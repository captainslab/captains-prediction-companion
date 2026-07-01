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
