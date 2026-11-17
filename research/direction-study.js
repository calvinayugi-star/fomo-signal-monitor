// Direction study (2026-11-17): can a model learn, from Hyperliquid's own history, which side (long/short) of which coin will
// reach the target before the stop, with no time limit? The goal set by the user: a hit rate of ~90% so stops become rare.
//
// Data: ~7 months of hourly candles for every perp that allows 10x (plus BTC for the market's direction).
// Label, per coin, hour and side: enter at the next hour's open (paying half the spread), then walk forward up to 7 days:
//   win  = the take-profit for the run's net target is reached first (+13.93% Conservative, +20% Aggressive),
//   loss = the stop at 90% of the way to liquidation is reached first (also when both fall inside the same hour: cautious).
// Features use only candles up to the decision hour, signed by the side ("move in the trade's direction").
// Train on the older months, test on the latest ~30% the model never saw (training rows that resolve after the cut are dropped).
//   node research/direction-study.js [--targets=c,a] [--drop=weekday,hourUtc] [--cut=0.7] [--end=1]
//   --drop leaves inputs out of the model (a robustness check); --cut/--end place the test window as fractions of the rows in time
//   (default: train on the first 70%, test on the rest; e.g. --cut=0.45 --end=0.7 tests an earlier market phase).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markets, candles } from '../src/perps/hl.js';
import { openPerp, targetPx, netAt } from '../src/perps/sim.js';
import { fit } from './gbt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const k = cfg.perps;
const H = 3600e3, HORIZON = 168, FUNDING_PER_HOUR = 0.0000125; // typical Hyperliquid funding, charged against the position
const TARGETS = { c: k.variants.find((v) => v.id === 'conservative').targetNetPct, a: k.variants.find((v) => v.id === 'aggressive').targetNetPct };
const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const KEYS = (opt.targets ?? 'c,a').split(',');
const DROP = new Set((opt.drop ?? '').split(',').filter(Boolean));
const etDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.displayTimezone }).format(new Date(t));

// --- data ---------------------------------------------------------------------------------------
const now = Date.now();
const universe = (await markets()).filter((m) => !m.delisted && m.maxLeverage >= k.leverage && m.dayVolumeUsd >= 1e6);
const series = new Map();
for (const m of universe) {
  const cs = (await candles(m.coin, '1h', now - 5000 * H, now)).filter((c) => c.t + H <= now);
  if (cs.length > 400) series.set(m.coin, { m, cs });
}
const btc = series.get('BTC').cs;
const btcAt = new Map(btc.map((c, i) => [c.t, i]));
console.log(`${series.size} coins, ${new Date(btc[0].t).toISOString().slice(0, 10)} → ${new Date(btc.at(-1).t).toISOString().slice(0, 10)} (${btc.length} hours)`);

// --- features -------------------------------------------------------------------------------------
const NAMES = ['long', 'r1', 'r4', 'r12', 'r24', 'r72', 'r168', 'btc_r1', 'btc_r4', 'btc_r24', 'btc_r168', 'rel24', 'rel168', 'vol24', 'vol168', 'volToStop',
  'pos24', 'pos168', 'ema24', 'ema168', 'volume1', 'volume24', 'hourUtc', 'weekday', 'stopDist'];
