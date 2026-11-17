// AI route, step 2 (2026-11-11): can a model trained on the tracker's records pick better tokens than the hand-written rules?
// Joins research/labels.jsonl (what a paper trade earned: target hit within 1h, else the 1h price, after costs) with the tracker's
// features, trains gradient-boosted regression trees on the earlier days and tests on the latest days it has never seen.
// Head to head on the test days, one position at a time per policy (same 15-min sightings, 1h limit, costs):
//   rules  = today's cheap checks + pre-score >= minScore (safety, 15-min and cost checks aren't in the records, so this flatters the rules a little)
//   model  = the highest predicted return among that run's sightings, if above a threshold picked on the training days
//   random = any sighting, as a floor
//   node research/train.js [c|a]     c = Conservative (+13.93%), a = Aggressive (+20%); default c
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const e = cfg.compounder.entry;
const target = process.argv[2] === 'a' ? 'a' : 'c';
const lines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// --- data ---------------------------------------------------------------------------------------
const labels = new Map(lines(path.join(ROOT, 'research', 'labels.jsonl')).filter((l) => l[target]).map((l) => [`${l.mint}|${l.t}`, l]));
const rows = fs
  .readdirSync(path.join(ROOT, 'data'))
  .filter((f) => /^candidate-outcomes-\d{4}-\d{2}\.jsonl$/.test(f))
  .flatMap((f) => lines(path.join(ROOT, 'data', f)))
  .map((r) => ({ ...r, label: labels.get(`${r.mint}|${r.t}`) }))
  .filter((r) => r.label && r.label.candles > 0)
  .map((r) => ({ ...r, ret: r.label[target].ret, hit: r.label[target].hit }))
  .sort((x, y) => Date.parse(x.t) - Date.parse(y.t));

const log10 = (x) => (x > 0 ? Math.log10(x) : NaN);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
const FEATURES = {
  ageH: (r) => num(r.ageH),
  logLiq: (r) => log10(r.liqUsd),
  logMcap: (r) => log10(r.mcapUsd),
  liqToMcap: (r) => num(r.liqUsd / r.mcapUsd),
  logVolH1: (r) => log10(r.volH1),
  logBuysH1: (r) => log10(r.buysH1),
  ratioH1: (r) => num(r.ratioH1),
  ratioH6: (r) => num(r.ratioH6),
  accel: (r) => num(r.accel),
  chgM5: (r) => num(r.chgM5),
  logTxnsM5: (r) => log10((r.buysM5 ?? 0) + (r.sellsM5 ?? 0) + 1),
  ratioM5: (r) => num((r.buysM5 ?? NaN) / Math.max(r.sellsM5 ?? 0, 1)),
  chgH1: (r) => num(r.chgH1),
  chgH6: (r) => num(r.chgH6),
  liqGrowth: (r) => num(r.liqGrowth),
  graduated: (r) => (/Graduated/.test(r.list) ? 1 : 0),
  trending: (r) => (/Trending/.test(r.list) ? 1 : 0),
  jupiter: (r) => (/Jupiter/.test(r.list) ? 1 : 0),
  dexscreener: (r) => (/DexScreener/.test(r.list) ? 1 : 0),
  hourUtc: (r) => new Date(r.t).getUTCHours(),
};
const names = Object.keys(FEATURES);
const X = rows.map((r) => names.map((n) => FEATURES[n](r)));

// --- today's rules, recomputed from the recorded numbers ---------------------------------------
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
function rulesPass(r) {
  if (r.liqUsd < Math.max(e.minLiquidityUsd, e.minLiquidityMultipleOfPosition * (target === 'c' ? 110 : 25))) return false;
  if (r.mcapUsd < e.minMarketCapUsd || (r.liqUsd / r.mcapUsd) * 100 < e.minLiqToMcapPct) return false;
  if (r.volH1 < e.minVolumeH1Usd || r.buysH1 < e.minBuysH1 || r.ratioH1 < e.minBuySellRatioH1 || r.ratioH6 < e.minBuySellRatioH6) return false;
  if (Math.max(r.ratioH1, r.ratioH6) > e.maxBuySellRatio || (r.accel != null && r.accel < e.minVolumeAcceleration)) return false;
  if (r.chgH1 < e.minChgH1Pct || r.chgH1 > e.maxChgH1Pct || r.chgH6 < e.minChgH6Pct || r.chgH6 > e.maxChgH6Pct) return false;
  if (r.liqGrowth != null && r.liqGrowth * 100 < e.minLiquidityGrowthPct) return false;
  const pre =
    15 * clamp01(Math.log2(r.accel) / 2) + 30 * clamp01(r.ratioH1 - 1) + 15 * clamp01((r.ratioH6 - 1) / 0.5) +
    10 * clamp01((r.liqGrowth ?? 0) / 0.25) + 15 * clamp01(r.chgH1 / 10) - (r.mcapUsd >= e.largeMcapUsd ? e.largeMcapPenalty : 0);
  r.preScore = pre;
  return pre >= e.minScore - 15; // the 15-min volume bonus (up to 15) isn't in the records, so give the rules its full benefit
}

