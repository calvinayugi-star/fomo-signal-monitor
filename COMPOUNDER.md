# FOMO Daily Compounder: Results (PAPER MODE)

Updated Sat, Oct 3, 01:00 EDT. Paper trades only: nothing is bought or sold.

Each run starts with a $100 seed on the 1st of the month (first run: 2026-10-03), compounds 100% of the bankroll one
position at a time, and stops when withdrawable value after costs reaches $5,000, at month end, or below $25.

## Run 2026-10 (ACTIVE)

| | |
|---|---|
| Seed → bankroll → target | $100 → **$100.00** → $5,000 |
| Run return | +0.0% |
| Distance remaining | $4900.00 |
| Days elapsed / left | 0.0 / 29.0 |
| Even-pace bankroll today | $100.00 (on pace) |
| Daily net return needed: from the seed / from here | +14.5% / +14.5% |
| Trades (wins / losses) | 0 (0 / 0) |
| Win rate | n/a |
| Average win / average loss (net) | n/a / n/a |
| Average net per trade | n/a |
| Total estimated costs | $0.00 |

**Open position:** none (cash).

### Win rate needed vs achieved

Assumes up to 2 trades a day for the rest of the run, compounding the whole bankroll.

| | Assumed win/loss (+10.0% / -4.5%) | Actual win/loss (n/a / n/a) |
|---|---|---|
| Whole run from the seed (57 trades) | 81% | n/a |
| From the current bankroll (57 trades left) | 81% | n/a |
| **Achieved** | n/a | n/a |

### Winner sizes and exits

Trades reaching the +10% target: 0. Net results of at least +10%: 0 · +15%: 0 · +20%: 0 · +30%: 0.
Exit reasons: n/a.

### Trades (newest first)

| # | Entered | Token | Size | Entry $ | Exit $ | Gross | Costs | Net | Net $ | Bankroll after | Exit |
|---|---|---|---|---|---|---|---|---|---|---|---|
| – | – | – | – | – | – | – | – | – | – | – | – |

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
