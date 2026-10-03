# FOMO Daily Compounder: Results (PAPER MODE)

Updated Sat, Oct 3, 04:00 EDT. Paper trades only: nothing is bought or sold.

Each run starts with a $100 seed on the 1st of the month (first run: 2026-10-03), compounds 100% of the bankroll one
position at a time, and stops when withdrawable value after costs reaches $5,000, at month end, or below $25.

## Run 2026-10 (ACTIVE)

| | |
|---|---|
| Seed → bankroll → target | $100 → **$94.20** → $5,000 |
| Run return | -5.8% |
| Distance remaining | $4905.80 |
| Days elapsed / left | 0.1 / 28.8 |
| Even-pace bankroll today | $101.70 (behind) |
| Daily net return needed: from the seed / from here | +14.5% / +14.8% |
| Trades (wins / losses) | 1 (0 / 1) |
| Win rate | 0% |
| Average win / average loss (net) | n/a / -5.8% |
| Average net per trade | -5.8% |
| Total estimated costs | $3.33 |

**Open position:** none (cash).

### Win rate needed vs achieved

Assumes up to 2 trades a day for the rest of the run, compounding the whole bankroll.

| | Assumed win/loss (+10.0% / -4.5%) | Actual win/loss (n/a / -5.8%) |
|---|---|---|
| Whole run from the seed (57 trades) | 81% | n/a |
| From the current bankroll (57 trades left) | 82% | n/a |
| **Achieved** | 0% | 0% |

### Winner sizes and exits

Trades reaching the +10% target: 0. Net results of at least +10%: 0 · +15%: 0 · +20%: 0 · +30%: 0.
Exit reasons: stop loss (1).

### Trades (newest first)

| # | Entered | Token | Size | Entry $ | Exit $ | Gross | Costs | Net | Net $ | Bankroll after | Exit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Oct 3, 03:03 | HI | $100.00 | 0.0005868 | 0.0005723 | -2.5% | $3.33 | -5.8% | -$5.80 | $94.20 | stop loss |

## Past runs

| Run | Seed | Final bankroll | Trades | Win rate | Result |
|---|---|---|---|---|---|
| – | – | – | – | – | – |

## Rules in effect

- Entry: 1h change +10% to +60% (after a winning day: +20% and volume trend ≥ 1.5), 5-min and 15-min change positive, buys/sells 1.15–5, last 15 min volume ≥ 1× the hour's 15-min average, liquidity ≥ $25k and ≥ 50× the position, safety checks, round trip ≤ 4% at the real size.
- Exit: stop −4% net (up to −6% for volatile tokens: 1.5× the average 5-min range), lock +6% at +10% net then trail giving back ≤ 40% of the peak gain, time stop 6h without the target, max hold 24h.
- Paper fill 3 min after the decision; exits settled on 1-minute candles (stop checked before new highs within a minute).
- At most 2 entries a day (midnight America/New_York), one position at a time, no re-entry into a token traded that day.
- Near the target the position is sized to need about +10% (with a 3% buffer); the finish line exits at $5,000 + 1%.

Every token up ≥ 5% in an hour is logged in [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl).
`node src/compounder-replay.js` reruns the logged hours with other floors, stops, targets and trailing settings (results in COMPOUNDER-REPLAY.md).
