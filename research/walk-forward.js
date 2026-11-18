// Walk-forward direction study (2026-11-17). The first study (research/direction-study.js) trained once and failed when the
// market changed phase. Here the model keeps updating: every week it is retrained on the most recent weeks and tested on the
// week after, across the whole history. It is judged against a simple benchmark, trading in the direction of BTC's 1-2 day
// trend, and it gets new inputs about positioning, not just price:
//   Hyperliquid funding rate and premium (the coin's own venue),
//   Gate.io hourly futures stats as a read on positioning: open interest change, long and short liquidations, retail and
//   top-trader long/short ratios, taker buy/sell ratio (Gate keeps 180 days, so the study covers about 6 months).
// Every input is taken from the hour before the decision, so nothing from the future leaks in.
// Label, per coin, hour and side: enter at the next hour's open (paying half the spread), walk forward up to 7 days:
//   win = the take-profit for the run's net target first; stop = the stop at 90% of the way to liquidation first (also when
//   both fall in the same hour); after 7 days the trade closes at market. The real hourly funding is charged on every trade.
//   node research/walk-forward.js [--targets=c,a] [--window=6] [--inputs=all|price]
//   --window: weeks of training data before each test week (0 = all history so far); --inputs=price leaves positioning out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markets, candles } from '../src/perps/hl.js';
import { getJson } from '../src/http.js';
import { openPerp, targetPx, netAt } from '../src/perps/sim.js';
import { fit } from './gbt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const k = cfg.perps;
const H = 3600e3, WEEK = 168 * H, HORIZON = 168;
const TARGETS = { c: k.variants.find((v) => v.id === 'conservative').targetNetPct, a: k.variants.find((v) => v.id === 'aggressive').targetNetPct };
const SEED = { c: 110, a: 25 };
const opt = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const KEYS = (opt.targets ?? 'c,a').split(',');
const WINDOW = Number(opt.window ?? 6);
const PRICE_ONLY = opt.inputs === 'price';
const etDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.displayTimezone }).format(new Date(t));
const CACHE = path.join(ROOT, '.cache', 'direction');
fs.mkdirSync(CACHE, { recursive: true });

// --- data (cached on disk, topped up incrementally) -------------------------------------------------
const now = Date.now();
async function cached(name, startMs, pageSize, fetchFrom) {
  const file = path.join(CACHE, `${name}.json`);
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* first run */
  }
  if (!rows.length || rows[0].t > startMs + 24 * H) rows = [];
  let from = rows.length ? rows.at(-1).t + 1 : startMs;
  for (;;) {
    const got = (await fetchFrom(from)).filter((r) => r.t >= from).sort((p, q) => p.t - q.t);
    if (!got.length) break;
    rows.push(...got);
    from = got.at(-1).t + 1;
    if (got.length < pageSize) break;
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}
const HL = 'https://api.hyperliquid.xyz/info';
const hlPost = (body) => getJson(HL, { init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });
const gateStart = now - 179.5 * 24 * H;
const loadCandles = (coin) => cached(`candles-${coin}`, gateStart - 200 * H, 4000, async (from) => (await candles(coin, '1h', from, now)).filter((c) => c.t + H <= now));
const loadFunding = (coin) =>
  cached(`funding-${coin}`, gateStart - 200 * H, 400, async (from) =>
    ((await hlPost({ type: 'fundingHistory', coin, startTime: Math.floor(from) })) ?? []).map((x) => ({ t: Math.floor(x.time / H) * H, f: +x.fundingRate, p: +x.premium })),
  );
const loadGate = (coin) =>
  cached(`gate-${coin}`, gateStart + H, 1000, async (from) => {
    const contract = `${coin.replace(/^k(?=[A-Z])/, '')}_USDT`;
    const list = await getJson(`https://api.gateio.ws/api/v4/futures/usdt/contract_stats?contract=${contract}&interval=1h&from=${Math.ceil(Math.max(from, gateStart) / 1000)}&limit=2000`);
    return (list ?? []).map((x) => ({ t: x.time * 1000, oi: +x.open_interest, oiUsd: +x.open_interest_usd, ll: +x.long_liq_usd || 0, sl: +x.short_liq_usd || 0, acc: +x.lsr_account, top: +x.top_lsr_size, tk: +x.lsr_taker }));
  });

