// Hourly entry point: track open alerts -> screen for a new candidate -> alert -> update results -> Compounder.
// With monitor.enabled false (since 2026-10-10) only the Compounder runs: the candidate lists and liquidity
// snapshots are still collected for it, already-open monitor records are tracked to their deadline, nothing new is alerted.
//   node src/run.js            normal run (sends Telegram if secrets are set, saves records)
//   node src/run.js --dry-run  prints the message, saves nothing
// Env: CONFIG (config path), DATA_DIR (records folder), CACHE_DIR (working data kept out of git),
//      TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen, fomoFee, dexPairs } from './screen.js';
import { collectCandidates } from './sources.js';
import { updateOpen, stats, resultsMarkdown } from './tracker.js';
import { sendTelegram, esc } from './telegram.js';
import { runCompounder } from './compounder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const SNAPSHOTS = path.join(path.resolve(process.env.CACHE_DIR ?? path.join(ROOT, '.cache')), 'snapshots.json');
const dryRun = process.argv.includes('--dry-run');
const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG ?? path.join(ROOT, 'config.json'), 'utf8'));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => fs.writeFileSync(path.join(DATA, file), JSON.stringify(value, null, 1) + '\n');

// Times shown in the display time zone, e.g. "Sun, Sep 27, 13:07 EDT".
const when = (d) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.displayTimezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(d);
const localHour = (d) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: cfg.displayTimezone, hour: 'numeric', hourCycle: 'h23' }).format(d));
const localDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.displayTimezone }).format(d); // YYYY-MM-DD
const px = (x) => (x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const stoppedNote = '> **The Signal Monitor was stopped on 2026-10-10** (no new alerts). These are its final results; only the Compounder still runs ([COMPOUNDER.md](COMPOUNDER.md)).\n\n';
const signed = (x, d = 0) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}%`;

function buildAlert(c, now) {
  const m = c.m;
  const decimals = c.safety.decimals;
  return {
    id: `${now.toISOString().slice(0, 13)}-${c.pair.baseToken.symbol}`,
    mode: cfg.mode,
    mint: c.mint,
    symbol: c.pair.baseToken.symbol,
    name: c.pair.baseToken.name,
    sources: [...c.sources],
    pairAddress: c.pair.pairAddress,
    dexId: c.pair.dexId,
    alertedAt: now.toISOString(),
    quoteExpiresAt: new Date(now.getTime() + cfg.quoteValidMinutes * 60e3).toISOString(),
    exitDeadline: new Date(now.getTime() + cfg.holdHours * 3600e3).toISOString(),
    positionUsd: cfg.positionUsd,
    entryPriceUsd: m.priceUsd,
    maxEntryPriceUsd: m.priceUsd * (1 + cfg.maxEntryDriftPct / 100),
    effectiveEntryPriceUsd: decimals != null ? cfg.positionUsd / (Number(c.cost.tokensOutRaw) / 10 ** decimals) : null,
    score: +c.score.toFixed(1),
    metrics: Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(4) : v])),
    safety: { holders: c.safety.holders, top10Pct: c.safety.top10, devPct: c.safety.devPct, gtScore: c.safety.gtScore },
    costs: {
      buyFeeUsd: c.cost.buyFeeUsd,
      estSellFeeUsd: c.cost.sellFeeUsd,
      dexRoundTripUsd: +c.cost.dexRoundTripUsd.toFixed(4),
      totalUsd: +c.cost.totalUsd.toFixed(4),
      totalPct: +c.cost.totalPct.toFixed(2),
      route: c.cost.route,
    },
    risks: buildRisks(c),
    delivered: false,
    status: 'open',
    track: {},
    result: null,
  };
}

function buildRisks(c) {
  const m = c.m;
  const risks = [...c.safety.risks];
  if (m.ageH < 24) risks.push(`young pool (${m.ageH.toFixed(1)}h old)`);
  if (m.chgH1 > 25) risks.push(`already up ${m.chgH1.toFixed(0)}% in the last hour; pullbacks are common`);
  if (m.liqUsd < 75000) risks.push(`thin liquidity ($${Math.round(m.liqUsd / 1000)}k)`);
  risks.push(`costs of ${c.cost.totalPct.toFixed(1)}% mean the price must rise at least that much just to break even`);
  risks.push('memecoins can go to zero within hours');
  return risks;
}

function alertMessage(a) {
  const m = a.metrics;
  const header =
    a.mode === 'paper'
      ? '📝 <b>PAPER MODE: tracking only, do not trade</b>\n'
      : '';
  return `${header}🟢 <b>BUY CANDIDATE: $${esc(a.symbol)}</b> (${esc(a.name)})
