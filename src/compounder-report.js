// Compounder results: run statistics, the pace toward the target, and COMPOUNDER.md.
const DAY = 86400e3;

const f = (x, d = 1, suffix = '') => (x == null || !Number.isFinite(x) ? 'n/a' : `${x.toFixed(d)}${suffix}`);
const sf = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
export const usd = (x) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
export const price = (x) => (x == null ? 'n/a' : x >= 1 ? x.toFixed(4) : x.toPrecision(4));

// Bankroll right now: cash plus the open position at its last marked net value (at cost if not marked yet).
export const bankrollOf = (run) => run.cash + (run.position ? run.position.mark?.proceeds ?? run.position.sizeUsd : 0);

export function runStats(run) {
  const trades = run.trades.filter((t) => !t.noFill);
  const wins = trades.filter((t) => t.netUsd > 0);
  const losses = trades.filter((t) => t.netUsd <= 0);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    avgWinPct: avg(wins.map((t) => t.netPct)),
    avgLossPct: avg(losses.map((t) => t.netPct)),
    avgNetPct: avg(trades.map((t) => t.netPct)),
    costsUsd: trades.reduce((s, t) => s + t.costsUsd, 0),
    targetHits: trades.filter((t) => t.targetHit).length,
    atLeast: [10, 15, 20, 30].map((x) => [x, trades.filter((t) => t.netPct >= x).length]),
    reasons: trades.reduce((m, t) => ((m[t.reason] = (m[t.reason] ?? 0) + 1), m), {}),
  };
}

// Win rate needed to compound bankroll -> target in tradesLeft trades with the given average win/loss.
export function requiredWinRate(bankroll, target, tradesLeft, avgWinPct, avgLossPct) {
  if (bankroll >= target) return 0;
  if (!(tradesLeft > 0) || !(avgWinPct > 0) || avgLossPct == null) return null;
  const w = Math.log(1 + avgWinPct / 100);
  const l = Math.log(1 + avgLossPct / 100);
  return ((Math.log(target / bankroll) / tradesLeft - l) / (w - l)) * 100;
}

// The even-compounding path from seed (start) to target (month end): where the bankroll "should" be now.
export function pace(run, now) {
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.endsAt);
  const total = (end - start) / DAY;
  const elapsed = Math.min(total, Math.max(0, (now - start) / DAY));
  const left = Math.max(0, (end - now) / DAY);
  const bankroll = bankrollOf(run);
  return {
    totalDays: total,
    elapsedDays: elapsed,
    daysLeft: left,
    paceBankroll: run.seedUsd * (run.targetUsd / run.seedUsd) ** (elapsed / total),
    dailyNeededPct: left > 0.5 && bankroll < run.targetUsd ? ((run.targetUsd / bankroll) ** (1 / left) - 1) * 100 : null,
    seedDailyNeededPct: ((run.targetUsd / run.seedUsd) ** (1 / total) - 1) * 100,
  };
}

export function summaryLine(run, now) {
  if (!run) return '';
  const b = bankrollOf(run);
  const s = runStats(run);
  const tail =
    run.status === 'active'
      ? `${b >= pace(run, now).paceBankroll ? 'on pace' : 'behind pace'} (pace today ${usd(pace(run, now).paceBankroll)})`
      : run.status.toUpperCase();
  return `🔁 <b>Compounder (paper):</b> $${run.seedUsd} → ${usd(b)} → $${run.targetUsd.toLocaleString('en-US')} · ${s.trades} trades (${s.wins}W/${s.losses}L) · ${tail}`;
}

