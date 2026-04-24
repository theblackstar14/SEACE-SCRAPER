import pLimit from "p-limit";
import fs from "node:fs/promises";
import path from "node:path";
import { scrapeSeace } from "../scraper/seaceScraper.js";
import { scrapeDetalle } from "../scraper/seaceDetalle.js";
import { isProcesoActivo } from "../scraper/cronograma.js";
import { selectBasesIntegradas } from "../scraper/documentos.js";
import { downloadDocumento } from "../pdf/downloader.js";
import { extractTextFromDoc } from "../pdf/docExtractor.js";
import { analizarRequisitos } from "../analyzer/requisitos.js";
import { evaluarProceso } from "../analyzer/evaluator.js";

const DEBUG_DIR = "./data/debug/pdftext";

async function dumpText(nomenclatura, text, meta) {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
    const safe = nomenclatura.replace(/[^\w-]/g, "_").slice(0, 80);
    const file = path.join(DEBUG_DIR, `${safe}.txt`);
    const header = `// Nomenclatura: ${nomenclatura}\n// Source: ${meta.source}\n// Files: ${JSON.stringify(meta.files || [])}\n// Pages: ${meta.pages || "n/a"}\n// Length: ${text.length} chars\n\n`;
    await fs.writeFile(file, header + text, "utf8");
    return file;
  } catch (e) {
    return null;
  }
}

