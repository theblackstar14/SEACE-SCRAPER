import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import { scrapeSeace } from "../scraper/seaceScraper.js";
import { scrapeDetalleConDescarga, scrapeCronogramaOnly } from "../scraper/seaceDetalle.js";
import { isProcesoActivo, parseSeaceDate } from "../scraper/cronograma.js";
import { extractTextFromDoc } from "../pdf/docExtractor.js";
import { analizarRequisitos } from "../analyzer/requisitos.js";
import { evaluarProceso } from "../analyzer/evaluator.js";
import { cleanDownloadsDir } from "../browserPool.js";
import { isLlmAvailable } from "../llm/claude.js";
import { isGeminiAvailable } from "../llm/gemini.js";
import {
  extractRequisitosWithClaudePdf,
  extractRequisitosWithClaudeText,
  extractRequisitosWithGeminiPdf,
  extractRequisitosWithGeminiText,
} from "../analyzer/llmExtractor.js";
import { hashBuffer, getByHash, setByHash, stats as hashCacheStats } from "../analyzer/hashCache.js";

/**
 * Elige provider óptimo según el caso:
 *  - PDF escaneado O muy grande (>40 pág) → Gemini PDF (context 1M, OCR fuerte)
 *  - Texto largo (>100k chars) → Gemini text (context 1M)
 *  - Texto chico OK → Claude text (rápido, barato para texto)
 *  - PDF chico (<40 pag) escaneado → Claude PDF (si Gemini no disponible)
 *
 * llmProvider: 'auto' | 'claude' | 'gemini'
 */
function pickLlmProvider({ tipo, pageCount, textLength, escaneado, llmProvider = "auto" }) {
  const claudeOk = isLlmAvailable();
  const geminiOk = isGeminiAvailable();

  if (llmProvider === "claude" && claudeOk) return "claude";
  if (llmProvider === "gemini" && geminiOk) return "gemini";

  // auto
  if (!claudeOk && !geminiOk) return null;
  if (!claudeOk) return "gemini";
  if (!geminiOk) return "claude";

  // ambos disponibles: elegir por tamaño
  if (escaneado || (pageCount && pageCount > 40)) return "gemini";
  if (textLength && textLength > 100_000) return "gemini";
  return "claude"; // caso normal: texto chico/mediano → Claude
}

const DEBUG_DIR = "./data/debug/pdftext";
const DUMP_MAX_FILES = 20;

const MS_DAY = 86_400_000;

/**
 * Pre-filtro 1: heurística por fecha publicación.
 * Si proceso publicado hace mucho, probable que ya venció presentación.
 * - LP-ABR (Licitación Pública Abreviada): ciclo ~25-30 días → skip si pubFecha > 30 días
 * - LP / LP-SM regular: ciclo ~45-60 días → skip si pubFecha > 60 días
 * - DIRECTA / RES-PROC: cortos, ~15 días → skip si pubFecha > 20 días
 */
function probablementeVencido(proceso, { maxPubDias = 30 } = {}) {
  const pubFecha = parseSeaceDate(proceso.fechaPublicacion);
  if (!pubFecha) return false; // si no parseamos, no descartamos
  const diasDesdePub = (Date.now() - pubFecha.ms) / MS_DAY;

  const nom = String(proceso.nomenclatura || "").toUpperCase();
  let umbral = maxPubDias;
  if (/LP-?ABR|LPABR/.test(nom)) umbral = Math.min(maxPubDias, 30);
  else if (/^LP-|LP-SM|^CP-|^LICITACION/.test(nom)) umbral = Math.max(maxPubDias, 60);
  else if (/DIRECTA|RES-PROC/.test(nom)) umbral = Math.min(maxPubDias, 20);

  return diasDesdePub > umbral;
}

/**
 * Pre-filtro 2: monto VR vs capacidad empresa.
 * Si VR > capacidad × ratio, ni con consorcio cubrimos. Skip.
 */
function fueraDeCapacidad(proceso, empresa, { maxMontoRatio = 2 } = {}) {
  const vr = proceso.vrCuantia;
  const capacidad = empresa.capacidadContratacionCAPECO;
  if (!vr || !capacidad) return false; // sin data, no descartamos
  return vr > capacidad * maxMontoRatio;
}

/**
 * Filtro real: tiene tiempo suficiente para postular.
 * presentación >= hoy + N días.
 */
function tieneTiempoSuficiente(detalle, { minDias = 15 } = {}) {
  const fp = detalle?.fechaPresentacion;
  if (!fp) return false;
  if (fp.estado === "vencido") return false;
  if (fp.diasRestantes == null) return false;
  return fp.diasRestantes >= minDias;
}

/**
 * Score de priorización (0-100). Mayor = más interesante para el postor.
 */
