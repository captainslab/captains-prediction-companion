# MLB Shared Price-Neutral Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one MLB analysis engine (`market-engine.analyzeGame`) the single source of posture for both the daily packets and the articles, with posture driven only by non-price evidence so the Price Isolation Invariant holds, and wire the daily packet generator onto it while preserving its existing packet format.

**Architecture:** Today there are two MLB "models": the daily packets read a market-neutral composite (`state/mlb/<date>/picks.json` from scoring-core) and the articles use `analyzeGame` (a price-structure scanner that decides CLEAR/LEAN from ask sums, ladder price deltas, and open interest — a Price Isolation violation). This plan price-neutralizes `analyzeGame` so its posture is seeded by `buildNonMarketContextBundle` (stats/weather/form/starters) and demotes all market-price structure to display-only notes. The same engine then feeds two separate renderers: `article-render.mjs` (unchanged format) and a new daily-board adapter that emits the existing sectioned decision-board format. The daily generator switches from `picks.json` to `discoverAllSeries → joinGames → enrichGamesWithContext → analyzeGame`, an input path that already exists for the article and lineup-packet generators.

**Tech Stack:** Node.js ESM (`.mjs`), `node:test` + `node:assert` (run via `node --test`), no external test framework. Pure-function modules under `scripts/mlb/lib/`. Cron via Hermes profile `captain` wrappers that `cd` into the repo and run repo `.mjs` (wrappers are unchanged by this plan).

## Global Constraints

- **Price Isolation Invariant (HARD):** Market price, odds, bid, ask, last_price, volume, open interest, and price movement must NEVER enter posture, scoring, ranking, classification, or upgrade/downgrade. Price is allowed for display, logging, and Kalshi API interaction ONLY. This is the entire point of the refactor — every engine task is judged against it.
- **No-trade policy:** No code emits trades, bankroll sizing, or entry orders. Posture vocabulary stays research-only (PICK / EVIDENCE_LEAN / CONTEXT_WATCH / WATCH / NO_CLEAR_PICK and the internal MARKET-ONLY LEAN, which is never shown to customers).
- **Telegram safety:** Do not touch send operations, bot tokens, chat IDs, or `_send-due.mjs` delivery wiring. Delivery cadence and idempotency (`delivery-summary.json`) are out of scope.
- **Cron behavior:** Do NOT edit anything under `/home/jordan/.hermes/`. The repo cron wrappers (`scripts/mlb/mlb-daily.sh`, `mlb-articles-daily.sh`) keep their current contract: `cd` into the repo, run the repo `.mjs`. No schedule, command, or flag changes.
- **No-touch zones:** `.env*`, Kalshi auth, Telegram tokens, `deploy/`, `logs/`, `node_modules/`, Hermes profile/cron/session state.
- **Delivery formats preserved:** Daily packets keep the sectioned decision-board format (TLDR + Top Edge / Watchlist / Fades / Blocked + audit inventory). Articles keep their current section structure and customer-facing label scrubbing. Do not put article prose into daily packets.
- **Test runner:** `node --test test/<file>.test.mjs`. A failing test prints `not ok`; a passing run prints `# pass N`.

---

## File Structure

**Modified:**
- `scripts/mlb/lib/market-engine.mjs` — price-neutralize posture. New `deriveNonMarketPosture()`; `analyzeGame.final` seeded from non-market evidence; per-section price structure relabeled to display-only `structure_signal` + `market_structure_notes`; `softLeanMl` OI/price posture promotion removed (kept only as a display note).
- `scripts/packets/generate-mlb-daily.mjs` — primary path switches from `loadMlbScoring`/`picks.json` to `discoverAllSeries → joinGames → enrichGamesWithContext → analyzeGame → daily-board adapter`. Preserve header neutrality note, sectioned board body, inventory artifact, exit codes.
- `test/mlb-market-engine.test.mjs` — rewrite the ~price→CLEAR/LEAN assertions to assert price is non-posture and non-market evidence drives posture.
- `test/mlb-article-render.test.mjs`, `test/mlb-article-evidence-gate.test.mjs` — update fixtures/assertions to the non-market posture semantics.
- `CLAUDE.md` — add a one-line note that `market-engine.analyzeGame` is now the single price-neutral MLB engine.

**Created:**
- `scripts/mlb/lib/daily-board-adapter.mjs` — pure adapter `analysisToDecisionRows(game, analysis)` → rows consumable by `renderSectionedPacket` from `scripts/shared/decision-packet.mjs`. Posture from `analysis.final`; price only in the display half of each row.
- `test/mlb-price-isolation-engine.test.mjs` — keystone regression: `analyzeGame` posture is invariant under price/OI mutation; non-market evidence flips posture.
- `test/mlb-daily-board-adapter.test.mjs` — adapter maps engine posture → board rows with price confined to display.

**Read-only references (do not modify):**
- `scripts/mlb/lib/series-discovery.mjs` — `discoverAllSeries(date)`, `joinGames(series)` (the input adapter analyzeGame needs).
- `scripts/mlb/publish-article-reports.mjs` — reference for `gatherGames`/`enrichGamesWithContext` usage; the article path stays working through the same engine.
- `scripts/shared/decision-packet.mjs` — `buildDecisionRow`, `renderSectionedPacket`, `buildInventoryArtifact`, `EDGE_STATUS`, `CONFIDENCE`.
- `scripts/shared/decision-process.mjs` — `evaluateDecisionProcess`, `DECISION_STATUSES`, `MARKET_TYPES`.