function prep(cs) {
  const n = cs.length, c = cs.map((x) => x.c);
  const ret = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
  const std = (i, w) => { let s = 0, s2 = 0; for (let j = i - w + 1; j <= i; j++) (s += ret[j]), (s2 += ret[j] * ret[j]); return Math.sqrt(Math.max(s2 / w - (s / w) ** 2, 0)) * 100; };
  const ema = (w) => { const a = 2 / (w + 1); const out = []; let e = c[0]; for (const x of c) out.push((e = a * x + (1 - a) * e)); return out; };
  const e24 = ema(24), e168 = ema(168);
  return { n, c, std, e24, e168, hi: (i, w) => Math.max(...cs.slice(i - w + 1, i + 1).map((x) => x.h)), lo: (i, w) => Math.min(...cs.slice(i - w + 1, i + 1).map((x) => x.l)), vol: (i, w) => cs.slice(i - w + 1, i + 1).reduce((s, x) => s + x.v * x.c, 0) };
}
function features(cs, P, i, d, stopDistPct) {
  const r = (w) => (P.c[i] / P.c[i - w] - 1) * 100;
  const b = btcAt.get(cs[i].t);
  const br = (w) => (b != null && b >= w ? (btc[b].c / btc[b - w].c - 1) * 100 : NaN);
  const pos = (w) => { const hi = P.hi(i, w), lo = P.lo(i, w); const x = hi > lo ? (P.c[i] - lo) / (hi - lo) : 0.5; return d === 1 ? x : 1 - x; };
  const vol24 = P.std(i, 24);
  const date = new Date(cs[i].t);
  return [d === 1 ? 1 : 0, d * r(1), d * r(4), d * r(12), d * r(24), d * r(72), d * r(168), d * br(1), d * br(4), d * br(24), d * br(168), d * (r(24) - br(24)), d * (r(168) - br(168)),
    vol24, P.std(i, 168), vol24 / stopDistPct, pos(24), pos(168), d * (P.c[i] / P.e24[i] - 1) * 100, d * (P.c[i] / P.e168[i] - 1) * 100,
    P.vol(i, 1) / (P.vol(i, 24) / 24), P.vol(i, 24) / (P.vol(i, 168) / 7), date.getUTCHours(), date.getUTCDay(), stopDistPct];
}

// --- labels ---------------------------------------------------------------------------------------
function outcome(cs, i, d, m, target) {
  const e = cs[i + 1];
  if (!e) return null;
  const slip = m.spreadPct / 2;
  const p = openPerp({ marginUsd: 1, leverage: k.leverage, side: d === 1 ? 'long' : 'short', entryPx: e.o * (1 + (d * slip) / 100), takerPct: k.fees.takerPct, mmrPct: m.mmrPct, stopFraction: k.stopLoss.beforeLiquidationFraction });
  const tp = targetPx(p, target, k.fees.makerPct);
  const lossPct = netAt(p, p.stopPx * (1 - (d * (slip + k.stopLoss.extraSlipPct)) / 100), k.fees.takerPct).netPct;
  for (let j = i + 1; j < cs.length && j <= i + HORIZON; j++) {
    const x = cs[j], hours = j - i;
    if (d === 1 ? x.l <= p.stopPx : x.h >= p.stopPx) return { win: 0, hours, ret: lossPct - hours * FUNDING_PER_HOUR * k.leverage * 100 };
    if (d === 1 ? x.h >= tp : x.l <= tp) return { win: 1, hours, ret: target - hours * FUNDING_PER_HOUR * k.leverage * 100 };
  }
  return null; // unresolved within 7 days, or not enough future data
}

const rows = { c: [], a: [] };
for (const [coin, { m, cs }] of series) {
  const P = prep(cs);
  const stopDistPct = Math.abs(openPerp({ marginUsd: 1, leverage: k.leverage, side: 'long', entryPx: 1, takerPct: 0, mmrPct: m.mmrPct, stopFraction: k.stopLoss.beforeLiquidationFraction }).stopPx - 1) * 100;
  for (let i = 168; i < cs.length - 1; i++)
    for (const d of [1, -1]) {
      const x = features(cs, P, i, d, stopDistPct);
      for (const key of KEYS) {
        const o = outcome(cs, i, d, m, TARGETS[key]);
        if (o) rows[key].push({ coin, t: cs[i].t, side: d === 1 ? 'long' : 'short', x, ...o });
      }
    }
}

