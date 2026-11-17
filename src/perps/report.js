// Perps Compounders: Telegram messages, the daily summary line, and PERPS.md.
import { esc } from '../telegram.js';
import { targetMovePct } from './signal.js';

const HOUR = 3600e3;
export const PAPER = '📝 <b>PAPER MODE: tracking only, no real orders</b>';
export const usd = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
export const tag = (run) => (run.name ?? run.variant).toUpperCase();
const sf = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const px = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const bankroll = (run) => run.cash + (run.position ? run.position.mark?.proceeds ?? run.position.marginUsd : 0);
const held = (pos, now) => (pos.fill ? `${((now - Date.parse(pos.fill.at)) / HOUR).toFixed(1)}h` : 'fill pending');

export function buyMessage(run, pos, k, time, now) {
  const e = pos.entry;
  const dir = pos.side === 'long' ? 1 : -1;
  const move = targetMovePct(pos.targetNetPct, k.leverage, k.fees);
  return `${PAPER}
🔁 <b>${tag(run)}: ${pos.side.toUpperCase()} ${esc(pos.coin)} ${k.leverage}x</b> on Hyperliquid

<b>TIME:</b> ${time.when(now)}
<b>MARGIN:</b> ${usd(pos.marginUsd)} (100% of the bankroll) · <b>POSITION:</b> ${usd(pos.marginUsd * k.leverage)}
<b>ENTRY:</b> ~$${px(pos.markPxAtDecision)} (market order, paper fill at the next minute)
<b>TAKE-PROFIT:</b> ~$${px(pos.markPxAtDecision * (1 + (dir * move) / 100))} (${dir > 0 ? '+' : '−'}${move.toFixed(2)}% in price = +${pos.targetNetPct.toFixed(2)}% net)
${k.stopLoss ? `<b>STOP-LOSS:</b> ~$${px(pos.markPxAtDecision * (1 - (dir * e.liqDistPct * k.stopLoss.beforeLiquidationFraction) / 100))} (${dir > 0 ? '−' : '+'}${(e.liqDistPct * k.stopLoss.beforeLiquidationFraction).toFixed(2)}% in price, just before liquidation)\n` : ''}<b>LIQUIDATION:</b> ~$${px(pos.markPxAtDecision * (1 - (dir * e.liqDistPct) / 100))} (${dir > 0 ? '−' : '+'}${e.liqDistPct}% in price).${k.stopLoss ? '' : ' No stop-loss.'}
<b>TIME LIMIT:</b> closed at market after ${pos.maxHoldHours ?? k.maxHoldHours}h if the target isn't reached.

<b>WHY:</b> ${dir > 0 ? 'up' : 'down'} ${Math.abs(e.chg15)}% in 15 min, ${sf(e.chg60)} in 1h · volume ${e.surge}× the usual 15 min${e.oiChgPct != null ? ` · open interest ${sf(e.oiChgPct)}` : ''}
Typical 2h range ${e.typical2hPct}% vs ${e.targetMovePct}% needed · worst 2h swing against ${e.worstAdverse2hPct}% vs ${e.liqDistPct}% to liquidation
Funding ${sf(e.fundingPctPerHour, 4)}/h · spread ${e.spreadPct}% · score ${e.score}`;
}

export function closeMessage(run, t) {
  if (t.noFill) return `${PAPER}\n🔁 <b>${tag(run)}: ${esc(t.coin)} not filled</b>. Bankroll unchanged at ${usd(t.newBankroll)}.`;
  const head = t.targetHit
    ? `✅ <b>${tag(run)}: CLOSED ${t.side.toUpperCase()} ${esc(t.coin)} at the target</b>`
    : t.reason === 'liquidated'
      ? `💥 <b>${tag(run)}: ${t.side.toUpperCase()} ${esc(t.coin)} LIQUIDATED</b>`
      : `⏹ <b>${tag(run)}: CLOSED ${t.side.toUpperCase()} ${esc(t.coin)}</b>: ${esc(t.reason)}`;
  return `${PAPER}
${head} after ${t.holdHours}h

Entry → exit: $${px(t.entryPx)} → $${px(t.exitPx)}
Fees ${usd(t.feesUsd)} · funding ${usd(t.fundingUsd)}
${t.netUsd >= 0 ? 'Profit' : 'Loss'}: <b>${t.netUsd >= 0 ? '+' : ''}${usd(t.netUsd)}</b> (${sf(t.netPct)} net) · best ${sf(t.peakNetPct)}, worst ${sf(t.worstNetPct)}
Bankroll: <b>${usd(t.newBankroll)}</b> (${sf((t.newBankroll / run.seedUsd - 1) * 100, 0)} since the $${run.seedUsd} start)`;
}

