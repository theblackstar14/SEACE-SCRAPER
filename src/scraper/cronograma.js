/**
 * Parser de tabla Cronograma de ficha SEACE.
 *
 * Layout observado (2026-04):
 *   | Etapa | Fecha Inicio | Fecha Fin |
 *
 * Etapas típicas (orden canónico):
 *   1. Convocatoria
 *   2. Registro de participantes (Electronica)
 *   3. Formulación de consultas y observaciones (Electronica)
 *   4. Absolución de consultas y observaciones (Electronica)
 *   5. Integración de las Bases (A TRAVÉS DEL SEACE)
 *   6. Presentación de propuestas (Electronica)   ← KEY
 *   7. Calificación y Evaluación de propuestas
 *   8. Otorgamiento de la Buena Pro
 */

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const normKey = (s) =>
  norm(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/**
 * Parsea fecha SEACE "DD/MM/YYYY" o "DD/MM/YYYY HH:mm" asumiendo timezone America/Lima (UTC-5).
 * Retorna { raw, iso, ms } o null si no parsea.
 */
export function parseSeaceDate(raw) {
  if (!raw) return null;
  const s = norm(raw);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh = "00", mi = "00"] = m;
  // America/Lima = UTC-5 fijo (sin DST)
  const iso = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}T${String(
    hh
  ).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00-05:00`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return { raw: s, iso, ms: d.getTime() };
}

/**
 * "Ahora" en ms, en timezone Lima. (Date.now() es UTC ms; comparación funciona igual.)
 */
function nowMs() {
  return Date.now();
}

/**
 * Extrae cronograma desde Cheerio $. Busca tabla cuyo thead contenga "Etapa".
 * Heurística robusta frente a ID auto-generado (j_idt370 etc).
 */
export function extractCronograma($) {
  let table = null;

  // busca thead con columnas Etapa | Fecha Inicio | Fecha Fin
  $("table").each((_, t) => {
    const $t = $(t);
    const heads = $t.find("thead th").map((_, th) => normKey($(th).text())).get();
    if (heads.some((h) => h === "etapa") && heads.some((h) => h.includes("fecha inicio"))) {
      table = $t;
      return false;
    }
  });

  if (!table) return [];

  const rows = [];
  table.find("tbody tr").each((_, tr) => {
    const tds = $(tr).find("> td");
    if (tds.length < 3) return;

    // col 0 puede ser multi-línea: "Integración de las Bases\nA TRAVÉS DEL SEACE"
    const etapaFull = norm($(tds[0]).text());
    const [etapaTitle, ...restLines] = etapaFull
      .split(/\s{2,}|\n/)
      .map(norm)
      .filter(Boolean);
    const ubicacion = restLines.join(" ") || null;

    const inicioRaw = norm($(tds[1]).text());
    const finRaw = norm($(tds[2]).text());

    rows.push({
      etapa: etapaTitle,
      etapaRaw: etapaFull,
      ubicacion,
      inicio: inicioRaw || null,
      fin: finRaw || null,
      inicioIso: parseSeaceDate(inicioRaw)?.iso || null,
      finIso: parseSeaceDate(finRaw)?.iso || null,
    });
  });

  return rows;
}

/**
 * Dado cronograma parseado, devuelve la fila de "Presentación de propuestas" con estado.
 *
 * Estado:
 *  - 'activo'    → hoy <= finMs (aún se puede presentar)
 *  - 'vencido'   → hoy > finMs
 *  - 'pendiente' → hoy < inicioMs (aún no abre la ventana)
 *  - 'sin_fecha' → no se encontró la etapa o no tiene fechas
 */
export function findFechaPresentacion(cronograma) {
  if (!Array.isArray(cronograma) || !cronograma.length) {
    return { estado: "sin_fecha", inicio: null, fin: null };
  }

  const target = cronograma.find((r) => {
    const k = normKey(r.etapa);
    return (
      k.includes("presentacion de propuestas") ||
      k.includes("presentacion de ofertas") ||
      k === "presentacion de propuesta"
    );
  });

  if (!target) {
    return { estado: "sin_fecha", inicio: null, fin: null };
  }

  const inicio = parseSeaceDate(target.inicio);
  const fin = parseSeaceDate(target.fin);
  const now = nowMs();

  let estado = "sin_fecha";
  if (fin) {
    if (now > fin.ms) estado = "vencido";
    else if (inicio && now < inicio.ms) estado = "pendiente";
    else estado = "activo";
  }

  return {
    etapa: target.etapa,
    inicio: target.inicio,
    fin: target.fin,
    inicioIso: inicio?.iso || null,
    finIso: fin?.iso || null,
    estado,
    diasRestantes: fin ? Math.ceil((fin.ms - now) / (1000 * 60 * 60 * 24)) : null,
  };
}

/**
 * Helper: ¿proceso activo? (según fecha presentación)
 */
export function isProcesoActivo(cronograma) {
  const fp = findFechaPresentacion(cronograma);
  return fp.estado === "activo" || fp.estado === "pendiente";
}