---

## Task 1: Keystone price-isolation regression test (red anchor)

This test encodes the invariant and MUST fail against the current engine. It is the gate for the whole refactor.

**Files:**
- Test: `test/mlb-price-isolation-engine.test.mjs` (create)
- Reference: `scripts/mlb/lib/market-engine.mjs:1083` (`analyzeGame`)

**Interfaces:**
- Consumes: `analyzeGame(game)` from `../scripts/mlb/lib/market-engine.mjs`. Returns `{ sections, final: { decision, decision_status, decision_process, reason, game_pick_decision, prop_watchlist, context_bundle, coverage, market_structure_notes }, ... }`.
- Produces: nothing consumed downstream; this is a guard test.

- [ ] **Step 1: Write the failing test**

```javascript
// test/mlb-price-isolation-engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGame } from '../scripts/mlb/lib/market-engine.mjs';

// Build a game with NO non-market evidence (no stats/weather/form/starters) and
// a strongly "arby" ML board. Under price isolation, a price-only board must
// NEVER produce a CLEAR/LEAN posture.
function priceOnlyGame(overrides = {}) {
  return {
    away: 'TB', home: 'LAD', away_full: 'Tampa Bay Rays', home_full: 'Los Angeles Dodgers',
    series: {
      ml: { markets: [
        { ticker: 'KXMLBGAME-G-TB', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.40, no_ask_dollars: 0.62, yes_bid_dollars: 0.38, open_interest_fp: 90000 },
        { ticker: 'KXMLBGAME-G-LAD', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.50, no_ask_dollars: 0.52, yes_bid_dollars: 0.48, open_interest_fp: 10000 },
      ] },
    },
    ...overrides,
  };
}

test('price-only board (no non-market evidence) yields NO CLEAR PICK posture', () => {
  const r = analyzeGame(priceOnlyGame());
  assert.equal(r.final.game_pick_decision, 'NO CLEAR PICK');
  assert.notEqual(r.final.decision_status, 'CLEAR');
});

test('posture is invariant under ask-price mutation', () => {
  const base = analyzeGame(priceOnlyGame());
  // Make the board a perfect cross-side arb (sum well under 96c) and skew OI hard.
  const mutated = analyzeGame(priceOnlyGame({
    series: { ml: { markets: [
      { ticker: 'KXMLBGAME-G-TB', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.30, no_ask_dollars: 0.71, open_interest_fp: 500000 },
      { ticker: 'KXMLBGAME-G-LAD', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.40, no_ask_dollars: 0.61, open_interest_fp: 1000 },
    ] } },
  }));
  assert.equal(mutated.final.game_pick_decision, base.final.game_pick_decision,
    'changing ask prices / OI must not change posture');
});

test('non-market evidence is what flips posture to a pick', () => {
  // Same board, now WITH strong non-market support for the home side.
  const withEvidence = analyzeGame(priceOnlyGame({
    stats_record: { away: { composite_score: 40 }, home: { composite_score: 75 } },
    starters: { away: { name: 'A' }, home: { name: 'B' } },
    recent_form: { away: {}, home: {} },
    weather_record: { temperature: 72 },
  }));
  assert.notEqual(withEvidence.final.game_pick_decision, 'NO CLEAR PICK',
    'strong non-market evidence should be able to produce a posture');
});

test('market structure is still reported for display (not posture)', () => {
  const r = analyzeGame(priceOnlyGame());
  assert.ok(Array.isArray(r.final.market_structure_notes),
    'engine must expose market structure as display-only notes');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mlb-price-isolation-engine.test.mjs`
Expected: FAIL. Current engine returns `game_pick_decision: 'CLEAR'` for the arb board and lacks `final.market_structure_notes`, so the first, second, and fourth tests fail.

- [ ] **Step 3: Commit the red anchor**

```bash
git add test/mlb-price-isolation-engine.test.mjs
git commit -m "test(mlb): add failing price-isolation guard for analyzeGame posture"
```

---

## Task 2: Non-market posture deriver

Add the pure function that computes posture from `buildNonMarketContextBundle` output only.

**Files:**
- Modify: `scripts/mlb/lib/market-engine.mjs` (add `deriveNonMarketPosture`, export it)
- Test: `test/mlb-price-isolation-engine.test.mjs` (add unit tests for the deriver)
- Reference: `scripts/mlb/lib/market-engine.mjs` `buildNonMarketContextBundle` returns `{ support_side, support_team, support_margin, overall_data_quality, support_reason, composite_score, provenance, ... }` (return at the `return {` near line 172 of that function).

**Interfaces:**
- Consumes: `contextBundle` = output of `buildNonMarketContextBundle(game)` or `null`.
- Produces: `deriveNonMarketPosture(contextBundle) → { decision: 'CLEAR'|'LEAN'|'NO CLEAR PICK', side: string|null, reason: string, margin: number|null, quality: string }`. Used by Task 3 to seed `finalDecision`. No price fields are read.

- [ ] **Step 1: Write the failing test (append to keystone file)**

