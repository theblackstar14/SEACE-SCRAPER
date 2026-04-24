/**
 * Extrae requisitos clave de Bases Integradas SEACE.
 *
 * Enfoque: regex multi-pattern calibrados sobre frases típicas SEACE.
 * Calcula un "confianza" score. Si baja, el consumidor puede pedir LLM fallback.
 *
 * NOTA: El calibrado fino requiere PDFs reales. Los patterns aquí son una
 * primera versión educada basada en estructura SOP SEACE (Directivas OSCE/OECE).
 */

const normText = (s) =>
  (s || "")
    .replace(/\s+/g, " ")
    .normalize("NFC")
    .trim();

/**
 * Extrae primer monto (en soles) de un texto. Acepta formatos:
 *   "S/ 5'000,000.00", "S/ 5,000,000.00", "S/ 5000000.00"
 *   "5'000,000", "S/. 12 345 678,90"
 */
function extractMonto(str) {
  if (!str) return null;
  // quita "S/" y similares
  const cleanStr = String(str).replace(/S\s*\/\s*\.?/gi, "");

  // busca número con separadores varios
  const m = cleanStr.match(/(\d{1,3}(?:[.,'\s]\d{3})*(?:[.,]\d{1,2})?)/);
  if (!m) return null;

  // normalizar: asume formato peruano (miles = , o ' o .; decimal = . o ,)
  let raw = m[1];
  // detectar último separador = decimal si tiene 1-2 dígitos después
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
 * Busca "experiencia del postor / experiencia mínima" con varias formulaciones.
 *
 * Patterns cubiertos:
 *   A. "experiencia ... no menor a S/ X"   → monto directo
 *   B. "experiencia ... equivalente a X veces (el valor referencial|VR)"  → múltiplo
 *   C. "experiencia mínima de N (años|obras)"   → antigüedad u obras número
 */
export function extractExperienciaMinima(text, { valorReferencial = null } = {}) {
  const hits = [];
  const t = normText(text);

  // A. monto directo
  const reA = /experiencia[^.]{0,400}?(?:no\s*(?:ser|debe\s*ser)?\s*menor\s*(?:a|al|de)|equivalente\s*a|por\s*un\s*monto\s*(?:acumulado\s*)?(?:no\s*menor\s*(?:a|de)|equivalente\s*a))\s*S\s*\/\s*\.?\s*([\d.,'\s]+)/gi;
  let m;
  while ((m = reA.exec(t)) !== null) {
    const monto = extractMonto(m[1]);
    if (monto) {
      hits.push({
        tipo: "monto",
        monto,
        moneda: "PEN",
        confianza: 0.85,
        patternId: "A",
        fragmento: m[0].slice(0, 220),
      });
    }
  }

  // B. veces el VR
  const reB = /experiencia[^.]{0,400}?equivalente\s*a\s*([\w\s]+?)\s*\(?(\d+(?:[.,]\d+)?)\)?\s*(?:veces?|\(?\d+\)?\s*veces?)\s*(?:el\s*)?(?:valor\s*referencial|VR|valor\s*estimado|VE|cuant[íi]a)/gi;
  while ((m = reB.exec(t)) !== null) {
    const veces = Number(String(m[2]).replace(",", "."));
    if (Number.isFinite(veces)) {
      const monto = valorReferencial ? Math.round(valorReferencial * veces * 100) / 100 : null;
      hits.push({
        tipo: "multiplo_vr",
        veces,
        monto,
        moneda: "PEN",
        confianza: 0.9,
        patternId: "B",
        fragmento: m[0].slice(0, 220),
      });
    }
  }

  // C. mínimo N obras / N años
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
      fragmento: m[0].slice(0, 220),
    });
  }

  return hits;
}

/**
 * Intenta identificar tipos de obra similar mencionados.
 */
export function extractTiposObraSimilar(text) {
  const t = normText(text).toLowerCase();
  const tipos = new Set();

  // keywords comunes en obras públicas Perú
  const keywords = [
    ["edificacion", /edificaci[óo]n(?:es)?\s+(?:urbana|rural|en\s+general)?/gi],
    ["carretera", /carreter(?:a|as)|vial(?:es)?|pavimenta(?:ci[óo]n|ci[óo]n\s+de\s+v[íi]as)|pista/gi],
    ["saneamiento", /saneamiento|agua\s+potable|alcantarillado|desag[üu]e/gi],
    ["puente", /puent(?:e|es)/gi],
    ["educativa", /(?:infraestructura\s+)?educativ(?:a|o)|colegio|instituci[óo]n\s+educativa|i\.e\./gi],
    ["salud", /hospital|centro\s+de\s+salud|posta\s+m[ée]dica|establecimiento\s+de\s+salud/gi],
    ["deportiva", /(?:infraestructura\s+)?deportiv(?:a|o)|losa\s+deportiva|estadio|coliseo/gi],
    ["riego", /riego|irrigaci[óo]n|canal(?:es)?\s+de\s+riego/gi],
    ["electrico", /electrificaci[óo]n|red\s+el[ée]ctrica|alumbrado\s+p[úu]blico/gi],
    ["muros", /muro\s+de\s+contenci[óo]n|defensa\s+ribere[ñn]a/gi],
  ];

  for (const [key, re] of keywords) {
    if (re.test(t)) tipos.add(key);
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
 * API principal: analiza texto de Bases y devuelve struct consolidado.
 */
export function analizarRequisitos(text, { valorReferencial = null } = {}) {
  const experiencia = extractExperienciaMinima(text, { valorReferencial });
  const tipos = extractTiposObraSimilar(text);
  const antiguedad = extractAntiguedadMax(text);

  // consolidar: preferir hit de mayor confianza con monto
  const conMonto = experiencia.filter((h) => h.monto != null).sort((a, b) => b.confianza - a.confianza);
  const montoFinal = conMonto[0]?.monto ?? null;
  const confianza = conMonto[0]?.confianza ?? 0;

  // cantidad de obras / años requeridas (hit C)
  const cantidadHit = experiencia.find((h) => h.tipo === "cantidad");

  return {
    experienciaMonto: montoFinal,
    experienciaConfianza: confianza,
    experienciaHits: experiencia,
    experienciaObrasMin: cantidadHit?.unidad === "obras" ? cantidadHit.cantidad : null,
    antiguedadMaxAnios: antiguedad,
    tiposObraSimilar: tipos,
    // flag: si confianza < 0.6, recomendamos LLM
    requiereLlm: confianza < 0.6,
  };
}
