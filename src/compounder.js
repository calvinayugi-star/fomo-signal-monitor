// FOMO Daily Compounder (paper mode): one position at a time, 100% of the bankroll compounded,
// from a monthly seed toward a net target. Runs inside the hourly monitor job:
//   settle the open position on 1-minute candles -> screen for +10%/1h momentum -> BUY / HOLD / NO TRADE.
// Records: data/compounder-run.json (ledger, never deleted), data/compounder-hourly.jsonl (every hourly
// decision plus every candidate up >= logFromChgH1Pct, for the replay script), and COMPOUNDER.md.
import fs from 'node:fs';
import path from 'node:path';
import { getJson } from './http.js';
import { collectCandidates, GT } from './sources.js';
import { dexPairs, safetyCheck, costCheck } from './screen.js';
import { sendTelegram, esc } from './telegram.js';
import { openPosition, findFill, replayExit, priceForNet } from './compounder-sim.js';
import { compounderMarkdown, summaryLine, runStats, bankrollOf, usd, price } from './compounder-report.js';
import { makeTime } from './time.js';

const HOUR = 3600e3;
const pctChange = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;
const round = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(d) : x ?? null);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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

// The last hour on completed 5-minute candles: 15-minute change, volume trend, average 5-minute range.
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
    atr5Pct: done.reduce((s, c) => s + ((c[2] - c[3]) / c[4]) * 100, 0) / done.length,
  };
}

function pairRow(c, pair, now) {
  const t = pair.txns?.h1 ?? {};
  return {
    symbol: pair.baseToken?.symbol,
    mint: c.mint,
    pairAddress: pair.pairAddress,
    sources: [...c.sources],
    priceUsd: Number(pair.priceUsd),
    chgH1: pair.priceChange?.h1 ?? 0,
    chgM5: pair.priceChange?.m5 ?? 0,
    liqUsd: Math.round(pair.liquidity?.usd ?? 0),
    volH1: Math.round(pair.volume?.h1 ?? 0),
    ratioH1: round((t.buys ?? 0) / Math.max(t.sells ?? 0, 1)),
    ageH: pair.pairCreatedAt ? round((now - pair.pairCreatedAt) / HOUR, 1) : null,
  };
}

// Checks that need no extra API calls. Returned separately from the floor so the replay can vary the floor.
function cheapFailure(row, sizeUsd, tradedToday, k) {
  const mo = k.momentum;
  if (row.chgH1 > mo.maxChgH1Pct) return `already spiked (>${mo.maxChgH1Pct}% 1h)`;
  if (row.ageH == null || row.ageH < mo.minPairAgeHours) return 'pair too new';
  if (row.liqUsd < Math.max(k.liquidity.minUsd, k.liquidity.minMultipleOfPosition * sizeUsd))
    return 'liquidity too thin for the position';
  if (row.ratioH1 < mo.minBuySellRatioH1) return 'buying not dominant (1h)';
  if (row.ratioH1 > mo.maxBuySellRatio) return 'unnatural buy/sell pattern (likely bots)';
  if (!(row.chgM5 > mo.minChgM5Pct)) return 'falling over last 5 min';
  if (tradedToday.has(row.mint)) return 'already traded today';
  return null;
}

// Position size: the whole bankroll, or less once a smaller position can finish the run.
function sizeFor(run, k) {
  const needed = run.targetUsd * (1 + k.sizing.bufferPct / 100) - run.cash;
  return Math.min(run.cash, Math.max(needed / (k.sizing.expectedNetPct / 100), 0));
}

