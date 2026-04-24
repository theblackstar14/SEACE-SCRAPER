import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import { scrapeSeace } from "../scraper/seaceScraper.js";
import { scrapeDetalleConDescarga } from "../scraper/seaceDetalle.js";
import { isProcesoActivo } from "../scraper/cronograma.js";
import { extractTextFromDoc } from "../pdf/docExtractor.js";
import { analizarRequisitos } from "../analyzer/requisitos.js";
import { evaluarProceso } from "../analyzer/evaluator.js";

const DEBUG_DIR = "./data/debug/pdftext";

async function dumpText(nomenclatura, text, meta) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
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
} = {}) {
  const runStart = Date.now();
  const emit = (step, data) => {
    onProgress({ step, ...data });
    const log = `[${step}] ${data.msg || ""}`;
    console.log(log);
  };

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

      if (!analisis.textoExtraido || analisis.calidadTexto.escaneado) {
        analisis.evaluacion = {
          resultado: "indeterminado",
          razones: [
            analisis.calidadTexto.escaneado
              ? analisis.calidadTexto.razonCalidad
              : `No se pudo extraer texto del ${doc.source.toUpperCase()} (${descarga.filename})`,
          ],
        };
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

      // sanity check: si monto extraído ≈ VR, probable confusión
      const vr = detalle.vrCuantiaMonto || p.vrCuantia;
      let sospecha = null;
      if (requisitos.experienciaMonto && vr) {
        const diff = Math.abs(requisitos.experienciaMonto - vr) / vr;
        if (diff < 0.02) {
          sospecha = `monto extraído (${requisitos.experienciaMonto}) coincide con VR (${vr}) ±2% — probable falso positivo`;
          analisis.warnings.push(`sospecha: ${sospecha}`);
          // dump para auditoría
          const dumpFile = await dumpText(p.nomenclatura, doc.text, {
            source: doc.source,
            ...doc.meta,
          });
          if (dumpFile) analisis.warnings.push(`dump-sospecha: ${dumpFile}`);
        }
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

      // si es template sin montos, indicar razón clara
      if (analisis.calidadTexto.template && requisitos.experienciaMonto == null) {
        analisis.evaluacion = {
          resultado: "indeterminado",
          razones: [analisis.calidadTexto.razonCalidad],
        };
      } else if (sospecha) {
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
    calidadTexto: analisis.calidadTexto, // { escaneado, template, razonCalidad }
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
    duracionMs: Date.now() - runStart,
  };

  emit("done", { msg: JSON.stringify(resumen) });

  return {
    runAt: new Date().toISOString(),
    filters,
    empresa: { razonSocial: empresa.razonSocial, ruc: empresa.ruc },
    resumen,
    procesos,
  };
}
