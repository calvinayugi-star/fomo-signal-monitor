// FOMO Compounder v2 (paper mode, since 2026-10-10): one position at a time, 100% of the bankroll.
// Goal: buy a token BEFORE it spikes (volume and buying building while the price is still flat),
// hold it with no stop until it is +targetNetPct net, sell, and look for the next one. Since 2026-10-27 a position that hasn't
// reached its target maxHoldHours (6) after the fill is sold at its last price and the run searches again.
// Since 2026-10-16 Graduated and Trending tokens are scored alike (list adjustments 0). Since 2026-10-20 two variants (config compounder.variants):
// the Conservative Compounder (+13.93% per day, $110 seed) and the Aggressive Compounder (+20% per trade, $25 seed). Same rules and hourly candidates,
// each its own run and bankroll; they never hold the same token at once. Since 2026-10-24 entry rules can differ per variant (Conservative: pairs 72h+ old,
// Aggressive: 15-60 min) and neither buys a token up more than 25% in the last 15 min. Since 2026-10-21 the runs loop: once a run's bankroll reaches goalUsd ($5,000) + its seed,
// it is all cash, $5,000+ is cashed out, and a new cycle starts from the seed at the next hourly run (one ledger run per cycle). Runs inside the hourly monitor job:
//   settle the open position on 1-minute candles -> screen for pre-spike setups -> BUY / HOLD / NO TRADE.
// Records: data/compounder-run.json (ledger, never deleted; the v1 October run stays in it),
// data/compounder-hourly.jsonl (every hourly decision and the candidates that passed the cheap checks), COMPOUNDER.md.
import fs from 'node:fs';
import path from 'node:path';
import { getJson } from './http.js';
import { collectCandidates, GT } from './sources.js';
import { dexPairs, safetyCheck, costCheck, metrics, liquidityGrowth } from './screen.js';
import { sendTelegram, esc } from './telegram.js';
import { openPosition, findFill, replayTarget, priceForNet, netAt } from './compounder-sim.js';
import { compounderMarkdown, summaryLine, dailyReport, runStats, bankrollOf, goalBankroll, entryFor, usd, price } from './compounder-report.js';
import { makeTime } from './time.js';

const HOUR = 3600e3;
const pctChange = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
const signed = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const round = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(d) : x ?? null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x) => clamp(Number.isFinite(x) ? x : 0, 0, 1);

// GeckoTerminal 1-minute candles covering [fromMs, toMs], paging back up to `pages` x 1000 minutes.
export async function minuteCandles(pairAddress, mint, fromMs, toMs, pages = 3) {
  const out = new Map();
  let before = Math.floor(toMs / 1000);
  for (let i = 0; i < pages; i++) {
    const j = await getJson(
      `${GT}/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${mint}&before_timestamp=${before}`,
    );
    const list = j.data?.attributes?.ohlcv_list ?? [];
    for (const c of list) out.set(c[0], c);
    if (!list.length) break;
    const oldest = Math.min(...list.map((c) => c[0]));
    if (oldest * 1000 <= fromMs || oldest >= before) break;
    before = oldest;
  }
  return [...out.values()].filter((c) => c[0] * 1000 >= fromMs - 5 * 60e3).sort((a, b) => a[0] - b[0]);
}

// Up to the last hour on completed 5-minute candles (at least 15 min, since entries are 15-60 min old tokens from 2026-10-21):
// 15-minute change and volume trend (last 15 min vs the average 15 min over the candles available).
async function fiveMinuteStats(pairAddress, mint, nowMs) {
  const j = await getJson(
    `${GT}/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=5&limit=16&currency=usd&token=${mint}`,
  );
  const done = (j.data?.attributes?.ohlcv_list ?? [])
    .filter((c) => (c[0] + 300) * 1000 <= nowMs)
    .sort((a, b) => a[0] - b[0])
    .slice(-12);
  if (done.length < 3) return null;
  const vol = (cs) => cs.reduce((s, c) => s + c[5], 0);
  return {
    chg15: pctChange(done.at(-1)[4], done.at(-4)?.[4] ?? done[0][1]),
    volTrend: vol(done.slice(-3)) / Math.max(vol(done) / (done.length / 3), 1e-9),
  };
}

// --- entry screen --------------------------------------------------------------------------------

const listOf = (sources) => sources.join(' + ');
const ageText = (h) => (h < 2 ? `${Math.round(h * 60)} min` : h < 72 ? `${Math.round(h)}h` : `${Math.round(h / 24)} days`);