async function screenMomentum({ rows, sizeUsd, afterWin, cfg, nowMs, log }) {
  const k = cfg.compounder;
  const mo = k.momentum;
  const floor = afterWin ? k.daily.afterWin.minChgH1Pct : mo.minChgH1Pct;
  const minVolTrend = afterWin ? k.daily.afterWin.minVolumeTrend : mo.minVolumeTrend;
  for (const r of rows) if (!r.reason && r.chgH1 < floor) r.reason = `below +${floor}% 1h floor`;

  let candleChecks = 0;
  for (const r of rows.filter((x) => !x.reason)) {
    if (candleChecks++ >= mo.maxCandleChecks) {
      r.reason = 'not checked (candle check limit)';
      continue;
    }
    try {
      const s = await fiveMinuteStats(r.pairAddress, r.mint, nowMs);
      if (!s) {
        r.reason = 'under 1h of 5-min candles';
        continue;
      }
      Object.assign(r, { chg15: round(s.chg15), volTrend: round(s.volTrend), atr5Pct: round(s.atr5Pct) });
      if (!(s.chg15 > mo.minChg15mPct)) r.reason = 'falling over last 15 min';
      else if (!(s.volTrend >= minVolTrend)) r.reason = 'volume fading (15 min vs hour)';
      else r.score = round(Math.min(r.chgH1, mo.maxChgH1Pct) * Math.min(s.volTrend, 3), 1);
    } catch (e) {
      r.reason = 'candle data unavailable';
      log.errors.push(`compounder candles ${r.symbol}: ${e.message}`);
    }
  }

  const ranked = rows.filter((r) => r.score != null && !r.reason).sort((a, b) => b.score - a.score);
  let best = null;
  let safetyChecks = 0;
  for (const r of ranked) {
    if (best) {
      r.reason = 'runner-up';
      continue;
    }
    if (safetyChecks++ >= mo.maxSafetyChecks) {
      r.reason = 'not checked (safety check limit)';
      continue;
    }
    try {
      const safety = await safetyCheck(r.mint, cfg);
      if (!safety.ok) {
        Object.assign(r, { reason: safety.reason, unsafe: true });
        continue;
      }
      const cost = await costCheck(r.mint, cfg, sizeUsd);
      if (!cost.ok) {
        Object.assign(r, { reason: cost.reason, unsafe: true });
        continue;
      }
      r.roundTripPct = round(cost.totalPct);
      r.dexRoundTripPct = round(cost.dexRoundTripPct);
      r.stopNetPct = round(clamp(k.exits.atrStopMultiple * r.atr5Pct, k.exits.stopNetPct, k.exits.maxStopNetPct), 1);
      if (cost.totalPct > k.costs.maxRoundTripPct) r.reason = `round trip ${r.roundTripPct}% at this size`;
      else if (r.stopNetPct - cost.totalPct < k.exits.minStopRoomPct) r.reason = 'stop too close to entry after costs';
      else {
        Object.assign(r, { holders: safety.holders, top10Pct: safety.top10, risks: safety.risks });
        best = r;
      }
    } catch (e) {
      r.reason = 'check failed (API error)';
      log.errors.push(`compounder checks ${r.symbol}: ${e.message}`);
    }
  }
  return best;
}

// --- run lifecycle -------------------------------------------------------------------------------

function newRun(now, k, time) {
  const [y, m] = time.localMonth(now).split('-').map(Number);
  return {
    id: time.localMonth(now),
    mode: 'paper',
    seedUsd: k.seedUsd,
    targetUsd: k.targetUsd,
    startedAt: now.toISOString(),
    endsAt: new Date(time.midnight(y, m + 1, 1)).toISOString(),
    status: 'active',
    cash: k.seedUsd,
    position: null,
    trades: [],
  };
}

function entriesOn(run, day, time) {
  const decided = run.trades.map((t) => t.decidedAt).concat(run.position ? [run.position.decidedAt] : []);
  return decided.filter((d) => time.localDate(new Date(d)) === day);
}

// Replays the open position on 1-minute candles; closes it if an exit rule fired.
async function settle(run, cfg, now) {
  const k = cfg.compounder;
  const pos = run.position;
  const fillAt = Date.parse(pos.decidedAt) + k.exits.fillDelayMinutes * 60e3;
  if (now < fillAt + 60e3) return null;
  const candles = await minuteCandles(pos.pairAddress, pos.mint, Date.parse(pos.decidedAt), now.getTime());

  if (!pos.fill) {
    const fill = findFill(candles, fillAt);
    if (!fill) {
      if (now - fillAt > k.exits.timeStopHours * HOUR) return { noFill: true };
      return null;
    }
    pos.fill = { rawPrice: fill.rawPrice, fillCandleT: fill.fillCandleT, at: new Date(fillAt).toISOString() };
  }
  const p = openPosition({ sizeUsd: pos.sizeUsd, rawEntry: pos.fill.rawPrice, dexRoundTripPct: pos.dexRoundTripPct, costs: cfg.costs });
  const finishNetUsd = run.targetUsd * (1 + k.finishLineBufferPct / 100) - (run.cash + pos.sizeUsd);
  const rules = { ...k.exits, stopNetPct: pos.stopNetPct };
  const res = replayExit(p, candles.filter((c) => c[0] > pos.fill.fillCandleT), rules, cfg.costs, {
    fillAt,
    now: now.getTime(),
    hardEndAt: Date.parse(run.endsAt),
    takeProfitNetUsd: finishNetUsd,
  });
  if (!res.closed) {
    pos.mark = {
      at: new Date(res.lastAt).toISOString(),
      price: res.lastPrice,
      netPct: round(res.netPct),
      proceeds: round(res.proceeds),
      stopPrice: res.stopPrice,
      targetHit: res.targetHit,
      peakNetPct: round(res.peakNetPct),
    };
  }
  return res;
}

