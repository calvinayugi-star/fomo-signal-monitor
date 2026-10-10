// FOMO Compounder v2 (paper mode, since 2026-10-10): one position at a time, 100% of the bankroll.
// Goal: buy a token BEFORE it spikes (volume and buying building while the price is still flat),
// hold it with no stop and no time limit until it is +targetNetPct net (+50%), sell, and look for the next one.
// Graduated tokens are preferred over Trending ones. Runs inside the hourly monitor job:
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
import { compounderMarkdown, summaryLine, runStats, bankrollOf, usd, price } from './compounder-report.js';
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

// The last hour on completed 5-minute candles: 15-minute change and volume trend (last 15 min vs the hour's 15-min average).
async function fiveMinuteStats(pairAddress, mint, nowMs) {
  const j = await getJson(
    `${GT}/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=5&limit=16&currency=usd&token=${mint}`,
  );
  const done = (j.data?.attributes?.ohlcv_list ?? [])
    .filter((c) => (c[0] + 300) * 1000 <= nowMs)
    .sort((a, b) => a[0] - b[0])
    .slice(-12);
  if (done.length < 12) return null;
  const vol = (cs) => cs.reduce((s, c) => s + c[5], 0);
  return {
    chg15: pctChange(done.at(-1)[4], done.at(-4)[4]),
    volTrend: vol(done.slice(-3)) / Math.max(vol(done) / 4, 1e-9),
  };
}

// --- entry screen --------------------------------------------------------------------------------

const listOf = (sources) => (sources.length > 1 ? 'Both' : sources[0]);

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
function entryFailure(r, sizeUsd, blocked, e) {
  const gradOnly = r.sources.length === 1 && r.sources[0] === 'Graduated';
  if (gradOnly && r.ageH > e.graduatedMaxAgeHours) return 'graduated too long ago';
  if (r.priceUsd == null) return 'no price';
  if (r.ageH == null || r.ageH < e.minPairAgeHours) return 'pair too new';
  if (r.liqUsd < Math.max(e.minLiquidityUsd, e.minLiquidityMultipleOfPosition * sizeUsd)) return 'liquidity too thin for the position';
  if (r.mcapUsd < e.minMarketCapUsd) return 'market cap too low';
  if (r.volH1 < e.minVolumeH1Usd) return '1h volume too low';
  if (r.buysH1 < e.minBuysH1) return 'too few buys (1h)';
  if (r.ratioH1 < e.minBuySellRatioH1) return 'buying not dominant (1h)';
  if (r.ratioH6 < e.minBuySellRatioH6) return 'buying not sustained (6h)';
  if (Math.max(r.ratioH1, r.ratioH6) > e.maxBuySellRatio) return 'unnatural buy/sell pattern (likely bots)';
  if (r.accel == null || r.accel < e.minVolumeAcceleration) return 'volume not building';
  if (r.chgH1 < e.minChgH1Pct) return 'falling (1h)';
  if (r.chgH1 > e.maxChgH1Pct) return `already moving (>${e.maxChgH1Pct}% 1h)`;
  if (r.chgM5 > e.maxChgM5Pct) return 'spiking right now (5 min)';
  if (r.chgH6 < e.minChgH6Pct) return 'falling over 6h';
  if (r.chgH6 > e.maxChgH6Pct) return `already spiked (>${e.maxChgH6Pct}% 6h)`;
  if (r.liqGrowth != null && r.liqGrowth * 100 < e.minLiquidityGrowthPct) return 'liquidity shrinking';
  if (blocked.has(r.mint)) return 'held or sold in the cooldown window';
  return null;
}

// 0-100 plus the list adjustment. Rewards accelerating volume and buying pressure, not price already gained.
function preScore(r, e) {
  const list = r.sources.includes('Graduated') ? e.graduatedBonus : -e.trendingOnlyPenalty;
  return (
    30 * clamp01(Math.log2(r.accel) / 2) + // 4x volume acceleration = full marks
    25 * clamp01(r.ratioH1 - 1) + // 2 buys per sell = full marks
    15 * clamp01((r.ratioH6 - 1) / 0.5) +
    15 * clamp01((r.liqGrowth ?? 0) / 0.25) + // +25% liquidity in ~1h = full marks
    list
  );
}

