# FOMO Compounder: Results (PAPER MODE)

Updated Sun, Oct 11, 00:00 EDT. Paper trades only: nothing is bought or sold.

**Rules v2 (since 2026-10-10):** start with $100, buy a token **before it spikes** with 100% of the bankroll,
**hold with no stop and no time limit until it is +20% net**, sell, and look for the next one. Graduated tokens are preferred.

## Run v2-2026-10-10 (ACTIVE)

| | |
|---|---|
| Start → now | $100 → **$100.00** (+0.0%) |
| Running for | 0.5 days (since Oct 10, 13:00) |
| Positions sold at +20% | 0 |
| Average time to reach the target | n/a |
| Average worst point before the target | n/a |
| Profit banked / costs | $0.00 / $0.00 |
| Each +20% sale multiplies the bankroll by | 1.20× ($100 → $249 after 5, $619 after 10) |

**Open position:** none (cash, searching for the next pre-spike token).

### Completed positions (newest first)

| # | Bought | Token | List | Size | Held | Worst | Entry → exit $ | Costs | Net | Net $ | Bankroll after |
|---|---|---|---|---|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – | – | – | – | – | – |

## Past runs

| Run | Rules | Seed | Final bankroll | Trades | Win rate | Result |
|---|---|---|---|---|---|---|
| 2026-10 | v1 | $100 | $45.29 | 15 | 40% | ended (rules changed to v2 on 2026-10-10) |

## Rules in effect

- **Lists:** Graduated (pump.fun, graduated within 72h) and Trending (GeckoTerminal). Graduated tokens get +10 score; Trending-only tokens −15.
- **Before the spike (price still quiet):** 1h change -5% to +15%, 6h -15% to +100%, 15 min -5% to +12%, 5 min ≤ +8%.
- **Demand building:** last hour's volume ≥ 1.5× the hours before, last 15 min ≥ 1.2× the hour's 15-min average, buys/sells ≥ 1.15 (1h) and ≥ 1 (6h) but ≤ 5 (bots), ≥ 60 buys and $15k volume in the hour, liquidity not shrinking.
- **Quality:** liquidity ≥ $25k and ≥ 50× the position, market cap ≥ $100k, pair ≥ 2h old, the monitor's safety checks, no top-10 share ≤ 8% on tokens under 72h (bundled wallets), round trip ≤ 4% at the real size, score ≥ 50.
- **Exit:** only at +20% net (after fees and slippage), checked on 1-minute candles, so the sale happens at the first minute the price gets there even though the job runs hourly. No stop loss, no time limit.
- Paper fill 3 min after the decision (cancelled if the token doesn't trade for 6h). No re-buy of a token within 24h of selling it. A warning is sent if a held token has no trades for 24h.

Every hourly decision, the reject counts and the candidates that passed the quick checks are logged in [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl).
