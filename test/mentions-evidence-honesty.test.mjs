// Evidence-honesty tests: make absent historical evidence visible and non-confident.
//
// Covers:
//   1. loadHistoryWithStatus: store_missing vs read_error vs ok-empty.
//   2. A strike with zero settled comparables AND no transcript produces an
//      explicit SOURCE GAPS entry naming each missing source.
//   3. Current-context-only evidence CANNOT produce STRONG YES — score is
//      clamped below 65 and confidence_cap_reason is set.
//   4. A strike WITH real comparables (kalshi_native_n >= 2) is NOT capped
//      and still scores normally (guard against over-capping).
//   5. Settlement text contains the strike token and its accepted forms and
//      does NOT contain the full market title.
//   6. Price fields still never influence score/order.
//
// All tests are in-memory; no network, no state writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadHistoryWithStatus,
  loadHistory,
  historyStorePath,
} from '../scripts/mentions/settled-history.mjs';
import {
  mentionCompositeToDecisionRow,
  buildMentionsSynthesisInput,
  computeEvidenceAvailability,
} from '../scripts/packets/generate-mentions-daily.mjs';
import { buildResearchTermNote } from '../scripts/mentions/mentions-research-perplexity.mjs';
import { renderMentionPacket } from '../scripts/mentions/render-mention-packet.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A composite that scores on current-context only: it has layers (so it is
// NOT blocked / proximity-only), a blended_pct override of 85, but NO settled
// comparables (kalshi_native_n = 0) and NO transcript word-match (source
// ladder prior_transcript_word_match status = 'missing'). This is the JPM
// earnings shape: current-context forecast, zero historical evidence.
function currentContextOnlyComposite({ score = 85, kalshiNativeN = 0 } = {}) {
  return {
    market_ticker: 'KXEARNINGSMENTIONJPM-26JUL14-TAILWIND',
    result: {
      _meta: { layers_present: 3, layers_total: 6, research_quality: 'live' },
      posture: 'PICK',
      composite_score: score,
      target_mention: 'Tailwind',
      top_supporting_layers: [{ category: 'current_event_context' }],
      missing_layers: [],
      market_context: {},
      reasoning_summary: `research_score=${score} [PICK]`,
      profile: 'earnings_mentions',
    },
    posture_final: 'PICK',
    research_quality: 'live',
    source_status: 'SOURCE_FETCHED',
    settled_history: null,
    kalshi_native_pct: null,
    kalshi_native_n: kalshiNativeN,
    kalshi_scan_ok: true,
    kalshi_events_scanned: 1,
    source_ladder: {
      profile: 'earnings_mentions',
      categories: [
        { category: 'prior_transcript_word_match', status: 'missing', note: 'no prior transcript mentions found', source_path: null },
        { category: 'recent_direct_quote_match', status: 'missing', note: 'no recent direct quote', source_path: null },
        { category: 'current_event_context', status: 'used', note: 'current context', source_path: null },
      ],
      used: ['current_event_context'],
      missing: ['prior_transcript_word_match', 'recent_direct_quote_match'],
    },
  };
}

// A composite WITH real comparables: kalshi_native_n >= 2 and a settled
// history artifact with a non-'none' tier. This must NOT be capped.
function historicallyBackedComposite({ score = 85 } = {}) {
  return {
    market_ticker: 'KXTRUMPMENTION-26JUL14-CHINA',
    result: {
      _meta: { layers_present: 3, layers_total: 6, research_quality: 'live' },
      posture: 'PICK',
      composite_score: score,
      target_mention: 'China',
      top_supporting_layers: [{ category: 'historical_tendency' }],
      missing_layers: [],
      market_context: {},
      reasoning_summary: `research_score=${score} [PICK]`,
      profile: 'political_mentions',
    },
    posture_final: 'PICK',
    research_quality: 'live',
    source_status: 'SOURCE_FETCHED',
    settled_history: {
      match_tier: 'exact_horizon',
      sample_size: 14,
      hits: 13,
      misses: 1,
      hit_rate: 0.928,
      source_tickers: ['KXTRUMPMENTION-26JAN14-CHINA'],
    },
    kalshi_native_pct: 92,
    kalshi_native_n: 14,
    source_ladder: {
      profile: 'political_mentions',
      categories: [
        { category: 'prior_transcript_word_match', status: 'used', note: 'keyword found in 85% of prior transcripts', source_path: 'https://example/transcript' },
        { category: 'current_event_context', status: 'used', note: 'current context', source_path: null },
      ],
      used: ['prior_transcript_word_match', 'current_event_context'],
      missing: [],
    },
  };
}