function entryRow(c, pair, nowMs, snapshots) {
  const m = metrics(pair, nowMs);
  return {
    symbol: pair.baseToken?.symbol,
    mint: c.mint,
    pairAddress: pair.pairAddress,
    sources: [...c.sources],
    priceUsd: m.priceUsd,
    liqUsd: Math.round(m.liqUsd),
    mcapUsd: Math.round(m.mcapUsd),
    ageH: round(m.ageH, 1),
    volH1: Math.round(m.volH1),
    buysH1: m.buysH1,
    ratioH1: round(m.ratioH1),
    ratioH6: round(m.ratioH6),
    accel: round(m.accel),
    chgM5: pair.priceChange?.m5 ?? 0,
    chgH1: m.chgH1,
    chgH6: m.chgH6,
    liqGrowth: round(liquidityGrowth(snapshots ?? {}, c.mint, m.liqUsd, nowMs), 3),
  };
}

// Checks that need no extra API calls: real, building demand while the price has not moved much yet.
function entryFailure(r, sizeUsd, blocked, taken, e) {
  if (r.priceUsd == null) return 'no price';
  if (r.ageH == null || r.ageH < e.minPairAgeHours) return 'pair too new';
  if (e.maxPairAgeHours && r.ageH > e.maxPairAgeHours) return `older than ${e.maxPairAgeHours}h`;
  if (r.liqUsd < Math.max(e.minLiquidityUsd, e.minLiquidityMultipleOfPosition * sizeUsd)) return 'liquidity too thin for the position';
  if (r.mcapUsd < e.minMarketCapUsd) return 'market cap too low';
  if (r.volH1 < e.minVolumeH1Usd) return '1h volume too low';
  if (r.buysH1 < e.minBuysH1) return 'too few buys (1h)';
  if (r.ratioH1 < e.minBuySellRatioH1) return 'buying not dominant (1h)';
  if (r.ratioH6 < e.minBuySellRatioH6) return 'buying not sustained (6h)';
  if (Math.max(r.ratioH1, r.ratioH6) > e.maxBuySellRatio) return 'unnatural buy/sell pattern (likely bots)';
  // A pair under ~1.5h old has no earlier hours to compare with (accel null), so this check only applies to older pairs.
  if (r.accel != null && r.accel < e.minVolumeAcceleration) return 'volume not building';
  // For pairs younger than priceWindowsMinAgeHours the 1h/6h change is the change since the pool opened, so no price windows (user choice 2026-10-21).
  const windows = !(r.ageH < (e.priceWindowsMinAgeHours ?? 0));
  if (windows && r.chgH1 < e.minChgH1Pct) return 'falling (1h)';
  if (windows && r.chgH1 > e.maxChgH1Pct) return `already moving (>${e.maxChgH1Pct}% 1h)`;
  if (windows && r.chgH6 < e.minChgH6Pct) return 'falling over 6h';
  if (windows && r.chgH6 > e.maxChgH6Pct) return `already spiked (>${e.maxChgH6Pct}% 6h)`;
  if (r.liqGrowth != null && r.liqGrowth * 100 < e.minLiquidityGrowthPct) return 'liquidity shrinking';
  if (blocked.has(r.mint)) return 'held or sold in the cooldown window';
  if (taken.has(r.mint)) return 'held by the other compounder';
  return null;
}

// 0-85 plus the list adjustment (Graduated bonus only within graduatedBonusMaxAgeHours) minus the large-cap penalty; stage 2 adds up to 15 for the
// 15-min volume trend. Weights re-set 2026-10-16 from 36 stage-2 near-misses: strong 1h buying and an hour already rising +5..15% hit +20% most often,
// volume acceleration barely separated (the filter already requires it), and tokens over $50M market cap almost never rose enough (1 of 12).
function preScore(r, e) {
  const list = !r.sources.includes('Graduated') ? -e.trendingOnlyPenalty : r.ageH <= e.graduatedBonusMaxAgeHours ? e.graduatedBonus : 0;
  return (
    15 * clamp01(Math.log2(r.accel) / 2) + // 4x volume acceleration = full marks
    30 * clamp01(r.ratioH1 - 1) + // 2 buys per sell = full marks
    15 * clamp01((r.ratioH6 - 1) / 0.5) +
    10 * clamp01((r.liqGrowth ?? 0) / 0.25) + // +25% liquidity in ~1h = full marks
    15 * clamp01(r.chgH1 / 10) + // price up 10% in the hour = full marks
    list -
    (r.mcapUsd >= e.largeMcapUsd ? e.largeMcapPenalty : 0)
  );
}

// API results shared by all variants within one hourly run, so running several variants doesn't multiply calls.
function makeCache(cfg, nowMs) {
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn().catch((err) => (memo.delete(key), Promise.reject(err))));
    return memo.get(key);
  };
  return {
    fiveMinuteStats: (r) => once(`5m|${r.mint}`, () => fiveMinuteStats(r.pairAddress, r.mint, nowMs)),
    safetyCheck: (r) => once(`safety|${r.mint}`, () => safetyCheck(r.mint, cfg)),
    costCheck: (r, usd) => once(`cost|${r.mint}|${Math.round(usd)}`, () => costCheck(r.mint, cfg, usd)),
  };
}

