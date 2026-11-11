// Router guarantee for the Wonderful AI Gateway > Model router (concept).
// Every number on the page is computed from data/router.json (public SPROUT data) by src/guarantee.js.
import { certifyAll, evaluate, sweep, ltt, indexBy, resplit, samplesNeeded, route, costOf, defaultAllowed, GRID, round } from './src/guarantee.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = 'wonderful-router-guarantee-v1';
const COLORS = ['#a77bf0', '#e8a33a', '#5ca3ff', '#2fc79c', '#8a8a8a'];
const S = {
  data: null, results: null, cert: null, extra: null,
  settings: { eps: 0.03, conf: 0.95, scope: 'family', allowed: null },
  tab: 'guarantee', task: null, page: 0, famFilter: null,
  policy: null, drillCache: new Map(), live: null,
};
const pct = (x, d = 1) => (Number.isFinite(x) ? (x * 100).toFixed(d) + '%' : '–');
const n0 = (x) => Math.round(x).toLocaleString('en-US');
const usd = (x) => x >= 100 ? '$' + n0(x) : x >= 1 ? '$' + x.toFixed(2) : '$' + x.toFixed(4);

function loadState() { try { const s = JSON.parse(localStorage.getItem(LS) || '{}'); if (s.settings) Object.assign(S.settings, s.settings); S.policy = s.policy || null; } catch { } }
function saveState() { try { localStorage.setItem(LS, JSON.stringify({ settings: S.settings, policy: S.policy })); } catch { } }

// ---------- routing state ----------
function parseHash() {
  const [p, q] = (location.hash.replace(/^#/, '') || '/model-router').split('?');
  const qs = new URLSearchParams(q || '');
  if (qs.has('tab')) S.tab = ['guarantee', 'rules', 'decisions'].includes(qs.get('tab')) ? qs.get('tab') : 'guarantee';
  if (qs.has('eps')) { const e = +qs.get('eps') / 100; if (e >= 0.005 && e <= 0.1) S.settings.eps = e; }
  if (qs.has('conf')) { const c = +qs.get('conf') / 100; if ([0.9, 0.95, 0.99].includes(c)) S.settings.conf = c; }
  if (qs.has('scope')) S.settings.scope = qs.get('scope') === 'org' ? 'org' : 'family';
  S.task = qs.has('task') ? +qs.get('task') : null;
}
function writeHash(replace = true) {
  const qs = new URLSearchParams();
  if (S.tab !== 'guarantee') qs.set('tab', S.tab);
  qs.set('eps', (S.settings.eps * 100).toFixed(1).replace(/\.0$/, ''));
  qs.set('conf', Math.round(S.settings.conf * 100));
  if (S.settings.scope === 'org') qs.set('scope', 'org');
  if (S.task !== null && S.tab === 'guarantee') qs.set('task', S.task);
  const h = '#/model-router?' + qs.toString();
  if (replace) history.replaceState(null, '', h); else history.pushState(null, '', h);
}

// ---------- computation ----------
function compute() {
  const d = S.data, { eps, conf, scope } = S.settings, delta = 1 - conf, allowed = S.settings.allowed;
  const t0 = performance.now();
  S.cert = certifyAll(d, { eps, delta, scope, allowed });
  // uncorrected (plug-in) policy, same scope
  const test = indexBy(d, 1), cal = indexBy(d, 0);
  const plugLam = new Map(S.cert.policies.map(p => [p.fam, p.plugin ?? 1.01]));
  const plugFor = (fam) => scope === 'org' ? plugLam.get(null) : plugLam.get(fam);
  let loss = 0, cost = 0, costPrem = 0; const P = d.models.length - 1;
  for (const i of test) { const k = route(d, i, plugFor(d.rows.fam[i]), allowed); loss += Math.max(0, d.rows.s[P][i] - d.rows.s[k][i]) / 100; cost += costOf(d, k, i); costPrem += costOf(d, P, i); }
  const plugTotal = { risk: loss / test.length, savings: 1 - cost / costPrem };
  // frontier curves (single org-wide threshold), test and calibration
  const sweepT = sweep(d, test, allowed), sweepC = sweep(d, cal, allowed);
  const always = d.models.slice(0, -1).map((m, k) => { const a = d.models.slice(0, -1).map((_, j) => j === k); const e = evaluate(d, test, 0, a); return { name: m.name, risk: e.risk, costRatio: 1 - e.savings, k }; });
  S.extra = { plugTotal, sweepT, sweepC, always, ms: Math.round(performance.now() - t0) };
  document.documentElement.dataset.computeMs = S.extra.ms;
}

// ---------- render ----------
function render() {
  $('#crumbCur').textContent = 'Model router';
  const main = $('#main');
  const pol = S.policy;
  const pill = $('#policyPill');
  if (pol) { pill.hidden = false; pill.innerHTML = `<i data-lucide="shield-check" style="width:13px;height:13px"></i>Policy v${pol.version} active · ≤${(pol.eps * 100).toFixed(1)}% certified`; } else pill.hidden = true;
  main.innerHTML = `<div class="page">
    <div class="ph"><div><h1>Model router</h1><p>Picks a model per prompt by your org’s rules, now with a quality guarantee you can audit.</p></div>
      <div class="r"><div class="seg" role="tablist" aria-label="Router views">${[['guarantee', 'Guarantee'], ['rules', 'Rules'], ['decisions', 'Decisions']].map(([id, l]) => `<button role="tab" data-tab="${id}" aria-selected="${S.tab === id}">${l}${id === 'guarantee' ? '<span class="new">New</span>' : ''}</button>`).join('')}</div>
      <button class="btn" data-act="export" title="Export (e)"><i data-lucide="download"></i>Export</button><button class="btn primary" data-act="apply" title="Apply policy (a)">Apply policy</button></div></div>
    ${S.tab === 'rules' ? renderRules() : S.tab === 'decisions' ? renderDecisions() : renderGuarantee()}
  </div>`;
  icons();
  bindAfter();
}
function icons() { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.6 } }); }

