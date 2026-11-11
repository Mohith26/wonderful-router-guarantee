// Router guarantee: certify that an automatic model router loses at most
// eps quality versus the premium model, with probability >= 1 - delta,
// using Learn-then-Test (Angelopoulos, Bates, Candes, Jordan, Lei 2021)
// with Hoeffding-Bentkus p-values and fixed-sequence testing.
//
// Pure functions; used by the browser app, the build/report scripts and tests.
//
// Data layout (data/router.json, see scripts/build_data.py):
//   models[k] = { id, name, price:[inUSDperM, outUSDperM], premium? }  (cheapest first; last = premium)
//   rows: column arrays, one entry per prompt
//     split[i]  0 = calibration, 1 = test
//     fam[i]    task family index into families[]
//     s[k][i]   judge score of model k, x100 (0..100)
//     tin[k][i], tout[k][i]  input/output tokens of model k
//     p[k][i]   predicted P(model k is as good as premium), x10000 (cheap models only)

export const GRID = Array.from({ length: 401 }, (_, j) => +(1 - j * 0.0025).toFixed(4)); // 1.0000 -> 0.0000

// ---------- numerics ----------
function logGamma(x) {
  // Lanczos approximation
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
// P(Bin(n, p) <= k)
export function binomCdf(k, n, p) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  const lnp = Math.log(p), ln1p = Math.log1p(-p), lgn = logGamma(n + 1);
  let s = 0, maxl = -Infinity; const terms = [];
  for (let i = 0; i <= k; i++) { const l = lgn - logGamma(i + 1) - logGamma(n - i + 1) + i * lnp + (n - i) * ln1p; terms.push(l); if (l > maxl) maxl = l; }
  for (const l of terms) s += Math.exp(l - maxl);
  return Math.min(1, Math.exp(maxl) * s);
}
function klBern(a, b) { // KL(Bern(a) || Bern(b))
  const t1 = a > 0 ? a * Math.log(a / b) : 0;
  const t2 = a < 1 ? (1 - a) * Math.log((1 - a) / (1 - b)) : 0;
  return t1 + t2;
}
// Hoeffding-Bentkus p-value for H0: risk > eps given mean loss rhat of n losses in [0,1]
export function hbPValue(rhat, eps, n) {
  if (n <= 0) return 1;
  const hoeff = rhat >= eps ? 1 : Math.exp(-n * klBern(rhat, eps));
  const bent = Math.E * binomCdf(Math.ceil(n * rhat), n, eps);
  return Math.min(1, hoeff, bent);
}
// smallest n for which a mean loss rhat would certify eps at level delta (planner)
export function samplesNeeded(rhat, eps, delta, nMax = 200000) {
  if (rhat >= eps) return null;
  let lo = 1, hi = 1;
  while (hi <= nMax && hbPValue(rhat, eps, hi) > delta) hi *= 2;
  if (hi > nMax) return null;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hbPValue(rhat, eps, mid) <= delta) hi = mid; else lo = mid + 1; }
  return lo;
}

// ---------- routing ----------
export function costOf(data, k, i) {
  const [pin, pout] = data.models[k].price;
  return (data.rows.tin[k][i] * pin + data.rows.tout[k][i] * pout) / 1e6;
}
// model chosen for prompt i at threshold lambda: cheapest allowed model whose
// predicted chance of matching the premium model is >= lambda, else premium
export function route(data, i, lambda, allowed) {
  const P = data.models.length - 1;
  if (lambda > 1) return P;
  const thr = lambda * 10000;
  for (let k = 0; k < P; k++) if (allowed[k] && data.rows.p[k][i] >= thr) return k;
  return P;
}
// quality loss of routing prompt i to model k (relative to premium), in [0,1]
export function lossOf(data, k, i) {
  const P = data.models.length - 1;
  return Math.max(0, data.rows.s[P][i] - data.rows.s[k][i]) / 100;
}
export function defaultAllowed(data) { return data.models.slice(0, -1).map(() => true); }

