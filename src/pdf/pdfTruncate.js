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
 * En Bases SEACE los requisitos de calificación (Capítulo III) suelen
 * estar al medio-final del documento, no al inicio. Si el PDF es muy
 * grande tomamos un rango SMART: primeras 5 (índice/datos generales)
 * + páginas del "medio" (donde está Cap III típicamente).
 */
async function smartPageSelection(srcDoc, maxPages) {
  const total = srcDoc.getPageCount();
  if (total <= maxPages) {
    return Array.from({ length: total }, (_, i) => i);
  }

  // estrategia: primeras 5 (intro, cronograma, datos) + medio
  const headSize = 5;
  const restSize = maxPages - headSize;

  // el "medio" tipo ~30% del doc. Ej: doc 100 pags, max 40 → head[0..4] + mid[25..59]
  const midStart = Math.floor(total * 0.25);
  const midEnd = Math.min(midStart + restSize, total);
  const adjMidStart = midEnd - restSize; // ajuste si no llega

  const indices = [];
  for (let i = 0; i < headSize; i++) indices.push(i);
  for (let i = adjMidStart; i < midEnd; i++) {
    if (!indices.includes(i)) indices.push(i);
  }

  return indices.sort((a, b) => a - b);
}

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

  // smart page selection: intro + medio del PDF (donde vive Cap III Requisitos)
  const indices = await smartPageSelection(srcDoc, maxPages);
  const destDoc = await PDFDocument.create();
  const pages = await destDoc.copyPages(srcDoc, indices);
  pages.forEach((p) => destDoc.addPage(p));

  const truncatedBytes = await destDoc.save();
  const reason = [
    excesoPaginas ? `${totalPages} páginas > max ${maxPages}` : null,
    excesoTamano ? `${Math.round(originalSize / 1024 / 1024)}MB > max ${CLAUDE_PDF_LIMIT_BYTES / 1024 / 1024}MB` : null,
  ].filter(Boolean).join(" + ");

  return {
    buffer: Buffer.from(truncatedBytes),
    pagesIncluded: indices.length,
    pagesSelected: indices, // transparencia: qué páginas exactas mandamos
    totalPages,
    wasCropped: true,
    originalSize,
    reason,
  };
}

export { CLAUDE_PDF_LIMIT_BYTES, DEFAULT_MAX_PAGES };
