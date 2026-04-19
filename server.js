import express from "express";
import { scrapeSeace } from "./src/scraper/seaceScraper.js";
import { scrapeDetalle, descargarDoc } from "./src/scraper/seaceDetalle.js";
import { cache, procesoRegistry, registerProcesos } from "./src/cache.js";
import { shutdownBrowser } from "./src/browserPool.js";

const app = express();
app.use(express.json());

// CORS abierto (prueba)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const listCache = cache("list", 60_000);          // 60s
const detalleCache = cache("detalle", 10 * 60_000); // 10min
const pdfCache = cache("pdf", 0);                 // permanente

// dedup de requests en vuelo (evita scrape paralelo del mismo recurso)
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// listado top 10
app.get("/api/v1/procesos", async (req, res) => {
  try {
    const cached = listCache.get("top");
    if (cached) return res.json({ data: cached, cached: true });

    const data = await once("list:top", () => scrapeSeace({ limit: 10 }));
    registerProcesos(data);
    listCache.set("top", data);
    res.json({ data, cached: false });
  } catch (e) {
    console.error("❌", req.path, e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// detalle por nidProceso
app.get("/api/v1/procesos/:nidProceso", async (req, res) => {
  const { nidProceso } = req.params;
  try {
    const cached = detalleCache.get(nidProceso);
    if (cached) return res.json({ data: cached, cached: true });

    const meta = procesoRegistry.get(nidProceso);
    const nomenclatura = req.query.nomenclatura || meta?.nomenclatura;
    if (!nomenclatura) {
      return res.status(400).json({
        error: "Falta nomenclatura. Llama primero a GET /api/v1/procesos o pásala como ?nomenclatura=",
      });
    }

    const data = await once(`det:${nidProceso}`, () =>
      scrapeDetalle({ nomenclatura, nidProceso })
    );
    detalleCache.set(nidProceso, data);
    res.json({ data, cached: false });
  } catch (e) {
    console.error("❌", req.path, e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// descarga documento
app.get("/api/v1/procesos/:nidProceso/documentos/:filename", async (req, res) => {
  const { nidProceso, filename } = req.params;
  const key = `${nidProceso}:${filename}`;
  try {
    const cached = pdfCache.get(key);
    if (cached) {
      res.setHeader("Content-Disposition", `attachment; filename="${cached.filename}"`);
      res.setHeader("Content-Type", "application/octet-stream");
      return res.send(cached.buffer);
    }

    const meta = procesoRegistry.get(nidProceso);
    const nomenclatura = req.query.nomenclatura || meta?.nomenclatura;
    if (!nomenclatura) {
      return res.status(400).json({ error: "Falta nomenclatura (?nomenclatura=...)" });
    }

    const out = await once(`pdf:${key}`, () =>
      descargarDoc({ nomenclatura, nidProceso, filename })
    );
    pdfCache.set(key, out);
    res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.send(out.buffer);
  } catch (e) {
    console.error("❌", req.path, e);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 SEACE API listening on 0.0.0.0:${port}`);
  console.log("  GET /health");
  console.log("  GET /api/v1/procesos");
  console.log("  GET /api/v1/procesos/:nidProceso");
  console.log("  GET /api/v1/procesos/:nidProceso/documentos/:filename");
});

async function shutdown() {
  console.log("\n👋 cerrando...");
  await shutdownBrowser();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
