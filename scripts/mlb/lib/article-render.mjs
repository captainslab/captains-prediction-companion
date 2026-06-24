// Article-style rendering for MLB pre-lock reports.
// Pure functions. No network, no fs. Consumes joined game objects + analysis
// from market-engine.analyzeGame().
//
// Output target: readable Telegram betting-market articles. The numeric
// engine evidence (quote gap, OI ratio, soft-LEAN logic, gate thresholds,
// market-internal labels) is preserved in a compact Evidence Box. The
// surrounding prose stays plain English so the article does not read like
// a debug log.
//
// Style rules enforced here:
//   - Main prose (Market Read, Why ...) mentions "gap" at most once and
//     "OI ratio" at most once. Repeating those phrases is what made the
//     old output read like engine output.
//   - The strings "soft-LEAN", "gate", and "market-internal" only appear
//     inside the Evidence Box or the System Caveats line.
//   - No invented lineup / weather / starter / park / injury context.
//   - HR / K props stay in a Prop Market Watchlist; never a Tier 1 pick.

import { MLB_SERIES } from './series-discovery.mjs';
import { DECISION_STATUSES, renderDecisionProcess } from '../../shared/decision-process.mjs';
import { buildMarketFamilyCoverage } from './market-engine.mjs';
import {
  describeKs,
  describeRunline,
  describeTeamRuns,
  describeTotal,
  describeYrfi,
} from './projection-language.mjs';
import { distributionFloorMean } from './projection-contracts.mjs';

function dollarsToCents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function fmtCents(c) {
  return c == null ? 'MISSING' : `${c}\u00a2`;
}

function quoteLine(m) {
  const y = dollarsToCents(m.yes_ask_dollars);
  const n = dollarsToCents(m.no_ask_dollars);
  const oi = m.open_interest_fp ?? '?';
  const vol = m.volume_fp ?? '?';
  return `YES ${fmtCents(y)} / NO ${fmtCents(n)}  (oi=${oi} vol=${vol})`;
}

function teamFromSuffix(market, eventTicker) {
  const t = market.ticker || '';
  if (!eventTicker || !t.startsWith(`${eventTicker}-`)) return null;
  return t.slice(eventTicker.length + 1);
}

function safeMatchup(game) {
  if (game.away_full && game.home_full) return `${game.away_full} at ${game.home_full}`;
  return `${game.away ?? '?'} at ${game.home ?? '?'}`;
}

function shortMatchup(game) {
  return `${game.away ?? '?'} @ ${game.home ?? '?'}`;
}

function eventTickersFor(game) {
  const out = {};
  for (const sid of Object.keys(MLB_SERIES)) {
    const s = game.series?.[sid];
    out[sid] = s ? s.event_ticker : null;
  }
  return out;
}

function fmtInt(n) {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  return Math.round(Number(n)).toLocaleString('en-US');
}

// Extract ML favorite/dog snapshot (by YES ask price) plus OI.
function mlSnapshot(game) {
  const ml = game.series?.ml;
  if (!ml || !ml.markets?.length) return null;
  const rows = ml.markets.map((m) => ({
    team: teamFromSuffix(m, ml.event_ticker) || 'YES',
    yes_c: dollarsToCents(m.yes_ask_dollars),
    no_c: dollarsToCents(m.no_ask_dollars),
    oi: Number(m.open_interest_fp ?? 0),
    vol: Number(m.volume_fp ?? 0),
  }));
  if (rows.length < 2) return { rows };
  // Favorite = higher YES ask (more expensive to buy YES on).
  const sorted = [...rows].sort((a, b) => (b.yes_c ?? 0) - (a.yes_c ?? 0));
  const fav = sorted[0];
  const dog = sorted[1];
  return { rows, fav, dog };
}

function totalsSnapshot(game) {
  const tot = game.series?.total;
  if (!tot || !tot.markets?.length) return null;
  // Find the line whose YES ask is closest to 50¢ — that is the "main" total.
  const rows = tot.markets.map((m) => ({
    label: (m.yes_sub_title || m.title || '').trim(),
    yes_c: dollarsToCents(m.yes_ask_dollars),
    no_c: dollarsToCents(m.no_ask_dollars),
    oi: Number(m.open_interest_fp ?? 0),
  }));
  const valid = rows.filter((r) => r.yes_c != null);
  if (!valid.length) return null;
  valid.sort((a, b) => Math.abs((a.yes_c ?? 0) - 50) - Math.abs((b.yes_c ?? 0) - 50));
  return { main: valid[0], rows };
}

function rfiSnapshot(game) {
  const rfi = game.series?.rfi;
  if (!rfi || !rfi.markets?.length) return null;
  const m = rfi.markets[0];
  return {
    yes_c: dollarsToCents(m.yes_ask_dollars),
    no_c: dollarsToCents(m.no_ask_dollars),
    oi: Number(m.open_interest_fp ?? 0),
  };
}

function hasRenderableContext(game, contextBundle = null) {
  if (contextBundle?.provenance) {
    return Object.values(contextBundle.provenance).some((layer) => layer?.status && layer.status !== 'missing');
  }
  return Boolean(game?.starters || game?.lineup_notes || game?.weather || game?.recent_form || game?.bullpen_context || game?.matchup_context || game?.injuries || game?.injury_notes || game?.news_context);
}

// Find any spread market that confirms the favorite (favorite -1.5 YES ≥ 30¢).
function spreadConfirmation(game, favTeam) {
  const sp = game.series?.spread;
  if (!sp || !sp.markets?.length || !favTeam) return { confirms: null };
  let best = null;
  for (const m of sp.markets) {
    const label = (m.yes_sub_title || m.title || '').toLowerCase();
    if (!label.includes('1.5')) continue;
    // Heuristic: the suffix team on the ticker matches favorite.
    const team = teamFromSuffix(m, sp.event_ticker) || '';
    const matches = team === favTeam || label.includes(favTeam.toLowerCase());
    if (!matches) continue;
    const y = dollarsToCents(m.yes_ask_dollars);
    if (y == null) continue;
    if (!best || y > best.yes_c) best = { yes_c: y, label: m.yes_sub_title || m.title };
  }
  if (!best) return { confirms: null };
  return { confirms: best.yes_c >= 30, yes_c: best.yes_c, label: best.label };
}

function renderGameContext(game, contextBundle = null) {
  const lines = ['Game Context'];
  const provenance = contextBundle?.provenance ?? null;
  const hasStarters = Boolean(provenance?.starters?.status && provenance.starters.status !== 'missing') || Boolean(game.starters?.away || game.starters?.home);
  const hasLineup = Boolean(provenance?.lineup?.status && provenance.lineup.status !== 'missing')
    || Boolean(provenance?.injuries?.status && provenance.injuries.status !== 'missing')
    || Boolean(game.lineup_notes || game.injuries?.length || game.injury_notes);
  const hasWeather = Boolean(provenance?.weather?.status && provenance.weather.status !== 'missing') || Boolean(game.weather || game.venue || game.park_context);
  const hasForm = Boolean(provenance?.recent_form?.status && provenance.recent_form.status !== 'missing')
    || Boolean(provenance?.bullpen?.status && provenance.bullpen.status !== 'missing')
    || Boolean(provenance?.matchup_model?.status && provenance.matchup_model.status !== 'missing')
    || Boolean(game.recent_form || game.matchup_context || game.bullpen_context);

  if (!hasStarters && !hasLineup && !hasWeather && !hasForm) {
    lines.push('  No game context sourced. Board data only.');
    return lines.join('\n');
  }

  if (hasStarters) {
    const a = game.starters?.away;
    const h = game.starters?.home;
    const fmtP = (p) => p ? `${p.name ?? 'TBD'} (ERA ${p.era ?? '?'}, ${p.hand ?? '?'})` : 'TBD';
    lines.push(`  Starters: ${fmtP(a)} vs ${fmtP(h)}`);
  } else {
    lines.push('  Starters: not sourced');
  }

  if (hasLineup) {
    lines.push(`  Lineup status: ${game.lineup_notes ?? 'unknown'}`);
    if (game.injuries?.length) {
      const top = game.injuries.slice(0, 4);
      for (const inj of top) {
        lines.push(`  Injury: ${inj.player ?? inj.name ?? '?'} (${inj.team ?? '?'}) — ${inj.status ?? inj.detail ?? '?'}`);
      }
    }
  } else {
    lines.push('  Lineup/injury: not sourced');
  }

  if (hasWeather) {
    const w = game.weather;
    if (w) {
      lines.push(`  Weather: ${w.temperature ?? '?'}°F, wind ${w.wind_speed ?? '?'} ${w.wind_direction ?? ''}, precip ${w.precipitation_risk ?? '?'}%${w.roof_status ? ` (${w.roof_status})` : ''}${w.note ? ` — ${w.note}` : ''}`);
    }
    if (game.venue) lines.push(`  Venue: ${game.venue}`);
  } else {
    lines.push('  Weather/park: not sourced');
  }

  if (hasForm) {
    if (game.recent_form?.away && game.recent_form?.home) {
      const a = game.recent_form.away;
      const h = game.recent_form.home;
      lines.push(`  Form: ${game.away ?? '?'} (${a.wins ?? '?'}-${a.losses ?? '?'}, L10 ${a.last10 ?? '?'}, OPS ${a.ops ?? '?'}) vs ${game.home ?? '?'} (${h.wins ?? '?'}-${h.losses ?? '?'}, L10 ${h.last10 ?? '?'}, OPS ${h.ops ?? '?'})`);
    }
    if (game.bullpen_context?.away && game.bullpen_context?.home) {
      const a = game.bullpen_context.away;
      const h = game.bullpen_context.home;
      lines.push(`  Bullpen: ${game.away ?? '?'} ERA ${a.era ?? '?'} / ${game.home ?? '?'} ERA ${h.era ?? '?'}`);
    }
  } else {
    lines.push('  Recent form/matchup: not sourced');
  }

  if (provenance) {
    lines.push('  Provenance');
    for (const [layerName, layer] of Object.entries(provenance)) {
      const source = Array.isArray(layer.source) ? layer.source.join('+') : (layer.source ?? 'unknown');
      const availability = layer.availability && layer.availability !== layer.status ? ` / ${layer.availability}` : '';
      const detail = layer.detail ? ` — ${layer.detail}` : '';
      const note = layer.note ? ` | note: ${layer.note}` : '';
      lines.push(`    - ${layerName}: ${source} — ${layer.status}${availability}${detail}${note}`);
    }
  }

  return lines.join('\n');
}

