// Perps backtest (2026-11-17): replays both Perps Compounders over Hyperliquid's last ~17 days of 5-minute candles with the
// live rules (src/perps/signal.js), fees, liquidation and the time limit (src/perps/sim.js). One decision every 15 min.
// Approximations: today's coin list, spreads and margin tiers; no open-interest history (that score part is 0, so fewer entries);
// funding at a flat typical rate against the position; exits on 5-min candles (liquidation before target inside a candle).
//   node research/perps-backtest.js [days] [entryKey=value ...]   e.g. 16 liqSafety=0.5 (overrides perps.entry for this run only)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markets, candles } from '../src/perps/hl.js';
import { marketFailure, evaluate } from '../src/perps/signal.js';
import { openPerp, replayPerp } from '../src/perps/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const k = cfg.perps;
// Overrides: hold=H (time limit in hours), dayMode=goal|firstTarget|oneTrade (Conservative: stop for the day when the day is up
// the target / after the first target sale / after any one trade), any other key=value goes to perps.entry.
const args = Object.fromEntries(process.argv.slice(3).map((a) => a.split('=')).map(([key, v]) => [key, v === 'true' ? true : v === 'false' ? false : isNaN(Number(v)) ? v : Number(v)]));
const { hold, dayMode = 'goal', ...entryArgs } = args;
if (hold) k.maxHoldHours = hold;
const e = { ...k.entry, ...entryArgs };
const M5 = 5 * 60e3, H = 3600e3;
const FUNDING_PER_HOUR = 0.0000125; // 0.00125%/h, Hyperliquid's usual baseline, charged against the position
const days = Number(process.argv[2] ?? 16);

const now = Date.now();
const mkts = (await markets()).filter((m) => !marketFailure(m, e, k.leverage));
console.log(`${mkts.length} coins pass today's universe checks: ${mkts.map((m) => m.coin).join(' ')}`);
const data = new Map();
for (const m of mkts) data.set(m.coin, (await candles(m.coin, '5m', now - 5000 * M5, now)).filter((c) => c.t + M5 <= now));
const start = Math.max(...[...data.values()].map((cs) => cs[0]?.t ?? now)) + 25 * H; // 24h of history needed before the first decision
const from = Math.max(start, now - days * 24 * H);
const idx = new Map([...data].map(([coin, cs]) => [coin, new Map(cs.map((c, i) => [c.t, i]))]));
console.log(`decisions from ${new Date(from).toISOString().slice(0, 16)} to ${new Date(now).toISOString().slice(0, 16)} UTC\n`);

// Quick pre-check (same thresholds as evaluate) so the full evaluation only runs on coins that are moving on volume.
function quick(cs, i) {
  const w = cs.slice(i - 287, i + 1);
  const close = w.at(-1).c;
  const chg15 = (close / w.at(-4).c - 1) * 100;
  const vol = w.map((c) => c.v * c.c);
  const surge = vol.slice(-3).reduce((s, v) => s + v, 0) / ((vol.reduce((s, v) => s + v, 0) / vol.length) * 3);
  return e.lax || (surge >= e.minVolumeSurge && Math.abs(chg15) >= e.minMove15Pct && Math.abs(chg15) <= e.maxMove15Pct) ? w : null;
}

const runs = k.variants.map((v) => ({ v, cash: v.seedUsd, busyUntil: 0, pos: null, trades: [], day: null, daysMet: 0, dayCount: 0, lastTraded: new Map() }));
const localDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.displayTimezone }).format(new Date(t));