function renderGuarantee() {
  const d = S.data, c = S.cert, x = S.extra, { eps, conf, scope } = S.settings;
  const tot = c.total;
  const calN = indexBy(d, 0).length;
  const certCount = c.policies.filter(p => p.lambdaHat !== null && p.testEval.offPremium > 0).length;
  return `<div class="kpis">
      <div class="card kpi"><div class="l">Est. savings</div><div class="v">${pct(tot.savings)}<small>vs. always gpt-4o</small></div><div class="s">on ${n0(tot.n)} held-out prompts</div></div>
      <div class="card kpi"><div class="l">Routed off premium</div><div class="v">${pct(tot.offPremium)}<small>of requests</small></div><div class="s">${certCount} of ${c.policies.length} ${scope === 'org' ? 'policy' : 'task families'} certified</div></div>
      <div class="card kpi"><div class="l">Quality loss</div><div class="v">≤ ${pct(eps)}<small>certified</small></div><div class="s">${pct(tot.risk, 2)} measured on held-out</div></div>
      <div class="card kpi"><div class="l">Audit set</div><div class="v">${n0(calN)}<small>judged prompts</small></div><div class="s">${Math.round(conf * 100)}% confidence · Learn-then-Test</div></div>
    </div>
    <div class="grid2">
      <div class="card"><div class="ct"><h2>Guarantee</h2><i data-lucide="info" class="info" title="Learn-then-Test with Hoeffding-Bentkus p-values"></i></div>
        <div class="cs">Route to a cheaper model only when the router can prove the average quality drop versus gpt-4o stays under your limit.</div>
        <div class="set">
          <div class="row"><div class="eps"><span class="k">Max quality loss</span><input type="range" id="eps" min="0.5" max="8" step="0.5" value="${(eps * 100).toFixed(1)}" aria-label="Max quality loss in judge-score points"><b id="epsV">${pct(eps)}</b></div></div>
          <div class="row"><div class="k">Confidence<small>Chance the limit holds on new traffic</small></div><div class="r"><div class="seg">${[0.9, 0.95, 0.99].map(v => `<button data-conf="${v}" aria-pressed="${conf === v}">${Math.round(v * 100)}%</button>`).join('')}</div></div></div>
          <div class="row"><div class="k">Scope<small>Certify each task family on its own</small></div><div class="r"><div class="seg">${[['family', 'Per task'], ['org', 'Org-wide']].map(([v, l]) => `<button data-scope="${v}" aria-pressed="${scope === v}">${l}</button>`).join('')}</div></div></div>
          <div class="row" style="display:block"><div class="k" style="margin-bottom:4px">Eligible models</div>
            ${d.models.map((m, k) => `<div class="mrow"><span class="mlogo"><i data-lucide="${m.name.startsWith('gpt') ? 'aperture' : 'infinity'}"></i></span><span class="mname">${esc(m.name)}</span><span class="tag" title="List price per million input / output tokens">$${m.price[0]} / $${m.price[1]}</span>${m.premium ? '<span class="tag" style="margin-left:auto">Premium</span>' : `<button class="toggle" role="switch" aria-checked="${S.settings.allowed[k]}" data-allow="${k}" aria-label="Allow ${esc(m.name)}"></button>`}</div>`).join('')}
          </div>
        </div>
      </div>
      <div class="card"><div class="ct"><h2>Cost vs. quality</h2><div class="r"><span class="leg"><i></i>Held-out</span><span class="leg"><i class="d"></i>Audit set</span><span class="leg"><i class="r"></i>Limit</span></div></div>
        <div class="cs">Every threshold the router could use, from always gpt-4o (right) to always the cheapest eligible model (left).</div>
        <div class="chart" id="frontier">${frontierSvg()}</div>
        ${spendByModel()}
      </div>
    </div>
    <div class="card tcard"><div class="ct"><h2>By task</h2><div class="r">${scope === 'org' ? 'One threshold for all traffic' : 'Each family has its own threshold and guarantee'}</div></div>
      <table class="t" style="margin-top:6px"><thead><tr><th>Task family</th><th class="n">Audit prompts</th><th>Model mix</th><th class="n">Off premium</th><th class="n">Savings</th><th class="n">Quality loss</th><th>Status</th></tr></thead>
      <tbody>${c.policies.map(p => taskRow(p)).join('')}</tbody></table>
    </div>
    ${validityCard()}`;
}
function taskRow(p) {
  const d = S.data, fam = p.fam, name = fam === null ? 'All tasks' : d.families[fam];
  const key = fam === null ? -1 : fam;
  const sel = S.task === key;
  const e = p.testEval;
  const routes = p.lambdaHat !== null && e.offPremium > 0;
  const status = routes ? '<span class="chip ok"><i data-lucide="shield-check" style="width:13px;height:13px"></i>Certified</span>' : p.lambdaHat === null ? '<span class="chip no">Premium only</span>' : '<span class="chip no">Premium only</span>';
  const mix = `<span class="mix" title="${d.models.map((m, k) => `${m.name} ${pct(e.mix[k])}`).join(' · ')}">${e.mix.map((v, k) => v > 0 ? `<span style="width:${(v * 100).toFixed(1)}%;background:${COLORS[k]}"></span>` : '').join('')}</span>`;
  return `<tr class="click ${sel ? 'sel' : ''}" tabindex="0" data-task="${key}" aria-expanded="${sel}"><td>${esc(name)}</td><td class="n">${n0(p.cal)}</td><td>${mix}</td><td class="n">${pct(e.offPremium)}</td><td class="n">${pct(e.savings)}</td><td class="n">${routes ? `≤ ${pct(S.settings.eps)} <span class="muted">· ${pct(e.risk, 2)}</span>` : '<span class="muted">0%</span>'}</td><td>${status}</td></tr>${sel ? `<tr><td colspan="7" style="padding:0">${drillHtml(p)}</td></tr>` : ''}`;
}

