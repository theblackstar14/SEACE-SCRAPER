import { withPage } from "../browserPool.js";
import { navigateToFicha } from "./common.js";
import { T } from "./selectors.js";
import { extractCronograma, findFechaPresentacion } from "./cronograma.js";
import { extractDocumentos } from "./documentos.js";
import { parseMonto } from "./parser.js";
import * as cheerio from "cheerio";

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const normKey = (s) =>
  norm(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // sin acentos
    .replace(/[^\w ]/g, "") // quitar `:`, `/`, etc.
    .trim();

/**
 * Busca la celda <td> siguiente a una celda cuyo texto matches label (con/sin acentos).
 * Prueba varias variantes.
 */
function fieldByLabels($, labels) {
  const targets = labels.map(normKey);
  let val = "";
  $("td").each((_, el) => {
    const k = normKey($(el).text());
    if (targets.includes(k)) {
      val = norm($(el).next().text());
      if (val) return false; // break
    }
  });
  return val;
}

export async function scrapeDetalle({ nomenclatura, nidProceso, filters }) {
  return withPage(async (page) => {
    const t0 = Date.now();
    await navigateToFicha(page, { nomenclatura, nidProceso, filters });
    const html = await page.content();
    const $ = cheerio.load(html);

    // labels reales confirmados SEACE 2026-04 (incluye typos/variantes)
    const cronograma = extractCronograma($);
    const fechaPresentacion = findFechaPresentacion(cronograma);
    const documentos = extractDocumentos($);

    const data = {
      nomenclatura: fieldByLabels($, ["Nomenclatura"]),
      nConvocatoria: fieldByLabels($, ["N° Convocatoria", "Nº Convocatoria", "N Convocatoria"]),
      tipoCompra: fieldByLabels($, ["Tipo Compra o Selección", "Tipo Compra o Seleccion"]),
      normativa: fieldByLabels($, ["Normativa Aplicable"]),
      versionSeace: fieldByLabels($, ["Versión SEACE", "Version SEACE"]),

      entidad: fieldByLabels($, ["Entidad Convocante"]),
      direccion: fieldByLabels($, ["Direccion Legal", "Dirección Legal"]),
      web: fieldByLabels($, ["Pagina Web", "Página Web"]),
      telefono: fieldByLabels($, [
        "Télefono de la Entidad",
        "Teléfono de la Entidad",
        "Telefono de la Entidad",
      ]),

      objeto: fieldByLabels($, ["Objeto de Contratación", "Objeto de Contratacion"]),
      descripcion: fieldByLabels($, [
        "Descripción del Objeto",
        "Descripcion del Objeto",
        "Descripción del objeto",
      ]),
      vrCuantia: fieldByLabels($, [
        "VR / VE / Cuantía de la contratación",
        "VR / VE / Cuantia de la contratacion",
      ]),
      vrCuantiaMonto: parseMonto(
        (fieldByLabels($, [
          "VR / VE / Cuantía de la contratación",
          "VR / VE / Cuantia de la contratacion",
        ]) || "").replace(/\s*Soles\s*$/i, "")
      ),
      montoDerecho: fieldByLabels($, [
        "Monto del Derecho de Participacion",
        "Monto del Derecho de Participación",
      ]),
      montoBases: fieldByLabels($, [
        "Monto del costo de Reproducción de las Bases",
        "Monto del costo de Reproduccion de las Bases",
      ]),
      fechaPublicacion: fieldByLabels($, [
        "Fecha y Hora Publicación",
        "Fecha y Hora Publicacion",
        "Fecha y hora de Publicación del reinicio",
      ]),
      reiniciadoDesde: fieldByLabels($, ["Reiniciado Desde"]),

      // Entidad Contratante (panel derecho inferior)
      entidadContratanteRuc: fieldByLabels($, ["N° Ruc", "N Ruc"]),
      entidadContratanteNombre: fieldByLabels($, ["Entidad Contratante"]),

      // estructurados
      cronograma,
      fechaPresentacion, // { inicio, fin, inicioISO, finISO, estado: 'activo'|'vencido'|'pendiente' }
      documentos,

      // flags derivados rápidos
      _fichaTimestamp: new Date().toISOString(),
    };

    console.log(
      `[scrapeDetalle] ${nomenclatura || nidProceso} en ${Date.now() - t0}ms — ` +
        `presentación: ${fechaPresentacion?.estado || "?"} (${fechaPresentacion?.fin || "s/f"})`
    );
    return data;
  });
}

export async function descargarDoc({ nomenclatura, nidProceso, filename, filters }) {
  return withPage(async (page) => {
    await navigateToFicha(page, { nomenclatura, nidProceso, filters });

    const dlAnchor = await page.evaluateHandle((fname) => {
      const anchors = document.querySelectorAll("a[onclick*='descargaDocGeneral']");
      for (const a of anchors) {
        if ((a.getAttribute("onclick") || "").includes(fname)) return a;
      }
      return null;
    }, filename);

    const el = dlAnchor.asElement();
    if (!el) throw new Error(`Archivo no encontrado en ficha: ${filename}`);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: T.download }),
      el.click(),
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const buffer = Buffer.concat(chunks);
    return {
      filename: download.suggestedFilename() || filename,
      buffer,
      size: buffer.length,
    };
  });
}
