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

**Scheduling.** GitHub's free scheduler skips many runs (here it managed about one every 5 hours on an hourly schedule).
So the workflow is offered 4 times an hour (:07, :22, :37, :52 UTC), and a guard step exits within seconds if the monitor ran in the last 50 minutes.
The repository is public, so these runs use no paid minutes (public repositories get unlimited free Actions minutes).
Others can read it but not change it, and the Telegram secrets are never visible.
If it is ever made private, set the schedule back to hourly (`'7 * * * *'`) first, or the runs can exceed the 2,000 free minutes a month.
The records are committed after each run, which also keeps the schedule from being paused for inactivity.

## Running locally

```powershell
node src/run.js --dry-run   # screens now, prints any alert, saves nothing
```

## Limits

- Research only. It has no trading code, no wallet access, and nothing it produces is financial advice.
- The lists approximate FOMO's Trending and Graduated tabs. They are not an exact copy.
- The honeypot check relies on token-program flags plus a live sell quote. Neither guarantees a real sell will succeed.
- Best and worst prices come from 15-minute candles, so short wicks may be missed.