// --- train / test -----------------------------------------------------------------------------------
const report = {};
const KEEP = NAMES.map((_, f) => f).filter((f) => !DROP.has(NAMES[f]));
const pick = (x) => KEEP.map((f) => x[f]);
if (DROP.size) console.log(`inputs left out: ${[...DROP].join(', ')}`);
for (const key of KEYS) {
  const R = rows[key].sort((p, q) => p.t - q.t);
  const cut = R[Math.floor(R.length * Number(opt.cut ?? 0.7))].t;
  const endT = Number(opt.end ?? 1) >= 1 ? Infinity : R[Math.floor(R.length * Number(opt.end))].t;
  const train = R.filter((r) => r.t + r.hours * H <= cut && (r.t / H) % 2 === 0); // resolved before the cut; every 2nd hour (neighbours are near-copies)
  const test = R.filter((r) => r.t >= cut && r.t < endT);
  const b0 = btc[btcAt.get(test[0].t)]?.c, b1 = btc[btcAt.get(test.at(-1).t)]?.c;
  console.log(`   test window ${new Date(test[0].t).toISOString().slice(0, 10)} → ${new Date(test.at(-1).t).toISOString().slice(0, 10)}: BTC ${b0 && b1 ? `${((b1 / b0 - 1) * 100).toFixed(1)}%` : 'n/a'}`);
  const name = key === 'c' ? `Conservative (+${TARGETS.c}%)` : `Aggressive (+${TARGETS.a}%)`;
  const t0 = Date.now();
  const model = fit(train.map((r) => pick(r.x)), train.map((r) => r.win), KEEP.map((f) => NAMES[f]));
  for (const r of test) r.p = model.predict(pick(r.x));
  const hit = (a) => (a.length ? (100 * a.filter((r) => r.win).length) / a.length : NaN);
  const ev = (a) => (a.length ? a.reduce((s, r) => s + r.ret, 0) / a.length : NaN);
  const testDays = (test.at(-1).t - test[0].t) / (24 * H);
  console.log(`\n== ${name}: train ${train.length} rows to ${new Date(cut).toISOString().slice(0, 10)}, test ${test.length} rows over ${testDays.toFixed(0)} days (fit ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  console.log(`   baseline, any coin/side/hour: hit ${hit(test).toFixed(1)}%, avg ${ev(test).toFixed(2)}% per trade · longs ${hit(test.filter((r) => r.side === 'long')).toFixed(1)}%, shorts ${hit(test.filter((r) => r.side === 'short')).toFixed(1)}%`);
  const trend = test.filter((r) => r.x[2] > 0 && r.x[4] > 0);
  console.log(`   simple trend rule (4h and 24h moving the trade's way): hit ${hit(trend).toFixed(1)}%, avg ${ev(trend).toFixed(2)}%, ${trend.length} rows`);
  const sorted = [...test].sort((p, q) => q.p - p.p);
  for (const frac of [0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005]) {
    const top = sorted.slice(0, Math.max(1, Math.floor(sorted.length * frac)));
    const episodes = new Set(top.map((r) => `${r.coin}|${etDay(r.t)}|${r.side}`)).size;
    console.log(`   model top ${(frac * 100).toString().padStart(4)}%: hit ${hit(top).toFixed(1).padStart(5)}%, avg ${ev(top).toFixed(2).padStart(6)}% per trade, predicted ${(top.at(-1).p * 100).toFixed(1)}%+ · ${top.length} rows, ${episodes} coin-day-sides`);
  }
  // One position at a time over the test days, taking the most confident setup each hour above a threshold.
  for (const th of [0.8, 0.85, 0.9, 0.93]) {
    const byHour = new Map();
    for (const r of test) (byHour.get(r.t) ?? byHour.set(r.t, []).get(r.t)).push(r);
    let bank = key === 'c' ? 110 : 25, busy = 0, wins = 0, losses = 0, doneDay = null;
    for (const [t, group] of [...byHour].sort((p, q) => p[0] - q[0])) {
      if (t < busy || (key === 'c' && doneDay === etDay(t))) continue;
      const best = group.filter((r) => r.p >= th).sort((p, q) => q.p - p.p)[0];
      if (!best) continue;
      bank *= 1 + best.ret / 100;
      best.win ? wins++ : losses++;
      busy = t + (best.hours + 1) * H;
      if (key === 'c' && best.win) doneDay = etDay(busy);
    }
    console.log(`   trading at ${th * 100}%+ confidence: ${wins + losses} trades (${((wins + losses) / testDays).toFixed(2)}/day), ${wins} wins, ${losses} stops → $${key === 'c' ? 110 : 25} → $${bank.toFixed(2)}`);
  }
  console.log(`   leans on: ${model.importance.slice(0, 10).map(([nm, v]) => `${nm} ${(v * 100).toFixed(0)}%`).join(', ')}`);
  report[key] = { train: train.length, test: test.length, cut: new Date(cut).toISOString(), baselineHit: hit(test), importance: model.importance.slice(0, 10) };
}
const out = path.join(ROOT, 'research', 'direction-study-results.json');
let prev = {};
try {
  prev = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  /* first run */
}
const tag = DROP.size ? `without ${[...DROP].join('+')}` : 'all inputs';
fs.writeFileSync(out, JSON.stringify({ ...prev, at: new Date().toISOString(), coins: [...series.keys()], [tag]: { ...(prev[tag] ?? {}), ...report } }, null, 1) + '\n');
