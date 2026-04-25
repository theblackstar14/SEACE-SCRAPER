import { chromium } from "playwright";
import pLimit from "p-limit";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config/config.js";

// folder controlado para downloads de Playwright (evita llenar %TEMP%)
const DOWNLOADS_DIR = path.resolve("./data/tmp/downloads");

export function ensureDownloadsDir() {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  } catch {}
  return DOWNLOADS_DIR;
}

export function cleanDownloadsDir() {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) return;
    for (const entry of fs.readdirSync(DOWNLOADS_DIR)) {
      try {
        fs.rmSync(path.join(DOWNLOADS_DIR, entry), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

let browser = null;
let launching = null;

const MAX_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 2;
const limit = pLimit(MAX_CONCURRENCY);

// recursos que no aportan al scrape — cortan 40-60% del tiempo de goto
// en modo headed (debug visual) NO bloqueamos CSS para que la página se vea normal
// Lazy: se evalúa al crear contexto, no al import
function getBlockedTypes() {
  return config.headless
    ? new Set(["image", "font", "media", "stylesheet"])
    : new Set(["media"]);
}
const BLOCKED_URL_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /doubleclick\.net/i,
  /facebook\.(com|net)/i,
  /hotjar\.com/i,
];

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;

  const launchOpts = {
    headless: config.headless,
    downloadsPath: ensureDownloadsDir(), // controla dónde van descargas (no %TEMP%)
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  };

  // slow-mo útil para debugging visual cuando corres con HEADLESS=false
  if (!config.headless && process.env.SLOW_MO) {
    launchOpts.slowMo = Number(process.env.SLOW_MO) || 250;
    console.log(`[browser] slowMo ${launchOpts.slowMo}ms`);
  }
  if (process.env.PROXY_SERVER) {
    launchOpts.proxy = {
      server: process.env.PROXY_SERVER,
      username: process.env.PROXY_USER,
      password: process.env.PROXY_PASS,
    };
    console.log("[browser] Proxy:", process.env.PROXY_SERVER);
  }

  launching = chromium.launch(launchOpts).then((b) => {
    browser = b;
    launching = null;
    b.on("disconnected", () => {
      browser = null;
    });
    return b;
  });
  return launching;
}

async function newContext(b) {
  const ctx = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
    locale: "es-PE",
    timezoneId: "America/Lima",
    acceptDownloads: true,
    // NO recording — previene trace/video archivos temp inflados
    recordVideo: undefined,
    recordHar: undefined,
  });

  // stealth básico
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // bloquear recursos pesados / tracking (tipos según modo headless vs headed)
  // IMPORTANTE: imgs de SEACE (fichaSeleccion.gif, btnLupa.gif, etc) se permiten
  // porque son iconos UI pequeños y sin ellos los botones quedan 0×0 →
  // Playwright marca como "not visible" aunque estén en DOM.
  const blockedTypes = getBlockedTypes();
  await ctx.route("**/*", (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();

    // tracking/ads siempre bloqueado
    if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) return route.abort();

    // imgs: bloquear solo externas (SEACE propias no → iconos UI botones)
    if (type === "image") {
      const isSeace = /seace\.gob\.pe|\.seace\./i.test(url) || url.startsWith("data:");
      if (isSeace) return route.continue();
      return route.abort();
    }

    if (blockedTypes.has(type)) return route.abort();
    return route.continue();
  });

  return ctx;
}

/**
 * Corre `fn(page)` con concurrencia limitada y context aislado.
 * Encola si supera MAX_CONCURRENCY.
 */
export async function withPage(fn) {
  return limit(async () => {
    const b = await getBrowser();
    const ctx = await newContext(b);
    const page = await ctx.newPage();
    try {
      return await fn(page);
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

/**
 * Retry exponencial para operaciones playwright flaky.
 * Reintenta en errores de timeout/navegación.
 */
export async function withRetry(fn, { retries = 3, baseMs = 800, label = "op" } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      const retriable =
        msg.includes("Timeout") ||
        msg.includes("net::") ||
        msg.includes("Target closed") ||
        msg.includes("Navigation") ||
        msg.includes("ECONNRESET");
      if (!retriable || i === retries - 1) throw e;
      const wait = baseMs * Math.pow(2, i);
      console.warn(`[retry ${label}] intento ${i + 1}/${retries} falló: ${msg.slice(0, 100)} — esperando ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function shutdownBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

export function poolStats() {
  return {
    active: limit.activeCount,
    pending: limit.pendingCount,
    concurrency: MAX_CONCURRENCY,
    browserConnected: !!(browser && browser.isConnected()),
  };
}
