import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  binomCdf, hbPValue, ucbRisk, samplesNeeded, route, lossOf, costOf, evaluate, sweep, ltt, plugin,
  certifyAll, indexBy, resplit, mulberry32, GRID,
} from '../src/guarantee.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

// tiny synthetic dataset builder: 2 cheap models + premium
function synth(n, seed, { split = null } = {}) {
  const rnd = mulberry32(seed);
  const R = { split: [], fam: [], s: [[], [], []], tin: [[], [], []], tout: [[], [], []], p: [[], []] };
  for (let i = 0; i < n; i++) {
    R.split.push(split ?? (i % 2)); R.fam.push(i % 2);
    const q0 = rnd(), q1 = rnd();
    R.p[0].push(Math.round(q0 * 10000)); R.p[1].push(Math.round(q1 * 10000));
    R.s[2].push(100);
    // a cheap model matches the premium with probability equal to its score (calibrated router)
    R.s[0].push(rnd() < q0 ? 100 : 0); R.s[1].push(rnd() < q1 ? 100 : 0);
    for (let k = 0; k < 3; k++) { R.tin[k].push(1000); R.tout[k].push(200); }
  }
  return { families: ['A', 'B'], models: [{ name: 'small', price: [0.1, 0.1] }, { name: 'mid', price: [0.5, 0.5] }, { name: 'prem', price: [5, 15], premium: true }], rows: R };
}

test('binomCdf matches direct summation (randomized)', () => {
  const rnd = mulberry32(3);
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(rnd() * 60), p = rnd(), k = Math.floor(rnd() * (n + 1));
    let s = 0, c = 1;
    for (let i = 0; i <= k; i++) { if (i > 0) c = c * (n - i + 1) / i; s += c * p ** i * (1 - p) ** (n - i); }
    assert.ok(Math.abs(binomCdf(k, n, p) - s) < 1e-9, `n=${n} k=${k} p=${p}`);
  }
});

test('Hoeffding-Bentkus p-value is monotone in n and in the observed risk', () => {
  assert.ok(hbPValue(0.01, 0.03, 2000) < hbPValue(0.01, 0.03, 500));
  assert.ok(hbPValue(0.02, 0.03, 1000) > hbPValue(0.01, 0.03, 1000));
  assert.equal(hbPValue(0.05, 0.03, 1000), 1);
});

test('HB p-value is valid: when the true risk equals eps, P(p <= delta) <= delta (randomized)', () => {
  const rnd = mulberry32(17); const eps = 0.05, delta = 0.1, n = 300; let rej = 0; const T = 3000;
  for (let t = 0; t < T; t++) { let s = 0; for (let i = 0; i < n; i++) s += rnd() < eps ? 1 : 0; if (hbPValue(s / n, eps, n) <= delta) rej++; }
  assert.ok(rej / T <= delta, `rejection rate ${rej / T}`);
});

test('UCB is the boundary of the test and the label planner is minimal', () => {
  const u = ucbRisk(0.01, 2000, 0.05);
  assert.ok(hbPValue(0.01, u * 1.01, 2000) <= 0.05 && hbPValue(0.01, u * 0.99, 2000) > 0.05);
  const n = samplesNeeded(0.01, 0.03, 0.05);
  assert.ok(hbPValue(0.01, 0.03, n) <= 0.05 && hbPValue(0.01, 0.03, n - 1) > 0.05);
  assert.equal(samplesNeeded(0.04, 0.03, 0.05), null);
});

test('route picks the cheapest allowed model above the threshold, else premium', () => {
  const d = synth(1, 1); d.rows.p[0][0] = 9000; d.rows.p[1][0] = 9500;
  assert.equal(route(d, 0, 0.85, [true, true]), 0);
  assert.equal(route(d, 0, 0.92, [true, true]), 1);
  assert.equal(route(d, 0, 0.85, [false, true]), 1);
  assert.equal(route(d, 0, 0.99, [true, true]), 2);
  assert.equal(route(d, 0, 1.01, [true, true]), 2);
});

test('loss is the non-negative drop versus premium; cost uses token prices', () => {
  const d = synth(1, 2); d.rows.s[0][0] = 40; d.rows.s[2][0] = 90; d.rows.s[1][0] = 100;
  assert.equal(lossOf(d, 0, 0), 0.5); assert.equal(lossOf(d, 1, 0), 0); assert.equal(lossOf(d, 2, 0), 0);
  assert.ok(Math.abs(costOf(d, 2, 0) - (1000 * 5 + 200 * 15) / 1e6) < 1e-12);
});

