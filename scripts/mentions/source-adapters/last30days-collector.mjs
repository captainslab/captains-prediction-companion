// last30days-collector.mjs
//
// Real source-backed evidence collection via the last30days skill CLI
// (mvanhorn/last30days-skill). Free sources only: reddit, youtube,
// hackernews, polymarket, github. No paid providers, no X.
//
// Strategy: ONE last30days fetch per event topic, then LOCAL exact-string
// matching per strike against the fetched corpus. YouTube items from the
// speaker's own channel are upgraded to transcripts via yt-dlp (free) so
// verbatim hits count as tier-1 prior_transcript_word_match evidence.
//
// NEVER includes pricing fields. Read-only. No trades.

import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const L30D_CLI = process.env.LAST30DAYS_CLI
  ?? join(homedir(), '.claude', 'skills', 'last30days', 'scripts', 'last30days.py');
const DEFAULT_SOURCES = 'reddit,youtube,hackernews';
const FETCH_TIMEOUT_MS = 240_000;
const TRANSCRIPT_LIMIT = 3; // yt-dlp pulls per event (politeness + speed)

// ---------------------------------------------------------------------------
// last30days fetch
// ---------------------------------------------------------------------------

export function runLast30Days(topic, { sources = DEFAULT_SOURCES, lookbackDays = 30, extraArgs = [] } = {}) {
  if (!existsSync(L30D_CLI)) {
    return { ok: false, error: `last30days CLI not found at ${L30D_CLI}`, report: null };
  }
  const args = [
    L30D_CLI, topic,
    '--search', sources,
    '--emit', 'json',
    '--quick',
    '--lookback-days', String(lookbackDays),
    ...extraArgs,
  ];
  try {
    const raw = execFileSync('python3', args, {
      encoding: 'utf8',
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, error: null, report: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `last30days fetch failed: ${err.message}`, report: null };
  }
}

export function flattenItems(report) {
  const bySource = report?.items_by_source ?? {};
  const items = [];
  for (const [source, list] of Object.entries(bySource)) {
    if (!Array.isArray(list)) continue;
    for (const it of list) {
      items.push({
        source,
        title: it.title ?? '',
        text: [it.title, it.snippet, it.body].filter(Boolean).join('\n'),
        url: it.url ?? it.metadata?.hn_url ?? null,
        author: it.author ?? null,
        container: it.container ?? null,
        published_at: it.published_at ?? null,
        engagement_score: it.engagement_score ?? 0,
        relevance: it.local_relevance ?? it.relevance_hint ?? 0,
        transcript: null, // filled by collectYoutubeTranscripts for youtube items
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// yt-dlp transcript upgrade (tier-1 evidence)
// ---------------------------------------------------------------------------

function vttToText(vtt) {
  return vtt
    .split('\n')
    .filter((l) => l.trim()
      && !l.startsWith('WEBVTT')
      && !l.startsWith('Kind:')
      && !l.startsWith('Language:')
      && !/^\d{2}:\d{2}/.test(l)
      && !/-->/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l, i, arr) => l && l !== arr[i - 1]) // drop empty + consecutive dupes
    .join(' ');
}

function fetchTranscript(url) {
  const dir = mkdtempSync(join(tmpdir(), 'cpc-yt-'));
  try {
    execFileSync('yt-dlp', [
      '--skip-download',
      '--write-auto-subs', '--write-subs',
      '--sub-langs', 'en.*',
      '--sub-format', 'vtt',
      '-o', join(dir, 'sub'),
      url,
    ], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'ignore', 'ignore'] });
    const vttFile = readdirSync(dir).find((f) => f.endsWith('.vtt'));
    if (!vttFile) return null;
    return vttToText(readFileSync(join(dir, vttFile), 'utf8'));
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Fallback: when last30days returns no YouTube items, search YouTube directly
 * via yt-dlp (free, no key) for the speaker's recent videos and append them
 * as synthetic youtube items so transcripts can still be pulled.
 */
export function ytdlpSearchFallback(items, { speakerHint, limit = TRANSCRIPT_LIMIT } = {}) {
  if (!speakerHint) return 0;
  try {
    const raw = execFileSync('yt-dlp', [
      `ytsearch${limit * 2}:${speakerHint}`,
      '--flat-playlist',
      '--print', '%(id)s\t%(title)s\t%(channel)s\t%(upload_date)s',
      '--no-warnings',
    ], { encoding: 'utf8', timeout: 90_000 });
    let added = 0;
    for (const line of raw.trim().split('\n')) {
      const [id, title, channel, uploadDate] = line.split('\t');
      if (!id) continue;
      items.push({
        source: 'youtube',
        title: title ?? '',
        text: title ?? '',
        url: `https://www.youtube.com/watch?v=${id}`,
        author: channel ?? null,
        container: channel ?? null,
        published_at: uploadDate && uploadDate !== 'NA'
          ? `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
          : null,
        engagement_score: 0,
        relevance: 0.5,
        transcript: null,
        _via: 'ytdlp_search_fallback',
      });
      added += 1;
    }
    return added;
  } catch {
    return 0;
  }
}

/**
 * Pulls transcripts for the top YouTube items (by relevance) in place.
 * speakerHint (optional) prioritizes items whose author/container matches —
 * those transcripts are the speaker's own words (tier 1), others stay proxy.
 */
export function collectYoutubeTranscripts(items, { speakerHint = null, limit = TRANSCRIPT_LIMIT } = {}) {
  const yt = items.filter((i) => i.source === 'youtube' && i.url);
  const hint = speakerHint ? speakerHint.toLowerCase() : null;
  yt.sort((a, b) => {
    const aSpeaker = hint && `${a.author} ${a.container}`.toLowerCase().includes(hint) ? 1 : 0;
    const bSpeaker = hint && `${b.author} ${b.container}`.toLowerCase().includes(hint) ? 1 : 0;
    return (bSpeaker - aSpeaker) || (b.relevance - a.relevance);
  });
  let fetched = 0;
  let attempted = 0;
  for (const item of yt) {
    if (fetched >= limit) break;
    attempted += 1;
    const transcript = fetchTranscript(item.url);
    if (transcript) {
      item.transcript = transcript;
      item.transcript_is_speaker = hint
        ? `${item.author} ${item.container}`.toLowerCase().includes(hint)
        : false;
      fetched += 1;
    }
  }
  return { fetched, attempted, candidates: yt.length };
}

// ---------------------------------------------------------------------------
// Exact-string matching (mention-market word rules)
// ---------------------------------------------------------------------------

/**
 * Strike text like "Sponsor / Sponsored" or "AI / Artificial Intelligence"
 * lists alternates. Each alternate matches as exact word/phrase, allowing
 * plurals and possessives per mention-market rules.
 */
export function strikeVariants(strikeText) {
  return String(strikeText)
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function variantRegex(variant) {
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}(?:s|'s|s')?\\b`, 'i');
}

export function matchStrike(strikeText, text) {
  if (!text) return null;
  for (const v of strikeVariants(strikeText)) {
    const m = variantRegex(v).exec(text);
    if (m) {
      const at = m.index;
      return {
        variant: v,
        excerpt: text.slice(Math.max(0, at - 80), at + v.length + 80).replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ladder input mapping
// ---------------------------------------------------------------------------

function evidenceDetail(item, hit) {
  return {
    source: item.source,
    url: item.url,
    author: item.author,
    published_at: item.published_at,
    variant: hit?.variant ?? null,
    excerpt: hit?.excerpt ?? null,
  };
}

/**
 * Builds source_ladder_inputs for ONE strike from the fetched corpus.
 *
 * Honest tiering:
 *  - prior_transcript_word_match: verbatim hit in a SPEAKER-OWN transcript → used;
 *    hit in a non-speaker transcript (interview clip, recap) → proxy.
 *  - recent_direct_quote_match: NOT claimable from social chatter; stays missing
 *    unless a transcript hit doubles as a quote within the window.
 *  - current_event_context: any relevant items → used.
 *  - prompt_likelihood: items whose TEXT hits the strike → used (discussion volume).
 */
export function buildLadderInputsForStrike(strikeText, items, { fetchError = null, transcriptStats = null } = {}) {
  if (fetchError) {
    const blocked = { status: 'blocked', note: fetchError };
    return {
      prior_transcript_word_match: blocked,
      recent_direct_quote_match: blocked,
      current_event_context: blocked,
      prompt_likelihood: blocked,
    };
  }

  const transcriptHits = [];
  const textHits = [];
  for (const item of items) {
    if (item.transcript) {
      const hit = matchStrike(strikeText, item.transcript);
      if (hit) transcriptHits.push({ item, hit });
    }
    const tHit = matchStrike(strikeText, item.text);
    if (tHit) textHits.push({ item, hit: tHit });
  }
  const speakerTranscriptHits = transcriptHits.filter((h) => h.item.transcript_is_speaker);
  const transcriptsChecked = items.filter((i) => i.transcript).length;

  const inputs = {};

  if (speakerTranscriptHits.length) {
    inputs.prior_transcript_word_match = {
      status: 'used',
      note: `verbatim hit in ${speakerTranscriptHits.length} speaker transcript(s) via yt-dlp`,
      source_path: speakerTranscriptHits[0].item.url,
      hits: speakerTranscriptHits.length,
      detail: speakerTranscriptHits.slice(0, 3).map((h) => evidenceDetail(h.item, h.hit)),
    };
  } else if (transcriptHits.length) {
    inputs.prior_transcript_word_match = {
      status: 'proxy',
      note: `verbatim hit in ${transcriptHits.length} non-speaker transcript(s) (clip/recap, not speaker-own channel)`,
      source_path: transcriptHits[0].item.url,
      hits: transcriptHits.length,
      detail: transcriptHits.slice(0, 3).map((h) => evidenceDetail(h.item, h.hit)),
    };
  } else if (transcriptsChecked > 0) {
    inputs.prior_transcript_word_match = {
      status: 'used',
      note: `0 verbatim hits across ${transcriptsChecked} transcript(s) checked — absence evidence`,
      hits: 0,
    };
  } else if (transcriptStats?.attempted > 0) {
    inputs.prior_transcript_word_match = {
      status: 'blocked',
      note: `transcript fetch blocked for all ${transcriptStats.attempted} attempted video(s) — YouTube bot-check on this host; treat as undercounted, NOT absence evidence`,
    };
  } else {
    inputs.prior_transcript_word_match = {
      status: 'undercounted',
      note: 'no candidate speaker videos found in corpus or via yt-dlp search',
    };
  }

  inputs.recent_direct_quote_match = speakerTranscriptHits.length
    ? {
      status: 'used',
      note: 'speaker said variant on-record within lookback window (transcript-backed)',
      source_path: speakerTranscriptHits[0].item.url,
      hits: speakerTranscriptHits.length,
    }
    : {
      status: 'missing',
      note: 'no transcript-backed speaker quote in window; social chatter does not qualify as a direct quote',
    };

  inputs.current_event_context = items.length
    ? {
      status: 'used',
      note: `${items.length} relevant item(s) from last30days (${[...new Set(items.map((i) => i.source))].join(', ')})`,
      source_path: items[0]?.url ?? null,
      hits: items.length,
      detail: items.slice(0, 5).map((i) => evidenceDetail(i, null)),
    }
    : { status: 'missing', note: 'last30days returned no relevant items for topic' };

  inputs.prompt_likelihood = textHits.length
    ? {
      status: 'used',
      note: `strike discussed in ${textHits.length} social item(s) — topic is live in the discourse`,
      source_path: textHits[0].item.url,
      hits: textHits.length,
      detail: textHits.slice(0, 3).map((h) => evidenceDetail(h.item, h.hit)),
    }
    : { status: 'missing', note: 'strike absent from fetched social discussion' };

  return inputs;
}

// ---------------------------------------------------------------------------
// Top-level: one event → per-strike ladder inputs
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.topic        - last30days research topic (event-level)
 * @param {string[]} opts.strikes    - resolving strings (one per market)
 * @param {string} [opts.speakerHint]- speaker/channel name for transcript tiering
 * @param {string} [opts.sources]    - comma list (free sources only by default)
 * @param {number} [opts.lookbackDays]
 * @param {boolean}[opts.transcripts]- pull yt-dlp transcripts (default true)
 */
export function collectLast30DaysEvidence({
  topic, strikes, speakerHint = null, sources = DEFAULT_SOURCES,
  lookbackDays = 30, transcripts = true,
}) {
  const fetchedAt = new Date().toISOString();
  const { ok, error, report } = runLast30Days(topic, { sources, lookbackDays });
  const items = ok ? flattenItems(report) : [];
  let transcriptStats = null;
  if (ok && transcripts) {
    if (!items.some((i) => i.source === 'youtube') && speakerHint) {
      ytdlpSearchFallback(items, { speakerHint });
    }
    transcriptStats = collectYoutubeTranscripts(items, { speakerHint });
  }

  const perStrike = {};
  for (const strike of strikes) {
    perStrike[strike] = buildLadderInputsForStrike(strike, items, { fetchError: ok ? null : error, transcriptStats });
  }

  return {
    adapter: 'last30days-collector',
    research_quality: ok && items.length ? 'live' : 'stub',
    fetched_at: fetchedAt,
    topic,
    sources,
    lookback_days: lookbackDays,
    fetch_ok: ok,
    fetch_error: error,
    item_count: items.length,
    transcripts_fetched: transcriptStats?.fetched ?? 0,
    transcripts_attempted: transcriptStats?.attempted ?? 0,
    per_strike: perStrike,
  };
}