const universe = (await markets()).filter((m) => !m.delisted && m.maxLeverage >= k.leverage && m.dayVolumeUsd >= 1e6);
const coins = new Map();
for (const m of universe) {
  try {
    const cs = await loadCandles(m.coin);
    if (cs.length < 400) continue;
    const [F, G] = [await loadFunding(m.coin), await loadGate(m.coin)];
    if (G.length < 400) continue;
    coins.set(m.coin, { m, cs, F: new Map(F.map((x) => [x.t, x])), G: new Map(G.map((x) => [x.t, x])) });
  } catch (err) {
    console.log(`   skipped ${m.coin}: ${err.message}`);
  }
}

// --- per-coin series, all aligned to the coin's hourly candles -------------------------------------------
const pre = (arr) => arr.reduce((s, v) => (s.push(s.at(-1) + v), s), [0]);
function prep({ cs, F, G }) {
  const n = cs.length, c = cs.map((x) => x.c);
  const ret = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
  const R1 = pre(ret), R2 = pre(ret.map((x) => x * x));
  const std = (i, w) => Math.sqrt(Math.max((R2[i + 1] - R2[i + 1 - w]) / w - ((R1[i + 1] - R1[i + 1 - w]) / w) ** 2, 0)) * 100;
  const ema = (w) => { const a = 2 / (w + 1); let e = c[0]; return c.map((x) => (e = a * x + (1 - a) * e)); };
  const roll = (w, f, pick) => cs.map((_, i) => { let v = pick(cs[i]); for (let j = Math.max(0, i - w + 1); j < i; j++) v = f(v, pick(cs[j])); return v; });
  const VS = pre(cs.map((x) => x.v * x.c));
  // Funding is paid at each candle's close; at decision hour i (made at the close of candle i) the safe "known" ones are those
  // paid up to candle i-1's close. fundPaid[n] is also what a position open over candle n pays.
  const fundPaid = cs.map((x) => F.get(x.t + H)?.f ?? 0), premPaid = cs.map((x) => F.get(x.t + H)?.p ?? 0);
  const FS = pre(fundPaid), PS = pre(premPaid);
  // Gate stats at each candle's open time, carried forward up to 3 hours when one is missing.
  const g = [];
  for (let i = 0, gap = 0; i < n; i++) {
    const x = G.get(cs[i].t);
    gap = x ? 0 : gap + 1;
    g.push(x ?? (gap <= 3 ? g[i - 1] ?? null : null));
  }
  const LL = pre(g.map((x) => x?.ll ?? 0)), SL = pre(g.map((x) => x?.sl ?? 0));
  const TK = pre(g.map((x) => Math.log(Math.min(Math.max(x?.tk || 1, 0.05), 20))));
  return {
    n, c, std, e24: ema(24), e168: ema(168), hi24: roll(24, Math.max, (x) => x.h), lo24: roll(24, Math.min, (x) => x.l), hi168: roll(168, Math.max, (x) => x.h), lo168: roll(168, Math.min, (x) => x.l),
    vol: (i, w) => VS[i + 1] - VS[i + 1 - w], FS,
    fund: (i, w) => ((FS[i] - FS[i - w]) / w) * 1e4, prem: (i, w) => ((PS[i] - PS[i - w]) / w) * 1e4, // basis points, from payments known at i
    g: (i) => g[i - 1], // Gate stats known at decision i: the hour before
    liq: (i, w, side) => ((side === 1 ? LL : SL)[i] - (side === 1 ? LL : SL)[i - w]) / (g[i - 1]?.oiUsd || NaN) * 100,
    taker: (i, w) => (TK[i] - TK[i - w]) / w,
  };
}
const ln = (x) => (x > 0 ? Math.log(x) : NaN);
const pct = (a, b) => (a > 0 && b > 0 ? (a / b - 1) * 100 : NaN);

