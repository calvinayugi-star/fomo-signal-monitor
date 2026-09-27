// Rebuilds FOMO-style "Trending" and "Graduated" lists from public data (Solana only).
//   Trending  = GeckoTerminal trending pools on Solana
//   Graduated = pump.fun tokens that completed their bonding curve (falls back to new PumpSwap pools)
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

  let pumpOk = false;
  for (const sort of cfg.sources.pumpfunSorts) {
    try {
      const coins = await getJson(
        `https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=${sort}&order=DESC&complete=true&includeNsfw=false`,
      );
      for (const c of coins ?? []) {
        if (c.complete && !c.is_banned) add(map, c.mint, 'Graduated');
      }
      pumpOk = true;
    } catch (e) {
      log.errors.push(`pump.fun ${sort}: ${e.message}`);
    }
  }

  if (!pumpOk) {
    // Fallback: newest PumpSwap pools, which is where pump.fun tokens land when they graduate.
    for (const page of [1, 2]) {
      try {
        const j = await getJson(`${GT}/networks/solana/new_pools?include=dex&page=${page}`);
        for (const pool of j.data ?? []) {
          if (pool.relationships?.dex?.data?.id === 'pumpswap') add(map, memeMintOfPool(pool), 'Graduated');
        }
      } catch (e) {
        log.errors.push(`graduated fallback p${page}: ${e.message}`);
      }
    }
  }

  return [...map.values()];
}
