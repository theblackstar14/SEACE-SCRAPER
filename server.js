import express from "express";
import rateLimit from "express-rate-limit";
import { scrapeSeace } from "./src/scraper/seaceScraper.js";
import { scrapeDetalle, descargarDoc } from "./src/scraper/seaceDetalle.js";
import { cache, swr, procesoRegistry, registerProcesos } from "./src/cache.js";
import { shutdownBrowser, poolStats } from "./src/browserPool.js";
import { createPgStore, isPgAvailable } from "./src/store/pgStore.js";
import { readDoc } from "./src/store/docStore.js";
import { descargarDocHttp } from "./src/scraper/descargaHttp.js";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
  console.error(`[${req.id}] [ERROR] ${req.path}`, e);
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
    const nidConvocatoria = req.query.nidConvocatoria || meta?.nidConvocatoria;
    const { data, source } = await swr(detalleCache, nidProceso, () =>
      scrapeDetalle({ nomenclatura, nidProceso, nidConvocatoria })
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

    const nidConvocatoria = req.query.nidConvocatoria || meta?.nidConvocatoria;
    const { data: out } = await swr(pdfCache, key, () =>
      descargarDoc({ nomenclatura, nidProceso, nidConvocatoria, filename })
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

// ============================================================================
// API v2: lee de Postgres (la DB del ERP). Para consumo del ERP.
// ============================================================================

// Un solo chequeo de configuración en vez de uno por endpoint.
const db = (req, res, next) => {
  if (!isPgAvailable()) return res.status(503).json({ error: "DATABASE_URL no configurada" });
  req.db = createPgStore();
  next();
};
app.use("/api/v2", db);

// GET /api/v2/procesos?resultado=califica&minDias=15&minScore=50&limit=20
// Lista procesos analizados (último análisis por nid_proceso).
app.get("/api/v2/procesos", async (req, res) => {
  try {
    const {
      resultado, estado, minScore, minDias,
      minMonto, maxMonto,
      region, provincia, distrito,
      cumplePlantel, search,
      revisar, pinned, integrada,
      orderBy, direction, limit, offset,
    } = req.query;
    const bool = (v) => (v === undefined ? undefined : v === "true" || v === "1");
    const result = await req.db.queryProcesos({
      resultado,
      estado,
      revisar: bool(revisar),
      pinned: bool(pinned),
      integrada: bool(integrada),
      minScore: minScore ? Number(minScore) : undefined,
      minDias: minDias ? Number(minDias) : undefined,
      minMonto: minMonto ? Number(minMonto) : undefined,
      maxMonto: maxMonto ? Number(maxMonto) : undefined,
      region,
      provincia,
      distrito,
      cumplePlantel,
      search,
      orderBy: orderBy || "score",
      direction: direction || "desc",
      limit: Math.min(Number(limit) || 50, 500),
      offset: Number(offset) || 0,
    });
    res.json(result);
  } catch (e) {
    sendError(res, req, e);
  }
});

// GET /api/v2/alertas — lo que cambió desde el run anterior.
// Es la pantalla de inicio del ERP: lo único que alguien mira a las 8am.
app.get("/api/v2/alertas", async (req, res) => {
  try {
    res.json({ data: await req.db.getAlertas({ limit: Math.min(Number(req.query.limit) || 100, 500) }) });
  } catch (e) {
    sendError(res, req, e);
  }
});

// GET /api/v2/ubicaciones — regiones/provincias/distritos distintas para filtros
app.get("/api/v2/ubicaciones", async (req, res) => {
  try {
    res.json(await req.db.getUbicacionesDistintas());
  } catch (e) {
    sendError(res, req, e);
  }
});

// GET /api/v2/empresa — perfil de la empresa activa (incluye personal)
app.get("/api/v2/empresa", async (req, res) => {
  try {
    const empresa = await req.db.getEmpresaActiva();
    if (!empresa) return res.status(404).json({ error: "empresa no encontrada" });
    res.json(empresa);
  } catch (e) {
    sendError(res, req, e);
  }
});

// PUT /api/v2/empresa — actualiza empresa activa (CRUD básico)
app.put("/api/v2/empresa", async (req, res) => {
  try {
    res.json(await req.db.updateEmpresaActiva(req.body));
  } catch (e) {
    sendError(res, req, e);
  }
});

// GET /api/v2/procesos/:nidProceso
// Detalle completo del último análisis de un proceso, con documentos.
app.get("/api/v2/procesos/:nidProceso", async (req, res) => {
  try {
    const proceso = await req.db.getProceso(req.params.nidProceso);
    if (!proceso) return res.status(404).json({ error: "proceso no encontrado" });
    const documentos = await req.db.getDocumentos(req.params.nidProceso);
    res.json({ proceso, documentos });
  } catch (e) {
    sendError(res, req, e);
  }
});

// PUT/DELETE /api/v2/procesos/:nidProceso/pin — el ERP protege un proceso de
// la purga nocturna. Sin pin, sus documentos se borran 7 días después del
// cierre de presentación.
app.put("/api/v2/procesos/:nidProceso/pin", async (req, res) => {
  try {
    res.json(await req.db.pin(req.params.nidProceso, req.body || {}));
  } catch (e) {
    sendError(res, req, e);
  }
});

app.delete("/api/v2/procesos/:nidProceso/pin", async (req, res) => {
  try {
    res.json(await req.db.unpin(req.params.nidProceso));
  } catch (e) {
    sendError(res, req, e);
  }
});

/**
 * Busca una descarga en la tabla de documentos de la ficha (jsonb en procesos).
 *
 * Sirve de whitelist: solo se bajan en vivo uuids que nosotros mismos vimos en
 * la ficha de ESE proceso. Aceptar un uuid cualquiera del cliente convertiría
 * esto en un proxy abierto contra Alfresco.
 */
async function descargaDeFicha(db, nidProceso, { uuid, filename }) {
  const p = await db.getProceso(nidProceso);
  for (const d of p?.documentos || []) {
    for (const x of d.descargas || []) {
      if (uuid ? x.uuid === uuid : x.filename === filename) return x;
    }
  }
  return null;
}

function enviarDoc(res, filename, buffer, inmutable) {
  res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(filename)}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  // inmutable solo si el nombre del archivo ES su hash; lo vivo puede cambiar
  res.setHeader("Cache-Control", inmutable ? "public, max-age=31536000, immutable" : "private, max-age=300");
  res.send(buffer);
}

// GET /api/v2/procesos/:nidProceso/documentos/:ref/download
//
// ESTE es el link que se le pasa al ERP: la URL de SEACE no se puede linkear
// (lleva un alf_ticket de un solo uso que caduca). `ref` es un sha256 si el
// documento está guardado en disco, o el uuid de Alfresco para cualquier otro
// de la ficha — los que nunca se bajaron (saltados por maxDocMB, actas,
// pliegos absolutorios). En ese caso hacemos los dos GETs acá y streameamos.
app.get("/api/v2/procesos/:nidProceso/documentos/:ref/download", async (req, res) => {
  const { nidProceso, ref } = req.params;
  try {
    if (/^[a-f0-9]{64}$/i.test(ref)) {
      const docs = await req.db.getDocumentos(nidProceso);
      const doc = docs.find((d) => d.hash_sha256 === ref);
      if (!doc) return res.status(404).json({ error: "documento no encontrado" });
      try {
        return enviarDoc(res, doc.filename, await readDoc(doc.path), true);
      } catch {
        // lo borró la purga. Si la ficha todavía tiene su uuid, se baja en
        // vivo: un link viejo del ERP sigue funcionando en vez de dar 410.
        const viva = await descargaDeFicha(req.db, nidProceso, { filename: doc.filename });
        if (!viva) {
          return res.status(410).json({ error: "documento purgado del disco", filename: doc.filename });
        }
        const out = await descargarDocHttp(viva.uuid, viva.filename);
        return enviarDoc(res, out.filename, out.buffer, false);
      }
    }

    const doc = await descargaDeFicha(req.db, nidProceso, { uuid: ref });
    if (!doc) return res.status(404).json({ error: "uuid no está en la ficha de este proceso" });
    const out = await descargarDocHttp(ref, doc.filename);
    enviarDoc(res, out.filename, out.buffer, false);
  } catch (e) {
    sendError(res, req, e);
  }
});

// GET /api/v2/runs — lista runs recientes
app.get("/api/v2/runs", async (req, res) => {
  try {
    res.json({ data: await req.db.listRuns(Math.min(Number(req.query.limit) || 50, 200)) });
  } catch (e) {
    sendError(res, req, e);
  }
});

// GET /api/v2/last-run — último run con sus procesos
app.get("/api/v2/last-run", async (req, res) => {
  try {
    res.json((await req.db.getLastRun()) || { run: null, procesos: [] });
  } catch (e) {
    sendError(res, req, e);
  }
});

// ---------- server ----------
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`[api] SEACE API :${port} (concurrency=${process.env.SCRAPE_CONCURRENCY || 2}, auth=${API_KEY ? "on" : "off"})`);
});

async function shutdown() {
  console.log("\n[api] cerrando...");
  await shutdownBrowser();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