```javascript
import { deriveNonMarketPosture } from '../scripts/mlb/lib/market-engine.mjs';

test('deriveNonMarketPosture: null/empty bundle → NO CLEAR PICK', () => {
  assert.equal(deriveNonMarketPosture(null).decision, 'NO CLEAR PICK');
  assert.equal(deriveNonMarketPosture({ overall_data_quality: 'missing' }).decision, 'NO CLEAR PICK');
});

test('deriveNonMarketPosture: strong margin + ok quality → LEAN/CLEAR on support side', () => {
  const r = deriveNonMarketPosture({ support_side: 'home', support_team: 'LAD', support_margin: 18, overall_data_quality: 'ok', support_reason: 'rotation+form edge' });
  assert.ok(r.decision === 'LEAN' || r.decision === 'CLEAR');
  assert.equal(r.side, 'LAD');
});

test('deriveNonMarketPosture: thin margin → NO CLEAR PICK even with ok quality', () => {
  const r = deriveNonMarketPosture({ support_side: 'home', support_team: 'LAD', support_margin: 2, overall_data_quality: 'ok' });
  assert.equal(r.decision, 'NO CLEAR PICK');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/mlb-price-isolation-engine.test.mjs`
Expected: FAIL with `deriveNonMarketPosture is not a function` (import is undefined).

- [ ] **Step 3: Implement `deriveNonMarketPosture` in market-engine.mjs**

Add near the other helpers (above `analyzeGame`). Thresholds mirror the existing `supportMatchesMarket` gate (`support_margin >= 5`, `overall_data_quality === 'ok'`); a larger margin promotes LEAN→CLEAR.

```javascript
// Posture comes ONLY from non-market evidence. Price/OI never enter here.
// margin is a market-neutral composite delta from buildNonMarketContextBundle.
const NONMARKET_LEAN_MARGIN = 5;
const NONMARKET_CLEAR_MARGIN = 15;

export function deriveNonMarketPosture(contextBundle) {
  const cb = contextBundle || null;
  const quality = cb?.overall_data_quality ?? 'missing';
  const margin = cb?.support_margin != null ? Number(cb.support_margin) : null;
  const side = cb?.support_team ?? null;
  if (!cb || quality !== 'ok' || side == null || margin == null || !Number.isFinite(margin)) {
    return { decision: 'NO CLEAR PICK', side: null, reason: cb?.support_reason || 'No qualifying non-market evidence.', margin, quality };
  }
  if (margin >= NONMARKET_CLEAR_MARGIN) {
    return { decision: 'CLEAR', side, reason: cb.support_reason || `Non-market composite favors ${side} by ${margin}.`, margin, quality };
  }
  if (margin >= NONMARKET_LEAN_MARGIN) {
    return { decision: 'LEAN', side, reason: cb.support_reason || `Non-market composite leans ${side} by ${margin}.`, margin, quality };
  }
  return { decision: 'NO CLEAR PICK', side: null, reason: cb.support_reason || `Non-market margin ${margin} below LEAN threshold.`, margin, quality };
}
```

- [ ] **Step 4: Run to verify the deriver tests pass**

Run: `node --test test/mlb-price-isolation-engine.test.mjs`
Expected: the three `deriveNonMarketPosture` tests PASS. The four `analyzeGame` guard tests still FAIL (engine not yet rewired) — that is expected until Task 3.

- [ ] **Step 5: Commit**

```bash
git add scripts/mlb/lib/market-engine.mjs test/mlb-price-isolation-engine.test.mjs
git commit -m "feat(mlb): add price-neutral deriveNonMarketPosture"
```

---

## Task 3: Reseed analyzeGame posture from non-market evidence; demote price structure to display

This is the core change. The per-section analyzers keep computing market structure, but their output becomes a display-only note. `finalDecision` is seeded from `deriveNonMarketPosture`. `softLeanMl`'s OI/price promotion is removed from posture.

**Files:**
- Modify: `scripts/mlb/lib/market-engine.mjs` (`analyzeGame` body, lines ~1083–1281; the `softLeanMl` call at ~1097–1105; the `gameClears/gameLeans/finalDecision` block at ~1118–1136; the `evaluateDecisionProcess` call ~1158–1230; the `return { final: ... }` ~1240–1278)
- Test: `test/mlb-price-isolation-engine.test.mjs` (the four `analyzeGame` guard tests from Task 1 now drive this)

**Interfaces:**
- Consumes: `deriveNonMarketPosture` (Task 2), `buildNonMarketContextBundle`, existing per-section analyzers.
- Produces: `analyzeGame` return with **unchanged keys** so renderers keep working, but new semantics:
  - `final.decision` / `final.game_pick_decision` = non-market posture (`CLEAR`/`LEAN`/`NO CLEAR PICK`).
  - `final.decision_status` = `evaluateDecisionProcess` status seeded by the non-market posture.
  - `final.reason` / `final.best_angle` / `final.best_source` = describe the non-market evidence, not the board.
  - NEW `final.market_structure_notes: Array<{ family, signal, reason }>` = display-only summary of per-section price structure (the old CLEAR/LEAN reasons, relabeled).
  - `sections.*` keep their existing fields for the article/packet "Board ___" display lines; renderers must not read `sections.*.decision` as posture (handled in later tasks where needed).

- [ ] **Step 1: Confirm the Task 1 guard tests fail (baseline red)**

Run: `node --test test/mlb-price-isolation-engine.test.mjs`
Expected: the four `analyzeGame` posture tests FAIL.

- [ ] **Step 2: Remove price/OI posture promotion (`softLeanMl`)**

Replace the soft-LEAN promotion block (currently ~lines 1097–1105):