/**
 * Pipeline:
 *   listar → detalle → filtro activos → descargar doc → extraer PDF → analizar → evaluar → output
 *
 * @param {object} opts
 *   - empresa: objeto empresa (razonSocial, experiencia[], especialidades[])
 *   - filters: { fechaDesde, fechaHasta, objetoContratacion='Obra', allPages=true }
 *   - limit: top N procesos del listado a analizar (default 30)
 *   - concurrency: paralelismo de detalles (default 2)
 *   - onProgress: callback({ step, idx, total, msg })
 *   - skipPdf: bool — para debug rápido, saltar descarga/análisis PDF
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

  // 2. DETALLE + FILTRO ACTIVOS (concurrencia controlada)
  const lim = pLimit(concurrency);
  const detallesConEstado = await Promise.all(
    candidatos.map((p, idx) =>
      lim(async () => {
        try {
          emit("detalle", { idx, total: candidatos.length, msg: `${p.nomenclatura}` });
          const detalle = await scrapeDetalle({
            nomenclatura: p.nomenclatura,
            nidProceso: p.nidProceso,
            nidConvocatoria: p.nidConvocatoria,
            // filters solo se usan si nav-directa falla (raro)
            filters: {
              objetoContratacion: filters.objetoContratacion || "Obra",
              fechaDesde: filters.fechaDesde,
              fechaHasta: filters.fechaHasta,
            },
          });
          return { listado: p, detalle, error: null };
        } catch (e) {
          console.warn(`[detalle FAIL] ${p.nomenclatura}: ${e.message}`);
          return { listado: p, detalle: null, error: e.message };
        }
      })
    )
  );

  // filtro: solo activos
  const activos = detallesConEstado.filter(
    (d) => d.detalle && isProcesoActivo(d.detalle.cronograma)
  );
  emit("filtro_activos", {
    msg: `${activos.length} activos / ${detallesConEstado.length} detallados`,
  });

  // 3. PDF + ANÁLISIS (serial dentro de cada, paralelo entre procesos con concurrency)
  const enriquecidos = await Promise.all(
    activos.map((item, idx) =>
      lim(async () => {
        const { listado: p, detalle } = item;
        const analisis = {
          documentoUsado: null,
          textoExtraido: false,
          requisitos: null,
          evaluacion: null,
          warnings: [],
        };

        if (skipPdf) {
          analisis.evaluacion = {
            resultado: "indeterminado",
            razones: ["skipPdf=true — análisis de Bases omitido"],
          };
          return { listado: p, detalle, analisis };
        }

        try {
          emit("pdf", { idx, total: activos.length, msg: `${p.nomenclatura}` });

          const sel = selectBasesIntegradas(detalle.documentos);
          if (!sel.doc || !sel.doc.descargas.length) {
            analisis.warnings.push(`Sin documento utilizable: ${sel.razon}`);
            analisis.evaluacion = {
              resultado: "indeterminado",
              razones: ["No hay Bases Integradas ni Bases Administrativas descargables."],
            };
            return { listado: p, detalle, analisis };
          }

          analisis.documentoUsado = {
            etapa: sel.doc.etapa,
            documento: sel.doc.documento,
            filename: sel.doc.descargas[0].filename,
            tipo: sel.doc.descargas[0].tipo,
            confianza: sel.confianza,
          };

          const descarga = await downloadDocumento({
            nomenclatura: p.nomenclatura,
            nidProceso: p.nidProceso,
            nidConvocatoria: p.nidConvocatoria,
            filename: sel.doc.descargas[0].filename,
            filters: {
              objetoContratacion: filters.objetoContratacion || "Obra",
              fechaDesde: filters.fechaDesde,
              fechaHasta: filters.fechaHasta,
            },
          });

          const doc = await extractTextFromDoc(descarga);
          analisis.textoExtraido = doc.text.length > 100;
          if (doc.errors.length) analisis.warnings.push(...doc.errors.map((e) => `${e.name}: ${e.error}`));

          if (!analisis.textoExtraido) {
            analisis.evaluacion = {
              resultado: "indeterminado",
              razones: [
                `No se pudo extraer texto del ${doc.source.toUpperCase()} (${descarga.filename})`,
              ],
            };
            return { listado: p, detalle, analisis };
          }

          const requisitos = analizarRequisitos(doc.text, {
            valorReferencial: detalle.vrCuantiaMonto || p.vrCuantia,
          });

          // dump texto cuando regex no encuentra monto — para calibrar
          if (requisitos.experienciaMonto == null) {
            const dumpFile = await dumpText(p.nomenclatura, doc.text, doc.meta);
            if (dumpFile) analisis.warnings.push(`dump: ${dumpFile}`);
          }
          analisis.requisitos = {
            experienciaMonto: requisitos.experienciaMonto,
            experienciaConfianza: requisitos.experienciaConfianza,
            tipoObra: requisitos.tiposObraSimilar.join("|"),
            antiguedadMaxAnios: requisitos.antiguedadMaxAnios,
            requiereLlm: requisitos.requiereLlm,
            paginas: doc.meta?.pages || null,
            fuente: doc.source,
          };

          const evaluacion = evaluarProceso(requisitos, empresa, { consorcioRatio: 0.5 });
          analisis.evaluacion = evaluacion;
        } catch (e) {
          console.warn(`[pdf/análisis FAIL] ${p.nomenclatura}: ${e.message}`);
          analisis.warnings.push(`error pipeline: ${e.message}`);
          analisis.evaluacion = {
            resultado: "indeterminado",
            razones: [`Error en análisis: ${e.message}`],
          };
        }

        return { listado: p, detalle, analisis };
      })
    )
  );

  // 4. BUILD OUTPUT
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
    estado: detalle.fechaPresentacion?.estado === "activo" ? "activo" : detalle.fechaPresentacion?.estado,
    cronograma: detalle.cronograma,
    documentoUsado: analisis.documentoUsado,
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
    detallados: detallesConEstado.filter((d) => d.detalle).length,
    activos: activos.length,
    califican: procesos.filter((p) => p.evaluacion.resultado === "califica").length,
    consorcio: procesos.filter((p) => p.evaluacion.resultado === "consorcio").length,
    noCalifican: procesos.filter((p) => p.evaluacion.resultado === "no_califica").length,
    indeterminados: procesos.filter((p) => p.evaluacion.resultado === "indeterminado").length,
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