function earningsEvent() {
  return {
    event_ticker: 'KXEARNINGSMENTIONJPM-26JUL14',
    series_ticker: 'KXEARNINGSMENTIONJPM',
    title: 'Will JPM mention Tailwind on the Q3 FY2026 earnings call?',
    sub_title: 'JPM earnings call',
    settlement_sources: [{ name: 'JPM IR', url: 'https://jpm.example/ir' }],
    markets: [
      {
        ticker: 'KXEARNINGSMENTIONJPM-26JUL14-TAILWIND',
        title: 'Will JPM mention Tailwind on the Q3 FY2026 earnings call?',
        yes_sub_title: 'Tailwind',
        custom_strike: 'Tailwind',
        rules_primary: 'Resolves YES if JPM says Tailwind during the earnings call.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. loadHistoryWithStatus: store_missing vs read_error vs ok-empty
// ---------------------------------------------------------------------------

test('loadHistoryWithStatus returns store_missing for a non-existent store dir (ENOENT)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-missing-'));
  const stateRoot = join(root, 'definitely-does-not-exist');
  const res = await loadHistoryWithStatus({ stateRoot });
  assert.equal(res.status, 'store_missing');
  assert.deepEqual(res.records, []);
  assert.deepEqual(res.errors, []);
});

test('loadHistoryWithStatus returns ok with zero records for an empty-but-readable store dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-empty-'));
  const stateRoot = join(root, 'state');
  mkdirSync(historyStorePath(stateRoot), { recursive: true });
  const res = await loadHistoryWithStatus({ stateRoot });
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.records, []);
  assert.deepEqual(res.errors, []);
});

test('loadHistoryWithStatus returns read_error for a corrupt/unreadable store file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-corrupt-'));
  const stateRoot = join(root, 'state');
  const dir = historyStorePath(stateRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'KXTEST.json'), '{ not valid json ]');
  const res = await loadHistoryWithStatus({ stateRoot });
  assert.equal(res.status, 'read_error');
  assert.ok(res.errors.length > 0, 'per-file error collected');
  assert.deepEqual(res.records, []);
});

test('loadHistoryWithStatus returns ok with records for a valid store file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-ok-'));
  const stateRoot = join(root, 'state');
  const dir = historyStorePath(stateRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'KXTEST.json'), JSON.stringify({
    updated_utc: '2026-07-14T00:00:00Z',
    records: [
      { market_ticker: 'KXTEST-1', series_ticker: 'KXTEST', result: 'yes', settlement_result: 'resolved_yes' },
      { market_ticker: 'KXTEST-2', series_ticker: 'KXTEST', result: 'no', settlement_result: 'resolved_no' },
    ],
  }));
  const res = await loadHistoryWithStatus({ stateRoot });
  assert.equal(res.status, 'ok');
  assert.equal(res.records.length, 2);
  assert.deepEqual(res.errors, []);
});

test('loadHistory (back-compat) still returns [] for a missing store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-bc-'));
  const stateRoot = join(root, 'no-store');
  const records = await loadHistory({ stateRoot });
  assert.deepEqual(records, []);
});

// ---------------------------------------------------------------------------
// 2. SOURCE GAPS: zero settled + no transcript -> explicit gap lines
// ---------------------------------------------------------------------------

