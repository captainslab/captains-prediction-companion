#!/usr/bin/env node
// MLB daily article publisher.
//
// Discovers all games on the slate-run-plan for --date, regenerates current
// market state via discoverAllSeries (unless --no-refresh), runs the existing
// analyzeGame() engine per game, and writes one article per game plus one
// comprehensive slate article.
//
// Outputs:
//   state/mlb/<DATE>/article-reports/game-<GAMEKEY>.txt
//   state/mlb/<DATE>/article-reports/game-<GAMEKEY>.meta.json
//   state/mlb/<DATE>/article-reports/comprehensive-slate.txt
//   state/mlb/<DATE>/article-reports/comprehensive-slate.meta.json
//   state/mlb/<DATE>/article-reports/delivery-summary.json
//
// Delivery:
//   --dry-run        Print delivery plan, do not send.
//   --send-telegram  Send via Telegram bot API using TELEGRAM_BOT_TOKEN and
//                    a chat target: TELEGRAM_CHAT_ID, or TELEGRAM_HOME_CHANNEL
//                    as a fallback (so the daily cron can run without manually
//                    sourcing .env). Articles are sent as .txt
//                    attachments via sendDocument so we avoid 10-chunk spam.
//   --force          Re-send articles even if delivery-summary.json marks them
//                    as already sent for this idempotency key.
//
// Idempotency:
//   Each article carries an idempotency_key of
//     mlb:<date>:article:<game_key|slate>:<plan.generated_utc>
//   Once sent, delivery-summary.json records the key + message_id and the
//   publisher will skip re-sending unless --force is passed. Prior
//   slate-run-plan delivery records are NOT modified.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:https';
import { URL } from 'node:url';

import { discoverAllSeries, joinGames, MLB_SERIES } from './lib/series-discovery.mjs';
import { analyzeGame } from './lib/market-engine.mjs';
import { buildGameArticle, buildSlateArticle } from './lib/article-render.mjs';
import { DECISION_STATUSES } from '../shared/decision-process.mjs';

function parseArgs(argv) {
  const opts = {
    date: null,
    stateRoot: 'state',
    dryRun: false,
    refresh: true,
    sendTelegram: false,
    force: false,
    help: false,
    only: null, // optional comma-sep list of game_keys
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--state-root') opts.stateRoot = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-refresh') opts.refresh = false;
    else if (a === '--send-telegram') opts.sendTelegram = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--only') opts.only = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`Invalid --date value: ${opts.date} (expected YYYY-MM-DD)`);
  }
  if (!opts.dryRun && !opts.sendTelegram) opts.dryRun = true; // default safe
  return opts;
}

export function loadPlan(stateRoot, date) {
  const path = resolve(stateRoot, 'mlb', date, 'slate-run-plan.json');
  if (!existsSync(path)) throw new Error(`No slate plan at ${path}. Run slate-check first.`);
  return { path, plan: JSON.parse(readFileSync(path, 'utf8')) };
}

function loadDeliverySummary(outDir) {
  const path = resolve(outDir, 'delivery-summary.json');
  if (!existsSync(path)) {
    return {
      path,
      data: {
        schema: 'mlb-article-delivery-summary/v1',
        first_seen_utc: new Date().toISOString(),
        articles: {}, // idempotency_key -> { sent_utc, message_id, file }
      },
    };
  }
  try {
    return { path, data: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, data: { schema: 'mlb-article-delivery-summary/v1', articles: {} } };
  }
}

function saveDeliverySummary(summary) {
  writeFileSync(summary.path, JSON.stringify(summary.data, null, 2), 'utf8');
}

