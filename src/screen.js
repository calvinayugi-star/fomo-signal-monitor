// Screening: demand -> safety -> sellability & cost on a $20 trade -> score.
import { getJson } from './http.js';
import { collectCandidates, GT, USDC } from './sources.js';

const JUP = 'https://lite-api.jup.ag/swap/v1';
const HOUR = 3600e3;
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const num = (x) => (x == null || x === '' ? null : Number(x));

export const fomoFee = (usd, costs) => Math.max(costs.fomoMinFeeUsd, (usd * costs.fomoFeePct) / 100);

// Best (deepest) pair per mint where the mint is the base token. DexScreener takes 30 mints per call.
export async function dexPairs(mints, log) {
  const best = new Map();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const pairs = await getJson(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(',')}`);
      for (const p of pairs ?? []) {
        const mint = p.baseToken?.address;
        if (!chunk.includes(mint)) continue;
        if ((p.liquidity?.usd ?? 0) > (best.get(mint)?.liquidity?.usd ?? -1)) best.set(mint, p);
      }
    } catch (e) {
      log.errors.push(`dexscreener: ${e.message}`);
    }
  }
  return best;
}

export function metrics(pair, now) {
  const volH1 = pair.volume?.h1 ?? 0;
  const volH6 = pair.volume?.h6 ?? 0;
  const t = pair.txns ?? {};
  const ageH = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / HOUR : null;
  // Volume acceleration: last hour vs the average hour before it (within the 6h window).
  const priorHours = Math.min(ageH ?? 6, 6) - 1;
  const accel = priorHours >= 0.5 ? volH1 / Math.max((volH6 - volH1) / priorHours, 1) : null;
  return {
    priceUsd: num(pair.priceUsd),
    liqUsd: pair.liquidity?.usd ?? 0,
    mcapUsd: pair.marketCap ?? pair.fdv ?? 0,
    ageH,
    volH1,
    volH6,
    volH24: pair.volume?.h24 ?? 0,
    buysH1: t.h1?.buys ?? 0,
    sellsH1: t.h1?.sells ?? 0,
    ratioH1: (t.h1?.buys ?? 0) / Math.max(t.h1?.sells ?? 0, 1),
    ratioH6: (t.h6?.buys ?? 0) / Math.max(t.h6?.sells ?? 0, 1),
    accel,
    chgH1: pair.priceChange?.h1 ?? 0,
    chgH6: pair.priceChange?.h6 ?? 0,
    chgH24: pair.priceChange?.h24 ?? 0,
  };
}

// Liquidity growth vs the most recent earlier snapshot (40 min - 8 h window, since scheduled runs can be late).
export function liquidityGrowth(snapshots, mint, liqUsd, now) {
  const prev = (snapshots[mint] ?? [])
    .filter((s) => now - s.t >= 40 * 60e3 && now - s.t <= 8 * HOUR)
    .sort((a, b) => b.t - a.t)[0];
  return prev && prev.liqUsd > 0 ? liqUsd / prev.liqUsd - 1 : null;
}

function demandFailure(c, m, cfg) {
  const d = cfg.demand;
  if (c.sources.size === 1 && c.sources.has('Graduated') && m.ageH > cfg.sources.graduatedMaxAgeHours)
    return 'graduated too long ago';
  if (m.priceUsd == null) return 'no price';
  if (m.liqUsd < d.minLiquidityUsd) return 'liquidity too low';
  if (m.mcapUsd < d.minMarketCapUsd) return 'market cap too low';
  if (m.ageH == null || m.ageH < d.minPairAgeHours) return 'pair too new';
  if (m.volH1 < d.minVolumeH1Usd) return '1h volume too low';
  if (m.buysH1 < d.minBuysH1) return 'too few buys (1h)';
  if (m.ratioH1 < d.minBuySellRatioH1) return 'buying not dominant (1h)';
  if (m.ratioH6 < d.minBuySellRatioH6) return 'buying not sustained (6h)';
  // Dozens of buys per sell, hour after hour, is a volume bot, not real demand.
  if (Math.max(m.ratioH1, m.ratioH6) > d.maxBuySellRatio) return 'unnatural buy/sell pattern (likely bots)';
  if (m.accel == null || m.accel < d.minVolumeAcceleration) return 'volume not accelerating';
  if (m.chgH1 < d.minPriceChangeH1Pct) return 'no 1h momentum';
  if (m.chgH1 > d.maxPriceChangeH1Pct) return 'already spiked (1h)';
  if (m.chgH6 < d.minPriceChangeH6Pct) return 'falling over 6h';
  if (m.liqGrowth == null && d.requireLiquidityHistory) return 'no liquidity history yet';
  if (m.liqGrowth != null && m.liqGrowth * 100 < d.minLiquidityGrowthPct) return 'liquidity shrinking';
  return null;
}

// 0-100. Weights favour sustained buying and accelerating volume over raw price moves.
function demandScore(m, cfg) {
  return (
    25 * clamp01(Math.log2(m.accel) / 2) + // 4x acceleration = full marks
    25 * clamp01(m.ratioH1 - 1) + // 2 buys per sell = full marks
    15 * clamp01((m.ratioH6 - 1) / 0.5) +
    15 * clamp01((m.liqGrowth ?? 0) / 0.25) + // +25% liquidity in ~1h = full marks
    10 * clamp01(m.chgH1 / 20) +
    10 * clamp01(Math.log10(m.volH1 / cfg.demand.minVolumeH1Usd) / 1.5)
  );
}

export async function safetyCheck(mint, cfg) {
  const s = cfg.safety;
  const risks = [];
  const info = (await getJson(`${GT}/networks/solana/tokens/${mint}/info`)).data?.attributes ?? {};
  let gp = null;
  try {
    const j = await getJson(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`);
    gp = j.result?.[mint] ?? null;
  } catch {
    /* handled below */
  }
  const on = (x) => x?.status === '1';
  const off = (x) => x?.status === '0';
  const fail = (reason) => ({ ok: false, reason });

  if (info.mint_authority === 'yes' || on(gp?.mintable)) return fail('supply can still be minted');
  if (!(info.mint_authority === 'no' || off(gp?.mintable))) return fail('mint authority unknown');
  if (info.freeze_authority === 'yes' || on(gp?.freezable)) return fail('wallets can be frozen');
  if (!(info.freeze_authority === 'no' || off(gp?.freezable))) return fail('freeze authority unknown');
  if (info.is_honeypot === 'yes') return fail('flagged as honeypot');

  if (gp) {
    if (gp.non_transferable === '1') return fail('non-transferable token');
    if (gp.transfer_hook?.length) return fail('has transfer hook');
    if (Object.keys(gp.transfer_fee ?? {}).length) return fail('has transfer fee');
    if (on(gp.balance_mutable_authority)) return fail('balances can be changed by an authority');
    if (on(gp.closable)) return fail('token can be closed');
    if (gp.default_account_state === '2') return fail('new accounts frozen by default');
    if (on(gp.transfer_fee_upgradable)) risks.push('a transfer fee could be added later');
    if (on(gp.metadata_mutable)) risks.push('token name/metadata can still be changed');
  } else {
    risks.push('GoPlus security check unavailable this run');
  }

  const holders = info.holders?.count ?? null;
  const top10 = num(info.holders?.distribution_percentage?.top_10);
  const devPct = num(info.developer_holding_percentage);
  if (holders == null || top10 == null) return fail('holder data unavailable');
  if (holders < s.minHolders) return fail('too few holders');
  if (top10 > s.maxTop10HolderPct) return fail('top 10 wallets hold too much');
  if (devPct != null && devPct > s.maxDevHoldingPct) return fail('developer holds too much');

  if (top10 > 40) risks.push(`top 10 wallets hold ${top10.toFixed(0)}% (includes the liquidity pool)`);
  if (devPct != null && devPct > 3) risks.push(`developer wallet holds ${devPct.toFixed(1)}%`);
  if (info.is_honeypot !== 'no') risks.push('no independent honeypot verdict; sellability based on a live sell quote only');

  return { ok: true, risks, holders, top10, devPct, decimals: info.decimals ?? null, gtScore: info.gt_score ?? null };
}

