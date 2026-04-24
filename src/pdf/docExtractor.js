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

const MAX_ZIP_DEPTH = 3; // evita loops / zip bombs

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
 * Extrae texto de un ZIP con soporte recursivo (ZIPs anidados — común en SEACE).
 * SEACE a veces empaca "Bases+Administrativas.zip" que contiene adentro
 * "BASES+INTEGRADAS.zip" → tenemos que recursar.
 */
async function extractFromZipBuffer(buffer, { filename = "archive.zip", errors = [], depth = 0, prefix = "" } = {}) {
  if (depth >= MAX_ZIP_DEPTH) {
    errors.push({ name: filename, error: `ZIP depth > ${MAX_ZIP_DEPTH}, stop recursion` });
    return { text: "", source: "zip", errors, meta: { pages: 0, files: [], allEntries: [] } };
  }

  const entries = extractPdfsFromZip(buffer, { includeAll: true });

  const allEntries = entries.map((e) => ({
    name: (prefix ? `${prefix}/` : "") + e.name,
    size: e.size,
    ext: (e.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase(),
  }));

  const parts = [];
  const files = [];
  let totalPages = 0;

  for (const entry of entries) {
    const entryName = (prefix ? `${prefix}/` : "") + entry.name;
    const innerExt = (entry.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    try {
      if (innerExt === "pdf") {
        const { text, numPages } = await extractText(entry.buffer);
        parts.push(`\n\n--- FILE: ${entryName} (pdf, ${numPages}p) ---\n${text}`);
        totalPages += numPages;
        files.push(entryName);
      } else if (innerExt === "docx") {
        const { text } = await extractTextFromDocx(entry.buffer);
        parts.push(`\n\n--- FILE: ${entryName} (docx) ---\n${text}`);
        files.push(entryName);
      } else if (innerExt === "zip") {
        // RECURSIVO — ZIPs anidados
        console.log(`[zip] recursando en ${entryName} (depth ${depth + 1})`);
        const nested = await extractFromZipBuffer(entry.buffer, {
          filename: entry.name,
          errors,
          depth: depth + 1,
          prefix: entryName,
        });
        if (nested.text) {
          parts.push(nested.text);
          totalPages += nested.meta?.pages || 0;
          files.push(...(nested.meta?.files || []));
          // merge inner entries en allEntries (para debug completo)
          if (nested.meta?.allEntries) {
            allEntries.push(...nested.meta.allEntries);
          }
        }
      } else if (innerExt === "doc") {
        errors.push({
          name: entryName,
          error: ".doc (Word 97-2003) requiere conversión previa — no soportado",
        });
      }
      // xls, dwg, jpg, png ignorados (no texto)
    } catch (e) {
      errors.push({ name: entryName, error: e.message });
    }
  }

  if (parts.join("").length < 100 && allEntries.length > 0 && depth === 0) {
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
      allEntries: allEntries.slice(0, 50),
      recursedDepth: depth,
    },
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
    return extractFromZipBuffer(buffer, { filename, errors, depth: 0 });
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
