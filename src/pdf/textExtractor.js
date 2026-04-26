// pdf-parse tiene side-effect en index.js (intenta leer un test PDF).
// Import directo al módulo interno evita el issue.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// patrones de warnings ruidosos de pdfjs-dist que podemos ignorar.
// Solo afectan a fidelidad visual de fuentes; la extracción de texto sigue OK.
const NOISY_PATTERNS = [
  /Ran out of space in font private use area/i,
  /TT: undefined function/i,
  /Warning: Indexing all PDF objects/i,
  /Warning: Unsupported feature/i,
  /Warning: getPdfManager/i,
];

function isNoisy(args) {
  const msg = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
  return NOISY_PATTERNS.some((p) => p.test(msg));
}

/**
 * Silencia temporalmente warnings ruidosos de pdfjs mientras se ejecuta fn().
 */
async function suppressPdfNoise(fn) {
  const origWarn = console.warn;
  const origLog = console.log;
  const origErr = console.error;
  console.warn = (...args) => { if (!isNoisy(args)) origWarn(...args); };
  console.log = (...args) => { if (!isNoisy(args)) origLog(...args); };
  console.error = (...args) => { if (!isNoisy(args)) origErr(...args); };
  try {
    return await fn();
  } finally {
    console.warn = origWarn;
    console.log = origLog;
    console.error = origErr;
  }
}

/**
 * Extrae texto plano de un PDF (Buffer).
 * Retorna { text, numPages, info, meta } o lanza si corrupto.
 */
export async function extractText(buffer) {
  const result = await suppressPdfNoise(() => pdfParse(buffer));
  return {
    text: result.text || "",
    numPages: result.numpages || 0,
    info: result.info || {},
    meta: result.metadata || null,
  };
}

/**
 * Extrae texto de múltiples PDFs y concatena. Útil cuando ZIP tiene varios.
 * Marca separadores `--- FILE: <name> ---` para que los regex sepan dónde están.
 */
export async function extractTextFromMany(pdfs) {
  const parts = [];
  let totalPages = 0;
  const errors = [];

  for (const pdf of pdfs) {
    try {
      const { text, numPages } = await extractText(pdf.buffer);
      parts.push(`\n\n--- FILE: ${pdf.name} (${numPages} pags) ---\n\n${text}`);
      totalPages += numPages;
    } catch (e) {
      errors.push({ name: pdf.name, error: e.message });
      console.warn(`[pdf] falla extrayendo ${pdf.name}: ${e.message}`);
    }
  }

  return {
    text: parts.join(""),
    totalPages,
    filesProcessed: pdfs.length - errors.length,
    errors,
  };
}
