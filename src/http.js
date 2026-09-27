// Small JSON fetch helper with per-host pacing and retries, so free API limits are respected.
const MIN_GAP_MS = {
  'api.geckoterminal.com': 4000, // free tier is ~30 calls/min but throttles bursts sooner
  'lite-api.jup.ag': 1100,
  'api.gopluslabs.io': 1000,
  'api.dexscreener.com': 300,
  'frontend-api-v3.pump.fun': 500,
};
const lastCall = new Map();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { retries = 3, timeoutMs = 20000, init } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + (MIN_GAP_MS[host] ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
    try {
      const res = await fetch(url, {
        ...init,
        headers: { 'user-agent': 'Mozilla/5.0 (FOMO Signal Monitor)', accept: 'application/json', ...init?.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`HTTP ${res.status}`);
        err.rateLimited = res.status === 429;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.fatal = true;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.fatal || attempt >= retries) throw new Error(`${host}: ${err.message}`);
      await sleep((err.rateLimited ? 15000 : 3000) * (attempt + 1));
    }
  }
}