test('evaluate and sweep agree, and the threshold above 1 is the always-premium policy', () => {
  const d = synth(400, 5, { split: 0 }); const idx = indexBy(d, 0);
  const sw = sweep(d, idx, [true, true]);
  for (const g of [0, 50, 200, 400]) { const e = evaluate(d, idx, GRID[g], [true, true]); assert.ok(Math.abs(e.risk - sw[g].risk) < 1e-12); assert.ok(Math.abs(1 - e.savings - sw[g].costRatio) < 1e-9); }
  const p = evaluate(d, idx, 1.01, [true, true]); assert.equal(p.risk, 0); assert.equal(p.savings, 0);
});

test('Learn-then-Test controls the true risk; plug-in tuning does not (randomized)', () => {
  const eps = 0.1, delta = 0.1; let lttBad = 0, plugBad = 0; const T = 60;
  const big = synth(20000, 999, { split: 1 }); const bigIdx = indexBy(big, 1);
  const trueRisk = new Map(sweep(big, bigIdx, [true, true]).map(s => [s.lambda, s.risk]));
  for (let t = 0; t < T; t++) {
    const d = synth(400, 1000 + t, { split: 0 }); const cal = indexBy(d, 0);
    const lh = ltt(d, cal, { eps, delta, allowed: [true, true] }).lambdaHat;
    const pl = plugin(d, cal, { eps, allowed: [true, true] });
    if (lh !== null && trueRisk.get(lh) > eps) lttBad++;
    if (pl !== null && trueRisk.get(pl) > eps) plugBad++;
  }
  assert.ok(lttBad / T <= delta + 0.05, `LTT violations ${lttBad}/${T}`);
  assert.ok(plugBad > lttBad, `plug-in ${plugBad} vs LTT ${lttBad}`);
});

test('fixed-sequence testing stops at the first failure (certified set is a prefix)', () => {
  const d = synth(500, 8, { split: 0 }); const r = ltt(d, indexBy(d, 0), { eps: 0.08, delta: 0.05, allowed: [true, true] });
  const firstFail = r.steps.findIndex(s => s.p > 0.05);
  if (r.lambdaHat !== null) assert.equal(r.steps[firstFail - 1].lambda, r.lambdaHat);
  assert.ok(r.steps.slice(0, firstFail).every(s => s.p <= 0.05));
});

test('per-family certification: each family gets its own threshold and the total adds up', () => {
  const d = synth(2000, 21); const res = certifyAll(d, { eps: 0.08, delta: 0.05, scope: 'family' });
  assert.equal(res.policies.length, 2);
  const nTest = res.policies.reduce((s, p) => s + p.test, 0);
  assert.equal(res.total.n, nTest);
  const w = res.policies.reduce((s, p) => s + p.testEval.risk * p.test, 0) / nTest;
  assert.ok(Math.abs(w - res.total.risk) < 1e-9);
});

test('re-split validity check returns sensible frequencies', () => {
  const d = synth(1200, 33); const pool = [...indexBy(d, 0), ...indexBy(d, 1)];
  const r = resplit(d, pool, { eps: 0.08, delta: 0.1, nCal: 400, B: 40, seed: 2, allowed: [true, true] });
  for (const k of ['lttViolation', 'pluginViolation', 'certifiedShare']) assert.ok(r[k] >= 0 && r[k] <= 1);
  assert.ok(r.lttViolation <= r.pluginViolation);
  assert.equal(r.nTest, 800);
});

test('public data snapshot is consistent (SPROUT rows, 5 models, probabilities in range)', () => {
  const d = load('data/router.json');
  const n = d.rows.split.length;
  assert.equal(n, d.meta.rows.calibration + d.meta.rows.test);
  assert.equal(d.models.length, 5); assert.ok(d.models[4].premium);
  for (const k of [0, 1, 2, 3]) { assert.equal(d.rows.p[k].length, n); assert.ok(d.rows.p[k].every(v => v >= 0 && v <= 10000)); }
  for (const k of [0, 1, 2, 3, 4]) assert.ok(d.rows.s[k].every(v => v >= 0 && v <= 100));
});

test('headline numbers in results.json reproduce from the data', () => {
  const d = load('data/router.json'); const r = load('results/results.json');
  const fam = certifyAll(d, { eps: r.eps, delta: r.delta, scope: 'family' });
  assert.equal(Math.round(fam.total.savings * 1e4) / 1e4, r.perFamily.savings);
  assert.equal(Math.round(fam.total.risk * 1e4) / 1e4, r.perFamily.testRisk);
  assert.ok(fam.total.risk <= r.eps);
  const all = [...indexBy(d, 0), ...indexBy(d, 1)];
  const org = resplit(d, all, { eps: r.eps, delta: r.delta, nCal: indexBy(d, 0).length, B: 200, seed: 11 });
  assert.equal(Math.round(org.pluginViolation * 1e4) / 1e4, r.resplits.org.pluginViolation);
  assert.equal(Math.round(org.lttViolation * 1e4) / 1e4, r.resplits.org.lttViolation);
});
