/**
 * Extractor de requisitos SEACE con LLM (Claude Haiku o Gemini Flash).
 *
 * Estrategia dual:
 *  - Claude: rápido, bueno para texto extraído, context 200k
 *  - Gemini: context 1M, excelente OCR, 10× más barato input tokens,
 *    ideal para PDFs escaneados grandes que no caben en Claude
 *
 * El orchestrator decide cuál usar según tamaño/tipo del documento.
 */

import { createMessage, extractToolInput, isLlmAvailable, defaultModel } from "../llm/claude.js";
import { generateStructured, isGeminiAvailable, defaultGeminiModel } from "../llm/gemini.js";
import { truncateForClaude } from "../pdf/pdfTruncate.js";

/**
 * Tool schema que Claude debe rellenar. Structured output con tool_use.
 */
const EXTRACCION_TOOL = {
  name: "registrar_requisitos_seace",
  description:
    "Registra los requisitos de calificación técnica encontrados en las Bases SEACE de un proceso de obra.",
  input_schema: {
    type: "object",
    properties: {
      experiencia_monto_pen: {
        type: ["number", "null"],
        description:
          "Monto mínimo en soles (PEN) de experiencia del postor en obras similares. Null si no se especifica.",
      },
      experiencia_veces_vr: {
        type: ["number", "null"],
        description:
          "Si el requisito está expresado como 'N veces el valor referencial' (ej 2x VR), indica N. Null si no aplica.",
      },
      tipos_obra_similar: {
        type: "array",
        items: { type: "string" },
        description:
          "Tipos de obra que el postor debe haber ejecutado para calificar como 'obra similar'. Ejemplos: edificacion, saneamiento, carretera, saneamiento, puente, educativa, salud, deportiva, riego, electrico, muros.",
      },
      antiguedad_max_anios: {
        type: ["number", "null"],
        description:
          "Antigüedad máxima (en años) de las obras acreditables. Típicamente 10 o 15. Null si no se especifica.",
      },
      experiencia_obras_min: {
        type: ["number", "null"],
        description:
          "Número mínimo de obras ejecutadas que debe acreditar el postor. Null si se mide por monto en vez de cantidad.",
      },
      es_bases_integradas: {
        type: "boolean",
        description:
          "true si el documento contiene los requisitos FINALES rellenos (Bases Integradas publicadas). false si es template sin rellenar.",
      },
      plantel_profesional: {
        type: "array",
        description:
          "Lista de profesionales clave requeridos por las Bases (sección B. CAPACIDAD TÉCNICA Y PROFESIONAL). Cada item es un rol exigido al postor. Vacío si no hay sección de plantel.",
        items: {
          type: "object",
          properties: {
            rol: {
              type: "string",
              description: "Cargo/rol exacto. Ejemplos: Residente de Obra, Especialista en Estructuras, Especialista en Suelos, Especialista en Sanitarias, Especialista en Eléctricas, Asistente Técnico.",
            },
            profesion: {
              type: ["string", "null"],
              description: "Profesión requerida. Ejemplos: Ingeniero Civil, Ingeniero Sanitario, Arquitecto, Ingeniero Eléctrico, Ingeniero Mecánico-Eléctrico.",
            },
            experiencia_general_meses: {
              type: ["number", "null"],
              description: "Experiencia general mínima en meses (típicamente 60-120). Null si no se especifica.",
            },
            experiencia_especifica_meses: {
              type: ["number", "null"],
              description: "Experiencia específica/efectiva mínima en meses (típicamente 24-48). Null si no se especifica.",
            },
            experiencia_especifica_en: {
              type: ["string", "null"],
              description: "En qué debe ser la experiencia específica. Ejemplos: 'obras similares', 'residente de obras de saneamiento', 'estructuras de concreto armado'.",
            },
          },
          required: ["rol"],
        },
      },
      lugar_ejecucion: {
        type: ["string", "null"],
        description:
          "Texto literal de la sección 1.5 LUGAR DE EJECUCIÓN o equivalente. Típicamente algo como 'Distrito de Pachacámac, Provincia de Lima, Departamento de Lima'. Null si no aparece.",
      },
      confianza: {
        type: "number",
        description:
          "Qué tan seguro estás de la extracción (0.0 a 1.0). 0.0 si no hay datos claros, 1.0 si los requisitos están explícitamente especificados.",
      },
      citas: {
        type: "array",
        items: { type: "string" },
        description:
          "Hasta 3 fragmentos literales del documento donde aparecen los requisitos extraídos (máx 200 chars cada uno).",
      },
      notas: {
        type: ["string", "null"],
        description: "Observaciones importantes para el evaluador. Null si no hay.",
      },
    },
    required: ["experiencia_monto_pen", "tipos_obra_similar", "es_bases_integradas", "confianza", "citas"],
  },
};