function recordClose(run, res) {
  const pos = run.position;
  const prevBankroll = run.cash + pos.sizeUsd;
  const base = {
    n: run.trades.length + 1,
    symbol: pos.symbol,
    mint: pos.mint,
    pairAddress: pos.pairAddress,
    decidedAt: pos.decidedAt,
    prevBankroll: round(prevBankroll),
    sizeUsd: round(pos.sizeUsd),
    stopNetPct: pos.stopNetPct,
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
      reason: res.reason,
      entryPriceUsd: pos.fill.rawPrice,
      exitPriceUsd: res.rawExit,
      grossPct: round(grossPct),
      costsUsd: round(pos.sizeUsd * (1 + grossPct / 100) - res.proceeds, 4),
      netUsd: round(res.netUsd, 4),
      netPct: round(res.netPct),
      peakNetPct: round(res.peakNetPct),
      targetHit: res.targetHit,
      newBankroll: round(run.cash + res.proceeds, 4),
    };
  }
  run.trades.push(trade);
  run.cash = trade.newBankroll;
  run.position = null;
  return trade;
}

function finishRun(run, status, now) {
  Object.assign(run, { status, endedAt: now.toISOString(), finalBankroll: round(run.cash) });
}

// --- messages ------------------------------------------------------------------------------------

const PAPER = '📝 <b>PAPER MODE: tracking only, do not trade</b>';
const runLine = (run) => `$${run.seedUsd} → ${usd(bankrollOf(run))} → $${run.targetUsd.toLocaleString('en-US')}`;

function candidateLines(rows, k) {
  const top = rows.filter((r) => r.chgH1 >= k.momentum.minChgH1Pct).slice(0, 5);
  return top.length
    ? top.map((r) => `• $${esc(r.symbol)} ${signed(r.chgH1)}${r.reason ? ` (${esc(r.reason)})` : ''}`).join('\n')
    : `• none up +${k.momentum.minChgH1Pct}% or more in the last hour`;
}

function buyMessage(run, r, pos, rows, k, cfg, time, now, entriesToday) {
  const p = openPosition({ sizeUsd: pos.sizeUsd, rawEntry: r.priceUsd, dexRoundTripPct: r.dexRoundTripPct, costs: cfg.costs });
  const stopPx = priceForNet(p, -pos.stopNetPct, cfg.costs);
  const targetPx = priceForNet(p, k.exits.targetNetPct, cfg.costs);
  const up = (pos.sizeUsd * k.exits.targetNetPct) / 100;
  const down = (pos.sizeUsd * pos.stopNetPct) / 100;
  return `${PAPER}
🔁 <b>COMPOUNDER: BUY $${esc(r.symbol)}</b>
<code>${r.mint}</code>

<b>TIME:</b> ${time.when(now)}
<b>CURRENT BANKROLL:</b> ${usd(bankrollOf(run))}
<b>FOMO TRENDING CANDIDATES:</b>
${candidateLines(rows, k)}
<b>BEST CANDIDATE:</b> $${esc(r.symbol)}
<b>1-HOUR MOMENTUM:</b> ${signed(r.chgH1)} (15 min ${signed(r.chg15)}, 5 min ${signed(r.chgM5)})
<b>LIQUIDITY:</b> $${Math.round(r.liqUsd / 1000)}k (position = ${((pos.sizeUsd / r.liqUsd) * 100).toFixed(1)}% of pool)
<b>DECISION:</b> BUY
<b>POSITION SIZE:</b> ${usd(pos.sizeUsd)}${run.cash > 0.005 ? ` of ${usd(bankrollOf(run))} (sized to finish the run)` : ' (100%)'}
<b>ENTRY:</b> ~$${price(r.priceUsd)} (paper fill ${k.exits.fillDelayMinutes} min after this alert)
<b>PROFIT OBJECTIVE:</b> +${k.exits.targetNetPct}% net (~$${price(targetPx)}), then lock +${k.exits.lockNetPct}% and trail
<b>EXIT / INVALIDATION:</b> stop −${pos.stopNetPct}% net (~$${price(stopPx)}, ${signed(pctChange(stopPx, r.priceUsd))} in price); time stop ${k.exits.timeStopHours}h
<b>ESTIMATED NET UPSIDE:</b> +${k.exits.targetNetPct}% (+${usd(up)}) or more if it trails
<b>ESTIMATED NET DOWNSIDE:</b> −${pos.stopNetPct}% (−${usd(down)}); more if it gaps through the stop
<b>WHY:</b> Up ${r.chgH1.toFixed(0)}% in the last hour with 15-min volume at ${r.volTrend.toFixed(1)}× the hour's average and ${r.ratioH1.toFixed(2)} buys per sell. Round trip costs ~${r.roundTripPct}% at this size, so the stop sits ${Math.abs(pctChange(stopPx, r.priceUsd)).toFixed(1)}% below entry in price.
<b>$5K RUN:</b> ${runLine(run)}
<b>TRADES TODAY:</b> ${entriesToday} / ${k.daily.maxEntries}
${r.risks?.length ? `\nRisks: ${r.risks.map(esc).join('; ')}` : ''}
<a href="https://dexscreener.com/solana/${r.pairAddress}">DexScreener</a>`;
}

