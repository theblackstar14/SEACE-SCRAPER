import AdmZip from "adm-zip";

/**
 * Extrae PDFs (y opcionalmente otros archivos) desde un Buffer ZIP.
 *
 * Retorna array de { name, buffer, size } ordenado por relevancia:
 *   - "Bases Integradas*.pdf" primero
 *   - luego cualquier PDF
 *   - ignora archivos no-PDF por default
 */
export function extractPdfsFromZip(buffer, { includeAll = false } = {}) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (e) {
    throw new Error(`ZIP inválido: ${e.message}`);
  }

  const entries = zip.getEntries()
    .filter((e) => !e.isDirectory)
    .filter((e) => includeAll || /\.pdf$/i.test(e.entryName));

  const items = entries.map((e) => ({
    name: e.entryName,
    buffer: e.getData(),
    size: e.header.size,
  }));

  // ranking: Bases Integradas primero, luego por tamaño descendente (más grande = más completo)
  items.sort((a, b) => {
    const aBI = /bases\s*integradas/i.test(a.name) ? 0 : 1;
    const bBI = /bases\s*integradas/i.test(b.name) ? 0 : 1;
    if (aBI !== bBI) return aBI - bBI;
    return b.size - a.size;
  });

  return items;
}

/**
 * Toma un archivo descargado de SEACE (puede ser .zip, .rar, .pdf)
 * y devuelve array de PDFs utilizables.
 *
 * Nota: .rar no se soporta aquí (requeriría node-unrar-js con complejidad).
 * Si llega .rar, se loguea y retorna vacío — fallback en evaluator.
 */
export function normalizeToPdfs({ filename, buffer, tipo }) {
  const ext = (tipo || "").toLowerCase();

  if (ext === "pdf") {
    return [{ name: filename, buffer, size: buffer.length }];
  }

  if (ext === "zip") {
    return extractPdfsFromZip(buffer);
  }

  if (ext === "rar") {
    console.warn(`[zip] archivo .rar no soportado: ${filename}`);
    return [];
  }

  console.warn(`[zip] tipo no soportado: ${ext} (${filename})`);
  return [];
}
