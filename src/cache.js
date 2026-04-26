import { LRUCache } from "lru-cache";

// cache TTL con LRU + stale-while-revalidate.
// Distintos namespaces para distintos perfiles (list, detalle, pdf).

const stores = new Map();

/**
 * @param {string} namespace
 * @param {object} opts
 *   - ttl: ms antes de considerar fresh expirado
 *   - staleMs: ms adicionales durante los que sirve stale mientras refresca
 *   - max: máximo de entries (LRU)
 *   - maxSize + sizeCalc: para limitar bytes (PDFs)
 */
export function cache(namespace, opts = {}) {
  if (stores.has(namespace)) return stores.get(namespace);

  const { ttl = 60_000, staleMs = 0, max = 500, maxSize, sizeCalc } = opts;

  const lruOpts = { max, ttl: ttl + staleMs, allowStale: true };
  if (maxSize && sizeCalc) {
    lruOpts.maxSize = maxSize;
    lruOpts.sizeCalculation = sizeCalc;
  }

  const lru = new LRUCache(lruOpts);

  const api = {
    /**
     * Devuelve { value, state } donde state ∈ 'fresh' | 'stale' | 'miss'.
     */
    getWithState(key) {
      const entry = lru.get(key, { allowStale: true });
      if (entry === undefined) return { value: null, state: "miss" };
      const age = Date.now() - entry.t;
      if (age <= ttl) return { value: entry.v, state: "fresh" };
      if (age <= ttl + staleMs) return { value: entry.v, state: "stale" };
      return { value: null, state: "miss" };
    },
    get(key) {
      return api.getWithState(key).value;
    },
    set(key, v) {
      lru.set(key, { v, t: Date.now() });
    },
    del(key) {
      lru.delete(key);
    },
    clear() {
      lru.clear();
    },
    size() {
      return lru.size;
    },
    keys() {
      return [...lru.keys()];
    },
  };

  stores.set(namespace, api);
  return api;
}

/**
 * Helper stale-while-revalidate.
 * - fresh: devuelve directo.
 * - stale: devuelve stale + dispara refresh background (dedup por key).
 * - miss: espera fetch.
 */
const refreshing = new Map();

export async function swr(cacheApi, key, fetcher) {
  const { value, state } = cacheApi.getWithState(key);

  if (state === "fresh") return { data: value, source: "cache" };

  if (state === "stale") {
    if (!refreshing.has(key)) {
      const p = Promise.resolve()
        .then(fetcher)
        .then((fresh) => {
          cacheApi.set(key, fresh);
          return fresh;
        })
        .catch((e) => {
          console.warn(`[swr refresh fail] ${key}: ${e.message}`);
        })
        .finally(() => refreshing.delete(key));
      refreshing.set(key, p);
    }
    return { data: value, source: "stale" };
  }

  // miss: fetch sync con dedup
  if (refreshing.has(key)) {
    const data = await refreshing.get(key);
    return { data, source: "dedup" };
  }
  const p = Promise.resolve()
    .then(fetcher)
    .then((fresh) => {
      cacheApi.set(key, fresh);
      return fresh;
    })
    .finally(() => refreshing.delete(key));
  refreshing.set(key, p);
  const data = await p;
  return { data, source: "fresh" };
}

// registry: nidProceso → { nomenclatura, ... }
// LRU para que no crezca infinito
export const procesoRegistry = new LRUCache({ max: 5000, ttl: 24 * 60 * 60 * 1000 });

export function registerProcesos(items) {
  for (const it of items) {
    if (it.nidProceso) procesoRegistry.set(String(it.nidProceso), it);
  }
}