export function dailyLine(run, now) {
  const trades = run.trades.filter((t) => !t.noFill);
  const hits = trades.filter((t) => t.targetHit).length;
  const pos = run.position;
  const open = pos ? ` · ${pos.side} ${pos.coin} (${pos.mark ? sf(pos.mark.netPct) : 'fill pending'}, ${held(pos, now)})` : '';
  return `${run.name}${run.cycle > 1 ? ` cycle ${run.cycle}` : ''}: ${usd(bankroll(run))} (${sf((bankroll(run) / run.seedUsd - 1) * 100, 1)} since $${run.seedUsd}) · ${trades.length} trades, ${hits} at target${open}${run.status !== 'active' ? ` · ${run.status.toUpperCase()}` : ''}`;
}

function runSection(run, now, time) {
  const trades = run.trades.filter((t) => !t.noFill);
  const pos = run.position;
  const rows = [...run.trades]
    .reverse()
    .map((t) =>
      t.noFill
        ? `| ${t.n} | ${time.short(new Date(t.decidedAt))} | ${t.coin} | ${t.side} | not filled | | | | | ${usd(t.newBankroll)} |`
        : `| ${t.n} | ${t.fillAt ? time.short(new Date(t.fillAt)) : ''} | ${t.coin} | ${t.side} | ${t.reason} | ${t.holdHours ?? ''}h | ${sf(t.worstNetPct)} | ${usd(t.feesUsd)} | ${sf(t.netPct)} (${usd(t.netUsd)}) | ${usd(t.newBankroll)} |`,
    );
  return `## ${run.name}: ${run.id} (${run.status.toUpperCase()})

| | |
|---|---|
| Start → now | $${run.seedUsd} → **${usd(bankroll(run))}** (${sf((bankroll(run) / run.seedUsd - 1) * 100)}) since ${time.when(new Date(run.startedAt))} |
| Cycle | ${run.cycle}, ${usd(run.cashedOutBeforeUsd)} cashed out in earlier cycles; goal ${usd(run.goalUsd + run.seedUsd)} |
| Trades | ${trades.length}: ${trades.filter((t) => t.targetHit).length} at target, ${trades.filter((t) => t.reason?.startsWith('time limit')).length} at the time limit, ${trades.filter((t) => t.reason?.startsWith('stop-loss')).length} stopped, ${trades.filter((t) => t.reason === 'liquidated').length} liquidated |
${run.per === 'day' ? `| Days the daily goal was met | ${[...(run.days ?? []), run.day].filter((d) => d?.goalMetAt).length} of ${(run.days?.length ?? 0) + (run.day ? 1 : 0)} |\n` : ''}${pos ? `| Open | **${pos.side.toUpperCase()} ${pos.coin}** ${pos.leverage}x, margin ${usd(pos.marginUsd)}, entry ${pos.fill ? `$${px(pos.fill.px)}` : 'pending'}, target ${pos.targetPx ? `$${px(pos.targetPx)}` : 'n/a'}, liquidation ${pos.liqPx ? `$${px(pos.liqPx)}` : 'n/a'}, now ${pos.mark ? sf(pos.mark.netPct) : 'n/a'}, held ${held(pos, now)} |\n` : ''}
| # | Filled | Coin | Side | Exit | Held | Worst | Fees | Net | Bankroll after |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| – | – | – | – | – | – | – | – | – | – |'}
`;
}

