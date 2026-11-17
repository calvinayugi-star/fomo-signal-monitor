// Perp paper-trade math (Hyperliquid, isolated margin, since 2026-11-17): position, net result after fees and funding,
// the take-profit price for a net target, liquidation, and a walk over 1-minute candles to the first exit.
// Fees: the entry is a market order (taker); the take-profit is a resting reduce-only limit order (maker); a time-limit exit
// is a market order (taker) that also pays the spread. Funding is paid (or received) on the hour while the position is open.

// mmrPct: maintenance margin as % of the position, = half the margin at the coin's max leverage (Hyperliquid's rule).
export function openPerp({ marginUsd, leverage, side, entryPx, takerPct, mmrPct }) {
  const notional = marginUsd * leverage;
  const d = side === 'long' ? 1 : -1;
  const mmr = mmrPct / 100;
  // Liquidated when margin + PnL falls to the maintenance margin of the position's current value.
  const liqRel = d === 1 ? (1 - 1 / leverage) / (1 - mmr) : (1 + 1 / leverage) / (1 + mmr);
  return { marginUsd, leverage, side, d, entryPx, notional, entryFee: (notional * takerPct) / 100, liqPx: entryPx * liqRel };
}

// Result if closed at px paying exitFeePct on the exit value, after the entry fee and the funding paid so far.
export function netAt(p, px, exitFeePct, fundingUsd = 0) {
  const rel = px / p.entryPx;
  const netUsd = p.notional * p.d * (rel - 1) - p.entryFee - (p.notional * rel * exitFeePct) / 100 - fundingUsd;
  return { netUsd, netPct: (netUsd / p.marginUsd) * 100, proceeds: p.marginUsd + netUsd };
}

// Price at which a maker exit nets targetNetPct of the margin (after both fees and the funding paid so far).
export function targetPx(p, targetNetPct, makerPct, fundingUsd = 0) {
  const need = (p.marginUsd * targetNetPct) / 100 + p.entryFee + fundingUsd;
  const mk = makerPct / 100;
  const rel = p.d === 1 ? (need + p.notional) / (p.notional * (1 - mk)) : (p.notional - need) / (p.notional * (1 + mk));
  return p.entryPx * rel;
}

// Walks completed 1-minute candles [{t, o, h, l, c}] (t = open time, ms) in order, from where the last check stopped.
// state carries what earlier checks found: fundingUsd, fundedThrough (last funding hour paid), peakNetPct, worstNetPct.
// Inside one candle the adverse extreme is checked first (liquidation before the take-profit): the cautious reading.
// Returns { closed, reason, exitAt, exitPx, netUsd, netPct, proceeds, targetHit } or { closed: false, lastPx, lastAt }.
export function replayPerp(p, candles, state, { targetNetPct, makerPct, takerPct, slipPct, fundingRatePerHour, closeAtMs, nowMs }) {
  let lastPx = state.lastPx ?? p.entryPx;
  let lastAt = state.lastAt ?? null;
  for (const c of candles) {
    if (c.t + 60e3 > closeAtMs) break; // the time limit falls inside or before this minute
    // Funding is settled on the hour: longs pay a positive rate, shorts receive it (and the reverse when negative).
    if (c.t % 3600e3 === 0 && c.t > (state.fundedThrough ?? 0)) {
      state.fundingUsd = (state.fundingUsd ?? 0) + p.d * p.notional * (c.o / p.entryPx) * fundingRatePerHour;
      state.fundedThrough = c.t;
    }
    const adverse = p.d === 1 ? c.l : c.h;
    const favorable = p.d === 1 ? c.h : c.l;
    state.worstNetPct = Math.min(state.worstNetPct ?? 0, netAt(p, adverse, takerPct, state.fundingUsd).netPct);
    if (p.d === 1 ? adverse <= p.liqPx : adverse >= p.liqPx) {
      return { closed: true, reason: 'liquidated', exitAt: c.t + 30e3, exitPx: p.liqPx, netUsd: -p.marginUsd, netPct: -100, proceeds: 0, targetHit: false };
    }
    const tp = targetPx(p, targetNetPct, makerPct, state.fundingUsd);
    if (p.d === 1 ? favorable >= tp : favorable <= tp) {
      return { closed: true, reason: `+${targetNetPct}% target`, exitAt: c.t + 30e3, exitPx: tp, ...netAt(p, tp, makerPct, state.fundingUsd), targetHit: true };
    }
    state.peakNetPct = Math.max(state.peakNetPct ?? -100, netAt(p, favorable, takerPct, state.fundingUsd).netPct);
    lastPx = c.c;
    lastAt = c.t + 60e3;
  }
  state.lastPx = lastPx;
  state.lastAt = lastAt;
  if (nowMs >= closeAtMs) {
    // Time limit: market exit at the last price before the limit, paying the taker fee and the spread.
    const exitPx = lastPx * (1 - (p.d * slipPct) / 100);
    return { closed: true, reason: 'time limit (target not reached)', exitAt: closeAtMs, exitPx, ...netAt(p, exitPx, takerPct, state.fundingUsd), targetHit: false };
  }
  return { closed: false, lastPx, lastAt, mark: netAt(p, lastPx * (1 - (p.d * slipPct) / 100), takerPct, state.fundingUsd) };
}