async function screenPreSpike({ rows, sizeUsd, e, cache, log }) {
  const open = rows.filter((r) => !r.reason);
  for (const r of open) r.score = round(preScore(r, e), 1);
  open.sort((a, b) => b.score - a.score);

  let candleChecks = 0;
  for (const r of open) {
    if (candleChecks++ >= e.maxCandleChecks) {
      r.reason = 'not checked (candle check limit)';
      continue;
    }
    try {
      const s = await cache.fiveMinuteStats(r);
      if (!s) {
        r.reason = 'under 15 min of 5-min candles';
        continue;
      }
      Object.assign(r, { chg15: round(s.chg15), volTrend: round(s.volTrend) });
      // 15-min spike cap restored 2026-10-24 (user choice): Coca Cola was bought +65% in 15 min and rugged; CYBERDACITY (−6%) hit +20%.
      if (e.maxChg15mPct != null && s.chg15 > e.maxChg15mPct) r.reason = `spiking (>${e.maxChg15mPct}% in 15 min)`;
      else if (!(s.volTrend >= e.minVolumeTrend15m)) r.reason = 'volume not building (15 min)';
      else r.score = round(r.score + 15 * clamp01((s.volTrend - 1) / 2), 1); // 3x the hour's 15-min average = full marks
    } catch (err) {
      r.reason = 'candle data unavailable';
      log.errors.push(`compounder candles ${r.symbol}: ${err.message}`);
    }
  }

  const ranked = rows.filter((r) => !r.reason).sort((a, b) => b.score - a.score);
  let best = null;
  let safetyChecks = 0;
  for (const r of ranked) {
    if (best) {
      r.reason = 'runner-up';
      continue;
    }
    if (r.score < e.minScore) {
      r.reason = 'score below bar';
      continue;
    }
    if (safetyChecks++ >= e.maxSafetyChecks) {
      r.reason = 'not checked (safety check limit)';
      continue;
    }
    try {
      const safety = await cache.safetyCheck(r);
      if (!safety.ok) {
        Object.assign(r, { reason: safety.reason, unsafe: true });
        continue;
      }
      Object.assign(r, { holders: safety.holders, top10Pct: round(safety.top10, 1), risks: safety.risks });
      // On young tokens a very even holder spread usually means one party split supply across many wallets:
      // 7 of 9 such alerts went to near zero (2026-10 evaluation).
      if (r.ageH < e.youngMaxAgeHours && safety.top10 <= e.youngMinTop10Pct) {
        Object.assign(r, { reason: 'holder spread suspiciously even (likely bundled wallets)', unsafe: true });
        continue;
      }
      const cost = await cache.costCheck(r, sizeUsd);
      if (!cost.ok) {
        Object.assign(r, { reason: cost.reason, unsafe: true });
        continue;
      }
      r.roundTripPct = round(cost.totalPct);
      r.dexRoundTripPct = round(cost.dexRoundTripPct);
      r.score = round(r.score - 3 * cost.dexRoundTripPct, 1);
      if (cost.totalPct > e.maxRoundTripPct) r.reason = `round trip ${r.roundTripPct}% at this size`;
      else if (r.score < e.minScore) r.reason = 'score below bar after costs';
      else best = r;
    } catch (err) {
      r.reason = 'check failed (API error)';
      log.errors.push(`compounder checks ${r.symbol}: ${err.message}`);
    }
  }
  return best;
}

// --- run lifecycle -------------------------------------------------------------------------------

// prev: the variant's last cycle when it reached its goal; the new cycle carries the cycle number and the total cashed out so far.
function newRun(now, k, time, v, prev) {
  const cycle = prev ? (prev.cycle ?? 1) + 1 : 1;
  return {
    id: `v2-${v.id}-${time.localDate(now)}${cycle > 1 ? `-c${cycle}` : ''}`,
    rules: k.rules,
    variant: v.id,
    ...(v.name ? { name: v.name } : {}),
    per: v.per ?? 'trade',
    mode: 'paper',
    seedUsd: v.seedUsd ?? k.seedUsd,
    ...(v.goalUsd ? { goalUsd: v.goalUsd, cycle, cashedOutBeforeUsd: prev ? round((prev.cashedOutBeforeUsd ?? 0) + (prev.cashOutUsd ?? 0)) : 0 } : {}),
    targetNetPct: v.targetNetPct,
    startedAt: now.toISOString(),
    endsAt: null, // open-ended: positions are never sold below the target
    status: 'active',
    cash: v.seedUsd ?? k.seedUsd,
    position: null,
    trades: [],
  };
}