// evaluate one fixed threshold on a set of prompts
export function evaluate(data, idx, lambda, allowed = defaultAllowed(data)) {
  const K = data.models.length, P = K - 1;
  let loss = 0, cost = 0, costPrem = 0, qual = 0, qualPrem = 0;
  const mix = new Array(K).fill(0);
  for (const i of idx) {
    const k = route(data, i, lambda, allowed);
    mix[k]++;
    loss += lossOf(data, k, i);
    cost += costOf(data, k, i); costPrem += costOf(data, P, i);
    qual += data.rows.s[k][i] / 100; qualPrem += data.rows.s[P][i] / 100;
  }
  const n = idx.length || 1;
  return { n: idx.length, risk: loss / n, cost, costPrem, savings: costPrem > 0 ? 1 - cost / costPrem : 0, offPremium: 1 - mix[P] / n, mix: mix.map(m => m / n), quality: qual / n, qualityPrem: qualPrem / n };
}

// mean loss and cost for every grid threshold in one pass per prompt
export function sweep(data, idx, allowed = defaultAllowed(data), grid = GRID) {
  const K = data.models.length, P = K - 1, G = grid.length;
  const loss = new Float64Array(G), cost = new Float64Array(G); let costPrem = 0;
  for (const i of idx) {
    costPrem += costOf(data, P, i);
    for (let g = 0; g < G; g++) { const k = route(data, i, grid[g], allowed); loss[g] += lossOf(data, k, i); cost[g] += costOf(data, k, i); }
  }
  const n = idx.length || 1;
  return grid.map((lambda, g) => ({ lambda, risk: loss[g] / n, costRatio: costPrem > 0 ? cost[g] / costPrem : 1 }));
}

// Learn-then-Test with fixed-sequence testing from the safest threshold down.
// Returns the most permissive certified threshold (or null = premium only).
export function ltt(data, calIdx, { eps, delta, allowed = defaultAllowed(data), grid = GRID } = {}) {
  const sw = sweep(data, calIdx, allowed, grid);
  const n = calIdx.length;
  const steps = [];
  let lambdaHat = null;
  for (const st of sw) {
    const p = hbPValue(st.risk, eps, n);
    steps.push({ ...st, p, ucb: ucbRisk(st.risk, n, delta) });
    if (p <= delta) lambdaHat = st.lambda; else break;
  }
  // keep the full curve for display
  for (let j = steps.length; j < sw.length; j++) steps.push({ ...sw[j], p: hbPValue(sw[j].risk, eps, n), ucb: ucbRisk(sw[j].risk, n, delta), untested: true });
  return { lambdaHat, n, eps, delta, steps };
}
// plug-in tuning (what a dashboard threshold usually does): most permissive
// threshold whose calibration mean loss is <= eps; no correction
export function plugin(data, calIdx, { eps, allowed = defaultAllowed(data), grid = GRID } = {}) {
  const sw = sweep(data, calIdx, allowed, grid);
  let best = null;
  for (const st of sw) if (st.risk <= eps) best = st.lambda;
  return best;
}
// HB upper confidence bound on the risk (largest eps not rejected), for display
export function ucbRisk(rhat, n, delta) {
  let lo = rhat, hi = 1;
  for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (hbPValue(rhat, mid, n) <= delta) hi = mid; else lo = mid; }
  return hi;
}

