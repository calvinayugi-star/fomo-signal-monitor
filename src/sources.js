// Rebuilds FOMO-style "Trending" and "Graduated" lists from public data (Solana only).
//   Trending  = GeckoTerminal trending pools on Solana
//   Graduated = pump.fun tokens that completed their bonding curve (falls back to the most-traded PumpSwap pools)
// Since 2026-10-24 (user: "as many tokens to search through as possible") two more lists feed the Compounder:
//   Jupiter     = Jupiter's top trending / top traded / top organic-score tokens over 5m-24h (tokenized stocks and other non-meme assets included since 2026-10-24; config jupiterExcludeTags can drop tags)
//   DexScreener = DexScreener's latest and top boosted tokens and latest token profiles (Solana only)
import { getJson } from './http.js';

export const GT = 'https://api.geckoterminal.com/api/v2';
export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BASE_ASSETS = new Set([SOL, USDC, USDT]);

const idToMint = (id) => id?.replace(/^solana_/, '');

function add(map, mint, source) {
  if (!mint || BASE_ASSETS.has(mint)) return;
  const c = map.get(mint) ?? { mint, sources: new Set() };
  c.sources.add(source);
  map.set(mint, c);
}

// The meme token is usually the base token, but some pools list it as the quote.
function memeMintOfPool(pool) {
  const base = idToMint(pool.relationships?.base_token?.data?.id);
  const quote = idToMint(pool.relationships?.quote_token?.data?.id);
  return BASE_ASSETS.has(base) ? quote : base;
}

export async function collectCandidates(cfg, log) {
  const map = new Map();

  for (const duration of cfg.sources.trendingDurations) {
    try {
      const j = await getJson(`${GT}/networks/solana/trending_pools?duration=${duration}&page=1`);
      for (const pool of j.data ?? []) add(map, memeMintOfPool(pool), 'Trending');
    } catch (e) {
      log.errors.push(`trending ${duration}: ${e.message}`);
    }
  }

  let pumpFailed = false;
  for (const sort of cfg.sources.pumpfunSorts) {
    try {
      const coins = await getJson(
        `https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=${sort}&order=DESC&complete=true&includeNsfw=false`,
      );
      for (const c of coins ?? []) {
        if (c.complete && !c.is_banned) add(map, c.mint, 'Graduated');
      }
    } catch (e) {
      pumpFailed = true;
      log.errors.push(`pump.fun ${sort}: ${e.message}`);
    }
  }

  if (pumpFailed) {
    // Fallback (also when only one sort fails): the most-traded PumpSwap pools, which is where pump.fun tokens land when they graduate.
    // Only pump.fun mints (address ends in "pump"); PumpSwap's top pools are otherwise mostly bot clones.
    for (let page = 1; page <= cfg.sources.graduatedFallbackPages; page++) {
      try {
        const j = await getJson(`${GT}/networks/solana/dexes/pumpswap/pools?sort=h24_tx_count_desc&page=${page}`);
        for (const pool of j.data ?? []) {
          const mint = memeMintOfPool(pool);
          if (mint?.endsWith('pump')) add(map, mint, 'Graduated');
        }
      } catch (e) {
        log.errors.push(`graduated fallback p${page}: ${e.message}`);
      }
    }
  }

  const skipTags = new Set(cfg.sources.jupiterExcludeTags ?? []);
  for (const list of cfg.sources.jupiterLists ?? []) {
    for (const interval of cfg.sources.jupiterIntervals ?? []) {
      try {
        const tokens = await getJson(`https://lite-api.jup.ag/tokens/v2/${list}/${interval}?limit=${cfg.sources.jupiterLimit ?? 100}`);
        for (const t of Array.isArray(tokens) ? tokens : []) if (!(t.tags ?? []).some((x) => skipTags.has(x))) add(map, t.id, 'Jupiter');
      } catch (e) {
        log.errors.push(`jupiter ${list} ${interval}: ${e.message}`);
      }
    }
  }

  for (const list of cfg.sources.dexscreenerLists ?? []) {
    try {
      const rows = await getJson(`https://api.dexscreener.com/${list}`);
      for (const r of Array.isArray(rows) ? rows : []) if (r.chainId === 'solana') add(map, r.tokenAddress, 'DexScreener');
    } catch (e) {
      log.errors.push(`dexscreener ${list}: ${e.message}`);
    }
  }

  return [...map.values()];
}