// Round-trip quote on Jupiter: $usd USDC -> token -> USDC (default: the monitor position). A missing sell route = treat as unsellable.
export async function costCheck(mint, cfg, usd = cfg.positionUsd) {
  const c = cfg.costs;
  const amount = Math.round(usd * 1e6);
  const q = (inMint, outMint, amt) =>
    getJson(`${JUP}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amt}&slippageBps=${c.slippageBps}`, {
      retries: 1,
    });
  let buy, sell;
  try {
    buy = await q(USDC, mint, amount);
  } catch {
    return { ok: false, reason: 'no buy route' };
  }
  if (!buy?.outAmount || buy.outAmount === '0') return { ok: false, reason: 'no buy route' };
  try {
    sell = await q(mint, USDC, buy.outAmount);
  } catch {
    return { ok: false, reason: 'no sell route (possible honeypot)' };
  }
  if (!sell?.outAmount || sell.outAmount === '0') return { ok: false, reason: 'no sell route (possible honeypot)' };

  const sellOutUsd = Number(sell.outAmount) / 1e6;
  const dexRoundTripUsd = Math.max(0, usd - sellOutUsd);
  const buyFeeUsd = fomoFee(usd, c);
  const sellFeeUsd = fomoFee(sellOutUsd, c);
  const totalUsd = dexRoundTripUsd + buyFeeUsd + sellFeeUsd;
  const out = {
    tokensOutRaw: buy.outAmount,
    dexRoundTripUsd,
    dexRoundTripPct: (dexRoundTripUsd / usd) * 100,
    buyFeeUsd,
    sellFeeUsd,
    totalUsd,
    totalPct: (totalUsd / usd) * 100,
    route: buy.routePlan?.map((r) => r.swapInfo?.label).join(' > '),
  };
  if (out.dexRoundTripPct > c.maxDexRoundTripPct) return { ok: false, reason: 'slippage/pool costs too high' };
  if (out.totalPct > c.maxTotalCostPct) return { ok: false, reason: 'total trading cost too high' };
  return { ok: true, ...out };
}

