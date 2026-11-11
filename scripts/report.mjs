// Writes results/results.json from data/router.json (deterministic):
//   node scripts/report.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { certifyAll, evaluate, indexBy, resplit, samplesNeeded, round, defaultAllowed } from '../src/guarantee.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/router.json'), 'utf8'));
const EPS = 0.03, DELTA = 0.05;

const fam = certifyAll(data, { eps: EPS, delta: DELTA, scope: 'family' });
const org = certifyAll(data, { eps: EPS, delta: DELTA, scope: 'org' });
const test = indexBy(data, 1);
const always = data.models.slice(0, -1).map((m, k) => { const allowed = data.models.slice(0, -1).map((_, j) => j === k); const e = evaluate(data, test, 0, allowed); return { model: m.name, risk: round(e.risk), savings: round(e.savings) }; });

// validity by random re-splits of calibration+test, per family and org-wide
const t0 = Date.now();
const all = [...indexBy(data, 0), ...indexBy(data, 1)];
const orgSplit = resplit(data, all, { eps: EPS, delta: DELTA, nCal: indexBy(data, 0).length, B: 200, seed: 11 });
const famSplit = data.families.map((name, j) => {
  const pool = [...indexBy(data, 0, j), ...indexBy(data, 1, j)];
  const r = resplit(data, pool, { eps: EPS, delta: DELTA, nCal: indexBy(data, 0, j).length, B: 200, seed: 100 + j });
  return { family: name, ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])) };
});
const famPluginViol = famSplit.reduce((s, r) => s + r.pluginViolation, 0) / famSplit.length;
const famLttViol = famSplit.reduce((s, r) => s + r.lttViolation, 0) / famSplit.length;

const policies = fam.policies.map(p => ({
  family: data.families[p.fam], cal: p.cal, test: p.test, lambda: p.lambdaHat, certified: p.lambdaHat !== null,
  calRisk: round(p.calEval.risk), testRisk: round(p.testEval.risk), testSavings: round(p.testEval.savings), offPremium: round(p.testEval.offPremium),
  plugin: p.plugin, pluginTestRisk: p.pluginTest ? round(p.pluginTest.risk) : null, pluginTestSavings: p.pluginTest ? round(p.pluginTest.savings) : null,
  // labels needed to certify the plug-in threshold's (riskier) setting, from its calibration risk
  labelsNeeded: p.plugin === null ? null : samplesNeeded(evaluate(data, indexBy(data, 0, p.fam), p.plugin).risk, EPS, DELTA),
}));

const out = {
  generatedBy: 'node scripts/report.mjs', data: 'data/router.json (SPROUT, public)', eps: EPS, delta: DELTA,
  rows: data.meta.rows, router: data.meta.diagnostics,
  alwaysCheap: always,
  perFamily: { testRisk: round(fam.total.risk), savings: round(fam.total.savings), offPremium: round(fam.total.offPremium), mix: fam.total.mix.map(x => round(x)), policies },
  orgWide: { lambda: org.policies[0].lambdaHat, testRisk: round(org.total.risk), savings: round(org.total.savings), offPremium: round(org.total.offPremium) },
  resplits: { B: 200, org: Object.fromEntries(Object.entries(orgSplit).map(([k, v]) => [k, typeof v === 'number' ? round(v) : v])), perFamily: famSplit, perFamilyMean: { lttViolation: round(famLttViol), pluginViolation: round(famPluginViol) } },
};
const runtimeMs = Date.now() - t0;
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'results/results.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ perFamily: { ...out.perFamily, policies: undefined }, orgWide: out.orgWide, resplitsOrg: out.resplits.org, famMean: out.resplits.perFamilyMean, runtimeMs }, null, 1));
for (const p of policies) console.log(p.family, p.cal, p.test, 'lam', p.lambda, 'test risk', p.testRisk, 'sav', p.testSavings, 'plugin', p.plugin, p.pluginTestRisk, p.pluginTestSavings, 'labels', p.labelsNeeded);
for (const r of famSplit) console.log(r.family, 'ltt viol', r.lttViolation, 'plugin viol', r.pluginViolation, 'ltt sav', r.lttSavings, 'plug sav', r.pluginSavings);
