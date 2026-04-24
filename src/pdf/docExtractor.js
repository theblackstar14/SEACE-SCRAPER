/**
 * Extractor unificado: PDF / ZIP / DOCX / (RAR no soportado) → texto plano.
 *
 * Antes existía zipExtractor.js + textExtractor.js por separado. Ahora un solo
 * entrypoint que recibe { filename, buffer, tipo } de la descarga SEACE y
 * devuelve { text, filesProcessed, errors, source }.
 */

import { extractText, extractTextFromMany } from "./textExtractor.js";
import { extractPdfsFromZip } from "./zipExtractor.js";
import mammoth from "mammoth";

/**
 * Extrae texto de un archivo docx vía mammoth (no trae formato, solo texto plano).
 */
async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return {
    text: result.value || "",
    messages: result.messages || [],
  };
}

/**
 * Entrypoint principal.
 * @param {object} descarga { filename, buffer, tipo }
 * @returns { text, source, errors, meta }
 */
export async function extractTextFromDoc({ filename, buffer, tipo }) {
  const ext = (tipo || "").toLowerCase();
  const errors = [];

  if (ext === "pdf") {
    try {
      const { text, numPages } = await extractText(buffer);
      return {
        text,
        source: "pdf",
        errors,
        meta: { pages: numPages, files: [filename] },
      };
    } catch (e) {
      errors.push({ name: filename, error: e.message });
      return { text: "", source: "pdf", errors, meta: { pages: 0, files: [] } };
    }
  }

  if (ext === "docx") {
    try {
      const { text, messages } = await extractTextFromDocx(buffer);
      return {
        text,
        source: "docx",
        errors,
        meta: { pages: null, files: [filename], warnings: messages?.slice(0, 5) || [] },
      };
    } catch (e) {
      errors.push({ name: filename, error: e.message });
      return { text: "", source: "docx", errors, meta: { pages: 0, files: [] } };
    }
  }

  if (ext === "zip") {
    // extrae todo el contenido del zip (pdfs + docx + más)
    const entries = extractPdfsFromZip(buffer, { includeAll: true });

    // listado detallado de TODO lo que hay en el ZIP (para debug)
    const allEntries = entries.map((e) => ({
      name: e.name,
      size: e.size,
      ext: (e.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase(),
    }));

    // procesa cada archivo interno
    const parts = [];
    const files = [];
    let totalPages = 0;

    for (const entry of entries) {
      const innerExt = (entry.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
      try {
        if (innerExt === "pdf") {
          const { text, numPages } = await extractText(entry.buffer);
          parts.push(`\n\n--- FILE: ${entry.name} (pdf, ${numPages}p) ---\n${text}`);
          totalPages += numPages;
          files.push(entry.name);
        } else if (innerExt === "docx") {
          const { text } = await extractTextFromDocx(entry.buffer);
          parts.push(`\n\n--- FILE: ${entry.name} (docx) ---\n${text}`);
          files.push(entry.name);
        } else if (innerExt === "doc") {
          // .doc (Word 97-2003) NO soportado por mammoth — flaguear
          errors.push({
            name: entry.name,
            error: ".doc (Word 97-2003) requiere conversion previa — no soportado",
          });
        }
        // otros tipos (xls, dwg, jpg, png...) no aportan texto
      } catch (e) {
        errors.push({ name: entry.name, error: e.message });
      }
    }

    // si nada rindió texto, loggear el contenido para diagnóstico
    if (parts.join("").length < 100 && allEntries.length > 0) {
      console.warn(
        `[zip] ${filename} no rindió texto. Contenido (${allEntries.length} entries):`,
        allEntries.slice(0, 20).map((e) => `${e.name} (${(e.size / 1024).toFixed(0)}KB)`).join(", ")
      );
    }

    return {
      text: parts.join(""),
      source: "zip",
      errors,
      meta: {
        pages: totalPages,
        files,
        entriesInZip: entries.length,
        allEntries: allEntries.slice(0, 30), // incluye primeros 30 en meta
      },
    };
  }

  if (ext === "rar") {
    return {
      text: "",
      source: "rar",
      errors: [{ name: filename, error: ".rar no soportado (necesita node-unrar-js)" }],
      meta: { pages: 0, files: [] },
    };
  }

  return {
    text: "",
    source: ext || "unknown",
    errors: [{ name: filename, error: `tipo no soportado: ${ext}` }],
    meta: { pages: 0, files: [] },
  };
}