const SYSTEM_PROMPT = `Eres experto en contratación pública peruana (OSCE/OECE/SEACE).
Tu tarea: extraer de las Bases de un proceso SEACE de OBRA los requisitos de calificación técnica del postor.

Claves importantes:
- SEACE tiene Bases Estándar (template) y Bases Integradas (rellenadas). Las Bases Estándar usan marcadores como [CONSIGNAR NOMENCLATURA] o [CONSIGNAR EL MONTO]; no tienen valores reales. Las Bases Integradas tienen los montos específicos rellenos.
- Experiencia del postor: "monto acumulado no menor a S/ X" o "equivalente a N veces el valor referencial".
- Obra similar: se define en las Bases; puede ser por tipo (edificacion, saneamiento, etc) o subespecialidad.
- No confundir VR/Valor Referencial/VE/Cuantía con la experiencia requerida — son cosas distintas.
- Plantel profesional: sección "B. CAPACIDAD TÉCNICA Y PROFESIONAL" o "CAPACIDAD TÉCNICA Y PROFESIONAL". Lista cargos como Residente de Obra, Especialistas. Cada uno con experiencia general y específica en meses.
- Lugar de ejecución: sección 1.5 o equivalente del Capítulo I. Indica distrito/provincia/departamento donde se ejecuta la obra.

Siempre responde invocando el tool registrar_requisitos_seace.`;

// ============================================================================
// CLAUDE
// ============================================================================

/**
 * Analiza un PDF con Claude — document block (OCR interno).
 */