test('a strike with zero settled comparables and no transcript produces explicit SOURCE GAPS lines', () => {
  const composite = currentContextOnlyComposite({ score: 85 });
  const row = mentionCompositeToDecisionRow(composite);
  const ev = row.evidence_availability;
  assert.ok(ev, 'evidence_availability plumbed onto row');
  assert.notEqual(ev.settled_evidence.status, 'present', 'settled evidence absent');
  assert.notEqual(ev.transcript_evidence.status, 'present', 'transcript evidence absent');

  const input = buildMentionsSynthesisInput({
    date: '2026-07-14',
    event: earningsEvent(),
    rows: [row],
  });
  const text = renderMentionPacket(input, { generatedAtUtc: '2026-07-14T12:00:00.000Z' });
  assert.ok(text, 'packet rendered');
  assert.match(text, /evidence availability gaps/i);
  assert.match(text, /settled history: no settled comparables/i);
  assert.match(text, /transcript source not available/i);
  // The full-strike appendix still renders full strike text — that is fine.
  // The gap block must not contain a price-shaped field.
  const gapsStart = text.indexOf('5. SOURCE GAPS');
  const gapsEnd = text.indexOf('6. QUALIFICATION');
  const gapsBlock = text.slice(gapsStart, gapsEnd);
  assert.ok(gapsBlock.length > 0, 'gaps block extracted');
  assert.doesNotMatch(gapsBlock, /- none/);
  assert.doesNotMatch(gapsBlock, /\b(yes_bid|yes_ask|no_bid|no_ask|volume|open_interest|implied_probability|last_price)\b/i);
});

test('a fully evidenced strike with no research gaps renders only - none in SOURCE GAPS', () => {
  const composite = historicallyBackedComposite({ score: 85 });
  const row = mentionCompositeToDecisionRow(composite);
  const input = buildMentionsSynthesisInput({
    date: '2026-07-14',
    event: earningsEvent(),
    rows: [row],
  });
  const text = renderMentionPacket(input, { generatedAtUtc: '2026-07-14T12:00:00.000Z' });
  const gapsStart = text.indexOf('5. SOURCE GAPS');
  const gapsEnd = text.indexOf('6. QUALIFICATION');
  const gapsBlock = text.slice(gapsStart, gapsEnd);
  assert.equal(gapsBlock, '5. SOURCE GAPS\n- none\n\n');
  assert.doesNotMatch(gapsBlock, /evidence availability gaps|confidence cap/i);
});

// ---------------------------------------------------------------------------
// 3. Current-context-only evidence CANNOT produce STRONG YES
// ---------------------------------------------------------------------------

test('current-context-only evidence clamps score below 65 and sets confidence_cap_reason', () => {
  const composite = currentContextOnlyComposite({ score: 85 });
  const row = mentionCompositeToDecisionRow(composite);
  assert.ok(row.composite_score !== null, 'score is still a number (not nulled)');
  assert.ok(row.composite_score < 65, `score must be < 65, got ${row.composite_score}`);
  assert.ok(row.confidence_cap_reason, 'confidence_cap_reason is set');
  assert.match(row.confidence_cap_reason, /current-context-only/i);
  // The tier derived from the clamped score is WEAK YES (not STRONG YES).
  // scoreToTier: >=65 STRONG YES, >=50 WEAK YES.
  assert.ok(row.composite_score >= 50, `score should still be WEAK YES territory (>=50), got ${row.composite_score}`);
});

test('source-backed labels without actual historical evidence do not bypass the cap', () => {
  const composite = currentContextOnlyComposite({ score: 85, kalshiNativeN: 0 });
  composite.research_quality = 'source_backed';
  composite.source_status = 'SOURCE_FETCHED';
  composite.kalshi_scan_ok = true;
  composite.kalshi_events_scanned = 4;
  composite.settled_history = null;
  const row = mentionCompositeToDecisionRow(composite);

  assert.ok(row.composite_score <= 64, `score must be capped, got ${row.composite_score}`);
  assert.notEqual(row.composite_posture, 'STRONG YES');
  assert.ok(row.confidence_cap_reason, 'confidence_cap_reason is set');
});

