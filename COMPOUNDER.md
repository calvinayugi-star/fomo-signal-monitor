# FOMO Daily Compounder: Results (PAPER MODE)

Updated Sun, Oct 4, 20:51 EDT. Paper trades only: nothing is bought or sold.

Each run starts with a $100 seed on the 1st of the month (first run: 2026-10-03), compounds 100% of the bankroll one
position at a time, and stops when withdrawable value after costs reaches $5,000, at month end, or below $25.

## Run 2026-10 (ACTIVE)

| | |
|---|---|
| Seed → bankroll → target | $100 → **$72.16** → $5,000 |
| Run return | -27.8% |
| Distance remaining | $4927.84 |
| Days elapsed / left | 1.8 / 27.1 |
| Even-pace bankroll today | $128.00 (behind) |
| Daily net return needed: from the seed / from here | +14.5% / +16.9% |
| Trades (wins / losses) | 4 (1 / 3) |
| Win rate | 25% |
| Average win / average loss (net) | +1.9% / -10.6% |
| Average net per trade | -7.5% |
| Total estimated costs | $9.11 |

**Open position:** none (cash).

### Win rate needed vs achieved

Assumes up to 2 trades a day for the rest of the run, compounding the whole bankroll.

| | Assumed win/loss (+10.0% / -10.0%) | Actual win/loss (+1.9% / -10.6%) |
|---|---|---|
| Whole run from the seed (57 trades) | 87% | impossible (>100%) |
| From the current bankroll (54 trades left) | 92% | impossible (>100%) |
| **Achieved** | 25% | 25% |

### Winner sizes and exits

Trades reaching the +10% target: 1. Net results of at least +10%: 0 · +15%: 0 · +20%: 0 · +30%: 0.
Exit reasons: stop loss (2), emergency stop (2).

### Trades (newest first)

| # | Entered | Token | Size | Entry $ | Exit $ | Gross | Costs | Net | Net $ | Bankroll after | Exit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | Oct 4, 02:03 | MISTAKE | $70.84 | 0.01843 | 0.01908 | +3.5% | $1.19 | +1.9% | $1.32 | $72.16 | emergency stop |
| 3 | Oct 4, 00:03 | CRAWL | $88.55 | 0.003672 | 0.003014 | -17.9% | $1.85 | -20.0% | -$17.71 | $70.84 | emergency stop |
| 2 | Oct 3, 07:04 | SOCKET | $94.20 | 0.0007626 | 0.0007390 | -3.1% | $2.74 | -6.0% | -$5.65 | $88.55 | stop loss |
| 1 | Oct 3, 03:03 | HI | $100.00 | 0.0005868 | 0.0005723 | -2.5% | $3.33 | -5.8% | -$5.80 | $94.20 | stop loss |

## Past runs

| Run | Seed | Final bankroll | Trades | Win rate | Result |
|---|---|---|---|---|---|
| – | – | – | – | – | – |

## Rules in effect

- Entry: 1h change +10% to +60% (after a winning day: +20% and volume trend ≥ 1.5), 5-min and 15-min change positive, buys/sells 1.15–5, last 15 min volume ≥ 1× the hour's 15-min average, liquidity ≥ $25k and ≥ 50× the position, safety checks, round trip ≤ 4% at the real size.
- Exit: stop −10% net (up to −15% for volatile tokens: 1.5× the average 5-min range), judged on 15-min closes so short wicks don't end a trade; emergency stop on any price at −20% net, rising with the stop. Lock +6% at +10% net then trail giving back ≤ 40% of the peak gain, time stop 6h without the target, max hold 24h.
- Paper fill 3 min after the decision; exits settled on 1-minute candles (the stop is checked before any new high can raise it).
- At most 2 entries a day (midnight America/New_York), one position at a time, no re-entry into a token traded that day.
- Near the target the position is sized to need about +10% (with a 3% buffer); the finish line exits at $5,000 + 1%.

Every token up ≥ 5% in an hour is logged in [data/compounder-hourly.jsonl](data/compounder-hourly.jsonl).
`node src/compounder-replay.js` reruns the logged hours with other floors, stops, targets and trailing settings (results in COMPOUNDER-REPLAY.md).
