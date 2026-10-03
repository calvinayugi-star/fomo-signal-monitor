# FOMO Signal Monitor

An hourly research monitor. Each hour it looks for the strongest new buy candidate among tokens on FOMO-style
**Trending** and **Graduated** lists, sized for a **$20 spot position** that is **exited within 24 hours**, and sends at most one Telegram alert.
Every alert is tracked automatically. It runs in **paper mode**: alerts only, no trading authority and no wallet access.

## How a token qualifies

Each run rebuilds the two lists from public data. Solana only, because FOMO's graduated tokens are pump.fun graduates.

| List | Source |
|---|---|
| Trending | GeckoTerminal Solana trending pools (1h and 6h) |
| Graduated | pump.fun tokens that completed their bonding curve, pool created within the last 72h. Falls back to new PumpSwap pools if pump.fun is unreachable. |

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

## FOMO Daily Compounder (second strategy, paper mode)

A separate paper strategy that runs in the same hourly job and shares the same candidate lists. It tests whether a
small monthly seed can be compounded to a net target by trading strong momentum, one position at a time.
It never trades; Telegram messages are marked PAPER MODE. Settings are under `compounder` in [config.json](config.json).

- **Run:** a $100 seed on the 1st of each month (first run started 2026-10-03), 100% of the bankroll compounded, no money added.
  The run ends when withdrawable value after costs reaches $5,000, at month end, or if the bankroll falls below $25.
- **Entry (hourly):** 1h change between +10% and +60%; still rising over 5 and 15 minutes; buys/sells 1.15–5; last 15 minutes of volume at least
  the hour's 15-minute average; liquidity ≥ $25k and ≥ 50× the position; the monitor's safety checks; a Jupiter round trip at the real
  position size ≤ 4% including FOMO fees. The strongest token (1h change × volume trend) is bought; otherwise NO TRADE.
- **Exit:** stop −10% net (up to −15% for volatile tokens), judged on 15-minute closes so short wicks don't end a trade, plus an emergency
  stop on any price at −20% net that rises with the stop. At +10% net the stop locks +6% and then trails giving back at most 40% of the peak gain,
  6h time stop if the target isn't reached, 24h maximum hold. Paper fills happen 3 minutes after the alert and exits are settled on
  1-minute candles, so stops work as if the price were watched continuously, even though the job runs hourly.
- **Limits:** at most 2 entries a day (New York midnight), one position at a time, no re-entry into a token traded that day.
  After a winning day (+8% or more) a second trade needs +20% 1h momentum and a volume trend of 1.5. Near $5,000 the position
  is sized to need only about +10%.
- **Records:** [data/compounder-run.json](data/compounder-run.json) is the ledger: every run and trade, never deleted.
  [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl) has every hourly decision plus every token up 5% or more, traded or not.
  [COMPOUNDER.md](COMPOUNDER.md) is regenerated every run: bankroll against an even-pace line, win rate, average win and loss,
  the **win rate needed compared with the one achieved**, winner sizes, and every trade.
- **Telegram:** BUY alerts in the hourly report format, a full report after each exit, and one line in the 8 AM daily summary.
  Hourly NO TRADE decisions are logged only.
- **Replay:** `node src/compounder-replay.js [--run 2026-10]` reruns the logged hours with other floors (5–20%), stops (−3 to −8%),
  targets (+6 to +20%) and trailing give-backs (25–50%), and writes COMPOUNDER-REPLAY.md. Run it locally; candles are cached in `.cache/replay`.

**Why the stop is wide.** The first version stopped at −4 to −6% net on any 1-minute low. With 2–4% round-trip costs that was only 2–3% below
the entry price, and both trades on 2026-10-03 were stopped out within 4 minutes; one of them (HI) then rose 81% within the hour.
Since 2026-10-03 the stop is −10% net on 15-minute closes. The trade-off: losers lose about −10% instead of −6%, so the strategy
needs bigger winners or a higher win rate. COMPOUNDER.md shows the win rate needed against the one achieved, and the replay's stop rows show which width works.

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