for (let t = Math.ceil(from / (15 * 60e3)) * 15 * 60e3; t < now - 3 * H; t += 15 * 60e3) {
  for (const run of runs) {
    if (run.v.per === 'day' && run.day?.date !== localDay(t)) {
      run.day = { date: localDay(t), start: run.cash, met: false };
      run.dayCount++;
    }
    if (t < run.busyUntil || run.cash < k.minBankrollUsd) continue;
    if (run.v.per === 'day' && run.day.met) continue;
    const taken = new Set(runs.filter((o) => o !== run && o.busyUntil > t).map((o) => o.pos));
    let best = null;
    for (const m of mkts) {
      const cs = data.get(m.coin);
      const i = idx.get(m.coin).get(t - M5); // last completed candle at decision time
      if (i == null || i < 287 || taken.has(m.coin) || t - (run.lastTraded.get(m.coin) ?? -Infinity) < k.cooldownHours * H) continue;
      const w = quick(cs, i);
      if (!w) continue;
      const r = evaluate({ ...m, markPx: w.at(-1).c, fundingPctPerHour: 0 }, w, { e, leverage: k.leverage, fees: k.fees, targetNetPct: run.v.targetNetPct });
      if (!r.reason && (!best || r.score > best.r.score)) best = { r, m, cs, i };
    }
    if (!best) continue;
    const { r, m, cs, i } = best;
    const fill = cs[i + 1];
    if (!fill) continue;
    const d = r.side === 'long' ? 1 : -1;
    const p = openPerp({ marginUsd: run.cash, leverage: k.leverage, side: r.side, entryPx: fill.o * (1 + (d * m.spreadPct) / 200), takerPct: k.fees.takerPct, mmrPct: m.mmrPct, stopFraction: k.stopLoss?.beforeLiquidationFraction ?? null });
    const closeAt = fill.t + k.maxHoldHours * H;
    const res = replayPerp(p, cs.slice(i + 1, i + 1 + k.maxHoldHours * 12 + 1), {}, { targetNetPct: run.v.targetNetPct, ...k.fees, slipPct: m.spreadPct / 2, stopSlipPct: k.stopLoss?.extraSlipPct ?? 0, fundingRatePerHour: FUNDING_PER_HOUR * d, closeAtMs: closeAt, nowMs: closeAt });
    run.trades.push({ t: new Date(t).toISOString().slice(5, 16), coin: m.coin, side: r.side, score: r.score, reason: res.reason, netPct: res.netPct, mins: Math.round((res.exitAt - fill.t) / 60e3) });
    run.cash = res.proceeds;
    run.pos = m.coin;
    run.lastTraded.set(m.coin, t);
    run.busyUntil = Math.ceil((res.exitAt + 1) / (15 * 60e3)) * 15 * 60e3;
    if (run.v.per === 'day') {
      run.day.trades = (run.day.trades ?? 0) + 1;
      (run.tradesPerDay ??= {})[run.day.date] = run.day.trades;
      const goal = run.cash >= run.day.start * (1 + run.v.targetNetPct / 100) - 0.005;
      if (goal) run.daysMet++;
      if (goal || (dayMode === 'firstTarget' && res.targetHit) || dayMode === 'oneTrade') run.day.met = true;
    }
  }
}

for (const run of runs) {
  const T = run.trades;
  const hit = T.filter((x) => x.reason.startsWith('+')), liq = T.filter((x) => x.reason === 'liquidated'), tl = T.filter((x) => x.reason.startsWith('time')), stop = T.filter((x) => x.reason.startsWith('stop'));
  const avg = (a) => (a.length ? (a.reduce((s, x) => s + x.netPct, 0) / a.length).toFixed(1) : '-');
  console.log(`== ${run.v.name}: $${run.v.seedUsd} → $${run.cash.toFixed(2)} · ${T.length} trades (${(T.length / days).toFixed(1)}/day) · target ${hit.length} (median ${hit.length ? hit.map((x) => x.mins).sort((a, b) => a - b)[hit.length >> 1] : '-'} min) · time limit ${tl.length} (avg ${avg(tl)}%) · stopped ${stop.length} (avg ${avg(stop)}%) · liquidated ${liq.length}${run.v.per === 'day' ? ` · daily goal met ${run.daysMet} of ${run.dayCount} days` : ''}`);
  if (run.tradesPerDay) console.log(`   trades per day: ${Object.entries(run.tradesPerDay).map(([d, n]) => `${d.slice(5)}:${n}`).join(' ')}`);
  console.log(`   longs ${T.filter((x) => x.side === 'long').length} (${T.filter((x) => x.side === 'long' && x.reason.startsWith('+')).length} hit) · shorts ${T.filter((x) => x.side === 'short').length} (${T.filter((x) => x.side === 'short' && x.reason.startsWith('+')).length} hit)`);
  for (const x of T) console.log(`   ${x.t} ${x.side.padEnd(5)} ${x.coin.padEnd(9)} score ${String(x.score).padStart(5)} → ${x.reason.padEnd(32)} ${x.netPct.toFixed(1).padStart(7)}% in ${x.mins} min`);
}
