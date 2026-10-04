# FOMO Signal Monitor: Results (PAPER MODE)

Updated Oct 4, 18:00 EDT. 3 of ~50 tracked alerts needed before review.

Each alert is a hypothetical $20 buy at the alert price, sold at the 24h exit deadline.
Costs = FOMO fees (0.5% or $0.37 minimum, each side) + quoted slippage/pool fees.

## Alert performance

| Metric | Value |
|---|---|
| Alerts (open / closed) | 9 (6 / 3) |
| Win rate after costs | 33% (plausible true range 6–79%) |
| Average gain (winners, after costs) | +16.2% |
| Average loss (losers, after costs) | -11.5% |
| Average / median result per alert, after costs | -2.3% / -9.7% |
| Profit factor (total won ÷ total lost; above 1 = profitable) | 0.70 |
| Net result after costs | -$1.37 |
| Gross result before costs | $1.31 |
| Total estimated costs | $2.68 |
| Avg best / worst price during hold | +56.0% / -10.5% |
| Share that were at some point up enough to cover costs | 33% |
| Best / worst single alert | $3.25 / -$2.68 |

## Signal quality: alerts vs tokens not alerted

Up to 5 tokens per run that passed the demand checks but were not alerted are tracked in the same way (hypothetical $20, 24h).
If alerts do not beat the runner-ups, the score is not adding value. If tokens that failed safety or cost checks do better than alerts, those rules may be too strict.
Costs for tokens without a live quote assume 1% slippage plus FOMO fees.

| Group | Closed | Win rate after costs | Avg before costs | Avg after costs | Avg best | Avg worst |
|---|---|---|---|---|---|---|
| **Alerts** | 3 | 33% | +2.2% | -2.3% | +56.0% | -10.5% |
| All runner-ups & near misses | 26 | 23% | -15.3% | -19.6% | +54.7% | -43.9% |
| ↳ runner-up | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ below score bar | 12 | 17% | +2.3% | -2.4% | +46.5% | -27.8% |
| ↳ failed cost/sellability | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ failed safety | 14 | 29% | -30.5% | -34.3% | +61.7% | -57.7% |
| ↳ not checked | 0 | n/a | n/a | n/a | n/a | n/a |

## All alerts (newest first)

| Alerted | Token | List | Status | Entry $ | Exit $ | Best | Worst | Costs | Net |
|---|---|---|---|---|---|---|---|---|---|
| Oct 4, 12:00 EDT | Crawler | Graduated | open | 0.0004519 | n/a | n/a | n/a | $1.17 | – |
| Oct 4, 10:00 EDT | DIT | Graduated | open | 0.0001547 | n/a | n/a | n/a | $1.26 | – |
| Oct 4, 06:00 EDT | SI | Trending+Graduated | open | 0.002511 | n/a | n/a | n/a | $1.20 | – |
| Oct 4, 04:00 EDT | PAYR | Graduated | open | 0.0006592 | n/a | n/a | n/a | $1.15 | – |
| Oct 3, 23:00 EDT | MISTAKE | Trending | open | 0.008592 | n/a | n/a | n/a | $0.92 | – |
| Oct 3, 21:00 EDT | catius | Graduated | open | 0.0007811 | n/a | n/a | n/a | $1.15 | – |
| Oct 3, 15:00 EDT | STONK | Trending | closed | 0.2215 | 0.2084 | +0.6% | -18.4% | $0.76 | -$1.94 |
| Oct 2, 18:00 EDT | HOTBOT | Trending | closed | 0.0007706 | 0.0009412 | +165.6% | -0.7% | $1.18 | $3.25 |
| Oct 2, 01:21 EDT | PENGU | Trending | closed | 0.009884 | 0.008927 | +1.9% | -12.4% | $0.74 | -$2.68 |

Runner-up records are in [data/shadows.json](data/shadows.json).