function drillHtml(p) {
  const d = S.data, { eps, conf } = S.settings, delta = 1 - conf;
  const famName = p.fam === null ? 'All tasks' : d.families[p.fam];
  const pl = p.pluginTest;
  const key = `${p.fam}|${eps}|${conf}|${S.settings.allowed.join('')}`;
  const rs = S.drillCache.get(key);
  const plugCalRisk = p.plugin === null ? null : evaluate(d, p.fam === null ? indexBy(d, 0) : indexBy(d, 0, p.fam), p.plugin, S.settings.allowed).risk;
  const need = plugCalRisk === null ? null : samplesNeeded(plugCalRisk, eps, delta);
  const samples = d.samples.filter(s => p.fam === null || d.rows.fam[s.i] === p.fam).slice(0, 5);
  const lam = S.cert.lambdaFor(p.fam);
  return `<div class="drill"><div class="drill-grid">
    <div><div class="ct" style="padding:14px 0 0"><h2>${esc(famName)}: risk by threshold</h2><div class="r"><span class="leg"><i></i>Audit-set loss</span><span class="leg"><i class="d"></i>Upper bound (${Math.round(conf * 100)}%)</span></div></div>
      <div class="chart" style="padding:6px 0 0">${riskSvg(p)}</div></div>
    <div><dl class="kv">
      <dt>Certified threshold</dt><dd>${p.lambdaHat === null ? 'none (premium only)' : `<b>${p.lambdaHat.toFixed(4)}</b> · router score needed to leave gpt-4o`}</dd>
      <dt>Held-out result</dt><dd><b>${pct(p.testEval.savings)}</b> saved · ${pct(p.testEval.risk, 2)} quality loss · ${n0(p.test)} prompts</dd>
      <dt>Uncorrected tuning</dt><dd>${pl ? `threshold ${p.plugin.toFixed(4)} · ${pct(pl.savings)} saved · <span style="color:${pl.risk > eps ? '#ff8a8a' : 'inherit'}">${pct(pl.risk, 2)} loss</span>` : 'n/a'}</dd>
      <dt>Re-splits</dt><dd id="rsOut">${rs ? `uncorrected broke the ${pct(eps)} limit in <b>${pct(rs.pluginViolation, 0)}</b> of ${rs.B}; certified in <b>${pct(rs.lttViolation, 0)}</b>` : '<span class="muted">computing…</span>'}</dd>
      <dt>To certify the uncorrected setting</dt><dd>${need === null ? 'not possible at any audit size (its audit loss is already at the limit)' : `about <b>${n0(need)}</b> judged prompts (have ${n0(p.cal)})`}</dd>
    </dl>
    <div class="note">The guarantee covers traffic like the audit set. Re-run it when the task mix, prompts or models change; the threshold only moves if the evidence supports it.</div></div>
  </div>
  ${samples.length ? `<table class="t" style="margin-top:12px;background:#141414;border-radius:10px"><thead><tr><th>Prompt</th><th>Routed to</th><th class="n">Router score</th><th class="n">Judge score</th><th class="n">gpt-4o</th><th class="n">Cost</th></tr></thead><tbody>${samples.map(s => decisionRow(s, lam)).join('')}</tbody></table>` : ''}</div>`;
}
function decisionRow(s, lam) {
  const d = S.data, i = s.i, P = d.models.length - 1;
  const k = route(d, i, lam, S.settings.allowed);
  const score = k < P ? d.rows.p[k][i] / 10000 : Math.max(...d.models.slice(0, -1).map((_, j) => S.settings.allowed[j] ? d.rows.p[j][i] / 10000 : 0));
  return `<tr><td><div class="prompt" title="${esc(s.preview)}">${esc(s.preview)}</div><span class="muted" style="font-size:12px">${esc(s.task)}</span></td><td><span class="dot" style="background:${COLORS[k]};margin-right:6px"></span>${esc(d.models[k].name)}</td><td class="n">${score.toFixed(3)}</td><td class="n">${(d.rows.s[k][i] / 100).toFixed(2)}</td><td class="n">${(d.rows.s[P][i] / 100).toFixed(2)}</td><td class="n">${usd(costOf(d, k, i))}</td></tr>`;
}

