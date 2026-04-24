import { withPage } from "../browserPool.js";
import { navigateToFicha } from "./common.js";
import { T } from "./selectors.js";
import { extractCronograma, findFechaPresentacion } from "./cronograma.js";
import { extractDocumentos, selectBasesIntegradas } from "./documentos.js";
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

export async function scrapeDetalle({ nomenclatura, nidProceso, nidConvocatoria, filters }) {
  return withPage(async (page) => {
    const t0 = Date.now();
    await navigateToFicha(page, { nomenclatura, nidProceso, nidConvocatoria, filters });
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

/**
 * Parsea el HTML de una ficha ya abierta en `page` y retorna data estructurada.
 * Extraído de scrapeDetalle para reuso.
 */
async function parseFichaFromPage(page, { nomenclatura, nidProceso } = {}) {
  const html = await page.content();
  const $ = cheerio.load(html);

  const cronograma = extractCronograma($);
  const fechaPresentacion = findFechaPresentacion(cronograma);
  const documentos = extractDocumentos($);

  return {
    nomenclatura: fieldByLabels($, ["Nomenclatura"]) || nomenclatura,
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
    entidadContratanteRuc: fieldByLabels($, ["N° Ruc", "N Ruc"]),
    entidadContratanteNombre: fieldByLabels($, ["Entidad Contratante"]),

    cronograma,
    fechaPresentacion,
    documentos,
    _fichaTimestamp: new Date().toISOString(),
  };
}

/**
 * Descarga un documento específico de la ficha ya abierta (sin re-navegar).
 * Limpia el archivo temp de Playwright tras leer el buffer (evita llenar %TEMP%).
 */
async function downloadFromPage(page, filename) {
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
    el.evaluate((node) => node.click()), // click via DOM (imgs pueden estar bloqueadas)
  ]);

  const stream = await download.createReadStream();
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buffer = Buffer.concat(chunks);

  // limpiar temp de Playwright — evita saturar %TEMP% en runs largos
  await download.delete().catch(() => {});

  return {
    filename: download.suggestedFilename() || filename,
    buffer,
    size: buffer.length,
  };
}

/**
 * OPTIMIZACIÓN PRINCIPAL: Scrapea detalle Y descarga el doc best-match en UNA
 * sola navegación. Antes usábamos 2 openBuscador separados = ~60s wasted por
 * proceso. Ahora ~30s total.
 *
 * @param {object} opts
 *  - nomenclatura, nidProceso, nidConvocatoria, filters (igual que scrapeDetalle)
 *  - downloadBases: bool — si true, descarga Bases Integradas/Administrativas
 *
 * @returns { detalle, descarga, docSelected }
 *   - detalle: igual que scrapeDetalle
 *   - descarga: { filename, buffer, size, tipo } | null
 *   - docSelected: output de selectBasesIntegradas (para logs)
 */
export async function scrapeDetalleConDescarga({
  nomenclatura,
  nidProceso,
  nidConvocatoria,
  filters,
  downloadBases = false,
}) {
  return withPage(async (page) => {
    const t0 = Date.now();
    await navigateToFicha(page, { nomenclatura, nidProceso, nidConvocatoria, filters });

    const detalle = await parseFichaFromPage(page, { nomenclatura, nidProceso });
    console.log(
      `[scrapeDetalle] ${nomenclatura || nidProceso} en ${Date.now() - t0}ms — ` +
        `presentación: ${detalle.fechaPresentacion?.estado || "?"} (${detalle.fechaPresentacion?.fin || "s/f"})`
    );

    let descarga = null;
    let docSelected = null;

    if (downloadBases) {
      docSelected = selectBasesIntegradas(detalle.documentos);
      if (docSelected.doc && docSelected.doc.descargas.length) {
        const targetFilename = docSelected.doc.descargas[0].filename;
        try {
          const tDl = Date.now();
          descarga = await downloadFromPage(page, targetFilename);
          const tipo = (descarga.filename.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
          descarga.tipo = tipo;
          console.log(
            `[descarga] ${nomenclatura}: ${descarga.filename} ${Math.round(descarga.size / 1024)}KB en ${Date.now() - tDl}ms`
          );
        } catch (e) {
          console.warn(`[descarga FAIL] ${nomenclatura}: ${e.message}`);
        }
      }
    }

    return { detalle, descarga, docSelected };
  });
}

export async function descargarDoc({ nomenclatura, nidProceso, nidConvocatoria, filename, filters }) {
  return withPage(async (page) => {
    await navigateToFicha(page, { nomenclatura, nidProceso, nidConvocatoria, filters });

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