export async function extractRequisitosWithClaudePdf(buffer, { valorReferencial = null, filename = "bases.pdf" } = {}) {
  if (!isLlmAvailable()) {
    throw new Error("ANTHROPIC_API_KEY no configurada");
  }

  const trunc = await truncateForClaude(buffer, { maxPages: 40 });

  const userText = `Analiza este documento de Bases SEACE y extrae TODOS los campos del tool, incluyendo:

1. **Requisitos de experiencia del postor** (monto en S/, tipos de obra similar, antigüedad).
2. **Plantel profesional COMPLETO** (sección "B. CAPACIDAD TÉCNICA Y PROFESIONAL" o "PLANTEL PROFESIONAL CLAVE"). Lista CADA cargo con su experiencia general/específica en meses. Roles típicos: Residente de Obra, Especialista en Estructuras, Especialista en Suelos, Especialista en Sanitarias, Especialista en Eléctricas, Asistente Técnico. Si la sección existe, NUNCA dejes el array vacío.
3. **Lugar de ejecución** (Capítulo I, sección 1.5 o equivalente). Texto literal: "Distrito X, Provincia Y, Departamento Z".

${valorReferencial ? `\nValor Referencial del proceso: S/ ${valorReferencial.toLocaleString("es-PE")} (no confundir con la experiencia requerida).` : ""}
${trunc.wasCropped ? `\nNota: el documento original es grande (${Math.round(trunc.originalSize / 1024 / 1024)}MB, ${trunc.totalPages} páginas). Se te envían las primeras ${trunc.pagesIncluded} páginas.` : ""}

Si es una Bases Estándar SIN rellenar (tiene placeholders [CONSIGNAR...]), indica es_bases_integradas=false y confianza≤0.3.
Si son Bases Integradas con montos reales, extrae con precisión y confianza≥0.8.`;

  const message = await createMessage({
    model: defaultModel(),
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [EXTRACCION_TOOL],
    tool_choice: { type: "tool", name: EXTRACCION_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: trunc.buffer.toString("base64"),
            },
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const input = extractToolInput(message, EXTRACCION_TOOL.name);
  if (!input) throw new Error("Claude no invocó el tool");

  return mapToResult(input, {
    provider: "claude",
    model: message.model,
    usage: message.usage,
    wasCropped: trunc.wasCropped,
    pagesAnalyzed: trunc.pagesIncluded || null,
    truncatedFrom: trunc.wasCropped ? { totalPages: trunc.totalPages, originalMB: Math.round(trunc.originalSize / 1024 / 1024) } : null,
  });
}

export async function extractRequisitosWithClaudeText(text, { valorReferencial = null } = {}) {
  if (!isLlmAvailable()) {
    throw new Error("ANTHROPIC_API_KEY no configurada");
  }

  // Multi-window strategy: si el doc es grande, enviamos varios fragmentos clave concatenados
  // (lugar de ejecución + sección requisitos + plantel) en lugar de un solo slice.
  const MAX_CHARS = 120000;
  const truncated = text.length > MAX_CHARS;
  let textSlice = text;
  if (truncated) {
    const tlow = text.toLowerCase();

    // 1. Encuentra todos los puntos de interés
    const findAll = (needle) => {
      const out = [];
      let i = 0;
      while ((i = tlow.indexOf(needle, i)) >= 0) { out.push(i); i += needle.length; }
      return out;
    };
    const reqIdx       = [...findAll("requisitos de calificaci"), ...findAll("requisitos de calif")];
    const expPostorIdx = findAll("experiencia del postor");
    const capTecIdx    = [...findAll("capacidad técnica y profesional"), ...findAll("capacidad tecnica y profesional")];
    const planIdx      = findAll("plantel profesional");
    const lugarIdx     = findAll("lugar de ejecuci");
    const cap3Idx      = [...findAll("capítulo iii"), ...findAll("capitulo iii")];

    // 2. Construye ventanas (cada una ~25k chars max) priorizando secciones reales
    //    de la "Sección Específica" (no las del template/TOC). Heurística:
    //    - cap III en la SEGUNDA mitad del documento es probablemente real
    //    - cap III en la PRIMERA mitad es TOC
    const halfLen = text.length / 2;
    const windows = [];
    const addWindow = (idx, before, after, label) => {
      if (idx < 0) return;
      const start = Math.max(0, idx - before);
      const end = Math.min(text.length, idx + after);
      windows.push({ start, end, label });
    };

    // ventana lugar (al inicio del PDF)
    if (lugarIdx[0] != null) addWindow(lugarIdx[0], 500, 1500, "lugar_ejecucion");

    // ventana cap III real (preferir occurrence en segunda mitad)
    const cap3Real = cap3Idx.find(i => i > halfLen) ?? cap3Idx[cap3Idx.length - 1];
    if (cap3Real != null) addWindow(cap3Real, 2000, 30000, "capitulo_iii");

    // ventana experiencia del postor (más específica)
    const expReal = expPostorIdx.find(i => i > halfLen) ?? expPostorIdx[0];
    if (expReal != null) addWindow(expReal, 2000, 15000, "experiencia_postor");

    // ventana capacidad técnica y profesional (plantel)
    const capTecReal = capTecIdx.find(i => i > halfLen) ?? capTecIdx[0];
    if (capTecReal != null) addWindow(capTecReal, 1500, 12000, "plantel");

    // ventana plantel profesional explícito
    if (planIdx[0] != null) addWindow(planIdx[0], 500, 8000, "plantel_explicit");

    // ventana requisitos calificación (último intento)
    const reqReal = reqIdx.find(i => i > halfLen) ?? reqIdx[0];
    if (reqReal != null) addWindow(reqReal, 1500, 12000, "requisitos");

    // 3. Mergear ventanas que se solapan
    windows.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const w of windows) {
      const last = merged[merged.length - 1];
      if (last && w.start <= last.end + 500) {
        last.end = Math.max(last.end, w.end);
        last.label += `+${w.label}`;
      } else {
        merged.push({ ...w });
      }
    }

    // 4. Construir slice respetando MAX_CHARS
    const parts = [];
    let totalChars = 0;
    for (const w of merged) {
      const len = w.end - w.start;
      if (totalChars + len > MAX_CHARS) {
        const remaining = MAX_CHARS - totalChars;
        if (remaining < 1000) break;
        parts.push(`\n\n[FRAGMENTO ${w.label}]\n${text.slice(w.start, w.start + remaining)}`);
        break;
      }
      parts.push(`\n\n[FRAGMENTO ${w.label}]\n${text.slice(w.start, w.end)}`);
      totalChars += len;
    }

    if (parts.length > 0) {
      textSlice = parts.join("");
    } else {
      textSlice = text.slice(0, MAX_CHARS);
    }
  }

  const userText = `Texto extraído de las Bases SEACE (proceso de obra):
---
${textSlice}
---
${truncated ? `\n[texto truncado — ${text.length} chars totales, enviados ${textSlice.length}]` : ""}
${valorReferencial ? `\nValor Referencial del proceso: S/ ${valorReferencial.toLocaleString("es-PE")}.` : ""}

Extrae TODOS los campos del tool:
1. Requisitos de experiencia del postor.
2. **Plantel profesional COMPLETO** — sección "B. CAPACIDAD TÉCNICA Y PROFESIONAL" o "PLANTEL PROFESIONAL CLAVE". Lista CADA rol con experiencia en meses. Si la sección existe, NUNCA dejes el array vacío.
3. **Lugar de ejecución** — texto literal de la sección 1.5.`;

  const message = await createMessage({
    model: defaultModel(),
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [EXTRACCION_TOOL],
    tool_choice: { type: "tool", name: EXTRACCION_TOOL.name },
    messages: [{ role: "user", content: userText }],
  });

  const input = extractToolInput(message, EXTRACCION_TOOL.name);
  if (!input) throw new Error("Claude no invocó el tool");

  return mapToResult(input, {
    provider: "claude",
    model: message.model,
    usage: message.usage,
    textLength: text.length,
    truncated,
  });
}

// ============================================================================
// GEMINI (1M context, excelente OCR, 10x más barato)
// ============================================================================

/**
 * Analiza un PDF con Gemini. Ventajas:
 *  - Context 1M tokens → PDFs hasta ~1000 páginas sin truncar
 *  - OCR nativo potente para escaneados
 *  - 10× más barato en tokens input
 *  - Rate limit más generoso
 */
export async function extractRequisitosWithGeminiPdf(buffer, { valorReferencial = null, filename = "bases.pdf" } = {}) {
  if (!isGeminiAvailable()) {
    throw new Error("GEMINI_API_KEY no configurada");
  }

  const sizeMB = Math.round(buffer.length / 1024 / 1024);
  const base64 = buffer.toString("base64");

  const userText = `Analiza este PDF de Bases SEACE (proceso de obra). Extrae TODOS los campos del schema:

1. **Requisitos de experiencia del postor** (monto en S/, tipos de obra similar, antigüedad).
2. **Plantel profesional COMPLETO** — sección "B. CAPACIDAD TÉCNICA Y PROFESIONAL" o "PLANTEL PROFESIONAL CLAVE". Lista CADA rol (Residente, Especialistas) con su experiencia general/específica en meses. Si la sección existe, NUNCA dejes el array vacío.
3. **Lugar de ejecución** — Capítulo I sección 1.5. Texto literal "Distrito X, Provincia Y, Departamento Z".

${valorReferencial ? `\nValor Referencial del proceso: S/ ${valorReferencial.toLocaleString("es-PE")} (no confundir con la experiencia requerida).` : ""}

Si es una Bases Estándar SIN rellenar (tiene placeholders [CONSIGNAR...], [ABC]), indica es_bases_integradas=false y confianza≤0.3.
Si son Bases Integradas con montos reales rellenos, extrae con precisión y confianza≥0.8.

Documento: ${filename} (${sizeMB}MB).`;

  const result = await generateStructured({
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: base64,
            },
          },
          { text: userText },
        ],
      },
    ],
  });

  return mapToResult(result.data, {
    provider: "gemini",
    model: result.model,
    usage: result.usage,
    pdfSizeMB: sizeMB,
  });
}

