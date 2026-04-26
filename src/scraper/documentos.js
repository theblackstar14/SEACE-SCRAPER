/**
 * Parser y selector de la tabla "Lista de Documentos" en ficha SEACE.
 *
 * Layout (2026-04):
 *   | Nro | Etapa | Documento | Archivo | Fecha y Hora de publicación | Acciones |
 *
 * Etapas observadas que contienen PDFs de interés:
 *   - "Convocatoria" → "Bases Administrativas" (suele ser .rar)
 *   - "Absolución de consultas y observaciones" → actas (.pdf)
 *   - "Integración de las Bases" → "Bases Integradas" (GENERALMENTE .zip con PDFs adentro)
 */

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const normKey = (s) =>
  norm(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * Infer tipo archivo desde filename (.zip/.rar/.pdf/...).
 */
function fileType(filename) {
  const m = String(filename || "").match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Extrae tabla de documentos. Usa el id confirmado `tbFicha:dtDocumentos_data`
 * pero cae atrás a heurística por headers.
 */
export function extractDocumentos($) {
  // intento 1: por id suffix (PrimeFaces)
  let tbody = $("tbody[id$=':dtDocumentos_data']").first();

  // intento 2: buscar tabla con thead que contenga columnas esperadas
  if (!tbody.length) {
    $("table").each((_, t) => {
      const heads = $(t).find("thead th").map((_, th) => normKey($(th).text())).get();
      if (heads.includes("etapa") && heads.includes("documento") && heads.includes("archivo")) {
        tbody = $(t).find("tbody").first();
        return false;
      }
    });
  }

  if (!tbody.length) return [];

  // descubrir headers en orden
  const table = tbody.closest("table");
  const headers = table
    .find("thead th")
    .map((_, th) => normKey($(th).text()))
    .get();

  const colIdx = (name) => headers.findIndex((h) => h.includes(name));
  const idxEtapa = colIdx("etapa");
  const idxDoc = colIdx("documento");
  const idxArchivo = colIdx("archivo");
  const idxFecha = colIdx("fecha");

  const docs = [];
  tbody.find("tr").each((_, tr) => {
    const tds = $(tr).find("> td");
    if (!tds.length) return;

    const etapa = idxEtapa >= 0 ? norm($(tds[idxEtapa]).text()) : "";
    const documento = idxDoc >= 0 ? norm($(tds[idxDoc]).text()) : "";
    const fecha = idxFecha >= 0 ? norm($(tds[idxFecha]).text()) : "";

    // extraer descargas de la celda Archivo + cualquier otro link
    const descargas = [];
    $(tr)
      .find("a[onclick*='descargaDocGeneral']")
      .each((_, a) => {
        const oc = $(a).attr("onclick") || "";
        const m = oc.match(/descargaDocGeneral\('([^']+)','([^']+)','([^']+)'/);
        if (m) {
          descargas.push({
            hash: m[1],
            sistema: m[2],
            filename: m[3],
            tipo: fileType(m[3]),
          });
        }
      });

    // tamaño visible suele estar como texto "(5884 KB)" en celda Archivo
    const archivoText = idxArchivo >= 0 ? norm($(tds[idxArchivo]).text()) : "";
    const sizeMatch = archivoText.match(/\(([\d.,]+)\s*([KMG]?B)\)/i);
    const sizeText = sizeMatch ? sizeMatch[0] : null;

    docs.push({
      nro: tds[0] ? norm($(tds[0]).text()) : null,
      etapa,
      documento,
      fecha,
      sizeText,
      descargas,
    });
  });

  return docs;
}

/**
 * Selecciona el mejor documento para análisis: Bases Integradas preferido, Bases fallback.
 *
 * Reglas de prioridad:
 *   1. Etapa "Integración de las Bases" + documento "Bases Integradas"
 *   2. Etapa "Convocatoria" + documento "Bases" / "Bases Administrativas"
 *   3. Último recurso: primer documento con descarga disponible
 *
 * Retorna { doc, confianza: 'alta' | 'media' | 'baja', razon }.
 */
export function selectBasesIntegradas(documentos) {
  if (!Array.isArray(documentos) || !documentos.length) {
    return { doc: null, confianza: "nula", razon: "sin documentos en ficha" };
  }

  // nivel 1: Bases Integradas
  const integradas = documentos.find((d) => {
    const e = normKey(d.etapa);
    const n = normKey(d.documento);
    return e.includes("integracion de las bases") && n.includes("bases integradas");
  });
  if (integradas && integradas.descargas.length) {
    return { doc: integradas, confianza: "alta", razon: "Bases Integradas encontradas" };
  }

  // nivel 2: Bases / Bases Administrativas (convocatoria)
  const bases = documentos.find((d) => {
    const e = normKey(d.etapa);
    const n = normKey(d.documento);
    return e.includes("convocatoria") && (n.includes("bases administrativas") || n === "bases");
  });
  if (bases && bases.descargas.length) {
    return {
      doc: bases,
      confianza: "media",
      razon: "Bases Integradas no disponibles, usando Bases Administrativas",
    };
  }

  // fallback: cualquier doc con descarga
  const cualquiera = documentos.find((d) => d.descargas.length);
  if (cualquiera) {
    return {
      doc: cualquiera,
      confianza: "baja",
      razon: `Fallback a ${cualquiera.documento}`,
    };
  }

  return { doc: null, confianza: "nula", razon: "ningún documento tiene descarga" };
}
