import { load } from "cheerio";

/**
 * Normaliza un header ("Fecha y Hora de Publicacion") a camelCase key ("fechaYHoraDePublicacion").
 * Luego mapeamos a nombres canónicos.
 */
function normalizeHeader(raw) {
  const clean = (raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar acentos
    .replace(/[^\w\s]/g, " ")
    .trim()
    .toLowerCase();
  return clean;
}

// mapa header SEACE → key canónica
const HEADER_MAP = [
  { re: /^n\s*$|^nro$|numero/, key: "nro" },
  { re: /nombre.*entidad/, key: "entidad" },
  { re: /fecha.*public/, key: "fechaPublicacion" },
  { re: /nomenclatura/, key: "nomenclatura" },
  { re: /reiniciado/, key: "reiniciadoDesde" },
  { re: /objeto.*contratac/, key: "objetoContratacion" },
  { re: /descripcion.*objeto/, key: "descripcion" },
  { re: /codigo.*snip/, key: "codSnip" },
  { re: /codigo.*inversion|cui/, key: "codCui" },
  { re: /vr|cuantia|valor.*referen/, key: "vrCuantia" },
  { re: /moneda/, key: "moneda" },
  { re: /version.*seace/, key: "versionSeace" },
  { re: /etapa/, key: "etapa" },
  { re: /tipo.*seleccion/, key: "tipoSeleccion" },
  { re: /accion/, key: "__acciones" }, // no almacenar, pero marcar
];

function canonicalKey(headerText) {
  const n = normalizeHeader(headerText);
  for (const { re, key } of HEADER_MAP) {
    if (re.test(n)) return key;
  }
  return n.replace(/\s+/g, "_") || "col";
}

/**
 * Parsea monto peruano: "521,292.05" → 521292.05, "---" → null.
 */
export function parseMonto(s) {
  if (!s) return null;
  const clean = String(s).replace(/[^\d.,-]/g, "");
  if (!clean || clean === "---" || clean === "-") return null;
  // formato peruano: miles con coma, decimal con punto
  const n = Number(clean.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Extrae nidProceso + nidConvocatoria del link de Ficha Selección (el correcto).
 * Evita tomar el del popup SNIP/CUI que es distinto y NO sirve para navegar.
 */
function extractProcesoIds($row) {
  let nidProceso = "";
  let nidConvocatoria = "";

  // prioridad: link que contiene img fichaSeleccion.gif
  const fichaLink = $row.find("a:has(img[src*='fichaSeleccion'])").first();
  const candidates = fichaLink.length ? [fichaLink] : $row.find("a[onclick]").toArray();

  for (const a of Array.isArray(candidates) ? candidates : [candidates[0]]) {
    const $a = a.find ? a : load("<div></div>")("div").add(a);
    const el = a.attr ? a : a; // cheerio handle
    const oc = (el.attr?.("onclick") || el.attribs?.onclick || "") || "";
    const mP = oc.match(/'nidProceso'\s*:\s*'([^']+)'/);
    const mC = oc.match(/'nidConvocatoria'\s*:\s*'([^']+)'/);
    if (mP && !nidProceso) nidProceso = mP[1];
    if (mC && !nidConvocatoria) nidConvocatoria = mC[1];
    if (nidProceso && nidConvocatoria) break;
  }

  return { nidProceso, nidConvocatoria };
}

/**
 * Parsea la tabla de resultados SEACE.
 * Retorna array de procesos con schema estable independiente del orden de columnas.
 */
export function parseTable(html) {
  const $ = load(html);

  // 1. Leer headers reales y construir mapping index → key
  const headers = [];
  $("#tbBuscador\\:idFormBuscarProceso\\:dtProcesos thead th").each((i, th) => {
    const text = $(th).text().trim();
    headers.push({ raw: text, key: canonicalKey(text) });
  });

  if (!headers.length) {
    console.warn("[parseTable] no se encontraron headers — selector cambió?");
    return [];
  }

  const resultados = [];

  $("#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr[data-ri]").each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.find("> td");
    if (!tds.length) return;

    const row = {};
    tds.each((i, td) => {
      const header = headers[i];
      if (!header || header.key === "__acciones") return;
      const $td = $(td);
      // para VR, preferimos número
      if (header.key === "vrCuantia") {
        const raw = $td.text().trim();
        row.vrCuantia = parseMonto(raw);
        row.vrCuantiaRaw = raw;
      } else {
        row[header.key] = $td.text().replace(/\s+/g, " ").trim();
      }
    });

    // IDs desde ficha link
    const ids = extractProcesoIds($tr);
    row.nidProceso = ids.nidProceso;
    row.nidConvocatoria = ids.nidConvocatoria;

    if (!row.nidProceso) {
      // fallback: cualquier onclick con nidProceso
      $tr.find("a[onclick]").each((_, a) => {
        if (row.nidProceso) return;
        const oc = $(a).attr("onclick") || "";
        const m = oc.match(/'nidProceso'\s*:\s*'([^']+)'/);
        if (m) row.nidProceso = m[1];
      });
    }

    resultados.push(row);
  });

  return resultados;
}

/**
 * Parsea info del paginador: "[ Mostrando de 61 a 75 del total 240 - Página: 5/16 ]"
 */
export function parsePaginatorInfo(text) {
  if (!text) return null;
  const m = text.match(/de\s+(\d+)\s+a\s+(\d+)\s+del total\s+(\d+)\s+-\s+P[aá]gina:\s+(\d+)\/(\d+)/i);
  if (!m) return null;
  return {
    from: Number(m[1]),
    to: Number(m[2]),
    total: Number(m[3]),
    page: Number(m[4]),
    pages: Number(m[5]),
  };
}
