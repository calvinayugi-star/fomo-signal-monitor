// Compounder results: run statistics, the open position, and COMPOUNDER.md.
// v2 runs (since 2026-10-10) sell only at the +target; v1 runs (October, stops and trailing exits) stay in "Past runs".
const HOUR = 3600e3;

const f = (x, d = 1, suffix = '') => (x == null || !Number.isFinite(x) ? 'n/a' : `${x.toFixed(d)}${suffix}`);
const sf = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
export const usd = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
export const price = (x) => (x == null ? 'n/a' : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
// compounder.entry with the variant's own overrides (since 2026-10-24 the Conservative Compounder buys pairs 72h+ old instead of 15-60 min).
export const entryFor = (k, variantId) => ({ ...k.entry, ...(k.variants.find((v) => v.id === variantId)?.entry ?? {}) });
// Pair age window of a variant's entry rules, e.g. "15–60 min" or "72h+".
const ageWindow = (e) => (e.maxPairAgeHours ? `${e.minPairAgeHours * 60}–${e.maxPairAgeHours * 60} min` : `${e.minPairAgeHours}h+`);
const hours = (h) => (h == null ? 'n/a' : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)} days`);

// Bankroll right now: cash plus the open position at its last marked net value (at cost if not marked yet).
export const bankrollOf = (run) => run.cash + (run.position ? run.position.mark?.proceeds ?? run.position.sizeUsd : 0);

export function runStats(run) {
  const trades = run.trades.filter((t) => !t.noFill);
  const wins = trades.filter((t) => t.netUsd > 0);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    avgNetPct: avg(trades.map((t) => t.netPct)),
    targetHits: trades.filter((t) => t.targetHit).length,
    early: trades.filter((t) => t.targetHit === false && t.holdHours != null).length, // one-off exits before the target
    avgHoldHours: avg(trades.filter((t) => t.targetHit && t.holdHours != null).map((t) => t.holdHours)),
    avgWorstNetPct: avg(trades.filter((t) => t.targetHit && t.worstNetPct != null).map((t) => t.worstNetPct)),
    netUsd: trades.reduce((s, t) => s + t.netUsd, 0),
    costsUsd: trades.reduce((s, t) => s + (t.costsUsd ?? 0), 0),
  };
}

const heldHours = (pos, now) => (pos.fill ? (now - Date.parse(pos.fill.at)) / HOUR : null);
const label = (run) => run.name ?? `+${run.targetNetPct}% per ${run.per === 'day' ? 'day' : 'trade'}`;
// Bankroll at which a run reaches its goal: goalUsd to cash out plus the seed kept for the next cycle (since 2026-10-21).
export const goalBankroll = (run) => (run.goalUsd ? run.goalUsd + run.seedUsd : null);
// Sales at the target still needed to reach the goal from the current bankroll.
const salesToGoal = (run, b) => (run.goalUsd ? Math.max(0, Math.ceil(Math.log(goalBankroll(run) / b) / Math.log(1 + run.targetNetPct / 100))) : null);
const cycleText = (run) => (run.goalUsd ? `cycle ${run.cycle ?? 1}, ${usd(run.cashedOutBeforeUsd ?? 0)} cashed out in earlier cycles` : '–');
const paused = (run) => run.per === 'day' && !run.position && run.day?.goalMetAt;
// Per-day runs: days on which the daily goal was met, out of the days the run has been active.
function dayGoals(run) {
  if (run.per !== 'day') return '–';
  const days = [...(run.days ?? []), ...(run.day ? [run.day] : [])];
  return `${days.filter((d) => d.goalMetAt).length} of ${days.length}`;
}
const nowText = (run, now) =>
  run.position
    ? `holding $${run.position.symbol} (${sf(run.position.mark?.netPct)}, ${hours(heldHours(run.position, now))})`
    : paused(run)
      ? 'daily goal met, paused until midnight'
      : 'in cash, searching';

export function summaryLine(run, now) {
  if (!run) return '';
  const b = bankrollOf(run);
  const s = runStats(run);
  if (run.rules !== 'v2')
    return `🔁 <b>Compounder (paper):</b> $${run.seedUsd} → ${usd(b)} · ${s.trades} trades (${s.wins}W/${s.losses}L) · ${run.status.toUpperCase()}`;
  const pos = run.position;
  const state = pos
    ? `holding $${pos.symbol} (${pos.mark ? `${sf(pos.mark.netPct)} now` : 'fill pending'}${pos.fill ? `, ${hours(heldHours(pos, now))}` : ''}${pos.stale ? ', no trades 24h+' : ''})`
    : paused(run)
      ? 'daily goal met, paused until midnight'
      : 'in cash, searching';
  return `🔁 <b>Compounder ${label(run)} (paper):</b> $${run.seedUsd} → ${usd(b)} · ${s.targetHits} sold at target${s.early ? `, ${s.early} closed early` : ''} · ${state}`;
}

function positionSection(run, now, time) {
  const pos = run.position;
  if (!pos) return '**Open position:** none (cash, searching for the next pre-spike token).';
  const rows = [
    ['Token', `$${pos.symbol} (${pos.list ?? 'n/a'}) · [DexScreener](https://dexscreener.com/solana/${pos.pairAddress})`],
    ['Bought', `${time.short(new Date(pos.decidedAt))} · ${usd(pos.sizeUsd)}${pos.fill ? ` at $${price(pos.fill.rawPrice)}` : ' (fill pending)'}`],
    ['Sell target', pos.targetPriceUsd ? `$${price(pos.targetPriceUsd)} (+${run.targetNetPct}% net)` : `+${run.targetNetPct}% net`],
    ['Current value', pos.mark ? `${usd(pos.mark.proceeds)} (${sf(pos.mark.netPct)} net, at ${time.short(new Date(pos.mark.at))})` : 'n/a'],
    ['Best / worst while held', `${sf(pos.peakNetPct)} / ${sf(pos.worstNetPct)}`],
    ['Held for', hours(heldHours(pos, now))],
  ];
  if (pos.stale) rows.push(['⚠️ Warning', 'no trades for 24h+: the token may be dead. Still held per the rules.']);
  return `### Open position\n\n| | |\n|---|---|\n${rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n')}`;
}