function runSection(run, cfg, now, time) {
  const s = runStats(run);
  const p = pace(run, now);
  const b = bankrollOf(run);
  const k = cfg.compounder;
  const tradesLeft = Math.floor(p.daysLeft * k.daily.maxEntries);
  const tradesTotal = Math.floor(p.totalDays * k.daily.maxEntries);
  const A = k.assumed;
  const need = (bank, n, w, l) => {
    const x = requiredWinRate(bank, run.targetUsd, n, w, l);
    return x == null ? 'n/a' : x > 100 ? 'impossible (>100%)' : `${x.toFixed(0)}%`;
  };
  const pos = run.position;
  const posText = pos
    ? `**Open position:** $${pos.symbol}, ${usd(pos.sizeUsd)} decided ${time.short(new Date(pos.decidedAt))}` +
      (pos.fill ? `, filled at $${price(pos.fill.rawPrice)}` : ', fill pending') +
      (pos.mark ? `; last mark ${sf(pos.mark.netPct)} net at ${time.short(new Date(pos.mark.at))}${pos.mark.targetHit ? ' (target reached, trailing)' : ''}` : '') +
      `. Stop ${-pos.stopNetPct}% net.`
    : '**Open position:** none (cash).';
  const rows = [...run.trades].reverse().map((t) =>
    t.noFill
      ? `| ${t.n} | ${time.short(new Date(t.decidedAt))} | ${t.symbol} | ${usd(t.sizeUsd)} | – | – | – | – | – | – | ${usd(t.newBankroll)} | not filled |`
      : `| ${t.n} | ${time.short(new Date(t.fillAt))} | ${t.symbol} | ${usd(t.sizeUsd)} | ${price(t.entryPriceUsd)} | ${price(t.exitPriceUsd)} | ${sf(t.grossPct)} | ${usd(t.costsUsd)} | ${sf(t.netPct)} | ${usd(t.netUsd)} | ${usd(t.newBankroll)} | ${t.reason} |`,
  );
  return `## Run ${run.id} (${run.status.toUpperCase()})

| | |
|---|---|
| Seed → bankroll → target | $${run.seedUsd} → **${usd(b)}** → $${run.targetUsd.toLocaleString('en-US')} |
| Run return | ${sf((b / run.seedUsd - 1) * 100)} |
| Distance remaining | ${usd(Math.max(0, run.targetUsd - b))} |
| Days elapsed / left | ${f(p.elapsedDays)} / ${f(p.daysLeft)} |
| Even-pace bankroll today | ${usd(p.paceBankroll)} (${b >= p.paceBankroll ? 'on pace' : 'behind'}) |
| Daily net return needed: from the seed / from here | ${sf(p.seedDailyNeededPct)} / ${sf(p.dailyNeededPct)} |
| Trades (wins / losses) | ${s.trades} (${s.wins} / ${s.losses}) |
| Win rate | ${f(s.winRate, 0, '%')} |
| Average win / average loss (net) | ${sf(s.avgWinPct)} / ${sf(s.avgLossPct)} |
| Average net per trade | ${sf(s.avgNetPct)} |
| Total estimated costs | ${usd(s.costsUsd)} |

${posText}

### Win rate needed vs achieved

Assumes up to ${k.daily.maxEntries} trades a day for the rest of the run, compounding the whole bankroll.

| | Assumed win/loss (${sf(A.avgWinPct)} / ${sf(A.avgLossPct)}) | Actual win/loss (${sf(s.avgWinPct)} / ${sf(s.avgLossPct)}) |
|---|---|---|
| Whole run from the seed (${tradesTotal} trades) | ${need(run.seedUsd, tradesTotal, A.avgWinPct, A.avgLossPct)} | ${need(run.seedUsd, tradesTotal, s.avgWinPct, s.avgLossPct)} |
| From the current bankroll (${tradesLeft} trades left) | ${need(b, tradesLeft, A.avgWinPct, A.avgLossPct)} | ${need(b, tradesLeft, s.avgWinPct, s.avgLossPct)} |
| **Achieved** | ${f(s.winRate, 0, '%')} | ${f(s.winRate, 0, '%')} |

### Winner sizes and exits

Trades reaching the +${k.exits.targetNetPct}% target: ${s.targetHits}. Net results of at least ${s.atLeast.map(([x, n]) => `+${x}%: ${n}`).join(' · ')}.
Exit reasons: ${Object.entries(s.reasons).map(([r, n]) => `${r} (${n})`).join(', ') || 'n/a'}.

### Trades (newest first)

| # | Entered | Token | Size | Entry $ | Exit $ | Gross | Costs | Net | Net $ | Bankroll after | Exit |
|---|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| – | – | – | – | – | – | – | – | – | – | – | – |'}
`;
}