```javascript
  // Soft-LEAN promotion: if ML is PASS, check liquidity+spread confirmation.
  if (mlAnalysis.decision === 'PASS') {
    const soft = softLeanMl(game.series.ml?.markets || [], spreadAnalysis.buckets, gameMeta);
    if (soft) {
      mlAnalysis.decision = 'LEAN';
      mlAnalysis.reason = soft.reason;
      mlAnalysis.tier = 'soft';
      mlAnalysis.side = soft.side;
      mlAnalysis.evidence = soft.evidence;
    }
  }
```

with a display-only capture (NO posture mutation):

```javascript
  // Market structure (ask sums, ladder inversions, OI) is DISPLAY-ONLY. It must
  // never promote posture. We still compute it so the packet/article can show a
  // "market structure" note alongside the non-market verdict.
  const softStructure = softLeanMl(game.series.ml?.markets || [], spreadAnalysis.buckets, gameMeta) || null;
```

- [ ] **Step 3: Replace the price-derived finalDecision block**

Replace the `gameLevelSections / gameClearLean / gameClears / gameLeans / finalDecision` block (~lines 1118–1136) with a non-market seed plus a display-only structure summary:

```javascript
  // POSTURE = non-market evidence only.
  const contextPosture = deriveNonMarketPosture(contextBundle);
  let finalDecision = contextPosture.decision;        // CLEAR | LEAN | NO CLEAR PICK
  let finalReason = contextPosture.reason;
  let bestAngle = contextPosture.side ? `${contextPosture.side}: ${contextPosture.reason}` : contextPosture.reason;
  let bestSource = contextPosture.side ? 'non_market_context' : null;

  // DISPLAY-ONLY market structure notes. These describe Kalshi board shape and
  // are NEVER posture. Each section's pre-existing decision string is reused as
  // a human-readable structure label, not as a verdict.
  const structureFamilies = [
    { family: 'ML', sec: mlAnalysis },
    { family: 'Spread', sec: spreadAnalysis },
    { family: 'Total', sec: totalAnalysis },
    { family: 'YFRI', sec: yfriAnalysis },
  ];
  const marketStructureNotes = structureFamilies
    .filter((s) => s.sec && s.sec.decision && s.sec.decision !== 'NO CLEAR PICK')
    .map((s) => ({ family: s.family, signal: s.sec.decision, reason: s.sec.reason }));
  if (softStructure) {
    marketStructureNotes.push({ family: 'ML', signal: 'LIQUIDITY/SPREAD', reason: softStructure.reason });
  }
  const marketSignalReason = marketStructureNotes.length
    ? `Market structure (display-only): ${marketStructureNotes.map((n) => `${n.family} ${n.signal}`).join(', ')}.`
    : 'No notable market structure.';
```

- [ ] **Step 4: Reseed `supportMatchesMarket` and `evaluateDecisionProcess`**

`supportMatchesMarket` becomes "does the display-only market structure agree with the non-market side" — used only for a display note, not posture. Update the variable (currently ~lines 1138–1156) and the `evaluateDecisionProcess` call's `rawDecision` and `hasMarketSignal`:

```javascript
  const supportTeam = contextPosture.side;
  const marketSideTeam = mlAnalysis.side ?? null;
  const marketStructureAgrees = Boolean(marketSideTeam && supportTeam && marketSideTeam === supportTeam);
```

In the `evaluateDecisionProcess({ ... })` call, change ONLY these fields:

```javascript
    rawDecision: finalDecision,                 // now the NON-MARKET posture
    hasMarketSignal: false,                      // market structure is display-only, not a model signal
    topEvidence: finalDecision === 'CLEAR' || finalDecision === 'LEAN' ? [finalReason] : [],
    marketSignalText: marketSignalReason,        // display-only structure summary
```

Leave the `checked` booleans (`projected_participants`, `lineup_injury_news`, `venue_context`, `recent_form_matchup`, `evidence_supported_side`) as-is, except set `evidence_supported_side: finalDecision !== 'NO CLEAR PICK'` and `market_board_context: hasMarketBoard` (board presence is a fact, not a price read).

- [ ] **Step 5: Add `market_structure_notes` to the return and keep keys stable**

In the `return { ... final: { ... } }` object (~line 1240), add one field and point `market_reason` at the structure summary:

```javascript
    final: {
      decision: finalDecision,
      decision_status: process.decisionStatus,
      decision_process: process,
      reason: finalReason,
      market_reason: marketSignalReason,
      market_structure_notes: marketStructureNotes,   // NEW: display-only
      best_angle: bestAngle,
      best_source: bestSource,
      game_pick_decision: finalDecision,
      prop_watchlist: propAlerts,
      context_bundle: contextBundle,
      coverage,
    },
```

- [ ] **Step 6: Run the keystone guard tests**

Run: `node --test test/mlb-price-isolation-engine.test.mjs`
Expected: ALL tests PASS — price-only board → `NO CLEAR PICK`; posture invariant under ask/OI mutation; non-market evidence flips posture; `market_structure_notes` is an array.

- [ ] **Step 7: Commit**

```bash
git add scripts/mlb/lib/market-engine.mjs test/mlb-price-isolation-engine.test.mjs
git commit -m "feat(mlb): seed analyzeGame posture from non-market evidence; price structure display-only"
```

---

## Task 4: Migrate existing engine tests to non-market posture semantics

`test/mlb-market-engine.test.mjs` (32 tests) currently asserts price→CLEAR/LEAN at the **section** level (e.g. `analyzeMl` cross-side arb → CLEAR). Sections still compute structure, so most section-level tests remain valid as **structure** assertions; the change is that they no longer imply a game posture. Update only the tests that assert a game-level posture or that conflate structure with verdict.