function calcularScore(proceso, evaluacion, empresa, { minDias = 15 } = {}) {
  let score = 0;

  // (1) resultado evaluación: 40 pts max
  const resMap = { califica: 40, consorcio: 25, no_califica: 5, indeterminado: 10 };
  score += resMap[evaluacion?.resultado] ?? 0;

  // (2) margen de tiempo: 25 pts max (más tiempo = mejor)
  const dias = proceso.diasRestantes ?? 0;
  if (dias >= 30) score += 25;
  else if (dias >= 21) score += 20;
  else if (dias >= minDias) score += 15;
  else if (dias > 0) score += 5;

  // (3) tipo obra coincide especialidades: 20 pts
  const tipos = (proceso.requisitos?.tipoObra || "").split("|").filter(Boolean);
  const especialidades = new Set((empresa.especialidades || []).map((s) => s.toLowerCase()));
  const matches = tipos.filter((t) => especialidades.has(t.toLowerCase())).length;
  if (matches >= 2) score += 20;
  else if (matches === 1) score += 12;

  // (4) confianza extracción: 10 pts max
  score += Math.round((proceso.requisitos?.confianza ?? 0) * 10);

  // (5) tamaño manejable: 5 pts (proceso < capacidad propia)
  const vr = proceso.valorReferencial || 0;
  if (vr > 0 && empresa.capacidadContratacionCAPECO && vr < empresa.capacidadContratacionCAPECO) {
    score += 5;
  }

  return Math.min(100, Math.max(0, Math.round(score)));
}

