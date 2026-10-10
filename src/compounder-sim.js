// Paper-trade maths for the Compounder, shared by the hourly run and the replay script.
// Prices are raw market prices (USD per token) from candles. Costs are applied here: the FOMO fee
// on each side, plus the quoted DEX round trip split evenly between the buy and the sell.
import { fomoFee } from './screen.js';

export function openPosition({ sizeUsd, rawEntry, dexRoundTripPct, costs }) {
  const half = dexRoundTripPct / 200;
  const buyFeeUsd = fomoFee(sizeUsd, costs);
  return { sizeUsd, rawEntry, half, buyFeeUsd, tokens: (sizeUsd - buyFeeUsd) / (rawEntry * (1 + half)) };
}

// What selling at a raw price would return after the DEX cost and the FOMO sell fee.
export function netAt(p, rawPrice, costs) {
  const gross = p.tokens * rawPrice * (1 - p.half);
  const sellFeeUsd = Math.min(gross, fomoFee(gross, costs));
  const proceeds = gross - sellFeeUsd;
  return { proceeds, sellFeeUsd, netUsd: proceeds - p.sizeUsd, netPct: (proceeds / p.sizeUsd - 1) * 100 };
}

// Raw price at which the net result equals netPct (net rises with price, so bisect).
export function priceForNet(p, netPct, costs) {
  let lo = 0;
  let hi = p.rawEntry * 1000;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (netAt(p, mid, costs).netPct < netPct) lo = mid;
    else hi = mid;
  }
  return hi;
}

// Paper fill: the last traded price at fill time (decision + delay); if nothing traded before it, the next trade.
// candles: [[tSec, open, high, low, close, volume]] ascending. Replay continues with candles after fillCandleT.
export function findFill(candles, fillAt) {
  let pick = null;
  for (const c of candles) {
    if (c[0] * 1000 <= fillAt) pick = c;
    else break;
  }
  if (pick) return { rawPrice: pick[4], fillCandleT: pick[0] };
  const next = candles.find((c) => c[0] * 1000 > fillAt);
  return next ? { rawPrice: next[1], fillCandleT: next[0] - 1 } : null;
}

// Applies the exit rules minute by minute, conservatively: the stop is checked before any new high
// can raise it. Rules (all net of costs):
//   stop at -stopNetPct, judged on stopCheckMinutes closes (e.g. 15-minute candles) so brief wicks don't
//   end a trade, with an emergency stop on any price (starting at -emergencyStopNetPct, then rising
//   with the stop, the same distance below it); once +targetNetPct is reached the stop locks at +lockNetPct and then trails,
//   giving back at most trailGiveBackPct of the peak gain; time stop if the target isn't reached in
//   timeStopHours; never held past maxHoldHours or hardEndAt (month end).
// takeProfitNetUsd: exit as soon as the net gain reaches it (the $5k finish line).
export function replayExit(p, candles, r, costs, { fillAt, now, hardEndAt = Infinity, takeProfitNetUsd = Infinity }) {
  const targetPrice = priceForNet(p, r.targetNetPct, costs);
  const finishPrice = Number.isFinite(takeProfitNetUsd)
    ? priceForNet(p, (takeProfitNetUsd / p.sizeUsd) * 100, costs)
    : Infinity;
  let stop = priceForNet(p, -r.stopNetPct, costs);
  // The emergency stop sits a fixed fraction below the stop and rises with it.
  const emergencyRatio = r.emergencyStopNetPct ? priceForNet(p, -r.emergencyStopNetPct, costs) / stop : 0;
  const bucketSec = (r.stopCheckMinutes ?? 1) * 60; // 60 = every 1-minute low counts
  const onCloses = bucketSec > 60;
  const stopReason = () => (targetHitAt ? 'trailing stop' : 'stop loss');
  let peak = p.rawEntry;
  let targetHitAt = null;
  let last = null;

  const deadline = () => {
    const ruleEnd = fillAt + (targetHitAt ? r.maxHoldHours : r.timeStopHours) * 3600e3;
    if (hardEndAt < ruleEnd) return { at: hardEndAt, reason: 'month end' };
    return { at: ruleEnd, reason: targetHitAt ? `max hold (${r.maxHoldHours}h)` : `time stop (target not reached in ${r.timeStopHours}h)` };
  };
  const done = (rawExit, atMs, reason) => ({
    closed: true,
    rawExit,
    exitAt: atMs,
    reason,
    targetHit: !!targetHitAt,
    peakNetPct: netAt(p, peak, costs).netPct,
    ...netAt(p, rawExit, costs),
  });

  for (const c of candles) {
    const [t, o, h, l] = c;
    const ms = t * 1000;
    const end = deadline();
    if (ms >= end.at) return done(o, ms, end.reason);
    if (onCloses) {
      // A new period started: if the previous one closed at or below the stop, sell at this open.
      if (last && Math.floor(t / bucketSec) !== Math.floor(last[0] / bucketSec) && last[4] <= stop) return done(o, ms, stopReason());
      if (l <= stop * emergencyRatio) return done(Math.min(o, stop * emergencyRatio), ms, 'emergency stop');
    } else if (l <= stop) return done(Math.min(o, stop), ms, stopReason());
    if (h >= finishPrice) return done(Math.max(o, finishPrice), ms, 'finish line reached');
    if (h > peak) {
      peak = h;
      if (!targetHitAt && h >= targetPrice) targetHitAt = ms;
      if (targetHitAt) {
        const keep = Math.max(r.lockNetPct, netAt(p, h, costs).netPct * (1 - r.trailGiveBackPct / 100));
        stop = Math.max(stop, priceForNet(p, keep, costs));
      }
    }
    last = c;
  }

  const lastPrice = last ? last[4] : p.rawEntry;
  const end = deadline();
  if (onCloses && last && last[4] <= stop) {
    const periodEnd = (Math.floor(last[0] / bucketSec) + 1) * bucketSec * 1000;
    if (now >= periodEnd && periodEnd < end.at) return done(lastPrice, periodEnd, stopReason());
  }
  if (now >= end.at) return done(lastPrice, end.at, end.reason);
  return {
    closed: false,
    lastPrice,
    lastAt: last ? last[0] * 1000 : fillAt,
    stopPrice: stop,
    targetHit: !!targetHitAt,
    peakNetPct: netAt(p, peak, costs).netPct,
    ...netAt(p, lastPrice, costs),
  };
}

// v2 exit: hold with no stop and no time limit; sell the first minute the price reaches the +targetNetPct
// net price (at that price, or at the open if the candle gapped above it). Also tracks the best and worst
// net mark seen, for the report. candles: only those after the last checked candle.
export function replayTarget(p, candles, targetNetPct, costs) {
  const targetPrice = priceForNet(p, targetNetPct, costs);
  let hi = -Infinity;
  let lo = Infinity;
  for (const [t, o, h, l] of candles) {
    lo = Math.min(lo, l);
    if (h >= targetPrice) {
      const rawExit = Math.max(o, targetPrice);
      return { closed: true, rawExit, exitAt: t * 1000, reason: `+${targetNetPct}% target`, targetHit: true, high: Math.max(hi, rawExit), low: lo, ...netAt(p, rawExit, costs) };
    }
    hi = Math.max(hi, h);
  }
  const last = candles.at(-1);
  return { closed: false, targetPrice, high: hi, low: lo, lastPrice: last?.[4] ?? null, lastAt: last ? last[0] * 1000 : null };
}