// Checks the open position on 1-minute candles since the last check; closes it only at the target.
async function settle(run, cfg, now) {
  const k = cfg.compounder;
  const pos = run.position;
  const fillAt = Date.parse(pos.decidedAt) + k.fillDelayMinutes * 60e3;
  if (now < fillAt + 60e3) return null;
  const from = pos.checkedThrough ? (pos.checkedThrough + 60) * 1000 : Date.parse(pos.decidedAt);
  const pages = clamp(Math.ceil((now - from) / 60e3 / 1000) + 1, 1, 10);
  const candles = (await minuteCandles(pos.pairAddress, pos.mint, from, now.getTime(), pages)).filter(
    (c) => c[0] * 1000 + 60e3 <= now && (!pos.checkedThrough || c[0] > pos.checkedThrough), // completed minutes only
  );

  if (!pos.fill) {
    const fill = findFill(candles, fillAt);
    if (!fill) return now - fillAt > k.noFillCancelHours * HOUR ? { noFill: true } : null;
    pos.fill = { rawPrice: fill.rawPrice, fillCandleT: fill.fillCandleT, at: new Date(fillAt).toISOString() };
    pos.checkedThrough = fill.fillCandleT;
  }
  // Time limit (since 2026-10-27, config maxHoldHours, per-variant override): if the target isn't reached within that many hours
  // of the fill, the position is sold at the last price before that time. A one-off exit the user asked for (config oneOffExits)
  // applies the same way to the matching position only.
  const oneOff = (k.oneOffExits ?? []).find((x) => x.mint === pos.mint && x.decidedAt === pos.decidedAt);
  const limitH = oneOff?.afterHours ?? holdLimit(run, k);
  const closeAtMs = limitH ? Date.parse(pos.fill.at) + limitH * HOUR : Infinity;
  const after = candles.filter((c) => c[0] > pos.fill.fillCandleT && c[0] * 1000 < closeAtMs);
  const p = openPosition({ sizeUsd: pos.sizeUsd, rawEntry: pos.fill.rawPrice, dexRoundTripPct: pos.dexRoundTripPct, costs: cfg.costs });
  // Near the goal (goalUsd to cash out + the seed kept for the next cycle), the position is sold as soon as the bankroll would reach it
  // (always a gain: the position is the whole bankroll and below the goal).
  const goalNetPct = run.goalUsd ? ((goalBankroll(run) - run.cash) / pos.sizeUsd - 1) * 100 : Infinity;
  const res = replayTarget(p, after, Math.min(run.targetNetPct, goalNetPct), cfg.costs);
  if (res.closed && goalNetPct < run.targetNetPct) res.reason = `${usd(goalBankroll(run))} goal reached`;
  if (Number.isFinite(res.high)) pos.peakNetPct = round(Math.max(pos.peakNetPct ?? -100, netAt(p, res.high, cfg.costs).netPct));
  if (Number.isFinite(res.low)) pos.worstNetPct = round(Math.min(pos.worstNetPct ?? 0, netAt(p, res.low, cfg.costs).netPct));
  if (res.closed) return res;
  if (now >= closeAtMs) {
    const rawExit = res.lastPrice ?? pos.mark?.price ?? pos.fill.rawPrice;
    return { closed: true, rawExit, exitAt: closeAtMs, reason: `${oneOff ? 'one-off ' : ''}${limitH}h ${oneOff ? 'exit' : 'time limit'} (target not reached)`, targetHit: false, ...netAt(p, rawExit, cfg.costs) };
  }

  if (after.length) {
    pos.checkedThrough = after.at(-1)[0];
    pos.lastTradeAt = new Date(res.lastAt).toISOString();
    const n = netAt(p, res.lastPrice, cfg.costs);
    pos.mark = { at: pos.lastTradeAt, price: res.lastPrice, netPct: round(n.netPct), proceeds: round(n.proceeds) };
  }
  pos.targetPriceUsd = res.targetPrice;
  const lastTrade = Date.parse(pos.lastTradeAt ?? pos.fill.at);
  pos.stale = now - lastTrade > k.staleAfterHours * HOUR;
  return res;
}

