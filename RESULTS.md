# FOMO Signal Monitor: Results (PAPER MODE)

Updated Oct 5, 23:00 EDT. 10 of ~50 tracked alerts needed before review.

Each alert is a hypothetical $20 buy at the alert price, sold at the 24h exit deadline.
Costs = FOMO fees (0.5% or $0.37 minimum, each side) + quoted slippage/pool fees.

## Alert performance

| Metric | Value |
|---|---|
| Alerts (open / closed) | 14 (4 / 10) |
| Win rate after costs | 10% (plausible true range 2–40%) |
| Average gain (winners, after costs) | +16.2% |
| Average loss (losers, after costs) | -63.3% |
| Average / median result per alert, after costs | -55.3% / -63.8% |
| Profit factor (total won ÷ total lost; above 1 = profitable) | 0.03 |
| Net result after costs | -$110.60 |
| Gross result before costs | -$102.51 |
| Total estimated costs | $8.09 |
| Avg best / worst price during hold | +94.2% / -61.8% |
| Share that were at some point up enough to cover costs | 80% |
| Best / worst single alert | $3.25 / -$20.37 |

## Signal quality: alerts vs tokens not alerted

Up to 5 tokens per run that passed the demand checks but were not alerted are tracked in the same way (hypothetical $20, 24h).
If alerts do not beat the runner-ups, the score is not adding value. If tokens that failed safety or cost checks do better than alerts, those rules may be too strict.
Costs for tokens without a live quote assume 1% slippage plus FOMO fees.

| Group | Closed | Win rate after costs | Avg before costs | Avg after costs | Avg best | Avg worst |
|---|---|---|---|---|---|---|
| **Alerts** | 10 | 10% | -51.3% | -55.3% | +94.2% | -61.8% |
| All runner-ups & near misses | 39 | 15% | -23.9% | -28.1% | +44.4% | -45.5% |
| ↳ runner-up | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ below score bar | 18 | 11% | -4.0% | -8.7% | +38.0% | -28.8% |
| ↳ failed cost/sellability | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ failed safety | 21 | 19% | -41.0% | -44.6% | +50.0% | -59.9% |
| ↳ not checked | 0 | n/a | n/a | n/a | n/a | n/a |

## All alerts (newest first)

| Alerted | Token | List | Status | Entry $ | Exit $ | Best | Worst | Costs | Net |
|---|---|---|---|---|---|---|---|---|---|
| Oct 5, 16:06 EDT | PLAGUE | Graduated | open | 0.001983 | n/a | n/a | n/a | $1.19 | – |
| Oct 5, 12:00 EDT | SWAP | Trending+Graduated | open | 0.0004630 | n/a | n/a | n/a | $1.18 | – |
| Oct 5, 10:00 EDT | BATONROGUE | Graduated | open | 0.0009927 | n/a | n/a | n/a | $1.34 | – |
| Oct 5, 02:00 EDT | Cadence | Trending | open | 0.0007718 | n/a | n/a | n/a | $1.16 | – |
| Oct 4, 19:00 EDT | AGENTCAT | Trending+Graduated | closed | 0.01541 | 0.000009437 | +179.1% | -100.0% | $0.38 | -$20.37 |
| Oct 4, 12:00 EDT | Crawler | Graduated | closed | 0.0004519 | 0.000007559 | +55.5% | -98.5% | $0.70 | -$20.37 |
| Oct 4, 10:00 EDT | DIT | Graduated | closed | 0.0001547 | 0.00009619 | +201.0% | -73.5% | $1.26 | -$8.82 |
| Oct 4, 06:00 EDT | SI | Trending+Graduated | closed | 0.002511 | 0.001888 | +11.0% | -55.2% | $1.20 | -$6.17 |
| Oct 4, 04:00 EDT | PAYR | Graduated | closed | 0.0006592 | 0.000004411 | +94.2% | -99.4% | $0.50 | -$20.37 |
| Oct 3, 23:00 EDT | MISTAKE | Trending | closed | 0.008592 | 0.003502 | +203.0% | -60.2% | $0.92 | -$12.77 |
| Oct 3, 21:00 EDT | catius | Graduated | closed | 0.0007811 | 0.000002726 | +30.1% | -99.7% | $0.44 | -$20.37 |
| Oct 3, 15:00 EDT | STONK | Trending | closed | 0.2215 | 0.2084 | +0.6% | -18.4% | $0.76 | -$1.94 |
| Oct 2, 18:00 EDT | HOTBOT | Trending | closed | 0.0007706 | 0.0009412 | +165.6% | -0.7% | $1.18 | $3.25 |
| Oct 2, 01:21 EDT | PENGU | Trending | closed | 0.009884 | 0.008927 | +1.9% | -12.4% | $0.74 | -$2.68 |

Runner-up records are in [data/shadows.json](data/shadows.json).
