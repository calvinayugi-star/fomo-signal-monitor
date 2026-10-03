// Reruns the logged Compounder hours with other settings, on 1-minute candles:
//   node src/compounder-replay.js [--run 2026-10]
// Uses every candidate logged in data/compounder-hourly.jsonl that passed the checks needing no extra
// API calls (and didn't fail safety/cost when checked). For each combination of 1h floor, stop, target
// and trailing give-back it reports:
//   - per trade: every eligible token traded on its own at $100 (first signal per token per day)
//   - as a run: compounding from the seed, one position at a time, max entries a day, best score first
// Simplifications: deeper checks (15-min trend, volume trend) only exist for tokens the hourly run
// examined; tokens without a quote assume costs.replayAssumedDexRoundTripPct; liquidity limits
// are not re-applied as the simulated bankroll grows. Candles are cached in .cache/replay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minuteCandles } from './compounder.js';
import { openPosition, findFill, replayExit } from './compounder-sim.js';
import { makeTime } from './time.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG ?? path.join(ROOT, 'config.json'), 'utf8'));
const k = cfg.compounder;
const time = makeTime(cfg.displayTimezone);
const runArg = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : null;
const DATA = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const OUT = path.join(process.env.DATA_DIR ? DATA : ROOT, 'COMPOUNDER-REPLAY.md');
const CACHE = path.join(path.resolve(process.env.CACHE_DIR ?? path.join(ROOT, '.cache')), 'replay');
const HOUR = 3600e3;
const NOW = Date.now();

const GRID = {
  floor: [5, 10, 15, 20],
  stop: [3, 4, 5, 6, 8],
  target: [6, 10, 15, 20],
  giveBack: [25, 40, 50],
};
const CURRENT = { floor: k.momentum.minChgH1Pct, stop: k.exits.stopNetPct, target: k.exits.targetNetPct, giveBack: k.exits.trailGiveBackPct };
for (const [key, v] of Object.entries(CURRENT)) if (!GRID[key].includes(v)) GRID[key] = [...GRID[key], v].sort((x, y) => x - y);

// --- load logged signals -------------------------------------------------------------------------
const hours = fs
  .readFileSync(path.join(DATA, 'compounder-hourly.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((h) => !runArg || h.run === runArg);

const events = [];
for (const h of hours) {
  const t = Date.parse(h.t);
  for (const r of h.candidates ?? []) {
    if (r.unsafe || (r.otherFail && r.otherFail !== 'already traded today')) continue;
    if (t + k.exits.maxHoldHours * HOUR > NOW) continue; // outcome not known yet
    events.push({ ...r, t, day: time.localDate(new Date(t)), score: r.score ?? Math.min(r.chgH1, k.momentum.maxChgH1Pct) * Math.min(r.volTrend ?? 1, 3) });
  }
}
if (!events.length) {
  console.log(`No completed signals yet in ${hours.length} logged hours (each needs ${k.exits.maxHoldHours}h of follow-up).`);
  process.exit(0);
}

// --- candles (cached per pool) -------------------------------------------------------------------
fs.mkdirSync(CACHE, { recursive: true });
const byPair = new Map();
for (const e of events) (byPair.get(e.pairAddress) ?? byPair.set(e.pairAddress, []).get(e.pairAddress)).push(e);
const candlesOf = new Map();
let fetched = 0;
for (const [pair, evs] of byPair) {
  const from = Math.min(...evs.map((e) => e.t)) - 10 * 60e3;
  const to = Math.min(NOW, Math.max(...evs.map((e) => e.t)) + (k.exits.maxHoldHours + 1) * HOUR);
  const file = path.join(CACHE, `${pair}.json`);
  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* not cached */
  }
  if (cached && cached.from <= from && cached.to >= to) {
    candlesOf.set(pair, cached.candles);
    continue;
  }
  try {
    const pages = Math.ceil((to - from) / 60e3 / 1000) + 1;
    const candles = await minuteCandles(pair, evs[0].mint, from, to, pages);
    fs.writeFileSync(file, JSON.stringify({ from, to, candles }));
    candlesOf.set(pair, candles);
    fetched++;
    if (fetched % 10 === 0) console.log(`Candles fetched: ${fetched} of ${byPair.size} pools`);
  } catch (e) {
    console.error(`\n${evs[0].symbol}: ${e.message}`);
  }
}

// --- simulation ----------------------------------------------------------------------------------
function simulate(e, sizeUsd, set) {
  const candles = candlesOf.get(e.pairAddress);
  if (!candles?.length) return null;
  const fillAt = e.t + k.exits.fillDelayMinutes * 60e3;
  const fill = findFill(candles, fillAt);
  if (!fill) return null;
  const dex = e.dexRoundTripPct ?? k.costs.replayAssumedDexRoundTripPct;
  const p = openPosition({ sizeUsd, rawEntry: fill.rawPrice, dexRoundTripPct: dex, costs: cfg.costs });
  const rules = { ...k.exits, stopNetPct: set.stop, targetNetPct: set.target, trailGiveBackPct: set.giveBack, lockNetPct: Math.min(k.exits.lockNetPct, set.target * 0.6) };
  const res = replayExit(p, candles.filter((c) => c[0] > fill.fillCandleT), rules, cfg.costs, { fillAt, now: NOW });
  return res.closed ? res : null;
}

const eligible = (e, set) => e.chgH1 >= set.floor;

function perTrade(set) {
  const seen = new Set();
  const out = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (!eligible(e, set) || seen.has(`${e.mint}|${e.day}`)) continue;
    seen.add(`${e.mint}|${e.day}`);
    const r = simulate(e, 100, set);
    if (r) out.push(r.netPct);
  }
  const wins = out.filter((x) => x > 0);
  return { n: out.length, winRate: out.length ? (wins.length / out.length) * 100 : null, avgNet: out.length ? out.reduce((s, x) => s + x, 0) / out.length : null };
}

