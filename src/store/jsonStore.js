import fs from "node:fs/promises";
import path from "node:path";

/**
 * Store JSON simple. Interfaz pensada para migrar a Postgres luego sin cambiar callers.
 *
 *   const store = createJsonStore("./data/output");
 *   await store.saveRun(runId, payload);
 *   const last = await store.getLastRun();
 */

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function todayTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createJsonStore(outDir = "./data/output") {
  return {
    outDir,

    async saveRun(runId, payload) {
      await ensureDir(outDir);
      const file = path.join(outDir, `procesos-${runId}.json`);
      await fs.writeFile(file, JSON.stringify(payload, null, 2), "utf8");

      // update index
      const indexFile = path.join(outDir, "runs.log.json");
      let idx = [];
      try {
        idx = JSON.parse(await fs.readFile(indexFile, "utf8"));
      } catch {}
      idx.push({
        runId,
        file: path.basename(file),
        ts: new Date().toISOString(),
        totales: {
          procesos: payload.procesos?.length ?? 0,
          activos: (payload.procesos || []).filter((p) => p.estado === "activo").length,
          califican: (payload.procesos || []).filter((p) => p.evaluacion?.resultado === "califica").length,
          consorcio: (payload.procesos || []).filter((p) => p.evaluacion?.resultado === "consorcio").length,
        },
      });
      await fs.writeFile(indexFile, JSON.stringify(idx, null, 2), "utf8");
      return file;
    },

    async getLastRun() {
      const indexFile = path.join(outDir, "runs.log.json");
      try {
        const idx = JSON.parse(await fs.readFile(indexFile, "utf8"));
      const last = idx[idx.length - 1];
        if (!last) return null;
        const file = path.join(outDir, last.file);
        return JSON.parse(await fs.readFile(file, "utf8"));
      } catch {
        return null;
      }
    },

    async listRuns() {
      const indexFile = path.join(outDir, "runs.log.json");
      try {
        return JSON.parse(await fs.readFile(indexFile, "utf8"));
      } catch {
        return [];
      }
    },

    newRunId() {
      const tag = todayTag();
      const ts = Date.now().toString().slice(-6);
      return `${tag}-${ts}`;
    },
  };
}