function starterSlateSummary(game, provenance) {
  if (game.starters?.away && game.starters?.home) {
    const a = game.starters.away;
    const h = game.starters.home;
    return `starters ${a.name ?? game.away ?? 'away'} (${a.era ?? '?'} ERA) vs ${h.name ?? game.home ?? 'home'} (${h.era ?? '?'} ERA)`;
  }
  return `starters ${provenance?.starters?.status ?? 'missing'}`;
}

function recentFormSlateSummary(game, provenance) {
  if (game.recent_form?.away && game.recent_form?.home) {
    const a = game.recent_form.away;
    const h = game.recent_form.home;
    return `recent form ${game.away ?? 'away'} ${a.wins ?? '?'}-${a.losses ?? '?'} vs ${game.home ?? 'home'} ${h.wins ?? '?'}-${h.losses ?? '?'}`;
  }
  return `recent form ${provenance?.recent_form?.status ?? 'missing'}`;
}

function bullpenSlateSummary(game, provenance) {
  if (game.bullpen_context?.away && game.bullpen_context?.home) {
    const a = game.bullpen_context.away;
    const h = game.bullpen_context.home;
    return `bullpen ${game.away ?? 'away'} ERA ${a.era ?? '?'} vs ${game.home ?? 'home'} ERA ${h.era ?? '?'}`;
  }
  return `bullpen ${provenance?.bullpen?.status ?? 'missing'}`;
}

function weatherSlateSummary(game, provenance) {
  if (game.weather) {
    const roof = game.weather.roof_status || provenance?.weather?.availability || null;
    const venue = game.venue ? ` at ${game.venue}` : '';
    const roofPart = roof ? ` (${roof})` : '';
    const wind = String(game.weather.wind_speed ?? '?');
    const windText = /mph/i.test(wind) ? wind : `${wind} mph`;
    return `weather/park ${game.weather.temperature ?? '?'}F, wind ${windText}, precip ${game.weather.precipitation_risk ?? '?'}%${roofPart}${venue}`;
  }
  const status = provenance?.weather?.status ?? 'missing';
  const availability = provenance?.weather?.availability ? ` (${provenance.weather.availability})` : '';
  return `weather/park ${status}${availability}`;
}

function lineupInjurySlateSummary(game, provenance) {
  const lineupStatus = provenance?.lineup?.status ?? (game.lineup_notes ? 'partial' : 'missing');
  const injuryStatus = provenance?.injuries?.status ?? (game.injuries?.length ? 'partial' : 'missing');
  const cleanDetail = (value) => String(value ?? '').replace(/^lineup_status=/, '').replace(/^injury_status=/, '').replace(/_/g, ' ');
  const lineupDetail = cleanDetail(provenance?.lineup?.detail ?? null);
  const injuryDetail = cleanDetail(provenance?.injuries?.detail ?? null);
  const phrase = (label, value) => {
    const text = String(value ?? '').trim();
    return text.toLowerCase().startsWith(label) ? text : `${label} ${text}`;
  };
  if (!game.lineup_notes && !game.injuries?.length && !game.injury_notes) {
    if (lineupStatus === 'missing' && injuryStatus === 'missing') {
      return 'lineup/injury missing';
    }
    return `${phrase('lineup', lineupDetail || lineupStatus)}; ${phrase('injury', injuryDetail || injuryStatus)}`;
  }
  if (game.lineup_notes || game.injuries?.length || game.injury_notes) {
    const injuries = game.injuries?.length
      ? `; injuries ${game.injuries.slice(0, 2).map((inj) => `${inj.player ?? inj.name ?? '?'}/${inj.team ?? '?'}/${inj.status ?? inj.detail ?? '?'}`).join(', ')}`
      : '';
    return `${phrase('lineup', lineupDetail || lineupStatus)}; ${phrase('injury', injuryDetail || injuryStatus)}${injuries}`;
  }
  return `${phrase('lineup', lineupDetail || lineupStatus)}; ${phrase('injury', injuryDetail || injuryStatus)}`;
}

const SLATE_EVIDENCE_MARGIN = 5;
const SLATE_LAYER_DIFF = 3;
const SLATE_VOTE_LAYERS = [
  ['starting_pitcher_signal', 'starter'],
  ['season_form', 'season form'],
  ['recent_form', 'recent form'],
  ['bullpen_fatigue_availability', 'bullpen'],
  ['park_weather_context', 'weather/park'],
  ['lineup_injury_state', 'lineup/injury'],
  ['lineup_handedness_matchup', 'handedness'],
  ['matchup_splits', 'matchup'],
];

