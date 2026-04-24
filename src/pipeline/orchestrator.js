import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import { scrapeSeace } from "../scraper/seaceScraper.js";
import { scrapeDetalleConDescarga } from "../scraper/seaceDetalle.js";
import { isProcesoActivo } from "../scraper/cronograma.js";
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
  if (!monto || !vr) return null;
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
 * Pipeline:
 *   listar → detalle+descarga (1 nav) → filtro activos → extraer PDF → analizar → evaluar → output
 *
 * Cambio clave: detalle y descarga ahora comparten UNA sola navegación.
 * Antes: 2× openBuscador/proceso = ~60s desperdicio. Ahora: 1× = ~30s/proceso.
 */
export async function runObraPipeline({
  empresa,
  filters = {},
  limit = 30,
  concurrency = 2,
  onProgress = () => {},
  skipPdf = false,
  useLlm = isLlmAvailable() || isGeminiAvailable(),
  llmPolicy = "fallback", // 'fallback' = solo si regex falla | 'always' = siempre
  llmProvider = "auto", // 'auto' | 'claude' | 'gemini'
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

  const candidatos = listado.slice(0, limit);

  // 2. DETALLE + DESCARGA (una sola nav por proceso, concurrencia controlada)
  const lim = pLimit(concurrency);
  const detallados = await Promise.all(
    candidatos.map((p, idx) =>
      lim(async () => {
        try {
          emit("detalle", { idx, total: candidatos.length, msg: `${p.nomenclatura}` });
          const { detalle, descarga, docSelected } = await scrapeDetalleConDescarga({
            nomenclatura: p.nomenclatura,
            nidProceso: p.nidProceso,
            nidConvocatoria: p.nidConvocatoria,
            filters: {
              objetoContratacion: filters.objetoContratacion || "Obra",
              fechaDesde: filters.fechaDesde,
              fechaHasta: filters.fechaHasta,
            },
            downloadBases: !skipPdf,
          });
          return { listado: p, detalle, descarga, docSelected, error: null };
        } catch (e) {
          console.warn(`[detalle FAIL] ${p.nomenclatura}: ${e.message}`);
          return { listado: p, detalle: null, descarga: null, error: e.message };
        }
      })
    )
  );

  // 3. FILTRO ACTIVOS
  const activos = detallados.filter((d) => d.detalle && isProcesoActivo(d.detalle.cronograma));
  emit("filtro_activos", {
    msg: `${activos.length} activos / ${detallados.filter((d) => d.detalle).length} detallados`,
  });

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
        try {
          // para escaneados GRANDES preferimos Gemini (1M context, OCR mejor)
          const provider = pickLlmProvider({
            tipo: "pdf",
            escaneado: true,
            pageCount: doc.meta?.pages || 0,
            llmProvider,
          });
          emit("llm", { msg: `${p.nomenclatura} → ${provider} OCR (escaneado)` });
          const vr = detalle.vrCuantiaMonto || p.vrCuantia;
          const llm =
            provider === "gemini"
              ? await extractRequisitosWithGeminiPdf(pdfForOcr, {
                  valorReferencial: vr,
                  filename: descarga.filename,
                })
              : await extractRequisitosWithClaudePdf(pdfForOcr, {
                  valorReferencial: vr,
                  filename: descarga.filename,
                });
          analisis.requisitos = mapLlmToRequisitos(llm, { fuente: `${provider}-pdf-ocr` });
          analisis.llmUsed = { via: `${provider}-pdf-ocr`, provider, ...llm.meta };
          if (!llm.esBasesIntegradas || llm.confianza < 0.3 || llm.experienciaMonto == null) {
            analisis.evaluacion = {
              resultado: "indeterminado",
              razones: [
                llm.esBasesIntegradas
                  ? `Claude analizó el PDF pero no detectó monto específico de experiencia (confianza ${llm.confianza.toFixed(2)}). ${llm.notas || ""}`
                  : `Claude identificó Bases Estándar sin rellenar (etapa temprana). ${llm.notas || ""}`,
              ],
            };
          } else {
            analisis.evaluacion = evaluarProceso(
              { experienciaMonto: llm.experienciaMonto, tiposObraSimilar: llm.tiposObraSimilar, antiguedadMaxAnios: llm.antiguedadMaxAnios },
              empresa,
              { consorcioRatio: 0.5 }
            );
            analisis.evaluacion.razones.unshift(
              `Extracción por ${provider} (PDF escaneado, OCR): confianza ${llm.confianza.toFixed(2)}`
            );
          }
          enriquecidos.push({ listado: p, detalle, analisis });
          continue;
        } catch (e) {
          analisis.warnings.push(`claude OCR fail: ${e.message}`);
        }
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

          const provider = pickLlmProvider({
            tipo: textOk ? "text" : "pdf",
            escaneado: false,
            pageCount: doc.meta?.pages || 0,
            textLength: doc.text?.length || 0,
            llmProvider,
          });
          const reason = regexFallo ? "regex fallo" : regexSospechoso ? "sospecha" : esTemplate ? "template" : "reforzar";
          emit("llm", {
            msg: `${p.nomenclatura} → ${provider} ${textOk ? "text" : "pdf"} (${reason})`,
          });

          const llm = textOk
            ? provider === "gemini"
              ? await extractRequisitosWithGeminiText(doc.text, { valorReferencial: vr })
              : await extractRequisitosWithClaudeText(doc.text, { valorReferencial: vr })
            : provider === "gemini"
            ? await extractRequisitosWithGeminiPdf(descarga.buffer, {
                valorReferencial: vr,
                filename: descarga.filename,
              })
            : await extractRequisitosWithClaudePdf(descarga.buffer, {
                valorReferencial: vr,
                filename: descarga.filename,
              });

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

    enriquecidos.push({ listado: p, detalle, analisis });
  }

  // 5. BUILD OUTPUT
  const procesos = enriquecidos.map(({ listado: p, detalle, analisis }) => ({
    id: p.nidProceso,
    nidConvocatoria: p.nidConvocatoria,
    nomenclatura: p.nomenclatura,
    entidad: detalle.entidad || p.entidad,
    descripcion: detalle.descripcion || p.descripcion,
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
    calidadTexto: analisis.calidadTexto, // { escaneado, template, razonCalidad }
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
  }));

  const resumen = {
    totalListados: listado.length,
    analizados: candidatos.length,
    detallados: detallados.filter((d) => d.detalle).length,
    activos: activos.length,
    califican: procesos.filter((p) => p.evaluacion.resultado === "califica").length,
    consorcio: procesos.filter((p) => p.evaluacion.resultado === "consorcio").length,
    noCalifican: procesos.filter((p) => p.evaluacion.resultado === "no_califica").length,
    indeterminados: procesos.filter((p) => p.evaluacion.resultado === "indeterminado").length,
    escaneados: procesos.filter((p) => p.calidadTexto?.escaneado).length,
    templates: procesos.filter((p) => p.calidadTexto?.template).length,
    llmUsed: procesos.filter((p) => p.llmUsed).length,
    llmEnabled: useLlm,
    duracionMs: Date.now() - runStart,
  };

  // cleanup final: temps de descarga ya no se necesitan
  cleanDownloadsDir();

  emit("done", { msg: JSON.stringify(resumen) });

  return {
    runAt: new Date().toISOString(),
    filters,
    empresa: { razonSocial: empresa.razonSocial, ruc: empresa.ruc },
    resumen,
    procesos,
  };
}