// Side-by-side view of the active variants (same rules, different sell targets).
function comparisonSection(runs, now) {
  if (runs.length < 2) return '';
  const cols = runs.map((r) => ({ r, s: runStats(r), b: bankrollOf(r) }));
  const row = (label, fn) => `| ${label} | ${cols.map(fn).join(' | ')} |`;
  return `## Side by side

${row('', ({ r }) => `**${label(r)}**`)}
${row('Rule', ({ r }) => `+${r.targetNetPct}% per ${r.per === 'day' ? 'day (one sale, then wait for midnight ET)' : 'trade (search again right after a sale)'}`)}
|---|${cols.map(() => '---|').join('')}
${row('Bankroll now (open position at its last mark)', ({ b }) => `**${usd(b)}**`)}
${row('Return since the start', ({ r, b }) => `${sf((b / r.seedUsd - 1) * 100)} (from ${r.seedUsd})`)}
${row('Goal', ({ r, b }) => (r.goalUsd ? `${usd(goalBankroll(r))} (${usd(r.goalUsd)} to cash out + ${r.seedUsd} kept): ${f((b / goalBankroll(r)) * 100)}% there, ~${salesToGoal(r, b)} more target sales` : '–'))}
${row('Cycle', ({ r }) => cycleText(r))}
${row('Positions sold at the target', ({ s }) => `${s.targetHits}${s.early ? ` (+${s.early} closed early)` : ''}`)}
${row('Average time to reach the target', ({ s }) => hours(s.avgHoldHours))}
${row('Average worst point before the target', ({ s }) => sf(s.avgWorstNetPct))}
${row('Profit banked / costs', ({ s }) => `${usd(s.netUsd)} / ${usd(s.costsUsd)}`)}
${row('Days the daily goal was met (per-day runs)', ({ r }) => dayGoals(r))}
${row('Now', ({ r }) => nowText(r, now))}

Both runs screen the same candidates (every 15 min since 2026-10-28) with the same rules except token age (see Rules in effect), and each sells at its target or at the time limit.
They never hold the same token at the same time: when both are in cash in the same run, the first column picks first and the other takes its next best.
Each run loops: once its bankroll reaches the goal it is all cash (a held position is sold as soon as it is worth the goal, even below its target), the goal amount or more is cashed out, and a new cycle starts from the seed.
`;
}