function normalizeCachedMarket(market = {}) {
  return {
    ticker: market.market_ticker ?? market.ticker ?? null,
    event_ticker: market.event_ticker ?? null,
    title: market.market_title ?? market.title ?? null,
    subtitle: market.contract_title ?? market.subtitle ?? null,
    yes_sub_title: market.contract_title ?? market.yes_sub_title ?? null,
    no_sub_title: market.no_sub_title ?? null,
    functional_strike: market.total_strike ?? market.functional_strike ?? null,
    custom_strike: market.custom_strike ?? null,
    floor_strike: market.floor_strike ?? null,
    cap_strike: market.cap_strike ?? null,
    strike_type: market.strike_type ?? null,
    yes_bid_dollars: market.yes_bid ?? market.yes_bid_dollars ?? null,
    yes_ask_dollars: market.yes_ask ?? market.yes_ask_dollars ?? null,
    no_bid_dollars: market.no_bid ?? market.no_bid_dollars ?? null,
    no_ask_dollars: market.no_ask ?? market.no_ask_dollars ?? null,
    last_price_dollars: market.last_price ?? market.last_price_dollars ?? null,
    volume_fp: market.volume ?? market.volume_fp ?? null,
    liquidity_dollars: market.liquidity ?? market.liquidity_dollars ?? null,
    open_interest_fp: market.open_interest ?? market.open_interest_fp ?? null,
    close_time: market.close_time ?? null,
    expected_expiration_time: market.expected_expiration_time ?? null,
    expiration_time: market.expiration_time ?? null,
    status: market.status ?? null,
  };
}

function loadCachedSeries(stateRoot, date) {
  const path = resolve(stateRoot, 'mlb', date, 'discovery', 'kalshi_adapter.json');
  const cached = readJsonSafe(path);
  if (!cached?.records?.length) return null;
  const byPrefix = new Map(Object.entries(MLB_SERIES).map(([id, meta]) => [meta.prefix, { id, meta }]));
  const out = Object.fromEntries(Object.entries(MLB_SERIES).map(([id, meta]) => [id, {
    series: meta.prefix,
    label: meta.label,
    ok: true,
    error: null,
    total: 0,
    matched: 0,
    events: [],
    source: path,
  }]));
  for (const record of cached.records) {
    const prefix = record.series_ticker ?? String(record.event_ticker ?? '').split('-')[0];
    const hit = byPrefix.get(prefix);
    if (!hit || !record.event_ticker) continue;
    out[hit.id].events.push({
      event_ticker: record.event_ticker,
      title: record.event_title ?? record.market_title ?? null,
      sub_title: record.sub_title ?? null,
      markets: (record.markets ?? []).map(normalizeCachedMarket),
    });
  }
  for (const bucket of Object.values(out)) {
    bucket.total = bucket.events.length;
    bucket.matched = bucket.events.length;
  }
  return out;
}

export async function gatherGames(date, planGameKeys, { useCache = false, stateRoot = 'state' } = {}) {
  if (useCache) {
    const cachedSeries = loadCachedSeries(stateRoot, date);
    if (!cachedSeries) {
      throw new Error(`--no-refresh requested but cached Kalshi discovery is missing or empty for ${date}. Expected ${resolve(stateRoot, 'mlb', date, 'discovery', 'kalshi_adapter.json')}`);
    }
    const games = joinGames(cachedSeries);
    const set = new Set(planGameKeys);
    return games.filter((g) => set.has(g.game_key));
  }
  const series = await discoverAllSeries(date);
  const games = joinGames(series);
  const set = new Set(planGameKeys);
  const matched = games.filter((g) => set.has(g.game_key));
  return matched;
}

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return null;
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}

function indexByGamePk(envelope) {
  const map = new Map();
  for (const rec of envelope?.records ?? []) {
    if (rec?.game_pk != null && !map.has(rec.game_pk)) {
      map.set(rec.game_pk, rec);
    }
  }
  return map;
}

function indexByMatchup(envelope) {
  const map = new Map();
  for (const rec of envelope?.records ?? []) {
    const key = rec.away_team && rec.home_team
      ? `${rec.away_team} at ${rec.home_team}`
      : rec.game ?? null;
    if (key && !map.has(key)) map.set(key, rec);
  }
  return map;
}

