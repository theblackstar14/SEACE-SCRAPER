// cache TTL en memoria + registry de procesos

const stores = new Map();

export function cache(namespace, ttlMs) {
  if (!stores.has(namespace)) stores.set(namespace, new Map());
  const store = stores.get(namespace);
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return null;
      if (ttlMs && Date.now() - e.t > ttlMs) {
        store.delete(key);
        return null;
      }
      return e.v;
    },
    set(key, v) {
      store.set(key, { v, t: Date.now() });
    },
    del(key) { store.delete(key); },
    clear() { store.clear(); },
  };
}

// registry: nidProceso → { nomenclatura, nidConvocatoria, ... }
export const procesoRegistry = new Map();

export function registerProcesos(items) {
  for (const it of items) {
    if (it.nidProceso) procesoRegistry.set(String(it.nidProceso), it);
  }
}
