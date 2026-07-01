# World Cup Advances Calibration Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calibrate the real Elo→Poisson advances model against historical international match outcomes (eloratings.net), tune its constants out-of-sample, and report whether the mapping is calibrated.

**Architecture:** Pure parsing/metrics libs + thin fetch/build scripts + one orchestrator that calls the *real* `eloToLambdas`/`computeAdvance` (parameterized by an optional config) over a historical dataset. Regulation W/D/L is calibrated on every international match; the penalty prior is tested on shootout history; the composite `p_advance` is spot-checked on identifiable knockouts.

**Tech Stack:** Node.js ESM (`.mjs`), built-in `node --test`, global `fetch`. No new dependencies.

## Global Constraints

- ES modules (`.mjs`), Node built-in test runner (`node --test`). One line per constraint below applies to every task.
- **Price isolation:** no price/odds/implied-probability/volume/market data anywhere in this harness — outcomes + Elo only.
- **No logic fork:** the backtest calls the real `eloToLambdas`/`computeAdvance`; constants are passed as an optional config. Default output (no config) must be byte-identical to today — existing WC tests must stay green.
- **Determinism:** no `Math.random`, no argless `new Date()` inside library logic; train/test split is a fixed hash of `date+homeCode+awayCode`.
- **Commits:** one commit per task; stage only the task's files (never `git add -A`). End commit messages with the Co-Authored-By trailer.
- eloratings results columns (0-indexed, tab): `0 year,1 month,2 day,3 homeCode,4 awayCode,5 homeGoals,6 awayGoals,7 typeCode (competition not round),8 venueCode,9 eloChange,10 homeEloPost,11 awayEloPost`. **Cols 10/11 are POST-match**; the prediction basis is PRE-match: `homeElo = col10 − col9`, `awayElo = col11 + col9`. Never feed post-match Elo to the model (look-ahead leakage).
- All new code lives under `scripts/worldcup/backtest/`; tests under `test/worldcup/backtest/`.

---

### Task 1: results-tsv parser

**Files:**
- Create: `scripts/worldcup/backtest/lib/results-tsv.mjs`
- Test: `test/worldcup/backtest/results-tsv.test.mjs`