export function perpsMarkdown(ledger, cfg, now, time) {
  const k = cfg.perps;
  const e = k.entry;
  const current = k.variants.map((v) => ledger.runs.filter((r) => r.variant === v.id).at(-1)).filter(Boolean);
  const past = ledger.runs.filter((r) => !current.includes(r));
  return `# Perps Compounders: Results (PAPER MODE)

Updated ${time.when(now)}. Paper trades on Hyperliquid's live market data: no account, no real orders.

**Rules (since 2026-11-17):** every 15 min, screen every Hyperliquid perp; open the best setup, **long or short, ${k.leverage}x isolated with 100% of the bankroll as margin**.
Close at the run's net target (a resting limit order, maker fee) or at market after the run's time limit. ${k.stopLoss ? `**Stop-loss at ${k.stopLoss.beforeLiquidationFraction * 100}% of the way to liquidation** (since 2026-11-17; liquidation is about 5–9% against the position depending on the coin), a market order that keeps the margin a liquidation would take.` : '**No stop-loss**: liquidation (about 5–9% against the position, depending on the coin) is the worst case.'}
${k.variants.map((v) => `**${v.name}:** $${v.seedUsd} seed, +${v.targetNetPct}% net per ${v.per === 'day' ? 'day' : 'trade'}${v.per === 'day' ? (v.dayStop === 'firstTarget' ? ' (no new trades after its first target sale of the day until midnight ET)' : ' (no new trades after the daily goal until midnight ET)') : ' (searching again right after each sale)'}, ${v.maxHoldHours ?? k.maxHoldHours}h time limit, needs a ${targetMovePct(v.targetNetPct, k.leverage, k.fees).toFixed(2)}% price move.`).join(' ')}
At ${usd(k.goalUsd)} + the seed a run cashes out ${usd(k.goalUsd)}+ and starts again from the seed. The runs never hold the same coin; no coin twice within ${k.cooldownHours}h.

${current.map((r) => runSection(r, now, time)).join('\n')}
## Rules in effect

- **Universe:** perps allowing ${k.leverage}x, 24h volume ≥ $${e.minDayVolumeUsd / 1e6}M, open interest ≥ $${e.minOpenInterestUsd / 1e6}M, spread ≤ ${e.maxSpreadPct}%.
- **Entry:** ${e.lax ? `as lax as possible (since 2026-11-17, user request): no entry filters; whenever a run is in cash it takes the highest-scoring coin, long if its last 15 min went up, short if down.` : `last 15 min volume ≥ ${e.minVolumeSurge}× the day's average 15 min; price moved ${e.minMove15Pct}–${e.maxMove15Pct}% in 15 min (long if up, short if down)${e.requireTrendAgreement ? ', with the last hour the same way' : ''}; this side pays at most ${e.maxAdverseFundingPctPerHour}%/h funding; a typical 2h range ≥ ${e.minRangeToTarget}× the needed move; the worst 2h swing against this side in the last day < ${e.liqSafety * 100}% of the distance to liquidation; score ≥ ${e.minScore}.`}
- **Score:** volume surge 30, 15-min move 20, 1h trend 15, open interest rising 15, room to reach the target 10, funding 10.
- **Costs:** taker ${k.fees.takerPct}% on the entry and time-limit exits (plus half the spread), maker ${k.fees.makerPct}% on the take-profit, hourly funding at the rate seen at entry.
- **Fills:** paper fill at the open of the first minute after the decision; exits checked minute by minute (liquidation before the take-profit inside a minute).

${past.length ? `## Past runs\n\n| Run | Seed | Final | Trades | Status |\n|---|---|---|---|---|\n${past.map((r) => `| ${r.id} | $${r.seedUsd} | ${usd(r.finalBankroll ?? r.cash)} | ${r.trades.length} | ${r.status}${r.note ? `: ${r.note}` : ''} |`).join('\n')}\n` : ''}`;
}