function recordClose(run, res, now) {
  const pos = run.position;
  const prevBankroll = run.cash + pos.sizeUsd;
  const base = {
    n: run.trades.length + 1,
    symbol: pos.symbol,
    mint: pos.mint,
    pairAddress: pos.pairAddress,
    list: pos.list,
    decidedAt: pos.decidedAt,
    prevBankroll: round(prevBankroll),
    sizeUsd: round(pos.sizeUsd),
    dexRoundTripPct: pos.dexRoundTripPct,
  };
  let trade;
  if (res.noFill) {
    trade = { ...base, noFill: true, reason: 'not filled (no trades after the decision)', netUsd: 0, netPct: 0, costsUsd: 0, newBankroll: round(prevBankroll) };
  } else {
    const grossPct = pctChange(res.rawExit, pos.fill.rawPrice);
    trade = {
      ...base,
      fillAt: pos.fill.at,
      exitAt: new Date(res.exitAt).toISOString(),
      holdHours: round((res.exitAt - Date.parse(pos.fill.at)) / HOUR, 1),
      reason: res.reason,
      entryPriceUsd: pos.fill.rawPrice,
      exitPriceUsd: res.rawExit,
      grossPct: round(grossPct),
      costsUsd: round(pos.sizeUsd * (1 + grossPct / 100) - res.proceeds, 4),
      netUsd: round(res.netUsd, 4),
      netPct: round(res.netPct),
      worstNetPct: pos.worstNetPct ?? null,
      targetHit: res.targetHit !== false,
      newBankroll: round(run.cash + res.proceeds, 4),
    };
  }
  run.trades.push(trade);
  run.cash = trade.newBankroll;
  run.position = null;
  return trade;
}

function finishRun(run, status, now, note) {
  Object.assign(run, { status, endedAt: now.toISOString(), finalBankroll: round(run.cash) }, note ? { note } : {});
}

// --- messages ------------------------------------------------------------------------------------

const PAPER = '📝 <b>PAPER MODE: tracking only, do not trade</b>';
const holdLimit = (run, k) => k.variants.find((v) => v.id === run.variant)?.maxHoldHours ?? k.maxHoldHours;
const tag = (run) =>(run.name ? run.name.toUpperCase() : `COMPOUNDER +${run.targetNetPct}%/${run.per === 'day' ? 'day' : 'trade'}`);