function v2Section(run, cfg, now, time) {
  const s = runStats(run);
  const b = bankrollOf(run);
  const days = (now - Date.parse(run.startedAt)) / (24 * HOUR);
  const rows = [...run.trades].reverse().map((t) =>
    t.noFill
      ? `| ${t.n} | ${time.short(new Date(t.decidedAt))} | ${t.symbol} | ${t.list ?? ''} | ${usd(t.sizeUsd)} | – | – | – | – | – | – | ${usd(t.newBankroll)} |`
      : `| ${t.n} | ${time.short(new Date(t.fillAt))} | ${t.symbol} | ${t.list ?? ''} | ${usd(t.sizeUsd)} | ${hours(t.holdHours)} | ${sf(t.worstNetPct)} | ${price(t.entryPriceUsd)} → ${price(t.exitPriceUsd)} | ${usd(t.costsUsd)} | ${sf(t.netPct)} | ${usd(t.netUsd)} | ${usd(t.newBankroll)} |`,
  );
  const dayRow = run.per === 'day'
    ? `\n| Days the daily goal was met | ${dayGoals(run)}${run.day ? ` · today started at ${usd(run.day.startBankroll)}${run.day.goalMetAt ? ', goal met, paused until midnight' : ''}` : ''} |`
    : '';
  return `## ${label(run)}: run ${run.id} (${run.status.toUpperCase()})

| | |
|---|---|
| Start → now | $${run.seedUsd} → **${usd(b)}** (${sf((b / run.seedUsd - 1) * 100)}) |
| Running for | ${f(days)} days (since ${time.short(new Date(run.startedAt))})${run.copiedFrom ? `; started as a copy of ${run.copiedFrom}` : ''} |${run.goalUsd ? `\n| Cycle | ${cycleText(run)} |` : ''}
| Positions sold at +${run.targetNetPct}% | ${s.targetHits}${s.early ? ` (+${s.early} closed early by a one-off exit)` : ''} |
| Average time to reach the target | ${hours(s.avgHoldHours)} |
| Average worst point before the target | ${sf(s.avgWorstNetPct)} |
| Profit banked / costs | ${usd(s.netUsd)} / ${usd(s.costsUsd)} |${dayRow}
| Each +${run.targetNetPct}% sale multiplies the bankroll by | ${f(1 + run.targetNetPct / 100, 4)}×${run.goalUsd ? `; ${usd(goalBankroll(run))} goal: ${salesToGoal(run, b)} more target sales from here (${salesToGoal(run, run.seedUsd)} from the ${run.seedUsd} seed)` : ''} |

${positionSection(run, now, time)}

### Completed positions (newest first)

| # | Bought | Token | List | Size | Held | Worst | Entry → exit $ | Costs | Net | Net $ | Bankroll after |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| – | – | – | – | – | – | – | – | – | – | – | – |'}
`;
}

