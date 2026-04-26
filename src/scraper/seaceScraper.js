import { withPage } from "../browserPool.js";
import { openBuscador, collectAllPages, getPaginatorInfo, OBJETO } from "./common.js";

/**
 * Scrape SEACE con filtros.
 *
 * @param {object} opts
 *   - limit: max filas a retornar (default: 50)
 *   - objetoContratacion: "Bien"|"Servicio"|"Consultoría"|"Obra"
 *   - fechaDesde: Date | "DD/MM/YYYY"
 *   - fechaHasta: Date | "DD/MM/YYYY"
 *   - allPages: bool (default false) — si true ignora limit y trae todas
 *   - maxPages: cota de páginas a visitar (default 50)
 */
export async function scrapeSeace(opts = {}) {
  const { limit = 50, allPages = false, maxPages = 50, ...filters } = opts;
  return withPage(async (page) => {
    const t0 = Date.now();
    await openBuscador(page, filters);

    const info = await getPaginatorInfo(page);
    if (info) {
      console.log(`[scrapeSeace] paginator: ${info.total} totales, ${info.pages} páginas`);
    }

    const rows = await collectAllPages(page, {
      maxRows: allPages ? Infinity : limit,
      maxPages,
    });

    console.log(
      `[scrapeSeace] ${rows.length} filas obtenidas en ${Date.now() - t0}ms` +
        (filters.objetoContratacion ? ` (filtro: ${filters.objetoContratacion})` : "")
    );
    return rows;
  });
}

export { OBJETO };