// --- gradient-boosted regression trees (squared error, depth-limited, missing values learn their side) --------------------
const CLIP = [-60, 20]; // a -95% rug and a -60% one end a run alike; clipping keeps one crash from dominating the fit
const clip = (y) => Math.max(CLIP[0], Math.min(CLIP[1], y));

function thresholds(col) {
  const v = col.filter(Number.isFinite).sort((a, b) => a - b);
  const out = new Set();
  for (let q = 1; q < 32; q++) out.add(v[Math.floor((q / 32) * v.length)]);
  return [...out].filter((x) => x !== undefined);
}

function buildTree(Xs, g, idx, depth, opt, cuts) {
  const mean = idx.reduce((s, i) => s + g[i], 0) / idx.length;
  if (depth === 0 || idx.length < 2 * opt.minLeaf) return { leaf: mean };
  let best = null;
  const total = idx.reduce((s, i) => s + g[i], 0);
  for (let f = 0; f < names.length; f++) {
    const miss = idx.filter((i) => !Number.isFinite(Xs[i][f]));
    const has = idx.filter((i) => Number.isFinite(Xs[i][f]));
    const missSum = miss.reduce((s, i) => s + g[i], 0);
    for (const th of cuts[f]) {
      let lS = 0, lN = 0;
      for (const i of has) if (Xs[i][f] <= th) (lS += g[i]), lN++;
      for (const missLeft of [true, false]) {
        const L = lS + (missLeft ? missSum : 0), Ln = lN + (missLeft ? miss.length : 0);
        const R = total - L, Rn = idx.length - Ln;
        if (Ln < opt.minLeaf || Rn < opt.minLeaf) continue;
        const gain = (L * L) / Ln + (R * R) / Rn - (total * total) / idx.length;
        if (!best || gain > best.gain) best = { gain, f, th, missLeft };
      }
    }
  }
  if (!best || best.gain <= 0) return { leaf: mean };
  const goLeft = (i) => (Number.isFinite(Xs[i][best.f]) ? Xs[i][best.f] <= best.th : best.missLeft);
  return {
    f: best.f, th: best.th, missLeft: best.missLeft,
    l: buildTree(Xs, g, idx.filter(goLeft), depth - 1, opt, cuts),
    r: buildTree(Xs, g, idx.filter((i) => !goLeft(i)), depth - 1, opt, cuts),
  };
}
const predictTree = (t, x) => ('leaf' in t ? t.leaf : (Number.isFinite(x[t.f]) ? x[t.f] <= t.th : t.missLeft) ? predictTree(t.l, x) : predictTree(t.r, x));

function train(idx, opt = { trees: 300, depth: 3, lr: 0.03, minLeaf: 40, subsample: 0.7 }) {
  const y = idx.map((i) => clip(rows[i].ret));
  const base = y.reduce((s, v) => s + v, 0) / y.length;
  const Xs = idx.map((i) => X[i]);
  const cuts = names.map((_, f) => thresholds(Xs.map((x) => x[f])));
  const pred = new Array(idx.length).fill(base);
  const trees = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < opt.trees; k++) {
    const g = y.map((v, j) => v - pred[j]);
    const sample = [...idx.keys()].filter(() => rand() < opt.subsample);
    const t = buildTree(Xs, g, sample, opt.depth, opt, cuts);
    trees.push(t);
    for (let j = 0; j < idx.length; j++) pred[j] += opt.lr * predictTree(t, Xs[j]);
  }
  return { base, trees, lr: opt.lr, predict: (x) => trees.reduce((s, t) => s + opt.lr * predictTree(t, x), base) };
}