function validityCard() {
  const r = S.results, x = S.extra, live = S.live;
  const orgR = r.resplits.org, famR = r.resplits.perFamilyMean;
  return `<div class="card tcard"><div class="ct"><h2>Does the guarantee hold?</h2><div class="r"><button class="btn sm" data-act="live" ${live && live.running ? 'disabled' : ''}><i data-lucide="play"></i>${live && live.running ? 'Running…' : 'Re-split 40 times with these settings'}</button></div></div>
    <div class="cs">Pool the audit and held-out prompts, re-split them at random, tune on one part and measure on the other. Default settings (${pct(r.eps, 0)} limit, ${Math.round((1 - r.delta) * 100)}%), ${r.resplits.B} re-splits, from <code>scripts/report.mjs</code>.</div>
    <div class="valid" style="margin-top:6px">
      <div><div class="l">Uncorrected tuning broke the limit</div><div class="v" style="color:#ff8a8a">${pct(famR.pluginViolation, 0)}<small>per task family, average</small></div></div>
      <div><div class="l">Certified router broke the limit</div><div class="v" style="color:var(--green-t)">${pct(famR.lttViolation, 1)}<small>allowed: ${pct(r.delta, 0)}</small></div></div>
      <div><div class="l">This tab, current settings</div><div class="v" id="liveV">${live && live.res ? `${pct(live.res.lttViolation, 0)} <small>certified vs ${pct(live.res.pluginViolation, 0)} uncorrected · ${live.res.B} re-splits</small>` : '<small>not run yet</small>'}</div></div>
    </div></div>`;
}

