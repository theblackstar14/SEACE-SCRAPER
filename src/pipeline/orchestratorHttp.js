/**
 * Pipeline HTTP-first. Usa Playwright SOLO para:
 *   - Bootstrap (1× navegación + paginación listado)
 *   - Descargas de PDF (download events)
 * El resto (cronograma, detalle, parseo) por HTTP directo.
 *
 * Speedup esperado vs Playwright-only:
 *   - 300 procesos: 2h 16min -> ~10 min
 */

import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import { bootstrapBatchByPage } from "../scraper/bootstrapHttp.js";
import { fetchCronogramaHttp, fetchDetalleHttp } from "../scraper/fichaHttp.js";
import { scrapeDetalleConDescarga } from "../scraper/seaceDetalle.js";
import { parseSeaceDate } from "../scraper/cronograma.js";
import { selectBasesIntegradas } from "../scraper/documentos.js";
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

const MS_DAY = 86_400_000;

// reuso helpers del orchestrator clásico (copy mínimo para no acoplar)
function probablementeVencido(proceso, { maxPubDias = 30 } = {}) {
  const pubFecha = parseSeaceDate(proceso.fechaPublicacion);
  if (!pubFecha) return false;
  const dias = (Date.now() - pubFecha.ms) / MS_DAY;
  const nom = String(proceso.nomenclatura || "").toUpperCase();
  let umbral = maxPubDias;
  if (/LP-?ABR|LPABR/.test(nom)) umbral = Math.min(maxPubDias, 30);
  else if (/^LP-|LP-SM|^CP-|^LICITACION/.test(nom)) umbral = Math.max(maxPubDias, 60);
  else if (/DIRECTA|RES-PROC/.test(nom)) umbral = Math.min(maxPubDias, 20);
  return dias > umbral;
}

function fueraDeCapacidad(proceso, empresa, { maxMontoRatio = 2 } = {}) {
  const vr = proceso.vrCuantia;
  const cap = empresa.capacidadContratacionCAPECO;
  if (!vr || !cap) return false;
  return vr > cap * maxMontoRatio;
}

function tieneTiempoSuficiente(detalle, { minDias = 15 } = {}) {
  const fp = detalle?.fechaPresentacion;
  if (!fp) return false;
  if (fp.estado === "vencido") return false;
  if (fp.diasRestantes == null) return false;
  return fp.diasRestantes >= minDias;
}