test('real settled comparables still exempt a source-backed label from the cap', () => {
  const composite = historicallyBackedComposite({ score: 85 });
  composite.research_quality = 'source_backed';
  composite.source_status = 'SOURCE_FETCHED';
  composite.kalshi_native_n = 14;
  composite.kalshi_scan_ok = true;
  composite.kalshi_events_scanned = 4;
  composite.settled_history = null;
  const row = mentionCompositeToDecisionRow(composite);

  assert.equal(row.composite_score, 85);
  assert.equal(row.confidence_cap_reason, null);
});

test('a score already below 65 is not further clamped and sets no cap reason', () => {
  const composite = currentContextOnlyComposite({ score: 55 });
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.composite_score, 55, 'score unchanged (already below cap)');
  assert.equal(row.confidence_cap_reason, null, 'no cap reason when already below cap');
});

// ---------------------------------------------------------------------------
// 4. A strike WITH real comparables is NOT capped
// ---------------------------------------------------------------------------

test('a strike with real comparables (kalshi_native_n >= 2) is NOT capped and scores normally', () => {
  const composite = historicallyBackedComposite({ score: 85 });
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.composite_score, 85, 'score unchanged — real evidence, no cap');
  assert.equal(row.confidence_cap_reason, null, 'no cap reason when historical evidence exists');
  // evidence_availability reports present for both sources.
  const ev = row.evidence_availability;
  assert.equal(ev.settled_evidence.status, 'present');
  assert.equal(ev.transcript_evidence.status, 'present');
});

test('a strike with settled history artifact but no transcript is NOT capped (settled counts as historical)', () => {
  const composite = historicallyBackedComposite({ score: 90 });
  // Remove transcript evidence but keep settled history.
  composite.source_ladder = {
    profile: 'political_mentions',
    categories: [
      { category: 'prior_transcript_word_match', status: 'missing', note: 'none', source_path: null },
      { category: 'current_event_context', status: 'used', note: 'ctx', source_path: null },
    ],
    used: ['current_event_context'],
    missing: ['prior_transcript_word_match'],
  };
  const row = mentionCompositeToDecisionRow(composite);
  assert.equal(row.composite_score, 90, 'settled history alone prevents the cap');
  assert.equal(row.confidence_cap_reason, null);
});

// ---------------------------------------------------------------------------
// 5. Settlement text: strike token + accepted forms, NOT full title
// ---------------------------------------------------------------------------

test('buildResearchTermNote settlement_fit lists strike token and accepted forms, not full title', () => {
  const note = buildResearchTermNote({
    phrase: 'Afford / Affordable (N+ times)',
    reason: 'habit/news-cycle pressure',
    kalshiNativePct: 50,
    kalshiNativeN: 2,
    proofPct: 10,
    handicapPct: 72,
    requiredCount: 3,
    acceptedForms: ['Afford', 'Affordable', 'Affords', "Afford's"],
  });
  assert.ok(note, 'note built');
  assert.match(note.settlement_fit, /either exact token "Afford" or "Affordable"/);
  // Accepted forms (plural/possessive) are listed too.
  assert.match(note.settlement_fit, /"Affords"/);
  // The full market title must NOT appear.
  assert.doesNotMatch(note.settlement_fit, /Will .* mention/i);
  assert.match(note.settlement_fit, /Requires 3 or more qualifying mentions, not just one\./);
});

test('buildResearchTermNote without acceptedForms still uses slash variants from the strike token', () => {
  const note = buildResearchTermNote({
    phrase: 'Tailwind',
    reason: 'current context',
    kalshiNativePct: null,
    kalshiNativeN: null,
    proofPct: 80,
    handicapPct: null,
  });
  assert.ok(note);
  assert.match(note.settlement_fit, /exact token "Tailwind"/);
  assert.doesNotMatch(note.settlement_fit, /--/);
});

test('describeSettlementFit does not interpolate a full title when handed a bare token', () => {
  // Simulate the OLD bug: phrase = "<title> -- <strike>".
  // The fix passes the bare token. Verify the bare-token path does not emit
  // the " -- " separator.
  const note = buildResearchTermNote({
    phrase: 'Tailwind',
    reason: 'current context',
    proofPct: 80,
  });
  assert.ok(note);
  assert.doesNotMatch(note.settlement_fit, / -- /);
  assert.match(note.settlement_fit, /"Tailwind"/);
});