function tradeReport(run, t, time) {
  const s = runStats(run);
  if (t.noFill)
    return `${PAPER}\n🔁 <b>COMPOUNDER: $${esc(t.symbol)} not filled</b>: no trades after the decision. Bankroll unchanged at ${usd(t.newBankroll)}.`;
  const icon = t.netUsd > 0 ? '✅' : '🔻';
  return `${PAPER}
${icon} <b>COMPOUNDER: EXIT $${esc(t.symbol)}</b> (${esc(t.reason)} at ${time.when(new Date(t.exitAt))})

Starting monthly bankroll: $${run.seedUsd}
Previous bankroll: ${usd(t.prevBankroll)}
Position size: ${usd(t.sizeUsd)}
Entry price: $${price(t.entryPriceUsd)}
Exit price: $${price(t.exitPriceUsd)}
Gross return: ${signed(t.grossPct)}
Estimated fees/slippage: ${usd(t.costsUsd)}
Net return: <b>${signed(t.netPct)}</b> (peak ${signed(t.peakNetPct)})
Dollar profit/loss: <b>${t.netUsd >= 0 ? '+' : ''}${usd(t.netUsd)}</b>
New bankroll: <b>${usd(t.newBankroll)}</b>
Monthly return: ${signed((t.newBankroll / run.seedUsd - 1) * 100)}
Distance remaining to $${run.targetUsd.toLocaleString('en-US')}: ${usd(Math.max(0, run.targetUsd - t.newBankroll))}
Trades completed: ${s.trades} · Wins: ${s.wins} · Losses: ${s.losses} · Win rate: ${s.winRate == null ? 'n/a' : `${s.winRate.toFixed(0)}%`}`;
}

function endMessage(run) {
  const s = runStats(run);
  const head = {
    complete: `🏁 <b>COMPOUNDER RUN ${run.id} COMPLETE</b>: target reached. Exit everything, withdraw, stop trading until next month.`,
    ended: `⏹ <b>COMPOUNDER RUN ${run.id} ENDED</b>: month over, target not reached.`,
    bust: `🛑 <b>COMPOUNDER RUN ${run.id} STOPPED</b>: bankroll below the minimum.`,
  }[run.status];
  return `${PAPER}\n${head}\n$${run.seedUsd} → <b>${usd(run.cash)}</b> in ${s.trades} trades (${s.wins}W/${s.losses}L).`;
}

// --- hourly entry point --------------------------------------------------------------------------