async function dumpText(nomenclatura, text, meta) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });

    // rotación: si ya hay más de N archivos, borrar los más viejos
    try {
      const entries = await fs.readdir(DEBUG_DIR);
      if (entries.length >= DUMP_MAX_FILES) {
        const stats = await Promise.all(
          entries.map(async (e) => ({
            name: e,
            mtime: (await fs.stat(path.join(DEBUG_DIR, e))).mtimeMs,
          }))
        );
        stats.sort((a, b) => a.mtime - b.mtime);
        const toDelete = stats.slice(0, Math.max(0, entries.length - DUMP_MAX_FILES + 1));
        await Promise.all(toDelete.map((e) => fs.rm(path.join(DEBUG_DIR, e.name), { force: true })));
      }
    } catch {}

    const safe = nomenclatura.replace(/[^\w-]/g, "_").slice(0, 80);
    const file = path.join(DEBUG_DIR, `${safe}.txt`);
    const header = `// Nomenclatura: ${nomenclatura}\n// Source: ${meta.source || "?"}\n// Files: ${JSON.stringify(meta.files || [])}\n// Pages: ${meta.pages || "n/a"}\n// Length: ${text.length} chars\n\n`;
    await fs.writeFile(file, header + text, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * Intenta LLM primero con `provider` preferido. Si falla por rate-limit, créditos
 * agotados, 429, o cualquier error → cae atrás al OTRO provider disponible.
 * Retorna { result, providerUsed, errors: [{ provider, error }] }.
 *
 * @param {object} opts
 *   - preferredProvider: "claude" | "gemini"
 *   - callClaude: async () => result
 *   - callGemini: async () => result
 */
async function tryLlmWithFallback({ preferredProvider, callClaude, callGemini }) {
  const { isLlmAvailable } = await import("../llm/claude.js");
  const { isGeminiAvailable } = await import("../llm/gemini.js");

  const errors = [];
  const order = [];
  if (preferredProvider === "gemini" && isGeminiAvailable()) {
    order.push({ name: "gemini", fn: callGemini });
    if (isLlmAvailable()) order.push({ name: "claude", fn: callClaude });
  } else if (preferredProvider === "claude" && isLlmAvailable()) {
    order.push({ name: "claude", fn: callClaude });
    if (isGeminiAvailable()) order.push({ name: "gemini", fn: callGemini });
  } else {
    // auto: el que esté
    if (isLlmAvailable()) order.push({ name: "claude", fn: callClaude });
    if (isGeminiAvailable()) order.push({ name: "gemini", fn: callGemini });
  }

  for (const { name, fn } of order) {
    try {
      const result = await fn();
      return { result, providerUsed: name, errors };
    } catch (e) {
      const msg = String(e.message || e);
      const depleted = /credits.*depleted|quota|insufficient|billing/i.test(msg);
      const rateLimit = /429|rate.?limit|too many/i.test(msg);
      console.warn(`[llm ${name} FAIL] ${msg.slice(0, 200)}`);
      errors.push({ provider: name, error: msg.slice(0, 300), fatal: depleted });
      // si el error es creds/billing, NO reintentar con mismo provider luego
      // pero sí con el otro (próxima iteración del loop)
    }
  }

  return { result: null, providerUsed: null, errors };
}

/**
 * Busca el PDF más grande dentro de un ZIP (recursivo a ZIPs anidados).
 * Retorna el Buffer o null.
 */
async function findLargestPdfRecursive(zip, depth = 0) {
  if (depth > 3) return null;
  const AdmZip = (await import("adm-zip")).default;
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  let biggest = null;
  for (const e of entries) {
    const ext = (e.entryName.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    if (ext === "pdf") {
      if (!biggest || e.header.size > biggest.header.size) {
        biggest = e;
      }
    } else if (ext === "zip") {
      try {
        const inner = new AdmZip(e.getData());
        const innerPdf = await findLargestPdfRecursive(inner, depth + 1);
        if (innerPdf && (!biggest || innerPdf.length > (biggest.getData?.()?.length || 0))) {
          return innerPdf; // ya es Buffer
        }
      } catch {}
    }
  }
  return biggest ? biggest.getData() : null;
}

/**
 * Sanity check: detecta si el monto extraído es absurdo vs VR.
 * Ej: monto muy bajo (< 1% VR) o muy alto (> 20× VR) es probable error.
 */
function detectarMontoAbsurdo(monto, vr) {
  if (!monto) return null;
  if (!vr) {
    // sin VR no podemos validar magnitud relativa. Ser defensivo.
    return `monto S/ ${monto.toLocaleString("es-PE")} extraído sin VR de referencia — requiere validación manual`;
  }
  if (monto === vr || Math.abs(monto - vr) / vr < 0.02) {
    return `monto extraído (${monto}) coincide con VR (${vr}) ±2% — probable falso positivo`;
  }
  if (monto < vr * 0.01) {
    return `monto extraído (S/ ${monto.toLocaleString("es-PE")}) es menor al 1% del VR (S/ ${vr.toLocaleString("es-PE")}) — monto absurdamente bajo`;
  }
  if (monto > vr * 20) {
    return `monto extraído (S/ ${monto.toLocaleString("es-PE")}) es mayor a 20× VR (S/ ${vr.toLocaleString("es-PE")}) — monto absurdamente alto`;
  }
  return null;
}

/**
 * Convierte output del LLM al formato interno de requisitos para compatibilidad
 * con el resto del pipeline.
 */
function mapLlmToRequisitos(llm, { fuente = "claude" } = {}) {
  return {
    experienciaMonto: llm.experienciaMonto,
    experienciaConfianza: llm.confianza,
    experienciaHits: llm.citas.map((c, i) => ({
      tipo: "monto",
      monto: llm.experienciaMonto,
      patternId: `LLM-${i + 1}`,
      confianza: llm.confianza,
      fragmento: c,
    })),
    tipoObra: (llm.tiposObraSimilar || []).join("|"),
    antiguedadMaxAnios: llm.antiguedadMaxAnios,
    requiereLlm: false, // ya lo usamos
    sospecha: null,
    paginas: llm.meta?.pagesAnalyzed || null,
    fuente,
  };
}

/**
 * Heurísticas sobre el texto extraído del doc:
 *   - escaneado: PDF con muchas páginas pero casi sin texto (chars/page < 50)
 *   - template: contiene frases marcadoras de "Bases Estándar" sin montos rellenos
 */
function analizarCalidadTexto(text, meta) {
  const flags = { escaneado: false, template: false, razonCalidad: null };

  const pages = meta.pages || 0;
  const ratio = pages > 0 ? text.length / pages : text.length;
  if (pages >= 10 && ratio < 50) {
    flags.escaneado = true;
    flags.razonCalidad = `PDF escaneado (${pages} págs, ~${Math.round(ratio)} chars/pág) — requiere OCR`;
    return flags;
  }

  // marcador inequívoco del template SEACE Bases Estándar (sin montos rellenos)
  const tlow = text.toLowerCase();
  const hasPlaceholder =
    tlow.includes("[consignar nomenclatura del procedimiento") ||
    tlow.includes("[consignar aquí") ||
    tlow.includes("[consignar el monto") ||
    tlow.includes("bases estándar licitación pública abreviada");
  const hasSpecificAmount = /experiencia[^.]{0,150}(no\s*menor\s*a|equivalente\s*a)\s*s\s*\/\s*\.?\s*\d{3,}/i.test(
    text
  );
  if (hasPlaceholder && !hasSpecificAmount) {
    flags.template = true;
    flags.razonCalidad =
      "Bases Estándar sin montos rellenos (etapa temprana — reintentar en Integración de Bases)";
  }

  return flags;
}

/**
 * Pipeline 2-FASE optimizado:
 *
 *   1. LISTADO (1.8 min)
 *   2. PRE-FILTRO heurística (instantáneo): pubFecha vieja, monto > capacidad
 *   3. CRONOGRAMA LIGERO (sin descarga, ~30s × N / concurrency)
 *   4. FILTRO TIEMPO: presentación >= hoy + minDias
 *   5. DETALLE COMPLETO + DESCARGA (skip > maxDocMB)
 *   6. ANÁLISIS LLM (regex/Claude/Gemini)
 *   7. SCORE + sorted output
 *
 * Beneficio: gastamos LLM/bandwidth solo en procesos accionables.
 *
 * @param {object} opts
 *   - minDias: días mínimos antes de presentación (default 15)
 *   - maxMontoRatio: VR <= empresa.capacidad × ratio (default 2)
 *   - maxPubDias: descarta si pubFecha > N días (default 30, override por tipo)
 *   - maxDocMB: skip download si Bases > N MB (default 50)
 */
export async function runObraPipeline({
  empresa,
  filters = {},
  limit = 30,
  concurrency = 2,
  onProgress = () => {},
  skipPdf = false,
  useLlm = isLlmAvailable() || isGeminiAvailable(),
  llmPolicy = "fallback",
  llmProvider = "auto",
  minDias = 15,
  maxMontoRatio = 2,
  maxPubDias = 30,
  maxDocMB = 50,
} = {}) {
  const runStart = Date.now();
  const emit = (step, data) => {
    onProgress({ step, ...data });
    const log = `[${step}] ${data.msg || ""}`;
    console.log(log);
  };

  // 0. CLEANUP de runs previos (evita que descargas acumuladas llenen disco)
  cleanDownloadsDir();

  // 1. LISTADO
  emit("listado", { msg: `scraping listado con filtros ${JSON.stringify(filters)}` });
  const listado = await scrapeSeace({
    objetoContratacion: filters.objetoContratacion || "Obra",
    fechaDesde: filters.fechaDesde,
    fechaHasta: filters.fechaHasta,
    allPages: filters.allPages ?? true,
    limit: filters.allPages === false ? limit : Infinity,
    maxPages: 50,
  });
  emit("listado_ok", { msg: `${listado.length} procesos en listado` });

  // 2. PRE-FILTRO HEURÍSTICA (instantáneo, sin red)
  const tras_prefiltro = listado
    .slice(0, limit)
    .filter((p) => {
      if (probablementeVencido(p, { maxPubDias })) return false;
      if (fueraDeCapacidad(p, empresa, { maxMontoRatio })) return false;
      return true;
    });
  const descartadosPrefiltro = Math.min(limit, listado.length) - tras_prefiltro.length;
  emit("prefiltro", {
    msg: `${tras_prefiltro.length} pasaron pre-filtro (${descartadosPrefiltro} descartados por pubFecha/monto)`,
  });

  // 3. CRONOGRAMA LIGERO — solo lee fechaPresentacion, no descarga
  const lim = pLimit(concurrency);
  const cronogramas = await Promise.all(
    tras_prefiltro.map((p, idx) =>
      lim(async () => {
        try {
          emit("cronograma", { idx, total: tras_prefiltro.length, msg: `${p.nomenclatura}` });
          const { cronograma, fechaPresentacion } = await scrapeCronogramaOnly({
            nomenclatura: p.nomenclatura,
            nidProceso: p.nidProceso,
            nidConvocatoria: p.nidConvocatoria,
            filters: {
              objetoContratacion: filters.objetoContratacion || "Obra",
              fechaDesde: filters.fechaDesde,
              fechaHasta: filters.fechaHasta,
            },
          });
          return { listado: p, cronograma, fechaPresentacion, error: null };
        } catch (e) {
          console.warn(`[cronograma FAIL] ${p.nomenclatura}: ${e.message}`);
          return { listado: p, error: e.message };
        }
      })
    )
  );

  // 4. FILTRO TIEMPO SUFICIENTE (>= minDias hasta presentación)
  const conTiempo = cronogramas.filter((c) =>
    tieneTiempoSuficiente({ fechaPresentacion: c.fechaPresentacion }, { minDias })
  );
  emit("filtro_tiempo", {
    msg: `${conTiempo.length}/${cronogramas.length} tienen >= ${minDias} días para presentación`,
  });

  // 5. DETALLE COMPLETO + DESCARGA — solo de los que pasaron filtros
  // Dedup runtime: filename+size visto antes en este run = reusa buffer
  const seenDocs = new Map(); // key=filename+size, val={buffer, filename, tipo, size}

  const detallados = await Promise.all(
    conTiempo.map((c, idx) =>
      lim(async () => {
        const p = c.listado;
        try {
          emit("detalle_full", { idx, total: conTiempo.length, msg: `${p.nomenclatura}` });
          const { detalle, descarga, docSelected } = await scrapeDetalleConDescarga({
            nomenclatura: p.nomenclatura,
            nidProceso: p.nidProceso,
            nidConvocatoria: p.nidConvocatoria,
            filters: {
              objetoContratacion: filters.objetoContratacion || "Obra",
              fechaDesde: filters.fechaDesde,
              fechaHasta: filters.fechaHasta,
              maxDocMB,
            },
            downloadBases: !skipPdf,
            // pasa seenDocs para dedup
            seenDocs,
          });
          return { listado: p, detalle, descarga, docSelected, error: null };
        } catch (e) {
          console.warn(`[detalle FAIL] ${p.nomenclatura}: ${e.message}`);
          return { listado: p, detalle: null, descarga: null, error: e.message };
        }
      })
    )
  );

  // mantener "activos" como variable para compat con código posterior
  const activos = detallados.filter((d) => d.detalle);
  emit("detalle_ok", { msg: `${activos.length} detalles completos` });

  // 4. ANÁLISIS PDF + EVALUACIÓN (en memoria, sin red)
  const enriquecidos = [];
  for (const item of activos) {
    const { listado: p, detalle, descarga, docSelected } = item;
    const analisis = {
      documentoUsado: null,
      textoExtraido: false,
      requisitos: null,
      evaluacion: null,
      warnings: [],
      calidadTexto: null,
    };

    if (skipPdf) {
      analisis.evaluacion = {
        resultado: "indeterminado",
        razones: ["skipPdf=true — análisis de Bases omitido"],
      };
      enriquecidos.push({ listado: p, detalle, analisis });
      continue;
    }

    if (!docSelected?.doc || !descarga) {
      analisis.warnings.push(
        `Sin documento descargable: ${docSelected?.razon || "descarga falló"}`
      );
      analisis.evaluacion = {
        resultado: "indeterminado",
        razones: ["No hay Bases Integradas ni Bases Administrativas descargables."],
      };
      enriquecidos.push({ listado: p, detalle, analisis });
      continue;
    }

    analisis.documentoUsado = {
      etapa: docSelected.doc.etapa,
      documento: docSelected.doc.documento,
      filename: descarga.filename,
      tipo: descarga.tipo,
      size: descarga.size,
      confianza: docSelected.confianza,
    };

    // CACHE POR HASH: si ya analizamos este buffer exacto antes, reusar
    const docHash = hashBuffer(descarga.buffer);
    analisis.docHash = docHash;
    const cached = await getByHash(docHash);
    if (cached) {
      console.log(`[cache HIT] ${p.nomenclatura} hash ${docHash.slice(0, 12)}... — reusa análisis previo`);
      analisis.cacheHit = true;
      analisis.requisitos = cached.requisitos;
      analisis.calidadTexto = cached.calidadTexto;
      analisis.zipContents = cached.zipContents || null;

      // re-aplicar sanity check (no se persiste en cache, depende del VR del proceso actual)
      const vrActual = detalle.vrCuantiaMonto || p.vrCuantia;
      const cachedSospecha = detectarMontoAbsurdo(cached.requisitos?.experienciaMonto, vrActual);

      if (cachedSospecha) {
        analisis.evaluacion = {
          resultado: "indeterminado",
          razones: [`[cache] hit + sospecha: ${cachedSospecha}`],
        };
        analisis.warnings.push(`cache-sospecha: ${cachedSospecha}`);
      } else if (cached.requisitos?.experienciaMonto) {
        analisis.evaluacion = evaluarProceso(
          {
            experienciaMonto: cached.requisitos.experienciaMonto,
            tiposObraSimilar: (cached.requisitos.tipoObra || "").split("|").filter(Boolean),
            antiguedadMaxAnios: cached.requisitos.antiguedadMaxAnios,
          },
          empresa,
          { consorcioRatio: 0.5 }
        );
        analisis.evaluacion.razones.unshift(`[cache] hit (hash ${docHash.slice(0, 8)})`);
      } else {
        analisis.evaluacion = cached.evaluacion || {
          resultado: "indeterminado",
          razones: [`[cache] hit: ${cached.calidadTexto?.razonCalidad || "sin requisitos extraíbles"}`],
        };
      }
      enriquecidos.push({ listado: p, detalle, analisis });
      continue;
    }

    try {
      const doc = await extractTextFromDoc(descarga);
      if (doc.errors.length) {
        analisis.warnings.push(...doc.errors.map((e) => `${e.name}: ${e.error}`));
      }

      // analizar calidad del texto extraído
      analisis.calidadTexto = analizarCalidadTexto(doc.text, doc.meta || {});
      analisis.textoExtraido = doc.text.length > 100;

      analisis.zipContents = doc.meta?.allEntries || null;

      // si es ZIP escaneado (PDF dentro escaneado), extrae ese PDF para Claude OCR
      let pdfForOcr = null;
      if (analisis.calidadTexto.escaneado && useLlm) {
        if (descarga.tipo === "pdf") {
          pdfForOcr = descarga.buffer;
        } else if (descarga.tipo === "zip") {
          // extraer el PDF más grande del ZIP (recursivo si está anidado)
          try {
            const AdmZip = (await import("adm-zip")).default;
            const zip = new AdmZip(descarga.buffer);
            pdfForOcr = await findLargestPdfRecursive(zip);
          } catch (e) {
            analisis.warnings.push(`no pude extraer PDF del zip: ${e.message}`);
          }
        }
      }

      // CASO ESPECIAL: escaneado Y LLM disponible → OCR directo sobre el PDF
      if (analisis.calidadTexto.escaneado && useLlm && pdfForOcr) {
        const preferred = pickLlmProvider({
          tipo: "pdf",
          escaneado: true,
          pageCount: doc.meta?.pages || 0,
          llmProvider,
        });
        const vr = detalle.vrCuantiaMonto || p.vrCuantia;
        emit("llm", { msg: `${p.nomenclatura} → ${preferred} OCR (escaneado) [con fallback]` });

        const { result: llm, providerUsed, errors } = await tryLlmWithFallback({
          preferredProvider: preferred,
          callClaude: () => extractRequisitosWithClaudePdf(pdfForOcr, { valorReferencial: vr, filename: descarga.filename }),
          callGemini: () => extractRequisitosWithGeminiPdf(pdfForOcr, { valorReferencial: vr, filename: descarga.filename }),
        });

        errors.forEach((e) => analisis.warnings.push(`${e.provider} fail: ${e.error}`));

        if (llm) {
          analisis.requisitos = mapLlmToRequisitos(llm, { fuente: `${providerUsed}-pdf-ocr` });
          analisis.llmUsed = { via: `${providerUsed}-pdf-ocr`, provider: providerUsed, ...llm.meta };
          if (!llm.esBasesIntegradas || llm.confianza < 0.3 || llm.experienciaMonto == null) {
            analisis.evaluacion = {
              resultado: "indeterminado",
              razones: [
                llm.esBasesIntegradas
                  ? `${providerUsed} analizó el PDF pero no detectó monto específico (confianza ${llm.confianza.toFixed(2)}). ${llm.notas || ""}`
                  : `${providerUsed} identificó Bases Estándar sin rellenar (etapa temprana). ${llm.notas || ""}`,
              ],
            };
          } else {
            analisis.evaluacion = evaluarProceso(
              { experienciaMonto: llm.experienciaMonto, tiposObraSimilar: llm.tiposObraSimilar, antiguedadMaxAnios: llm.antiguedadMaxAnios },
              empresa,
              { consorcioRatio: 0.5 }
            );
            analisis.evaluacion.razones.unshift(
              `Extracción por ${providerUsed} (PDF escaneado, OCR): confianza ${llm.confianza.toFixed(2)}`
            );
          }
          enriquecidos.push({ listado: p, detalle, analisis });
          continue;
        }
        // ambos LLM fallaron — cae a la rama "No se pudo extraer texto" de abajo
      }

      if (!analisis.textoExtraido || analisis.calidadTexto.escaneado) {
        let razon;
        if (analisis.calidadTexto.escaneado) {
          razon = analisis.calidadTexto.razonCalidad;
        } else if (doc.source === "zip" && doc.meta?.allEntries?.length) {
          const list = doc.meta.allEntries.map((e) => `${e.name} (${Math.round(e.size / 1024)}KB)`).join(", ");
          razon = `ZIP contiene ${doc.meta.allEntries.length} archivos sin texto extraíble: ${list}`;
        } else {
          razon = `No se pudo extraer texto del ${doc.source.toUpperCase()} (${descarga.filename})`;
        }
        analisis.evaluacion = { resultado: "indeterminado", razones: [razon] };
        enriquecidos.push({ listado: p, detalle, analisis });
        continue;
      }

      const requisitos = analizarRequisitos(doc.text, {
        valorReferencial: detalle.vrCuantiaMonto || p.vrCuantia,
      });

      // dump texto si no extrajo monto — calibración
      if (requisitos.experienciaMonto == null) {
        const dumpFile = await dumpText(p.nomenclatura, doc.text, {
          source: doc.source,
          ...doc.meta,
        });
        if (dumpFile) analisis.warnings.push(`dump: ${dumpFile}`);
      }

      // sanity check ampliado: monto ≈ VR, < 1% VR, o > 20× VR → sospechoso
      const vr = detalle.vrCuantiaMonto || p.vrCuantia;
      let sospecha = detectarMontoAbsurdo(requisitos.experienciaMonto, vr);
      if (sospecha) {
        analisis.warnings.push(`sospecha: ${sospecha}`);
        const dumpFile = await dumpText(p.nomenclatura, doc.text, {
          source: doc.source,
          ...doc.meta,
        });
        if (dumpFile) analisis.warnings.push(`dump-sospecha: ${dumpFile}`);
      }

      analisis.requisitos = {
        experienciaMonto: requisitos.experienciaMonto,
        experienciaConfianza: sospecha ? Math.min(requisitos.experienciaConfianza, 0.3) : requisitos.experienciaConfianza,
        experienciaHits: requisitos.experienciaHits.map((h) => ({
          tipo: h.tipo,
          monto: h.monto,
          veces: h.veces,
          cantidad: h.cantidad,
          unidad: h.unidad,
          patternId: h.patternId,
          confianza: h.confianza,
          fragmento: h.fragmento,
        })),
        tipoObra: requisitos.tiposObraSimilar.join("|"),
        antiguedadMaxAnios: requisitos.antiguedadMaxAnios,
        requiereLlm: requisitos.requiereLlm || sospecha != null,
        sospecha,
        paginas: doc.meta?.pages || null,
        fuente: doc.source,
      };

      // decisión: regex suficiente, o llamar a Claude?
      const regexFallo = requisitos.experienciaMonto == null;
      const regexSospechoso = sospecha != null;
      const esTemplate = analisis.calidadTexto.template; // template con o sin monto
      const esTemplateSinMonto = esTemplate && regexFallo;
      const debeLlm =
        useLlm &&
        (llmPolicy === "always" ||
          regexFallo ||
          regexSospechoso ||
          esTemplate || // SIEMPRE Claude en templates (regex puede extraer basura)
          requisitos.experienciaConfianza < 0.7);

      if (debeLlm) {
        try {
          const vr = detalle.vrCuantiaMonto || p.vrCuantia;
          const textOk = doc.text && doc.text.length > 500;

          const preferred = pickLlmProvider({
            tipo: textOk ? "text" : "pdf",
            escaneado: false,
            pageCount: doc.meta?.pages || 0,
            textLength: doc.text?.length || 0,
            llmProvider,
          });
          const reason = regexFallo ? "regex fallo" : regexSospechoso ? "sospecha" : esTemplate ? "template" : "reforzar";
          emit("llm", {
            msg: `${p.nomenclatura} → ${preferred} ${textOk ? "text" : "pdf"} (${reason}) [con fallback]`,
          });

          const { result: llm, providerUsed: provider, errors: llmErrors } = await tryLlmWithFallback({
            preferredProvider: preferred,
            callClaude: () =>
              textOk
                ? extractRequisitosWithClaudeText(doc.text, { valorReferencial: vr })
                : extractRequisitosWithClaudePdf(descarga.buffer, { valorReferencial: vr, filename: descarga.filename }),
            callGemini: () =>
              textOk
                ? extractRequisitosWithGeminiText(doc.text, { valorReferencial: vr })
                : extractRequisitosWithGeminiPdf(descarga.buffer, { valorReferencial: vr, filename: descarga.filename }),
          });

          llmErrors.forEach((e) => analisis.warnings.push(`${e.provider} fail: ${e.error}`));

          if (!llm) {
            throw new Error(`todos los LLM fallaron (${llmErrors.map((e) => e.provider).join(", ")})`);
          }

          analisis.llmUsed = {
            via: `${provider}-${textOk ? "text" : "pdf"}`,
            provider,
            ...llm.meta,
            citas: llm.citas,
            notas: llm.notas,
          };

          // LLM pisa regex si tiene mayor confianza o regex falló
          if (llm.experienciaMonto != null && (regexFallo || llm.confianza > requisitos.experienciaConfianza)) {
            analisis.requisitos = mapLlmToRequisitos(llm, {
              fuente: `${provider}-${textOk ? "text" : "pdf"}`,
            });

            if (llm.esBasesIntegradas && llm.confianza >= 0.5) {
              analisis.evaluacion = evaluarProceso(
                {
                  experienciaMonto: llm.experienciaMonto,
                  tiposObraSimilar: llm.tiposObraSimilar,
                  antiguedadMaxAnios: llm.antiguedadMaxAnios,
                },
                empresa,
                { consorcioRatio: 0.5 }
              );
              analisis.evaluacion.razones.unshift(
                `Extracción por ${provider} (confianza ${llm.confianza.toFixed(2)}, citas: ${llm.citas.length})`
              );
            } else {
              analisis.evaluacion = {
                resultado: "indeterminado",
                razones: [
                  llm.esBasesIntegradas
                    ? `Claude: monto S/ ${llm.experienciaMonto?.toLocaleString("es-PE")} pero confianza baja (${llm.confianza.toFixed(2)}). ${llm.notas || ""}`
                    : `Claude: Bases Estándar sin rellenar. ${llm.notas || ""}`,
                ],
              };
            }
          } else {
            // LLM también falló — usar regex si extrajo algo con sospecha flag
            if (esTemplateSinMonto) {
              analisis.evaluacion = {
                resultado: "indeterminado",
                razones: [llm.notas || analisis.calidadTexto.razonCalidad],
              };
            } else if (regexSospechoso) {
              analisis.evaluacion = {
                resultado: "indeterminado",
                razones: [`Requiere revisión manual: ${sospecha}. Claude tampoco confirmó el monto.`],
              };
            } else {
              analisis.evaluacion = {
                resultado: "indeterminado",
                razones: [`Ni regex ni Claude encontraron requisitos extraíbles. ${llm.notas || ""}`],
              };
            }
          }
        } catch (e) {
          console.warn(`[llm FAIL] ${p.nomenclatura}: ${e.message}`);
          analisis.warnings.push(`claude error: ${e.message}`);
          // fallback a lógica regex-only
          if (esTemplateSinMonto) {
            analisis.evaluacion = {
              resultado: "indeterminado",
              razones: [analisis.calidadTexto.razonCalidad],
            };
          } else if (regexSospechoso) {
            analisis.evaluacion = {
              resultado: "indeterminado",
              razones: [`Requiere revisión manual: ${sospecha}`],
            };
          } else {
            analisis.evaluacion = evaluarProceso(requisitos, empresa, { consorcioRatio: 0.5 });
          }
        }
      } else if (esTemplateSinMonto) {
        analisis.evaluacion = {
          resultado: "indeterminado",
          razones: [analisis.calidadTexto.razonCalidad],
        };
      } else if (regexSospechoso) {
        analisis.evaluacion = {
          resultado: "indeterminado",
          razones: [`Requiere revisión manual: ${sospecha}`],
        };
      } else {
        analisis.evaluacion = evaluarProceso(requisitos, empresa, { consorcioRatio: 0.5 });
      }
    } catch (e) {
      console.warn(`[análisis FAIL] ${p.nomenclatura}: ${e.message}`);
      analisis.warnings.push(`error análisis: ${e.message}`);
      analisis.evaluacion = {
        resultado: "indeterminado",
        razones: [`Error en análisis: ${e.message}`],
      };
    }

    // guardar en cache hash si tuvimos análisis (cualquiera, incluso indeterminado)
    if (analisis.docHash && !analisis.cacheHit && (analisis.requisitos || analisis.calidadTexto)) {
      await setByHash(analisis.docHash, {
        requisitos: analisis.requisitos,
        calidadTexto: analisis.calidadTexto,
        zipContents: analisis.zipContents,
        evaluacion: analisis.evaluacion,
      }, {
        filename: analisis.documentoUsado?.filename,
        size: analisis.documentoUsado?.size,
      }).catch(() => {});
    }

    enriquecidos.push({ listado: p, detalle, analisis });
  }

  // log stats cache
  const cstats = await hashCacheStats();
  emit("cache_stats", { msg: `cache: ${cstats.entries} entries, ${cstats.totalHits} hits, ${cstats.sizeKB}KB` });

  // 7. BUILD OUTPUT con score y sort
  const procesos = enriquecidos
    .map(({ listado: p, detalle, analisis }) => {
      const descripcionFull = detalle.descripcion || p.descripcion || "";
      const descripcionCorta = descripcionFull.slice(0, 120);
      const proceso = {
        // identificación principal (orden visible)
        nomenclatura: p.nomenclatura,
        entidad: detalle.entidad || p.entidad,
        descripcionCorta,
        descripcion: descripcionFull,
        // IDs internos
        id: p.nidProceso,
        nidConvocatoria: p.nidConvocatoria,
        objeto: detalle.objeto || p.objetoContratacion,
        valorReferencial: detalle.vrCuantiaMonto ?? p.vrCuantia ?? null,
        moneda: p.moneda || "PEN",
        fechaPublicacion: detalle.fechaPublicacion || p.fechaPublicacion,
        fechaPropuesta: detalle.fechaPresentacion?.finIso || detalle.fechaPresentacion?.fin || null,
        diasRestantes: detalle.fechaPresentacion?.diasRestantes ?? null,
        estado: detalle.fechaPresentacion?.estado,
        cronograma: detalle.cronograma,
        documentoUsado: analisis.documentoUsado,
        zipContents: analisis.zipContents || null,
        calidadTexto: analisis.calidadTexto,
        llmUsed: analisis.llmUsed || null,
        requisitos: analisis.requisitos
          ? {
              experienciaMinima: analisis.requisitos.experienciaMonto,
              tipoObra: analisis.requisitos.tipoObra,
              antiguedadMaxAnios: analisis.requisitos.antiguedadMaxAnios,
              confianza: analisis.requisitos.experienciaConfianza,
              requiereRevisionManual: analisis.requisitos.requiereLlm,
            }
          : null,
        evaluacion: {
          resultado: analisis.evaluacion?.resultado || "indeterminado",
          razones: analisis.evaluacion?.razones || [],
          sugerenciaConsorcio: analisis.evaluacion?.sugerenciaConsorcio || null,
        },
        warnings: analisis.warnings,
      };
      proceso.score = calcularScore(proceso, proceso.evaluacion, empresa, { minDias });
      return proceso;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0)); // mejor primero

  const cacheHitsRun = enriquecidos.filter((e) => e.analisis.cacheHit).length;
  const dedupHitsRun = activos.filter((d) => d.descarga?._deduped).length;

  const resumen = {
    totalListados: listado.length,
    limit,
    preFiltroPasaron: tras_prefiltro.length,
    descartadosPrefiltro,
    cronogramasLeidos: cronogramas.filter((c) => c.fechaPresentacion).length,
    conTiempoSuficiente: conTiempo.length,
    detalleCompleto: activos.length,
    califican: procesos.filter((p) => p.evaluacion.resultado === "califica").length,
    consorcio: procesos.filter((p) => p.evaluacion.resultado === "consorcio").length,
    noCalifican: procesos.filter((p) => p.evaluacion.resultado === "no_califica").length,
    indeterminados: procesos.filter((p) => p.evaluacion.resultado === "indeterminado").length,
    escaneados: procesos.filter((p) => p.calidadTexto?.escaneado).length,
    templates: procesos.filter((p) => p.calidadTexto?.template).length,
    llmUsed: procesos.filter((p) => p.llmUsed).length,
    llmEnabled: useLlm,
    cacheHashHits: cacheHitsRun,
    dedupRuntimeHits: dedupHitsRun,
    cacheStats: cstats,
    parametros: { minDias, maxMontoRatio, maxPubDias, maxDocMB },
    duracionMs: Date.now() - runStart,
  };

  // buffers descargados (Map nidProceso -> buffer) — para subir a Storage si se requiere
  const buffers = new Map();
  for (const item of activos) {
    if (item.descarga?.buffer && item.listado?.nidProceso) {
      buffers.set(item.listado.nidProceso, {
        buffer: item.descarga.buffer,
        filename: item.descarga.filename,
        tipo: item.descarga.tipo,
        size: item.descarga.size,
      });
    }
  }

  // cleanup final: temps de descarga ya no se necesitan
  cleanDownloadsDir();

  emit("done", { msg: JSON.stringify(resumen) });

  return {
    runAt: new Date().toISOString(),
    filters,
    empresa: { razonSocial: empresa.razonSocial, ruc: empresa.ruc },
    resumen,
    procesos,
    _buffers: buffers, // NO se persiste en JSON, solo runtime
  };
}
