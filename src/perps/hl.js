// Hyperliquid public market data (no account or key needed): every perp with its live context, and candles.
// Docs: POST https://api.hyperliquid.xyz/info with {"type": ...}.
import { getJson } from '../http.js';

const API = 'https://api.hyperliquid.xyz/info';
const post = (body) => getJson(API, { init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });

// Every listed perp: max leverage, maintenance margin for a small position, and the live context (mark, spread, volume, OI, funding).
export async function markets() {
  const [meta, ctxs] = await post({ type: 'metaAndAssetCtxs' });
  const tables = new Map(meta.marginTables ?? []);
  return meta.universe.map((u, i) => {
    const c = ctxs[i] ?? {};
    const mark = Number(c.markPx);
    const [bid, ask] = (c.impactPxs ?? []).map(Number);
    // Small positions sit in the first margin tier; maintenance margin is half the margin at that tier's max leverage.
    const tierMax = tables.get(u.marginTableId)?.marginTiers?.[0]?.maxLeverage ?? u.maxLeverage;
    return {
      coin: u.name,
      maxLeverage: u.maxLeverage,
      delisted: !!u.isDelisted,
      mmrPct: 100 / (2 * tierMax),
      markPx: mark,
      prevDayPx: Number(c.prevDayPx),
      dayVolumeUsd: Number(c.dayNtlVlm),
      openInterestUsd: Number(c.openInterest) * mark,
      fundingPctPerHour: Number(c.funding) * 100,
      spreadPct: bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null,
    };
  });
}

// Candles as [{ t, o, h, l, c, v }] (t = open time in ms), oldest first; at most 5,000 per call.
export async function candles(coin, interval, startMs, endMs) {
  const list = await post({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(startMs), endTime: Math.floor(endMs) } });
  return (list ?? []).map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v })).sort((a, b) => a.t - b.t);
}
