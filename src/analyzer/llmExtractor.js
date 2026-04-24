/**
 * Extractor de requisitos SEACE con Claude (Haiku vision).
 *
 * Usado como fallback cuando:
 *  - PDF es escaneado (regex no funciona)
 *  - Regex extrajo monto sospechoso (ej: igual al VR)
 *  - Texto es muy corto o template sin montos
 *
 * Ventaja: Claude tiene OCR interno en document blocks → funciona sobre
 * PDFs escaneados sin tesseract. También razona sobre el texto para
 * distinguir experiencia mínima vs VR vs otros montos.
 */

import { createMessage, extractToolInput, isLlmAvailable, defaultModel } from "../llm/claude.js";
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

Siempre responde invocando el tool registrar_requisitos_seace.`;

/**
 * Analiza un PDF con Claude — document block (OCR interno).
 */
export async function extractRequisitosWithClaudePdf(buffer, { valorReferencial = null, filename = "bases.pdf" } = {}) {
  if (!isLlmAvailable()) {
    throw new Error("ANTHROPIC_API_KEY no configurada");
  }

  // truncar si necesario (Claude limit ~32MB base64)
  const trunc = await truncateForClaude(buffer, { maxPages: 40 });

  const userText = `Analiza este documento de Bases SEACE y extrae los requisitos de calificación del postor.
${
  valorReferencial
    ? `\nValor Referencial del proceso: S/ ${valorReferencial.toLocaleString("es-PE")} (no confundir con la experiencia requerida).`
    : ""
}
${
  trunc.wasCropped
    ? `\nNota: el documento original es grande (${Math.round(trunc.originalSize / 1024 / 1024)}MB, ${trunc.totalPages} páginas). Se te envían las primeras ${trunc.pagesIncluded} páginas. Los requisitos usualmente están al inicio del Capítulo "Requisitos de Calificación".`
    : ""
}

Si es una Bases Estándar SIN rellenar (tiene placeholders [CONSIGNAR...]), indica es_bases_integradas=false y confianza≤0.3.
Si son Bases Integradas con montos reales, extrae con precisión y confianza≥0.8.`;

  const message = await createMessage({
    model: defaultModel(),
    max_tokens: 1024,
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
            cache_control: { type: "ephemeral" }, // prompt caching
          },
          { type: "text", text: userText },
        ],
      },
    ],
  });

  const input = extractToolInput(message, EXTRACCION_TOOL.name);
  if (!input) {
    throw new Error("Claude no invocó el tool");
  }

  return {
    experienciaMonto: input.experiencia_monto_pen,
    experienciaVecesVr: input.experiencia_veces_vr,
    tiposObraSimilar: input.tipos_obra_similar || [],
    antiguedadMaxAnios: input.antiguedad_max_anios,
    experienciaObrasMin: input.experiencia_obras_min,
    esBasesIntegradas: input.es_bases_integradas,
    confianza: input.confianza ?? 0,
    citas: input.citas || [],
    notas: input.notas || null,
    meta: {
      model: message.model,
      usage: message.usage,
      wasCropped: trunc.wasCropped,
      pagesAnalyzed: trunc.pagesIncluded || null,
      truncatedFrom: trunc.wasCropped ? { totalPages: trunc.totalPages, originalMB: Math.round(trunc.originalSize / 1024 / 1024) } : null,
    },
  };
}

/**
 * Alternativa: analiza TEXTO ya extraído (para cuando tenemos texto pero regex falló).
 * Mucho más barato que PDF (solo texto tokens).
 */
export async function extractRequisitosWithClaudeText(text, { valorReferencial = null } = {}) {
  if (!isLlmAvailable()) {
    throw new Error("ANTHROPIC_API_KEY no configurada");
  }

  // SMART TEXT SELECTION: si el texto es largo, buscar sección "Requisitos de
  // Calificación" (donde vive experiencia mínima) y mandar esa ventana.
  // Fallback a primeros N chars si no encontramos el anchor.
  const MAX_CHARS = 40000;
  const truncated = text.length > MAX_CHARS;
  let textSlice = text;
  if (truncated) {
    const tlow = text.toLowerCase();
    const anchors = [
      "requisitos de calificaci",
      "requisitos de calif",
      "experiencia del postor",
      "capítulo iii",
      "capitulo iii",
    ];
    let anchorIdx = -1;
    for (const a of anchors) {
      const idx = tlow.indexOf(a);
      if (idx >= 0) {
        anchorIdx = idx;
        break;
      }
    }
    if (anchorIdx >= 0) {
      // ventana: 5k antes del anchor + 35k después
      const start = Math.max(0, anchorIdx - 5000);
      const end = Math.min(text.length, start + MAX_CHARS);
      textSlice = text.slice(start, end);
    } else {
      textSlice = text.slice(0, MAX_CHARS);
    }
  }

  const userText = `Texto extraído de las Bases SEACE (PDF plano):
---
${textSlice}
---
${truncated ? `\n[texto truncado — ${text.length} chars totales, solo primeros ${MAX_CHARS}]` : ""}
${
  valorReferencial
    ? `\nValor Referencial del proceso: S/ ${valorReferencial.toLocaleString("es-PE")}.`
    : ""
}

Extrae los requisitos de calificación del postor.`;

  const message = await createMessage({
    model: defaultModel(),
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [EXTRACCION_TOOL],
    tool_choice: { type: "tool", name: EXTRACCION_TOOL.name },
    messages: [{ role: "user", content: userText }],
  });

  const input = extractToolInput(message, EXTRACCION_TOOL.name);
  if (!input) throw new Error("Claude no invocó el tool");

  return {
    experienciaMonto: input.experiencia_monto_pen,
    experienciaVecesVr: input.experiencia_veces_vr,
    tiposObraSimilar: input.tipos_obra_similar || [],
    antiguedadMaxAnios: input.antiguedad_max_anios,
    experienciaObrasMin: input.experiencia_obras_min,
    esBasesIntegradas: input.es_bases_integradas,
    confianza: input.confianza ?? 0,
    citas: input.citas || [],
    notas: input.notas || null,
    meta: {
      model: message.model,
      usage: message.usage,
      textLength: text.length,
      truncated,
    },
  };
}
