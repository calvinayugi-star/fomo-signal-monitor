# Perps Compounders: Results (PAPER MODE)

Updated Wed, Nov 18, 01:45 EST. Paper trades on Hyperliquid's live market data: no account, no real orders.

**Rules (since 2026-11-17):** every 15 min, screen every Hyperliquid perp; open the best setup, **long or short, 10x isolated with 100% of the bankroll as margin**.
Close at the run's net target (a resting limit order, maker fee); no time limit since 2026-11-17 (trades get time to breathe). **Stop-loss at 90% of the way to liquidation** (since 2026-11-17; liquidation is about 5–9% against the position depending on the coin), a market order that keeps the margin a liquidation would take.
**Conservative Perps:** $110 seed, +13.93% net per day (no new trades after its first target sale of the day until midnight ET), no time limit, trades only in the direction of the last 4h, needs a 1.45% price move. **Aggressive Perps:** $25 seed, +20% net per trade (searching again right after each sale), no time limit, needs a 2.06% price move.
At $5000.00 + the seed a run cashes out $5000.00+ and starts again from the seed. The runs never hold the same coin; no coin twice within 24h.

## Conservative Perps: perps-conservative-2026-11-16 (ACTIVE)

| | |
|---|---|
| Start → now | $110 → **$142.78** (+29.8%) since Mon, Nov 16, 21:15 EST |
| Cycle | 1, $0.00 cashed out in earlier cycles; goal $5110.00 |
| Trades | 2: 2 at target, 0 at the time limit, 0 stopped, 0 liquidated |
| Days the daily goal was met | 2 of 3 |

| # | Filled | Coin | Side | Exit | Held | Worst | Fees | Net | Bankroll after |
|---|---|---|---|---|---|---|---|---|---|
| 2 | Nov 17, 00:32 | WLD | long | +13.93% target | 6.86h | -17.3% | $0.75 | +13.9% ($17.46) | $142.78 |
| 1 | Nov 16, 22:17 | AAVE | long | +13.93% target | 0.16h | -1.2% | $0.66 | +13.9% ($15.32) | $125.32 |

## Aggressive Perps: perps-aggressive-2026-11-16 (ACTIVE)

| | |
|---|---|
| Start → now | $25 → **$25.00** (+0.0%) since Mon, Nov 16, 21:15 EST |
| Cycle | 1, $0.00 cashed out in earlier cycles; goal $5025.00 |
| Trades | 0: 0 at target, 0 at the time limit, 0 stopped, 0 liquidated |

| # | Filled | Coin | Side | Exit | Held | Worst | Fees | Net | Bankroll after |
|---|---|---|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – | – | – | – |

## Rules in effect

- **Universe:** perps allowing 10x, 24h volume ≥ $5M, open interest ≥ $2M, spread ≤ 0.1%.
- **Entry:** last 15 min volume ≥ 1.5× the day's average 15 min; price moved 0.3–2.5% in 15 min (long if up, short if down), with the last hour the same way; this side pays at most 0.01%/h funding; a typical 2h range ≥ 1× the needed move; the worst 2h swing against this side in the last day < 80% of the distance to liquidation; score ≥ 50.
- **Score:** volume surge 30, 15-min move 20, 1h trend 15, open interest rising 15, room to reach the target 10, funding 10.
- **Costs:** taker 0.045% on the entry and time-limit exits (plus half the spread), maker 0.015% on the take-profit, hourly funding at the rate seen at entry.
- **Fills:** paper fill at the open of the first minute after the decision; exits checked minute by minute (liquidation before the take-profit inside a minute).