// ---------- charts ----------
function niceMax(v) { const steps = [0.04, 0.06, 0.08, 0.1, 0.12, 0.16, 0.2]; return steps.find(s => s >= v) ?? 0.2; }
function frontierSvg() {
  const x = S.extra, c = S.cert, eps = S.settings.eps;
  const W = 640, H = 300, L = 46, R = 16, T = 14, B = 30;
  const ymax = niceMax(Math.max(0.05, eps * 2, x.plugTotal.risk * 1.3));
  const xs = (v) => L + (W - L - R) * v, ys = (v) => T + (H - T - B) * (1 - Math.min(v, ymax) / ymax);
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = ymax * k / 4; g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="ax" x="${L - 8}" y="${ys(v) + 4}" text-anchor="end">${(v * 100).toFixed(0)}%</text>`; }
  for (let k = 0; k <= 4; k++) g += `<text class="ax" x="${xs(k / 4)}" y="${H - 9}" text-anchor="middle">${k * 25}%</text>`;
  const path = (sw) => { const pts = sw.filter(p => p.risk <= ymax * 1.02); return pts.length ? 'M' + pts.map(p => `${xs(p.costRatio).toFixed(1)},${ys(p.risk).toFixed(1)}`).join('L') : ''; };
  const certX = 1 - c.total.savings, certY = c.total.risk, plX = 1 - x.plugTotal.savings, plY = x.plugTotal.risk;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost versus quality loss for every router threshold">
    <defs><clipPath id="fc"><rect x="${L}" y="${T - 2}" width="${W - L - R}" height="${H - T - B + 2}"/></clipPath></defs>
    ${g}
    <line x1="${L}" x2="${W - R}" y1="${ys(eps)}" y2="${ys(eps)}" stroke="#03a97e" stroke-width="1.5" stroke-dasharray="2 3"/>
    <text class="lbl g" x="${L + 6}" y="${ys(eps) - 6}">limit ${(eps * 100).toFixed(1)}%</text>
    <g clip-path="url(#fc)"><path d="${path(x.sweepC)}" fill="none" stroke="#9e9e9e" stroke-width="1.3" stroke-dasharray="5 4"/><path d="${path(x.sweepT)}" fill="none" stroke="#5ca3ff" stroke-width="2"/></g>
    ${x.always.filter(a => a.risk <= ymax).map(a => `<circle cx="${xs(a.costRatio)}" cy="${ys(a.risk)}" r="4" fill="#141414" stroke="#9e9e9e" stroke-width="1.5"/><text class="ax" x="${xs(a.costRatio) + 7}" y="${ys(a.risk) + 4}">always ${esc(a.name)}</text>`).join('')}
    <circle cx="${xs(1)}" cy="${ys(0)}" r="4.5" fill="#141414" stroke="#e0e0e0" stroke-width="1.5"/><text class="ax" x="${xs(1) - 4}" y="${ys(0) - 10}" text-anchor="end">always gpt-4o</text>
    <circle cx="${xs(plX)}" cy="${ys(plY)}" r="5" fill="#141414" stroke="#e8a33a" stroke-width="2"/><text class="lbl a" x="${xs(plX) - 10}" y="${ys(plY) + 18}" text-anchor="end">Uncorrected · ${pct(x.plugTotal.savings, 0)} saved, ${pct(plY)} loss</text>
    <circle cx="${xs(certX)}" cy="${ys(certY)}" r="5.5" fill="#03a97e" stroke="#141414" stroke-width="1.5"/><text class="lbl g" x="${xs(certX) - 10}" y="${ys(certY) + 4}" text-anchor="end">Certified · ${pct(c.total.savings, 0)} saved, ${pct(certY)} loss</text>
    <line id="fHov" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="#555" style="display:none"/>
    <rect id="fRect" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg>`;
}
function spendByModel() {
  const d = S.data, c = S.cert, tot = c.total; const P = d.models.length - 1;
  // spend share by model under the certified policy (held-out prompts)
  const test = indexBy(d, 1); const spend = new Array(d.models.length).fill(0);
  for (const i of test) { const k = route(d, i, S.cert.lambdaFor(d.rows.fam[i]), S.settings.allowed); spend[k] += costOf(d, k, i); }
  const sum = spend.reduce((a, b) => a + b, 0) || 1;
  const off = S.extra.always.filter(a => a.risk > niceMax(Math.max(0.05, S.settings.eps * 2, S.extra.plugTotal.risk * 1.3)));
  return `<div class="sbm"><div class="sbm-h"><span>Spend by model, certified policy</span><span class="muted">${usd(sum)} across ${n0(test.length)} prompts</span></div>
    <div class="sbm-bar">${spend.map((v, k) => v > 0 ? `<span style="width:${(100 * v / sum).toFixed(2)}%;background:${COLORS[k]}"></span>` : '').join('')}</div>
    <div class="sbm-l">${d.models.map((m, k) => `<span><span class="dot" style="background:${COLORS[k]}"></span>${esc(m.name)} <b>${pct(tot.mix[k], 0)}</b> <span class="muted">of requests · ${pct(spend[k] / sum, 0)} of spend</span></span>`).join('')}</div>
    ${off.length ? `<div class="muted" style="font-size:12px;margin-top:8px">Off chart: ${off.map(a => `always ${esc(a.name)} (${pct(a.risk, 0)} loss)`).join(', ')}</div>` : ''}</div>`;
}
function riskSvg(p) {
  const steps = p.steps, eps = S.settings.eps;
  const W = 560, H = 214, L = 46, R = 10, T = 10, B = 40;
  const shown = steps.filter(s => s.lambda >= 0.5);
  const ymax = niceMax(Math.max(eps * 2.5, 0.05));
  const xs = (lam) => L + (W - L - R) * (1 - lam) / 0.5, ys = (v) => T + (H - T - B) * (1 - Math.min(v, ymax) / ymax);
  let g = '';
  for (let k = 0; k <= 4; k++) { const v = ymax * k / 4; g += `<line class="gl" x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}"/><text class="ax" x="${L - 8}" y="${ys(v) + 4}" text-anchor="end">${(v * 100).toFixed(0)}%</text>`; }
  for (const lam of [1, 0.9, 0.8, 0.7, 0.6, 0.5]) g += `<text class="ax" x="${xs(lam)}" y="${H - 22}" text-anchor="middle">${lam.toFixed(1)}</text>`;
  const pr = (key) => { const pts = shown.filter(s => s[key] <= ymax * 1.02); return pts.length ? 'M' + pts.map(s => `${xs(s.lambda).toFixed(1)},${ys(s[key]).toFixed(1)}`).join('L') : ''; };
  const lh = p.lambdaHat, pl = p.plugin;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Audit-set loss and its upper bound by router threshold">
    ${g}<text class="ax" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">router score needed to leave gpt-4o (stricter ← → looser)</text>
    <line x1="${L}" x2="${W - R}" y1="${ys(eps)}" y2="${ys(eps)}" stroke="#03a97e" stroke-width="1.5" stroke-dasharray="2 3"/>
    <path d="${pr('ucb')}" fill="none" stroke="#9e9e9e" stroke-width="1.3" stroke-dasharray="5 4"/>
    <path d="${pr('risk')}" fill="none" stroke="#5ca3ff" stroke-width="2"/>
    ${pl !== null && pl >= 0.5 ? `<line x1="${xs(pl)}" x2="${xs(pl)}" y1="${T}" y2="${H - B}" stroke="#e8a33a" stroke-dasharray="3 3"/><text class="lbl a" x="${xs(pl) + 5}" y="${T + 24}">uncorrected</text>` : ''}
    ${lh !== null && lh >= 0.5 ? `<line x1="${xs(lh)}" x2="${xs(lh)}" y1="${T}" y2="${H - B}" stroke="#03a97e"/><text class="lbl g" x="${xs(lh) - 5}" y="${T + 40}" text-anchor="end">certified</text>` : ''}
  </svg>`;
}

// ---------- other tabs ----------
function renderRules() {
  const d = S.data, pol = S.policy;
  return `<div class="card" style="margin-top:18px">
    <div class="rule"><span class="ico"><i data-lucide="shuffle"></i></span><div><b>Router - automatic</b><span class="d">Picks a model per prompt by your org’s rules</span></div><i data-lucide="check" style="margin-left:auto;color:var(--t2)"></i></div>
    <div class="rule"><span class="ico"><i data-lucide="shield-check"></i></span><div><b>Quality guarantee</b><span class="d">${pol ? `Policy v${pol.version}: ≤ ${pct(pol.eps)} average quality loss vs. gpt-4o at ${Math.round(pol.conf * 100)}% confidence, ${pol.scope === 'org' ? 'org-wide' : 'per task family'} · applied ${esc(pol.at)}` : 'Not applied yet. Set a limit on the Guarantee tab and apply it.'}</span></div>${pol ? '<span class="chip ok" style="margin-left:auto">Active</span>' : '<span class="chip no" style="margin-left:auto">Draft</span>'}</div>
    <div class="rule"><span class="ico"><i data-lucide="box"></i></span><div><b>Eligible models</b><span class="d">${d.models.filter((m, k) => m.premium || S.settings.allowed[k]).map(m => esc(m.name)).join(', ')} · only models approved for the team are considered</span></div></div>
    <div class="rule"><span class="ico"><i data-lucide="route"></i></span><div><b>Thresholds</b><span class="d">${S.cert.policies.map(p => `${p.fam === null ? 'All tasks' : esc(d.families[p.fam])}: ${p.lambdaHat === null ? 'premium only' : p.lambdaHat.toFixed(4)}`).join(' · ')}</span></div></div>
  </div>`;
}
function renderDecisions() {
  const d = S.data;
  const rows = d.samples.filter(s => S.famFilter === null || d.rows.fam[s.i] === S.famFilter);
  const per = 20, pages = Math.max(1, Math.ceil(rows.length / per)), pg = Math.min(S.page, pages - 1);
  return `<div class="tabs-row"><div class="seg">${[[null, 'All'], ...d.families.map((f, j) => [j, f])].map(([v, l]) => `<button data-fam="${v === null ? '' : v}" aria-pressed="${S.famFilter === v}">${esc(l)}</button>`).join('')}</div><span class="muted" style="margin-left:auto;font-size:12.5px">${n0(rows.length)} sampled prompts · current settings</span></div>
  <div class="card">${rows.length ? `<table class="t"><thead><tr><th>Prompt</th><th>Routed to</th><th class="n">Router score</th><th class="n">Judge score</th><th class="n">gpt-4o</th><th class="n">Cost</th></tr></thead><tbody>${rows.slice(pg * per, pg * per + per).map(s => decisionRow(s, S.cert.lambdaFor(d.rows.fam[s.i]))).join('')}</tbody></table>` : '<div class="empty">No sampled prompts in this family.</div>'}
  <div class="ct" style="padding:12px 18px 14px"><span class="muted" style="font-size:12.5px">Page ${pg + 1} of ${pages}</span><div class="r"><button class="btn sm" data-page="-1" ${pg === 0 ? 'disabled' : ''}>Previous</button><button class="btn sm" data-page="1" ${pg >= pages - 1 ? 'disabled' : ''}>Next</button></div></div></div>`;
}

// ---------- interactions ----------
let recomputeT = null;
function recompute() { clearTimeout(recomputeT); recomputeT = setTimeout(() => { compute(); writeHash(); render(); }, 120); }
function bindAfter() {
  const e = $('#eps');
  if (e) e.addEventListener('input', () => { S.settings.eps = +e.value / 100; $('#epsV').textContent = pct(S.settings.eps); saveState(); recompute(); });
  const f = $('#frontier svg');
  if (f) {
    const rect = f.querySelector('#fRect'), line = f.querySelector('#fHov'); let tip = null;
    rect.addEventListener('mousemove', (ev) => {
      const b = f.getBoundingClientRect(); const W = 640, L = 46, R = 16; const xv = ((ev.clientX - b.left) * W / b.width - L) / (W - L - R);
      const sw = S.extra.sweepT; let best = sw[0]; for (const s of sw) if (Math.abs(s.costRatio - xv) < Math.abs(best.costRatio - xv)) best = s;
      const xx = L + (W - L - R) * best.costRatio; line.setAttribute('x1', xx); line.setAttribute('x2', xx); line.style.display = '';
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip); }
      tip.innerHTML = `threshold <b>${best.lambda.toFixed(4)}</b><br>cost ${pct(best.costRatio)} of gpt-4o · loss <b>${pct(best.risk, 2)}</b>`;
      tip.style.left = ev.clientX + 12 + 'px'; tip.style.top = ev.clientY - 12 + 'px';
    });
    rect.addEventListener('mouseleave', () => { line.style.display = 'none'; if (tip) { tip.remove(); tip = null; } });
  }
  // fill the drill-down re-split result asynchronously
  if (S.tab === 'guarantee' && S.task !== null) {
    const p = S.cert.policies.find(x => (x.fam === null ? -1 : x.fam) === S.task);
    if (p) {
      const { eps, conf } = S.settings; const key = `${p.fam}|${eps}|${conf}|${S.settings.allowed.join('')}`;
      if (!S.drillCache.has(key)) setTimeout(() => {
        const d = S.data; const pool = p.fam === null ? [...indexBy(d, 0), ...indexBy(d, 1)] : [...indexBy(d, 0, p.fam), ...indexBy(d, 1, p.fam)];
        const r = resplit(d, pool, { eps, delta: 1 - conf, nCal: p.cal, B: 100, seed: 7 + (p.fam ?? 9), allowed: S.settings.allowed });
        S.drillCache.set(key, r);
        const out = $('#rsOut'); if (out) out.innerHTML = `uncorrected broke the ${pct(eps)} limit in <b>${pct(r.pluginViolation, 0)}</b> of ${r.B}; certified in <b>${pct(r.lttViolation, 0)}</b>`;
      }, 30);
    }
  }
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2200); }
function modal(title, body, foot) { const o = $('#overlay'); o.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="b">${body}</div>${foot ? `<div class="f">${foot}</div>` : ''}</div>`; o.hidden = false; icons(); const b = o.querySelector('.f .primary') || o.querySelector('button'); b && b.focus(); }
function closeModal() { const o = $('#overlay'); o.hidden = true; o.innerHTML = ''; }
function applyModal() {
  const c = S.cert, d = S.data, { eps, conf, scope } = S.settings;
  modal('Apply router policy', `Route with ${scope === 'org' ? 'one org-wide threshold' : 'a threshold per task family'}: ${c.policies.map(p => `${p.fam === null ? 'all tasks' : esc(d.families[p.fam])} ${p.lambdaHat === null ? 'premium only' : p.lambdaHat.toFixed(4)}`).join(', ')}.<br><br>Guarantee: average quality loss vs. gpt-4o ≤ <b style="color:var(--t1)">${pct(eps)}</b> with ${Math.round(conf * 100)}% confidence for traffic like the audit set. Held-out estimate: <b style="color:var(--t1)">${pct(c.total.savings)}</b> saved, ${pct(c.total.risk, 2)} loss.`, `<button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="confirm-apply">Apply policy</button>`);
}
function doApply() {
  const c = S.cert, { eps, conf, scope } = S.settings;
  const at = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date());
  S.policy = { version: (S.policy?.version ?? 1) + 1, eps, conf, scope, at, allowed: S.settings.allowed.slice(), thresholds: c.policies.map(p => ({ family: p.fam === null ? 'all' : S.data.families[p.fam], lambda: p.lambdaHat })), savings: round(c.total.savings), risk: round(c.total.risk) };
  saveState(); closeModal(); render(); toast(`Policy v${S.policy.version} applied`);
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400); }
function exportMenu() {
  modal('Export', 'Download the certified policy (thresholds, guarantee, held-out results) or the per-task table.', `<button class="btn" data-act="close">Cancel</button><button class="btn" data-act="csv">Per-task CSV</button><button class="btn primary" data-act="json">Policy JSON</button>`);
}
function exportJSON() {
  const c = S.cert, d = S.data, { eps, conf, scope } = S.settings;
  const out = { generatedAt: new Date().toISOString(), data: d.meta.source, guarantee: { maxQualityLoss: eps, confidence: conf, method: 'Learn-then-Test, Hoeffding-Bentkus p-values, fixed-sequence', scope }, premium: d.models.at(-1).name, eligible: d.models.filter((m, k) => !m.premium && S.settings.allowed[k]).map(m => m.name), policies: c.policies.map(p => ({ family: p.fam === null ? 'all' : d.families[p.fam], threshold: p.lambdaHat, auditPrompts: p.cal, heldOut: { prompts: p.test, savings: round(p.testEval.savings), qualityLoss: round(p.testEval.risk), offPremium: round(p.testEval.offPremium) }, uncorrected: { threshold: p.plugin, heldOutLoss: p.pluginTest ? round(p.pluginTest.risk) : null } })), total: { savings: round(c.total.savings), qualityLoss: round(c.total.risk), offPremium: round(c.total.offPremium) } };
  download('router-policy.json', JSON.stringify(out, null, 2), 'application/json'); closeModal(); toast('Exported policy JSON');
}
function exportCSV() {
  const c = S.cert, d = S.data;
  const rows = [['family', 'threshold', 'audit_prompts', 'heldout_prompts', 'off_premium', 'savings', 'heldout_quality_loss', 'uncorrected_threshold', 'uncorrected_heldout_loss']];
  for (const p of c.policies) rows.push([p.fam === null ? 'all' : d.families[p.fam], p.lambdaHat ?? '', p.cal, p.test, round(p.testEval.offPremium), round(p.testEval.savings), round(p.testEval.risk), p.plugin ?? '', p.pluginTest ? round(p.pluginTest.risk) : '']);
  download('router-guarantee-by-task.csv', rows.map(r => r.map(v => /[,"]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v).join(',')).join('\n'), 'text/csv'); closeModal(); toast('Exported CSV');
}
function liveRun() {
  if (S.live && S.live.running) return;
  S.live = { running: true }; render();
  setTimeout(() => {
    const d = S.data, { eps, conf } = S.settings;
    const pool = [...indexBy(d, 0), ...indexBy(d, 1)];
    const r = resplit(d, pool, { eps, delta: 1 - conf, nCal: indexBy(d, 0).length, B: 40, seed: Date.now() & 0xffff, allowed: S.settings.allowed });
    S.live = { running: false, res: r }; render(); toast('40 re-splits done in your browser (org-wide threshold)');
  }, 40);
}

document.addEventListener('click', (e) => {
  const t = e.target;
  const st = t.closest('[data-static]'); if (st) { e.preventDefault(); toast('Only Model router is part of this concept demo'); return; }
  const tab = t.closest('[data-tab]'); if (tab) { S.tab = tab.dataset.tab; writeHash(false); render(); return; }
  const cf = t.closest('[data-conf]'); if (cf) { S.settings.conf = +cf.dataset.conf; saveState(); compute(); writeHash(); render(); return; }
  const sc = t.closest('[data-scope]'); if (sc) { S.settings.scope = sc.dataset.scope; S.task = null; saveState(); compute(); writeHash(); render(); return; }
  const al = t.closest('[data-allow]'); if (al) { const k = +al.dataset.allow; S.settings.allowed[k] = !S.settings.allowed[k]; saveState(); compute(); writeHash(); render(); toast(`${S.data.models[k].name} ${S.settings.allowed[k] ? 'allowed' : 'excluded'}`); return; }
  const tr = t.closest('tr[data-task]'); if (tr) { const k = +tr.dataset.task; S.task = S.task === k ? null : k; writeHash(); render(); return; }
  const fm = t.closest('[data-fam]'); if (fm) { S.famFilter = fm.dataset.fam === '' ? null : +fm.dataset.fam; S.page = 0; render(); return; }
  const pg = t.closest('[data-page]'); if (pg) { S.page = Math.max(0, S.page + +pg.dataset.page); render(); return; }
  const a = t.closest('[data-act]');
  if (a) { const k = a.dataset.act; if (k === 'apply') applyModal(); else if (k === 'confirm-apply') doApply(); else if (k === 'close') closeModal(); else if (k === 'export') exportMenu(); else if (k === 'json') exportJSON(); else if (k === 'csv') exportCSV(); else if (k === 'live') liveRun(); return; }
});
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay') closeModal(); });
$('#sideToggle').addEventListener('click', () => $('#app').classList.toggle('collapsed'));
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.key === 'Escape') { if (!$('#overlay').hidden) closeModal(); else if (S.task !== null) { S.task = null; writeHash(); render(); } return; }
  if (!$('#overlay').hidden) return;
  if (e.key === '?') { modal('Keyboard shortcuts', `<div class="keys"><kbd>1</kbd><span>Guarantee</span><kbd>2</kbd><span>Rules</span><kbd>3</kbd><span>Decisions</span><kbd>[</kbd><span>Lower the quality-loss limit by 0.5%</span><kbd>]</kbd><span>Raise it by 0.5%</span><kbd>j</kbd><span>Next task family</span><kbd>k</kbd><span>Previous task family</span><kbd>a</kbd><span>Apply policy</span><kbd>e</kbd><span>Export</span><kbd>Esc</kbd><span>Close</span></div>`, '<button class="btn primary" data-act="close">Done</button>'); return; }
  if (['1', '2', '3'].includes(e.key)) { S.tab = ['guarantee', 'rules', 'decisions'][+e.key - 1]; writeHash(false); render(); return; }
  if (e.key === '[' || e.key === ']') { S.settings.eps = Math.min(0.08, Math.max(0.005, +(S.settings.eps + (e.key === ']' ? 0.005 : -0.005)).toFixed(3))); saveState(); compute(); writeHash(); render(); return; }
  if (e.key === 'a') { applyModal(); return; }
  if (e.key === 'e') { exportMenu(); return; }
  if ((e.key === 'j' || e.key === 'k') && S.tab === 'guarantee') {
    const keys = S.cert.policies.map(p => p.fam === null ? -1 : p.fam); let i = keys.indexOf(S.task);
    i = e.key === 'j' ? Math.min(keys.length - 1, i + 1) : Math.max(0, i - 1); S.task = keys[i]; writeHash(); render(); return;
  }
  if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-task]')) e.target.click();
});
window.addEventListener('hashchange', () => { parseHash(); compute(); render(); });

async function boot() {
  loadState();
  icons();
  try {
    const [d, r] = await Promise.all(['data/router.json', 'results/results.json'].map(u => fetch(u).then(x => { if (!x.ok) throw new Error(`${u}: HTTP ${x.status}`); return x.json(); })));
    S.data = d; S.results = r;
    if (!S.settings.allowed || S.settings.allowed.length !== d.models.length - 1) S.settings.allowed = defaultAllowed(d);
    parseHash(); compute(); writeHash(); render();
  } catch (err) {
    $('#main').innerHTML = `<div class="err" role="alert"><h2>Couldn’t load router data</h2><p>${esc(err.message)}. Serve the folder over HTTP (for example <code>python3 -m http.server</code>).</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
}
boot();
