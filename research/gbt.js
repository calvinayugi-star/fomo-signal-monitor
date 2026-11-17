// Gradient-boosted trees for yes/no outcomes (logistic loss), histogram-based so a few hundred thousand rows train in seconds
// in plain Node. Features are binned into quantiles once; missing values (NaN) get their own bin and learn which side to go.
// Used by research/direction-study.js (2026-11-17). fit() returns { predict(row), importance } where row is an array of numbers.

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function quantileCuts(values, bins) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const cuts = [];
  for (let q = 1; q < bins; q++) {
    const c = v[Math.floor((q / bins) * v.length)];
    if (c !== undefined && c !== cuts.at(-1)) cuts.push(c);
  }
  return cuts;
}
// Bin 0 = missing, 1..cuts.length+1 = quantile bins.
function binOf(x, cuts) {
  if (!Number.isFinite(x)) return 0;
  let lo = 0, hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x <= cuts[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo + 1;
}

// X: rows (arrays of numbers, NaN = missing), y: 0/1. names: feature names (for importance).
export function fit(X, y, names, { trees = 250, depth = 4, lr = 0.05, minLeaf = 300, lambda = 1, subsample = 0.5, bins = 32, seed = 7 } = {}) {
  const n = X.length, F = names.length;
  const cuts = names.map((_, f) => quantileCuts(X.map((r) => r[f]), bins));
  const nb = cuts.map((c) => c.length + 2);
  const binned = names.map((_, f) => Uint8Array.from(X, (r) => binOf(r[f], cuts[f])));
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const base = Math.log(mean / (1 - mean));
  const Fx = new Float64Array(n).fill(base);
  const g = new Float64Array(n), h = new Float64Array(n);
  const importance = new Float64Array(F);
  const forest = [];
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);

  function grow(idx, d) {
    let G = 0, H = 0;
    for (const i of idx) (G += g[i]), (H += h[i]);
    const leaf = { leaf: -G / (H + lambda) };
    if (d === depth || idx.length < 2 * minLeaf) return leaf;
    const parent = (G * G) / (H + lambda);
    let best = null;
    for (let f = 0; f < F; f++) {
      const B = nb[f], col = binned[f];
      const hg = new Float64Array(B), hh = new Float64Array(B), hn = new Int32Array(B);
      for (const i of idx) {
        const b = col[i];
        hg[b] += g[i];
        hh[b] += h[i];
        hn[b]++;
      }
      let gl = 0, hl = 0, nl = 0;
      for (let t = 1; t < B - 1; t++) {
        gl += hg[t];
        hl += hh[t];
        nl += hn[t];
        for (const missLeft of [true, false]) {
          const GL = gl + (missLeft ? hg[0] : 0), HL = hl + (missLeft ? hh[0] : 0), NL = nl + (missLeft ? hn[0] : 0);
          const GR = G - GL, HR = H - HL, NR = idx.length - NL;
          if (NL < minLeaf || NR < minLeaf) continue;
          const gain = (GL * GL) / (HL + lambda) + (GR * GR) / (HR + lambda) - parent;
          if (!best || gain > best.gain) best = { gain, f, t, missLeft };
        }
      }
    }
    if (!best || best.gain <= 1e-9) return leaf;
    importance[best.f] += best.gain;
    const col = binned[best.f];
    const goLeft = (i) => (col[i] === 0 ? best.missLeft : col[i] <= best.t);
    const L = [], R = [];
    for (const i of idx) (goLeft(i) ? L : R).push(i);
    return { f: best.f, t: best.t, missLeft: best.missLeft, l: grow(L, d + 1), r: grow(R, d + 1) };
  }
  const walkBins = (node, i) => ('leaf' in node ? node.leaf : walkBins((binned[node.f][i] === 0 ? node.missLeft : binned[node.f][i] <= node.t) ? node.l : node.r, i));

  for (let k = 0; k < trees; k++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(Fx[i]);
      g[i] = p - y[i];
      h[i] = Math.max(p * (1 - p), 1e-6);
    }
    const sample = [];
    for (let i = 0; i < n; i++) if (rand() < subsample) sample.push(i);
    const tree = grow(sample, 0);
    forest.push(tree);
    for (let i = 0; i < n; i++) Fx[i] += lr * walkBins(tree, i);
  }

  const walk = (node, row) => {
    if ('leaf' in node) return node.leaf;
    const b = binOf(row[node.f], cuts[node.f]);
    return walk((b === 0 ? node.missLeft : b <= node.t) ? node.l : node.r, row);
  };
  const total = importance.reduce((a, b) => a + b, 0) || 1;
  return {
    predict: (row) => sigmoid(forest.reduce((z, t) => z + lr * walk(t, row), base)),
    importance: names.map((nm, f) => [nm, importance[f] / total]).sort((a, b) => b[1] - a[1]),
  };
}