// ---------------------------------------------------------------------------
// 6. Price fields still never influence score/order
// ---------------------------------------------------------------------------

test('price fields in market_context do not change the composite score or evidence availability', () => {
  const c1 = currentContextOnlyComposite({ score: 85 });
  const c2 = currentContextOnlyComposite({ score: 85 });
  // Inject different market prices — the score must not change.
  c1.result.market_context = { yes_bid_cents: 90, yes_ask_cents: 92, volume: 5000, open_interest: 10000 };
  c2.result.market_context = { yes_bid_cents: 10, yes_ask_cents: 12, volume: 100, open_interest: 200 };
  const r1 = mentionCompositeToDecisionRow(c1);
  const r2 = mentionCompositeToDecisionRow(c2);
  assert.equal(r1.composite_score, r2.composite_score, 'score identical regardless of price');
  assert.deepEqual(r1.evidence_availability, r2.evidence_availability, 'evidence availability identical');
  assert.equal(r1.confidence_cap_reason, r2.confidence_cap_reason, 'cap reason identical');
});

test('price fields cannot change a cap decision that is driven by evidence fields', () => {
  const noHistory = currentContextOnlyComposite({ score: 85, kalshiNativeN: 1 });
  noHistory.settled_history = { match_tier: 'exact_horizon', sample_size: 1, hits: 1, misses: 0, hit_rate: 1, usable: false };
  const backed = currentContextOnlyComposite({ score: 85, kalshiNativeN: 1 });
  backed.settled_history = { match_tier: 'exact_horizon', sample_size: 2, hits: 2, misses: 0, hit_rate: 1, usable: true };
  noHistory.result.market_context = { yes_bid_cents: 90, yes_ask_cents: 92, volume: 5000, open_interest: 10000 };
  backed.result.market_context = { yes_bid_cents: 10, yes_ask_cents: 12, volume: 100, open_interest: 200 };
  const r1 = mentionCompositeToDecisionRow(noHistory);
  const r2 = mentionCompositeToDecisionRow(backed);
  assert.equal(r1.composite_score, 64, 'n=1 evidence is capped');
  assert.equal(r2.composite_score, 85, 'usable evidence is not capped');
  assert.equal(r1.evidence_availability.settled_evidence.status, 'unavailable');
  assert.equal(r2.evidence_availability.settled_evidence.status, 'present');
  const json = JSON.stringify(r1.evidence_availability);
  assert.doesNotMatch(json, /\b(price|bid|ask|volume|open_interest|implied)\b/i);
});

test('computeEvidenceAvailability does not infer scan results from a missing count', () => {
  const composite = currentContextOnlyComposite({ kalshiNativeN: null });
  const ev = computeEvidenceAvailability(composite);
  assert.equal(ev.settled_evidence.status, 'unavailable');
  assert.equal(ev.settled_evidence.n, 0);
  assert.equal(ev.transcript_evidence.status, 'missing');
});

test('computeEvidenceAvailability reports present when kalshi_native_n >= 2 even without settled_history artifact', () => {
  const composite = currentContextOnlyComposite({ score: 80, kalshiNativeN: 14 });
  composite.kalshi_native_pct = 92;
  composite.settled_history = null;
  const ev = computeEvidenceAvailability(composite);
  assert.equal(ev.settled_evidence.status, 'present', 'kalshi_native_n >= 2 alone counts as present');
  assert.equal(ev.settled_evidence.n, 14);
});

test('a verified zero scan is distinct from an unavailable scan', () => {
  // Simulate the verified Kalshi ground truth: KXEARNINGSMENTIONJPM has
  // 0 settled markets. kalshi_native_n = 0, no settled_history artifact.
  const composite = currentContextOnlyComposite({ score: 85, kalshiNativeN: 0 });
  composite.kalshi_scan_ok = true;
  composite.kalshi_events_scanned = 3;
  const ev = computeEvidenceAvailability(composite);
  assert.notEqual(ev.settled_evidence.status, 'present', 'JPM must NOT show settled evidence');
  assert.equal(ev.settled_evidence.n, 0);
  assert.equal(ev.settled_evidence.status, 'none_for_series', 'declared as real absence, not a lookup bug');
  // The row declares this honestly in the packet.
  const row = mentionCompositeToDecisionRow(composite);
  assert.ok(row.evidence_availability.settled_evidence.status !== 'present');
  assert.ok(row.composite_score < 65, 'JPM current-context-only score is capped');
});