export async function screen(cfg, store, now, log) {
  const candidates = await collectCandidates(cfg, log);
  const cooldownMs = cfg.cooldownDays * 24 * HOUR;
  const blocked = new Set(
    store.alerts.filter((a) => a.status === 'open' || now - Date.parse(a.alertedAt) < cooldownMs).map((a) => a.mint),
  );
  const pool = candidates.filter((c) => !blocked.has(c.mint));
  const pairs = await dexPairs(pool.map((c) => c.mint), log);

  const rejects = {};
  const reject = (why) => (rejects[why] = (rejects[why] ?? 0) + 1);
  const passed = [];

  for (const c of pool) {
    const pair = pairs.get(c.mint);
    if (!pair) {
      reject('no DEX pair found');
      continue;
    }
    const m = metrics(pair, now);
    m.liqGrowth = liquidityGrowth(store.snapshots, c.mint, m.liqUsd, now);
    (store.snapshots[c.mint] ??= []).push({ t: now.getTime(), liqUsd: m.liqUsd, priceUsd: m.priceUsd });
    const why = demandFailure(c, m, cfg);
    if (why) reject(why);
    else passed.push({ ...c, pair, m, demandScore: demandScore(m, cfg) });
  }

  // Each demand-passing candidate gets an outcome group, so runner-ups can be tracked against alerts.
  passed.sort((a, b) => b.demandScore - a.demandScore);
  const qualified = [];
  for (const [i, c] of passed.entries()) {
    if (i >= cfg.safety.maxChecksPerRun) {
      Object.assign(c, { group: 'not checked', outcome: 'outside top checks this run' });
      continue;
    }
    try {
      const safety = await safetyCheck(c.mint, cfg);
      if (!safety.ok) {
        reject(safety.reason);
        Object.assign(c, { group: 'failed safety', outcome: safety.reason });
        continue;
      }
      const cost = await costCheck(c.mint, cfg);
      if (!cost.ok) {
        reject(cost.reason);
        Object.assign(c, { safety, group: 'failed cost/sellability', outcome: cost.reason });
        continue;
      }
      // Penalise pool costs and heavy concentration; FOMO's fixed fees are the same for every token.
      const score = c.demandScore - 3 * cost.dexRoundTripPct - Math.max(0, safety.top10 - 40) * 0.5;
      Object.assign(c, { safety, cost, score });
      if (score < cfg.minScore) {
        reject('score below bar');
        Object.assign(c, { group: 'below score bar', outcome: `score ${score.toFixed(1)}` });
        continue;
      }
      qualified.push(c);
    } catch (e) {
      reject('check failed (API error)');
      Object.assign(c, { group: 'not checked', outcome: 'API error during checks' });
      log.errors.push(`checks ${c.mint}: ${e.message}`);
    }
  }
  qualified.sort((a, b) => b.score - a.score);
  for (const c of qualified.slice(1)) Object.assign(c, { group: 'runner-up', outcome: `qualified, score ${c.score.toFixed(1)}` });

  Object.assign(log, {
    candidates: candidates.length,
    skippedRecentlyAlerted: candidates.length - pool.length,
    passedDemand: passed.length,
    qualified: qualified.length,
    rejects,
    topDemand: passed.slice(0, 5).map((c) => ({ symbol: c.pair.baseToken?.symbol, score: +c.demandScore.toFixed(1) })),
  });
  return { best: qualified[0] ?? null, others: passed.filter((c) => c !== qualified[0]), candidates, pairs };
}
