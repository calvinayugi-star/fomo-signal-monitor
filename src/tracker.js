// Results tracker: follows every alert (and every runner-up, for comparison) for its 24h window,
// then records the outcome after costs. Records are never deleted.
import { getJson } from './http.js';
import { GT } from './sources.js';
import { dexPairs, fomoFee } from './screen.js';

const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
const MAX_CLOSES_PER_RUN = 12; // bounds run time; anything left closes next run from the same candles

// Hourly price sample for open records (a backup for when candle data is missing).
async function sampleOpen(open, log) {
  const pairs = await dexPairs([...new Set(open.map((a) => a.mint))], log);
  const now = Date.now();
  for (const a of open) {
    const price = Number(pairs.get(a.mint)?.priceUsd);
    if (!(price > 0) || now > Date.parse(a.exitDeadline)) continue;
    a.track.lastPriceUsd = price;
    a.track.lastSampleAt = new Date(now).toISOString();
    a.track.bestPriceUsd = Math.max(a.track.bestPriceUsd ?? price, price);
    a.track.worstPriceUsd = Math.min(a.track.worstPriceUsd ?? price, price);
  }
}

// 15-minute candles covering alert time -> exit deadline.
async function candles(a) {
  const before = Math.floor(Date.parse(a.exitDeadline) / 1000);
  const start = Math.floor(Date.parse(a.alertedAt) / 1000);
  const j = await getJson(
    `${GT}/networks/solana/pools/${a.pairAddress}/ohlcv/minute?aggregate=15&limit=100&currency=usd&token=${a.mint}&before_timestamp=${before}`,
  );
  return (j.data?.attributes?.ohlcv_list ?? [])
    .filter(([t]) => t + 900 > start && t < before)
    .sort((x, y) => x[0] - y[0]);
}

function close(a, cfg, { exit, best, worst, source }) {
  const entry = a.entryPriceUsd;
  const grossPct = pct(exit, entry) ?? -100;
  const exitValueUsd = Math.max(0, a.positionUsd * (1 + grossPct / 100));
  // Selling costs can't exceed what's left: a token that goes to ~0 loses the stake plus the buy fee.
  const sellSideUsd = Math.min(exitValueUsd, fomoFee(exitValueUsd, cfg.costs) + a.costs.dexRoundTripUsd);
  const costsUsd = a.costs.buyFeeUsd + sellSideUsd;
  const netUsd = exitValueUsd - a.positionUsd - costsUsd;
  a.status = 'closed';
  a.result = {
    closedAt: new Date().toISOString(),
    priceSource: source,
    exitPriceUsd: exit,
    bestPriceUsd: best,
    worstPriceUsd: worst,
    grossPct,
    bestPct: pct(best, entry),
    worstPct: pct(worst, entry),
    costsUsd,
    netUsd,
    netPct: (netUsd / a.positionUsd) * 100,
  };
}

export async function updateOpen(records, cfg, now, log) {
  const open = records.filter((a) => a.status === 'open');
  if (!open.length) return [];
  await sampleOpen(open, log);
  const closed = [];
  for (const a of open.filter((x) => now >= Date.parse(x.exitDeadline)).slice(0, MAX_CLOSES_PER_RUN)) {
    try {
      const list = await candles(a);
      const t = a.track;
      if (list.length) {
        close(a, cfg, {
          exit: list.at(-1)[4],
          best: Math.max(...list.map((c) => c[2]), t.bestPriceUsd ?? 0),
          worst: Math.min(...list.map((c) => c[3]), t.worstPriceUsd ?? Infinity),
          source: 'candles',
        });
      } else if (t.lastPriceUsd) {
        close(a, cfg, { exit: t.lastPriceUsd, best: t.bestPriceUsd, worst: t.worstPriceUsd, source: 'hourly samples' });
      } else {
        // No trading data at all after the alert: record as a total loss rather than dropping it.
        close(a, cfg, { exit: 0, best: a.entryPriceUsd, worst: 0, source: 'no data (treated as total loss)' });
      }
      closed.push(a);
    } catch (e) {
      log.errors.push(`close ${a.symbol}: ${e.message}`); // retried next run
    }
  }
  return closed;
}

// Wilson 95% interval: how far the true win rate could plausibly be from the measured one.
function wilson(wins, n) {
  if (!n) return null;
  const z = 1.96;
  const p = wins / n;
  const mid = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [Math.max(0, mid - half) * 100, Math.min(1, mid + half) * 100];
}

export function stats(records) {
  const closed = records.filter((a) => a.status === 'closed');
  const r = closed.map((a) => a.result);
  const wins = r.filter((x) => x.netUsd > 0);
  const losses = r.filter((x) => x.netUsd <= 0);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);
  const sortedNet = r.map((x) => x.netPct).sort((a, b) => a - b);
  const grossLoss = Math.abs(sum(losses.map((x) => x.netUsd)));
  return {
    total: records.length,
    open: records.length - closed.length,
    closed: closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : null,
    winRateRange: wilson(wins.length, closed.length),
    avgGainPct: avg(wins.map((x) => x.netPct)),
    avgLossPct: avg(losses.map((x) => x.netPct)),
    avgNetPct: avg(r.map((x) => x.netPct)),
    medianNetPct: sortedNet.length ? sortedNet[Math.floor((sortedNet.length - 1) / 2)] : null,
    avgGrossPct: avg(r.map((x) => x.grossPct)),
    profitFactor: grossLoss > 0 ? sum(wins.map((x) => x.netUsd)) / grossLoss : null,
    netUsd: sum(r.map((x) => x.netUsd)),
    grossUsd: sum(closed.map((a) => (a.positionUsd * a.result.grossPct) / 100)),
    costsUsd: sum(r.map((x) => x.costsUsd)),
    avgBestPct: avg(r.map((x) => x.bestPct).filter((x) => x != null)),
    avgWorstPct: avg(r.map((x) => x.worstPct).filter((x) => x != null)),
    // Share that at some point were up enough to cover costs: tells us whether a take-profit rule would help.
    touchedBreakevenPct: closed.length
      ? (closed.filter((a) => a.result.bestPct >= (a.result.costsUsd / a.positionUsd) * 100).length / closed.length) * 100
      : null,
    bestTradeUsd: r.length ? Math.max(...r.map((x) => x.netUsd)) : null,
    worstTradeUsd: r.length ? Math.min(...r.map((x) => x.netUsd)) : null,
  };
}

