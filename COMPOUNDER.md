# FOMO Daily Compounder: Results (PAPER MODE)

Updated Sat, Oct 10, 08:00 EDT. Paper trades only: nothing is bought or sold.

Each run starts with a $100 seed on the 1st of the month (first run: 2026-10-03), compounds 100% of the bankroll one
position at a time, and stops when withdrawable value after costs reaches $5,000, at month end, or below $25.

## Run 2026-10 (ACTIVE)

| | |
|---|---|
| Seed → bankroll → target | $100 → **$44.19** → $5,000 |
| Run return | -55.8% |
| Distance remaining | $4955.81 |
| Days elapsed / left | 7.3 / 21.7 |
| Even-pace bankroll today | $267.80 (behind) |
| Daily net return needed: from the seed / from here | +14.5% / +24.4% |
| Trades (wins / losses) | 14 (5 / 9) |
| Win rate | 36% |
| Average win / average loss (net) | +10.4% / -13.3% |
| Average net per trade | -4.9% |
| Total estimated costs | $29.48 |

**Open position:** none (cash).

### Win rate needed vs achieved

Assumes up to 2 trades a day for the rest of the run, compounding the whole bankroll.

| | Assumed win/loss (+10.0% / -10.0%) | Actual win/loss (+10.4% / -13.3%) |
|---|---|---|
| Whole run from the seed (57 trades) | 87% | 88% |
| From the current bankroll (43 trades left) | impossible (>100%) | impossible (>100%) |
| **Achieved** | 36% | 36% |

### Winner sizes and exits

Trades reaching the +10% target: 5. Net results of at least +10%: 3 · +15%: 1 · +20%: 1 · +30%: 0.
Exit reasons: stop loss (6), emergency stop (6), trailing stop (2).

### Trades (newest first)

| # | Entered | Token | Size | Entry $ | Exit $ | Gross | Costs | Net | Net $ | Bankroll after | Exit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 14 | Oct 9, 10:03 | HeeHaw | $49.25 | 0.002664 | 0.002471 | -7.2% | $1.50 | -10.3% | -$5.07 | $44.19 | stop loss |
| 13 | Oct 9, 01:03 | OWLNIGHT | $61.57 | 0.001126 | 0.0009288 | -17.5% | $1.53 | -20.0% | -$12.31 | $49.25 | emergency stop |
| 12 | Oct 8, 05:03 | ZKDARK | $70.70 | 0.0008248 | 0.0007431 | -9.9% | $2.14 | -12.9% | -$9.14 | $61.57 | stop loss |
| 11 | Oct 8, 04:03 | swordinu | $81.11 | 0.006838 | 0.006093 | -10.9% | $1.57 | -12.8% | -$10.40 | $70.70 | stop loss |
| 10 | Oct 7, 08:03 | CATCRAFT | $73.45 | 0.002237 | 0.002543 | +13.7% | $2.38 | +10.4% | $7.66 | $81.11 | emergency stop |
| 9 | Oct 7, 00:03 | XRPN | $65.60 | 0.004746 | 0.005448 | +14.8% | $1.85 | +12.0% | $7.85 | $73.45 | emergency stop |
| 8 | Oct 6, 07:03 | MEMEAGENCY | $81.99 | 0.005995 | 0.004891 | -18.4% | $1.30 | -20.0% | -$16.40 | $65.60 | emergency stop |
| 7 | Oct 6, 00:03 | Attention+ | $93.07 | 0.0002087 | 0.0001913 | -8.3% | $3.33 | -11.9% | -$11.08 | $81.99 | stop loss |
| 6 | Oct 5, 10:04 | SWAP | $77.21 | 0.0003601 | 0.0004503 | +25.1% | $3.48 | +20.5% | $15.86 | $93.07 | trailing stop |
| 5 | Oct 5, 02:03 | AGENTCAT | $72.16 | 0.03131 | 0.03406 | +8.8% | $1.29 | +7.0% | $5.06 | $77.21 | trailing stop |
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