**Files:**
- Modify: `test/mlb-market-engine.test.mjs`
- Reference: `scripts/mlb/lib/market-engine.mjs`

- [ ] **Step 1: Run the suite to see what breaks**

Run: `node --test test/mlb-market-engine.test.mjs`
Expected: section-level tests (e.g. `analyzeMl` returns `decision: 'CLEAR'`) still PASS (sections unchanged). Any test asserting `analyzeGame(...).final.decision === 'CLEAR'` from a price-only board now FAILS. Record the failing test names.

- [ ] **Step 2: Rewrite each failing game-level assertion**

For every failing test that built a price-only `game` and expected a CLEAR/LEAN final posture, change the expectation to `NO CLEAR PICK` and add a structure-note assertion. Concrete transformation pattern:

```javascript
// BEFORE
test('analyzeGame: arb ML board → game CLEAR', () => {
  const r = analyzeGame(arbGameNoContext());
  assert.equal(r.final.game_pick_decision, 'CLEAR');
});
// AFTER
test('analyzeGame: arb ML board with no context → NO CLEAR PICK, structure noted', () => {
  const r = analyzeGame(arbGameNoContext());
  assert.equal(r.final.game_pick_decision, 'NO CLEAR PICK');
  assert.ok(r.final.market_structure_notes.some((n) => n.family === 'ML'));
});
```

For tests that want to assert a real posture, add non-market evidence to the fixture (mirror the `withEvidence` fixture from Task 1, Step 1) and assert posture follows the `support_team`.

- [ ] **Step 3: Run until green**

Run: `node --test test/mlb-market-engine.test.mjs`
Expected: `# pass` equals the test count, `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add test/mlb-market-engine.test.mjs
git commit -m "test(mlb): assert non-market posture, price structure display-only"
```

---

## Task 5: Daily-board adapter (engine posture → existing board rows)

A pure adapter that turns `analyzeGame` output into the decision rows the existing daily packet format renders, with price confined to the display half.

**Files:**
- Create: `scripts/mlb/lib/daily-board-adapter.mjs`
- Test: `test/mlb-daily-board-adapter.test.mjs` (create)
- Reference: `scripts/shared/decision-packet.mjs` (`buildDecisionRow`, `EDGE_STATUS`, `CONFIDENCE`); current row-building logic in `scripts/packets/generate-mlb-daily.mjs:101–169` (`mlbPickToDecisionRow`) is the format to match.

**Interfaces:**
- Consumes: `game` (joined game object) and `analysis = analyzeGame(game)`.
- Produces: `analysisToDecisionRows(game, analysis) → Array<DecisionRow>` where each row is the output of `buildDecisionRow`. Posture (`statusOverride`, `composite.posture`, `confidence`) comes from `analysis.final` (non-market). The `market: { yes_ask, yes_bid, last_price }` half is filled from the ML markets for DISPLAY ONLY; `fair.probability` and `composite.score` are NOT derived from price (use the non-market composite/margin, or `null` when unavailable). Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

```javascript
// test/mlb-daily-board-adapter.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGame } from '../scripts/mlb/lib/market-engine.mjs';
import { analysisToDecisionRows } from '../scripts/mlb/lib/daily-board-adapter.mjs';
import { EDGE_STATUS } from '../scripts/shared/decision-packet.mjs';

function gameWithEvidence() {
  return {
    away: 'TB', home: 'LAD', away_full: 'Tampa Bay Rays', home_full: 'Los Angeles Dodgers',
    stats_record: { away: { composite_score: 40 }, home: { composite_score: 78 } },
    starters: { away: { name: 'A' }, home: { name: 'B' } },
    recent_form: { away: {}, home: {} }, weather_record: { temperature: 72 },
    series: { ml: { markets: [
      { ticker: 'KXMLBGAME-G-TB', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.41, yes_bid_dollars: 0.39 },
      { ticker: 'KXMLBGAME-G-LAD', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.60, yes_bid_dollars: 0.58 },
    ] } },
  };
}

test('adapter produces at least one row carrying engine posture', () => {
  const game = gameWithEvidence();
  const rows = analysisToDecisionRows(game, analyzeGame(game));
  assert.ok(rows.length >= 1);
  assert.ok(Object.values(EDGE_STATUS).includes(rows[0].edge_status));
});

test('adapter never derives composite score or fair probability from price', () => {
  const game = gameWithEvidence();
  const baseRows = analysisToDecisionRows(game, analyzeGame(game));
  // Mutate only ask/bid prices; posture-bearing row fields must be unchanged.
  const skewed = { ...game, series: { ml: { markets: [
    { ticker: 'KXMLBGAME-G-TB', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.05, yes_bid_dollars: 0.03 },
    { ticker: 'KXMLBGAME-G-LAD', event_ticker: 'KXMLBGAME-G', yes_ask_dollars: 0.95, yes_bid_dollars: 0.93 },
  ] } } };
  const skewedRows = analysisToDecisionRows(skewed, analyzeGame(skewed));
  assert.equal(skewedRows[0].edge_status, baseRows[0].edge_status);
  assert.equal(skewedRows[0].composite_score, baseRows[0].composite_score);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/mlb-daily-board-adapter.test.mjs`
Expected: FAIL — `analysisToDecisionRows` is not defined.

- [ ] **Step 3: Implement the adapter**

