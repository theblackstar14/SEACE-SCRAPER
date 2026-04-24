// pdf-parse tiene side-effect en index.js (intenta leer un test PDF).
// Import directo al módulo interno evita el issue.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * Extrae texto plano de un PDF (Buffer).
 * Retorna { text, numPages, info, meta } o lanza si corrupto.
 */
export async function extractText(buffer) {
  const result = await pdfParse(buffer);
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