export function compounderMarkdown(ledger, cfg, now, time) {
  const k = cfg.compounder;
  const runs = [...ledger.runs].reverse();
  const current = runs[0];
  const past = runs.slice(current?.status === 'active' ? 1 : 0).map((r) => {
    const s = runStats(r);
    return `| ${r.id} | $${r.seedUsd} | ${usd(r.cash)} | ${s.trades} | ${f(s.winRate, 0, '%')} | ${r.status} |`;
  });
  const e = k.exits;
  return `# FOMO Daily Compounder: Results (PAPER MODE)

Updated ${time.when(now)}. Paper trades only: nothing is bought or sold.

Each run starts with a $${k.seedUsd} seed on the 1st of the month (first run: ${k.startDate}), compounds 100% of the bankroll one
position at a time, and stops when withdrawable value after costs reaches $${k.targetUsd.toLocaleString('en-US')}, at month end, or below $${k.bustBelowUsd}.

${current ? runSection(current, cfg, now, time) : 'No run has started yet.'}
## Past runs

| Run | Seed | Final bankroll | Trades | Win rate | Result |
|---|---|---|---|---|---|
${past.join('\n') || '| – | – | – | – | – | – |'}

## Rules in effect

- Entry: 1h change +${k.momentum.minChgH1Pct}% to +${k.momentum.maxChgH1Pct}% (after a winning day: +${k.daily.afterWin.minChgH1Pct}% and volume trend ≥ ${k.daily.afterWin.minVolumeTrend}), 5-min and 15-min change positive, buys/sells ${k.momentum.minBuySellRatioH1}–${k.momentum.maxBuySellRatio}, last 15 min volume ≥ ${k.momentum.minVolumeTrend}× the hour's 15-min average, liquidity ≥ $${k.liquidity.minUsd / 1000}k and ≥ ${k.liquidity.minMultipleOfPosition}× the position, safety checks, round trip ≤ ${k.costs.maxRoundTripPct}% at the real size.
- Exit: stop −${e.stopNetPct}% net (up to −${e.maxStopNetPct}% for volatile tokens: ${e.atrStopMultiple}× the average 5-min range), judged on ${e.stopCheckMinutes}-min closes so short wicks don't end a trade; emergency stop on any price at −${e.emergencyStopNetPct}% net, rising with the stop. Lock +${e.lockNetPct}% at +${e.targetNetPct}% net then trail giving back ≤ ${e.trailGiveBackPct}% of the peak gain, time stop ${e.timeStopHours}h without the target, max hold ${e.maxHoldHours}h.
- Paper fill ${e.fillDelayMinutes} min after the decision; exits settled on 1-minute candles (the stop is checked before any new high can raise it).
- At most ${k.daily.maxEntries} entries a day (midnight ${cfg.displayTimezone}), one position at a time, no re-entry into a token traded that day.
- Near the target the position is sized to need about +${k.sizing.expectedNetPct}% (with a ${k.sizing.bufferPct}% buffer); the finish line exits at $${k.targetUsd.toLocaleString('en-US')} + ${k.finishLineBufferPct}%.

Every token up ≥ ${k.momentum.logFromChgH1Pct}% in an hour is logged in [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl).
\`node src/compounder-replay.js\` reruns the logged hours with other floors, stops, targets and trailing settings (results in COMPOUNDER-REPLAY.md).
`;
}