List: ${a.sources.join(' + ')} · Score ${a.score}/100
<code>${a.mint}</code>

<b>Entry conditions</b>
• $${a.positionUsd} spot buy, only if price ≤ <b>$${px(a.maxEntryPriceUsd)}</b> (alert price $${px(a.entryPriceUsd)} +${cfg.maxEntryDriftPct}%)
• Quote expires <b>${when(new Date(a.quoteExpiresAt))}</b>. After that, skip it.
• Est. costs $${a.costs.totalUsd.toFixed(2)} (${a.costs.totalPct.toFixed(1)}%): FOMO fees $${(a.costs.buyFeeUsd + a.costs.estSellFeeUsd).toFixed(2)} + slippage/pool $${a.costs.dexRoundTripUsd.toFixed(2)}

<b>Why it qualified</b>
• Volume ${m.accel.toFixed(1)}x the prior hourly average ($${Math.round(m.volH1 / 1000)}k in 1h)
• Buys/sells: ${m.ratioH1.toFixed(2)} (1h), ${m.ratioH6.toFixed(2)} (6h)
• Liquidity $${Math.round(m.liqUsd / 1000)}k (${m.liqGrowth != null ? `${signed(m.liqGrowth * 100)} vs ~1h ago` : "no earlier reading"})
• Price ${signed(m.chgH1)} 1h, ${signed(m.chgH6)} 6h
• ${a.safety.holders} holders; mint &amp; freeze authority off; sell route confirmed

<b>Risks</b>
${a.risks.map((r) => `• ${esc(r)}`).join('\n')}

⏰ <b>Exit deadline: ${when(new Date(a.exitDeadline))}</b>. Sell no later than this.
<a href="https://dexscreener.com/solana/${a.pairAddress}">DexScreener</a> · <a href="https://www.geckoterminal.com/solana/pools/${a.pairAddress}">GeckoTerminal</a>`;
}

// Runner-ups / near misses: tracked like alerts (never sent) so the score can be judged against them.
function buildShadow(c, now) {
  const estimated = !c.cost?.ok;
  return {
    id: `${now.toISOString().slice(0, 13)}-${c.pair.baseToken.symbol}`,
    mint: c.mint,
    symbol: c.pair.baseToken.symbol,
    sources: [...c.sources],
    pairAddress: c.pair.pairAddress,
    alertedAt: now.toISOString(),
    exitDeadline: new Date(now.getTime() + cfg.holdHours * 3600e3).toISOString(),
    positionUsd: cfg.positionUsd,
    entryPriceUsd: c.m.priceUsd,
    group: c.group,
    outcome: c.outcome,
    demandScore: +c.demandScore.toFixed(1),
    score: c.score != null ? +c.score.toFixed(1) : null,
    costs: {
      buyFeeUsd: fomoFee(cfg.positionUsd, cfg.costs),
      dexRoundTripUsd: estimated
        ? (cfg.positionUsd * cfg.shadow.assumedDexRoundTripPct) / 100
        : +c.cost.dexRoundTripUsd.toFixed(4),
      estimated,
    },
    status: 'open',
    track: {},
    result: null,
  };
}

// Warns in the daily summary before the cron-job.org GitHub token expires (it can't warn by itself).
function tokenReminder(now) {
  const t = cfg.triggerToken;
  if (!t?.expires) return '';
  const days = Math.ceil((Date.parse(`${t.expires}T23:59:59Z`) - now) / 86400e3);
  if (days > t.remindDaysBefore) return '';
  const when = days > 0 ? `expires in <b>${days} day${days === 1 ? '' : 's'}</b> (${t.expires})` : `<b>expired</b> on ${t.expires}`;
  const lapsed = days <= 0 ? "\nUntil then the monitor only runs when GitHub's own scheduler starts it (every few hours)." : '';
  return `

⚠️ <b>Action needed:</b> the GitHub token used by cron-job.org ${when}.
Create a new one (github.com/settings/personal-access-tokens/new: only fomo-signal-monitor, Actions: Read and write), paste it into the cron-job.org job's Authorization header after "Bearer ", then update triggerToken.expires in config.json.${lapsed}`;
}