```javascript
// scripts/mlb/lib/daily-board-adapter.mjs
// Pure adapter: analyzeGame() output -> shared decision rows for the daily
// packet board. Posture comes from the non-market engine verdict. Price is
// copied into the DISPLAY half of the row only and never into score/posture.
import { buildDecisionRow, EDGE_STATUS, CONFIDENCE } from '../../shared/decision-packet.mjs';

const POSTURE_TO_STATUS = Object.freeze({
  CLEAR: EDGE_STATUS.PICK,
  LEAN: EDGE_STATUS.LEAN,
  'MARKET-ONLY LEAN': EDGE_STATUS.WATCH,
  'NO CLEAR PICK': EDGE_STATUS.WATCH,
});

const POSTURE_LABEL = Object.freeze({
  CLEAR: 'PICK',
  LEAN: 'EVIDENCE_LEAN',
  'MARKET-ONLY LEAN': 'CONTEXT_WATCH',
  'NO CLEAR PICK': 'NO_CLEAR_PICK',
});

function mlDisplayMarket(game) {
  const ml = game?.series?.ml?.markets || [];
  const pick = ml[0] || {};
  return { yes_ask: pick.yes_ask_dollars ?? null, yes_bid: pick.yes_bid_dollars ?? null, last_price: pick.last_price_dollars ?? null };
}

export function analysisToDecisionRows(game, analysis) {
  const final = analysis?.final ?? {};
  const decision = final.game_pick_decision ?? 'NO CLEAR PICK';
  const status = POSTURE_TO_STATUS[decision] ?? EDGE_STATUS.WATCH;
  const posture = POSTURE_LABEL[decision] ?? 'NO_CLEAR_PICK';
  const cb = final.context_bundle ?? null;
  const quality = cb?.overall_data_quality ?? 'missing';
  const confidence = decision === 'CLEAR' ? CONFIDENCE.HIGH : decision === 'LEAN' ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW;

  const matchup = `${game.away ?? '?'} at ${game.home ?? '?'}`;
  const sideTarget = final.best_angle || matchup;
  const structureNote = final.market_reason || 'No notable market structure.';
  const analysisText = [final.reason, `[${structureNote}]`].filter(Boolean).join(' ');

  const row = buildDecisionRow({
    marketTicker: game?.series?.ml?.markets?.[0]?.event_ticker ?? `MLB-${game.away}-${game.home}`,
    sideTarget,
    marketType: 'mlb',
    settlementSummary: `${matchup} — MLB game settlement per Kalshi listing`,
    composite: {
      score: null,                              // non-market composite carries no 0-100 score here
      posture,
      layersPresent: quality === 'ok' ? 4 : 0,
      layersTotal: 6,
      topEvidenceLayers: cb?.support_reason ? ['non_market_context'] : [],
      missingLayers: quality === 'ok' ? [] : ['non_market_context'],
      modelProbability: null,                   // never price-derived
    },
    market: mlDisplayMarket(game),              // DISPLAY ONLY
    fair: { probability: null },                // posture is categorical, not a price-derived prob
    confidence,
    analysis: analysisText,
    trigger: { price: null, event: decision === 'NO CLEAR PICK' ? 'non-market evidence emerges' : 'lineup confirmation' },
    statusOverride: status,
  });
  return [row];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/mlb-daily-board-adapter.test.mjs`
Expected: PASS — rows carry engine posture; `edge_status` and `composite_score` are invariant under price mutation.

- [ ] **Step 5: Commit**

```bash
git add scripts/mlb/lib/daily-board-adapter.mjs test/mlb-daily-board-adapter.test.mjs
git commit -m "feat(mlb): daily-board adapter maps engine posture to board rows, price display-only"
```

---

## Task 6: Wire generate-mlb-daily.mjs onto the shared engine

Switch the daily generator's primary path from `picks.json` to `discoverAllSeries → joinGames → enrichGamesWithContext → analyzeGame → analysisToDecisionRows`, while preserving the packet format (header neutrality note, sectioned board body via `renderSectionedPacket`, inventory artifact, exit codes).

**Files:**
- Modify: `scripts/packets/generate-mlb-daily.mjs` (imports; `buildMlbSlatePacket` ~178–225; `main` ~470–589)
- Reference: `scripts/mlb/lib/series-discovery.mjs` (`discoverAllSeries`, `joinGames`); `scripts/mlb/publish-article-reports.mjs:208–272` (`enrichGamesWithContext` pattern); `scripts/mlb/lib/daily-board-adapter.mjs` (Task 5)
- Test: extend `test/mlb-daily-board-adapter.test.mjs` or add a small generator-level smoke test if a fixture harness exists; otherwise verification is the dry-run in Task 8.

**Interfaces:**
- Consumes: `analyzeGame`, `analysisToDecisionRows`, `discoverAllSeries`, `joinGames`, the existing `enrichGamesWithContext` (import it; if it is not exported from `publish-article-reports.mjs`, lift the read-only enrichment into `series-discovery.mjs` as `enrichGamesWithContext(games, stateRoot, date)` and import from there — do NOT duplicate logic).
- Produces: same packet artifacts as today: `<date>-mlb-daily-board.txt` (sectioned board) + `<date>-mlb-daily.inventory.txt`, with identical header/footer and the neutrality note (now literally true).

- [ ] **Step 1: Add the engine path to `buildMlbSlatePacket`**

Replace the `scoring.picks.map(mlbPickToDecisionRow)` source with engine rows. Keep `renderSectionedPacket`, the header, the neutrality note, and the inventory artifact exactly as they are. New signature accepts joined games + analyses instead of `scoring`:

