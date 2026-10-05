# FOMO Signal Monitor: Results (PAPER MODE)

Updated Oct 4, 23:00 EDT. 4 of ~50 tracked alerts needed before review.

Each alert is a hypothetical $20 buy at the alert price, sold at the 24h exit deadline.
Costs = FOMO fees (0.5% or $0.37 minimum, each side) + quoted slippage/pool fees.

## Alert performance

| Metric | Value |
|---|---|
| Alerts (open / closed) | 10 (6 / 4) |
| Win rate after costs | 25% (plausible true range 5–70%) |
| Average gain (winners, after costs) | +16.2% |
| Average loss (losers, after costs) | -41.6% |
| Average / median result per alert, after costs | -27.2% / -13.4% |
| Profit factor (total won ÷ total lost; above 1 = profitable) | 0.13 |
| Net result after costs | -$21.74 |
| Gross result before costs | -$18.62 |
| Total estimated costs | $3.12 |
| Avg best / worst price during hold | +49.6% / -32.8% |
| Share that were at some point up enough to cover costs | 50% |
| Best / worst single alert | $3.25 / -$20.37 |

## Signal quality: alerts vs tokens not alerted

Up to 5 tokens per run that passed the demand checks but were not alerted are tracked in the same way (hypothetical $20, 24h).
If alerts do not beat the runner-ups, the score is not adding value. If tokens that failed safety or cost checks do better than alerts, those rules may be too strict.
Costs for tokens without a live quote assume 1% slippage plus FOMO fees.

| Group | Closed | Win rate after costs | Avg before costs | Avg after costs | Avg best | Avg worst |
|---|---|---|---|---|---|---|
| **Alerts** | 4 | 25% | -23.3% | -27.2% | +49.6% | -32.8% |
| All runner-ups & near misses | 30 | 20% | -21.7% | -25.9% | +52.7% | -48.0% |
| ↳ runner-up | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ below score bar | 14 | 14% | -1.9% | -6.6% | +40.5% | -30.8% |
| ↳ failed cost/sellability | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ failed safety | 16 | 25% | -39.1% | -42.7% | +63.5% | -62.9% |
| ↳ not checked | 0 | n/a | n/a | n/a | n/a | n/a |

## All alerts (newest first)

| Alerted | Token | List | Status | Entry $ | Exit $ | Best | Worst | Costs | Net |
|---|---|---|---|---|---|---|---|---|---|
| Oct 4, 19:00 EDT | AGENTCAT | Trending+Graduated | open | 0.01541 | n/a | n/a | n/a | $0.86 | – |
| Oct 4, 12:00 EDT | Crawler | Graduated | open | 0.0004519 | n/a | n/a | n/a | $1.17 | – |
| Oct 4, 10:00 EDT | DIT | Graduated | open | 0.0001547 | n/a | n/a | n/a | $1.26 | – |
| Oct 4, 06:00 EDT | SI | Trending+Graduated | open | 0.002511 | n/a | n/a | n/a | $1.20 | – |
| Oct 4, 04:00 EDT | PAYR | Graduated | open | 0.0006592 | n/a | n/a | n/a | $1.15 | – |
| Oct 3, 23:00 EDT | MISTAKE | Trending | open | 0.008592 | n/a | n/a | n/a | $0.92 | – |
| Oct 3, 21:00 EDT | catius | Graduated | closed | 0.0007811 | 0.000002726 | +30.1% | -99.7% | $0.44 | -$20.37 |
| Oct 3, 15:00 EDT | STONK | Trending | closed | 0.2215 | 0.2084 | +0.6% | -18.4% | $0.76 | -$1.94 |
| Oct 2, 18:00 EDT | HOTBOT | Trending | closed | 0.0007706 | 0.0009412 | +165.6% | -0.7% | $1.18 | $3.25 |
| Oct 2, 01:21 EDT | PENGU | Trending | closed | 0.009884 | 0.008927 | +1.9% | -12.4% | $0.74 | -$2.68 |

Runner-up records are in [data/shadows.json](data/shadows.json).
