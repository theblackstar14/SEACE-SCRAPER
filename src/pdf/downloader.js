import { descargarDoc } from "../scraper/seaceDetalle.js";

/**
 * Descarga un archivo de la ficha SEACE por nombre.
 * Reusa el flow existente (abre buscador → ficha → click descarga).
 *
 * Retorna { filename, buffer, size, tipo }.
 */
export async function downloadDocumento({ nomenclatura, nidProceso, nidConvocatoria, filename, filters }) {
  const out = await descargarDoc({ nomenclatura, nidProceso, nidConvocatoria, filename, filters });
  const tipo = (out.filename.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  return { ...out, tipo };
}
