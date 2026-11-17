// AI route, step 1 (2026-11-11): label tracker records with what a paper trade would really have earned under the current exits.
// For every record in the current trading pool (pairs 1-72h old, liquidity >= $10k): fill 3 min after the sighting (as the live runs do),
// then on GeckoTerminal 1-minute candles: if the price reaches the target net within 1h of the fill, the trade earns the target;
// otherwise it is sold at the last price before the 1h mark. Both targets are labelled: c = +13.93% on $110, a = +20% on $25.
// One GeckoTerminal call covers ~16h of a pair, so records of the same token share calls. Resumable: appends to research/labels.jsonl.
//   node research/label.js [maxCalls]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson } from '../src/http.js';
import { GT } from '../src/sources.js';
import { openPosition, findFill, priceForNet, netAt } from '../src/compounder-sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const OUT = path.join(ROOT, 'research', 'labels.jsonl');
const MIN = 60e3;
const HOLD = cfg.compounder.maxHoldHours * 60 * MIN;
const FILL = cfg.compounder.fillDelayMinutes * MIN;
const DEX_ROUND_TRIP_PCT = 2; // the tracker doesn't quote every token; 2% is the typical PumpSwap round trip seen in live buys
const TARGETS = { c: { size: 110, net: 13.93 }, a: { size: 25, net: 20 } };

const key = (r) => `${r.mint}|${r.t}`;
const lines = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const records = fs
  .readdirSync(path.join(ROOT, 'data'))
  .filter((f) => /^candidate-outcomes-\d{4}-\d{2}\.jsonl$/.test(f))
  .flatMap((f) => lines(path.join(ROOT, 'data', f)))
  .filter((r) => r.ageH >= 1 && r.ageH <= 72 && r.liqUsd >= 10000 && r.pairAddress && Date.now() - Date.parse(r.t) > FILL + HOLD + 10 * MIN);
const done = new Set(fs.existsSync(OUT) ? lines(OUT).map(key) : []);
const todo = records.filter((r) => !done.has(key(r)));

const byPair = new Map();
for (const r of todo) (byPair.get(r.pairAddress) ?? byPair.set(r.pairAddress, []).get(r.pairAddress)).push(r);
console.log(`${records.length} records in the pool, ${done.size} labelled, ${todo.length} to go on ${byPair.size} pairs`);

function label(r, candles) {
  const fillAt = Date.parse(r.t) + FILL;
  const fill = findFill(candles, fillAt);
  if (!fill) return { err: 'no fill' };
  const hour = candles.filter((c) => c[0] > fill.fillCandleT && c[0] * 1000 < fillAt + HOLD);
  const out = { candles: hour.length };
  for (const [k, { size, net }] of Object.entries(TARGETS)) {
    const p = openPosition({ sizeUsd: size, rawEntry: fill.rawPrice, dexRoundTripPct: DEX_ROUND_TRIP_PCT, costs: cfg.costs });
    const px = priceForNet(p, net, cfg.costs);
    let worst = 0;
    let hitMin = null;
    for (const c of hour) {
      if (c[2] >= px) {
        hitMin = Math.round((c[0] * 1000 - fillAt) / MIN);
        break;
      }
      worst = Math.min(worst, netAt(p, c[3], cfg.costs).netPct);
    }
    const exit = hour.at(-1)?.[4] ?? fill.rawPrice;
    out[k] = { hit: hitMin != null, hitMin, ret: hitMin != null ? net : +netAt(p, exit, cfg.costs).netPct.toFixed(2), worstBefore: +worst.toFixed(1) };
  }
  out.highPct = hour.length ? +((Math.max(...hour.map((c) => c[2])) / fill.rawPrice - 1) * 100).toFixed(1) : 0;
  out.lowPct = hour.length ? +((Math.min(...hour.map((c) => c[3])) / fill.rawPrice - 1) * 100).toFixed(1) : 0;
  return out;
}

const maxCalls = Number(process.argv[2] ?? Infinity);
let calls = 0;
let labelled = 0;
for (const [pair, rs] of byPair) {
  rs.sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
  while (rs.length && calls < maxCalls) {
    const t0 = Date.parse(rs[0].t);
    const before = Math.floor((t0 + 990 * MIN) / 1000); // 1000 one-minute candles: 10 min before the first record to ~16h after
    const covered = rs.filter((r) => Date.parse(r.t) + FILL + HOLD <= before * 1000);
    rs.splice(0, covered.length);
    let candles = [];
    let err = null;
    try {
      const j = await getJson(`${GT}/networks/solana/pools/${pair}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${covered[0].mint}&before_timestamp=${before}`);
      candles = (j.data?.attributes?.ohlcv_list ?? []).sort((a, b) => a[0] - b[0]);
    } catch (e) {
      err = e.message;
    }
    calls++;
    const out = covered.map((r) => JSON.stringify({ mint: r.mint, t: r.t, variant: r.variant, ...(err ? { err } : label(r, candles)) }));
    fs.appendFileSync(OUT, out.join('\n') + '\n');
    labelled += covered.length;
    if (calls % 50 === 0) console.log(`${calls} calls, ${labelled}/${todo.length} labelled`);
  }
}
console.log(`done: ${calls} calls, ${labelled} labelled`);