export function enrichGamesWithContext(games, stateRoot, date) {
  const dir = resolve(stateRoot, 'mlb', date, 'discovery');
  const stats = readJsonSafe(resolve(dir, 'stats_adapter.json'));
  const weather = readJsonSafe(resolve(dir, 'weather_adapter.json'));
  const context = readJsonSafe(resolve(dir, 'context_adapter.json'));

  if (!stats && !weather && !context) return games;

  const statsByPk = indexByGamePk(stats);
  const weatherByPk = indexByGamePk(weather);
  const contextByPk = indexByGamePk(context);
  const statsByMatchup = indexByMatchup(stats);
  const weatherByMatchup = indexByMatchup(weather);
  const contextByMatchup = indexByMatchup(context);

  for (const game of games) {
    const key = `${game.away_full} at ${game.home_full}`;
    const pk = game.game_pk ?? null;

    const sr = (pk != null ? statsByPk.get(pk) : null) ?? statsByMatchup.get(key) ?? null;
    if (sr) {
      game.stats_record = sr;
      if (sr.away_pitcher) game.starters = { away: sr.away_pitcher, home: sr.home_pitcher };
      if (sr.away_team_stats) game.recent_form = { away: sr.away_team_stats, home: sr.home_team_stats };
      if (sr.away_bullpen) game.bullpen_context = { away: sr.away_bullpen, home: sr.home_bullpen };
      if (sr.away_lineup_handedness) game.matchup_context = { away_handedness: sr.away_lineup_handedness, home_handedness: sr.home_lineup_handedness };
    }

    const wr = (pk != null ? weatherByPk.get(pk) : null) ?? weatherByMatchup.get(key) ?? null;
    if (wr) {
      game.weather_record = wr;
      game.weather = {
        temperature: wr.temperature,
        wind_speed: wr.wind_speed,
        wind_direction: wr.wind_direction,
        precipitation_risk: wr.precipitation_risk,
        roof_status: wr.roof_status,
        note: wr.weather_note,
      };
      game.venue = wr.venue;
      game.park_context = { venue: wr.venue, roof_type: wr.roof_type };
    }

    const cr = (pk != null ? contextByPk.get(pk) : null) ?? contextByMatchup.get(key) ?? null;
    if (cr) {
      game.context_record = cr;
      game.lineup_status = cr.lineup_status ?? null;
      game.lineup_notes = cr.lineup_status ?? 'pending';
      if (cr.key_injuries?.length) game.injuries = cr.key_injuries;
      if (cr.injury_status) game.injury_status = cr.injury_status;
      if (cr.injury_status) game.injury_notes = cr.injury_status;
      if (cr.probable_pitchers) {
        game.news_context = { probable_pitchers: cr.probable_pitchers };
        game.probable_pitchers = cr.probable_pitchers;
      }
    }

    game.context_records = {
      stats: sr ?? null,
      weather: wr ?? null,
      context: cr ?? null,
    };
  }
  return games;
}

function articleIdempotencyKey(planMeta, scope) {
  // planMeta.generated_utc is stable per slate refresh; scope = 'slate' | game_key
  const stamp = planMeta.generated_utc || planMeta.date || 'unknown';
  return `mlb:${planMeta.date}:article:${scope}:${stamp}`;
}

// Evidence-completeness gate: board-only articles must never be sent as full
// articles. Requires lineup/injury, venue/weather, and recent-form/matchup
// context to be checked in the decision process. A NO CLEAR PICK article
// WITH full context is valid — it says "we looked and there's no play."
export function isArticleDeliverable(analysis, articleText = '') {
  const process = analysis?.final?.decision_process;
  if (!process) return { deliverable: false, reason: 'no decision_process on analysis' };
  const checked = new Set(process.checkedItems?.map((x) => x.id) ?? []);
  const missing = [];
  if (!checked.has('lineup_injury_news')) missing.push('lineup/injury/news');
  if (!checked.has('venue_context')) missing.push('venue/weather/park');
  if (!checked.has('recent_form_matchup')) missing.push('recent form/matchup');
  if (missing.length) {
    return { deliverable: false, reason: `BLOCKED_CONTEXT_MISSING: ${missing.join(', ')}` };
  }
  const coverage = analysis?.final?.coverage ?? null;
  if (articleText && !coverage) {
    return { deliverable: false, reason: 'BLOCKED_COVERAGE_MISSING: family coverage contract missing from analysis' };
  }
  if (articleText && coverage?.mode === 'LIMITED') {
    if (!/(limited coverage|board-only|display-only)/i.test(articleText)) {
      return { deliverable: false, reason: 'BLOCKED_COVERAGE_OVERCLAIM: limited coverage article must say limited coverage or board-only/display-only' };
    }
    if (/(all-market|full coverage|every family modeled|all families modeled)/i.test(articleText)) {
      return { deliverable: false, reason: 'BLOCKED_COVERAGE_OVERCLAIM: article implies all-market model coverage that does not exist' };
    }
  }
  return { deliverable: true, reason: null };
}