async function screenPreSpike({ rows, sizeUsd, cfg, nowMs, log }) {
  const e = cfg.compounder.entry;
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
      const s = await fiveMinuteStats(r.pairAddress, r.mint, nowMs);
      if (!s) {
        r.reason = 'under 1h of 5-min candles';
        continue;
      }
      Object.assign(r, { chg15: round(s.chg15), volTrend: round(s.volTrend) });
      if (s.chg15 > e.maxChg15mPct) r.reason = 'spiking over the last 15 min';
      else if (s.chg15 < e.minChg15mPct) r.reason = 'falling over the last 15 min';
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
      const safety = await safetyCheck(r.mint, cfg);
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
      const cost = await costCheck(r.mint, cfg, sizeUsd);
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

function newRun(now, k, time) {
  return {
    id: `v2-${time.localDate(now)}`,
    rules: k.rules,
    mode: 'paper',
    seedUsd: k.seedUsd,
    targetNetPct: k.targetNetPct,
    startedAt: now.toISOString(),
    endsAt: null, // open-ended: positions are never sold below the target
    status: 'active',
    cash: k.seedUsd,
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
  const after = candles.filter((c) => c[0] > pos.fill.fillCandleT);
  const p = openPosition({ sizeUsd: pos.sizeUsd, rawEntry: pos.fill.rawPrice, dexRoundTripPct: pos.dexRoundTripPct, costs: cfg.costs });
  const res = replayTarget(p, after, k.targetNetPct, cfg.costs);
  if (Number.isFinite(res.high)) pos.peakNetPct = round(Math.max(pos.peakNetPct ?? -100, netAt(p, res.high, cfg.costs).netPct));
  if (Number.isFinite(res.low)) pos.worstNetPct = round(Math.min(pos.worstNetPct ?? 0, netAt(p, res.low, cfg.costs).netPct));
  if (res.closed) return res;

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
      targetHit: true,
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

function buyMessage(run, r, pos, k, cfg, time, now) {
  const p = openPosition({ sizeUsd: pos.sizeUsd, rawEntry: r.priceUsd, dexRoundTripPct: r.dexRoundTripPct, costs: cfg.costs });
  const targetPx = priceForNet(p, k.targetNetPct, cfg.costs);
  return `${PAPER}
🔁 <b>COMPOUNDER: BUY $${esc(r.symbol)}</b> (${esc(listOf(r.sources))})
<code>${r.mint}</code>

<b>TIME:</b> ${time.when(now)}
<b>BANKROLL:</b> ${usd(bankrollOf(run))} · <b>POSITION:</b> ${usd(pos.sizeUsd)} (100%)
<b>ENTRY:</b> ~$${price(r.priceUsd)} (paper fill ${k.fillDelayMinutes} min after this alert)
<b>SELL TARGET:</b> +${k.targetNetPct}% net ≈ $${price(targetPx)} (${signed(pctChange(targetPx, r.priceUsd), 0)} in price) → ~${usd(pos.sizeUsd * (1 + k.targetNetPct / 100))}
<b>STOP:</b> none. Held until the target is reached, however long that takes.

<b>WHY (pre-spike setup):</b>
• Price still quiet: 1h ${signed(r.chgH1)}, 6h ${signed(r.chgH6)}, 15 min ${signed(r.chg15)}
• Volume building: last hour ${r.accel.toFixed(1)}× the hours before; last 15 min ${r.volTrend.toFixed(1)}× the hour's average
• Buying: ${r.ratioH1.toFixed(2)} buys per sell (1h), ${r.ratioH6.toFixed(2)} (6h)
• Liquidity $${Math.round(r.liqUsd / 1000)}k${r.liqGrowth != null ? ` (${signed(r.liqGrowth * 100, 0)} vs last check)` : ''}, ${r.holders ?? 'n/a'} holders, top 10 hold ${r.top10Pct ?? 'n/a'}%
• Round trip costs ~${r.roundTripPct}% at this size · score ${r.score}
${r.risks?.length ? `\nRisks: ${r.risks.map(esc).join('; ')}; memecoins can go to zero and a position with no stop can be held at a loss indefinitely` : ''}
<a href="https://dexscreener.com/solana/${r.pairAddress}">DexScreener</a>`;
}

function tradeReport(run, t) {
  const s = runStats(run);
  if (t.noFill)
    return `${PAPER}\n🔁 <b>COMPOUNDER: $${esc(t.symbol)} not filled</b>: no trades after the decision. Bankroll unchanged at ${usd(t.newBankroll)}.`;
  return `${PAPER}
✅ <b>COMPOUNDER: SOLD $${esc(t.symbol)} at the +${run.targetNetPct}% target</b> after ${t.holdHours}h

Entry → exit: $${price(t.entryPriceUsd)} → $${price(t.exitPriceUsd)} (${signed(t.grossPct)} gross)
Fees/slippage: ${usd(t.costsUsd)}
Profit: <b>+${usd(t.netUsd)}</b> (${signed(t.netPct)} net)
Worst point while held: ${signed(t.worstNetPct)}
Bankroll: ${usd(t.prevBankroll)} → <b>${usd(t.newBankroll)}</b> (${signed((t.newBankroll / run.seedUsd - 1) * 100, 0)} since the $${run.seedUsd} start)
Completed: ${s.trades} · Searching for the next pre-spike token now.`;
}

function staleMessage(pos, k, time) {
  return `${PAPER}
⚠️ <b>COMPOUNDER: $${esc(pos.symbol)} has had no trades for ${k.staleAfterHours}h+</b> (last trade ${time.when(new Date(pos.lastTradeAt ?? pos.fill.at))}).
It may be dead (liquidity pulled). Per the rules it is still held until +${k.targetNetPct}%; last mark ${signed(pos.mark?.netPct)}.`;
}

// --- hourly entry point --------------------------------------------------------------------------

export async function runCompounder({ cfg, candidates, pairs, snapshots, dryRun, dataDir, reportPath, log }) {
  const k = cfg.compounder;
  const e = k.entry;
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
  const hourly = { t: now.toISOString(), rules: k.rules, errors: [] };

  // 1. A run under older rules is closed (kept in the ledger) before the current rules start.
  for (const old of ledger.runs.filter((r) => r.status === 'active' && r.rules !== k.rules)) {
    if (old.position) {
      const m = old.position.mark;
      old.trades.push({ n: old.trades.length + 1, symbol: old.position.symbol, decidedAt: old.position.decidedAt, reason: 'rules changed (closed at last mark)', netPct: m?.netPct ?? 0, netUsd: m ? m.proceeds - old.position.sizeUsd : 0, costsUsd: 0, newBankroll: round(old.cash + (m?.proceeds ?? old.position.sizeUsd)) });
      old.cash = old.trades.at(-1).newBankroll;
      old.position = null;
    }
    finishRun(old, 'ended', now, `rules changed to ${k.rules} on ${time.localDate(now)}`);
  }
  let run = ledger.runs.find((r) => r.status === 'active' && r.rules === k.rules);
  if (!run && time.localDate(now) >= k.startDate && !ledger.runs.some((r) => r.rules === k.rules)) {
    run = newRun(now, k, time);
    ledger.runs.push(run);
    await send(`${PAPER}\n🔁 <b>COMPOUNDER ${k.rules} STARTED</b> with $${k.seedUsd}: buy before the spike, hold until +${k.targetNetPct}% net, repeat. Graduated tokens preferred.`);
  }

  // 2. Settle the open position: it closes only at the target (or if it never filled).
  if (run?.position) {
    try {
      const wasStale = run.position.stale;
      const res = await settle(run, cfg, now);
      if (res?.closed || res?.noFill) {
        const t = recordClose(run, res, now);
        hourly.exit = { symbol: t.symbol, reason: t.reason, netPct: t.netPct, netUsd: t.netUsd, holdHours: t.holdHours };
        await send(tradeReport(run, t));
      } else if (run.position.stale && !wasStale) {
        await send(staleMessage(run.position, k, time));
      }
    } catch (err) {
      hourly.errors.push(`settle: ${err.message}`);
    }
  }

  // 3. Screen (only when in cash) and decide.
  let rows = [];
  const rejects = {};
  try {
    if (!run) hourly.decision = 'IDLE (no active run)';
    else if (run.position) hourly.decision = 'HOLD';
    else {
      if (!candidates) candidates = await collectCandidates(cfg, log);
      const missing = candidates.filter((c) => !pairs?.has(c.mint)).map((c) => c.mint);
      const allPairs = new Map([...(pairs ?? []), ...(missing.length ? await dexPairs(missing, log) : [])]);
      const cooldownMs = k.cooldownHours * HOUR;
      const blocked = new Set(run.trades.filter((t) => now - Date.parse(t.exitAt ?? t.decidedAt) < cooldownMs).map((t) => t.mint));
      const sizeUsd = run.cash;
      for (const c of candidates) {
        const pair = allPairs.get(c.mint);
        if (!pair) continue;
        const r = entryRow(c, pair, now.getTime(), snapshots);
        const why = entryFailure(r, sizeUsd, blocked, e);
        if (why) rejects[why] = (rejects[why] ?? 0) + 1;
        else rows.push(r);
      }
      const best = await screenPreSpike({ rows, sizeUsd, cfg, nowMs: now.getTime(), log: hourly });
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
        hourly.decision = 'BUY';
        hourly.best = best.symbol;
        await send(buyMessage(run, best, run.position, k, cfg, time, now));
      } else {
        hourly.decision = 'NO TRADE (cash)';
      }
    }
  } catch (err) {
    hourly.errors.push(`screen: ${err.message}`);
    hourly.decision ??= 'NO TRADE (error)';
  }

  Object.assign(hourly, {
    run: run?.id ?? null,
    bankroll: run ? round(bankrollOf(run)) : null,
    position: run?.position ? { symbol: run.position.symbol, mark: run.position.mark?.netPct ?? null, stale: !!run.position.stale } : null,
    rejects,
    candidates: rows,
  });
  log.compounder = { decision: hourly.decision, bankroll: hourly.bankroll, logged: rows.length, errors: hourly.errors.length };
  log.errors.push(...hourly.errors.map((x) => `compounder ${x}`));
  console.log(`Compounder: ${hourly.decision}; bankroll ${hourly.bankroll}; ${rows.length} candidates passed the cheap checks`);

  const shown = run ?? ledger.runs.at(-1);
  if (!dryRun) {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1) + '\n');
    fs.appendFileSync(path.join(dataDir, 'compounder-hourly.jsonl'), JSON.stringify(hourly) + '\n');
    fs.writeFileSync(reportPath, compounderMarkdown(ledger, cfg, now, time));
  }
  return summaryLine(shown, now, time);
}
