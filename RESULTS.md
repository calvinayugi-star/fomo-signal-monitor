# FOMO Signal Monitor: Results (PAPER MODE)

Updated Oct 3, 17:00 EDT. 1 of ~50 tracked alerts needed before review.

Each alert is a hypothetical $20 buy at the alert price, sold at the 24h exit deadline.
Costs = FOMO fees (0.5% or $0.37 minimum, each side) + quoted slippage/pool fees.

## Alert performance

| Metric | Value |
|---|---|
| Alerts (open / closed) | 3 (2 / 1) |
| Win rate after costs | 0% (plausible true range 0–79%) |
| Average gain (winners, after costs) | n/a |
| Average loss (losers, after costs) | -13.4% |
| Average / median result per alert, after costs | -13.4% / -13.4% |
| Profit factor (total won ÷ total lost; above 1 = profitable) | 0.00 |
| Net result after costs | -$2.68 |
| Gross result before costs | -$1.94 |
| Total estimated costs | $0.74 |
| Avg best / worst price during hold | +1.9% / -12.4% |
| Share that were at some point up enough to cover costs | 0% |
| Best / worst single alert | -$2.68 / -$2.68 |

## Signal quality: alerts vs tokens not alerted

Up to 5 tokens per run that passed the demand checks but were not alerted are tracked in the same way (hypothetical $20, 24h).
If alerts do not beat the runner-ups, the score is not adding value. If tokens that failed safety or cost checks do better than alerts, those rules may be too strict.
Costs for tokens without a live quote assume 1% slippage plus FOMO fees.

| Group | Closed | Win rate after costs | Avg before costs | Avg after costs | Avg best | Avg worst |
|---|---|---|---|---|---|---|
| **Alerts** | 1 | 0% | -9.7% | -13.4% | +1.9% | -12.4% |
| All runner-ups & near misses | 12 | 25% | -15.7% | -20.5% | +22.3% | -33.3% |
| ↳ runner-up | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ below score bar | 8 | 0% | -23.4% | -28.3% | +21.4% | -37.4% |
| ↳ failed cost/sellability | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ failed safety | 4 | 75% | -0.3% | -5.0% | +24.0% | -25.1% |
| ↳ not checked | 0 | n/a | n/a | n/a | n/a | n/a |

## All alerts (newest first)

| Alerted | Token | List | Status | Entry $ | Exit $ | Best | Worst | Costs | Net |
|---|---|---|---|---|---|---|---|---|---|
| Oct 3, 15:00 EDT | STONK | Trending | open | 0.2215 | n/a | n/a | n/a | $0.76 | – |
| Oct 2, 18:00 EDT | HOTBOT | Trending | open | 0.0007706 | n/a | n/a | n/a | $1.18 | – |
| Oct 2, 01:21 EDT | PENGU | Trending | closed | 0.009884 | 0.008927 | +1.9% | -12.4% | $0.74 | -$2.68 |

Runner-up records are in [data/shadows.json](data/shadows.json).