test('settled history sample_size=1 is not present and cannot support STRONG YES', () => {
  const composite = currentContextOnlyComposite({ score: 85, kalshiNativeN: null });
  composite.settled_history = {
    match_tier: 'exact_horizon', sample_size: 1, hits: 1, misses: 0, hit_rate: 1, usable: false,
  };
  const row = mentionCompositeToDecisionRow(composite);
  assert.notEqual(row.evidence_availability.settled_evidence.status, 'present');
  assert.equal(row.composite_score, 64);
  assert.notEqual(row.composite_score >= 65, true);
});

test('failed Kalshi scan renders lookup failure, never verified absence', () => {
  const composite = currentContextOnlyComposite({ score: 85, kalshiNativeN: null });
  composite.kalshi_scan_ok = false;
  composite.kalshi_scan_error = 'HTTP 503';
  const row = mentionCompositeToDecisionRow(composite);
  const text = renderMentionPacket(buildMentionsSynthesisInput({ date: '2026-07-14', event: earningsEvent(), rows: [row] }), { generatedAtUtc: '2026-07-14T12:00:00.000Z' });
  assert.match(text, /lookup failed|could not be completed/i);
  assert.doesNotMatch(text, /no settled comparables for this series/i);
  assert.equal(row.composite_score, 64);
});

test('required_count=1 is usable settlement text, not silently omitted', () => {
  const note = buildResearchTermNote({
    phrase: 'Tailwind', reason: 'direct source', proofPct: 80, requiredCount: 1,
  });
  assert.match(note.settlement_fit, /Requires 1 qualifying mention\./);
  assert.doesNotMatch(note.settlement_fit, /not just one/i);
});

test('failed or unknown Kalshi scans are not reported as verified zero', () => {
  const failed = currentContextOnlyComposite({ score: 85, kalshiNativeN: null });
  Object.assign(failed, { kalshi_scan_ok: false, kalshi_scan_error: 'timeout' });
  assert.equal(computeEvidenceAvailability(failed).settled_evidence.status, 'error');

  const unknown = currentContextOnlyComposite({ score: 85, kalshiNativeN: undefined });
  Object.assign(unknown, { kalshi_scan_ok: undefined, kalshi_events_scanned: undefined, kalshi_scan_error: null });
  assert.equal(computeEvidenceAvailability(unknown).settled_evidence.status, 'unavailable');
  assert.notEqual(computeEvidenceAvailability(unknown).settled_evidence.status, 'none_for_series');
});

test('researchScore override requires source provenance', () => {
  const c = currentContextOnlyComposite({ score: 85 });
  c.result.composite_score = null;
  c.result._meta.layers_present = 0;
  c.blended_pct = 99;
  c.proof_pct = null;
  c.handicap_pct = null;
  c.kalshi_scan_ok = false;
  const row = mentionCompositeToDecisionRow(c);
  assert.equal(row.composite_score, null, 'unproven blended score must not become a rated row');
});

test('zero-evidence cap is symmetric and never ships STRONG NO', () => {
  const expected = new Map([[95, 64], [85, 64], [65, 64], [64, 64], [50, 50], [35, 35], [34, 35], [15, 35], [2, 35]]);
  for (const [raw, capped] of expected) {
    const row = mentionCompositeToDecisionRow(currentContextOnlyComposite({ score: raw, kalshiNativeN: null }));
    assert.equal(row.composite_score, capped, `raw ${raw}`);
    assert.notEqual(row.composite_score, null);
    assert.ok(row.composite_score >= 35 && row.composite_score < 65, `raw ${raw} must stay in safe tier range`);
  }
});
