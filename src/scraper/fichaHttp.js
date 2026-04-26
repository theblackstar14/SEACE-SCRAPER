/**
 * Fetch HTTP directo de ficha SEACE (post-bootstrap).
 *
 * Replica el POST que hace el navegador cuando clickeas "Ficha Selección":
 *   PrimeFaces.addSubmitParam('tbBuscador:idFormBuscarProceso',{
 *     ntipo:'1', '<buttonId>':'<buttonId>',
 *     nidConvocatoria, nidProceso, nidSistema:'3', ptoRetorno:'LOCAL'
 *   }).submit('tbBuscador:idFormBuscarProceso');
 *
 * Body params: ViewState + form fields + button ID + nidProceso/nidConvocatoria.
 * Response: HTML completo de la ficha.
 */

import * as cheerio from "cheerio";
import { getSession } from "./httpClient.js";
import { extractCronograma, findFechaPresentacion } from "./cronograma.js";
import { extractDocumentos } from "./documentos.js";
import { parseMonto } from "./parser.js";

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const normKey = (s) =>
  norm(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w ]/g, "")
    .trim();

function fieldByLabels($, labels) {
  const targets = labels.map(normKey);
  let val = "";
  $("td").each((_, el) => {
    const k = normKey($(el).text());
    if (targets.includes(k)) {
      val = norm($(el).next().text());
      if (val) return false;
    }
  });
  return val;
}

/**
 * Hace POST JSF a la URL del buscador con params para abrir ficha.
 *
 * @returns {Promise<{ html: string, redirected: boolean, status: number }>}
 */
export async function postFichaForm({ buttonId, nidProceso, nidConvocatoria, nidSistema = "3" }) {
  const session = getSession();
  if (!buttonId) throw new Error("buttonId requerido para postFichaForm");
  if (!nidProceso || !nidConvocatoria) throw new Error("nidProceso + nidConvocatoria requeridos");

  // construir form params como en el navegador
  const formId = "tbBuscador:idFormBuscarProceso";
  const params = {
    [formId]: formId, // form param principal
    [buttonId]: buttonId, // submit button param (key = value)
    ntipo: "1",
    nidConvocatoria,
    nidProceso,
    nidSistema,
    ptoRetorno: "LOCAL",
  };

  const t0 = Date.now();
  const { html, status, headers } = await session.postForm(params);

  return {
    html,
    status,
    elapsedMs: Date.now() - t0,
    headers,
  };
}

/**
 * Parsea HTML de ficha y devuelve struct igual que scrapeDetalle (Playwright).
 */
export function parseFichaHtml(html, { nomenclatura, nidProceso } = {}) {
  const $ = cheerio.load(html);

  // sanity check: ¿se ve como ficha?
  const hasFicha = $("td:contains('Entidad Convocante')").length > 0 ||
                   $("td:contains('Nomenclatura')").length > 0;
  if (!hasFicha) {
    return { _error: "no es una ficha de proceso", _htmlSize: html.length };
  }

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
 * Versión LIGERA: solo cronograma. Mismo POST + parseo simplificado.
 */
export async function fetchCronogramaHttp({ nomenclatura, nidProceso, nidConvocatoria, buttonId }) {
  const t0 = Date.now();
  const { html, status, elapsedMs } = await postFichaForm({
    buttonId,
    nidProceso,
    nidConvocatoria,
  });

  const $ = cheerio.load(html);
  const cronograma = extractCronograma($);
  const fechaPresentacion = findFechaPresentacion(cronograma);

  console.log(
    `[cronograma-http] ${nomenclatura || nidProceso} en ${elapsedMs}ms (status=${status}) — ` +
      `presentación: ${fechaPresentacion?.estado || "?"} (${fechaPresentacion?.fin || "s/f"})`
  );

  if (!cronograma.length) {
    return {
      _error: "cronograma vacío en respuesta HTTP",
      _htmlSize: html.length,
      cronograma: [],
      fechaPresentacion: { estado: "sin_fecha", inicio: null, fin: null },
    };
  }

  return { cronograma, fechaPresentacion };
}

/**
 * Versión COMPLETA: ficha entera + documentos.
 */
export async function fetchDetalleHttp({ nomenclatura, nidProceso, nidConvocatoria, buttonId }) {
  const { html, status, elapsedMs } = await postFichaForm({
    buttonId,
    nidProceso,
    nidConvocatoria,
  });

  const detalle = parseFichaHtml(html, { nomenclatura, nidProceso });
  detalle._httpStatus = status;
  detalle._httpElapsedMs = elapsedMs;
  detalle._htmlSize = html.length;

  console.log(
    `[detalle-http] ${nomenclatura || nidProceso} en ${elapsedMs}ms — ` +
      `presentación: ${detalle.fechaPresentacion?.estado || "?"} (${detalle.fechaPresentacion?.fin || "s/f"})`
  );

  return detalle;
}
