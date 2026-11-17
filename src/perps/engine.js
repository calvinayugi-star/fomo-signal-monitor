// Perps Compounders (paper mode, since 2026-11-17; replace the spot memecoin Compounders): two runs on Hyperliquid perps,
// 10x isolated, 100% of the bankroll as margin, longs and shorts, no stop-loss, a take-profit at the run's net target and a 2h time limit.
//   Conservative: $110 seed, +13.93% net once per day (then no new trades until midnight ET).
//   Aggressive:   $25 seed, +20% net per trade, searching again right after each sale.
// Each loops: when the bankroll reaches goalUsd + seed it is cashed out (all but the seed) and a new cycle starts from the seed.
// The runs never hold the same coin at once and don't re-trade a coin within cooldownHours. Every 15 min:
//   settle each open position on 1-minute candles -> screen every perp -> open / hold / nothing.
// Records: data/perps-run.json (ledger, never deleted), data/perps-log-YYYY-MM.jsonl (every decision + candidates), PERPS.md.
import fs from 'node:fs';
import path from 'node:path';
import { sendTelegram } from '../telegram.js';
import { makeTime } from '../time.js';
import { markets, candles } from './hl.js';
import { openPerp, targetPx, replayPerp } from './sim.js';
import { marketFailure, evaluate } from './signal.js';
import { perpsMarkdown, dailyLine, buyMessage, closeMessage, PAPER, tag, usd } from './report.js';

const HOUR = 3600e3;
const round = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(d) : x ?? null);
const readOr = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
export const goalBankroll = (run) => run.goalUsd + run.seedUsd;
export const bankrollOf = (run) => run.cash + (run.position ? run.position.mark?.proceeds ?? run.position.marginUsd : 0);

function newRun(now, k, time, v, prev) {
  const cycle = prev ? (prev.cycle ?? 1) + 1 : 1;
  return {
    id: `perps-${v.id}-${time.localDate(now)}${cycle > 1 ? `-c${cycle}` : ''}`,
    venue: k.venue,
    variant: v.id,
    name: v.name,
    per: v.per,
    mode: 'paper',
    seedUsd: v.seedUsd,
    goalUsd: k.goalUsd,
    cycle,
    cashedOutBeforeUsd: prev ? round((prev.cashedOutBeforeUsd ?? 0) + (prev.cashOutUsd ?? 0)) : 0,
    targetNetPct: v.targetNetPct,
    leverage: k.leverage,
    startedAt: now.toISOString(),
    status: 'active',
    cash: v.seedUsd,
    position: null,
    trades: [],
  };
}

// Settles an open position on the 1-minute candles since the last check. Returns the close, { noFill }, or null (still open).
async function settle(pos, k, now) {
  const fillAtMs = Date.parse(pos.decidedAt) + k.fillDelayMinutes * 60e3;
  const from = pos.checkedThrough != null ? pos.checkedThrough + 60e3 : fillAtMs - 60e3;
  if (now - from < 60e3) return null;
  const cs = (await candles(pos.coin, '1m', from, now)).filter((c) => c.t >= from && c.t + 60e3 <= now);
  const d = pos.side === 'long' ? 1 : -1;
  if (!pos.fill) {
    const f = cs.find((c) => c.t >= fillAtMs);
    if (!f) return now - fillAtMs > k.noFillCancelHours * HOUR ? { noFill: true } : null;
    // Market entry at the open of the first minute after the decision, paying half the spread.
    pos.fill = { at: new Date(f.t).toISOString(), px: f.o * (1 + (d * pos.slipPct) / 100), candleT: f.t };
  }
  const p = openPerp({ marginUsd: pos.marginUsd, leverage: pos.leverage, side: pos.side, entryPx: pos.fill.px, takerPct: k.fees.takerPct, mmrPct: pos.mmrPct });
  pos.liqPx = p.liqPx;
  pos.targetPx = targetPx(p, pos.targetNetPct, k.fees.makerPct, pos.state.fundingUsd ?? 0);
  const todo = cs.filter((c) => c.t >= pos.fill.candleT && c.t > (pos.checkedThrough ?? -Infinity));
  const res = replayPerp(p, todo, pos.state, {
    targetNetPct: pos.targetNetPct,
    makerPct: k.fees.makerPct,
    takerPct: k.fees.takerPct,
    slipPct: pos.slipPct,
    fundingRatePerHour: pos.fundingPctPerHour / 100,
    closeAtMs: pos.fill.candleT + k.maxHoldHours * HOUR,
    nowMs: now.getTime(),
  });
  if (todo.length) pos.checkedThrough = todo.at(-1).t;
  if (!res.closed && res.mark) pos.mark = { at: new Date(res.lastAt ?? now).toISOString(), px: res.lastPx, netPct: round(res.mark.netPct), proceeds: round(res.mark.proceeds) };
  return res.closed ? { ...res, p } : null;
}