/**
 * Analiza texto extraído con Gemini.
 */
export async function extractRequisitosWithGeminiText(text, { valorReferencial = null } = {}) {
  if (!isGeminiAvailable()) {
    throw new Error("GEMINI_API_KEY no configurada");
  }

  // Gemini tiene 1M context — no necesita truncar casi nunca
  const MAX_CHARS = 500_000; // más generoso que Claude
  const truncated = text.length > MAX_CHARS;
  const textSlice = truncated ? text.slice(0, MAX_CHARS) : text;

  const userText = `Texto extraído de Bases SEACE (proceso de obra):
---
${textSlice}
---
${truncated ? `\n[texto truncado — ${text.length} chars totales]` : ""}
${valorReferencial ? `\nValor Referencial del proceso: S/ ${valorReferencial.toLocaleString("es-PE")}.` : ""}

Extrae TODOS los campos del schema:
1. Requisitos de experiencia del postor.
2. **Plantel profesional COMPLETO** — sección "B. CAPACIDAD TÉCNICA Y PROFESIONAL". Lista CADA rol con experiencia en meses. NUNCA dejes el array vacío si la sección existe.
3. **Lugar de ejecución** — sección 1.5, texto literal.`;

  const result = await generateStructured({
    contents: [{ role: "user", parts: [{ text: userText }] }],
  });

  return mapToResult(result.data, {
    provider: "gemini",
    model: result.model,
    usage: result.usage,
    textLength: text.length,
    truncated,
  });
}

// ============================================================================
// UTILS
// ============================================================================

function mapToResult(data, meta) {
  return {
    experienciaMonto: data.experiencia_monto_pen,
    experienciaVecesVr: data.experiencia_veces_vr,
    tiposObraSimilar: data.tipos_obra_similar || [],
    antiguedadMaxAnios: data.antiguedad_max_anios,
    experienciaObrasMin: data.experiencia_obras_min,
    esBasesIntegradas: data.es_bases_integradas,
    plantel: (data.plantel_profesional || []).map((p) => ({
      rol: p.rol,
      profesion: p.profesion || null,
      expGeneralMeses: p.experiencia_general_meses ?? null,
      expEspecificaMeses: p.experiencia_especifica_meses ?? null,
      expEspecificaEn: p.experiencia_especifica_en || null,
    })),
    lugarEjecucion: data.lugar_ejecucion || null,
    confianza: data.confianza ?? 0,
    citas: data.citas || [],
    notas: data.notas || null,
    meta,
  };
}