function fmtPoints(n) {
  if (!Number.isFinite(Number(n))) return '?';
  const value = Number(n);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function sideLabel(game, side) {
  if (side === 'away') return game.away ?? game.away_full ?? 'away';
  if (side === 'home') return game.home ?? game.home_full ?? 'home';
  return 'none';
}

function ledgerRowsByCategory(bundle, side) {
  const rows = bundle?.ledger?.[side]?.evidence_ledger ?? [];
  return new Map(rows.map((row) => [row.category, row]));
}

function slateLayerVotes(game, bundle, provenance) {
  const awayRows = ledgerRowsByCategory(bundle, 'away');
  const homeRows = ledgerRowsByCategory(bundle, 'home');
  const leadingSide = bundle?.support_side ?? null;
  const supportMargin = Number(bundle?.support_margin);
  const supporting = [];
  const opposing = [];
  const canceling = [];

  for (const [category, label] of SLATE_VOTE_LAYERS) {
    const away = awayRows.get(category);
    const home = homeRows.get(category);
    const awayValue = Number(away?.value);
    const homeValue = Number(home?.value);
    if (!away?.present || !home?.present || !Number.isFinite(awayValue) || !Number.isFinite(homeValue)) continue;
    const diff = awayValue - homeValue;
    if (Math.abs(diff) < SLATE_LAYER_DIFF) {
      canceling.push(label);
      continue;
    }
    const winner = diff > 0 ? 'away' : 'home';
    if (leadingSide && winner === leadingSide) supporting.push(label);
    else opposing.push(`${label} ${sideLabel(game, winner)}`);
  }

  const partialOrMissing = [];
  for (const [label, layer] of [
    ['starters', provenance?.starters],
    ['recent form', provenance?.recent_form],
    ['bullpen', provenance?.bullpen],
    ['weather/park', provenance?.weather],
    ['lineup', provenance?.lineup],
    ['injuries', provenance?.injuries],
    ['matchup', provenance?.matchup_model],
  ]) {
    if (!layer || ['missing', 'partial', 'unavailable'].includes(layer.status)) {
      partialOrMissing.push(`${label} ${layer?.status ?? 'missing'}`);
    }
  }

  const leading = leadingSide ? sideLabel(game, leadingSide) : null;
  let failure;
  if (!leadingSide) {
    failure = 'no directional layer advantage across sourced non-market layers';
  } else if (!Number.isFinite(supportMargin) || supportMargin < SLATE_EVIDENCE_MARGIN) {
    failure = `support margin ${fmtPoints(supportMargin)} below ${SLATE_EVIDENCE_MARGIN}-point evidence threshold`;
  } else if (supporting.length < 2) {
    failure = `only ${supporting.length} directional support layer(s), below evidence threshold`;
  } else if (opposing.length || canceling.length) {
    failure = 'opposing/canceling layers prevented a clean evidence threshold';
  } else if (partialOrMissing.length) {
    failure = 'partial/missing context prevented evidence threshold';
  } else {
    failure = 'non-market context did not produce an evidence-ready slate decision';
  }

  return {
    leading,
    supportMargin,
    supporting,
    opposing,
    canceling,
    partialOrMissing,
    failure,
  };
}

function noPickThresholdReason(game, bundle, provenance) {
  const votes = slateLayerVotes(game, bundle, provenance);
  if (!votes.leading) {
    const gaps = votes.partialOrMissing.length ? `; partial/missing: ${votes.partialOrMissing.join(', ')}` : '';
    return `no directional layer advantage${gaps}; ${votes.failure}.`;
  }
  const support = votes.supporting.length
    ? `supports ${votes.leading}: ${votes.supporting.join(', ')}`
    : `supports ${votes.leading}: none clear`;
  const opposeParts = [];
  if (votes.opposing.length) opposeParts.push(`opposes: ${votes.opposing.join(', ')}`);
  if (votes.canceling.length) opposeParts.push(`cancels: ${votes.canceling.join(', ')}`);
  const oppose = opposeParts.length ? `; ${opposeParts.join('; ')}` : '';
  const gaps = votes.partialOrMissing.length ? `; partial/missing: ${votes.partialOrMissing.join(', ')}` : '';
  return `leading side ${votes.leading} by ${fmtPoints(votes.supportMargin)} pts; ${support}${oppose}${gaps}; ${votes.failure}.`;
}

function propAlertCounts(analysis) {
  const alerts = analysis?.final?.prop_watchlist ?? [];
  return {
    hr: alerts.filter((a) => a.kind === 'HR').length,
    k: alerts.filter((a) => a.kind === 'K').length,
  };
}

function compositeScoreText(game, bundle) {
  const awayScore = bundle?.side_scores?.away;
  const homeScore = bundle?.side_scores?.home;
  const away = game.away ?? 'away';
  const home = game.home ?? 'home';
  if (awayScore == null || homeScore == null) {
    return `${away} BLOCKED_CONTEXT_MISSING vs ${home} BLOCKED_CONTEXT_MISSING`;
  }
  return `${away} ${fmtPoints(awayScore)} vs ${home} ${fmtPoints(homeScore)}`;
}

function getFamilyCoverage(it) {
  const analysis = it.analysis ?? null;
  const game = it.game ?? null;
  return analysis?.final?.coverage ?? buildMarketFamilyCoverage(game, analysis);
}

function familyStatusLines(it) {
  const game = it.game;
  const analysis = it.analysis;
  const coverage = getFamilyCoverage(it);
  const d = processStatus(analysis);
  const matchup = shortMatchup(game);
  const ctx = slateContextSummary(it);
  const bundle = analysis?.final?.context_bundle ?? null;
  const composite = compositeScoreText(game, bundle);
  const propCounts = propAlertCounts(analysis);
  const mlCoverage = coverage.families.ml;
  const mlStatus = mlCoverage.status === 'NON_MARKET_COMPOSITE_READY'
    ? `composite ${composite}; ${mlCoverage.status} — ${d} ${ctx.supportTeam ?? 'side'} — ${(ctx.supportReason ?? 'non-market evidence supports this side').replace(/\.+$/, '')}.`
    : mlCoverage.status === 'PARTIAL_NEEDS_PATCH'
      ? `composite ${composite}; ${mlCoverage.status} — ${ctx.noPickReason} Limited coverage: some non-market context exists, but the composite is not ready yet.`
      : mlCoverage.status === 'BOARD_ANALYZER_ONLY'
        ? `composite ${composite}; ${mlCoverage.status} — board signal only, not evidence, not a pick.`
        : `composite ${composite}; ${mlCoverage.status} — no ML market to model.`;
  // Ks/HR: a real modeled composite (from the projection engine) wins over the
  // board-analyzer fallback. Board anomaly counts are display-only context and
  // never override a modeled read.
  const hrFamily = coverage.families.hr;
  const hrStatus = hrFamily.modeled
    ? `${hrFamily.status} — ${hrFamily.detail}.`
    : propCounts.hr
      ? `BOARD_ANALYZER_ONLY — ${propCounts.hr} HR market anomaly(ies); HR ladder analyzer only; display-only board context, not a non-market composite.`
      : hrFamily.status === 'BLOCKED_MODEL_LAYER_MISSING'
        ? 'BLOCKED_MODEL_LAYER_MISSING — HR markets missing; no HR board analyzer to render.'
        : 'BOARD_ANALYZER_ONLY — HR ladder analyzer only; display-only board context, not a non-market composite.';
  const ksFamily = coverage.families.ks;
  const kStatus = ksFamily.modeled
    ? `${ksFamily.status} — ${ksFamily.detail}.`
    : propCounts.k
      ? `BOARD_ANALYZER_ONLY — ${propCounts.k} K market anomaly(ies); K ladder analyzer only; display-only board context, not a non-market composite.`
      : ksFamily.status === 'BLOCKED_MODEL_LAYER_MISSING'
        ? 'BLOCKED_MODEL_LAYER_MISSING — K markets missing; no K board analyzer to render.'
        : 'BOARD_ANALYZER_ONLY — K ladder analyzer only; display-only board context, not a non-market composite.';
  return [
    `${matchup}:`,
    `ML/game-side: ${mlStatus}`,
    `Spread: ${coverage.families.spread.status} — ${coverage.families.spread.detail}.`,
    `Total: ${coverage.families.total.status} — ${coverage.families.total.detail}.`,
    `YFRI/NRFI: ${coverage.families.yfri.status} — ${coverage.families.yfri.detail}.`,
    `Ks props: ${kStatus}`,
    `HR props: ${hrStatus}`,
  ];
}

export function renderFamilyStatusBlock(game, analysis) {
  const coverage = getFamilyCoverage({ game, analysis });
  const lines = ['Market-family coverage'];
  lines.push(`  Coverage mode: ${coverage.mode} — ${coverage.mode === 'LIMITED' ? 'limited coverage; board analyzers remain display-only and NOT IN SCORE.' : 'full modeled coverage.'}`);
  lines.push(`  Coverage summary: ${coverage.summary}.`);
  const familyLines = familyStatusLines({ game, analysis });
  for (const line of familyLines.slice(1)) {
    lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

function slateContextSummary(it) {
  const game = it.game;
  const bundle = it.analysis?.final?.context_bundle ?? null;
  const provenance = bundle?.provenance ?? null;
  const supportTeam = bundle?.support_team ?? null;
  const supportReason = bundle?.support_reason ?? null;
  const starters = starterSlateSummary(game, provenance);
  const recentForm = recentFormSlateSummary(game, provenance);
  const bullpen = bullpenSlateSummary(game, provenance);
  const weather = weatherSlateSummary(game, provenance);
  const lineup = lineupInjurySlateSummary(game, provenance);
  const missing = [];
  for (const [label, layer] of [
    ['starters', provenance?.starters],
    ['recent form', provenance?.recent_form],
    ['bullpen', provenance?.bullpen],
    ['weather/park', provenance?.weather],
    ['lineup/injury', provenance?.lineup],
  ]) {
    if (!layer || layer.status === 'missing') missing.push(label);
  }
  return {
    supportTeam,
    supportReason,
    starters,
    recentForm,
    bullpen,
    weather,
    lineup,
    missing,
    noPickReason: noPickThresholdReason(game, bundle, provenance),
  };
}

function renderMarketOverview(game) {
  // Kept as a compact factual ledger inside Evidence Box (and the Game info
  // block above it). Not the lead prose.
  const lines = ['Market overview (display-only — NOT IN SCORE)'];
  const ml = game.series?.ml;
  if (!ml || !ml.markets?.length) {
    lines.push('  ML: MISSING / UNQUOTED');
  } else {
    for (const m of ml.markets) {
      const team = teamFromSuffix(m, ml.event_ticker) || 'YES';
      lines.push(`  ML ${team}: ${quoteLine(m)}`);
    }
  }
  const sp = game.series?.spread;
  if (!sp || !sp.markets?.length) {
    lines.push('  Spread: MISSING / UNQUOTED');
  } else {
    for (const m of sp.markets) {
      const label = (m.yes_sub_title || m.title || m.ticker || '?').trim();
      lines.push(`  Spread ${label}: ${quoteLine(m)}`);
    }
  }
  const tot = game.series?.total;
  if (!tot || !tot.markets?.length) {
    lines.push('  Total: MISSING / UNQUOTED');
  } else {
    for (const m of tot.markets) {
      const label = (m.yes_sub_title || m.title || m.ticker || '?').trim();
      lines.push(`  Total ${label}: ${quoteLine(m)}`);
    }
  }
  const hr = game.series?.hr;
  if (!hr || !hr.markets?.length) {
    lines.push('  HR props: MISSING / UNQUOTED');
  } else {
    lines.push(`  HR props: ${hr.markets.length} player markets posted`);
  }
  const ks = game.series?.ks;
  if (!ks || !ks.markets?.length) {
    lines.push('  K props: MISSING / UNQUOTED');
  } else {
    lines.push(`  K props: ${ks.markets.length} starter ladders posted`);
  }
  const rfi = game.series?.rfi;
  if (!rfi || !rfi.markets?.length) {
    lines.push('  YFRI/NFRI: MISSING / UNQUOTED');
  } else {
    const m = rfi.markets[0];
    lines.push(`  YFRI/NFRI: ${quoteLine(m)}`);
  }
  return lines.join('\n');
}

function bestSection(analysis) {
  const order = { CLEAR: 0, LEAN: 1, WATCH: 2, PASS: 3, 'NO CLEAR PICK': 4 };
  const cand = [
    { key: 'ML', sec: analysis.sections.ml },
    { key: 'Spread', sec: analysis.sections.spread },
    { key: 'Total', sec: analysis.sections.total },
    { key: 'YFRI', sec: analysis.sections.yfri },
  ];
  cand.sort((a, b) => (order[a.sec.decision] ?? 9) - (order[b.sec.decision] ?? 9));
  return cand[0];
}

function decisionLabel(d) {
  if (d === 'CLEAR' || d === 'LEAN' || d === 'WATCH' || d === 'PASS') return d;
  return 'NO CLEAR PICK';
}

function processStatus(analysis) {
  return analysis?.final?.decision_process?.decisionStatus ?? decisionLabel(analysis?.final?.decision);
}

function isEvidenceLean(status) {
  return status === DECISION_STATUSES.EVIDENCE_LEAN || status === DECISION_STATUSES.STRONG_EVIDENCE_LEAN;
}

function isMarketOnlyLean(status) {
  return status === DECISION_STATUSES.MARKET_ONLY_LEAN;
}

// Customer-facing label policy: the internal MARKET-ONLY LEAN status never
// appears in packet text. It renders as CONTEXT WATCH so no copy implies a
// market-derived edge. Market data is display-only and NOT IN SCORE.
const CONTEXT_WATCH = 'CONTEXT WATCH';

function displayStatus(status) {
  return isMarketOnlyLean(status) ? CONTEXT_WATCH : status;
}

// Defense-in-depth: scrub any engine-vocabulary leak (engine reasons,
// decision-process lines) out of customer-facing text.
function scrubMarketLabel(text) {
  return text
    .replaceAll('MARKET-ONLY LEAN', CONTEXT_WATCH)
    .replaceAll('Market-only leans', 'Context watches')
    .replaceAll('market-only leans', 'context watches')
    .replaceAll('Market-only lean', 'Context watch')
    .replaceAll('market-only lean', 'context watch')
    .replaceAll('market-only read', 'display-only market context (NOT IN SCORE)')
    .replaceAll('Market-only side', 'Context side');
}

// Build the natural-language Market Read paragraph. This is the lead prose
// of the article. It MUST stay free of repeated engine vocabulary.
function renderMarketRead(game, mlSnap, totSnap, rfiSnap, spreadConf) {
  const sentences = [];
  if (mlSnap?.fav && mlSnap?.dog) {
    sentences.push(
      `The moneyline prices ${mlSnap.fav.team} as the favorite at ${fmtCents(mlSnap.fav.yes_c)}, with ${mlSnap.dog.team} on the other side at ${fmtCents(mlSnap.dog.yes_c)}.`,
    );
    if (mlSnap.fav.oi && mlSnap.dog.oi) {
      const heavier = mlSnap.fav.oi >= mlSnap.dog.oi ? mlSnap.fav : mlSnap.dog;
      const lighter = heavier === mlSnap.fav ? mlSnap.dog : mlSnap.fav;
      const dom = heavier.oi >= 2 * lighter.oi ? 'far heavier' : heavier.oi >= 1.3 * lighter.oi ? 'meaningfully heavier' : 'roughly balanced';
      sentences.push(
        `Open interest sits ${dom} on ${heavier.team} (${fmtInt(heavier.oi)} vs ${fmtInt(lighter.oi)}).`,
      );
    }
  } else if (mlSnap?.rows?.length) {
    sentences.push('Moneyline is posted but the pair is incomplete or unpriced.');
  } else {
    sentences.push('No moneyline quotes were available for this game.');
  }
  if (spreadConf?.confirms === true) {
    sentences.push(`The spread ladder backs that read: ${spreadConf.label} sits at ${fmtCents(spreadConf.yes_c)}.`);
  } else if (spreadConf?.confirms === false) {
    sentences.push(`The spread ladder is thin on the favorite side (${spreadConf.label} only ${fmtCents(spreadConf.yes_c)}), so it does not back the moneyline read.`);
  } else {
    sentences.push('The spread ladder does not give a usable favorite-side read at -1.5.');
  }
  if (totSnap?.main) {
    sentences.push(`Total sits around ${totSnap.main.label} at ${fmtCents(totSnap.main.yes_c)} YES.`);
  }
  if (rfiSnap) {
    sentences.push(`YFRI/NFRI is posted at ${fmtCents(rfiSnap.yes_c)} / ${fmtCents(rfiSnap.no_c)}.`);
  }
  return sentences.join(' ');
}

function renderWhyPick(analysis, mlSnap, spreadConf, status, game, coverage) {
  const d = analysis.final.decision;
  const hasContext = hasRenderableContext(game, analysis?.final?.context_bundle ?? null);
  if (isEvidenceLean(status)) {
    const side = mlSnap?.fav?.team || 'the favorite';
    const points = [];
    points.push(`price separation favors ${side}`);
    if (mlSnap?.fav?.oi && mlSnap?.dog?.oi && mlSnap.fav.oi >= 1.3 * mlSnap.dog.oi) {
      points.push('open interest is one-sided in the same direction');
    }
    if (spreadConf?.confirms === true) points.push('the spread ladder agrees');
    else if (spreadConf?.confirms === false) points.push('the spread ladder is not contradicting outright');
    const joined = points.length ? points.join(', ') : 'the market reads one-sided on price and depth';
    return `Non-market evidence favors ${side}. ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
  }
  if ((d === 'CLEAR' || d === 'LEAN') && isMarketOnlyLean(status)) {
    const side = mlSnap?.fav?.team || 'the board side';
    return `The board points toward ${side}, but board signal only, not evidence, not a pick. Market data here is display-only and NOT IN SCORE.`;
  }
  // PASS / NO CLEAR PICK
  if (coverage?.mode === 'LIMITED') {
    return `${limitedCoverageSentence(coverage)} spread, total, YFRI/NRFI, Ks, and HR remain board-only or blocked. No side here is defensible without outside context (lineups, weather, starters, park).`;
  }
  if (hasContext) {
    return 'Context reviewed, no defensible edge.';
  }
  return 'Prices, depth, spread shape, total and first-inning markets all read close to fair given what is posted. No side here is defensible without outside context (lineups, weather, starters, park).';
}

function renderBottomLine(analysis, mlSnap, status, game, coverage) {
  if (status === DECISION_STATUSES.STRONG_EVIDENCE_LEAN) {
    const side = mlSnap?.fav?.team || 'favorite';
    return `Call: STRONG EVIDENCE LEAN — ${side}. No trades placed, no sizing.`;
  }
  if (status === DECISION_STATUSES.EVIDENCE_LEAN) {
    const side = mlSnap?.fav?.team || 'favorite';
    return `Call: EVIDENCE LEAN — ${side}. No trades placed, no sizing.`;
  }
  if (status === DECISION_STATUSES.MARKET_ONLY_LEAN) {
    const side = mlSnap?.fav?.team || 'board side';
    return `Call: ${CONTEXT_WATCH} — ${side}. Board signal only, not evidence, not a pick. Market context is display-only and NOT IN SCORE. No trades placed, no sizing.`;
  }
  if (coverage?.mode === 'LIMITED') {
    return `Call: NO CLEAR PICK — limited coverage. ${limitedCoverageSentence(coverage)} spread, total, YFRI/NRFI, Ks, and HR remain board-only or blocked. No trades placed, no sizing.`;
  }
  const hasCtx = hasRenderableContext(game, analysis?.final?.context_bundle ?? null);
  if (hasCtx) {
    return 'Call: PASS — context reviewed, no defensible edge. No trades placed, no sizing.';
  }
  return 'Call: PASS — board only. Nothing actionable from the market alone. No trades placed, no sizing.';
}

const FAMILY_LABELS = Object.freeze({
  ml: 'ML/game-side',
  spread: 'Spread',
  total: 'Total',
  yfri: 'YRFI/NRFI',
  ks: 'Ks props',
  hr: 'HR props',
});

const FAMILY_STATUS_LABELS = Object.freeze({
  NON_MARKET_COMPOSITE_READY: 'MODELED',
  BOARD_ANALYZER_ONLY: 'BOARD_ONLY_DISPLAY',
  BLOCKED_MODEL_LAYER_MISSING: 'BLOCKED_MODEL',
  PARTIAL_NEEDS_PATCH: 'NOT_READY',
});

function familyLabel(key) {
  return FAMILY_LABELS[key] ?? key;
}

function familyStateLabel(status) {
  return FAMILY_STATUS_LABELS[status] ?? 'UNAVAILABLE';
}

function familyGroups(coverage) {
  const groups = {
    modeled: [],
    board_only: [],
    blocked: [],
    not_ready: [],
    unavailable: [],
  };
  for (const [key, family] of Object.entries(coverage?.families ?? {})) {
    const label = familyLabel(key);
    const state = familyStateLabel(family?.status);
    if (state === 'MODELED') groups.modeled.push(label);
    else if (state === 'BOARD_ONLY_DISPLAY') groups.board_only.push(label);
    else if (state === 'BLOCKED_MODEL') groups.blocked.push(label);
    else if (state === 'NOT_READY') groups.not_ready.push(label);
    else groups.unavailable.push(label);
  }
  return groups;
}

function coverageSummaryLine(coverage) {
  const groups = familyGroups(coverage);
  const parts = [];
  if (groups.modeled.length) parts.push(`Modeled families: ${groups.modeled.join(', ')}.`);
  if (groups.board_only.length) parts.push(`BOARD_ONLY_DISPLAY families: ${groups.board_only.join(', ')}.`);
  if (groups.not_ready.length) parts.push(`NOT_READY families: ${groups.not_ready.join(', ')}.`);
  if (groups.blocked.length) parts.push(`BLOCKED_MODEL families: ${groups.blocked.join(', ')}.`);
  if (groups.unavailable.length) parts.push(`UNAVAILABLE families: ${groups.unavailable.join(', ')}.`);
  if (!parts.length) return 'No family coverage available.';
  return parts.join(' ');
}

function limitedCoverageSentence(coverage) {
  const groups = familyGroups(coverage);
  const modeled = groups.modeled.length ? groups.modeled.join(', ') : 'none';
  return `Limited coverage: modeled families are ${modeled}.`;
}

function formatGameSideComposite(game, bundle) {
  const awayScore = bundle?.side_scores?.away;
  const homeScore = bundle?.side_scores?.home;
  if (awayScore == null || homeScore == null) {
    return 'BLOCKED_CONTEXT_MISSING';
  }
  const away = game.away ?? 'away';
  const home = game.home ?? 'home';
  const lead = awayScore === homeScore ? 'even' : awayScore > homeScore ? away : home;
  const margin = Math.abs(Number(awayScore) - Number(homeScore));
  return `${away} ${fmtPoints(awayScore)} vs ${home} ${fmtPoints(homeScore)}; leading ${lead}; margin ${fmtPoints(margin)}.`;
}

function projectionFallbackLabel(family) {
  return familyStateLabel(family?.status);
}

function lineupIsReady(status) {
  const text = String(status ?? '').toLowerCase();
  return text.includes('confirm') || text === 'complete';
}

function modelConsistencyCheck(game, analysis) {
  const bundle = analysis?.final?.context_bundle ?? null;
  const projections = analysis?.final?.projections ?? null;
  const sideScores = bundle?.side_scores ?? null;
  const scoreProj = projections?.score ?? null;
  const yrfiProj = projections?.yrfi ?? null;
  const awayRuns = distributionFloorMean(scoreProj?.outputs?.team_runs_distribution?.away);
  const homeRuns = distributionFloorMean(scoreProj?.outputs?.team_runs_distribution?.home);
  const totalRuns = distributionFloorMean(scoreProj?.outputs?.total_runs_distribution);
  const awaySide = Number(sideScores?.away);
  const homeSide = Number(sideScores?.home);
  const lineupStatus = bundle?.provenance?.lineup?.status ?? game?.lineup_status ?? null;
  const awayEra = Number(game?.starters?.away?.era);
  const homeEra = Number(game?.starters?.home?.era);
  const avgEra = Number.isFinite(awayEra) && Number.isFinite(homeEra) ? (awayEra + homeEra) / 2 : null;

  const checkA = (() => {
    if (!Number.isFinite(awaySide) || !Number.isFinite(homeSide) || !Number.isFinite(awayRuns) || !Number.isFinite(homeRuns)) {
      return ['INSUFFICIENT_DATA', 'missing side scores or projected team runs'];
    }
    const compositeLead = awaySide === homeSide ? 'even' : awaySide > homeSide ? 'away' : 'home';
    const projectedLead = awayRuns === homeRuns ? 'even' : awayRuns > homeRuns ? 'away' : 'home';
    // Run-line cover probability is a magnitude detail, not a direction signal:
    // a sub-50% home -1.5 cover only means the projected margin is under 1.5,
    // not that the other side is favored. So it is reported, never a mismatch trigger.
    const runlineHomeFav = scoreProj?.outputs?.runline_home_minus_1_5;
    const coverNote = Number.isFinite(runlineHomeFav)
      ? ` home -1.5 cover ${Math.round(runlineHomeFav * 100)}%`
      : '';
    if (compositeLead === 'even' || projectedLead === 'even') {
      return ['INSUFFICIENT_DATA', `composite lead ${compositeLead}; projected runs ${awayRuns.toFixed(1)} vs ${homeRuns.toFixed(1)}.`];
    }
    if (compositeLead === projectedLead) {
      return ['CONSISTENT', `both favor ${compositeLead}; projected runs ${awayRuns.toFixed(1)} vs ${homeRuns.toFixed(1)};${coverNote}.`];
    }
    return ['MISMATCH', `composite leads ${compositeLead} but projected runs favor ${projectedLead} (${awayRuns.toFixed(1)} vs ${homeRuns.toFixed(1)}).`];
  })();

  const checkB = (() => {
    // Compare the projected total against the sum of projected team runs — both
    // are run-scale model outputs. (Side scores are evidence composites, not
    // runs, so they must not be summed into a "run environment" here.)
    if (!Number.isFinite(totalRuns) || !Number.isFinite(awayRuns) || !Number.isFinite(homeRuns)) {
      return ['INSUFFICIENT_DATA', 'missing total projection or projected team runs'];
    }
    const envTotal = awayRuns + homeRuns;
    const delta = Math.abs(totalRuns - envTotal);
    if (delta <= 1.0) return ['CONSISTENT', `projected total ${totalRuns.toFixed(1)} vs summed team runs ${envTotal.toFixed(1)} (gap ${delta.toFixed(1)}).`];
    if (delta >= 1.5) return ['MISMATCH', `projected total ${totalRuns.toFixed(1)} vs summed team runs ${envTotal.toFixed(1)} (gap ${delta.toFixed(1)}).`];
    return ['INSUFFICIENT_DATA', `projected total ${totalRuns.toFixed(1)} vs summed team runs ${envTotal.toFixed(1)} (gap ${delta.toFixed(1)}).`];
  })();

  const checkC = (() => {
    if (!Number.isFinite(yrfiProj?.outputs?.yrfi_prob)) {
      return ['INSUFFICIENT_DATA', 'YRFI projection unavailable'];
    }
    if (!lineupIsReady(lineupStatus)) {
      return ['INSUFFICIENT_DATA', 'starter/top-order assumptions stay provisional while lineup is not confirmed'];
    }
    if (!Number.isFinite(avgEra)) {
      return ['INSUFFICIENT_DATA', 'starter ERAs unavailable'];
    }
    const yrfiProb = Number(yrfiProj.outputs.yrfi_prob);
    const yrfiHigh = yrfiProb >= 0.5;
    const weakStarters = avgEra >= 4.0;
    if ((yrfiHigh && weakStarters) || (!yrfiHigh && !weakStarters)) {
      return ['CONSISTENT', `YRFI ${Math.round(yrfiProb * 100)}% with starter ERA average ${avgEra.toFixed(2)}.`];
    }
    return ['MISMATCH', `YRFI ${Math.round(yrfiProb * 100)}% with starter ERA average ${avgEra.toFixed(2)}.`];
  })();

  return [
    `  Game-side vs projections: ${checkA[0]} — ${checkA[1]}`,
    `  Total vs run environment: ${checkB[0]} — ${checkB[1]}`,
    `  YRFI/NRFI vs starter assumptions: ${checkC[0]} — ${checkC[1]}`,
  ].join('\n');
}

function sourceLedger(game, analysis) {
  const bundle = analysis?.final?.context_bundle ?? null;
  const coverage = analysis?.final?.coverage ?? buildMarketFamilyCoverage(game, analysis);
  const provenance = bundle?.provenance ?? {};
  const projections = analysis?.final?.projections ?? null;
  const backed = (keys) => keys.some((key) => provenance?.[key]?.status && provenance[key].status !== 'missing');
  const lines = ['Source Ledger'];
  lines.push(`  MLB_OFFICIAL: ${backed(['starters', 'lineup']) ? 'BACKED' : 'UNAVAILABLE'}${backed(['starters', 'lineup']) ? ' via starters/lineup provenance.' : ' (starters/lineup provenance missing).'}`);
  lines.push(`  STATS_ADAPTER: ${backed(['recent_form', 'bullpen', 'matchup_model']) ? 'BACKED' : 'UNAVAILABLE'}${backed(['recent_form', 'bullpen', 'matchup_model']) ? ' via recent_form/bullpen/matchup provenance.' : ' (stats provenance missing).'}`);
  lines.push(`  WEATHER_ADAPTER: ${backed(['weather']) ? 'BACKED' : 'UNAVAILABLE'}${backed(['weather']) ? ' via weather provenance.' : ' (weather provenance missing).'}`);
  lines.push(`  CONTEXT_ADAPTER: ${backed(['lineup', 'injuries']) ? 'BACKED' : 'UNAVAILABLE'}${backed(['lineup', 'injuries']) ? ' via lineup/injury provenance.' : ' (context provenance missing).'}`);
  const modelStatuses = Object.values(coverage?.families ?? {}).filter((family) => family?.status === 'NON_MARKET_COMPOSITE_READY');
  if (projections && modelStatuses.length) {
    lines.push(`  MODEL_OUTPUT: BACKED via ${modelStatuses.map((family) => family.label).join(', ')}.`);
  } else if (projections) {
    lines.push('  MODEL_OUTPUT: BACKED via projection outputs.');
  } else {
    lines.push('  MODEL_OUTPUT: UNAVAILABLE (projection outputs missing).');
  }
  lines.push('  AUDIT_ARTIFACTS_AVAILABLE: yes (customer text omits local paths; artifacts stay in inventory/meta/audit files).');
  return lines.join('\n');
}

function renderDefaultModelSection(game, analysis) {
  const coverage = analysis?.final?.coverage ?? buildMarketFamilyCoverage(game, analysis);
  const bundle = analysis?.final?.context_bundle ?? null;
  const projections = analysis?.final?.projections ?? null;
  const awayName = game.away_full ?? game.away ?? 'Away';
  const homeName = game.home_full ?? game.home ?? 'Home';
  const scoreProj = projections?.score ?? null;
  const yrfiProj = projections?.yrfi ?? null;
  const ksAway = projections?.ks_away ?? null;
  const ksHome = projections?.ks_home ?? null;
  const hrProj = projections?.hr ?? null;
  const lines = ['Game Model Results'];
  lines.push(`  Game-side composite: ${formatGameSideComposite(game, bundle)}`);
  if (bundle?.side_scores?.home != null && bundle?.side_scores?.away != null) {
    lines.push(`  Home composite score: ${fmtPoints(bundle.side_scores.home)}`);
    lines.push(`  Away composite score: ${fmtPoints(bundle.side_scores.away)}`);
  } else {
    lines.push('  Home composite score: BLOCKED_CONTEXT_MISSING');
    lines.push('  Away composite score: BLOCKED_CONTEXT_MISSING');
  }
  lines.push(`  Coverage: ${coverageSummaryLine(coverage)}`);
  lines.push('  Projected runs:');
  if (scoreProj) {
    const winLine = describeMoneyline(scoreProj, { home_team: homeName, away_team: awayName })
      .replace(/^Projected win probability —\s*/i, '');
    lines.push(`  Win probability: ${winLine}`);
    lines.push(`    Away: ${describeTeamRuns(scoreProj, 'away', awayName)}`);
    lines.push(`    Home: ${describeTeamRuns(scoreProj, 'home', homeName)}`);
    lines.push(`    Total: ${describeTotal(scoreProj)}`);
    lines.push(`    Spread/run differential: ${describeRunline(scoreProj, { home_team: homeName })}`);
  } else {
    lines.push(`  Win probability: ${projectionFallbackLabel(coverage?.families?.ml)}`);
    const spreadState = projectionFallbackLabel(coverage?.families?.spread);
    const totalState = projectionFallbackLabel(coverage?.families?.total);
    lines.push(`    Away: ${spreadState}`);
    lines.push(`    Home: ${spreadState}`);
    lines.push(`    Total: ${totalState}`);
    lines.push(`    Spread/run differential: ${spreadState}`);
  }
  if (yrfiProj) {
    lines.push(`  YRFI/NRFI: ${describeYrfi(yrfiProj)}`);
  } else {
    lines.push(`  YRFI/NRFI: ${projectionFallbackLabel(coverage?.families?.yfri)}`);
  }
  if (ksAway || ksHome) {
    lines.push('  K status: MODELED');
    lines.push(`    Away starter: ${describeKs(ksAway, `${awayName} starter`)}`);
    lines.push(`    Home starter: ${describeKs(ksHome, `${homeName} starter`)}`);
  } else {
    lines.push(`  K status: ${projectionFallbackLabel(coverage?.families?.ks)}`);
  }
  return lines.join('\n');
}

function defaultNoPickReason(game, analysis) {
  const bundle = analysis?.final?.context_bundle ?? null;
  const coverage = analysis?.final?.coverage ?? buildMarketFamilyCoverage(game, analysis);
  const projections = analysis?.final?.projections ?? null;
  const lineupStatus = bundle?.provenance?.lineup?.status ?? game?.lineup_status ?? null;
  if (!lineupIsReady(lineupStatus)) {
    return 'lineup pending keeps projections provisional';
  }
  const modeledFamilies = Object.values(coverage?.families ?? {}).filter((family) => family?.status === 'NON_MARKET_COMPOSITE_READY');
  if (modeledFamilies.length > 1) {
    return 'modeled families disagree';
  }
  if (modeledFamilies.length === 1) {
    return 'single modeled family only';
  }
  if (projections?.score?.status === 'provisional' || projections?.yrfi?.status === 'provisional') {
    return 'lineup pending keeps projections provisional';
  }
  return 'no modeled family crosses the decision threshold';
}

function renderCleanGameArticle({ date, game, analysis }) {
  const matchup = safeMatchup(game);
  const finalLabel = processStatus(analysis);
  const shownLabel = displayStatus(finalLabel);
  const contextBundle = analysis?.final?.context_bundle ?? null;
  const coverage = analysis?.final?.coverage ?? buildMarketFamilyCoverage(game, analysis);
  const gameSide = (() => {
    const awayScore = contextBundle?.side_scores?.away;
    const homeScore = contextBundle?.side_scores?.home;
    if (awayScore == null || homeScore == null) return null;
    if (awayScore === homeScore) return game.away ?? null;
    return awayScore > homeScore ? (game.away ?? null) : (game.home ?? null);
  })();
  const lines = [];
  lines.push(`${matchup} — ${isEvidenceLean(finalLabel) ? `${shownLabel} ${gameSide ?? ''}`.trim() : 'NO CLEAR PICK'}`);
  lines.push('='.repeat(Math.min(lines[0].length, 80)));
  lines.push('');
  lines.push('TLDR');
  if (isEvidenceLean(finalLabel)) {
    lines.push(`  Call: ${shownLabel} — ${gameSide ?? 'favorite'}.`);
    lines.push(`  Side / market: ${gameSide ?? 'favorite'} (non-market evidence only).`);
    lines.push('  Why: non-market evidence and the projection model point the same way.');
  } else {
    lines.push('  Call: NO CLEAR PICK.');
    lines.push(`  Why: ${defaultNoPickReason(game, analysis)}.`);
  }
  lines.push('  Market board: available for display-only audit; not used in score. Market data is display-only and NOT IN SCORE.');
  if (contextBundle) {
    lines.push('  Context: starters, lineup status, weather/park, and recent form sourced from adapters.');
  } else {
    lines.push('  Context: no sourced non-market game context was attached.');
  }
  lines.push('');
  lines.push('Game info');
  lines.push(`  Date: ${date}`);
  lines.push(`  Matchup: ${matchup}`);
  lines.push(`  First pitch: ${game.start_ct ?? game.first_pitch_ct ?? 'MISSING'}  /  ${game.start_utc ?? game.first_pitch_utc ?? 'MISSING'}`);
  lines.push(`  Game key: ${game.game_key ?? 'MISSING'}`);
  lines.push('');
  lines.push(renderGameContext(game, contextBundle));
  lines.push('');
  lines.push(renderDefaultModelSection(game, analysis));
  lines.push('');
  lines.push('Model Consistency Check');
  lines.push(modelConsistencyCheck(game, analysis));
  lines.push('');
  lines.push(sourceLedger(game, analysis));
  lines.push('');
  lines.push('Bottom Line');
  if (isEvidenceLean(finalLabel)) {
    lines.push(`  Call: ${shownLabel} — ${gameSide ?? 'favorite'}.`);
  } else {
    lines.push(`  Call: NO CLEAR PICK — ${defaultNoPickReason(game, analysis)}.`);
  }
  return {
    headline: lines[0],
    text: lines.join('\n'),
    decision: shownLabel,
    best_angle: analysis?.final?.best_angle ?? null,
    reason: analysis?.final?.reason ?? null,
    game_key: game.game_key ?? null,
  };
}

function buildAuditGameArticle({ date, game, analysis }) {
  const matchup = safeMatchup(game);
  const tickers = eventTickersFor(game);
  const best = bestSection(analysis);
  const rawLabel = decisionLabel(analysis.final.decision);
  const finalLabel = processStatus(analysis);
  const process = analysis.final.decision_process;

  const mlSnap = mlSnapshot(game);
  const totSnap = totalsSnapshot(game);
  const rfiSnap = rfiSnapshot(game);
  const spreadConf = spreadConfirmation(game, mlSnap?.fav?.team);

  const shownLabel = displayStatus(finalLabel);
  const contextBundle = analysis.final.context_bundle ?? null;
  const hasContext = hasRenderableContext(game, contextBundle);
  const coverage = getFamilyCoverage({ game, analysis });

  const headline = finalLabel === DECISION_STATUSES.MARKET_ONLY_LEAN || isEvidenceLean(finalLabel)
    ? `${matchup} — ${shownLabel} ${mlSnap?.fav?.team ?? ''}`.trim()
    : `${matchup} — NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' (limited coverage)' : ''}`;
  const finalCallLine = isEvidenceLean(finalLabel)
    ? `${shownLabel} on ${mlSnap?.fav?.team ?? 'favorite'} moneyline`
    : finalLabel === DECISION_STATUSES.MARKET_ONLY_LEAN
      ? `${shownLabel} — ${mlSnap?.fav?.team ?? 'favorite'} moneyline (board signal only, not evidence, not a pick)`
      : hasContext
        ? `NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' — limited coverage' : ''} — context reviewed, no defensible edge`
        : `NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' — limited coverage' : ''} — board only, no defensible side`;

  const lines = [];
  lines.push(headline);
  lines.push('='.repeat(Math.min(headline.length, 80)));
  lines.push('');

  // TLDR: plain-English top-of-article summary. No engine/debug vocabulary.
  lines.push('TLDR');
  if (isEvidenceLean(finalLabel)) {
    const side = mlSnap?.fav?.team ?? 'favorite';
    lines.push(`  Call: ${finalLabel} — ${side} moneyline.`);
    lines.push(`  Side / market: ${side} ML`);
    lines.push(`  Why: market signal and required MLB evidence point the same way.`);
  } else if (isMarketOnlyLean(finalLabel)) {
    const side = mlSnap?.fav?.team ?? 'board side';
    lines.push(`  Call: ${CONTEXT_WATCH} — ${side} moneyline context only.`);
    lines.push(`  Side / market: ${side} ML (context, not a pick)`);
    lines.push('  Why: board signal only, not evidence, not a pick. Market data is NOT IN SCORE.');
  } else if (hasContext) {
    lines.push(`  Call: NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' — limited coverage' : ''}.`);
    lines.push('  Side / market: none — context reviewed, no defensible edge.');
    lines.push(`  Why: ${coverage.mode === 'LIMITED' ? 'limited coverage' : 'starters, form, weather, and board reviewed'}; neither side stands out.`);
  } else {
    lines.push(`  Call: NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' — limited coverage' : ''}.`);
    lines.push('  Side / market: none — no defensible side on the board.');
    lines.push(`  Why: ${coverage.mode === 'LIMITED' ? coverageSummaryLine(coverage) : 'prices and depth read close to fair'}; no side stands out cleanly.`);
  }
  if (hasContext) {
    lines.push('  Context: starters, lineup status, weather/park, and recent form sourced from adapters.');
  } else {
    lines.push('  Risk: market-only read. No lineup, weather, starter, or park context was pulled.');
  }
  lines.push('');

  lines.push('Final Call');
  lines.push(`  ${finalCallLine}`);
  lines.push('');

  lines.push('Game info');
  lines.push(`  Date: ${date}`);
  lines.push(`  Matchup: ${matchup}`);
  lines.push(`  First pitch: ${game.start_ct ?? game.first_pitch_ct ?? 'MISSING'}  /  ${game.start_utc ?? game.first_pitch_utc ?? 'MISSING'}`);
  lines.push(`  Game key: ${game.game_key ?? 'MISSING'}`);
  lines.push(`  ML event: ${tickers.ml ?? 'MISSING'}`);
  lines.push(`  Spread event: ${tickers.spread ?? 'MISSING'}`);
  lines.push(`  Total event: ${tickers.total ?? 'MISSING'}`);
  lines.push(`  HR event: ${tickers.hr ?? 'MISSING'}`);
  lines.push(`  K event: ${tickers.ks ?? 'MISSING'}`);
  lines.push(`  YFRI event: ${tickers.rfi ?? 'MISSING'}`);
  lines.push('');

  lines.push('Market Read (display-only context — NOT IN SCORE)');
  lines.push('  ' + renderMarketRead(game, mlSnap, totSnap, rfiSnap, spreadConf));
  lines.push('');

  lines.push(renderGameContext(game, contextBundle));
  lines.push('');

  lines.push(renderFamilyStatusBlock(game, analysis));
  lines.push('');

  const whyHeader = (finalLabel === 'CLEAR' || finalLabel === 'LEAN') ? 'Why This Side' : 'Why No Pick';
  const processWhyHeader = (isEvidenceLean(finalLabel) || isMarketOnlyLean(finalLabel)) ? 'Why This Side' : whyHeader;
  lines.push(processWhyHeader);
  lines.push('  ' + renderWhyPick(analysis, mlSnap, spreadConf, finalLabel, game, coverage));
  lines.push('');

  // Evidence Box: the engine-vocabulary stuff lives here. Numbers + reasons.
  lines.push('Evidence Box');
  lines.push(`  Best angle source: ${best.key} section — raw engine label ${rawLabel}`);
  lines.push(`  Decision status: ${shownLabel}`);
  lines.push(`  Engine reason: ${analysis.final.reason}`);
  lines.push(`  Coverage mode: ${coverage.mode}`);
  lines.push(`  ML: ${coverage.families.ml.status} — ${coverage.families.ml.detail}`);
  lines.push(`  Spread: ${coverage.families.spread.status} — ${coverage.families.spread.detail}`);
  lines.push(`  Total: ${coverage.families.total.status} — ${coverage.families.total.detail}`);
  lines.push(`  YFRI: ${coverage.families.yfri.status} — ${coverage.families.yfri.detail}`);
  const propAlerts = analysis.final.prop_watchlist || [];
  const hrAlerts = propAlerts.filter((a) => a.kind === 'HR');
  const kAlerts = propAlerts.filter((a) => a.kind === 'K');
  lines.push('  HR props: ' + (hrAlerts.length
    ? `${coverage.families.hr.status} — ${hrAlerts.length} ladder anomaly(ies) — see Prop Market Watchlist (not a game pick).`
    : `${coverage.families.hr.status} — ${coverage.families.hr.detail}`));
  lines.push('  K props: ' + (kAlerts.length
    ? `${coverage.families.ks.status} — ${kAlerts.length} ladder anomaly(ies) — see Prop Market Watchlist (not a game pick).`
    : `${coverage.families.ks.status} — ${coverage.families.ks.detail}`));
  lines.push('');
  // Compact ledger appended so the Evidence Box is self-contained for audit.
  lines.push(renderMarketOverview(game));
  lines.push('');

  if (process) {
    lines.push(renderDecisionProcess(process, { heading: 'Decision Process' }));
    lines.push('');
  }

  if (propAlerts.length) {
    lines.push('Prop Market Watchlist (anomalies — not game picks)');
    for (const a of hrAlerts) {
      lines.push(`  - HR ${a.name}: MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
    }
    for (const a of kAlerts) {
      lines.push(`  - K ${a.name} (${a.side}): MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
    }
    lines.push('  Caveat: Prop anomalies are not official picks without liquidity, lineup, starter, and context confirmation.');
    lines.push('');
  }

  lines.push('Risk Notes');
  lines.push(`  Lineups: ${game.lineup_notes ? `${game.lineup_notes}` : 'MISSING (not sourced).'}`);
  lines.push(`  Weather/park: ${game.weather ? 'Sourced — see Game Context.' : 'MISSING (not sourced).'}`);
  lines.push(`  Starters: ${game.starters ? 'Sourced — see Game Context.' : 'MISSING (not sourced beyond market presence).'}`);
  lines.push('  Thin liquidity or stale rungs may have been filtered by the engine; see Evidence Box.');
  lines.push('');

  lines.push('Bottom Line');
  lines.push('  ' + renderBottomLine(analysis, mlSnap, finalLabel, game, coverage));

  // Legacy section anchors so older audit tooling still grepable for these
  // labels without changing pick logic.
  lines.push('');
  lines.push('Pick summary');
  if (isEvidenceLean(finalLabel)) {
    lines.push(`  Side / market: ${analysis.final.best_angle}`);
    lines.push(`  Confidence: ${finalLabel}`);
  } else if (isMarketOnlyLean(finalLabel)) {
    lines.push(`  Context side / market: ${analysis.final.best_angle}`);
    lines.push(`  Confidence: ${CONTEXT_WATCH} (not an evidence pick; market context NOT IN SCORE)`);
  } else {
    lines.push(`  No defensible evidence-based pick at this time${coverage.mode === 'LIMITED' ? ' — limited coverage only' : ''}.`);
    lines.push(`  Coverage: ${coverage.summary}`);
    lines.push(`  Family statuses: ML=${coverage.families.ml.status}, Spread=${coverage.families.spread.status}, Total=${coverage.families.total.status}, YFRI=${coverage.families.yfri.status}, Ks=${coverage.families.ks.status}, HR=${coverage.families.hr.status}`);
  }
  lines.push('');
  lines.push('Best angle');
  lines.push(`  Label: ${shownLabel}`);
  lines.push(`  Source: ${best.key} section`);
  lines.push('');
  lines.push('Evidence');
  lines.push('  See Evidence Box above.');
  lines.push('');
  lines.push('Risk notes');
  lines.push('  See Risk Notes above.');
  lines.push('');
  lines.push('Final call');
  lines.push('  ' + (isEvidenceLean(finalLabel) || isMarketOnlyLean(finalLabel)
    ? `${shownLabel}: ${analysis.final.best_angle}`
    : `NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' — limited coverage' : ''}. Board attached for review only.`));

  const text = scrubMarketLabel(lines.join('\n'));
  return {
    headline: scrubMarketLabel(headline),
    text,
    decision: shownLabel,
    best_angle: analysis.final.best_angle,
    reason: scrubMarketLabel(analysis.final.reason ?? ''),
    game_key: game.game_key ?? null,
  };
}

export function buildGameArticle({ date, game, analysis, audit = false }) {
  return audit
    ? buildAuditGameArticle({ date, game, analysis })
    : renderCleanGameArticle({ date, game, analysis });
}

function rankPriority(d) {
  const order = {
    [DECISION_STATUSES.STRONG_EVIDENCE_LEAN]: 0,
    [DECISION_STATUSES.EVIDENCE_LEAN]: 1,
    [DECISION_STATUSES.MARKET_ONLY_LEAN]: 2,
    [DECISION_STATUSES.WATCH]: 3,
    [DECISION_STATUSES.NO_CLEAR_PICK]: 4,
    CLEAR: 5,
    LEAN: 5,
    WATCH: 3,
    PASS: 4,
  };
  return order[d] ?? 9;
}

// Short prose blurb for a game on the slate article.
function slateBlurb(it) {
  const d = processStatus(it.analysis);
  const matchup = shortMatchup(it.game);
  const ctx = slateContextSummary(it);
  const coverage = getFamilyCoverage(it);
  if (isEvidenceLean(d)) {
    const side = ctx.supportTeam ?? 'favorite';
    const support = (ctx.supportReason ?? `Non-market evidence supports ${side} via ${ctx.starters}; ${ctx.recentForm}; ${ctx.bullpen}; ${ctx.weather}; ${ctx.lineup}.`).replace(/\.+$/, '');
    return `${matchup}: ${d} ${side} — ${support}.`;
  }
  if (isMarketOnlyLean(d)) {
    return `${matchup}: ${CONTEXT_WATCH} board signal only, not evidence, not a pick.`;
  }
  if (d === 'WATCH') {
    return `${matchup}: ML/game-side WATCH — board has a wrinkle but nothing clean enough to call.`;
  }
  return `${matchup}: ML/game-side NO CLEAR PICK${coverage.mode === 'LIMITED' ? ' (limited coverage)' : ''} — ${ctx.noPickReason}`;
}

export function buildSlateArticle({ date, items, planMeta = {} }) {
  const ranked = items
    .map((it) => ({
      game_key: it.game.game_key,
      matchup: shortMatchup(it.game),
      decision: processStatus(it.analysis),
      best_angle: it.analysis.final.best_angle,
      reason: it.analysis.final.reason,
      _it: it,
    }))
    .sort((a, b) => rankPriority(a.decision) - rankPriority(b.decision));

  const strongs = ranked.filter((r) => r.decision === DECISION_STATUSES.STRONG_EVIDENCE_LEAN);
  const evidences = ranked.filter((r) => r.decision === DECISION_STATUSES.EVIDENCE_LEAN);
  const marketOnly = ranked.filter((r) => r.decision === DECISION_STATUSES.MARKET_ONLY_LEAN);
  const watches = ranked.filter((r) => r.decision === DECISION_STATUSES.WATCH);
  const passes = ranked.filter((r) => r.decision === DECISION_STATUSES.NO_CLEAR_PICK);

  const evidenceCount = strongs.length + evidences.length;
  const anyContext = items.some((it) => hasRenderableContext(it.game, it.analysis?.final?.context_bundle ?? null));
  const limitedCoverage = evidenceCount === 0 && (marketOnly.length > 0 || passes.length > 0);
  const headline = evidenceCount
    ? `MLB ${date} Slate — ${strongs.length} strong / ${evidences.length} evidence lean across ${items.length} games`
    : `MLB ${date} Slate — no evidence lean across ${items.length} games${limitedCoverage ? ' (limited coverage)' : ''}`;

  const lines = [];
  lines.push(headline);
  lines.push('='.repeat(Math.min(headline.length, 80)));
  lines.push('');

  // TLDR: top of slate article, plain English, no engine vocabulary.
  lines.push('TLDR');
  const tldrTop = [...strongs, ...evidences];
  if (tldrTop.length) {
    lines.push('  Evidence leans:');
    let ti = 1;
    for (const r of tldrTop) {
      const snap = mlSnapshot(r._it.game);
      const fav = snap?.fav?.team ?? 'favorite';
      lines.push(`    ${ti}. ${r.matchup}: ${r.decision} ${fav}`);
      ti++;
    }
  } else {
    lines.push('  Evidence leans: none.');
  }
  if (marketOnly.length) {
    lines.push(`  ${CONTEXT_WATCH} (display-only, NOT IN SCORE):`);
    for (const r of marketOnly) {
      const snap = mlSnapshot(r._it.game);
      const fav = snap?.fav?.team ?? 'board side';
      lines.push(`    - ${r.matchup}: ${fav} (downgraded; board signal only, not evidence, not a pick)`);
    }
  } else {
    lines.push(`  ${CONTEXT_WATCH}: none.`);
  }
  if (passes.length) {
    lines.push('  Pass / no-pick:');
    for (const r of passes) lines.push(`    - ${r.matchup}`);
    lines.push(`  Coverage note: ${coverageSummaryLine(getFamilyCoverage(passes[0]._it))}`);
  } else {
    lines.push('  Pass / no-pick: none — every game produced at least a watch-level read.');
  }
  if (evidenceCount) {
    lines.push(`  Takeaway: ${evidenceCount} evidence-backed read(s); no trades or sizing.`);
  } else if (marketOnly.length) {
    lines.push(`  Takeaway: ${marketOnly.length} context watch(es), but no evidence picks. Market context is NOT IN SCORE.`);
  } else if (passes.length) {
    lines.push(`  Takeaway: ${limitedCoverageSentence(getFamilyCoverage(passes[0]._it))} and the slate still has no evidence picks.`);
  } else {
    lines.push('  Takeaway: no defensible side stands out.');
  }
  lines.push('');

  lines.push('Slate overview');
  lines.push(`  Date: ${date}`);
  lines.push(`  Games covered: ${items.length}`);
  lines.push(`  STRONG EVIDENCE LEAN: ${strongs.length}   EVIDENCE LEAN: ${evidences.length}   ${CONTEXT_WATCH}: ${marketOnly.length}   WATCH: ${watches.length}   ML/GAME-SIDE NO CLEAR PICK: ${passes.length}`);
  if (planMeta.cluster_count != null) lines.push(`  Plan clusters: ${planMeta.cluster_count}`);
  lines.push('');

  lines.push('Best angles ranked');
  const top = [...strongs, ...evidences, ...marketOnly, ...watches];
  if (!top.length) {
    lines.push('  None — no game produced a defensible angle.');
  } else {
    let i = 1;
    for (const r of top) {
      const snap = mlSnapshot(r._it.game);
      const fav = snap?.fav?.team ?? 'favorite';
      lines.push(`  ${i}. [${displayStatus(r.decision)}] ${r.matchup} — side: ${fav}.`);
      i++;
    }
  }
  lines.push('');

  lines.push('Tiered ranking');
  lines.push('  Tier 1 — STRONG EVIDENCE LEAN');
  if (!strongs.length) lines.push('    (none)');
  for (const r of strongs) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push('  Tier 2 — EVIDENCE LEAN');
  if (!evidences.length) lines.push('    (none)');
  for (const r of evidences) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push(`  Tier 3 — ${CONTEXT_WATCH} (display-only context, NOT IN SCORE)`);
  if (!marketOnly.length) lines.push('    (none)');
  for (const r of marketOnly) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push('  Tier 4 — WATCH');
  if (!watches.length) lines.push('    (none)');
  for (const r of watches) lines.push(`    - ${r.matchup} (${r.game_key}): ${r.best_angle}`);
  lines.push(`  Tier 5 — ML/game-side NO CLEAR PICK${limitedCoverage ? ' (limited coverage)' : ''}`);
  if (!passes.length) lines.push('    (none)');
  for (const r of passes) lines.push(`    - ${r.matchup} (${r.game_key})`);
  lines.push('');

  lines.push('Game-by-game ML/game-side evidence');
  for (const r of ranked) {
    lines.push('  ' + slateBlurb(r._it));
  }
  lines.push('');

  lines.push('Market-family coverage');
  for (const r of ranked) {
    const coverage = getFamilyCoverage(r._it);
    const familyLines = familyStatusLines(r._it);
    lines.push(`  ${familyLines[0]}`);
    lines.push(`    - Coverage mode: ${coverage.mode} — ${coverage.mode === 'LIMITED' ? 'limited coverage; board analyzers remain display-only and NOT IN SCORE.' : 'full modeled coverage.'}`);
    lines.push(`    - Coverage summary: ${coverage.summary}.`);
    for (const line of familyLines.slice(1)) {
      lines.push(`    - ${line}`);
    }
  }
  lines.push('');

  lines.push('ML/game-side pass / no-pick games');
  if (!passes.length) {
    lines.push('  (none — every game produced at least a WATCH-level read)');
  } else {
    for (const r of passes) lines.push(`  - ${r.matchup} (${r.game_key})`);
  }
  lines.push('');

  // Prop Market Watchlist: HR/K ladder anomalies are NOT slate picks.
  lines.push('Prop Market Watchlist (anomalies — not game picks)');
  let propCount = 0;
  for (const it of items) {
    const alerts = it.analysis.final.prop_watchlist || [];
    if (!alerts.length) continue;
    lines.push(`  ${shortMatchup(it.game)} (${it.game.game_key}):`);
    for (const a of alerts) {
      const tag = a.kind === 'K' ? `K ${a.name} (${a.side})` : `HR ${a.name}`;
      lines.push(`    - ${tag}: MARKET ANOMALY (raw=${a.raw_decision}) — ${a.reason}`);
      propCount++;
    }
  }
  if (!propCount) lines.push('  No prop ladder anomalies detected on the slate.');
  lines.push('  Caveat: Prop anomalies are not official picks without liquidity, lineup, starter, and context confirmation.');
  lines.push('');

  lines.push('System caveats');
  if (anyContext) {
    lines.push('  Context was sourced on one or more games; missing layers are marked per game in Game Context.');
  } else {
    lines.push('  No lineup, weather, park, starter form, or bullpen context was pulled.');
  }
  lines.push('  Price, OI/liquidity, spread confirmation, and ladder behavior cannot create an evidence pick by themselves.');
  lines.push('  All market data in this report (prices, OI, volume, movement) is display-only context and NOT IN SCORE — it is never a model, scoring, posture, or ranking input.');
  lines.push(`  Raw engine CLEAR/LEAN labels are capped at ${CONTEXT_WATCH} until the required MLB evidence checklist is complete.`);
  lines.push('  No trades. No bankroll sizing. Research only.');
  lines.push('');

  lines.push('Final slate conclusion');
  if (evidenceCount === 0 && marketOnly.length === 0) {
    lines.push(passes.length
      ? '  Slate has no evidence lean and limited coverage remains on board-only or blocked families.'
      : '  Slate has no evidence lean and no context watch. Watch for new evidence.');
  } else if (evidenceCount === 0) {
    lines.push(`  Slate has ${marketOnly.length} context watch(es), all downgraded for incomplete context; none is a pick.`);
  } else if (strongs.length) {
    lines.push(`  Slate has ${strongs.length} strong evidence lean(s); no trades or sizing.`);
  } else {
    lines.push(`  Slate has ${evidences.length} evidence lean(s); no trades or sizing.`);
  }

  // Strip the temporary _it back-references so output is JSON-safe in callers.
  const cleanRanked = ranked.map(({ _it, ...rest }) => rest);

  return {
    headline: scrubMarketLabel(headline),
    text: scrubMarketLabel(lines.join('\n')),
    ranked: cleanRanked,
    counts: {
      strong_evidence_lean: strongs.length,
      evidence_lean: evidences.length,
      context_watch: marketOnly.length,
      watch: watches.length,
      no_clear_pick: passes.length,
    },
  };
}
