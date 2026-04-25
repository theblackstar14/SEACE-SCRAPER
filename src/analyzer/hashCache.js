/**
 * Cache por hash SHA256 del buffer del PDF.
 *
 * Idea: muchísimos PDFs SEACE son IDÉNTICOS:
 *  - "Bases Estándar" template SIN rellenar → la entidad lo sube tal cual,
 *    aparece en 30-50% de procesos en etapa Convocatoria.
 *  - Algunos PDFs grandes son re-uploads exactos en convocatorias relacionadas.
 *
 * Hash → análisis ya hecho. 0 LLM calls en los procesos repetidos.
 *
 * Persistencia: archivo JSON en data/cache/hash-cache.json
 * (Cuando migremos a DB, esta interfaz será drop-in con tabla cache_hashes).
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_FILE = "./data/cache/hash-cache.json";
const TTL_DAYS = 30; // bases pueden cambiar; expirar tras 30 días

let memCache = null; // { hash: { result, ts, hits } }

async function load() {
  if (memCache) return memCache;
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    memCache = JSON.parse(raw);
  } catch {
    memCache = {};
  }
  // purgar entradas expiradas
  const cutoff = Date.now() - TTL_DAYS * 86_400_000;
  for (const [k, v] of Object.entries(memCache)) {
    if (v.ts < cutoff) delete memCache[k];
  }
  return memCache;
}

async function persist() {
  if (!memCache) return;
  try {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(memCache, null, 2), "utf8");
  } catch (e) {
    console.warn(`[hashCache] no pude persistir: ${e.message}`);
  }
}

export function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Si tenemos análisis cacheado para este hash, retornarlo.
 * Incrementa contador de hits.
 */
export async function getByHash(hash) {
  const cache = await load();
  const entry = cache[hash];
  if (!entry) return null;
  entry.hits = (entry.hits || 0) + 1;
  entry.lastHit = Date.now();
  return entry.result;
}

/**
 * Guardar resultado análisis para futuros hits.
 */
export async function setByHash(hash, result, meta = {}) {
  const cache = await load();
  cache[hash] = {
    result,
    ts: Date.now(),
    hits: 0,
    meta, // { filename, size, source — opcional, debug }
  };
  await persist();
}

/**
 * Stats del cache (para logging/debug).
 */
export async function stats() {
  const cache = await load();
  const entries = Object.values(cache);
  const totalHits = entries.reduce((a, b) => a + (b.hits || 0), 0);
  return {
    entries: entries.length,
    totalHits,
    sizeKB: Math.round(JSON.stringify(cache).length / 1024),
  };
}

export async function clear() {
  memCache = {};
  await persist();
}
