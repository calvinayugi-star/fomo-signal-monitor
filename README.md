# FOMO Signal Monitor

> **Status (2026-10-10): the $20 Signal Monitor is stopped; only the [Compounder](#fomo-compounder-second-strategy-paper-mode) runs.**
> `monitor.enabled` is `false` in config.json: the hourly job still collects the Trending/Graduated lists and liquidity history for the
> Compounder, but sends no monitor alerts and records no new runner-ups. Its final results stay in [RESULTS.md](RESULTS.md) and data/alerts.json.
> Set `monitor.enabled` to `true` to restart it.

An hourly research monitor. Each hour it looks for the strongest new buy candidate among tokens on FOMO-style
**Trending** and **Graduated** lists, sized for a **$20 spot position** that is **exited within 24 hours**, and sends at most one Telegram alert.
Every alert is tracked automatically. It runs in **paper mode**: alerts only, no trading authority and no wallet access.

## How a token qualifies

Each run rebuilds the two lists from public data. Solana only, because FOMO's graduated tokens are pump.fun graduates.

| List | Source |
|---|---|
| Trending | GeckoTerminal Solana trending pools (1h and 6h) |
| Graduated | pump.fun tokens that completed their bonding curve, pool created within the last 72h. Falls back to the most-traded PumpSwap pools (pump.fun mints only) if pump.fun is unreachable. |

Tokens alerted in the last 7 days are skipped. Every remaining token must pass all of the checks below. All thresholds live in [config.json](config.json).

1. **Demand** (DexScreener): liquidity ≥ $25k, market cap ≥ $100k, pool ≥ 2h old, 1h volume ≥ $15k with ≥ 60 buys,
   buys/sells ≥ 1.15 over 1h and ≥ 1.0 over 6h but no more than 5 (higher is a volume bot), 1h volume at least the prior hourly average,
   price over 1h between -5% and +50% (to avoid chasing a spike), and 6h change no worse than -10%.
   Liquidity must also be flat or growing compared with this monitor's own previous reading (40 minutes to 8 hours earlier).
   So a token must be seen on two runs before it can alert.
2. **Safety** (GeckoTerminal and GoPlus):
   - Mint and freeze authority must be confirmed off.
   - Rejects honeypot flags, transfer fees, transfer hooks, and tokens whose balances can be changed or that can be closed.
   - Needs ≥ 300 holders; the top 10 wallets may hold at most 60%, a figure that includes the liquidity pool.
   - The developer wallet may hold at most 10%.
3. **Sellability and cost** (Jupiter): a live $20 buy quote followed by a sell quote for the tokens received.
   If there is no sell route, the token is rejected as a possible honeypot. Slippage and pool fees must be ≤ 3%, and total cost ≤ 7%.
4. **Score** (0–100): volume acceleration, buy pressure (1h and 6h), liquidity growth, momentum and volume size,
   minus penalties for pool costs and wallet concentration. The best token scoring ≥ 55 is alerted. If none reaches 55, nothing is sent.

Each alert contains the entry conditions (maximum entry price, quote expiry 20 minutes after the alert), estimated costs, the reasons it qualified, the risks, and the exit deadline.

### Costs: a $20 position starts about 4–7% behind

The FOMO app quoted a **$0.37 fee** on a $20 trade (checked 2026-09-27). The monitor assumes the same fee on the sell,
so about $0.74, or 3.7%, of a $20 position before slippage. With up to 3% slippage and pool fees on top,
each alert needs roughly a +4–7% move just to break even.
The model is `max(fomoMinFeeUsd, fomoFeePct × trade size)`. Update `costs` in [config.json](config.json) if the fee in the app changes.

## Results tracker

- [data/alerts.json](data/alerts.json): every alert, never deleted. Each record holds the entry price, estimated costs, the exit-deadline price,
  the best and worst prices during the hold (15-minute candles), and the net result after costs.
- [data/shadows.json](data/shadows.json): runner-ups and near misses, also never deleted. Each run, up to 5 tokens that passed the demand
  checks but were not alerted are tracked the same way, at most once per token per 24h. Each is labelled with why it wasn't alerted:
  runner-up, below the score bar, failed safety, failed cost/sellability, or not checked.
- [RESULTS.md](RESULTS.md): regenerated every run. It contains:
  - Alert performance: win rate with its plausible range, average gain and loss, average and median result, profit factor,
    net result after costs, best and worst prices, and how often a token was at some point up enough to cover costs.
  - A **signal quality** table comparing alerts with each runner-up group.
  - A table of every alert.
- [data/runs.jsonl](data/runs.jsonl): one line per run with rejection counts. Use it to see which rule filters out the most tokens when tuning.
- A daily Telegram summary is sent at the first run at or after 8 AM New York time (`dailySummaryHour`, in `displayTimezone`), even when there are no alerts. It also shows the last 24h of activity: runs, tokens checked, how many passed, and the top rejection reasons. It includes the alerts' average result next to the runner-ups'.
- Hourly liquidity readings are working data, not records. They are kept in the GitHub Actions cache (`.cache/`), not in the repository.

**Reading the signal quality table.** If alerts don't clearly beat the runner-ups, the score isn't picking winners.
If tokens that failed a rule do as well as alerts, that rule may be too strict.
Runner-ups build up several times faster than alerts, so these comparisons become meaningful before 50 alerts have closed.

Stay in paper mode until about 50 alerts have closed and the numbers have been reviewed.

## FOMO Compounder (second strategy, paper mode)

A separate paper strategy that runs in the same hourly job and shares the same candidate lists. It never trades;
Telegram messages are marked PAPER MODE. Settings are under `compounder` in [config.json](config.json).

**Rules v2 (since 2026-10-10).** Start with $100. Buy a token **before it spikes** with 100% of the bankroll, **hold it with no
stop loss and no time limit until it is +20% net** (after fees and slippage), sell, and immediately look for the next one.

**Four variants run side by side** (`compounder.variants`), each with its own $100 run and bankroll:

| | +20% | +10% |
|---|---|---|
| **Per trade** | sell at +20%, buy again right away | sell at +10%, buy again right away |
| **Per day** (added 2026-10-11) | sell at +20%; once the day is up +20%, no new buys until midnight ET | same with +10% |

Per-day runs never sell below the target either: a position held overnight still waits for +X% from its buy price. The day's goal is measured
from the bankroll at the first hourly run after midnight ET and counts only banked gains. All four use
identical entry rules and the same hourly candidates (API results are shared, so extra variants add almost no calls).
The +10% run was added on 2026-10-11 as a copy of the +20% run (same start, same open Fartcoin position, re-checked against +10% from the fill),
since with identical rules it would have made the same decisions until then. COMPOUNDER.md opens with a side-by-side table, and every
Telegram message is labelled with its variant, e.g. COMPOUNDER +20%/trade or COMPOUNDER +10%/day; per-day runs also send a "daily goal met" message.
The per-day runs were added the same way, as copies of the +20% run (same start and open position).

- **Lists:** since 2026-10-16 Graduated and Trending tokens are scored alike (before: +10 for graduates under 72h, −15 for Trending-only); no graduation age limit.
- **Entry (hourly), "before the spike":** the price is still quiet (15 min −20% to +12%; no 1h limit)
  while demand builds (last hour's volume ≥ 1.0× the hours before, buys/sells 1.15–5 over 1h and ≥ 1 over 6h,
  liquidity not shrinking). Same quality bar as the monitor: liquidity ≥ $25k and ≥ 50× the position, market cap ≥ $100k, safety checks,
  round trip ≤ 4% at the real size. New: tokens under 72h whose top 10 wallets hold ≤ 8% are rejected (7 of 9 such alerts went to near zero).
  Loosened 2026-10-14 (no buys for 2.5 days): volume acceleration 1.5× → 1.25×, 15-min volume trend 1.2× → 0.9×, 15-min floor −5% → −10%. Score bar (50) and bot filters unchanged.
  Loosened 2026-10-16 (user review, no buys in ~4 days): volume acceleration 1.25× → 1.1× (bot clones sit at ~1.00×), 15-min volume trend rule removed (0),
  15-min floor −10% → −20% (3 of 3 tokens rejected for a 15-min dip hit +20% within 11h), 1h window −5..+15% → −10..+25%. Score bar (50) and bot filters unchanged.
  Also 2026-10-16: 72h graduated limit removed (old Monitor alerts: tokens ≥72h old 0 of 8 fell 80%+, under 72h 13 of 19), Graduated bonus now only
  for graduates under 72h; 6h window (−15..+100%) and 5-min spike limit (≤ +8%) removed. Volume acceleration 1.1× → 1.0× (user choice; clones at ~1.00×
  are still held back by the 1h volume, bot-ratio and score rules). 1h price window (−10..+25%) removed (user choice). Reviewed and kept: pair ≥ 2h, buys/sells ≥ 1.15 (1h) / ≥ 1 (6h) / ≤ 5, liquidity, round trip ≤ 4%.
  Score re-weighted 2026-10-16 (user choice, from 36 stage-2 near-misses Oct 10–16): 1h buys/sells 30, 1h price rise up to +10% 15, 6h buys/sells 15,
  15-min volume trend 15, volume acceleration 15 (was 30), liquidity growth 10 (was 15), −15 for market cap ≥ $50M, list adjustments 0, bar 50 → 45.
  On those 36 tokens: 11 entries, 7 hit +20%, 0 crashed (current score at 50: 10 entries, 7 hit, 1 crashed). Fitted on the same data, so expect worse live.
- **Exit:** only at the variant's target (+20% or +10% net), checked on 1-minute candles, so the paper sale happens the first minute the price gets there. Nothing else ends a position.
  If a held token has no trades for 24h a warning is sent (it may be dead), but it stays held.
  One-off exception (user request, 2026-10-11): `compounder.oneOffExits` closes the Fartcoin position bought 2026-10-11 07:00 UTC in all runs
  if no target is hit within 24h of the fill (2026-10-12 07:03 UTC), at the last price before then. It matches only that position.
- **Records:** [data/compounder-run.json](data/compounder-run.json) is the ledger (every run and trade, never deleted; the v1 October run
  is kept there, ended at $44.19). [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl) has every hourly decision, reject counts and the
  candidates that passed the quick checks. [COMPOUNDER.md](COMPOUNDER.md) shows the bankroll, the open position (value, best/worst, time held)
  and every completed position.
- **Telegram:** a BUY alert, a SOLD report at the target, a stale-token warning, and one line in the 8 AM daily summary.

**Risk of this design.** With no stop, a token that collapses before reaching +20% is held indefinitely and the whole bankroll is tied up in it.
In the 2026-10 data, 31 of 45 Graduated-only tokens (69%) reached +20% net within 24h of being flagged, and 12 of the other 14 went to near zero.
The target was +50% when v2 started (2026-10-10) and was lowered to +20% the same day to favour hit rate.

**v1 (2026-10-03 to 2026-10-10)** bought +10–60% 1h momentum with −10% stops and a +10% trailing target; it went from $100 to $44.19 in 14 trades.
`node src/compounder-replay.js` still replays the v1 rules (settings under `compounderV1`).

## Setup (one time)

**1. Telegram bot**
1. In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts. Copy the **token** it gives you.
2. Open your new bot and press **Start**.
3. In PowerShell, from this folder:
   ```powershell
   $env:TELEGRAM_BOT_TOKEN = "paste-token-here"
   node src/telegram-setup.js            # prints your chat ID
   $env:TELEGRAM_CHAT_ID = "paste-chat-id-here"
   node src/telegram-setup.js --test     # sends a test message
   ```

**2. GitHub (free scheduler)**
1. Create a repository on github.com, for example `fomo-signal-monitor`.
2. Push this folder to it:
   ```powershell
   git init -b main
   git add .
   git commit -m "FOMO Signal Monitor"
   git remote add origin https://github.com/<you>/fomo-signal-monitor.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Secrets and variables → Actions → New repository secret**. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
4. Go to **Actions → FOMO Signal Monitor → Run workflow** to test it once. After that it runs about once an hour.

**Scheduling.** GitHub's own scheduler starts runs here only every 4–6 hours, so the main trigger is external:
a free **cron-job.org** job sends a POST to this workflow's `dispatches` endpoint at the top of every hour.
It uses a fine-grained GitHub token limited to this repository with *Actions: Read and write* only. The token expires around 2026-12-31; replace it in cron-job.org before then.
GitHub's schedule (4 slots an hour) stays as a backup; a guard step makes those runs exit within seconds if the monitor ran in the last 50 minutes.
The repository is public (unlimited free Actions minutes). Others can read it but not change it, and the Telegram secrets are never visible.
Actions must be pinned to full commit SHAs (a repository setting); keep that when updating the workflow.