function calcularScore(p, evaluacion, empresa, { minDias = 15 } = {}) {
  let score = 0;
  const resMap = { califica: 40, consorcio: 25, no_califica: 5, indeterminado: 10 };
  score += resMap[evaluacion?.resultado] ?? 0;
  const dias = p.diasRestantes ?? 0;
  if (dias >= 30) score += 25;
  else if (dias >= 21) score += 20;
  else if (dias >= minDias) score += 15;
  else if (dias > 0) score += 5;
  const tipos = (p.requisitos?.tipoObra || "").split("|").filter(Boolean);
  const especialidades = new Set((empresa.especialidades || []).map((s) => s.toLowerCase()));
  const matches = tipos.filter((t) => especialidades.has(t.toLowerCase())).length;
  if (matches >= 2) score += 20;
  else if (matches === 1) score += 12;
  score += Math.round((p.requisitos?.confianza ?? 0) * 10);
  const vr = p.valorReferencial || 0;
  if (vr > 0 && empresa.capacidadContratacionCAPECO && vr < empresa.capacidadContratacionCAPECO) {
    score += 5;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}

function pickLlmProvider({ tipo, pageCount, textLength, escaneado, llmProvider = "auto" }) {
  const cOk = isLlmAvailable();
  const gOk = isGeminiAvailable();
  if (llmProvider === "claude" && cOk) return "claude";
  if (llmProvider === "gemini" && gOk) return "gemini";
  if (!cOk && !gOk) return null;
  if (!cOk) return "gemini";
  if (!gOk) return "claude";
  if (escaneado || (pageCount && pageCount > 40)) return "gemini";
  if (textLength && textLength > 100_000) return "gemini";
  return "claude";
}

function detectarMontoAbsurdo(monto, vr) {
  if (!monto) return null;
  if (!vr) return `monto S/ ${monto.toLocaleString("es-PE")} sin VR — revision manual`;
  if (monto === vr || Math.abs(monto - vr) / vr < 0.02) {
    return `monto (${monto}) coincide VR (${vr}) — falso positivo probable`;
  }
  if (monto < vr * 0.01) return `monto S/ ${monto.toLocaleString("es-PE")} < 1% VR — absurdo`;
  if (monto > vr * 20) return `monto S/ ${monto.toLocaleString("es-PE")} > 20× VR — absurdo`;
  return null;
}

function mapLlmToRequisitos(llm, { fuente }) {
  return {
    experienciaMonto: llm.experienciaMonto,
    experienciaConfianza: llm.confianza,
    experienciaHits: llm.citas.map((c, i) => ({
      tipo: "monto", monto: llm.experienciaMonto, patternId: `LLM-${i + 1}`,
      confianza: llm.confianza, fragmento: c,
    })),
    tipoObra: (llm.tiposObraSimilar || []).join("|"),
    antiguedadMaxAnios: llm.antiguedadMaxAnios,
    requiereLlm: false, sospecha: null,
    paginas: llm.meta?.pagesAnalyzed || null,
    fuente,
  };
}

function analizarCalidadTexto(text, meta) {
  const flags = { escaneado: false, template: false, razonCalidad: null };
  const pages = meta.pages || 0;
  const ratio = pages > 0 ? text.length / pages : text.length;
  if (pages >= 10 && ratio < 50) {
    flags.escaneado = true;
    flags.razonCalidad = `PDF escaneado (${pages} págs, ~${Math.round(ratio)} chars/pág) — requiere OCR`;
    return flags;
  }
  const tlow = text.toLowerCase();
  const hasPlaceholder =
    tlow.includes("[consignar nomenclatura del procedimiento") ||
    tlow.includes("[consignar aquí") ||
    tlow.includes("[consignar el monto") ||
    tlow.includes("bases estándar licitación pública abreviada");
  const hasSpec = /experiencia[^.]{0,150}(no\s*menor\s*a|equivalente\s*a)\s*s\s*\/\s*\.?\s*\d{3,}/i.test(text);
  if (hasPlaceholder && !hasSpec) {
    flags.template = true;
    flags.razonCalidad = "Bases Estándar sin montos rellenos (etapa temprana)";
  }
  return flags;
}

/**
 * PIPELINE HTTP COMPLETO.
 */
export async function runObraPipelineHttp({
  empresa,
  filters = {},
  limit = 30,
  concurrency = 5,
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
    console.log(`[${step}] ${data.msg || ""}`);
  };

  cleanDownloadsDir();

  emit("start", { msg: "HTTP pipeline" });

  // 1+2+3. BOOTSTRAP BATCH-POR-PAGINA: pagina + HTTP fetch cronograma de cada pag ANTES de seguir
  const cronogramaByNid = new Map(); // nidProceso -> { cronograma, fechaPresentacion }
  const allListado = [];
  let processedCount = 0;

  await bootstrapBatchByPage({
    filters: {
      objetoContratacion: filters.objetoContratacion || "Obra",
      fechaDesde: filters.fechaDesde,
      fechaHasta: filters.fechaHasta,
    },
    maxPages: 50,
    onPageRows: async (rowsOfThisPage, session, pageIdx) => {
      // pre-filtros heurísticos antes de gastar HTTP
      const validas = rowsOfThisPage.filter((r) => {
        if (!r.buttonId || !r.nidProceso) return false;
        if (probablementeVencido(r, { maxPubDias })) return false;
        if (fueraDeCapacidad(r, empresa, { maxMontoRatio })) return false;
        return true;
      });

      allListado.push(...validas);

      // si excedimos limit, no procesamos más HTTP
      if (processedCount >= limit) return;

      const slice = validas.slice(0, Math.max(0, limit - processedCount));
      processedCount += slice.length;

      // HTTP fetch cronograma en paralelo (conc 5)
      const lim = pLimit(concurrency);
      await Promise.all(
        slice.map((r) =>
          lim(async () => {
            try {
              const result = await fetchCronogramaHttp({
                nomenclatura: r.nomenclatura,
                nidProceso: r.nidProceso,
                nidConvocatoria: r.nidConvocatoria,
                buttonId: r.buttonId,
              });
              if (!result._error) {
                cronogramaByNid.set(r.nidProceso, result);
              }
            } catch (e) {
              console.warn(`[cronograma-http FAIL] ${r.nomenclatura}: ${e.message}`);
            }
          })
        )
      );
      emit("page_done", { msg: `página ${pageIdx + 1}: ${slice.length} cronogramas HTTP procesados` });
    },
  });

  emit("listado_done", { msg: `${allListado.length} pasaron pre-filtro, ${cronogramaByNid.size} cronogramas OK` });

  // 4. FILTRO TIEMPO SUFICIENTE
  const conTiempo = allListado.filter((r) => {
    const c = cronogramaByNid.get(r.nidProceso);
    if (!c) return false;
    return tieneTiempoSuficiente({ fechaPresentacion: c.fechaPresentacion }, { minDias });
  });
  emit("filtro_tiempo", { msg: `${conTiempo.length} con >= ${minDias}d para presentación` });

  // 5. DETALLE COMPLETO HTTP + DESCARGA via Playwright (solo descarga PDF necesita browser)
  const detallados = [];
  const lim = pLimit(concurrency);

  // 5a. Detalle HTTP en paralelo (rápido — ~2s c/u)
  await Promise.all(
    conTiempo.map((r) =>
      lim(async () => {
        try {
          const detalle = await fetchDetalleHttp({
            nomenclatura: r.nomenclatura,
            nidProceso: r.nidProceso,
            nidConvocatoria: r.nidConvocatoria,
            buttonId: r.buttonId,
          });
          if (!detalle._error) {
            detallados.push({ listado: r, detalle, descarga: null, docSelected: null });
          } else {
            detallados.push({ listado: r, detalle: null, descarga: null, error: detalle._error });
          }
        } catch (e) {
          detallados.push({ listado: r, detalle: null, descarga: null, error: e.message });
        }
      })
    )
  );

  emit("detalle_http_done", { msg: `${detallados.filter((d) => d.detalle).length} detalles HTTP OK` });

  // 5b. DESCARGAS via Playwright (download events son complejos en HTTP, mantenemos browser)
  if (!skipPdf) {
    const seenDocs = new Map();
    const detalleConDescarga = pLimit(2); // browser sequential
    const conDetalle = detallados.filter((d) => d.detalle);

    await Promise.all(
      conDetalle.map((item) =>
        detalleConDescarga(async () => {
          try {
            const sel = selectBasesIntegradas(item.detalle.documentos);
            if (!sel.doc?.descargas?.length) {
              item.docSelected = sel;
              return;
            }
            // usar Playwright SOLO para descarga (download event)
            const { descarga, docSelected } = await scrapeDetalleConDescarga({
              nomenclatura: item.listado.nomenclatura,
              nidProceso: item.listado.nidProceso,
              nidConvocatoria: item.listado.nidConvocatoria,
              filters: {
                objetoContratacion: filters.objetoContratacion || "Obra",
                fechaDesde: filters.fechaDesde,
                fechaHasta: filters.fechaHasta,
                maxDocMB,
              },
              downloadBases: true,
              seenDocs,
            });
            item.descarga = descarga;
            item.docSelected = docSelected;
          } catch (e) {
            console.warn(`[descarga FAIL] ${item.listado.nomenclatura}: ${e.message}`);
          }
        })
      )
    );

    emit("descarga_done", {
      msg: `${detallados.filter((d) => d.descarga).length} descargas OK (Playwright)`,
    });
  }

  // 6. ANÁLISIS LLM (igual que orchestrator clásico, simplificado)
  const enriquecidos = [];
  for (const item of detallados.filter((d) => d.detalle)) {
    const { listado: p, detalle, descarga, docSelected } = item;
    const analisis = {
      documentoUsado: null,
      textoExtraido: false,
      requisitos: null,
      evaluacion: null,
      warnings: [],
      calidadTexto: null,
    };

    if (skipPdf || !descarga || !docSelected?.doc) {
      analisis.evaluacion = {
        resultado: "indeterminado",
        razones: [skipPdf ? "skipPdf=true" : "Sin Bases descargables"],
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

    // cache hash
    const docHash = hashBuffer(descarga.buffer);
    analisis.docHash = docHash;
    const cached = await getByHash(docHash);
    if (cached) {
      console.log(`[cache] hit ${docHash.slice(0, 8)} ${p.nomenclatura}`);
      analisis.cacheHit = true;
      analisis.requisitos = cached.requisitos;
      analisis.calidadTexto = cached.calidadTexto;
      const vr = detalle.vrCuantiaMonto || p.vrCuantia;
      const cs = detectarMontoAbsurdo(cached.requisitos?.experienciaMonto, vr);
      if (cs) {
        analisis.evaluacion = { resultado: "indeterminado", razones: [`cache + sospecha: ${cs}`] };
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
        analisis.evaluacion.razones.unshift(`cache hit (${docHash.slice(0, 8)})`);
      } else {
        analisis.evaluacion = cached.evaluacion || { resultado: "indeterminado", razones: ["cache: sin requisitos"] };
      }
      enriquecidos.push({ listado: p, detalle, analisis });
      continue;
    }

    try {
      const doc = await extractTextFromDoc(descarga);
      if (doc.errors.length) analisis.warnings.push(...doc.errors.map((e) => `${e.name}: ${e.error}`));
      analisis.calidadTexto = analizarCalidadTexto(doc.text, doc.meta || {});
      analisis.textoExtraido = doc.text.length > 100;

      if (!analisis.textoExtraido || analisis.calidadTexto.escaneado) {
        const razon = analisis.calidadTexto.razonCalidad || `Sin texto extraíble del ${doc.source}`;
        // si escaneado y LLM, intentar OCR via LLM
        if (analisis.calidadTexto.escaneado && useLlm && descarga.tipo === "pdf") {
          try {
            const provider = pickLlmProvider({ tipo: "pdf", escaneado: true, pageCount: doc.meta?.pages, llmProvider });
            console.log(`[llm-${provider}-ocr] ${p.nomenclatura}`);
            const llm = provider === "gemini"
              ? await extractRequisitosWithGeminiPdf(descarga.buffer, { valorReferencial: detalle.vrCuantiaMonto || p.vrCuantia, filename: descarga.filename })
              : await extractRequisitosWithClaudePdf(descarga.buffer, { valorReferencial: detalle.vrCuantiaMonto || p.vrCuantia, filename: descarga.filename });
            analisis.requisitos = mapLlmToRequisitos(llm, { fuente: `${provider}-pdf-ocr` });
            analisis.llmUsed = { via: `${provider}-pdf-ocr`, provider, ...llm.meta };
            if (llm.esBasesIntegradas && llm.confianza >= 0.5 && llm.experienciaMonto != null) {
              analisis.evaluacion = evaluarProceso(
                { experienciaMonto: llm.experienciaMonto, tiposObraSimilar: llm.tiposObraSimilar, antiguedadMaxAnios: llm.antiguedadMaxAnios },
                empresa, { consorcioRatio: 0.5 }
              );
              analisis.evaluacion.razones.unshift(`Extracción ${provider} OCR (conf ${llm.confianza.toFixed(2)})`);
            } else {
              analisis.evaluacion = { resultado: "indeterminado", razones: [`${provider} OCR: confianza ${llm.confianza.toFixed(2)} ${llm.notas || ""}`] };
            }
          } catch (e) {
            analisis.evaluacion = { resultado: "indeterminado", razones: [razon, `OCR error: ${e.message}`] };
          }
        } else {
          analisis.evaluacion = { resultado: "indeterminado", razones: [razon] };
        }
        enriquecidos.push({ listado: p, detalle, analisis });
        continue;
      }

      const requisitos = analizarRequisitos(doc.text, { valorReferencial: detalle.vrCuantiaMonto || p.vrCuantia });
      const sospecha = detectarMontoAbsurdo(requisitos.experienciaMonto, detalle.vrCuantiaMonto || p.vrCuantia);

      analisis.requisitos = {
        experienciaMonto: requisitos.experienciaMonto,
        experienciaConfianza: sospecha ? Math.min(requisitos.experienciaConfianza, 0.3) : requisitos.experienciaConfianza,
        experienciaHits: requisitos.experienciaHits.map((h) => ({ tipo: h.tipo, monto: h.monto, veces: h.veces, cantidad: h.cantidad, unidad: h.unidad, patternId: h.patternId, confianza: h.confianza, fragmento: h.fragmento })),
        tipoObra: requisitos.tiposObraSimilar.join("|"),
        antiguedadMaxAnios: requisitos.antiguedadMaxAnios,
        requiereLlm: requisitos.requiereLlm || sospecha != null,
        sospecha,
        paginas: doc.meta?.pages || null,
        fuente: doc.source,
      };

      const regexFallo = requisitos.experienciaMonto == null;
      const esTemplate = analisis.calidadTexto.template;
      const debeLlm = useLlm && (regexFallo || sospecha != null || esTemplate || requisitos.experienciaConfianza < 0.7);

      if (debeLlm) {
        try {
          const provider = pickLlmProvider({ tipo: "text", textLength: doc.text.length, llmProvider });
          console.log(`[llm-${provider}-text] ${p.nomenclatura}`);
          const vr = detalle.vrCuantiaMonto || p.vrCuantia;
          const llm = provider === "gemini"
            ? await extractRequisitosWithGeminiText(doc.text, { valorReferencial: vr })
            : await extractRequisitosWithClaudeText(doc.text, { valorReferencial: vr });
          analisis.llmUsed = { via: `${provider}-text`, provider, ...llm.meta, citas: llm.citas, notas: llm.notas };

          if (llm.experienciaMonto != null && (regexFallo || llm.confianza > requisitos.experienciaConfianza)) {
            analisis.requisitos = mapLlmToRequisitos(llm, { fuente: `${provider}-text` });
            if (llm.esBasesIntegradas && llm.confianza >= 0.5) {
              analisis.evaluacion = evaluarProceso(
                { experienciaMonto: llm.experienciaMonto, tiposObraSimilar: llm.tiposObraSimilar, antiguedadMaxAnios: llm.antiguedadMaxAnios },
                empresa, { consorcioRatio: 0.5 }
              );
              analisis.evaluacion.razones.unshift(`Extracción ${provider} (conf ${llm.confianza.toFixed(2)})`);
            } else {
              analisis.evaluacion = { resultado: "indeterminado", razones: [`${provider} confianza ${llm.confianza.toFixed(2)}`] };
            }
          } else if (esTemplate) {
            analisis.evaluacion = { resultado: "indeterminado", razones: [analisis.calidadTexto.razonCalidad] };
          } else if (sospecha) {
            analisis.evaluacion = { resultado: "indeterminado", razones: [`Sospecha: ${sospecha}`] };
          } else {
            analisis.evaluacion = { resultado: "indeterminado", razones: ["Ni regex ni LLM"] };
          }
        } catch (e) {
          analisis.warnings.push(`llm error: ${e.message}`);
          if (esTemplate) analisis.evaluacion = { resultado: "indeterminado", razones: [analisis.calidadTexto.razonCalidad] };
          else if (sospecha) analisis.evaluacion = { resultado: "indeterminado", razones: [`Sospecha: ${sospecha}`] };
          else analisis.evaluacion = evaluarProceso(requisitos, empresa, { consorcioRatio: 0.5 });
        }
      } else if (esTemplate) {
        analisis.evaluacion = { resultado: "indeterminado", razones: [analisis.calidadTexto.razonCalidad] };
      } else if (sospecha) {
        analisis.evaluacion = { resultado: "indeterminado", razones: [`Sospecha: ${sospecha}`] };
      } else {
        analisis.evaluacion = evaluarProceso(requisitos, empresa, { consorcioRatio: 0.5 });
      }

      // cache save
      if (analisis.requisitos || analisis.calidadTexto) {
        await setByHash(docHash, {
          requisitos: analisis.requisitos,
          calidadTexto: analisis.calidadTexto,
          evaluacion: analisis.evaluacion,
        }, { filename: descarga.filename, size: descarga.size }).catch(() => {});
      }
    } catch (e) {
      analisis.evaluacion = { resultado: "indeterminado", razones: [`error: ${e.message}`] };
    }

    enriquecidos.push({ listado: p, detalle, analisis });
  }

  const cstats = await hashCacheStats();
  emit("cache_stats", { msg: `cache: ${cstats.entries} entries, ${cstats.totalHits} hits` });

  // 7. BUILD OUTPUT con score y sort
  const procesos = enriquecidos
    .map(({ listado: p, detalle, analisis }) => {
      const descripcionFull = detalle?.descripcion || p.descripcion || "";
      const proceso = {
        nomenclatura: p.nomenclatura,
        entidad: detalle?.entidad || p.entidad,
        descripcionCorta: descripcionFull.slice(0, 120),
        descripcion: descripcionFull,
        id: p.nidProceso,
        nidConvocatoria: p.nidConvocatoria,
        objeto: detalle?.objeto || p.objetoContratacion,
        valorReferencial: detalle?.vrCuantiaMonto ?? p.vrCuantia ?? null,
        moneda: p.moneda || "PEN",
        fechaPublicacion: detalle?.fechaPublicacion || p.fechaPublicacion,
        fechaPropuesta: detalle?.fechaPresentacion?.finIso || detalle?.fechaPresentacion?.fin || null,
        diasRestantes: detalle?.fechaPresentacion?.diasRestantes ?? null,
        estado: detalle?.fechaPresentacion?.estado,
        cronograma: detalle?.cronograma,
        documentoUsado: analisis.documentoUsado,
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
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const resumen = {
    totalListados: allListado.length,
    limit,
    cronogramasLeidos: cronogramaByNid.size,
    conTiempoSuficiente: conTiempo.length,
    detalleCompleto: detallados.filter((d) => d.detalle).length,
    califican: procesos.filter((p) => p.evaluacion.resultado === "califica").length,
    consorcio: procesos.filter((p) => p.evaluacion.resultado === "consorcio").length,
    noCalifican: procesos.filter((p) => p.evaluacion.resultado === "no_califica").length,
    indeterminados: procesos.filter((p) => p.evaluacion.resultado === "indeterminado").length,
    escaneados: procesos.filter((p) => p.calidadTexto?.escaneado).length,
    templates: procesos.filter((p) => p.calidadTexto?.template).length,
    llmUsed: procesos.filter((p) => p.llmUsed).length,
    llmEnabled: useLlm,
    cacheHashHits: enriquecidos.filter((e) => e.analisis.cacheHit).length,
    cacheStats: cstats,
    parametros: { minDias, maxMontoRatio, maxPubDias, maxDocMB },
    duracionMs: Date.now() - runStart,
    pipelineMode: "http",
  };

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
