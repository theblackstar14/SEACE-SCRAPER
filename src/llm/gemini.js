import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

/**
 * Cliente Gemini. Ventaja sobre Claude para este caso:
 *  - Context window 1M tokens (vs 200k Claude) → PDFs grandes sin truncar
 *  - OCR interno excelente para escaneados
 *  - 10× más barato en input tokens ($0.075/1M vs $0.80/1M)
 *  - Rate limits más generosos (250k TPM vs 50k)
 *  - Native structured output via responseSchema
 *
 * Env:
 *   GEMINI_API_KEY — requerido
 *   GEMINI_MODEL   — default "gemini-2.5-flash" (rápido + barato)
 */

let client = null;

function getClient() {
  if (client) return client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY no está en env");
  }
  client = new GoogleGenerativeAI(apiKey);
  return client;
}

export function isGeminiAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

export function defaultGeminiModel() {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

// Schema para extracción estructurada de requisitos SEACE
export const REQUISITOS_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    experiencia_monto_pen: {
      type: SchemaType.NUMBER,
      description: "Monto mínimo en soles de experiencia del postor en obras similares. 0 si no aplica.",
      nullable: true,
    },
    experiencia_veces_vr: {
      type: SchemaType.NUMBER,
      description: "Si el requisito se expresa como 'N veces el valor referencial', indica N.",
      nullable: true,
    },
    tipos_obra_similar: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Tipos de obra similar (edificacion, saneamiento, carretera, puente, educativa, salud, deportiva, riego, electrico, muros).",
    },
    antiguedad_max_anios: {
      type: SchemaType.NUMBER,
      description: "Antigüedad máxima en años de obras acreditables.",
      nullable: true,
    },
    experiencia_obras_min: {
      type: SchemaType.NUMBER,
      description: "Número mínimo de obras que debe acreditar el postor.",
      nullable: true,
    },
    es_bases_integradas: {
      type: SchemaType.BOOLEAN,
      description: "true si el doc tiene los requisitos finales rellenos. false si es template.",
    },
    confianza: {
      type: SchemaType.NUMBER,
      description: "Qué tan seguro estás de la extracción (0.0 a 1.0).",
    },
    citas: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: "Hasta 3 fragmentos literales del documento como evidencia (máx 200 chars cada uno).",
    },
    notas: {
      type: SchemaType.STRING,
      description: "Observaciones para el evaluador.",
      nullable: true,
    },
  },
  required: [
    "experiencia_monto_pen",
    "tipos_obra_similar",
    "es_bases_integradas",
    "confianza",
    "citas",
  ],
};

const SYSTEM_INSTRUCTION = `Eres experto en contratación pública peruana (OSCE/OECE/SEACE).
Tu tarea: extraer de las Bases de un proceso SEACE de OBRA los requisitos de calificación técnica del postor.

Claves:
- SEACE tiene Bases Estándar (template con marcadores [ABC] sin rellenar) y Bases Integradas (rellenas con montos reales).
- Los requisitos de calificación viven en el Capítulo III — típicamente a mitad del documento.
- Experiencia del postor: "monto acumulado no menor a S/ X" o "equivalente a N veces el valor referencial".
- NO confundir VR/Valor Referencial/Cuantía con la experiencia requerida — son distintos.

Siempre responde con JSON estructurado según el schema.`;

/**
 * Genera contenido estructurado con Gemini.
 *
 * @param {object} opts
 *   - contents: array de content parts (texto o inlineData PDF)
 *   - temperature: default 0.1 (determinístico)
 *   - systemInstruction: override del sistema
 *   - schema: schema de respuesta (default REQUISITOS_SCHEMA)
 */
export async function generateStructured(opts) {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: defaultGeminiModel(),
    systemInstruction: opts.systemInstruction || SYSTEM_INSTRUCTION,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: opts.schema || REQUISITOS_SCHEMA,
      temperature: opts.temperature ?? 0.1,
      maxOutputTokens: opts.maxOutputTokens || 2048,
    },
  });

  const result = await model.generateContent({
    contents: opts.contents,
  });

  const response = result.response;
  const text = response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini no devolvió JSON válido: ${text.slice(0, 200)}`);
  }

  return {
    data: parsed,
    usage: {
      promptTokens: response.usageMetadata?.promptTokenCount || null,
      candidatesTokens: response.usageMetadata?.candidatesTokenCount || null,
      totalTokens: response.usageMetadata?.totalTokenCount || null,
    },
    model: defaultGeminiModel(),
  };
}
