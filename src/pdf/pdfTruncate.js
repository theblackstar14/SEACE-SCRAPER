import { PDFDocument } from "pdf-lib";

/**
 * Claude API document block acepta PDFs hasta ~32 MB base64 (~24 MB raw).
 * PDFs más grandes deben truncarse.
 *
 * Estrategia: preservar primeras N páginas + páginas con "experiencia" /
 * "requisitos" si detectables (pero aquí simple: solo primeras N).
 */

const CLAUDE_PDF_LIMIT_BYTES = 24 * 1024 * 1024; // 24MB raw → ~32MB base64

/**
 * Si el PDF pasa el límite, retorna un PDF nuevo con las primeras `maxPages` páginas.
 * Si está bajo el límite, retorna el original.
 *
 * @returns { buffer, pagesIncluded, wasCropped, originalSize }
 */
export async function truncateForClaude(buffer, { maxPages = 40 } = {}) {
  const originalSize = buffer.length;

  if (originalSize <= CLAUDE_PDF_LIMIT_BYTES) {
    return { buffer, pagesIncluded: null, wasCropped: false, originalSize };
  }

  const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();
  const pagesToCopy = Math.min(maxPages, totalPages);

  const destDoc = await PDFDocument.create();
  const indices = Array.from({ length: pagesToCopy }, (_, i) => i);
  const pages = await destDoc.copyPages(srcDoc, indices);
  pages.forEach((p) => destDoc.addPage(p));

  const truncatedBytes = await destDoc.save();
  return {
    buffer: Buffer.from(truncatedBytes),
    pagesIncluded: pagesToCopy,
    totalPages,
    wasCropped: true,
    originalSize,
  };
}

export { CLAUDE_PDF_LIMIT_BYTES };