function asRun(set) {
  const hoursMap = new Map();
  for (const e of events) (hoursMap.get(e.t) ?? hoursMap.set(e.t, []).get(e.t)).push(e);
  let bankroll = k.seedUsd;
  let busyUntil = 0;
  const entries = {};
  const traded = new Set();
  let n = 0;
  let wins = 0;
  for (const [t, evs] of [...hoursMap].sort((a, b) => a[0] - b[0])) {
    if (t < busyUntil || bankroll >= k.targetUsd || bankroll < k.bustBelowUsd) continue;
    const day = evs[0].day;
    if ((entries[day] ?? 0) >= k.daily.maxEntries) continue;
    const pick = evs.filter((e) => eligible(e, set) && !traded.has(`${e.mint}|${day}`)).sort((a, b) => b.score - a.score)[0];
    if (!pick) continue;
    const r = simulate(pick, bankroll, set);
    if (!r) continue;
    entries[day] = (entries[day] ?? 0) + 1;
    traded.add(`${pick.mint}|${day}`);
    bankroll += r.netUsd;
    busyUntil = r.exitAt;
    n++;
    if (r.netUsd > 0) wins++;
  }
  return { final: bankroll, n, winRate: n ? (wins / n) * 100 : null };
}

const combos = [];
for (const floor of GRID.floor)
  for (const stop of GRID.stop)
    for (const target of GRID.target)
      for (const giveBack of GRID.giveBack) {
        const set = { floor, stop, target, giveBack };
        combos.push({ set, trade: perTrade(set), run: asRun(set) });
      }

// --- report --------------------------------------------------------------------------------------
const f = (x, d = 1, s = '') => (x == null ? 'n/a' : `${x.toFixed(d)}${s}`);
const sf = (x) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);
const label = (s) => `+${s.floor}% / −${s.stop}% / +${s.target}% / ${s.giveBack}%`;
const row = (c) =>
  `| ${label(c.set)} | ${c.trade.n} | ${f(c.trade.winRate, 0, '%')} | ${sf(c.trade.avgNet)} | ${c.run.n} | ${f(c.run.winRate, 0, '%')} | $${c.run.final.toFixed(2)} |`;
const head = '| Floor / stop / target / give-back | Trades (each alone) | Win rate | Avg net per trade | Run trades | Run win rate | Run result |\n|---|---|---|---|---|---|---|';
const same = (a, b) => Object.keys(a).every((x) => a[x] === b[x]);
const current = combos.find((c) => same(c.set, CURRENT));
const oneAtATime = Object.keys(GRID).map((param) => {
  const rows = combos.filter((c) => Object.keys(CURRENT).every((x) => x === param || c.set[x] === CURRENT[x]));
  return `### Changing only the ${param}\n\n${head}\n${rows.map(row).join('\n')}`;
});
const byRun = [...combos].sort((a, b) => b.run.final - a.run.final).slice(0, 10);
const byTrade = combos.filter((c) => c.trade.n >= 5).sort((a, b) => b.trade.avgNet - a.trade.avgNet).slice(0, 10);
const span = `${time.short(new Date(Math.min(...events.map((e) => e.t))))} – ${time.short(new Date(Math.max(...events.map((e) => e.t))))}`;

const md = `# Compounder replay (${runArg ?? 'all runs'})

Generated ${time.when(new Date())}. ${hours.length} logged hours, ${events.length} candidate signals with a known outcome (${span}).
Settings are written as 1h floor / stop (net) / target (net) / trailing give-back. Current config: **${label(CURRENT)}**.
Small samples mislead: treat differences of a few trades as noise. ${current && current.trade.avgNet <= 0 ? '**The current settings lose money per trade after costs on this data.**' : ''}

## Current settings

${head}
${current ? row(current) : '| n/a |'}

${oneAtATime.join('\n\n')}

## Best 10 by run result

${head}
${byRun.map(row).join('\n')}

## Best 10 by average net per trade (at least 5 trades)

${head}
${byTrade.map(row).join('\n') || '| not enough trades yet |'}

Simplifications: deeper momentum checks only exist for tokens the hourly run examined; unquoted tokens assume ${k.costs.replayAssumedDexRoundTripPct}% DEX round trip plus FOMO fees; the stop is fixed (no volatility widening); liquidity limits are not re-applied as the bankroll grows.
`;
fs.writeFileSync(OUT, md);
console.log(`Wrote COMPOUNDER-REPLAY.md (${combos.length} setting combinations, ${events.length} signals).`);
if (current) console.log(`Current settings: ${current.trade.n} trades, win rate ${f(current.trade.winRate, 0, '%')}, avg ${sf(current.trade.avgNet)}; run $${k.seedUsd} → $${current.run.final.toFixed(2)}`);
