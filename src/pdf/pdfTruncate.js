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
 * Estructura típica Bases SEACE:
 *   - Sección General (pags 1-15): disposiciones comunes, glosario
 *   - Cap I Generalidades (pags 15-25)
 *   - Cap II Procedimiento (pags 25-40)
 *   - **Cap III Requerimientos / Requisitos de Calificación** (pags 40-70) ← KEY
 *   - Cap IV Factores de evaluación (pags 70-80)
 *   - Anexos (pags 80+)
 *
 * Los REQUISITOS DEL POSTOR (experiencia mínima, tipos obra, antigüedad)
 * viven en Capítulo III. Empíricamente en PDFs de 80-120 pág están en la
 * mitad-final (~60-90%).
 *
 * Estrategia: HEAD + TAIL
 *   - head: primeras 5 (intro, datos generales, cronograma)
 *   - tail: últimas N (donde vive Cap III + Cap IV)
 * Cubre Cap III/IV que casi siempre están antes de los Anexos finales.
 */
async function smartPageSelection(srcDoc, maxPages) {
  const total = srcDoc.getPageCount();
  if (total <= maxPages) {
    return Array.from({ length: total }, (_, i) => i);
  }

  const headSize = 5;
  const tailSize = maxPages - headSize;

  const indices = new Set();
  for (let i = 0; i < headSize; i++) indices.add(i);

  // cola: últimas tailSize páginas
  const tailStart = Math.max(headSize, total - tailSize);
  for (let i = tailStart; i < total; i++) indices.add(i);

  return [...indices].sort((a, b) => a - b);
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