function buyMessage(run, r, pos, k, cfg, time, now) {
  const p = openPosition({ sizeUsd: pos.sizeUsd, rawEntry: r.priceUsd, dexRoundTripPct: r.dexRoundTripPct, costs: cfg.costs });
  const targetPx = priceForNet(p, run.targetNetPct, cfg.costs);
  return `${PAPER}
🔁 <b>${tag(run)}: BUY $${esc(r.symbol)}</b> (${esc(listOf(r.sources))})
<code>${r.mint}</code>

<b>TIME:</b> ${time.when(now)}
<b>BANKROLL:</b> ${usd(bankrollOf(run))} · <b>POSITION:</b> ${usd(pos.sizeUsd)} (100%)
<b>ENTRY:</b> ~$${price(r.priceUsd)} (paper fill ${k.fillDelayMinutes} min after this alert)
<b>SELL TARGET:</b> +${run.targetNetPct}% net ≈ $${price(targetPx)} (${signed(pctChange(targetPx, r.priceUsd), 0)} in price) → ~${usd(pos.sizeUsd * (1 + run.targetNetPct / 100))}
<b>STOP:</b> none.${holdLimit(run, k) ? ` <b>TIME LIMIT:</b> sold at its last price if the target isn't reached ${holdLimit(run, k)}h after the fill.` : ' Held until the target is reached, however long that takes.'}

<b>WHY (pre-spike setup):</b>
• Price: 1h ${signed(r.chgH1)}, 6h ${signed(r.chgH6)}, 15 min ${signed(r.chg15)}
• Volume: ${r.accel != null ? `last hour ${r.accel.toFixed(1)}× the hours before; ` : ''}last 15 min ${r.volTrend.toFixed(1)}× the average 15 min · pair ${ageText(r.ageH)} old
• Buying: ${r.ratioH1.toFixed(2)} buys per sell (1h), ${r.ratioH6.toFixed(2)} (6h)
• Liquidity $${Math.round(r.liqUsd / 1000)}k${r.liqGrowth != null ? ` (${signed(r.liqGrowth * 100, 0)} vs last check)` : ''}, ${r.holders ?? 'n/a'} holders, top 10 hold ${r.top10Pct ?? 'n/a'}%
• Round trip costs ~${r.roundTripPct}% at this size · score ${r.score}
${r.risks?.length ? `\nRisks: ${r.risks.map(esc).join('; ')}; memecoins can go to zero before the target or the time limit` : ''}
<a href="https://dexscreener.com/solana/${r.pairAddress}">DexScreener</a>`;
}

function tradeReport(run, t) {
  const s = runStats(run);
  if (t.noFill)
    return `${PAPER}\n🔁 <b>${tag(run)}: $${esc(t.symbol)} not filled</b>: no trades after the decision. Bankroll unchanged at ${usd(t.newBankroll)}.`;
  return `${PAPER}
${t.targetHit ? `✅ <b>${tag(run)}: SOLD $${esc(t.symbol)} at the +${run.targetNetPct}% target</b>` : `⏹ <b>${tag(run)}: SOLD $${esc(t.symbol)}</b>: ${esc(t.reason)},`} after ${t.holdHours}h

Entry → exit: $${price(t.entryPriceUsd)} → $${price(t.exitPriceUsd)} (${signed(t.grossPct)} gross)
Fees/slippage: ${usd(t.costsUsd)}
${t.netUsd >= 0 ? 'Profit' : 'Loss'}: <b>${t.netUsd >= 0 ? '+' : ''}${usd(t.netUsd)}</b> (${signed(t.netPct)} net)
Worst point while held: ${signed(t.worstNetPct)}
Bankroll: ${usd(t.prevBankroll)} → <b>${usd(t.newBankroll)}</b> (${signed((t.newBankroll / run.seedUsd - 1) * 100, 0)} since the $${run.seedUsd} start)
Completed: ${s.trades} · ${run.per === 'day' ? "Searching again unless today's goal is met." : 'Searching for the next pre-spike token now.'}`;
}

function staleMessage(run, k, time) {
  const pos = run.position;
  return `${PAPER}
⚠️ <b>${tag(run)}: $${esc(pos.symbol)} has had no trades for ${k.staleAfterHours}h+</b> (last trade ${time.when(new Date(pos.lastTradeAt ?? pos.fill.at))}).
It may be dead (liquidity pulled). Per the rules it is still held until +${run.targetNetPct}%; last mark ${signed(pos.mark?.netPct)}.`;
}

// --- hourly entry point --------------------------------------------------------------------------

export async function runCompounder({ cfg, candidates, pairs, snapshots, dryRun, dataDir, reportPath, log }) {
  const k = cfg.compounder;
  const time = makeTime(cfg.displayTimezone);
  const now = new Date();
  const ledgerFile = path.join(dataDir, 'compounder-run.json');
  let ledger = { runs: [] };
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch {
    /* first run */
  }
  const send = (html) => sendTelegram(html, { dryRun });
  const hourly = { t: now.toISOString(), rules: k.rules, errors: [], variants: {} };

  // 1. A run under older rules, or started before a restart the user asked for (config restart.at), is closed
  // (kept in the ledger) and the current rules start again from the seed.
  // A restart can name the variants it applies to (2026-10-24: only the Conservative Compounder).
  const restartOf = (r) => [].concat(k.restart ?? []).find((x) => r.startedAt < x.at && (!x.variants || x.variants.includes(r.variant)));
  const beforeRestart = (r) => !!restartOf(r);
  for (const old of ledger.runs.filter((r) => r.status === 'active' && (r.rules !== k.rules || beforeRestart(r)))) {
    const restarted = old.rules === k.rules;
    const closed = old.position?.symbol;
    if (old.position) {
      const m = old.position.mark;
      old.trades.push({ n: old.trades.length + 1, symbol: old.position.symbol, decidedAt: old.position.decidedAt, reason: `${restarted ? 'restart' : 'rules changed'} (closed at last mark)`, netPct: m?.netPct ?? 0, netUsd: m ? m.proceeds - old.position.sizeUsd : 0, costsUsd: 0, targetHit: false, newBankroll: round(old.cash + (m?.proceeds ?? old.position.sizeUsd)) });
      old.cash = old.trades.at(-1).newBankroll;
      old.position = null;
    }
    finishRun(old, 'ended', now, restarted ? restartOf(old).note : `rules changed to ${k.rules} on ${time.localDate(now)}`);
    if (restarted)
      await send(`${PAPER}\n⏹ <b>${tag(old)} ENDED</b> (restart)${closed ? `: $${esc(closed)} closed at its last mark (${signed(old.trades.at(-1).netPct)})` : ''}. Final bankroll ${usd(old.cash)} from $${old.seedUsd}.`);
  }

  // 2. One active run per variant. The single v2 run from before variants existed becomes the variant with its target.
  const v2 = () => ledger.runs.filter((r) => r.rules === k.rules && !beforeRestart(r));
  for (const r of v2()) if (!r.variant) r.variant = k.variants.find((v) => v.targetNetPct === r.targetNetPct)?.id ?? 't20';
  const runs = [];
  for (const v of k.variants) {
    let run = v2().find((r) => r.status === 'active' && r.variant === v.id);
    // A run that reached its goal is followed by a new cycle from the seed (the loop the user asked for on 2026-10-21).
    const last = v2().filter((r) => r.variant === v.id).at(-1);
    const prev = last?.status === 'completed' && last.goalUsd ? last : null;
    if (!run && time.localDate(now) >= k.startDate && (!last || prev)) {
      // A variant added later copies a sibling run that has no completed trades yet (same start, same open position):
      // with identical rules it would have made exactly the same decisions so far. Otherwise it starts fresh now.
      const twin = !prev && v2().find((r) => r.status === 'active' && r.trades.length === 0 && r.startedAt < now.toISOString() && r.seedUsd === (v.seedUsd ?? k.seedUsd));
      run = newRun(now, k, time, v, prev);
      if (twin) {
        Object.assign(run, { startedAt: twin.startedAt, cash: twin.cash, copiedFrom: twin.id });
        if (twin.position) {
          const { mark, peakNetPct, worstNetPct, lastTradeAt, stale, targetPriceUsd, ...pos } = structuredClone(twin.position);
          if (pos.fill) pos.checkedThrough = pos.fill.fillCandleT; // re-checked from the fill against this variant's target
          run.position = pos;
        }
      }
      ledger.runs.push(run);
      const same = twin ? ` (same start${twin.position ? ` and same open position, $${esc(twin.position.symbol)},` : ''} as ${esc(twin.id)})` : '';
      const cyc = prev ? ` cycle ${run.cycle}` : '';
      await send(`${PAPER}\n🔁 <b>${tag(run)}${cyc} STARTED</b> with $${run.seedUsd}${same}: buy before the spike, hold until +${v.targetNetPct}% net${holdLimit(run, k) ? ` (or sell at its last price after ${holdLimit(run, k)}h)` : ''}, repeat${run.per === 'day' ? `; once the day is up +${v.targetNetPct}%, no new buys until midnight ET` : ''}${run.goalUsd ? `; at ${usd(goalBankroll(run))} it cashes out ${usd(run.goalUsd)}+ and starts again from $${run.seedUsd}` : ''}${prev ? `. Cashed out so far: ${usd(run.cashedOutBeforeUsd)}` : ''}.`);
    }
    if (!run) continue;
    if (run.targetNetPct !== v.targetNetPct) {
      // A target change in config applies to the run (and any open position) from this hour on.
      (run.targetChanges ??= []).push({ at: now.toISOString(), from: run.targetNetPct, to: v.targetNetPct });
      run.targetNetPct = v.targetNetPct;
    }
    run.per = v.per ?? 'trade';
    runs.push(run);
  }

  // 3. Per variant: settle the open position (it closes only at its target), or screen for a new one when in cash.
  const cache = makeCache(cfg, now.getTime());
  let allPairs = null;
  for (const run of runs) {
    const h = { errors: [] };
    hourly.variants[run.variant] = h;
    // Per-day runs: the day's starting bankroll is its value at the first run after midnight (open position at its last mark).
    const today = time.localDate(now);
    if (run.per === 'day' && run.day?.date !== today) {
      if (run.day) (run.days ??= []).push({ ...run.day, endBankroll: round(bankrollOf(run)) });
      run.day = { date: today, startBankroll: round(bankrollOf(run)) };
    }
    if (run.position) {
      try {
        const wasStale = run.position.stale;
        const res = await settle(run, cfg, now);
        if (res?.closed || res?.noFill) {
          const t = recordClose(run, res, now);
          h.exit = { symbol: t.symbol, reason: t.reason, netPct: t.netPct, netUsd: t.netUsd, holdHours: t.holdHours };
          await send(tradeReport(run, t));
          if (run.goalUsd && run.cash >= goalBankroll(run) - 0.005) {
            // All cash: everything above the seed is cashed out; the seed starts the next cycle at the next hourly run.
            run.cashOutUsd = round(run.cash - run.seedUsd);
            finishRun(run, 'completed', now, `goal reached: cashed out ${usd(run.cashOutUsd)}, ${usd(run.seedUsd)} kept for the next cycle`);
            h.decision = 'GOAL REACHED (cashed out)';
            await send(`${PAPER}\n🏁 <b>${tag(run)}${run.cycle > 1 ? ` cycle ${run.cycle}` : ''}: GOAL REACHED</b>: $${run.seedUsd} → <b>${usd(run.cash)}</b> in ${run.trades.length} trades.
💵 Cash out <b>${usd(run.cashOutUsd)}</b> and keep $${run.seedUsd}. Total cashed out: ${usd((run.cashedOutBeforeUsd ?? 0) + run.cashOutUsd)}.
A new cycle starts from $${run.seedUsd} at the next hourly run.`);
          }
        } else if (run.position.stale && !wasStale) {
          await send(staleMessage(run, k, time));
        }
      } catch (err) {
        h.errors.push(`settle: ${err.message}`);
      }
    }
    // The daily goal counts only banked gains (in cash after a sale), never an open position's mark.
    if (run.per === 'day' && !run.position && !run.day.goalMetAt && run.cash >= run.day.startBankroll * (1 + run.targetNetPct / 100) - 0.005) {
      run.day.goalMetAt = now.toISOString();
      await send(`${PAPER}\n🎯 <b>${tag(run)}: daily goal met</b>: ${usd(run.day.startBankroll)} → ${usd(run.cash)} today (${signed((run.cash / run.day.startBankroll - 1) * 100)}). No new buys until midnight ET.`);
    }

    const rows = [];
    const rejects = {};
    try {
      if (run.status === 'completed') h.decision ??= 'GOAL REACHED (cashed out)';
      else if (run.position) h.decision = 'HOLD';
      else if (run.per === 'day' && run.day.goalMetAt) h.decision = 'NO TRADE (daily goal met)';
      else {
        if (!candidates) candidates = await collectCandidates(cfg, log);
        if (!allPairs) {
          const missing = candidates.filter((c) => !pairs?.has(c.mint)).map((c) => c.mint);
          allPairs = new Map([...(pairs ?? []), ...(missing.length ? await dexPairs(missing, log) : [])]);
        }
        const cooldownMs = k.cooldownHours * HOUR;
        const blocked = new Set(v2().filter((r) => r.variant === run.variant).flatMap((r) => r.trades).filter((t) => now - Date.parse(t.exitAt ?? t.decidedAt) < cooldownMs).map((t) => t.mint));
        // The runs never hold the same token at the same time (runs earlier in config order pick first in a shared hour).
        const taken = new Set(runs.filter((o) => o !== run && o.position && o.status === 'active').map((o) => o.position.mint));
        const sizeUsd = run.cash;
        const e = entryFor(k, run.variant);
        for (const c of candidates) {
          const pair = allPairs.get(c.mint);
          if (!pair) continue;
          const r = entryRow(c, pair, now.getTime(), snapshots);
          const why = entryFailure(r, sizeUsd, blocked, taken, e);
          if (why) rejects[why] = (rejects[why] ?? 0) + 1;
          else rows.push(r);
        }
        const best = await screenPreSpike({ rows, sizeUsd, e, cache, log: h });
        if (best) {
          run.position = {
            symbol: best.symbol,
            mint: best.mint,
            pairAddress: best.pairAddress,
            list: listOf(best.sources),
            decidedAt: now.toISOString(),
            alertPriceUsd: best.priceUsd,
            sizeUsd: round(sizeUsd, 4),
            dexRoundTripPct: best.dexRoundTripPct,
            roundTripPct: best.roundTripPct,
            score: best.score,
            entry: { chgH1: best.chgH1, chgH6: best.chgH6, chg15: best.chg15, accel: best.accel, volTrend: best.volTrend, ratioH1: best.ratioH1, ageH: best.ageH, top10Pct: best.top10Pct },
          };
          run.cash = round(run.cash - sizeUsd, 4);
          h.decision = 'BUY';
          h.best = best.symbol;
          await send(buyMessage(run, best, run.position, k, cfg, time, now));
        } else {
          h.decision = 'NO TRADE (cash)';
        }
      }
    } catch (err) {
      h.errors.push(`screen: ${err.message}`);
      h.decision ??= 'NO TRADE (error)';
    }
    Object.assign(h, {
      run: run.id,
      bankroll: round(bankrollOf(run)),
      position: run.position ? { symbol: run.position.symbol, mark: run.position.mark?.netPct ?? null, stale: !!run.position.stale } : null,
      rejects,
      candidates: rows,
    });
    hourly.errors.push(...h.errors.map((x) => `${run.variant} ${x}`));
  }
  if (!runs.length) hourly.decision = 'IDLE (no active run)';

  log.compounder = Object.fromEntries(Object.entries(hourly.variants).map(([id, h]) => [id, { decision: h.decision, bankroll: h.bankroll }]));
  log.errors.push(...hourly.errors.map((x) => `compounder ${x}`));
  for (const [id, h] of Object.entries(hourly.variants))
    console.log(`Compounder ${id}: ${h.decision}; bankroll ${h.bankroll}; ${h.candidates.length} candidates passed the cheap checks`);

  // Daily report: the active runs plus any that reached their goal in the last 24h, with a link to the full report.
  let hourlyLog = [];
  try {
    hourlyLog = fs.readFileSync(path.join(dataDir, 'compounder-hourly.jsonl'), 'utf8').trim().split('\n').slice(-30).map((l) => JSON.parse(l));
  } catch {
    /* no log yet */
  }
  const reportRuns = v2().filter((r) => r.status === 'active' || (r.status === 'completed' && now - Date.parse(r.endedAt) < 24 * HOUR));
  reportRuns.sort((a, b) => k.variants.findIndex((v) => v.id === a.variant) - k.variants.findIndex((v) => v.id === b.variant));
  const daily = reportRuns.length
    ? `${dailyReport(reportRuns, hourlyLog, now, time)}${k.reportUrl ? `\n\n<a href="${k.reportUrl}">Full report</a>` : ''}`
    : '';

  if (!dryRun) {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1) + '\n');
    fs.appendFileSync(path.join(dataDir, 'compounder-hourly.jsonl'), JSON.stringify(hourly) + '\n');
    fs.writeFileSync(reportPath, compounderMarkdown(ledger, cfg, now, time));
  }
  return daily || (runs.length ? runs : ledger.runs.slice(-1)).map((r) => summaryLine(r, now)).join('\n');
}