// --- evaluation ------------------------------------------------------------------------------------
// One position at a time: at each sighting time, if in cash, the policy may buy one of that time's sightings; it is busy until
// the sale (hit minute, else 1h) plus the 15-min run cadence. Returns trades and compounded bankroll.
function simulate(idxs, choose) {
  const byTime = new Map();
  for (const i of idxs) (byTime.get(rows[i].t) ?? byTime.set(rows[i].t, []).get(rows[i].t)).push(i);
  let busyUntil = 0, bank = 1;
  const trades = [];
  for (const [t, group] of [...byTime].sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]))) {
    if (Date.parse(t) < busyUntil) continue;
    const i = choose(group);
    if (i == null) continue;
    const r = rows[i];
    trades.push(r.ret);
    bank *= 1 + r.ret / 100;
    busyUntil = Date.parse(t) + ((r.label[target].hitMin ?? 60) + 3 + 15) * 60e3;
  }
  return { n: trades.length, hit: trades.filter((v) => v >= (target === 'c' ? 13.9 : 19.9)).length, avg: trades.reduce((s, v) => s + v, 0) / (trades.length || 1), crash: trades.filter((v) => v <= -30).length, bank };
}
const fmt = (s) => `${String(s.n).padStart(4)} trades · hit ${String(Math.round((100 * s.hit) / (s.n || 1))).padStart(3)}% · avg ${s.avg.toFixed(2).padStart(6)}% · ≤-30%: ${String(s.crash).padStart(3)} · $100 → $${(100 * s.bank).toFixed(0)}`;

const cutAt = Math.floor(rows.length * 0.7);
const trainIdx = [...Array(cutAt).keys()];
const testIdx = [...Array(rows.length - cutAt).keys()].map((i) => i + cutAt);
const days = (idx) => `${rows[idx[0]].t.slice(0, 10)} → ${rows[idx.at(-1)].t.slice(0, 10)}`;
console.log(`target ${target === 'c' ? '+13.93% (Conservative)' : '+20% (Aggressive)'} · ${rows.length} labelled sightings · train ${trainIdx.length} (${days(trainIdx)}) · test ${testIdx.length} (${days(testIdx)})`);

// Threshold for the model chosen on the training days only: fit on the first 70% of them, pick the best cut on the rest.
const inner = Math.floor(trainIdx.length * 0.7);
const m0 = train(trainIdx.slice(0, inner));
const val = trainIdx.slice(inner);
let theta = 0, bestBank = -Infinity;
for (const th of [-4, -2, -1, 0, 1, 2, 3, 4, 6]) {
  const s = simulate(val, (g) => { const b = g.map((i) => [i, m0.predict(X[i])]).sort((a, b) => b[1] - a[1])[0]; return b[1] > th ? b[0] : null; });
  if (s.n >= 5 && s.bank > bestBank) (bestBank = s.bank), (theta = th);
}
const model = train(trainIdx);
const p = new Map(testIdx.map((i) => [i, model.predict(X[i])]));

// Ranking quality on unseen days: do higher predictions mean better outcomes?
const sorted = [...testIdx].sort((a, b) => p.get(b) - p.get(a));
const fifth = Math.floor(sorted.length / 5);
console.log('\nTest days, all sightings by predicted return (fifths, best first):');
for (let q = 0; q < 5; q++) {
  const s = sorted.slice(q * fifth, (q + 1) * fifth);
  console.log(`  ${q + 1}: avg real return ${(s.reduce((a, i) => a + rows[i].ret, 0) / s.length).toFixed(2).padStart(6)}% · hit ${Math.round((100 * s.filter((i) => rows[i].hit).length) / s.length)}% · ≤-30% ${Math.round((100 * s.filter((i) => rows[i].ret <= -30).length) / s.length)}%`);
}

let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
console.log(`\nHead to head on the test days (model threshold ${theta}% chosen on training days):`);
console.log(`  rules : ${fmt(simulate(testIdx, (g) => { const ok = g.filter((i) => rulesPass(rows[i])).sort((a, b) => rows[b].preScore - rows[a].preScore); return ok[0] ?? null; }))}`);
console.log(`  model : ${fmt(simulate(testIdx, (g) => { const b = g.map((i) => [i, p.get(i)]).sort((a, b) => b[1] - a[1])[0]; return b[1] > theta ? b[0] : null; }))}`);
console.log(`  random: ${fmt(simulate(testIdx, (g) => g[Math.floor(rand() * g.length)]))}`);

// What the model leans on: total split gain per feature is not tracked, so count how often each feature is used near the root.
const use = new Map();
const walk = (t, d) => { if ('leaf' in t) return; use.set(names[t.f], (use.get(names[t.f]) ?? 0) + 1 / (d + 1)); walk(t.l, d + 1); walk(t.r, d + 1); };
for (const t of model.trees) walk(t, 0);
console.log('\nFeatures the model leans on most:', [...use].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, v]) => `${n} ${v.toFixed(0)}`).join(', '));
