// Candidate outcome tracker (since 2026-10-28, user request): every token a Compounder run evaluates inside its age window,
// bought or rejected (with the reason), is re-priced 15 and 60 minutes later (config compounder.outcomes.afterMinutes), so the
// entry rules and crash filters can be judged on the current sources. Pending tokens live in data/outcomes-pending.json;
// a token whose horizons are all recorded is appended to data/candidate-outcomes.jsonl. Prices come from DexScreener
// (30 tokens per call), at the first run after each horizon; `min` is the real time elapsed, which can be late if runs were missed.

const round = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(d) : x ?? null);
const FIELDS = ['symbol', 'mint', 'pairAddress', 'ageH', 'score', 'priceUsd', 'liqUsd', 'mcapUsd', 'volH1', 'buysH1', 'ratioH1', 'ratioH6', 'accel',
  'chgM5', 'buysM5', 'sellsM5', 'chgH1', 'chgH6', 'chg15', 'volTrend', 'liqGrowth', 'holders', 'top10Pct', 'devPct', 'reason'];

// Adds this run's evaluated rows (one variant) unless the token was already tracked within trackEveryHours.
export function trackNew(state, rows, { variant, bestMint, nowMs, cfg }) {
  const o = cfg.compounder.outcomes;
  state.pending ??= [];
  state.lastTracked ??= {};
  for (const [mint, t] of Object.entries(state.lastTracked)) if (nowMs - t > o.trackEveryHours * 3600e3) delete state.lastTracked[mint];
  for (const r of rows) {
    if (r.priceUsd == null || state.lastTracked[r.mint]) continue;
    state.lastTracked[r.mint] = nowMs;
    const row = Object.fromEntries(FIELDS.map((f) => [f, r[f] ?? null]));
    state.pending.push({ t: new Date(nowMs).toISOString(), variant, list: r.sources.join(' + '), bought: r.mint === bestMint, ...row, after: {} });
  }
}

export const dueMints = (state, nowMs, cfg) =>
  [...new Set((state.pending ?? []).filter((p) => cfg.compounder.outcomes.afterMinutes.some((m) => !p.after[m] && nowMs - Date.parse(p.t) >= m * 60e3)).map((p) => p.mint))];

// Records each due horizon from `pairs` (mint -> DexScreener pair) and returns the tokens that are complete (removed from pending).
export function recordDue(state, pairs, nowMs, cfg) {
  const done = [];
  for (const p of state.pending ?? []) {
    for (const m of cfg.compounder.outcomes.afterMinutes) {
      const elapsed = (nowMs - Date.parse(p.t)) / 60e3;
      if (p.after[m] || elapsed < m) continue;
      const price = Number(pairs.get(p.mint)?.priceUsd);
      p.after[m] = Number.isFinite(price) && price > 0
        ? { min: Math.round(elapsed), priceUsd: price, pct: round((price / p.priceUsd - 1) * 100, 1) }
        : { min: Math.round(elapsed), priceUsd: null, pct: null, note: 'no DexScreener pair' };
    }
    if (cfg.compounder.outcomes.afterMinutes.every((m) => p.after[m])) done.push(p);
  }
  state.pending = (state.pending ?? []).filter((p) => !done.includes(p));
  return done;
}