export async function runCompounder({ cfg, candidates, pairs, dryRun, dataDir, reportPath, log }) {
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
  const hourly = { t: now.toISOString(), errors: [] };
  let run = ledger.runs.find((r) => r.status === 'active');

  // 1. Settle the open position (this also enforces the month-end exit).
  if (run?.position) {
    try {
      const res = await settle(run, cfg, now);
      if (res?.closed || res?.noFill) {
        const t = recordClose(run, res);
        hourly.exit = { symbol: t.symbol, reason: t.reason, netPct: t.netPct, netUsd: t.netUsd };
        await send(tradeReport(run, t, time));
      }
    } catch (e) {
      hourly.errors.push(`settle: ${e.message}`);
    }
  }

  // 2. Run status: finished, bust, month over, or a new month's run.
  if (run && !run.position) {
    const status =
      run.cash >= run.targetUsd ? 'complete' : run.cash < k.bustBelowUsd ? 'bust' : now >= Date.parse(run.endsAt) ? 'ended' : null;
    if (status) {
      finishRun(run, status, now);
      await send(endMessage(run));
      run = null;
    }
  } else if (run?.position && now - Date.parse(run.endsAt) > 6 * HOUR) {
    // No candle data since month end: close at the last mark rather than leave the run open forever.
    const m = run.position.mark;
    const t = recordClose(run, m ? { closed: true, rawExit: m.price, exitAt: Date.parse(run.endsAt), reason: 'month end (last mark)', proceeds: m.proceeds, netUsd: m.proceeds - run.position.sizeUsd, netPct: m.netPct, peakNetPct: m.peakNetPct, targetHit: m.targetHit } : { noFill: true });
    await send(tradeReport(run, t, time));
    finishRun(run, run.cash >= run.targetUsd ? 'complete' : 'ended', now);
    await send(endMessage(run));
    run = null;
  }
  const month = time.localMonth(now);
  if (!run && time.localDate(now) >= k.startDate && !ledger.runs.some((r) => r.id === month)) {
    run = newRun(now, k, time);
    ledger.runs.push(run);
  }

  // 3. Candidates up >= logFromChgH1Pct in the last hour (logged every hour, traded or not).
  let rows = [];
  try {
    if (!candidates) candidates = await collectCandidates(cfg, log);
    const missing = candidates.filter((c) => !pairs?.has(c.mint)).map((c) => c.mint);
    const allPairs = new Map([...(pairs ?? []), ...(missing.length ? await dexPairs(missing, log) : [])]);
    const day = time.localDate(now);
    const tradedToday = new Set(run ? run.trades.filter((t) => time.localDate(new Date(t.decidedAt)) === day).map((t) => t.mint) : []);
    if (run?.position) tradedToday.add(run.position.mint);
    const sizeUsd = run ? sizeFor(run, k) : k.seedUsd;
    for (const c of candidates) {
      const pair = allPairs.get(c.mint);
      if (!pair) continue;
      const r = pairRow(c, pair, now.getTime());
      if (!(r.chgH1 >= k.momentum.logFromChgH1Pct)) continue;
      r.otherFail = cheapFailure(r, sizeUsd, tradedToday, k);
      r.reason = r.otherFail;
      rows.push(r);
    }
    rows.sort((a, b) => b.chgH1 - a.chgH1);

    // 4. Decide.
    const entries = run ? entriesOn(run, day, time).length : 0;
    if (!run) hourly.decision = 'IDLE (no active run this month)';
    else if (run.position) hourly.decision = 'HOLD';
    else if (entries >= k.daily.maxEntries) hourly.decision = 'NO TRADE (daily limit reached)';
    else {
      const afterWin = run.trades.some(
        (t) => time.localDate(new Date(t.decidedAt)) === day && t.netPct >= k.daily.goodDayNetPct,
      );
      const best = await screenMomentum({ rows, sizeUsd, afterWin, cfg, nowMs: now.getTime(), log: hourly });
      if (best) {
        run.position = {
          symbol: best.symbol,
          mint: best.mint,
          pairAddress: best.pairAddress,
          decidedAt: now.toISOString(),
          alertPriceUsd: best.priceUsd,
          sizeUsd: round(sizeUsd, 4),
          dexRoundTripPct: best.dexRoundTripPct,
          roundTripPct: best.roundTripPct,
          stopNetPct: best.stopNetPct,
          atr5Pct: best.atr5Pct,
          chgH1: best.chgH1,
        };
        run.cash = round(run.cash - sizeUsd, 4);
        hourly.decision = 'BUY';
        hourly.best = best.symbol;
        await send(buyMessage(run, best, run.position, rows, k, cfg, time, now, entries + 1));
      } else {
        hourly.decision = 'NO TRADE (cash)';
      }
      if (afterWin) hourly.afterWin = true;
    }
  } catch (e) {
    hourly.errors.push(`screen: ${e.message}`);
    hourly.decision ??= 'NO TRADE (error)';
  }

  Object.assign(hourly, {
    run: run?.id ?? null,
    bankroll: run ? round(bankrollOf(run)) : null,
    position: run?.position ? { symbol: run.position.symbol, mark: run.position.mark?.netPct ?? null } : null,
    tradesToday: run ? entriesOn(run, time.localDate(now), time).length : 0,
    candidates: rows,
  });
  log.compounder = { decision: hourly.decision, bankroll: hourly.bankroll, logged: rows.length, errors: hourly.errors.length };
  log.errors.push(...hourly.errors.map((e) => `compounder ${e}`));
  console.log(`Compounder: ${hourly.decision}; bankroll ${hourly.bankroll}; ${rows.length} candidates logged`);

  const shown = run ?? ledger.runs.at(-1);
  if (!dryRun) {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1) + '\n');
    fs.appendFileSync(path.join(dataDir, 'compounder-hourly.jsonl'), JSON.stringify(hourly) + '\n');
    fs.writeFileSync(reportPath, compounderMarkdown(ledger, cfg, now, time));
  }
  return summaryLine(shown, now);
}
