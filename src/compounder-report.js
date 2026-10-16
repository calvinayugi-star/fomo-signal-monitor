// Compounder results: run statistics, the open position, and COMPOUNDER.md.
// v2 runs (since 2026-10-10) sell only at the +target; v1 runs (October, stops and trailing exits) stay in "Past runs".
const HOUR = 3600e3;

const f = (x, d = 1, suffix = '') => (x == null || !Number.isFinite(x) ? 'n/a' : `${x.toFixed(d)}${suffix}`);
const sf = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
export const usd = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
export const price = (x) => (x == null ? 'n/a' : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
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
const label = (run) => `+${run.targetNetPct}% per ${run.per === 'day' ? 'day' : 'trade'}`;
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
|---|${cols.map(() => '---|').join('')}
${row('Bankroll now (open position at its last mark)', ({ b }) => `**${usd(b)}**`)}
${row('Return since the $100 start', ({ r, b }) => sf((b / r.seedUsd - 1) * 100))}
${row('Positions sold at the target', ({ s }) => `${s.targetHits}${s.early ? ` (+${s.early} closed early)` : ''}`)}
${row('Average time to reach the target', ({ s }) => hours(s.avgHoldHours))}
${row('Average worst point before the target', ({ s }) => sf(s.avgWorstNetPct))}
${row('Profit banked / costs', ({ s }) => `${usd(s.netUsd)} / ${usd(s.costsUsd)}`)}
${row('Days the daily goal was met (per-day runs)', ({ r }) => dayGoals(r))}
${row('Now', ({ r }) => nowText(r, now))}

All runs use identical entry rules and the same hourly candidates; each sells only when its position is up the target from the buy price.
**Per trade** runs buy again right after a sale. **Per day** runs stop buying for the rest of the day (until midnight ET) once the
bankroll is up the target versus its value at the start of the day. When several runs are in cash they usually buy the same token.
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
| Running for | ${f(days)} days (since ${time.short(new Date(run.startedAt))})${run.copiedFrom ? `; started as a copy of ${run.copiedFrom}` : ''} |
| Positions sold at +${run.targetNetPct}% | ${s.targetHits}${s.early ? ` (+${s.early} closed early by a one-off exit)` : ''} |
| Average time to reach the target | ${hours(s.avgHoldHours)} |
| Average worst point before the target | ${sf(s.avgWorstNetPct)} |
| Profit banked / costs | ${usd(s.netUsd)} / ${usd(s.costsUsd)} |${dayRow}
| Each +${run.targetNetPct}% sale multiplies the bankroll by | ${f(1 + run.targetNetPct / 100, 2)}× ($100 → $${(100 * (1 + run.targetNetPct / 100) ** 5).toFixed(0)} after 5, $${(100 * (1 + run.targetNetPct / 100) ** 10).toFixed(0)} after 10) |

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
  const current = runs.filter((r) => r.status === 'active' && r.rules === k.rules).sort((a, b) => (a.per === 'day') - (b.per === 'day') || b.targetNetPct - a.targetNetPct);
  const past = runs.filter((r) => !current.includes(r)).map((r) => {
    const s = runStats(r);
    return `| ${r.id} | ${r.rules ?? 'v1'} | $${r.seedUsd} | ${usd(r.finalBankroll ?? r.cash)} | ${s.trades} | ${f(s.winRate, 0, '%')} | ${r.status}${r.note ? ` (${r.note})` : ''} |`;
  });
  return `# FOMO Compounder: Results (PAPER MODE)

Updated ${time.when(now)}. Paper trades only: nothing is bought or sold.

**Rules ${k.rules} (since ${k.startDate}):** start with $${k.seedUsd}, buy a token **before it spikes** with 100% of the bankroll,
**hold with no stop and no time limit until it reaches the sell target** (${k.variants.map((v) => `+${v.targetNetPct}% per ${v.per ?? 'trade'}`).join(', ')}: run side by side), sell, and look for the next one.

${comparisonSection(current, now)}
${current.length ? current.map((r) => v2Section(r, cfg, now, time)).join('\n') : 'No run has started yet.'}
## Past runs

| Run | Rules | Seed | Final bankroll | Trades | Win rate | Result |
|---|---|---|---|---|---|---|
${past.join('\n') || '| – | – | – | – | – | – | – |'}

## Rules in effect

- **Lists:** Graduated (pump.fun) and Trending (GeckoTerminal). Tokens that graduated within ${e.graduatedBonusMaxAgeHours}h get +${e.graduatedBonus} score, older graduates 0, Trending-only tokens −${e.trendingOnlyPenalty}; market cap ≥ ${e.largeMcapUsd / 1e6}M −${e.largeMcapPenalty}.
- **Score (0–100 before adjustments):** 1h buys/sells 30, price rise in the hour (up to +10%) 15, 6h buys/sells 15, last 15 min volume vs the hour 15, volume acceleration 15, liquidity growth 10; minus 3 per 1% DEX round trip.
- **Before the spike (price still quiet):** 1h change ${e.minChgH1Pct}% to +${e.maxChgH1Pct}%, 15 min ${e.minChg15mPct}% to +${e.maxChg15mPct}% (no 6h or 5-min limit since 2026-10-16).
- **Demand building:** last hour's volume ≥ ${e.minVolumeAcceleration}× the hours before${e.minVolumeTrend15m > 0 ? `, last 15 min ≥ ${e.minVolumeTrend15m}× the hour's 15-min average` : ''}, buys/sells ≥ ${e.minBuySellRatioH1} (1h) and ≥ ${e.minBuySellRatioH6} (6h) but ≤ ${e.maxBuySellRatio} (bots), ≥ ${e.minBuysH1} buys and $${e.minVolumeH1Usd / 1000}k volume in the hour, liquidity not shrinking.
- **Quality:** liquidity ≥ $${e.minLiquidityUsd / 1000}k and ≥ ${e.minLiquidityMultipleOfPosition}× the position, market cap ≥ $${e.minMarketCapUsd / 1000}k, pair ≥ ${e.minPairAgeHours}h old, the monitor's safety checks, no top-10 share ≤ ${e.youngMinTop10Pct}% on tokens under ${e.youngMaxAgeHours}h (bundled wallets), round trip ≤ ${e.maxRoundTripPct}% at the real size, score ≥ ${e.minScore}.
- **Exit:** only at the variant's target (${k.variants.map((v) => `+${v.targetNetPct}%`).join(' or ')} net, after fees and slippage), checked on 1-minute candles, so the sale happens at the first minute the price gets there even though the job runs hourly. No stop loss, no time limit.
- Paper fill ${k.fillDelayMinutes} min after the decision (cancelled if the token doesn't trade for ${k.noFillCancelHours}h). No re-buy of a token within ${k.cooldownHours}h of selling it. A warning is sent if a held token has no trades for ${k.staleAfterHours}h.

Every hourly decision, the reject counts and the candidates that passed the quick checks are logged in [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl).
`;
}