**Interfaces:**
- Produces: `parseResultsRow(line: string): MatchRow | null` and `parseResultsTsv(text: string): MatchRow[]`, where `MatchRow = {date, homeCode, awayCode, homeGoals, awayGoals, typeCode, venueCode, eloChange, homeEloPost, awayEloPost, homeElo, awayElo}` (date = `YYYY-MM-DD`; numbers are numbers). **`homeElo`/`awayElo` are PRE-match ratings** derived from the post-match columns (eloratings cols 10/11 are post-match; using them directly to predict the match is look-ahead leakage). `homeElo = col10 − eloChange`, `awayElo = col11 + eloChange`; `eloChange = col9` (home team's signed change; Elo is zero-sum per match). `homeEloPost`/`awayEloPost` keep the raw post values for traceability.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResultsRow, parseResultsTsv } from '../../../scripts/worldcup/backtest/lib/results-tsv.mjs';

test('parseResultsRow parses a row and derives PRE-match Elo', () => {
  // Raw cols 10/11 (2144/2081) are POST-match; pre-match = post -/+ eloChange(-6).
  const row = '2022\t12\t18\tAR\tFR\t3\t3\tWC\tQA\t-6\t2144\t2081\t0\t0\t1\t3';
  assert.deepEqual(parseResultsRow(row), {
    date: '2022-12-18', homeCode: 'AR', awayCode: 'FR',
    homeGoals: 3, awayGoals: 3, typeCode: 'WC', venueCode: 'QA',
    eloChange: -6, homeEloPost: 2144, awayEloPost: 2081,
    homeElo: 2150, awayElo: 2075,
  });
});

test('parseResultsRow returns null on malformed/short rows', () => {
  assert.equal(parseResultsRow(''), null);
  assert.equal(parseResultsRow('2022\t12'), null);
});

test('parseResultsTsv skips blank lines and bad rows', () => {
  const text = '2022\t12\t18\tAR\tFR\t3\t3\tWC\tQA\t-6\t2144\t2081\n\nbad\n';
  assert.equal(parseResultsTsv(text).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/results-tsv.test.mjs`
Expected: FAIL — cannot find module `results-tsv.mjs`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// Pure parser for eloratings.net <year>_results.tsv rows. No network.
function pad2(n) { return String(n).padStart(2, '0'); }

export function parseResultsRow(line) {
  if (!line || !line.trim()) return null;
  const f = line.split('\t');
  if (f.length < 12) return null;
  const year = Number(f[0]); const month = Number(f[1]); const day = Number(f[2]);
  const homeGoals = Number(f[5]); const awayGoals = Number(f[6]);
  const eloChange = Number(f[9]);
  const homeEloPost = Number(f[10]); const awayEloPost = Number(f[11]);
  if (![year, month, day, homeGoals, awayGoals, eloChange, homeEloPost, awayEloPost].every(Number.isFinite)) return null;
  if (!f[3] || !f[4]) return null;
  return {
    date: `${year}-${pad2(month)}-${pad2(day)}`,
    homeCode: f[3], awayCode: f[4],
    homeGoals, awayGoals,
    typeCode: f[7] || null, venueCode: f[8] || null,
    eloChange, homeEloPost, awayEloPost,
    // PRE-match ratings (post -/+ change): the prediction basis, no look-ahead.
    homeElo: homeEloPost - eloChange,
    awayElo: awayEloPost + eloChange,
  };
}

export function parseResultsTsv(text) {
  return String(text).split('\n').map(parseResultsRow).filter(Boolean);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/results-tsv.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/results-tsv.mjs test/worldcup/backtest/results-tsv.test.mjs
git commit -m "feat(wc-backtest): eloratings results.tsv parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: neutral-venue derivation

**Files:**
- Create: `scripts/worldcup/backtest/lib/neutral.mjs`
- Test: `test/worldcup/backtest/neutral.test.mjs`

**Interfaces:**
- Consumes: `MatchRow` from Task 1.
- Produces: `isNeutral(row: MatchRow): boolean` — true when `venueCode` matches neither `homeCode` nor `awayCode` (a match played in a third country). When `venueCode` is null, default to `false` (treat as home).

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNeutral } from '../../../scripts/worldcup/backtest/lib/neutral.mjs';

test('home venue is not neutral', () => {
  assert.equal(isNeutral({ homeCode: 'FR', awayCode: 'SE', venueCode: 'FR' }), false);
});
test('third-country venue is neutral', () => {
  assert.equal(isNeutral({ homeCode: 'AR', awayCode: 'FR', venueCode: 'QA' }), true);
});
test('null venue defaults to not neutral', () => {
  assert.equal(isNeutral({ homeCode: 'AR', awayCode: 'FR', venueCode: null }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/neutral.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// Derive whether a historical match was played at a neutral site.
export function isNeutral(row) {
  const v = row?.venueCode;
  if (!v) return false;
  return v !== row.homeCode && v !== row.awayCode;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/neutral.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/neutral.mjs test/worldcup/backtest/neutral.test.mjs
git commit -m "feat(wc-backtest): neutral-venue derivation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: calibration metrics

**Files:**
- Create: `scripts/worldcup/backtest/lib/calibration-metrics.mjs`
- Test: `test/worldcup/backtest/calibration-metrics.test.mjs`

**Interfaces:**
- Produces:
  - `brierMulticlass(probs: {pHome,pDraw,pAway}, outcome: 'home'|'draw'|'away'): number` — sum of squared error over the 3 classes.
  - `logLoss(probs, outcome): number` — `-ln(p_assigned_to_actual)`, clamped to avoid `-Infinity`.
  - `reliabilityBins(points: {p:number, hit:0|1}[], bins=10): {bin, predicted, observed, n}[]`.
  - `eloGapBucket(gap: number): string` — signed buckets like `'0-50'`, `'50-100'`, …, `'400+'`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brierMulticlass, logLoss, reliabilityBins, eloGapBucket } from '../../../scripts/worldcup/backtest/lib/calibration-metrics.mjs';

test('brierMulticlass: perfect prediction is 0', () => {
  assert.equal(brierMulticlass({ pHome: 1, pDraw: 0, pAway: 0 }, 'home'), 0);
});
test('brierMulticlass: even split vs home', () => {
  const b = brierMulticlass({ pHome: 1/3, pDraw: 1/3, pAway: 1/3 }, 'home');
  assert.ok(Math.abs(b - ((1/3-1)**2 + (1/3)**2 + (1/3)**2)) < 1e-9);
});
test('logLoss clamps and rewards confidence', () => {
  assert.ok(logLoss({ pHome: 0.9, pDraw: 0.05, pAway: 0.05 }, 'home') < logLoss({ pHome: 0.4, pDraw: 0.3, pAway: 0.3 }, 'home'));
  assert.ok(Number.isFinite(logLoss({ pHome: 0, pDraw: 0, pAway: 1 }, 'home')));
});
test('reliabilityBins groups by predicted probability', () => {
  const pts = [{ p: 0.05, hit: 0 }, { p: 0.95, hit: 1 }];
  const bins = reliabilityBins(pts, 10);
  assert.equal(bins.find(b => b.bin === 0).observed, 0);
  assert.equal(bins.find(b => b.bin === 9).observed, 1);
});
test('eloGapBucket buckets magnitude', () => {
  assert.equal(eloGapBucket(30), '0-50');
  assert.equal(eloGapBucket(420), '400+');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/calibration-metrics.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
// Pure calibration metrics. No I/O.
const EPS = 1e-12;

export function brierMulticlass(probs, outcome) {
  const y = { pHome: outcome === 'home' ? 1 : 0, pDraw: outcome === 'draw' ? 1 : 0, pAway: outcome === 'away' ? 1 : 0 };
  return (probs.pHome - y.pHome) ** 2 + (probs.pDraw - y.pDraw) ** 2 + (probs.pAway - y.pAway) ** 2;
}

export function logLoss(probs, outcome) {
  const p = outcome === 'home' ? probs.pHome : outcome === 'draw' ? probs.pDraw : probs.pAway;
  return -Math.log(Math.min(1 - EPS, Math.max(EPS, p)));
}

export function reliabilityBins(points, bins = 10) {
  const acc = Array.from({ length: bins }, (_, i) => ({ bin: i, sumP: 0, sumHit: 0, n: 0 }));
  for (const { p, hit } of points) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    acc[idx].sumP += p; acc[idx].sumHit += hit; acc[idx].n += 1;
  }
  return acc.map((b) => ({ bin: b.bin, predicted: b.n ? b.sumP / b.n : null, observed: b.n ? b.sumHit / b.n : null, n: b.n }));
}

export function eloGapBucket(gap) {
  const g = Math.abs(gap);
  if (g >= 400) return '400+';
  const lo = Math.floor(g / 50) * 50;
  return `${lo}-${lo + 50}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/calibration-metrics.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/calibration-metrics.mjs test/worldcup/backtest/calibration-metrics.test.mjs
git commit -m "feat(wc-backtest): calibration metrics (Brier, log-loss, reliability, buckets)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: parameterize eloToLambdas/computeAdvance with a config

**Files:**
- Modify: `scripts/worldcup/lib/advances-model.mjs`
- Test: `test/worldcup/backtest/advances-model-config.test.mjs`

**Interfaces:**
- Produces: `eloToLambdas(eloTeam, eloOpp, opts)` and `computeAdvance(input)` accept an optional `config` (`opts.config` / `input.config`) `{ eloGoalSupremacyDivisor=600, baselineTotalGoals=2.4, homeAdvantageElo=0, penaltyPrior=0.5 }`. When omitted, behavior is unchanged. Also export `DEFAULT_ADVANCES_CONFIG`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eloToLambdas, DEFAULT_ADVANCES_CONFIG } from '../../../scripts/worldcup/lib/advances-model.mjs';

test('default config is exported with the current constants', () => {
  assert.equal(DEFAULT_ADVANCES_CONFIG.eloGoalSupremacyDivisor, 600);
  assert.equal(DEFAULT_ADVANCES_CONFIG.baselineTotalGoals, 2.4);
});

test('omitting config reproduces the legacy lambdas exactly', () => {
  const legacy = eloToLambdas(1900, 1700);
  const explicit = eloToLambdas(1900, 1700, { config: DEFAULT_ADVANCES_CONFIG });
  assert.deepEqual(explicit, legacy);
});

test('a smaller divisor widens the favourite lambda', () => {
  const wide = eloToLambdas(1900, 1700, { config: { ...DEFAULT_ADVANCES_CONFIG, eloGoalSupremacyDivisor: 300 } });
  const base = eloToLambdas(1900, 1700);
  assert.ok(wide.lambdaTeam > base.lambdaTeam);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/advances-model-config.test.mjs`
Expected: FAIL — `DEFAULT_ADVANCES_CONFIG` not exported / config ignored.

- [ ] **Step 3: Write minimal implementation**

In `scripts/worldcup/lib/advances-model.mjs`: add near the existing constants —

```javascript
export const DEFAULT_ADVANCES_CONFIG = {
  eloGoalSupremacyDivisor: ELO_GOAL_SUPREMACY_DIVISOR,
  baselineTotalGoals: ADVANCES_BASELINE_TOTAL_GOALS,
  homeAdvantageElo: 0,
  penaltyPrior: 0.5,
};
```

Then in `eloToLambdas(eloTeam, eloOpp, opts = {})`, replace the hardcoded constant reads with config-aware reads at the top of the function body:

```javascript
  const cfg = { ...DEFAULT_ADVANCES_CONFIG, ...(opts.config || {}) };
  // use cfg.eloGoalSupremacyDivisor, cfg.baselineTotalGoals, cfg.homeAdvantageElo
  // wherever ELO_GOAL_SUPREMACY_DIVISOR / ADVANCES_BASELINE_TOTAL_GOALS were used,
  // and add cfg.homeAdvantageElo to (eloTeam - eloOpp) before dividing.
```

Thread `opts.config` through `computeAdvance` to `eloToLambdas`, and read `penaltyPrior` from the config in the penalty step (defaulting to existing 0.5). Do not change any default numeric result.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/advances-model-config.test.mjs` then `node --test test/worldcup-advances-model.test.mjs`
Expected: BOTH PASS (config test + unchanged existing advances tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/lib/advances-model.mjs test/worldcup/backtest/advances-model-config.test.mjs
git commit -m "feat(wc-backtest): parameterize advances model constants via optional config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: regulation prediction adapter

**Files:**
- Create: `scripts/worldcup/backtest/lib/regulation-predict.mjs`
- Test: `test/worldcup/backtest/regulation-predict.test.mjs`

**Interfaces:**
- Consumes: `eloToLambdas` + the Poisson grid from `advances-model.mjs` (reuse its exported helpers; if `poissonMatrix`/`regulationWDL` are not yet exported, export them in this task).
- Produces: `predictRegulation({homeElo, awayElo, neutral, config}): {pHome, pDraw, pAway}` summing to ~1, computed from the real model (home gets `+config.homeAdvantageElo` unless `neutral`).

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictRegulation } from '../../../scripts/worldcup/backtest/lib/regulation-predict.mjs';

test('probabilities sum to ~1', () => {
  const p = predictRegulation({ homeElo: 1900, awayElo: 1700, neutral: false });
  assert.ok(Math.abs(p.pHome + p.pDraw + p.pAway - 1) < 1e-6);
});
test('stronger team is favoured', () => {
  const p = predictRegulation({ homeElo: 2100, awayElo: 1600, neutral: true });
  assert.ok(p.pHome > p.pAway);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/regulation-predict.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
import { eloToLambdas, poissonMatrix, regulationWDL, DEFAULT_ADVANCES_CONFIG } from '../../lib/advances-model.mjs';

export function predictRegulation({ homeElo, awayElo, neutral = false, config = DEFAULT_ADVANCES_CONFIG }) {
  const homeEloAdj = neutral ? homeElo : homeElo; // homeAdvantageElo is applied inside eloToLambdas via config
  const lam = eloToLambdas(homeEloAdj, awayElo, { config: neutral ? { ...config, homeAdvantageElo: 0 } : config });
  const matrix = poissonMatrix(lam.lambdaTeam, lam.lambdaOpp);
  const wdl = regulationWDL(matrix, true);
  return { pHome: wdl.pWin, pDraw: wdl.pDraw, pAway: wdl.pLoss };
}
```

(If `poissonMatrix`/`regulationWDL` are not exported from `advances-model.mjs`, add `export` to them in that file as part of this task and re-run Task 4's tests to confirm no regression.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/regulation-predict.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/regulation-predict.mjs test/worldcup/backtest/regulation-predict.test.mjs scripts/worldcup/lib/advances-model.mjs
git commit -m "feat(wc-backtest): regulation W/D/L prediction adapter over the real model

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: fetch + build the regulation dataset

**Files:**
- Create: `scripts/worldcup/backtest/fetch-results.mjs`
- Create: `scripts/worldcup/backtest/build-regulation-dataset.mjs`
- Create (fixture): `test/worldcup/backtest/fixtures/results-sample.tsv`
- Test: `test/worldcup/backtest/build-regulation-dataset.test.mjs`

**Interfaces:**
- Produces:
  - `fetchResultsYear(year, {fetchImpl=fetch}): Promise<string>` — returns TSV text from `https://www.eloratings.net/<year>_results.tsv`.
  - `buildRegulationDataset(tsvTexts: string[]): {records: {date,homeElo,awayElo,neutral,outcome}[]}` where `outcome ∈ 'home'|'draw'|'away'`.

- [ ] **Step 1: Write the failing test** (uses a committed fixture, no network)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRegulationDataset } from '../../../scripts/worldcup/backtest/build-regulation-dataset.mjs';

test('builds records with W/D/L outcome from a sample TSV', () => {
  const tsv = readFileSync(new URL('./fixtures/results-sample.tsv', import.meta.url), 'utf8');
  const ds = buildRegulationDataset([tsv]);
  assert.ok(ds.records.length >= 3);
  const draw = ds.records.find(r => r.outcome === 'draw');
  assert.ok(draw && draw.homeElo > 0 && draw.awayElo > 0);
  assert.ok(['home', 'draw', 'away'].includes(ds.records[0].outcome));
});
```

Fixture `results-sample.tsv` (tab-separated; include a home win, a draw, an away win, and one neutral-site row):

```
2022	12	18	AR	FR	3	3	WC	QA	-6	2144	2081	0	0	1	3
2022	12	14	FR	MA	2	0	WC	QA	30	2075	1893	1	-3	3	14
2019	06	10	SE	NO	3	3	FQ	SE	0	1700	1640	0	0	40	44
2018	07	15	FR	HR	4	2	WC	RU	0	2000	1850	0	0	1	20
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/build-regulation-dataset.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`fetch-results.mjs`:

```javascript
export async function fetchResultsYear(year, { fetchImpl = fetch } = {}) {
  const url = `https://www.eloratings.net/${year}_results.tsv`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.text();
}
```

`build-regulation-dataset.mjs`:

```javascript
import { parseResultsTsv } from './lib/results-tsv.mjs';
import { isNeutral } from './lib/neutral.mjs';

export function buildRegulationDataset(tsvTexts) {
  const records = [];
  for (const text of tsvTexts) {
    for (const row of parseResultsTsv(text)) {
      const outcome = row.homeGoals > row.awayGoals ? 'home' : row.homeGoals < row.awayGoals ? 'away' : 'draw';
      records.push({ date: row.date, homeElo: row.homeElo, awayElo: row.awayElo, neutral: isNeutral(row), outcome });
    }
  }
  return { records };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/build-regulation-dataset.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/fetch-results.mjs scripts/worldcup/backtest/build-regulation-dataset.mjs test/worldcup/backtest/fixtures/results-sample.tsv test/worldcup/backtest/build-regulation-dataset.test.mjs
git commit -m "feat(wc-backtest): fetch + build regulation dataset from eloratings results

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: deterministic train/test split

**Files:**
- Create: `scripts/worldcup/backtest/lib/split.mjs`
- Test: `test/worldcup/backtest/split.test.mjs`

**Interfaces:**
- Produces: `splitTrainTest(records, {testFraction=0.3}): {train, test}` — deterministic by a string hash of `date+homeElo+awayElo`; same input → same split.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTrainTest } from '../../../scripts/worldcup/backtest/lib/split.mjs';

const recs = Array.from({ length: 100 }, (_, i) => ({ date: `2020-01-${(i % 28) + 1}`, homeElo: 1500 + i, awayElo: 1600 }));

test('split is deterministic and partitions fully', () => {
  const a = splitTrainTest(recs, { testFraction: 0.3 });
  const b = splitTrainTest(recs, { testFraction: 0.3 });
  assert.equal(a.train.length + a.test.length, recs.length);
  assert.deepEqual(a.test.map(r => r.homeElo), b.test.map(r => r.homeElo));
  assert.ok(a.test.length > 15 && a.test.length < 45);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/split.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 0xffffffff;
}
export function splitTrainTest(records, { testFraction = 0.3 } = {}) {
  const train = []; const test = [];
  for (const r of records) {
    (hashStr(`${r.date}|${r.homeElo}|${r.awayElo}`) < testFraction ? test : train).push(r);
  }
  return { train, test };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/split.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/split.mjs test/worldcup/backtest/split.test.mjs
git commit -m "feat(wc-backtest): deterministic train/test split

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: regulation calibration + constant tuning orchestrator

**Files:**
- Create: `scripts/worldcup/backtest/lib/calibrate-regulation.mjs`
- Test: `test/worldcup/backtest/calibrate-regulation.test.mjs`

**Interfaces:**
- Consumes: `predictRegulation` (Task 5), metrics (Task 3), `splitTrainTest` (Task 7).
- Produces: `evaluateConfig(records, config): {brier, logLoss, n, reliability}` and `tuneRegulation(records, grid): {best: {config, trainLogLoss}, test: {brier, logLoss, reliability}, baseline: {...}}`.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConfig, tuneRegulation } from '../../../scripts/worldcup/backtest/lib/calibrate-regulation.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../../../scripts/worldcup/lib/advances-model.mjs';

const recs = [
  { date: '2022-12-18', homeElo: 2144, awayElo: 2081, neutral: true, outcome: 'draw' },
  { date: '2022-12-14', homeElo: 2075, awayElo: 1893, neutral: true, outcome: 'home' },
  { date: '2019-06-10', homeElo: 1700, awayElo: 1640, neutral: false, outcome: 'draw' },
  { date: '2018-07-15', homeElo: 2000, awayElo: 1850, neutral: true, outcome: 'home' },
];

test('evaluateConfig returns finite metrics', () => {
  const m = evaluateConfig(recs, DEFAULT_ADVANCES_CONFIG);
  assert.ok(Number.isFinite(m.brier) && Number.isFinite(m.logLoss) && m.n === 4);
});

test('tuneRegulation reports baseline + best + held-out test metrics', () => {
  const grid = [DEFAULT_ADVANCES_CONFIG, { ...DEFAULT_ADVANCES_CONFIG, eloGoalSupremacyDivisor: 500 }];
  const out = tuneRegulation(recs, grid);
  assert.ok(out.best && out.test && out.baseline);
  assert.ok(Number.isFinite(out.test.logLoss));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/calibrate-regulation.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
import { predictRegulation } from './regulation-predict.mjs';
import { brierMulticlass, logLoss, reliabilityBins } from './calibration-metrics.mjs';
import { splitTrainTest } from './split.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../../lib/advances-model.mjs';

export function evaluateConfig(records, config) {
  let brier = 0; let ll = 0; const pts = [];
  for (const r of records) {
    const p = predictRegulation({ homeElo: r.homeElo, awayElo: r.awayElo, neutral: r.neutral, config });
    brier += brierMulticlass(p, r.outcome);
    ll += logLoss(p, r.outcome);
    pts.push({ p: p.pHome, hit: r.outcome === 'home' ? 1 : 0 });
  }
  const n = records.length || 1;
  return { brier: brier / n, logLoss: ll / n, n: records.length, reliability: reliabilityBins(pts) };
}

export function tuneRegulation(records, grid = [DEFAULT_ADVANCES_CONFIG]) {
  const { train, test } = splitTrainTest(records);
  let best = null;
  for (const config of grid) {
    const m = evaluateConfig(train, config);
    if (!best || m.logLoss < best.trainLogLoss) best = { config, trainLogLoss: m.logLoss };
  }
  return {
    baseline: evaluateConfig(test, DEFAULT_ADVANCES_CONFIG),
    best,
    test: evaluateConfig(test, best.config),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/calibrate-regulation.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/calibrate-regulation.mjs test/worldcup/backtest/calibrate-regulation.test.mjs
git commit -m "feat(wc-backtest): regulation calibration + out-of-sample constant tuning

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: penalty-layer test on shootout history

**Files:**
- Create: `scripts/worldcup/backtest/fetch-shootouts.mjs`
- Create: `scripts/worldcup/backtest/lib/penalty-test.mjs`
- Create (fixture): `test/worldcup/backtest/fixtures/shootouts-sample.json`
- Test: `test/worldcup/backtest/penalty-test.test.mjs`

**Interfaces:**
- Produces:
  - `fetchShootouts({fetchImpl=fetch}): Promise<{ok, rows}>` — best-effort fetch of a public shootouts source (URL pinned in Task 0); `{ok:false}` on failure (fail-soft).
  - `evaluatePenaltyPrior(shootouts: {higherEloWon: boolean}[]): {n, higherEloWinRate}` — the observed rate at which the higher-Elo team won the shootout (tests whether ~50/50 holds).

- [ ] **Step 1: Write the failing test** (fixture-driven, no network)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluatePenaltyPrior } from '../../../scripts/worldcup/backtest/lib/penalty-test.mjs';

test('evaluatePenaltyPrior computes higher-Elo win rate', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/shootouts-sample.json', import.meta.url), 'utf8'));
  const out = evaluatePenaltyPrior(rows);
  assert.equal(out.n, 4);
  assert.ok(out.higherEloWinRate >= 0 && out.higherEloWinRate <= 1);
});
```

Fixture `shootouts-sample.json`:

```json
[{"higherEloWon": true}, {"higherEloWon": false}, {"higherEloWon": true}, {"higherEloWon": false}]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/penalty-test.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`lib/penalty-test.mjs`:

```javascript
export function evaluatePenaltyPrior(shootouts) {
  const n = shootouts.length;
  const wins = shootouts.filter((s) => s.higherEloWon).length;
  return { n, higherEloWinRate: n ? wins / n : null };
}
```

`fetch-shootouts.mjs` (fail-soft; URL confirmed in Task 0):

```javascript
export async function fetchShootouts({ fetchImpl = fetch, url } = {}) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, rows: await res.text() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/penalty-test.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/fetch-shootouts.mjs scripts/worldcup/backtest/lib/penalty-test.mjs test/worldcup/backtest/fixtures/shootouts-sample.json test/worldcup/backtest/penalty-test.test.mjs
git commit -m "feat(wc-backtest): penalty-prior test against shootout history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: run-calibration CLI + report

**Files:**
- Create: `scripts/worldcup/backtest/run-calibration.mjs`
- Test: `test/worldcup/backtest/run-calibration.test.mjs`

**Interfaces:**
- Consumes: every prior task.
- Produces: `buildReport({records, grid, shootouts}): report` — `{generated_for, regulation: tuneRegulation(...), penalty: evaluatePenaltyPrior(...), sample_sizes}`. CLI (`--from <year> --to <year> --state-root state`) fetches real data, writes `state/worldcup/backtest/calibration_report.json`, prints a summary. Sets nothing in the live model — report only.

- [ ] **Step 1: Write the failing test** (pure `buildReport`, no network)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../../../scripts/worldcup/backtest/run-calibration.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../../../scripts/worldcup/lib/advances-model.mjs';

test('buildReport assembles regulation + penalty sections', () => {
  const records = [
    { date: '2022-12-18', homeElo: 2144, awayElo: 2081, neutral: true, outcome: 'draw' },
    { date: '2022-12-14', homeElo: 2075, awayElo: 1893, neutral: true, outcome: 'home' },
    { date: '2018-07-15', homeElo: 2000, awayElo: 1850, neutral: true, outcome: 'home' },
  ];
  const report = buildReport({ records, grid: [DEFAULT_ADVANCES_CONFIG], shootouts: [{ higherEloWon: true }] });
  assert.ok(report.regulation.test && report.penalty.n === 1);
  assert.equal(report.sample_sizes.regulation, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/worldcup/backtest/run-calibration.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```javascript
import { tuneRegulation } from './lib/calibrate-regulation.mjs';
import { evaluatePenaltyPrior } from './lib/penalty-test.mjs';
import { DEFAULT_ADVANCES_CONFIG } from '../lib/advances-model.mjs';

export function buildReport({ records, grid = [DEFAULT_ADVANCES_CONFIG], shootouts = [] }) {
  return {
    regulation: tuneRegulation(records, grid),
    penalty: evaluatePenaltyPrior(shootouts),
    sample_sizes: { regulation: records.length, shootouts: shootouts.length },
  };
}
// CLI wiring (fetch real years, write report json, print summary) guarded by
// `if (import.meta.url === \`file://${process.argv[1]}\`)`, using fetchResultsYear +
// buildRegulationDataset + a default config grid. No model mutation.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/worldcup/backtest/run-calibration.test.mjs` then `node --test test/worldcup-advances-model.test.mjs test/worldcup-packet-renderer.test.mjs`
Expected: PASS (new test + no WC regression).

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/run-calibration.mjs test/worldcup/backtest/run-calibration.test.mjs
git commit -m "feat(wc-backtest): calibration report + CLI orchestrator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 0 (do FIRST): pin data sources

**Files:**
- Create: `scripts/worldcup/backtest/DATA_SOURCES.md`

- [ ] **Step 1:** `curl -sI https://www.eloratings.net/2022_results.tsv` → confirm HTTP 200; record the column legend (verbatim from this plan's Global Constraints) in `DATA_SOURCES.md`.
- [ ] **Step 2:** Identify + fetch-check a public shootouts source (try `https://raw.githubusercontent.com/martj42/international_results/master/shootouts.csv`); record the exact URL, columns, and license in `DATA_SOURCES.md`. If unreachable, write "penalty layer: untested (no source)" and Task 9's fetch stays fail-soft.
- [ ] **Step 3: Commit**

```bash
git add scripts/worldcup/backtest/DATA_SOURCES.md
git commit -m "docs(wc-backtest): pin eloratings + shootout data sources

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** regulation calibration (Tasks 5,6,8), penalty layer (Task 9), composite spot-check — *gap:* the composite `p_advance` spot-check from the spec has no dedicated task. **Add Task 11** below. Constant tuning OOS (Tasks 7,8) ✓. Metrics (Task 3) ✓. Parameterization without logic fork (Task 4) ✓. Price isolation — no market data in any task ✓. Data sources pinned (Task 0) ✓.
- **Placeholder scan:** Task 4 and the Task 10 CLI describe edits in prose rather than a full code block (the edits are localized constant-threading and a guarded CLI). Acceptable but call out: the implementer must keep default output identical (asserted by Task 4 Step 4 + the WC regression run).
- **Type consistency:** `predictRegulation` returns `{pHome,pDraw,pAway}`; metrics consume the same keys ✓. `evaluateConfig`/`tuneRegulation` shapes match Task 10 usage ✓.

### Task 11: composite p_advance spot-check (added in self-review)

**Files:**
- Create: `scripts/worldcup/backtest/lib/composite-spotcheck.mjs`
- Test: `test/worldcup/backtest/composite-spotcheck.test.mjs`

**Interfaces:**
- Produces: `spotCheckAdvance(ties: {homeElo,awayElo,neutral,advanced:'home'|'away'}[], config): {n, brier}` — calls the real `computeAdvance`, scores Brier of `p_advance` (home perspective) vs the actual advancer. Used only as a sanity check on identifiable knockout ties (shootout winners + known decisive knockouts).

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spotCheckAdvance } from '../../../scripts/worldcup/backtest/lib/composite-spotcheck.mjs';

test('spotCheckAdvance scores Brier of p_advance vs actual advancer', () => {
  const ties = [
    { homeElo: 2100, awayElo: 1700, neutral: true, advanced: 'home' },
    { homeElo: 1700, awayElo: 2100, neutral: true, advanced: 'away' },
  ];
  const out = spotCheckAdvance(ties);
  assert.equal(out.n, 2);
  assert.ok(out.brier >= 0 && out.brier <= 1);
});
```

- [ ] **Step 2: Run test to verify it fails** — `node --test test/worldcup/backtest/composite-spotcheck.test.mjs` → FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```javascript
import { computeAdvance, DEFAULT_ADVANCES_CONFIG } from '../../lib/advances-model.mjs';

export function spotCheckAdvance(ties, config = DEFAULT_ADVANCES_CONFIG) {
  let brier = 0;
  for (const t of ties) {
    const adv = computeAdvance({
      eloTeam: t.homeElo, eloOpp: t.awayElo,
      bracket: { team_is_home: !t.neutral, stage: 'knockout', match_id: null },
      lineup: { confirmed: false }, config,
    });
    const p = adv.status === 'READY' ? adv.p_advance : 0.5;
    const y = t.advanced === 'home' ? 1 : 0;
    brier += (p - y) ** 2;
  }
  return { n: ties.length, brier: ties.length ? brier / ties.length : null };
}
```

- [ ] **Step 4: Run test to verify it passes** — `node --test test/worldcup/backtest/composite-spotcheck.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/worldcup/backtest/lib/composite-spotcheck.mjs test/worldcup/backtest/composite-spotcheck.test.mjs
git commit -m "feat(wc-backtest): composite p_advance spot-check on knockout ties

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Wire `spotCheckAdvance` into `buildReport` as a `composite` section when knockout ties are available; otherwise omit with a logged note.)