function recordClose(run, res, k) {
  const pos = run.position;
  let t;
  if (res.noFill) {
    t = { n: run.trades.length + 1, coin: pos.coin, side: pos.side, decidedAt: pos.decidedAt, noFill: true, reason: 'not filled', netUsd: 0, netPct: 0, newBankroll: round(run.cash + pos.marginUsd, 4) };
  } else {
    const exitFeePct = res.targetHit ? k.fees.makerPct : k.fees.takerPct;
    const feesUsd = res.p.entryFee + (res.p.notional * (res.exitPx / res.p.entryPx) * exitFeePct) / 100;
    t = {
      n: run.trades.length + 1,
      coin: pos.coin,
      side: pos.side,
      decidedAt: pos.decidedAt,
      fillAt: pos.fill.at,
      exitAt: new Date(res.exitAt).toISOString(),
      holdHours: round((res.exitAt - pos.fill.candleT) / HOUR, 2),
      reason: res.reason,
      entryPx: pos.fill.px,
      exitPx: res.exitPx,
      liqPx: pos.liqPx,
      marginUsd: round(pos.marginUsd, 4),
      notionalUsd: round(res.p.notional, 2),
      feesUsd: res.reason === 'liquidated' ? round(res.p.entryFee, 4) : round(feesUsd, 4),
      fundingUsd: round(pos.state.fundingUsd ?? 0, 4),
      netUsd: round(res.netUsd, 4),
      netPct: round(res.netPct),
      peakNetPct: round(pos.state.peakNetPct ?? null),
      worstNetPct: round(pos.state.worstNetPct ?? null),
      targetHit: !!res.targetHit,
      score: pos.score,
      newBankroll: round(run.cash + res.proceeds, 4),
    };
  }
  run.trades.push(t);
  run.cash = t.newBankroll;
  run.position = null;
  return t;
}