const PRICE = ['long', 'r1', 'r4', 'r12', 'r24', 'r48', 'r72', 'r168', 'btc_r1', 'btc_r4', 'btc_r24', 'btc_r48', 'btc_r168', 'rel24', 'rel168', 'vol24', 'vol168', 'volToStop',
  'pos24', 'pos168', 'ema24', 'ema168', 'volume1', 'volume24', 'stopDist'];
const POSITIONING = ['fund1', 'fund24', 'fund72', 'prem24', 'btc_fund24', 'oi4', 'oi24', 'oi72', 'btc_oi24', 'liqMine4', 'liqOpp4', 'liqMine24', 'liqOpp24', 'btc_liqMine24', 'btc_liqOpp24',
  'acc', 'acc24', 'top', 'top24', 'taker4', 'taker24', 'btc_acc', 'btc_top'];
const NAMES = PRICE_ONLY ? PRICE : [...PRICE, ...POSITIONING];
const IX = Object.fromEntries(NAMES.map((nm, f) => [nm, f]));
function features(P, i, B, b, d, stopDistPct) {
  const r = (w) => (P.c[i] / P.c[i - w] - 1) * 100;
  const br = (w) => (b != null && b >= w ? (B.c[b] / B.c[b - w] - 1) * 100 : NaN);
  const pos = (hi, lo) => { const x = hi > lo ? (P.c[i] - lo) / (hi - lo) : 0.5; return d === 1 ? x : 1 - x; };
  const vol24 = P.std(i, 24);
  const x = [d === 1 ? 1 : 0, d * r(1), d * r(4), d * r(12), d * r(24), d * r(48), d * r(72), d * r(168), d * br(1), d * br(4), d * br(24), d * br(48), d * br(168), d * (r(24) - br(24)), d * (r(168) - br(168)),
    vol24, P.std(i, 168), vol24 / stopDistPct, pos(P.hi24[i], P.lo24[i]), pos(P.hi168[i], P.lo168[i]), d * (P.c[i] / P.e24[i] - 1) * 100, d * (P.c[i] / P.e168[i] - 1) * 100,
    P.vol(i, 1) / (P.vol(i, 24) / 24), P.vol(i, 24) / (P.vol(i, 168) / 7), stopDistPct];
  if (PRICE_ONLY) return Float64Array.from(x);
  const g = P.g(i), bg = b != null ? B.g(b) : null;
  x.push(d * P.fund(i, 1), d * P.fund(i, 24), d * P.fund(i, 72), d * P.prem(i, 24), b != null ? d * B.fund(b, 24) : NaN,
    pct(g?.oi, P.g(i - 4)?.oi), pct(g?.oi, P.g(i - 24)?.oi), pct(g?.oi, P.g(i - 72)?.oi), b != null ? pct(bg?.oi, B.g(b - 24)?.oi) : NaN,
    P.liq(i, 4, d), P.liq(i, 4, -d), P.liq(i, 24, d), P.liq(i, 24, -d), b != null ? B.liq(b, 24, d) : NaN, b != null ? B.liq(b, 24, -d) : NaN,
    d * ln(g?.acc), d * (ln(g?.acc) - ln(P.g(i - 24)?.acc)), d * ln(g?.top), d * (ln(g?.top) - ln(P.g(i - 24)?.top)), d * P.taker(i, 4), d * P.taker(i, 24),
    d * ln(bg?.acc), d * ln(bg?.top));
  return Float64Array.from(x);
}

