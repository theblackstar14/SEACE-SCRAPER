/**
 * Extrae requisitos clave de Bases Integradas / Bases Administrativas SEACE.
 *
 * Enfoque: regex multi-pattern calibrados sobre frases típicas SEACE.
 * Calcula confianza score. Si baja, consumidor puede pedir LLM fallback.
 *
 * Reglas importantes aprendidas:
 *  - Ventana ESTRECHA entre "experiencia" y el monto (150 chars) — si no,
 *    captura montos de secciones vecinas (Valor Referencial, presupuesto, etc).
 *  - Excluir matches donde entre "experiencia" y el monto aparecen marcadores
 *    de OTRAS secciones (VR/VE/Valor Referencial/presupuesto).
 *  - Tipos de obra: solo contar si aparecen CERCA de "experiencia similar"
 *    u "obras similares" (dentro de ventana), no en todo el PDF.
 */

const normText = (s) =>
  (s || "")
    .replace(/\s+/g, " ")
    .normalize("NFC")
    .trim();

/**
 * Extrae primer monto (en soles) de un texto. Acepta formatos:
 *   "S/ 5'000,000.00", "S/ 5,000,000.00", "S/ 5000000.00", "5,000,000"
 */
function extractMonto(str) {
  if (!str) return null;
  const cleanStr = String(str).replace(/S\s*\/\s*\.?/gi, "");
  const m = cleanStr.match(/(\d{1,3}(?:[.,'\s]\d{3})*(?:[.,]\d{1,2})?)/);
  if (!m) return null;

  let raw = m[1];
  const lastSep = raw.match(/[.,]\d{1,2}$/);
  let decimal = "";
  if (lastSep) {
    decimal = "." + raw.slice(raw.length - 2);
    raw = raw.slice(0, raw.length - 3);
  }
  const digits = raw.replace(/[^\d]/g, "");
  const n = Number(digits + decimal);
  return Number.isFinite(n) ? n : null;
}

/**
 * Verifica si un fragmento contiene marcadores de OTRA sección (VR, presupuesto, etc).
 * Si sí, el monto probablemente no es de experiencia.
 */
function tieneMarcadorOtraSeccion(fragmento) {
  const t = fragmento.toLowerCase();
  const re = /(valor\s*referencial|valor\s*estimado|vr\s*\/|ve\s*\/|presupuesto|monto\s*del\s*contrato|cuant[íi]a\s*de\s*la\s*contrataci[óo]n|derecho\s*de\s*participaci[óo]n)/;
  return re.test(t);
}

/**
 * Busca "experiencia del postor / experiencia mínima" con formulaciones varias.
 *
 * Patterns:
 *   A. "experiencia ... no menor a S/ X"           → monto directo
 *   B. "experiencia ... N veces (VR|valor referencial)" → múltiplo
 *   C. "experiencia mínima de N (años|obras)"      → cantidad
 */
export function extractExperienciaMinima(text, { valorReferencial = null } = {}) {
  const hits = [];
  const t = normText(text);
  const WINDOW = 150; // caracteres entre "experiencia" y el valor buscado

  // A. monto directo — ventana estrecha 150 chars, debe contener "experiencia"
  //    y luego "no menor a" / "equivalente a" / "acumulado" cerca del S/
  const reA = new RegExp(
    `experiencia[^.]{0,${WINDOW}}?(?:no\\s*(?:ser|debe\\s*ser)?\\s*menor\\s*(?:a|al|de)|acumulado\\s*(?:no\\s*menor\\s*(?:a|de)|equivalente\\s*a)|por\\s*un\\s*monto\\s*(?:acumulado\\s*)?(?:no\\s*menor\\s*(?:a|de)|equivalente\\s*a))\\s*S\\s*\\/\\s*\\.?\\s*([\\d.,'\\s]+)`,
    "gi"
  );
  let m;
  while ((m = reA.exec(t)) !== null) {
    // exclusión: si el fragmento contiene marcadores de VR u otra sección, descartamos
    if (tieneMarcadorOtraSeccion(m[0])) continue;
    const monto = extractMonto(m[1]);
    if (monto) {
      hits.push({
        tipo: "monto",
        monto,
        moneda: "PEN",
        confianza: 0.85,
        patternId: "A",
        fragmento: m[0].slice(0, 300),
      });
    }
  }

  // B. "N veces el valor referencial" — múltiplo del VR
  const reB = new RegExp(
    `experiencia[^.]{0,${WINDOW}}?equivalente\\s*a\\s*([\\w\\s]+?)\\(?(\\d+(?:[.,]\\d+)?)\\)?\\s*(?:veces?|\\(?\\d+\\)?\\s*veces?)\\s*(?:el\\s*)?(?:valor\\s*referencial|VR|valor\\s*estimado|VE|cuant[íi]a)`,
    "gi"
  );
  while ((m = reB.exec(t)) !== null) {
    const veces = Number(String(m[2]).replace(",", "."));
    if (Number.isFinite(veces) && veces > 0 && veces < 100) {
      const monto = valorReferencial ? Math.round(valorReferencial * veces * 100) / 100 : null;
      hits.push({
        tipo: "multiplo_vr",
        veces,
        monto,
        moneda: "PEN",
        confianza: 0.9,
        patternId: "B",
        fragmento: m[0].slice(0, 300),
      });
    }
  }

  // C. "experiencia mínima de N obras / años"
  const reC = /experiencia\s+m[íi]nima\s+de\s+(\d+)\s*\(?[\w]*\)?\s*(obras?|a[ñn]os?)/gi;
  while ((m = reC.exec(t)) !== null) {
    const n = Number(m[1]);
    const unidad = m[2].toLowerCase().startsWith("a") ? "anios" : "obras";
    hits.push({
      tipo: "cantidad",
      cantidad: n,
      unidad,
      confianza: 0.6,
      patternId: "C",
      fragmento: m[0].slice(0, 200),
    });
  }

  return hits;
}

/**
 * Tipos de obra similar — solo cuenta keywords cerca de "obras similares" o
 * "experiencia similar" (ventana ±300 chars), no en todo el PDF.
 */
export function extractTiposObraSimilar(text) {
  const t = normText(text);
  const tlow = t.toLowerCase();
  const tipos = new Set();

  // localizar índices de "obras similares" / "experiencia similar" / "obra similar"
  const anchors = [];
  const reAnchor = /obras?\s+similar(?:es)?|experiencia\s+similar/gi;
  let m;
  while ((m = reAnchor.exec(tlow)) !== null) {
    anchors.push(m.index);
  }

  // si no hay anchors, limitar a primeros 20000 chars (evita keywords de páginas finales)
  if (!anchors.length) anchors.push(0);

  const keywords = [
    ["edificacion", /edificaci[óo]n(?:es)?/],
    ["carretera", /carreter(?:a|as)|pavimenta(?:ci[óo]n|ci[óo]n\s+de\s+v[íi]as)/],
    ["saneamiento", /saneamiento|agua\s+potable|alcantarillado|desag[üu]e/],
    ["puente", /puent(?:e|es)/],
    ["educativa", /(?:infraestructura\s+)?educativ(?:a|o)|instituci[óo]n\s+educativa/],
    ["salud", /hospital|centro\s+de\s+salud|posta\s+m[ée]dica|establecimiento\s+de\s+salud/],
    ["deportiva", /(?:infraestructura\s+)?deportiv(?:a|o)|losa\s+deportiva|estadio|coliseo/],
    ["riego", /\briego\b|irrigaci[óo]n|canal(?:es)?\s+de\s+riego/],
    ["electrico", /electrificaci[óo]n|red\s+el[ée]ctrica|alumbrado\s+p[úu]blico/],
    ["muros", /muro\s+de\s+contenci[óo]n|defensa\s+ribere[ñn]a/],
  ];

  // extraer ventanas ±300 chars alrededor de cada anchor
  const windows = anchors.map((idx) => tlow.slice(Math.max(0, idx - 300), idx + 500));
  const windowText = windows.join(" ");

  for (const [key, re] of keywords) {
    if (re.test(windowText)) tipos.add(key);
  }

  return [...tipos];
}

/**
 * Busca "antigüedad" máxima: "experiencia ... en los últimos N años".
 */
export function extractAntiguedadMax(text) {
  const t = normText(text);
  const re = /(?:ejecutad[ao]s?|obtenid[ao]s?|realizad[ao]s?)\s+en\s+los\s+[úu]ltimos\s+(\d+)\s*\(?[\w]*\)?\s*a[ñn]os/gi;
  const m = re.exec(t);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * API principal.
 */
export function analizarRequisitos(text, { valorReferencial = null } = {}) {
  const experiencia = extractExperienciaMinima(text, { valorReferencial });
  const tipos = extractTiposObraSimilar(text);
  const antiguedad = extractAntiguedadMax(text);

  const conMonto = experiencia.filter((h) => h.monto != null).sort((a, b) => b.confianza - a.confianza);
  const montoFinal = conMonto[0]?.monto ?? null;
  const confianza = conMonto[0]?.confianza ?? 0;

  const cantidadHit = experiencia.find((h) => h.tipo === "cantidad");

  return {
    experienciaMonto: montoFinal,
    experienciaConfianza: confianza,
    experienciaHits: experiencia,
    experienciaObrasMin: cantidadHit?.unidad === "obras" ? cantidadHit.cantidad : null,
    antiguedadMaxAnios: antiguedad,
    tiposObraSimilar: tipos,
    requiereLlm: confianza < 0.6,
  };
}
