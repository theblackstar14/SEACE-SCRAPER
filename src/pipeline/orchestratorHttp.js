/**
 * Pipeline HTTP-first. Usa Playwright SOLO para el bootstrap
 * (1× navegación + paginación del listado, para capturar cookies + ViewState).
 * Detalle, cronograma, parseo y descargas van por HTTP directo.
 *
 * Speedup esperado vs Playwright-only:
 *   - 300 procesos: 2h 16min -> ~10 min
 */

import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import { bootstrapBatchByPage } from "../scraper/bootstrapHttp.js";
import { fetchDetalleHttp } from "../scraper/fichaHttp.js";
import { descargarDocHttp } from "../scraper/descargaHttp.js";
import { parseSeaceDate } from "../scraper/cronograma.js";
import { selectBasesIntegradas, parseSizeMB } from "../scraper/documentos.js";
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
import {
  fingerprintDoc,
  esIntegrada,
  diasHastaIntegracion,
  reconciliar,
  getEstado,
  saveEstados,
  purgarVencidos,
} from "../store/procesoState.js";

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

  // 1+2+3. BOOTSTRAP BATCH-POR-PAGINA: pagina + HTTP fetch de cada pag ANTES de seguir.
  //
  // Un solo POST por proceso: fetchCronogramaHttp y fetchDetalleHttp hacían
  // EL MISMO postFichaForm y solo diferían en el parseo. Traemos el detalle
  // completo acá, donde el buttonId todavía es válido (deja de serlo apenas
  // paginamos), y el cronograma sale del mismo HTML.
  const detalleByNid = new Map(); // nidProceso -> detalle completo
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

      const slice = validas.slice(0, Math.max(0, limit - processedCount));
      processedCount += slice.length;

      // HTTP fetch detalle completo en paralelo
      const lim = pLimit(concurrency);
      await Promise.all(
        slice.map((r) =>
          lim(async () => {
            try {
              const detalle = await fetchDetalleHttp({
                nomenclatura: r.nomenclatura,
                nidProceso: r.nidProceso,
                nidConvocatoria: r.nidConvocatoria,
                buttonId: r.buttonId,
              });
              if (!detalle._error) {
                detalleByNid.set(r.nidProceso, detalle);
              }
            } catch (e) {
              console.warn(`[detalle-http FAIL] ${r.nomenclatura}: ${e.message}`);
            }
          })
        )
      );
      emit("page_done", { msg: `página ${pageIdx + 1}: ${slice.length} detalles HTTP procesados` });

      // ya juntamos lo pedido — paginar más no aporta nada
      if (processedCount >= limit) return "stop";
    },
  });

  emit("listado_done", { msg: `${allListado.length} pasaron pre-filtro, ${detalleByNid.size} detalles OK` });

  // 4. FILTRO TIEMPO SUFICIENTE (+ selección de doc y estado previo).
  //
  // La selección del documento se hace ACÁ y no en la descarga porque su
  // huella es lo que decide si hay que bajar algo: comparada contra el run
  // anterior dice "el doc es el mismo" sin gastar un byte.
  const detallados = [];
  for (const r of allListado) {
    const detalle = detalleByNid.get(r.nidProceso);
    if (!detalle) continue;
    if (!tieneTiempoSuficiente(detalle, { minDias })) continue;
    const docSelected = selectBasesIntegradas(detalle.documentos);
    detallados.push({
      listado: r,
      detalle,
      descarga: null,
      docSelected,
      docFingerprint: fingerprintDoc(docSelected),
      prevEstado: await getEstado(r.nidProceso),
    });
  }
  emit("filtro_tiempo", { msg: `${detallados.length} con >= ${minDias}d para presentación` });

  // 5b. DESCARGAS directas a Alfresco (sin Playwright).
  //
  // El uuid del onclick `descargaDocGeneral(uuid,...)` ya viene en el HTML de
  // ficha que bajamos en el paso 1-3. Resolverlo es un GET a alfprod.seace,
  // otro host sin ViewState ni cookies — así que no hay que re-navegar la
  // ficha. Antes cada descarga costaba un navigateToFicha completo
  // (openBuscador + findRow paginando hasta 35 páginas) = 33-60s por proceso
  // solo para volver a una página que ya habíamos leído.
  if (!skipPdf) {
    const seenDocs = new Map();
    // ponytail: 2 fijo, no `concurrency`. Medido con 5 en paralelo: un PDF de
    // 2.2MB que solo tarda 2s pasó a 112s, y un ZIP de 44MB murió con
    // "terminated". Alfresco estrangula o corta. Subir esto si alguna vez
    // deja de ser el caso — con 2 no se observó ninguna degradación.
    const lim = pLimit(2);
    let dlCounter = 0;

    await Promise.all(
      detallados.map((item) =>
        lim(async () => {
          const nom = item.listado.nomenclatura;
          const sel = item.docSelected;
          const target = sel.doc?.descargas?.[0];
          if (!target) return;

          // ¿Cambió el documento desde el run anterior? La huella sale de la
          // ficha (que ya tenemos), así que esto se decide sin bajar nada.
          // Mismo doc + análisis todavía en el cache por hash = no hay nada
          // que hacer. En un cron nocturno esto es la mayoría de los procesos.
          const prev = item.prevEstado;
          if (prev?.docHash && prev.docFingerprint === item.docFingerprint) {
            if (await getByHash(prev.docHash)) {
              console.log(`[sin cambios] ${nom}: misma huella de doc, reuso análisis`);
              item.reusoHash = prev.docHash;
              return;
            }
          }

          const dedupKey = `${target.filename}|${sel.doc.sizeText || ""}`;
          if (seenDocs.has(dedupKey)) {
            console.log(`[dedup HIT] ${nom}: ${target.filename}`);
            item.descarga = { ...seenDocs.get(dedupKey), _deduped: true };
            return;
          }

          const sizeMB = parseSizeMB(sel.doc.sizeText);
          if (sizeMB && sizeMB > maxDocMB) {
            console.warn(`[descarga SKIP] ${nom}: ${target.filename} ${sizeMB.toFixed(1)}MB > ${maxDocMB}MB`);
            sel.skipped = true;
            sel.skipReason = `archivo ${sizeMB.toFixed(1)}MB > ${maxDocMB}MB`;
            return;
          }

          try {
            const t0 = Date.now();
            const d = await descargarDocHttp(target.hash, target.filename, { counter: ++dlCounter });
            console.log(`[descarga] ${nom}: ${d.filename} ${Math.round(d.size / 1024)}KB en ${Date.now() - t0}ms`);
            item.descarga = d;
            seenDocs.set(dedupKey, d);
          } catch (e) {
            console.warn(`[descarga FAIL] ${nom}: ${e.message}`);
          }
        })
      )
    );

    emit("descarga_done", {
      msg: `${detallados.filter((d) => d.descarga).length} descargas OK (HTTP directo)`,
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

    if (skipPdf || (!descarga && !item.reusoHash) || !docSelected?.doc) {
      // "Sin Bases descargables" solo si DE VERDAD no hay. Si lo saltamos
      // nosotros (maxDocMB) o falló la descarga, decirlo: el doc existe y
      // alguien puede bajarlo a mano. Reportar lo contrario hace que el
      // gerente descarte un proceso que sí es viable.
      const razon = skipPdf
        ? "skipPdf=true"
        : docSelected?.skipReason
          ? `Bases NO analizadas: ${docSelected.skipReason} — descargar manualmente`
          : docSelected?.doc
            ? "Bases publicadas pero la descarga falló — reintentar"
            : "Sin Bases descargables";
      analisis.evaluacion = { resultado: "indeterminado", razones: [razon] };
      enriquecidos.push({ listado: p, detalle, analisis });
      continue;
    }

    analisis.documentoUsado = {
      etapa: docSelected.doc.etapa,
      documento: docSelected.doc.documento,
      filename: descarga?.filename || docSelected.doc.descargas?.[0]?.filename || null,
      tipo: descarga?.tipo || null,
      size: descarga?.size ?? null,
      confianza: docSelected.confianza,
    };

    // cache hash. Sin descarga (doc sin cambios) usamos el hash del run
    // anterior: el bloque de cache de abajo hace el resto.
    const docHash = descarga ? hashBuffer(descarga.buffer) : item.reusoHash;
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

    // Salto reusoHash sin entrada en cache: el TTL venció entre el paso 5b y
    // acá. No hay buffer que analizar. Raro, pero no vale un crash.
    if (!descarga) {
      analisis.evaluacion = {
        resultado: "indeterminado",
        razones: ["reuso de análisis previo pero el cache expiró — se reanaliza en el próximo run"],
      };
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
        // Tabla de documentos de la ficha. Solo bajamos uno (las Bases), pero
        // el uuid de Alfresco de los demás vale guardarlo: con eso el ERP los
        // puede pedir en vivo sin que nadie vuelva a scrapear la ficha.
        documentos: (detalle?.documentos || []).map((d) => ({
          nro: d.nro,
          etapa: d.etapa,
          documento: d.documento,
          fecha: d.fecha,
          sizeText: d.sizeText,
          // `hash` del parser es el uuid de Alfresco, no un sha256. Se renombra
          // acá para que no se confunda con el hash de contenido del disco.
          descargas: (d.descargas || []).map((x) => ({
            uuid: x.hash,
            filename: x.filename,
            tipo: x.tipo,
          })),
        })),
        documentoUsado: analisis.documentoUsado,
        docHash: analisis.docHash || null,
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

  // 8. ESTADO POR PROCESO: ¿qué cambió desde ayer?
  //
  // Sin esto el run nocturno produce la misma lista todas las noches y nadie
  // la mira. Lo único que de verdad pide atención es la aparición de las
  // Bases Integradas (los montos reales), y eso solo se ve comparando contra
  // el run anterior.
  const itemByNid = new Map(detallados.map((i) => [i.listado.nidProceso, i]));
  const nowIso = new Date().toISOString();
  const estados = procesos.map((p) => {
    const item = itemByNid.get(p.id);
    const est = reconciliar(
      item?.prevEstado || null,
      {
        nidProceso: p.id,
        nomenclatura: p.nomenclatura,
        entidad: p.entidad,
        valorReferencial: p.valorReferencial,
        fechaPropuesta: p.fechaPropuesta,
        diasRestantes: p.diasRestantes,
        resultado: p.evaluacion.resultado,
        score: p.score,
        docFingerprint: item?.docFingerprint || null,
        integrada: esIntegrada(item?.docSelected),
        docEtapa: item?.docSelected?.doc?.etapa || null,
        docHash: p.docHash,
        diasHastaIntegracion: diasHastaIntegracion(p.cronograma),
      },
      { minDias, nowIso }
    );
    p.novedad = est.novedad;
    p.revisar = est.revisar;
    p.revisarTipo = est.revisarTipo;
    p.motivo = est.motivo;
    return est;
  });
  await saveEstados(estados);
  const purgados = await purgarVencidos();

  // lo que hay que mirar primero va primero; dentro de eso las oportunidades
  // antes que lo que solo pide lectura humana, y recién después por score.
  const prio = (p) => (p.revisar ? (p.revisarTipo === "oportunidad" ? 2 : 1) : 0);
  procesos.sort((a, b) => prio(b) - prio(a) || (b.score || 0) - (a.score || 0));

  const alertas = procesos
    .filter((p) => p.revisar)
    .map((p) => ({
      nomenclatura: p.nomenclatura,
      entidad: p.entidad,
      novedad: p.novedad,
      revisarTipo: p.revisarTipo,
      motivo: p.motivo,
      diasRestantes: p.diasRestantes,
      score: p.score,
    }));
  emit("estado_done", {
    msg:
      `${alertas.filter((a) => a.revisarTipo === "oportunidad").length} oportunidades, ` +
      `${alertas.filter((a) => a.revisarTipo === "manual").length} a revisar a mano, ` +
      `${estados.filter((e) => e.novedad === "nuevo").length} nuevos, ${purgados} vencidos purgados`,
  });

  const resumen = {
    totalListados: allListado.length,
    limit,
    detallesLeidos: detalleByNid.size,
    conTiempoSuficiente: detallados.length,
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
    nuevos: estados.filter((e) => e.novedad === "nuevo").length,
    aRevisar: alertas.length,
    sinCambios: detallados.filter((d) => d.reusoHash).length,
    cacheStats: cstats,
    parametros: { minDias, maxMontoRatio, maxPubDias, maxDocMB },
    duracionMs: Date.now() - runStart,
    pipelineMode: "http",
  };

  // buffers para upload a Storage si requerido
  const buffers = new Map();
  for (const item of detallados) {
    if (item.descarga?.buffer && item.listado?.nidProceso) {
      buffers.set(item.listado.nidProceso, {
        buffer: item.descarga.buffer,
        filename: item.descarga.filename,
        tipo: item.descarga.tipo,
        size: item.descarga.size,
      });
    }
  }

  cleanDownloadsDir();
  emit("done", { msg: JSON.stringify(resumen) });

  return {
    runAt: new Date().toISOString(),
    filters,
    empresa: { razonSocial: empresa.razonSocial, ruc: empresa.ruc },
    resumen,
    alertas,
    procesos,
    _buffers: buffers,
  };
}
