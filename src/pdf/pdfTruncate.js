import { PDFDocument } from "pdf-lib";

/**
 * Claude API tiene DOS límites independientes al recibir PDFs:
 *   1. Tamaño base64: ~32 MB → 24 MB raw
 *   2. Tokens totales: 200k context. Cada página PDF tokeniza ~1500-3500
 *      tokens dependiendo de densidad de texto/imgs. 100 páginas = ~250k
 *      tokens → REBOTA con "prompt too long"
 *
 * Por eso truncamos por AMBOS criterios: páginas y tamaño.
 */

const CLAUDE_PDF_LIMIT_BYTES = 24 * 1024 * 1024; // 24MB raw
const DEFAULT_MAX_PAGES = 40; // ~80-120k tokens — margen cómodo bajo 200k

/**
 * Trunca un PDF si supera límite de páginas o tamaño.
 * Retorna { buffer, pagesIncluded, totalPages, wasCropped, originalSize, reason }
 */
export async function truncateForClaude(buffer, { maxPages = DEFAULT_MAX_PAGES } = {}) {
  const originalSize = buffer.length;

  let srcDoc;
  try {
    srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  } catch (e) {
    // PDF corrupto — devolver como está, Claude reportará
    return {
      buffer,
      pagesIncluded: null,
      totalPages: null,
      wasCropped: false,
      originalSize,
      reason: `no se pudo leer metadata: ${e.message}`,
    };
  }

  const totalPages = srcDoc.getPageCount();
  const excesoPaginas = totalPages > maxPages;
  const excesoTamano = originalSize > CLAUDE_PDF_LIMIT_BYTES;

  if (!excesoPaginas && !excesoTamano) {
    return { buffer, pagesIncluded: totalPages, totalPages, wasCropped: false, originalSize };
  }

  // recorte: tomar las primeras maxPages
  const pagesToCopy = Math.min(maxPages, totalPages);
  const destDoc = await PDFDocument.create();
  const indices = Array.from({ length: pagesToCopy }, (_, i) => i);
  const pages = await destDoc.copyPages(srcDoc, indices);
  pages.forEach((p) => destDoc.addPage(p));

  const truncatedBytes = await destDoc.save();
  const reason = [
    excesoPaginas ? `${totalPages} páginas > max ${maxPages}` : null,
    excesoTamano ? `${Math.round(originalSize / 1024 / 1024)}MB > max ${CLAUDE_PDF_LIMIT_BYTES / 1024 / 1024}MB` : null,
  ].filter(Boolean).join(" + ");

  return {
    buffer: Buffer.from(truncatedBytes),
    pagesIncluded: pagesToCopy,
    totalPages,
    wasCropped: true,
    originalSize,
    reason,
  };
}

export { CLAUDE_PDF_LIMIT_BYTES, DEFAULT_MAX_PAGES };