// ---------- per task family ----------
export function indexBy(data, split, fam = null) {
  const out = [];
  const R = data.rows;
  for (let i = 0; i < R.split.length; i++) if (R.split[i] === split && (fam === null || R.fam[i] === fam)) out.push(i);
  return out;
}
// certify each family separately (each with its own guarantee); evaluate on test
export function certifyAll(data, { eps, delta, allowed = defaultAllowed(data), scope = 'family' } = {}) {
  const fams = data.families.map((f, j) => j);
  const res = [];
  if (scope === 'org') {
    const cal = indexBy(data, 0), test = indexBy(data, 1);
    const c = ltt(data, cal, { eps, delta, allowed });
    const pl = plugin(data, cal, { eps, allowed });
    return { scope, policies: [{ fam: null, cal: cal.length, test: test.length, ...c, plugin: pl, testEval: c.lambdaHat === null ? evaluate(data, test, 1.01, allowed) : evaluate(data, test, c.lambdaHat, allowed), calEval: c.lambdaHat === null ? evaluate(data, cal, 1.01, allowed) : evaluate(data, cal, c.lambdaHat, allowed), pluginTest: pl === null ? null : evaluate(data, test, pl, allowed) }], lambdaFor: () => c.lambdaHat ?? 1.01, total: totalEval(data, () => c.lambdaHat ?? 1.01, allowed) };
  }
  const lam = new Map();
  for (const j of fams) {
    const cal = indexBy(data, 0, j), test = indexBy(data, 1, j);
    const c = ltt(data, cal, { eps, delta, allowed });
    const pl = plugin(data, cal, { eps, allowed });
    lam.set(j, c.lambdaHat ?? 1.01);
    res.push({ fam: j, cal: cal.length, test: test.length, ...c, plugin: pl, testEval: evaluate(data, test, c.lambdaHat ?? 1.01, allowed), calEval: evaluate(data, cal, c.lambdaHat ?? 1.01, allowed), pluginTest: pl === null ? null : evaluate(data, test, pl, allowed) });
  }
  const lambdaFor = (fam) => lam.get(fam);
  return { scope, policies: res, lambdaFor, total: totalEval(data, lambdaFor, allowed) };
}
function totalEval(data, lambdaFor, allowed) {
  const K = data.models.length, P = K - 1; const R = data.rows;
  let loss = 0, cost = 0, costPrem = 0, n = 0; const mix = new Array(K).fill(0);
  for (let i = 0; i < R.split.length; i++) {
    if (R.split[i] !== 1) continue;
    const k = route(data, i, lambdaFor(R.fam[i]), allowed);
    mix[k]++; n++; loss += lossOf(data, k, i); cost += costOf(data, k, i); costPrem += costOf(data, P, i);
  }
  return { n, risk: loss / Math.max(1, n), savings: costPrem > 0 ? 1 - cost / costPrem : 0, cost, costPrem, offPremium: 1 - mix[P] / Math.max(1, n), mix: mix.map(m => m / Math.max(1, n)) };
}

// ---------- validity check by random re-splits ----------
// Pool calibration+test prompts of one family (or all), re-split at random B
// times, tune on the calibration part, measure the risk on the rest.
export function mulberry32(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function resplit(data, pool, { eps, delta, nCal, B = 100, seed = 1, allowed = defaultAllowed(data), grid = GRID } = {}) {
  const rnd = mulberry32(seed);
  // precompute per-prompt loss/cost for every grid value once
  const G = grid.length, P = data.models.length - 1;
  const L = pool.map(i => { const a = new Float32Array(G); for (let g = 0; g < G; g++) a[g] = lossOf(data, route(data, i, grid[g], allowed), i); return a; });
  const C = pool.map(i => { const a = new Float32Array(G); for (let g = 0; g < G; g++) a[g] = costOf(data, route(data, i, grid[g], allowed), i); return a; });
  const CP = pool.map(i => costOf(data, P, i));
  let lttViol = 0, plugViol = 0, lttSav = 0, plugSav = 0, certified = 0;
  const order = pool.map((_, j) => j);
  for (let b = 0; b < B; b++) {
    for (let j = order.length - 1; j > 0; j--) { const r = Math.floor(rnd() * (j + 1)); [order[j], order[r]] = [order[r], order[j]]; }
    const cal = order.slice(0, nCal), test = order.slice(nCal);
    const mean = (set, g, A) => { let s = 0; for (const j of set) s += A[j][g]; return s / set.length; };
    let gL = -1, gP = -1;
    for (let g = 0; g < G; g++) { const r = mean(cal, g, L); if (hbPValue(r, eps, cal.length) <= delta) gL = g; else break; }
    for (let g = 0; g < G; g++) { if (mean(cal, g, L) <= eps) gP = g; }
    const testRisk = (g) => g < 0 ? 0 : mean(test, g, L);
    const sav = (g) => { if (g < 0) return 0; let c = 0, cp = 0; for (const j of test) { c += C[j][g]; cp += CP[j]; } return 1 - c / cp; };
    if (gL >= 0) certified++;
    if (testRisk(gL) > eps) lttViol++;
    if (testRisk(gP) > eps) plugViol++;
    lttSav += sav(gL); plugSav += sav(gP);
  }
  return { B, nCal, nTest: pool.length - nCal, lttViolation: lttViol / B, pluginViolation: plugViol / B, lttSavings: lttSav / B, pluginSavings: plugSav / B, certifiedShare: certified / B };
}

export function round(x, d = 4) { const f = 10 ** d; return Math.round(x * f) / f; }