// --- labels -----------------------------------------------------------------------------------------
function outcome(cs, P, i, d, m, target) {
  const e = cs[i + 1];
  if (!e) return null;
  const slip = m.spreadPct / 2;
  const p = openPerp({ marginUsd: 1, leverage: k.leverage, side: d === 1 ? 'long' : 'short', entryPx: e.o * (1 + (d * slip) / 100), takerPct: k.fees.takerPct, mmrPct: m.mmrPct, stopFraction: k.stopLoss.beforeLiquidationFraction });
  const tp = targetPx(p, target, k.fees.makerPct);
  const lossPct = netAt(p, p.stopPx * (1 - (d * (slip + k.stopLoss.extraSlipPct)) / 100), k.fees.takerPct).netPct;
  const funding = (j) => -d * (P.FS[j + 1] - P.FS[i + 1]) * k.leverage * 100; // % of margin paid (or received) over candles i+1..j
  for (let j = i + 1; j < cs.length && j <= i + HORIZON; j++) {
    const x = cs[j], hours = j - i;
    if (d === 1 ? x.l <= p.stopPx : x.h >= p.stopPx) return { win: 0, hours, ret: lossPct + funding(j) };
    if (d === 1 ? x.h >= tp : x.l <= tp) return { win: 1, hours, ret: target + funding(j) };
  }
  const j = i + HORIZON;
  if (j >= cs.length) return null; // not enough future data yet
  return { win: 0, timeout: 1, hours: HORIZON, ret: netAt(p, cs[j].c * (1 - (d * slip) / 100), k.fees.takerPct).netPct + funding(j) };
}

const btcCoin = coins.get('BTC');
const B = prep(btcCoin);
const btcAt = new Map(btcCoin.cs.map((c, i) => [c.t, i]));
const rows = { c: [], a: [] };
let lastT = 0;
for (const [coin, entry] of coins) {
  const { m, cs } = entry;
  const P = coin === 'BTC' ? B : prep(entry);
  const stopDistPct = Math.abs(openPerp({ marginUsd: 1, leverage: k.leverage, side: 'long', entryPx: 1, takerPct: 0, mmrPct: m.mmrPct, stopFraction: k.stopLoss.beforeLiquidationFraction }).stopPx - 1) * 100;
  lastT = Math.max(lastT, cs.at(-1).t);
  for (let i = 200; i < cs.length - 1; i++) {
    if (!P.g(i) || !P.g(i - 72)) continue; // same rows with or without positioning inputs: only hours Gate covers
    const b = btcAt.get(cs[i].t);
    for (const d of [1, -1]) {
      const x = features(P, i, B, b, d, stopDistPct);
      for (const key of KEYS) {
        const o = outcome(cs, P, i, d, m, TARGETS[key]);
        if (o) rows[key].push({ coin, t: cs[i].t, d, x, ...o });
      }
    }
  }
}
const firstT = Math.min(...KEYS.map((key) => rows[key][0]?.t ?? Infinity));
console.log(`${coins.size} coins · rows from ${new Date(firstT).toISOString().slice(0, 10)} · inputs: ${PRICE_ONLY ? 'price only' : 'price + positioning'} · training window: ${WINDOW ? `${WINDOW} weeks` : 'all history so far'}`);

// --- walk forward -------------------------------------------------------------------------------------
const hit = (a) => (a.length ? (100 * a.filter((r) => r.win).length) / a.length : NaN);
const avg = (a) => (a.length ? a.reduce((s, r) => s + r.ret, 0) / a.length : NaN);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '  -');
const btcPx = (t) => B.c[btcAt.get(t)];
function sim(byHour, key, choose) {
  let bank = SEED[key], busy = 0, wins = 0, stops = 0, outs = 0, doneDay = null, low = bank;
  for (const [t, group] of byHour) {
    if (t < busy || (key === 'c' && doneDay === etDay(t))) continue;
    const best = choose(group);
    if (!best) continue;
    bank *= 1 + best.ret / 100;
    low = Math.min(low, bank);
    best.win ? wins++ : best.timeout ? outs++ : stops++;
    busy = t + (best.hours + 1) * H;
    if (key === 'c' && best.win) doneDay = etDay(busy);
  }
  return { trades: wins + stops + outs, wins, stops, outs, bank, low };
}
const fmtSim = (s, key, days) => `${s.trades} trades (${(s.trades / days).toFixed(2)}/day), ${s.wins} wins, ${s.stops} stops, ${s.outs} closed at 7 days → $${SEED[key]} → $${s.bank.toFixed(2)} (lowest $${s.low.toFixed(2)})`;