export async function runPerps({ cfg, dryRun, dataDir, cacheDir, reportPath, log }) {
  const k = cfg.perps;
  const time = makeTime(cfg.displayTimezone);
  const now = new Date();
  const ledgerFile = path.join(dataDir, 'perps-run.json');
  const ledger = readOr(ledgerFile, { runs: [] });
  const oiFile = path.join(cacheDir, 'perps-oi.json');
  const oiLog = readOr(oiFile, {}); // coin -> [{ t, oiUsd }], working data for the open-interest change
  const send = (html) => sendTelegram(html, { dryRun });
  const entry = { t: now.toISOString(), errors: [], variants: {} };

  // 1. Runs started before a restart the user asked for (config restart, optionally per variant) are closed at their last mark.
  const restartOf = (r) => [].concat(k.restart ?? []).find((x) => r.startedAt < x.at && (!x.variants || x.variants.includes(r.variant)));
  for (const old of ledger.runs.filter((r) => r.status === 'active' && restartOf(r))) {
    if (old.position) {
      const m = old.position.mark;
      old.trades.push({ n: old.trades.length + 1, coin: old.position.coin, side: old.position.side, decidedAt: old.position.decidedAt, reason: 'restart (closed at last mark)', netPct: m?.netPct ?? 0, netUsd: m ? m.proceeds - old.position.marginUsd : 0, targetHit: false, newBankroll: round(old.cash + (m?.proceeds ?? old.position.marginUsd)) });
      old.cash = old.trades.at(-1).newBankroll;
      old.position = null;
    }
    Object.assign(old, { status: 'ended', endedAt: now.toISOString(), finalBankroll: round(old.cash), note: restartOf(old).note });
    await send(`${PAPER}\n⏹ <b>${tag(old)} ENDED</b> (restart). Final bankroll ${usd(old.cash)} from $${old.seedUsd}.`);
  }

  // 2. One active run per variant; a run that reached its goal is followed by a new cycle from the seed.
  const current = () => ledger.runs.filter((r) => !restartOf(r));
  const runs = [];
  for (const v of k.variants) {
    let run = current().find((r) => r.status === 'active' && r.variant === v.id);
    const last = current().filter((r) => r.variant === v.id).at(-1);
    const prev = last?.status === 'completed' ? last : null;
    if (!run && (!last || prev)) {
      run = newRun(now, k, time, v, prev);
      ledger.runs.push(run);
      await send(`${PAPER}\n🔁 <b>${tag(run)}${prev ? ` cycle ${run.cycle}` : ''} STARTED</b> with $${run.seedUsd} on Hyperliquid perps: ${k.leverage}x, longs and shorts, sell at +${v.targetNetPct}% net or after ${k.maxHoldHours}h, no stop-loss${run.per === 'day' ? `; once the day is up +${v.targetNetPct}%, no new trades until midnight ET` : ''}; at ${usd(goalBankroll(run))} it cashes out ${usd(run.goalUsd)}+ and starts again from $${run.seedUsd}.`);
    }
    if (run?.status === 'active') runs.push(run);
  }

  // 3. Market data once per run, shared by both runs; 5-min candles fetched only for coins that pass the cheap checks.
  let mkts = [];
  try {
    mkts = await markets();
  } catch (err) {
    entry.errors.push(`markets: ${err.message}`);
  }
  const byCoin = new Map(mkts.map((m) => [m.coin, m]));
  const c5Cache = new Map();
  const c5Of = async (coin) => {
    if (!c5Cache.has(coin)) {
      const cs = await candles(coin, '5m', now - 25 * HOUR, now);
      c5Cache.set(coin, cs.filter((c) => c.t + 5 * 60e3 <= now));
    }
    return c5Cache.get(coin);
  };
  const oiPrev = (coin) => (oiLog[coin] ?? []).filter((x) => now - x.t >= 10 * 60e3 && now - x.t <= 2 * HOUR).at(-1)?.oiUsd ?? null;

  for (const run of runs) {
    const h = { errors: [] };
    entry.variants[run.variant] = h;
    const v = k.variants.find((x) => x.id === run.variant);
    const today = time.localDate(now);
    if (run.per === 'day' && run.day?.date !== today) {
      if (run.day) (run.days ??= []).push({ ...run.day, endBankroll: round(bankrollOf(run)) });
      run.day = { date: today, startBankroll: round(bankrollOf(run)) };
    }

    if (run.position) {
      try {
        const res = await settle(run.position, k, now);
        if (res) {
          const t = recordClose(run, res, k);
          h.exit = { coin: t.coin, side: t.side, reason: t.reason, netPct: t.netPct, netUsd: t.netUsd };
          await send(closeMessage(run, t));
          if (run.cash >= goalBankroll(run) - 0.005) {
            run.cashOutUsd = round(run.cash - run.seedUsd);
            Object.assign(run, { status: 'completed', endedAt: now.toISOString(), finalBankroll: round(run.cash), note: `goal reached: cashed out ${usd(run.cashOutUsd)}, ${usd(run.seedUsd)} kept for the next cycle` });
            h.decision = 'GOAL REACHED (cashed out)';
            await send(`${PAPER}\n🏁 <b>${tag(run)}${run.cycle > 1 ? ` cycle ${run.cycle}` : ''}: GOAL REACHED</b>: $${run.seedUsd} → <b>${usd(run.cash)}</b> in ${run.trades.length} trades.\n💵 Cash out <b>${usd(run.cashOutUsd)}</b> and keep $${run.seedUsd}. Total cashed out: ${usd(run.cashedOutBeforeUsd + run.cashOutUsd)}.\nA new cycle starts from $${run.seedUsd} at the next run.`);
          } else if (run.cash < k.minBankrollUsd) {
            Object.assign(run, { status: 'busted', endedAt: now.toISOString(), finalBankroll: round(run.cash), note: `bankroll ${usd(run.cash)} after ${t.coin} ${t.reason}; restart needs the user's go-ahead` });
            h.decision = 'BUSTED';
            await send(`${PAPER}\n💥 <b>${tag(run)}: BUSTED</b> at ${usd(run.cash)} (${t.coin} ${t.reason}). It stays stopped until you ask for a restart.`);
          }
        }
      } catch (err) {
        h.errors.push(`settle: ${err.message}`);
      }
    }
    if (run.per === 'day' && run.status === 'active' && !run.position && !run.day.goalMetAt && run.cash >= run.day.startBankroll * (1 + run.targetNetPct / 100) - 0.005) {
      run.day.goalMetAt = now.toISOString();
      await send(`${PAPER}\n🎯 <b>${tag(run)}: daily goal met</b>: ${usd(run.day.startBankroll)} → ${usd(run.cash)} today. No new trades until midnight ET.`);
    }

    const rows = [];
    const rejects = {};
    try {
      if (run.status !== 'active') h.decision ??= run.status.toUpperCase();
      else if (run.position) h.decision = 'HOLD';
      else if (run.per === 'day' && run.day.goalMetAt) h.decision = 'NO TRADE (daily goal met)';
      else if (!mkts.length) h.decision = 'NO TRADE (no market data)';
      else {
        const cooldown = new Set(run.trades.filter((t) => now - Date.parse(t.exitAt ?? t.decidedAt) < k.cooldownHours * HOUR).map((t) => t.coin));
        const taken = new Set(runs.filter((o) => o !== run && o.position).map((o) => o.position.coin));
        const goalNetPct = (goalBankroll(run) / run.cash - 1) * 100;
        const targetNetPct = Math.min(run.targetNetPct, goalNetPct);
        for (const m of mkts) {
          const why = marketFailure(m, k.entry, k.leverage) ?? (cooldown.has(m.coin) ? 'traded in the cooldown window' : taken.has(m.coin) ? 'held by the other run' : null);
          if (why) {
            rejects[why] = (rejects[why] ?? 0) + 1;
            continue;
          }
          try {
            rows.push(evaluate(m, await c5Of(m.coin), { e: k.entry, leverage: k.leverage, fees: k.fees, targetNetPct: v.targetNetPct, oiPrevUsd: oiPrev(m.coin) }));
          } catch (err) {
            rows.push({ coin: m.coin, reason: 'candle data unavailable' });
            h.errors.push(`candles ${m.coin}: ${err.message}`);
          }
        }
        const best = rows.filter((r) => !r.reason).sort((a, b) => b.score - a.score)[0];
        if (best) {
          const m = byCoin.get(best.coin);
          run.position = {
            coin: best.coin,
            side: best.side,
            decidedAt: now.toISOString(),
            markPxAtDecision: m.markPx,
            marginUsd: round(run.cash, 4),
            leverage: k.leverage,
            mmrPct: m.mmrPct,
            slipPct: round(m.spreadPct / 2, 4),
            fundingPctPerHour: m.fundingPctPerHour,
            targetNetPct: round(targetNetPct, 4),
            score: best.score,
            entry: best,
            state: {},
          };
          run.cash = 0;
          h.decision = `OPEN ${best.side.toUpperCase()}`;
          h.best = best.coin;
          await send(buyMessage(run, run.position, k, time, now));
        } else h.decision = 'NO TRADE (cash)';
      }
    } catch (err) {
      h.errors.push(`screen: ${err.message}`);
      h.decision ??= 'NO TRADE (error)';
    }
    // Candidates: full numbers for coins that passed or scored 30+, just the reason for the rest (keeps the log ~15 MB a month).
    const compact = rows.map((r) => (!r.reason || r.score >= 30 ? r : { coin: r.coin, side: r.side, chg15: r.chg15, surge: r.surge, score: r.score, reason: r.reason }));
    Object.assign(h, { run: run.id, bankroll: round(bankrollOf(run)), position: run.position ? { coin: run.position.coin, side: run.position.side, mark: run.position.mark?.netPct ?? null } : null, rejects, candidates: compact });
    entry.errors.push(...h.errors.map((x) => `${run.variant} ${x}`));
  }

  // Open-interest readings for the next runs' change (working data, kept 3h).
  for (const m of mkts) if (m.maxLeverage >= k.leverage) (oiLog[m.coin] ??= []).push({ t: now.getTime(), oiUsd: Math.round(m.openInterestUsd) });
  for (const [coin, list] of Object.entries(oiLog)) {
    const kept = list.filter((x) => now - x.t <= 3 * HOUR);
    if (kept.length) oiLog[coin] = kept;
    else delete oiLog[coin];
  }

  log.perps = Object.fromEntries(Object.entries(entry.variants).map(([id, h]) => [id, { decision: h.decision, bankroll: h.bankroll }]));
  log.errors.push(...entry.errors.map((x) => `perps ${x}`));
  for (const [id, h] of Object.entries(entry.variants)) console.log(`Perps ${id}: ${h.decision}${h.best ? ` ${h.best}` : ''}; bankroll ${h.bankroll}; ${h.candidates.filter((r) => !r.reason).length} of ${h.candidates.length} evaluated passed`);

  if (!dryRun) {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1) + '\n');
    fs.appendFileSync(path.join(dataDir, `perps-log-${now.toISOString().slice(0, 7)}.jsonl`), JSON.stringify(entry) + '\n');
    fs.writeFileSync(reportPath, perpsMarkdown(ledger, cfg, now, time));
    fs.mkdirSync(path.dirname(oiFile), { recursive: true });
    fs.writeFileSync(oiFile, JSON.stringify(oiLog));
  }
  const shown = ledger.runs.filter((r) => r.status === 'active' || now - Date.parse(r.endedAt ?? 0) < 24 * HOUR);
  return shown.map((r) => dailyLine(r, now)).join('\n');
}
