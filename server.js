import express from "express";
import rateLimit from "express-rate-limit";
import { scrapeSeace } from "./src/scraper/seaceScraper.js";
import { scrapeDetalle, descargarDoc } from "./src/scraper/seaceDetalle.js";
import { cache, swr, procesoRegistry, registerProcesos } from "./src/cache.js";
import { shutdownBrowser, poolStats } from "./src/browserPool.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// ---------- CORS ----------
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------- request id + timing log ----------
app.use((req, res, next) => {
  const id = Math.random().toString(36).slice(2, 8);
  req.id = id;
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`[${id}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ---------- auth ----------
const API_KEY = process.env.API_KEY;
const PUBLIC_PATHS = new Set(["/health", "/"]);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (!API_KEY) return next(); // sin API_KEY en env = modo dev abierto
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---------- rate limit ----------
const limiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.RATE_LIMIT_PER_MIN) || 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate_limit" },
});
app.use("/api/", limiter);

// ---------- caches ----------
const LIST_TTL = 60_000;
const LIST_STALE = 5 * 60_000;
const DETALLE_TTL = 10 * 60_000;
const DETALLE_STALE = 30 * 60_000;

const listCache = cache("list", { ttl: LIST_TTL, staleMs: LIST_STALE, max: 50 });
const detalleCache = cache("detalle", { ttl: DETALLE_TTL, staleMs: DETALLE_STALE, max: 1000 });
const pdfCache = cache("pdf", {
  ttl: 24 * 60 * 60 * 1000,
  max: 500,
  maxSize: 200 * 1024 * 1024, // 200 MB
  sizeCalc: (entry) => entry?.v?.buffer?.length || 1,
});

// ---------- util ----------
const IS_PROD = process.env.NODE_ENV === "production";

function sanitizeFilename(name) {
  return String(name || "download")
    .replace(/[\r\n"\\]/g, "") // nada de CRLF injection
    .replace(/[^\w.\-() ]/g, "_")
    .slice(0, 200);
}

function sendError(res, req, e, status = 500) {
  console.error(`[${req.id}] ❌ ${req.path}`, e);
  const body = { error: e.message || "internal_error" };
  if (!IS_PROD) body.stack = e.stack;
  res.status(status).json(body);
}

// ---------- routes ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, ts: Date.now(), pool: poolStats(), caches: {
    list: listCache.size(), detalle: detalleCache.size(), pdf: pdfCache.size(),
  }})
);

// debug (abierto si sin API_KEY, protegido si con ella)
app.get("/debug", async (req, res) => {
  if (IS_PROD) return res.status(404).end();
  try {
    const { withPage } = await import("./src/browserPool.js");
    const { config } = await import("./src/config/config.js");
    const out = await withPage(async (page) => {
      const resp = await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("domcontentloaded");
      return {
        status: resp?.status(),
        url: page.url(),
        title: await page.title(),
        bodySnippet: (await page.content()).slice(0, 3000),
      };
    });
    res.json(out);
  } catch (e) {
    sendError(res, req, e);
  }
});

// listado con filtros — usa SWR
app.get("/api/v1/procesos", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 15, 200);
  const objeto = req.query.objeto; // Bien|Servicio|Consultoría|Obra
  const fechaDesde = req.query.fechaDesde; // DD/MM/YYYY
  const fechaHasta = req.query.fechaHasta;
  const allPages = req.query.allPages === "true";

  const key = `list:${objeto || "any"}:${fechaDesde || ""}:${fechaHasta || ""}:${allPages ? "all" : limit}`;
  try {
    const { data, source } = await swr(listCache, key, () =>
      scrapeSeace({
        limit,
        allPages,
        objetoContratacion: objeto,
        fechaDesde,
        fechaHasta,
      })
    );
    registerProcesos(data);
    res.json({ data, source, count: data.length, filters: { objeto, fechaDesde, fechaHasta, allPages } });
  } catch (e) {
    sendError(res, req, e);
  }
});

// detalle
app.get("/api/v1/procesos/:nidProceso", async (req, res) => {
  const { nidProceso } = req.params;
  try {
    const meta = procesoRegistry.get(nidProceso);
    const nomenclatura = req.query.nomenclatura || meta?.nomenclatura;
    if (!nomenclatura) {
      return res.status(400).json({
        error: "Falta nomenclatura. Llama primero a GET /api/v1/procesos o pasa ?nomenclatura=",
      });
    }
    const { data, source } = await swr(detalleCache, nidProceso, () =>
      scrapeDetalle({ nomenclatura, nidProceso })
    );
    res.json({ data, source });
  } catch (e) {
    sendError(res, req, e);
  }
});

// descarga documento
app.get("/api/v1/procesos/:nidProceso/documentos/:filename", async (req, res) => {
  const { nidProceso, filename } = req.params;
  const key = `${nidProceso}:${filename}`;
  try {
    const meta = procesoRegistry.get(nidProceso);
    const nomenclatura = req.query.nomenclatura || meta?.nomenclatura;
    if (!nomenclatura) {
      return res.status(400).json({ error: "Falta nomenclatura (?nomenclatura=...)" });
    }

    const { data: out } = await swr(pdfCache, key, () =>
      descargarDoc({ nomenclatura, nidProceso, filename })
    );

    const safeName = sanitizeFilename(out.filename);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(out.buffer);
  } catch (e) {
    sendError(res, req, e);
  }
});

// warmup: pre-cachea listado + primeros N detalles. Para demo o cron.
app.post("/api/v1/warmup", async (req, res) => {
  const n = Math.min(Number(req.body?.detalles) || 3, 10);
  const t0 = Date.now();
  try {
    const procesos = await scrapeSeace({ limit: 10 });
    registerProcesos(procesos);
    listCache.set("top:10", procesos);

    const targets = procesos.slice(0, n);
    const results = await Promise.allSettled(
      targets.map((p) =>
        scrapeDetalle({ nomenclatura: p.nomenclatura, nidProceso: p.nidProceso }).then((d) => {
          detalleCache.set(p.nidProceso, d);
          return p.nidProceso;
        })
      )
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    res.json({
      ok: true,
      listado: procesos.length,
      detallesOk: ok,
      detallesFail: results.length - ok,
      ms: Date.now() - t0,
    });
  } catch (e) {
    sendError(res, req, e);
  }
});

// invalidar cache manualmente
app.post("/api/v1/cache/purge", (req, res) => {
  const ns = req.body?.namespace;
  if (ns === "list") listCache.clear();
  else if (ns === "detalle") detalleCache.clear();
  else if (ns === "pdf") pdfCache.clear();
  else {
    listCache.clear(); detalleCache.clear(); pdfCache.clear();
  }
  res.json({ ok: true });
});

// ---------- server ----------
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 SEACE API :${port} (concurrency=${process.env.SCRAPE_CONCURRENCY || 2}, auth=${API_KEY ? "on" : "off"})`);
});

async function shutdown() {
  console.log("\n👋 cerrando...");
  await shutdownBrowser();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