const report = {};
for (const key of KEYS) {
  const R = rows[key].sort((p, q) => p.t - q.t);
  const testEnd = lastT - HORIZON * H; // every row up to here is fully resolved, so no test row is missing because it is still open
  const firstWeek = Math.ceil((firstT + Math.max(WINDOW || 6, 4) * WEEK - 4 * 24 * H) / WEEK) * WEEK + 4 * 24 * H; // Mondays 00:00 UTC
  const weeks = [], tested = [], imp = new Map();
  const t0 = Date.now();
  for (let ws = firstWeek; ws < testEnd; ws += WEEK) {
    const we = Math.min(ws + WEEK, testEnd + H);
    const train = R.filter((r) => r.t + (r.hours + 1) * H <= ws && (!WINDOW || r.t >= ws - WINDOW * WEEK) && (r.t / H) % 2 === 0);
    const test = R.filter((r) => r.t >= ws && r.t < we);
    if (!test.length) continue;
    const model = fit(train.map((r) => r.x), train.map((r) => r.win), NAMES);
    for (const r of test) r.p = model.predict(r.x);
    for (const [nm, v] of model.importance) imp.set(nm, (imp.get(nm) ?? 0) + v);
    const sorted = [...test].sort((p, q) => q.p - p.p), top2 = sorted.slice(0, Math.max(1, Math.floor(test.length * 0.02)));
    const sure = test.filter((r) => r.p >= 0.9), both = test.filter((r) => r.x[IX.btc_r24] > 0 && r.x[IX.btc_r48] > 0);
    weeks.push({ week: new Date(ws).toISOString().slice(0, 10), btc: pct(btcPx(test.at(-1).t), btcPx(test[0].t)), base: hit(test), bench: hit(both), top2: hit(top2), sureN: sure.length, sure: hit(sure), train: train.length });
    tested.push(...test);
  }
  const days = (tested.at(-1).t - tested[0].t) / (24 * H);
  const name = key === 'c' ? `Conservative (+${TARGETS.c}%)` : `Aggressive (+${TARGETS.a}%)`;
  console.log(`\n== ${name}: ${weeks.length} weekly retrains, tested ${new Date(tested[0].t).toISOString().slice(0, 10)} → ${new Date(tested.at(-1).t).toISOString().slice(0, 10)} (${days.toFixed(0)} days, ${tested.length} rows, fit ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  console.log('   week of      BTC   all  BTC 1-2d  model top 2%  model 90%+ (n)');
  for (const w of weeks) console.log(`   ${w.week} ${f1(w.btc).padStart(6)}% ${f1(w.base).padStart(5)}% ${f1(w.bench).padStart(7)}% ${f1(w.top2).padStart(9)}%   ${f1(w.sure).padStart(7)}% (${w.sureN})`);
  const lines = [['any coin, side, hour (baseline)', tested],
    ['BTC 1-day trend', tested.filter((r) => r.x[IX.btc_r24] > 0)],
    ['BTC 2-day trend', tested.filter((r) => r.x[IX.btc_r48] > 0)],
    ['BTC 1-day and 2-day agree', tested.filter((r) => r.x[IX.btc_r24] > 0 && r.x[IX.btc_r48] > 0)]];
  const sorted = [...tested].sort((p, q) => q.p - p.p);
  for (const frac of [0.2, 0.05, 0.02, 0.005]) lines.push([`model top ${frac * 100}% (ranked over the whole period)`, sorted.slice(0, Math.floor(sorted.length * frac))]);
  for (const th of [0.8, 0.85, 0.9, 0.93]) lines.push([`model ${th * 100}%+ confident`, tested.filter((r) => r.p >= th)]);
  lines.push(['model 85%+ and with BTC 1-2 day trend', tested.filter((r) => r.p >= 0.85 && r.x[IX.btc_r24] > 0 && r.x[IX.btc_r48] > 0)]);
  console.log('   hit rate over every row (each coin, hour and side):');
  for (const [label, a] of lines) console.log(`     ${label.padEnd(44)} hit ${f1(hit(a)).padStart(5)}%, avg ${avg(a).toFixed(2).padStart(6)}% per trade, ${a.length} rows`);
  console.log('   calibration (model says → happened):');
  for (const [lo, hi] of [[0.7, 0.8], [0.8, 0.85], [0.85, 0.9], [0.9, 0.95], [0.95, 1.01]]) {
    const a = tested.filter((r) => r.p >= lo && r.p < hi);
    if (a.length) console.log(`     ${(lo * 100).toFixed(0)}–${Math.min(hi * 100, 100).toFixed(0)}%: ${f1(hit(a))}% (${a.length} rows)`);
  }
  const byHour = new Map();
  for (const r of tested) (byHour.get(r.t) ?? byHour.set(r.t, []).get(r.t)).push(r);
  const hours = [...byHour].sort((p, q) => p[0] - q[0]);
  const best = (f, score) => (g) => g.filter(f).sort((p, q) => score(q) - score(p))[0];
  const agree = (r) => r.x[IX.btc_r24] > 0 && r.x[IX.btc_r48] > 0;
  const sims = {
    'benchmark: BTC itself, 1-day trend': sim(hours, key, best((r) => r.coin === 'BTC' && r.x[IX.btc_r24] > 0, () => 0)),
    'benchmark: BTC itself, 1+2-day trend': sim(hours, key, best((r) => r.coin === 'BTC' && agree(r), () => 0)),
    'benchmark: strongest coin, 1+2-day trend': sim(hours, key, best(agree, (r) => r.x[IX.r24])),
  };
  for (const th of [0.8, 0.85, 0.9, 0.93]) sims[`model ${th * 100}%+`] = sim(hours, key, best((r) => r.p >= th, (r) => r.p));
  sims['model 85%+ with BTC 1-2 day trend'] = sim(hours, key, best((r) => r.p >= 0.85 && agree(r), (r) => r.p));
  console.log('   one trade at a time, whole bank each trade:');
  for (const [label, s] of Object.entries(sims)) console.log(`     ${label.padEnd(42)} ${fmtSim(s, key, days)}`);
  const importance = [...imp].map(([nm, v]) => [nm, v / weeks.length]).sort((p, q) => q[1] - p[1]);
  const posShare = importance.filter(([nm]) => POSITIONING.includes(nm)).reduce((s, [, v]) => s + v, 0);
  console.log(`   leans on: ${importance.slice(0, 12).map(([nm, v]) => `${nm} ${(v * 100).toFixed(0)}%`).join(', ')}${PRICE_ONLY ? '' : ` · positioning inputs ${(posShare * 100).toFixed(0)}% in all`}`);
  report[key] = { weeks, days, rows: tested.length, hits: Object.fromEntries(lines.map(([label, a]) => [label, { hit: hit(a), avg: avg(a), n: a.length }])), sims, importance: importance.slice(0, 15) };
}
const out = path.join(ROOT, 'research', 'walk-forward-results.json');
let prev = {};
try {
  prev = JSON.parse(fs.readFileSync(out, 'utf8'));
} catch {
  /* first run */
}
const tag = `${PRICE_ONLY ? 'price' : 'all'}-window${WINDOW}`;
fs.writeFileSync(out, JSON.stringify({ ...prev, at: new Date().toISOString(), coins: [...coins.keys()], [tag]: { ...(prev[tag] ?? {}), ...report } }, null, 1) + '\n');