// Last 24h of run logs (plus this run), so the summary also proves the monitor is alive.
function activityLines(log, now) {
  const runs = [];
  try {
    for (const line of fs.readFileSync(path.join(DATA, 'runs.jsonl'), 'utf8').trim().split('\n')) {
      const r = JSON.parse(line);
      if (now - Date.parse(r.t) <= 24 * 3600e3) runs.push(r);
    }
  } catch {
    /* no log yet */
  }
  runs.push(log);
  const sum = (k) => runs.reduce((s, r) => s + (r[k] ?? 0), 0);
  const blockers = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.rejects ?? {})) blockers[k] = (blockers[k] ?? 0) + v;
  const top = Object.entries(blockers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${esc(k)} (${v})`)
    .join(', ');
  return `<b>Last 24h:</b> ${runs.length} runs, ~${Math.round(sum('candidates') / runs.length)} tokens checked per run
Passed demand checks: ${sum('passedDemand')} · Runner-ups recorded: ${sum('shadowed')} · Alerts: ${runs.filter((r) => r.alerted).length}
Top reasons tokens were rejected: ${top || 'n/a'}`;
}

function summaryMessage(alerts, shadows, closedSinceLast, log, now, compounderLine) {
  const s = stats(alerts);
  const sh = stats(shadows);
  const f = (x, suffix = '%') => (x == null ? 'n/a' : `${x.toFixed(1)}${suffix}`);
  const recent = closedSinceLast.map(
    (a) => `• $${esc(a.symbol)}: ${a.result.netUsd >= 0 ? '+' : '-'}$${Math.abs(a.result.netUsd).toFixed(2)} net (best ${f(a.result.bestPct)}, worst ${f(a.result.worstPct)})`,
  );
  const results = s.total
    ? `Alerts: ${s.total} (${s.open} open, ${s.closed} closed of ~${cfg.reviewAfterAlerts} for review)
Win rate: ${f(s.winRate)} · Avg gain ${f(s.avgGainPct)} · Avg loss ${f(s.avgLossPct)}
Net after costs: ${s.netUsd < 0 ? '-' : ''}$${Math.abs(s.netUsd).toFixed(2)} (costs $${s.costsUsd.toFixed(2)})
Avg per alert after costs: ${f(s.avgNetPct)} vs runner-ups ${f(sh.avgNetPct)} (${sh.closed} tracked)`
    : `No alerts yet: no token has cleared every check. Runner-ups tracked: ${sh.total} (${sh.closed} closed).`;
  return `📊 <b>Daily summary (${cfg.mode.toUpperCase()} MODE)</b>
${results}
${recent.length ? `\nClosed since last summary:\n${recent.join('\n')}\n` : ''}
${compounderLine ? `${compounderLine}

` : ''}${activityLines(log, now)}${tokenReminder(now)}`;
}

// Daily summary once the monitor is stopped: the Compounder line plus proof the job is alive.
function compounderSummary(log, now, compounderLine) {
  let runs = 1;
  try {
    for (const line of fs.readFileSync(path.join(DATA, 'runs.jsonl'), 'utf8').trim().split('\n'))
      if (now - Date.parse(JSON.parse(line).t) <= 24 * 3600e3) runs++;
  } catch {
    /* no log yet */
  }
  return `📊 <b>Daily summary (PAPER MODE)</b>
${compounderLine || 'Compounder: no data this run.'}

<b>Last 24h:</b> ${runs} hourly runs${log.errors.length ? ` · errors this run: ${log.errors.length}` : ''}${tokenReminder(now)}`;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const now = new Date();
  let snapshots = {};
  try {
    snapshots = JSON.parse(fs.readFileSync(SNAPSHOTS, 'utf8'));
  } catch {
    /* first run, or the cache expired: liquidity history rebuilds within an hour */
  }
  const store = { alerts: readJson('alerts.json', []), shadows: readJson('shadows.json', []), snapshots };
  const state = readJson('state.json', {});
  const log = { t: now.toISOString(), errors: [] };
  let shared = {}; // candidates and DEX pairs, reused by the Compounder
  const monitorOn = cfg.monitor?.enabled !== false;

  try {
    log.closed = (await updateOpen(store.alerts, cfg, now, log)).map((a) => a.symbol);
    log.closedShadows = (await updateOpen(store.shadows, cfg, now, log)).length;
  } catch (e) {
    log.errors.push(`tracker: ${e.message}`);
  }

  if (!monitorOn) {
    // Monitor stopped: only gather what the Compounder needs (lists, DEX pairs, liquidity history).
    try {
      const candidates = await collectCandidates(cfg, log);
      const pairs = await dexPairs(candidates.map((c) => c.mint), log);
      for (const [mint, p] of pairs)
        (store.snapshots[mint] ??= []).push({ t: now.getTime(), liqUsd: p.liquidity?.usd ?? 0, priceUsd: Number(p.priceUsd) });
      shared = { candidates, pairs };
      log.candidates = candidates.length;
    } catch (e) {
      log.errors.push(`candidates: ${e.message}`);
    }
  } else try {
    const { best, others, candidates, pairs } = await screen(cfg, store, now, log);
    shared = { candidates, pairs };
    const recentShadow = new Set(
      store.shadows.filter((x) => now - Date.parse(x.alertedAt) < cfg.shadow.cooldownHours * 3600e3).map((x) => x.mint),
    );
    const shadows = others.filter((c) => !recentShadow.has(c.mint)).slice(0, cfg.shadow.maxPerRun);
    store.shadows.push(...shadows.map((c) => buildShadow(c, now)));
    log.shadowed = shadows.length;
    if (best) {
      const alert = buildAlert(best, now);
      alert.delivered = await sendTelegram(alertMessage(alert), { dryRun });
      store.alerts.push(alert);
      log.alerted = alert.symbol;
    }
  } catch (e) {
    log.errors.push(`screen: ${e.message}`);
  }

  // The Compounder (separate paper strategy) shares this run's candidates; its errors never stop the monitor.
  let compounderLine = '';
  if (cfg.compounder?.enabled) {
    try {
      compounderLine = await runCompounder({
        cfg,
        ...shared,
        snapshots: store.snapshots,
        dryRun,
        dataDir: DATA,
        reportPath: path.join(process.env.DATA_DIR ? DATA : ROOT, 'COMPOUNDER.md'),
        log,
      });
    } catch (e) {
      log.errors.push(`compounder: ${e.message}`);
    }
  }

  // Once a day, at the first run at or after the summary hour (runs can be late), even with no alerts.
  if (localHour(now) >= cfg.dailySummaryHour && state.lastSummaryDate !== localDate(now)) {
    const since = Date.parse(state.lastSummaryAt ?? 0);
    const closedSince = store.alerts.filter((a) => a.result && Date.parse(a.result.closedAt) > since);
    const msg = monitorOn
      ? summaryMessage(store.alerts, store.shadows, closedSince, log, now, compounderLine)
      : compounderSummary(log, now, compounderLine);
    if (await sendTelegram(msg, { dryRun })) {
      state.lastSummaryAt = now.toISOString();
      state.lastSummaryDate = localDate(now);
    }
  }

  // Liquidity snapshots are working data (not records), so keep only the last 26h.
  const cutoff = now.getTime() - 26 * 3600e3;
  for (const [mint, snaps] of Object.entries(store.snapshots)) {
    const kept = snaps.filter((s) => s.t >= cutoff);
    if (kept.length) store.snapshots[mint] = kept;
    else delete store.snapshots[mint];
  }

  console.log(JSON.stringify(log, null, 1));
  if (dryRun) return;
  writeJson('alerts.json', store.alerts);
  writeJson('shadows.json', store.shadows);
  if (!monitorOn) {
    // RESULTS.md keeps updating only while the last open monitor records close.
    if (log.closed?.length || log.closedShadows)
      fs.writeFileSync(path.join(process.env.DATA_DIR ? DATA : ROOT, 'RESULTS.md'), stoppedNote + resultsMarkdown(store.alerts, store.shadows, cfg));
    fs.mkdirSync(path.dirname(SNAPSHOTS), { recursive: true });
    fs.writeFileSync(SNAPSHOTS, JSON.stringify(store.snapshots));
    writeJson('state.json', state);
    fs.appendFileSync(path.join(DATA, 'runs.jsonl'), JSON.stringify(log) + '\n');
    return;
  }
  fs.mkdirSync(path.dirname(SNAPSHOTS), { recursive: true });
  fs.writeFileSync(SNAPSHOTS, JSON.stringify(store.snapshots));
  writeJson('state.json', state);
  fs.appendFileSync(path.join(DATA, 'runs.jsonl'), JSON.stringify(log) + '\n');
  fs.writeFileSync(path.join(process.env.DATA_DIR ? DATA : ROOT, 'RESULTS.md'), resultsMarkdown(store.alerts, store.shadows, cfg));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