function writeArticleFiles(outDir, baseName, article, extraMeta = {}) {
  mkdirSync(outDir, { recursive: true });
  const txtPath = resolve(outDir, `${baseName}.txt`);
  const metaPath = resolve(outDir, `${baseName}.meta.json`);
  writeFileSync(txtPath, article.text, 'utf8');
  writeFileSync(
    metaPath,
    JSON.stringify({
      schema: 'mlb-article/v1',
      base_name: baseName,
      headline: article.headline,
      char_count: article.text.length,
      decision: article.decision ?? null,
      generated_utc: new Date().toISOString(),
      ...extraMeta,
    }, null, 2),
    'utf8',
  );
  return { txtPath, metaPath };
}

// --- Telegram delivery (best-effort, env-driven) ---

// Pure resolver — exported so tests can exercise the fallback without I/O.
export function resolveTelegramEnv(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  // chat target: prefer explicit TELEGRAM_CHAT_ID, fall back to the Hermes
  // profile's TELEGRAM_HOME_CHANNEL so the daily cron can resolve a target
  // without anyone having to source .env manually.
  const chat = env.TELEGRAM_CHAT_ID || env.TELEGRAM_HOME_CHANNEL;
  const source = env.TELEGRAM_CHAT_ID
    ? 'TELEGRAM_CHAT_ID'
    : (env.TELEGRAM_HOME_CHANNEL ? 'TELEGRAM_HOME_CHANNEL' : null);
  if (!token || !chat) {
    throw new Error('TELEGRAM_BOT_TOKEN and (TELEGRAM_CHAT_ID or TELEGRAM_HOME_CHANNEL) must be set for --send-telegram.');
  }
  return { token, chat, chat_source: source };
}

// Load env from project .env files (same pattern as scripts/packets/
// send-packets-telegram.mjs) so the cron wrapper needs no manual sourcing.
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

function telegramEnv() {
  loadEnvFile('.env');
  loadEnvFile('.env.local');
  return resolveTelegramEnv();
}

function httpsJson(urlStr, body) {
  return new Promise((resolveP, rejectP) => {
    const url = new URL(urlStr);
    const data = Buffer.from(JSON.stringify(body));
    const req = request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { resolveP({ status: res.statusCode, body: JSON.parse(txt) }); }
        catch { resolveP({ status: res.statusCode, body: { raw: txt } }); }
      });
    });
    req.on('error', rejectP);
    req.write(data); req.end();
  });
}

function httpsMultipart(urlStr, fields, fileField, filePath, fileName) {
  return new Promise((resolveP, rejectP) => {
    const url = new URL(urlStr);
    const boundary = `----captainBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
    const fileBuf = readFileSync(filePath);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`));
    parts.push(fileBuf);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const req = request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        try { resolveP({ status: res.statusCode, body: JSON.parse(txt) }); }
        catch { resolveP({ status: res.statusCode, body: { raw: txt } }); }
      });
    });
    req.on('error', rejectP);
    req.write(body); req.end();
  });
}

async function telegramSendDocument({ token, chat }, filePath, caption) {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  const res = await httpsMultipart(url, { chat_id: chat, caption: caption.slice(0, 1000) }, 'document', filePath, basename(filePath));
  if (!res.body?.ok) throw new Error(`telegram sendDocument failed: status=${res.status} body=${JSON.stringify(res.body).slice(0, 400)}`);
  return res.body.result.message_id;
}

// --- Main pipeline ---

