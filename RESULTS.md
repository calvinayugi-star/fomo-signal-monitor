# FOMO Signal Monitor: Results (PAPER MODE)

Updated Oct 3, 19:01 EDT. 2 of ~50 tracked alerts needed before review.

Each alert is a hypothetical $20 buy at the alert price, sold at the 24h exit deadline.
Costs = FOMO fees (0.5% or $0.37 minimum, each side) + quoted slippage/pool fees.

## Alert performance

| Metric | Value |
|---|---|
| Alerts (open / closed) | 3 (1 / 2) |
| Win rate after costs | 50% (plausible true range 9–91%) |
| Average gain (winners, after costs) | +16.2% |
| Average loss (losers, after costs) | -13.4% |
| Average / median result per alert, after costs | +1.4% / -13.4% |
| Profit factor (total won ÷ total lost; above 1 = profitable) | 1.21 |
| Net result after costs | $0.57 |
| Gross result before costs | $2.49 |
| Total estimated costs | $1.92 |
| Avg best / worst price during hold | +83.8% / -6.6% |
| Share that were at some point up enough to cover costs | 50% |
| Best / worst single alert | $3.25 / -$2.68 |

## Signal quality: alerts vs tokens not alerted

Up to 5 tokens per run that passed the demand checks but were not alerted are tracked in the same way (hypothetical $20, 24h).
If alerts do not beat the runner-ups, the score is not adding value. If tokens that failed safety or cost checks do better than alerts, those rules may be too strict.
Costs for tokens without a live quote assume 1% slippage plus FOMO fees.

| Group | Closed | Win rate after costs | Avg before costs | Avg after costs | Avg best | Avg worst |
|---|---|---|---|---|---|---|
| **Alerts** | 2 | 50% | +6.2% | +1.4% | +83.8% | -6.6% |
| All runner-ups & near misses | 14 | 36% | +14.9% | +10.1% | +57.3% | -29.8% |
| ↳ runner-up | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ below score bar | 9 | 11% | +0.1% | -4.9% | +54.8% | -35.0% |
| ↳ failed cost/sellability | 0 | n/a | n/a | n/a | n/a | n/a |
| ↳ failed safety | 5 | 80% | +41.6% | +36.9% | +62.0% | -20.4% |
| ↳ not checked | 0 | n/a | n/a | n/a | n/a | n/a |

## All alerts (newest first)

| Alerted | Token | List | Status | Entry $ | Exit $ | Best | Worst | Costs | Net |
|---|---|---|---|---|---|---|---|---|---|
| Oct 3, 15:00 EDT | STONK | Trending | open | 0.2215 | n/a | n/a | n/a | $0.76 | – |
| Oct 2, 18:00 EDT | HOTBOT | Trending | closed | 0.0007706 | 0.0009412 | +165.6% | -0.7% | $1.18 | $3.25 |
| Oct 2, 01:21 EDT | PENGU | Trending | closed | 0.009884 | 0.008927 | +1.9% | -12.4% | $0.74 | -$2.68 |

Runner-up records are in [data/shadows.json](data/shadows.json).
