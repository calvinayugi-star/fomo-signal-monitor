// Perp entry rules (2026-11-17): a coin is a candidate when a move is starting with real participation, in either direction
// (long when the last 15 min are up, short when down), it moves enough in a typical 2h to reach the target, and its recent
// swings stay well inside the liquidation distance (no stop-loss, so liquidation is the worst case).
// Pure: market context + completed 5-minute candles in, a row with the verdict out. Used by the engine and by backtests.
import { openPerp } from './sim.js';

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : NaN);
const round = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);

// Cheap checks on the live context, before any candle call.
export function marketFailure(m, e, leverage) {
  if (m.delisted) return 'delisted';
  if (m.maxLeverage < leverage) return `max leverage under ${leverage}x`;
  if (!(m.dayVolumeUsd >= e.minDayVolumeUsd)) return '24h volume too low';
  if (!(m.openInterestUsd >= e.minOpenInterestUsd)) return 'open interest too low';
  if (m.spreadPct == null || m.spreadPct > e.maxSpreadPct) return 'spread too wide';
  return null;
}

// Price move the target needs (both fees included), in % of price.
export const targetMovePct = (targetNetPct, leverage, fees) => (targetNetPct + (fees.takerPct + fees.makerPct) * leverage) / leverage;

// m: market (from hl.markets), c5: completed 5-min candles covering ~24h, oiPrevUsd: open interest 10 min-2h ago (or null).
export function evaluate(m, c5, { e, leverage, fees, targetNetPct, oiPrevUsd = null }) {
  const row = { coin: m.coin, markPx: m.markPx, dayVolumeUsd: Math.round(m.dayVolumeUsd), oiUsd: Math.round(m.openInterestUsd), spreadPct: round(m.spreadPct, 3), fundingPctPerHour: round(m.fundingPctPerHour, 4), mmrPct: round(m.mmrPct, 2) };
  if (c5.length < 48) return { ...row, reason: 'not enough candle history' };
  const close = c5.at(-1).c;
  const chg15 = pct(close, c5.at(-4).c);
  const chg60 = pct(close, c5.at(-13).c);
  const chg4h = pct(close, c5.at(-49).c);
  const usdVol = c5.map((k) => k.v * k.c);
  const vol15 = usdVol.slice(-3).reduce((s, v) => s + v, 0);
  const avg15 = (usdVol.reduce((s, v) => s + v, 0) / usdVol.length) * 3;
  const surge = vol15 / Math.max(avg15, 1e-9);
  const side = chg15 >= 0 ? 'long' : 'short';
  const d = side === 'long' ? 1 : -1;

  // Typical and worst 2h behaviour over the last day (24 five-minute candles per window).
  const ranges = [];
  let worstAdverse = 0;
  for (let s = 0; s + 24 <= c5.length; s++) {
    const w = c5.slice(s, s + 24);
    const hi = Math.max(...w.map((k) => k.h));
    const lo = Math.min(...w.map((k) => k.l));
    ranges.push(((hi - lo) / w[0].o) * 100);
    worstAdverse = Math.max(worstAdverse, d === 1 ? ((w[0].o - lo) / w[0].o) * 100 : ((hi - w[0].o) / w[0].o) * 100);
  }
  ranges.sort((a, b) => a - b);
  const typical2h = ranges[Math.floor(ranges.length / 2)];
  const move = targetMovePct(targetNetPct, leverage, fees);
  const liqDistPct = Math.abs(openPerp({ marginUsd: 1, leverage, side, entryPx: 1, takerPct: 0, mmrPct: m.mmrPct }).liqPx - 1) * 100;
  const oiChgPct = oiPrevUsd ? pct(m.openInterestUsd, oiPrevUsd) : null;
  const adverseFunding = d * m.fundingPctPerHour; // > 0: this side pays funding

  Object.assign(row, { side, chg15: round(chg15), chg60: round(chg60), chg4h: round(chg4h), surge: round(surge), typical2hPct: round(typical2h), targetMovePct: round(move), worstAdverse2hPct: round(worstAdverse), liqDistPct: round(liqDistPct), oiChgPct: round(oiChgPct) });

  const absMove = Math.abs(chg15);
  let reason = null;
  // e.lax (since 2026-11-17, user request "as lax as possible"): no entry filters, the score alone ranks the coins.
  if (e.lax) reason = null;
  else if (surge < e.minVolumeSurge) reason = 'volume not surging';
  else if (absMove < e.minMove15Pct) reason = 'no move yet (15 min)';
  else if (absMove > e.maxMove15Pct) reason = `already moved >${e.maxMove15Pct}% in 15 min`;
  else if (e.requireTrendAgreement && Math.sign(chg60) !== d) reason = '1h trend against the move';
  else if (e.requireTrend4hAgreement && Math.sign(chg4h) !== d) reason = '4h trend against the move';
  else if (adverseFunding > e.maxAdverseFundingPctPerHour) reason = 'funding against this side';
  else if (typical2h < e.minRangeToTarget * move) reason = 'moves too little to reach the target in 2h';
  else if (worstAdverse >= e.liqSafety * liqDistPct) reason = 'recent swings too close to liquidation';

  const score =
    30 * clamp01((surge - 1) / 2) + // 3x the average 15-min volume = full marks
    20 * clamp01(absMove / 1) + // a 1% move in 15 min = full marks (capped above by the chase limit)
    15 * (Math.sign(chg60) === d ? clamp01(Math.abs(chg60) / 2) : 0) + // the hour moving the same way, 2% = full marks
    15 * clamp01((oiChgPct ?? 0) / 3) + // open interest up 3% since the last check (new positions) = full marks
    10 * clamp01(typical2h / move - 1) + // a typical 2h range of twice the needed move = full marks
    10 * (adverseFunding <= 0 ? 1 : 0.5); // this side is paid (or pays nothing) in funding
  row.score = round(score, 1);
  if (!reason && !e.lax && score < e.minScore) reason = 'score below bar';
  return { ...row, reason };
}