export const SHADOW_GROUPS = ['runner-up', 'below score bar', 'failed cost/sellability', 'failed safety', 'not checked'];

const f = (x, d = 1, suffix = '') => (x == null || !Number.isFinite(x) ? 'n/a' : `${x.toFixed(d)}${suffix}`);
const sf = (x, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`);
const usd = (x) => (x == null ? 'n/a' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`);
const price = (x) => (x == null ? 'n/a' : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const range = (r) => (r ? `${r[0].toFixed(0)}–${r[1].toFixed(0)}%` : 'n/a');

function comparisonRows(alerts, shadows) {
  const groups = [['**Alerts**', alerts], ['All runner-ups & near misses', shadows]];
  for (const g of SHADOW_GROUPS) groups.push([`↳ ${g}`, shadows.filter((s) => s.group === g)]);
  return groups.map(([label, recs]) => {
    const s = stats(recs);
    return `| ${label} | ${s.closed} | ${f(s.winRate, 0, '%')} | ${sf(s.avgGrossPct)} | ${sf(s.avgNetPct)} | ${sf(s.avgBestPct)} | ${sf(s.avgWorstPct)} |`;
  });
}

export function resultsMarkdown(alerts, shadows, cfg) {
  const tz = cfg.displayTimezone;
  const local = (d) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
    }).format(new Date(d));
  const s = stats(alerts);
  const rows = [...alerts].reverse().map((a) => {
    const r = a.result;
    return `| ${local(a.alertedAt)} | ${a.symbol} | ${a.sources.join('+')} | ${a.status} | ${price(a.entryPriceUsd)} | ${price(r?.exitPriceUsd)} | ${sf(r?.bestPct)} | ${sf(r?.worstPct)} | ${usd(r?.costsUsd ?? a.costs.totalUsd)} | ${r ? usd(r.netUsd) : '–'} |`;
  });
  const reviewNote =
    s.closed >= cfg.reviewAfterAlerts
      ? `**${s.closed} alerts tracked. Ready for review before any real-money decision.**`
      : `${s.closed} of ~${cfg.reviewAfterAlerts} tracked alerts needed before review.`;
  return `# FOMO Signal Monitor: Results (${cfg.mode.toUpperCase()} MODE)

Updated ${local(Date.now())}. ${reviewNote}

Each alert is a hypothetical $${cfg.positionUsd} buy at the alert price, sold at the ${cfg.holdHours}h exit deadline.
Costs = FOMO fees (${cfg.costs.fomoFeePct}% or $${cfg.costs.fomoMinFeeUsd} minimum, each side) + quoted slippage/pool fees.

## Alert performance

| Metric | Value |
|---|---|
| Alerts (open / closed) | ${s.total} (${s.open} / ${s.closed}) |
| Win rate after costs | ${f(s.winRate, 0, '%')} (plausible true range ${range(s.winRateRange)}) |
| Average gain (winners, after costs) | ${sf(s.avgGainPct)} |
| Average loss (losers, after costs) | ${sf(s.avgLossPct)} |
| Average / median result per alert, after costs | ${sf(s.avgNetPct)} / ${sf(s.medianNetPct)} |
| Profit factor (total won ÷ total lost; above 1 = profitable) | ${f(s.profitFactor, 2)} |
| Net result after costs | ${usd(s.netUsd)} |
| Gross result before costs | ${usd(s.grossUsd)} |
| Total estimated costs | ${usd(s.costsUsd)} |
| Avg best / worst price during hold | ${sf(s.avgBestPct)} / ${sf(s.avgWorstPct)} |
| Share that were at some point up enough to cover costs | ${f(s.touchedBreakevenPct, 0, '%')} |
| Best / worst single alert | ${usd(s.bestTradeUsd)} / ${usd(s.worstTradeUsd)} |

## Signal quality: alerts vs tokens not alerted

Up to ${cfg.shadow.maxPerRun} tokens per run that passed the demand checks but were not alerted are tracked in the same way (hypothetical $${cfg.positionUsd}, ${cfg.holdHours}h).
If alerts do not beat the runner-ups, the score is not adding value. If tokens that failed safety or cost checks do better than alerts, those rules may be too strict.
Costs for tokens without a live quote assume ${cfg.shadow.assumedDexRoundTripPct}% slippage plus FOMO fees.

| Group | Closed | Win rate after costs | Avg before costs | Avg after costs | Avg best | Avg worst |
|---|---|---|---|---|---|---|
${comparisonRows(alerts, shadows).join('\n')}

## All alerts (newest first)

| Alerted | Token | List | Status | Entry $ | Exit $ | Best | Worst | Costs | Net |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| – | – | – | – | – | – | – | – | – | – |'}

Runner-up records are in [data/shadows.json](data/shadows.json).
`;
}