```javascript
export function buildMlbSlatePacketFromEngine({ date, games, analyses, artifacts = [], inventoryPath = null }) {
  if (!Array.isArray(games) || !games.length) return null;
  const allRows = games.flatMap((g, i) => analysisToDecisionRows(g, analyses[i]));
  const boardRows = allRows; // adapter already excludes prop-only rows
  const tldrNote = 'Posture is non-market: market price/structure is display-only and never scored.';
  const body = renderSectionedPacket(boardRows, {
    tldrNote,
    auditArtifacts: [inventoryPath].filter(Boolean),
    perSectionLimit: 14,
  });
  const header = packetHeader({
    packetType: PACKET_TYPE, date,
    title: 'Captain MLB — CPC Packet: Daily Slate Board',
    sources: [KALSHI_SOURCES.mlb?.page_url ?? KALSHI_SOURCES.mlb?.label].filter(Boolean),
  });
  const neutralityNote = 'Posture is market-neutral: model never reads market price/odds/OI. Price shown for display only.';
  const text = [header, neutralityNote, body, packetFooter()].filter(Boolean).join('\n\n');
  const inventoryLines = allRows.map((r, i) =>
    `#${i + 1} [${r.edge_status}] ${r.market_ticker} :: ${r.side_target} | score=${r.composite_score} ask=${r.market_yes_ask} conf=${r.confidence}`);
  const inventoryText = buildInventoryArtifact({
    marketType: 'mlb', date, eventTicker: `MLB-SLATE-${date}`, inventoryLines,
    meta: { board_rows: boardRows.length, total_rows: allRows.length },
  });
  return { text, rows: boardRows, inventoryText, counts: { total: allRows.length, board: boardRows.length, lineupPending: 0 } };
}
```

- [ ] **Step 2: Rewire `main` to build games via the shared engine**

In `main`, replace the `loadMlbScoring` primary block (~507–534) with:

```javascript
  const seriesResults = await discoverAllSeries(opts.date);
  let games = joinGames(seriesResults);
  games = enrichGamesWithContext(games, opts.stateRoot, opts.date); // read-only stats/weather/context
  const analyses = games.map((g) => analyzeGame(g));

  if (games.length) {
    const inventoryName = `${opts.date}-mlb-daily.inventory`;
    const slate = buildMlbSlatePacketFromEngine({
      date: opts.date, games, analyses, artifacts,
      inventoryPath: join(dir, `${inventoryName}.txt`),
    });
    if (slate) {
      const invW = writeAudit(dir, inventoryName, slate.inventoryText, { kind: 'raw_inventory_audit', total_rows: slate.counts.total, board_rows: slate.counts.board });
      items.push({ name: 'mlb-daily.inventory', ...invW });
      const w = writeAudit(dir, `${opts.date}-mlb-daily-board`, slate.text, { kind: 'decision_board', board_rows: slate.counts.board, total_rows: slate.counts.total, research_prime: primeMeta });
      items.push({ name: 'mlb-daily-board', ...w });
    }
  }
```

Keep the existing per-event Kalshi packet loop (`buildKalshiGamePacket`) for the per-game inventory artifacts, but have it read posture from the matching `analyses[i].final` instead of `gamePicks`/`picks.json`. The empty-slate and MISSING paths are unchanged.

- [ ] **Step 3: Update imports**

Add at the top of `generate-mlb-daily.mjs`:

```javascript
import { discoverAllSeries, joinGames, enrichGamesWithContext } from '../mlb/lib/series-discovery.mjs';
import { analyzeGame } from '../mlb/lib/market-engine.mjs';
import { analysisToDecisionRows } from '../mlb/lib/daily-board-adapter.mjs';
```

Remove the now-unused `loadMlbScoring`/`mlbPickToDecisionRow` from the primary path. Keep them exported only if other modules import them (grep first: `grep -rn "loadMlbScoring\|mlbPickToDecisionRow" scripts test`). If nothing else imports them, delete them.

- [ ] **Step 4: Run the existing generator unit tests (if any) + adapter tests**

Run: `node --test test/mlb-daily-board-adapter.test.mjs`
Expected: PASS. (Generator end-to-end is verified in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add scripts/packets/generate-mlb-daily.mjs
git commit -m "feat(mlb): daily packets driven by shared price-neutral engine, format preserved"
```

---

## Task 7: Update article + evidence-gate tests for non-market posture

`test/mlb-article-render.test.mjs` (27) and `test/mlb-article-evidence-gate.test.mjs` (21) build price-only boards and expect CLEAR/LEAN-derived article output. Update fixtures to include non-market evidence where they intend a real posture, and assert that price-only fixtures render as `NO_CLEAR_PICK` / `CONTEXT_WATCH`.

**Files:**
- Modify: `test/mlb-article-render.test.mjs`, `test/mlb-article-evidence-gate.test.mjs`
- Reference: `scripts/mlb/lib/article-render.mjs:584` (status read), `:655,:710` (`analysis.final.decision`), `DECISION_STATUSES.MARKET_ONLY_LEAN`

- [ ] **Step 1: Run both suites; record failures**

Run: `node --test test/mlb-article-render.test.mjs test/mlb-article-evidence-gate.test.mjs`
Expected: tests asserting a pick from a price-only board FAIL.

- [ ] **Step 2: Add non-market evidence to "expects a pick" fixtures**