export async function publish(opts) {
  // Article-report sends re-enabled 2026-06-12 (user directive): packets go
  // out mentions-style — short caption + attached .txt document, idempotency
  // keys in delivery-summary.json. The composite pipeline remains separate.
  const { plan, path: planPath } = loadPlan(opts.stateRoot, opts.date);
  const planGameKeys = plan.games.map((g) => g.game_key);
  if (!planGameKeys.length) throw new Error(`Plan ${planPath} has zero games.`);

  let games;
  if (opts.refresh) {
    games = await gatherGames(opts.date, planGameKeys, { stateRoot: opts.stateRoot });
  } else {
    games = await gatherGames(opts.date, planGameKeys, { useCache: true, stateRoot: opts.stateRoot });
  }
  if (opts.only) {
    const onlySet = new Set(opts.only.split(',').map((s) => s.trim()).filter(Boolean));
    games = games.filter((g) => onlySet.has(g.game_key));
  }
  if (!games.length) throw new Error('No games matched the slate plan after filtering.');
  const matchedKeys = new Set(games.map((g) => g.game_key));
  const unmatchedPlanGames = planGameKeys
    .filter((gameKey) => !matchedKeys.has(gameKey))
    .map((game_key) => ({ game_key, reason: opts.refresh ? 'not returned by live discovery join' : 'not present in cached kalshi_adapter join' }));

  enrichGamesWithContext(games, opts.stateRoot, opts.date);

  const outDir = resolve(opts.stateRoot, 'mlb', opts.date, 'article-reports');
  mkdirSync(outDir, { recursive: true });

  const planMeta = { date: plan.date, generated_utc: plan.generated_utc, cluster_count: plan.cluster_count };

  const perGame = [];
  for (const game of games) {
    const analysis = analyzeGame(game);
    const article = buildGameArticle({ date: opts.date, game, analysis });
    const idem = articleIdempotencyKey(planMeta, game.game_key);
    const base = `game-${game.game_key}`;
    const { txtPath, metaPath } = writeArticleFiles(outDir, base, article, {
      idempotency_key: idem,
      game_key: game.game_key,
      matchup: `${game.away_full || game.away} at ${game.home_full || game.home}`,
      first_pitch_utc: game.start_utc ?? game.first_pitch_utc ?? null,
    });
    perGame.push({ game, analysis, article, idem, txtPath, metaPath });
  }

  const slate = buildSlateArticle({
    date: opts.date,
    items: perGame.map((p) => ({ game: p.game, analysis: p.analysis, gameArticle: p.article })),
    planMeta,
  });
  const slateIdem = articleIdempotencyKey(planMeta, 'slate');
  const { txtPath: slateTxt, metaPath: slateMeta } = writeArticleFiles(outDir, 'comprehensive-slate', slate, {
    idempotency_key: slateIdem,
    counts: slate.counts,
    game_count: perGame.length,
  });

  // Delivery planning — evidence-completeness gate.
  const summary = loadDeliverySummary(outDir);
  const deliveryPlan = [];
  let deliverableGameCount = 0;
  for (const p of perGame) {
    const already = summary.data.articles[p.idem];
    const gate = isArticleDeliverable(p.analysis, p.article.text);
    if (gate.deliverable) deliverableGameCount++;
    deliveryPlan.push({
      kind: 'game',
      game_key: p.game.game_key,
      idem: p.idem,
      file: p.txtPath,
      headline: p.article.headline,
      already_sent: Boolean(already),
      previous_message_id: already?.message_id ?? null,
      blocked: !gate.deliverable,
      blocked_reason: gate.reason,
    });
  }
  // Block the slate article if zero games passed the evidence gate.
  const slateBlocked = deliverableGameCount === 0;
  const slateBlockedReason = slateBlocked ? 'BLOCKED_CONTEXT_MISSING: all games blocked — no evidence-complete articles on slate' : null;
  deliveryPlan.push({
    kind: 'slate',
    idem: slateIdem,
    file: slateTxt,
    headline: slate.headline,
    already_sent: Boolean(summary.data.articles[slateIdem]),
    previous_message_id: summary.data.articles[slateIdem]?.message_id ?? null,
    blocked: slateBlocked,
    blocked_reason: slateBlockedReason,
  });

  // Execute delivery.
  const results = [];
  if (opts.sendTelegram) {
    const env = telegramEnv();
    for (const item of deliveryPlan) {
      if (item.blocked) {
        results.push({ ...item, sent: false, skipped: 'blocked', blocked_reason: item.blocked_reason });
        continue;
      }
      if (item.already_sent && !opts.force) {
        results.push({ ...item, sent: false, skipped: 'idempotent' });
        continue;
      }
      try {
        const id = await telegramSendDocument(env, item.file, item.headline);
        summary.data.articles[item.idem] = {
          sent_utc: new Date().toISOString(),
          message_id: id,
          file: item.file,
          kind: item.kind,
          headline: item.headline,
        };
        results.push({ ...item, sent: true, message_id: id });
      } catch (err) {
        results.push({ ...item, sent: false, error: err.message });
      }
    }
    saveDeliverySummary(summary);
  } else {
    // dry run — still write a summary file so callers can inspect plan
    summary.data.last_dry_run_utc = new Date().toISOString();
    summary.data.last_dry_run_plan = deliveryPlan.map(({ kind, game_key, idem, file, headline, already_sent, blocked, blocked_reason }) => ({
      kind, game_key: game_key ?? null, idem, file, headline, already_sent, blocked: blocked ?? false, blocked_reason: blocked_reason ?? null,
    }));
    saveDeliverySummary(summary);
  }

  return {
    plan_path: planPath,
    out_dir: outDir,
    slate_file: slateTxt,
    slate_meta: slateMeta,
    game_count: perGame.length,
    games: perGame.map((p) => ({ game_key: p.game.game_key, file: p.txtPath, decision: p.article.decision, headline: p.article.headline, idem: p.idem })),
    slate: { file: slateTxt, idem: slateIdem, counts: slate.counts, headline: slate.headline },
    delivery_plan: deliveryPlan,
    unmatched_plan_games: unmatchedPlanGames,
    results,
    sent: opts.sendTelegram,
    forced: opts.force,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/mlb/publish-article-reports.mjs --date YYYY-MM-DD [--dry-run|--send-telegram] [--force] [--no-refresh] [--only KEY1,KEY2] [--state-root state]');
    return;
  }
  const result = await publish(opts);
  // Cron stdout is relayed to Telegram as the "Cronjob Response", so keep it
  // to a short summary — packets themselves travel as .txt documents.
  console.log(`[mlb-articles] date=${opts.date} games=${result.game_count} slate_counts=${JSON.stringify(result.slate.counts)}`);
  if (opts.sendTelegram) {
    const sentN = result.results.filter((r) => r.sent).length;
    const blockedN = result.results.filter((r) => r.skipped === 'blocked').length;
    const skippedN = result.results.filter((r) => r.skipped === 'idempotent').length;
    const failed = result.results.filter((r) => !r.sent && !r.skipped);
    console.log(`[mlb-articles] delivered=${sentN} blocked=${blockedN} skipped_already_sent=${skippedN} failed=${failed.length}`);
    for (const r of result.results.filter((r) => r.skipped === 'blocked')) {
      console.log(`[mlb-articles] BLOCKED ${r.kind} ${r.game_key ?? 'slate'}: ${r.blocked_reason}`);
    }
    for (const r of failed) {
      console.error(`[mlb-articles] FAILED ${r.kind} ${r.game_key ?? 'slate'}: ${r.error}`);
    }
    if (failed.length) process.exit(2);
  } else {
    console.log('[mlb-articles] dry-run: no Telegram send. Use --send-telegram to deliver.');
    for (const item of result.delivery_plan) {
      const flag = item.blocked
        ? `(${item.blocked_reason})`
        : item.already_sent ? '(already sent)' : '(would send .txt document)';
      console.log(`[mlb-articles]   plan ${item.kind} ${item.game_key ?? 'slate'} ${flag} idem=${item.idem}`);
    }
    for (const item of result.unmatched_plan_games ?? []) {
      console.log(`[mlb-articles]   unmatched plan game ${item.game_key}: ${item.reason}`);
    }
  }
  console.log('[mlb-articles] No trades placed. No bankroll sizing. Research only.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`[mlb-articles] error: ${err.message}`);
    process.exit(1);
  });
}