export function compounderMarkdown(ledger, cfg, now, time) {
  const k = cfg.compounder;
  const e = k.entry;
  const runs = [...ledger.runs].reverse();
  const order = (r) => k.variants.findIndex((v) => v.id === r.variant);
  const current = runs.filter((r) => r.status === 'active' && r.rules === k.rules).sort((a, b) => order(a) - order(b));
  const past = runs.filter((r) => !current.includes(r)).map((r) => {
    const s = runStats(r);
    return `| ${r.id} | ${r.rules ?? 'v1'} | $${r.seedUsd} | ${usd(r.finalBankroll ?? r.cash)}${r.cashOutUsd != null ? ` (${usd(r.cashOutUsd)} cashed out)` : ''} | ${s.trades} | ${f(s.winRate, 0, '%')} | ${r.status}${r.note ? ` (${r.note})` : ''} |`;
  });
  return `# FOMO Compounder: Results (PAPER MODE)

Updated ${time.when(now)}. Paper trades only: nothing is bought or sold.

**Rules ${k.rules} (since ${k.startDate}; two runs since 2026-10-20):** buy a token **before it spikes** with 100% of the bankroll,
**hold with no stop until it reaches the sell target**${k.maxHoldHours ? ` (or sell at its last price after ${k.maxHoldHours}h, since 2026-10-27)` : ''}, sell, and look for the next one. ${k.variants.map((v) => `**${v.name ?? v.id}:** ${v.seedUsd ?? k.seedUsd} seed, +${v.targetNetPct}% per ${v.per ?? 'trade'}, tokens ${ageWindow(entryFor(k, v.id))} since the pool opened${v.goalUsd ? `, at ${usd(v.goalUsd + (v.seedUsd ?? k.seedUsd))} cashes out ${usd(v.goalUsd)}+ and starts again from ${v.seedUsd ?? k.seedUsd}` : ''}`).join('. ')}.

${comparisonSection(current, now)}
${current.length ? current.map((r) => v2Section(r, cfg, now, time)).join('\n') : 'No run has started yet.'}
## Past runs

| Run | Rules | Seed | Final bankroll | Trades | Win rate | Result |
|---|---|---|---|---|---|---|
${past.join('\n') || '| – | – | – | – | – | – | – |'}

## Rules in effect

- **Lists:** Graduated (pump.fun) and Trending (GeckoTerminal). Tokens that graduated within ${e.graduatedBonusMaxAgeHours}h get +${e.graduatedBonus} score, older graduates 0, Trending-only tokens −${e.trendingOnlyPenalty}; market cap ≥ ${e.largeMcapUsd / 1e6}M −${e.largeMcapPenalty}.
- **Score (0–100 before adjustments):** 1h buys/sells 30, price rise in the hour (up to +10%) 15, 6h buys/sells 15, last 15 min volume vs the average 15 min 15, volume acceleration 15 (0 for pairs under ~1.5h), liquidity growth 10; minus 3 per 1% DEX round trip.
- **Price:** none for pairs under ${e.priceWindowsMinAgeHours}h old (since 2026-10-21; their 1h/6h change is the change since the pool opened), otherwise 1h change ${e.minChgH1Pct}% to +${e.maxChgH1Pct}% and 6h ${e.minChgH6Pct}% to +${e.maxChgH6Pct}%; no buy if up more than ${e.maxChg15mPct}% in the last 15 min (since 2026-10-24), no 5-min limit. The score rewards a 1h rise up to +10%.
- **Demand building:** last hour's volume ≥ ${e.minVolumeAcceleration}× the hours before${e.minVolumeTrend15m > 0 ? `, last 15 min ≥ ${e.minVolumeTrend15m}× the hour's 15-min average` : ''}, buys/sells ≥ ${e.minBuySellRatioH1} (1h) and ≥ ${e.minBuySellRatioH6} (6h) but ≤ ${e.maxBuySellRatio} (bots), ≥ ${e.minBuysH1} buys and $${e.minVolumeH1Usd / 1000}k volume in the hour, liquidity not shrinking.
- **Quality:** liquidity ≥ $${e.minLiquidityUsd / 1000}k and ≥ ${e.minLiquidityMultipleOfPosition}× the position, market cap ≥ ${e.minMarketCapUsd / 1000}k, pair age since the pool opened (time since graduation for pump.fun tokens): ${k.variants.map((v) => `${v.name ?? v.id} ${ageWindow(entryFor(k, v.id))}`).join(', ')} (since 2026-10-24; the volume-acceleration check is skipped for pairs under ~1.5h, which have no earlier hours), the monitor's safety checks, no top-10 share ≤ ${e.youngMinTop10Pct}% on tokens under ${e.youngMaxAgeHours}h (bundled wallets), round trip ≤ ${e.maxRoundTripPct}% at the real size, score ≥ ${e.minScore}.
- **Exit:** only at the run's target (${k.variants.map((v) => `+${v.targetNetPct}%`).join(' or ')} net, after fees and slippage) or at the run's goal, checked on 1-minute candles, so the sale happens at the first minute the price gets there even though the job runs every 15 min. No stop loss. ${k.maxHoldHours ? `Time limit (since 2026-10-27, ${k.maxHoldHours}h since 2026-10-28): a position that hasn't reached its target ${k.maxHoldHours}h after the fill is sold at the last price before then, and the run searches again.` : 'No time limit.'}
- **Crash filters (since 2026-10-28):** no buy if sells beat buys in the last 5 min (${e.minTxnsM5}+ trades), liquidity under ${e.minLiqToMcapPct}% of market cap, or, vs an earlier holder reading (10 min to 3h old), holders falling, the developer's share down ${e.maxDevDropPts}+ points, or the top-10 share down ${e.maxTop10DropPts}+ points.
- **Outcome tracker (since 2026-10-28):** every token a run evaluates inside its age window, bought or rejected, is re-priced ${k.outcomes?.afterMinutes?.join(' and ')} min later: [data/candidate-outcomes.jsonl](data/candidate-outcomes.jsonl).
- Paper fill ${k.fillDelayMinutes} min after the decision (cancelled if the token doesn't trade for ${k.noFillCancelHours}h). No re-buy of a token within ${k.cooldownHours}h of selling it. A warning is sent if a held token has no trades for ${k.staleAfterHours}h.

Every hourly decision, the reject counts and the candidates that passed the quick checks are logged in [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl).
`;
}

// Daily Telegram report per run: P&L over the last 24h (bankroll now vs its marked value 24h ago, from the hourly log),
// sales in that window, the open position, and progress to the goal. Runs that reached their goal in the window are included.
export function dailyReport(runs, hourly, now, time) {
  const dayAgo = now - 24 * HOUR;
  const blocks = runs.map((run) => {
    const b = bankrollOf(run);
    const then = Date.parse(run.startedAt) >= dayAgo ? null : hourly.find((h) => Date.parse(h.t) >= dayAgo && h.variants?.[run.variant]?.run === run.id);
    const startB = then ? then.variants[run.variant].bankroll : run.seedUsd;
    const pnl = b - startB;
    const sold = run.trades.filter((t) => !t.noFill && Date.parse(t.exitAt ?? t.decidedAt) >= dayAgo);
    const banked = sold.reduce((s, t) => s + t.netUsd, 0);
    const pos = run.position;
    const state = run.status === 'completed'
      ? `🏁 goal reached at ${usd(run.finalBankroll ?? run.cash)}: ${usd(run.cashOutUsd)} cashed out, new cycle from $${run.seedUsd}`
      : pos
        ? `holding $${pos.symbol}${pos.fill ? ` since ${time.short(new Date(pos.fill.at))}` : ' (fill pending)'}: ${pos.mark ? `${sf(pos.mark.netPct)} now` : 'not marked yet'}, target +${run.targetNetPct}%${pos.stale ? ' ⚠️ no trades 24h+' : ''}`
        : paused(run)
          ? "in cash, today's goal met: paused until midnight ET"
          : 'in cash, searching';
    const days = run.per === 'day' ? (run.days ?? []).slice(-1)[0] : null;
    return `<b>${(run.name ?? label(run)).toUpperCase()}</b> (+${run.targetNetPct}% per ${run.per === 'day' ? 'day' : 'trade'})
24h P&amp;L: <b>${pnl >= 0 ? '+' : ''}${usd(pnl)}</b> (${sf(startB > 0 ? (pnl / startB) * 100 : null)})${then ? '' : ' since the start'} · bankroll ${usd(startB)} → <b>${usd(b)}</b>
Banked in 24h: ${sold.length ? `${usd(banked)} from ${sold.length} sale${sold.length > 1 ? 's' : ''} (${sold.map((t) => `$${t.symbol} ${sf(t.netPct)}${t.holdHours != null ? ` in ${hours(t.holdHours)}` : ''}`).join(', ')})` : 'none'}
Now: ${state}${days ? `\nYesterday's daily goal: ${days.goalMetAt ? 'met ✅' : 'not met'}` : ''}
Since start: $${run.seedUsd} → ${usd(b)} (${sf((b / run.seedUsd - 1) * 100)}) · ${runStats(run).targetHits} target sales${run.goalUsd && run.status !== 'completed' ? ` · ${usd(goalBankroll(run))} goal: ${f((b / goalBankroll(run)) * 100)}%, ~${salesToGoal(run, b)} sales to go` : ''}${run.goalUsd ? `\nCycle ${run.cycle ?? 1} · total cashed out: ${usd((run.cashedOutBeforeUsd ?? 0) + (run.cashOutUsd ?? 0))}` : ''}`;
  });
  return `💰 <b>Compounders: daily P&amp;L (paper)</b>\n\n${blocks.join('\n\n')}`;
}