For each test that wants a posture, extend its game fixture with the `stats_record/starters/recent_form/weather_record` block (same shape as Task 1's `withEvidence`) and keep the existing market block for display. For tests that intend "no evidence", assert `NO_CLEAR_PICK`/`CONTEXT_WATCH` and that `market_structure_notes` carries the old signal.

```javascript
// price-only board now renders as context-watch, structure shown but not scored
const out = buildGameArticle(priceOnlyGame(), analyzeGame(priceOnlyGame()));
assert.match(out.text, /NO CLEAR PICK|Context watch/i);
```

- [ ] **Step 3: Run until green**

Run: `node --test test/mlb-article-render.test.mjs test/mlb-article-evidence-gate.test.mjs`
Expected: `# fail 0` for both.

- [ ] **Step 4: Commit**

```bash
git add test/mlb-article-render.test.mjs test/mlb-article-evidence-gate.test.mjs
git commit -m "test(mlb): article + evidence-gate assert non-market posture"
```

---

## Task 8: Full regression, dry-run, and isolation re-audit

**Files:**
- Reference: all of the above; `scripts/mlb/mlb-daily.sh` (repo wrapper, read-only)

- [ ] **Step 1: Run the full MLB test surface**

Run: `node --test test/mlb-*.test.mjs`
Expected: `# fail 0` across `mlb-price-isolation-engine`, `mlb-market-engine`, `mlb-article-render`, `mlb-article-evidence-gate`, `mlb-daily-board-adapter`, and any existing `mlb-*` tests.

- [ ] **Step 2: Dry-run the daily generator against a real date and inspect format**

Run: `node scripts/packets/generate-mlb-daily.mjs --date 2026-06-17 --dry-run`
Expected: prints `[mlb-daily] summary event_count=... packets_written=...` and writes `state/packets/2026-06-17/mlb-daily/2026-06-17-mlb-daily-board.txt`. Open it and confirm: header present, neutrality note present, sectioned board structure (TLDR / Top Edge / Watchlist / Fades / Blocked) matches the pre-refactor layout, no trade/bankroll language.

- [ ] **Step 3: Confirm price isolation independently**

Re-run the price-isolation auditor agent against `scripts/mlb/lib/market-engine.mjs`, `scripts/mlb/lib/daily-board-adapter.mjs`, and `scripts/packets/generate-mlb-daily.mjs`. Expected verdict: CLEAN — price appears only in display/inventory fields, never in posture/score/ranking.

- [ ] **Step 4: Confirm cron wrappers are untouched and still run repo code**

Run: `git diff --name-only` and confirm no files under `scripts/mlb/*.sh` changed. Confirm `scripts/mlb/mlb-daily.sh` still `cd`s into the repo and runs `node scripts/packets/generate-mlb-daily.mjs`.

- [ ] **Step 5: Update CLAUDE.md note + commit**

Add one line under the Price Isolation Invariant section: "`scripts/mlb/lib/market-engine.mjs` (`analyzeGame`) is the single MLB analysis engine; its posture is non-market and market price/odds/OI are display-only." Then:

```bash
git add CLAUDE.md
git commit -m "docs(mlb): record single price-neutral analyzeGame engine"
```

- [ ] **Step 6: Verify the original symptom is resolved**

Confirm that a change to `market-engine.mjs` non-market logic now visibly changes the daily packet board (edit a threshold in a scratch branch, dry-run, observe the board change, revert). This proves the daily packets and articles share one engine.

---

## Risks & Assumptions

- **ASSUMPTION (confirmed by inspection):** `discoverAllSeries` + `joinGames` produce the `game.series.{ml,spread,total,hr,ks,rfi}.markets` shape `analyzeGame` needs; `enrichGamesWithContext` supplies the non-market fields `buildNonMarketContextBundle` reads. Both already power the article/lineup generators.
- **RISK (expected, correct behavior):** Until the stats/weather/context adapters are populated for a date, `buildNonMarketContextBundle` yields no qualifying evidence, so daily packets will show mostly `NO_CLEAR_PICK`. This is the honest, invariant-compliant result — a pick requires real non-market evidence, not board shape. If the slate looks empty, the fix is upstream context population, not re-introducing price into posture.
- **RISK:** This retires `picks.json`/scoring-core as the daily packets' source. The scoring-core composite is itself market-neutral and could later be folded into `buildNonMarketContextBundle` as an additional evidence layer (follow-up, out of scope). Flag to the user before deleting any scoring-core code; this plan only stops *reading* `picks.json` in the daily packet path, it does not delete the composite pipeline.
- **RISK:** `enrichGamesWithContext` may currently live inside `publish-article-reports.mjs` un-exported. If so, Task 6 lifts it (read-only) into `series-discovery.mjs` and both callers import it — no logic duplication.

---

## Self-Review

- **Spec coverage:** one shared engine (Tasks 2–3), separate renderers — article unchanged (Task 7 verifies), new daily renderer/adapter (Task 5) wired into the daily generator preserving format (Task 6); price isolation preserved and proven (Tasks 1, 8.3); no-trade/Telegram/cron/format constraints in Global Constraints and verified in Task 8. Covered.
- **Placeholder scan:** all code steps carry concrete code; test steps carry real assertions; commands have expected output. No TBDs.
- **Type consistency:** `deriveNonMarketPosture` (Task 2) is consumed in Task 3; `analyzeGame.final.market_structure_notes` (Task 3) is read in Task 5 (`final.market_reason`) and Task 7; `analysisToDecisionRows` (Task 5) is consumed in Task 6 (`buildMlbSlatePacketFromEngine`). Names consistent.
