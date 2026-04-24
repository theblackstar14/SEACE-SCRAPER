import { config } from "../config/config.js";
import { withRetry } from "../browserPool.js";
import { SEL, T, OBJETO } from "./selectors.js";
import { parseTable, parsePaginatorInfo } from "./parser.js";

/**
 * Formatea Date → "DD/MM/YYYY" para inputs PrimeFaces SEACE.
 */
export function formatSeaceDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yy = dt.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

/**
 * Espera a que termine un ciclo XHR PrimeFaces (update JSF).
 * Algunas acciones disparan request, otras no. Fallback a timeout corto.
 */
async function waitJsfCycle(page, { trigger, timeout = T.results }) {
  const respPromise = page
    .waitForResponse(
      (r) => r.url().includes("buscadorPublico") && r.request().method() === "POST",
      { timeout }
    )
    .catch(() => null);
  await trigger();
  await respPromise;
  // settle corto del DOM post-update
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}

/**
 * Selecciona valor en un PrimeFaces selectOneMenu.
 * Estrategia: clic al label → panel visible → click al <li> con texto deseado.
 */
async function selectPrimeMenu(page, { dropdownId, labelId, panelId, value }) {
  // abre panel
  await page.click(labelId);
  await page.waitForSelector(`${panelId}.ui-selectonemenu-panel`, {
    state: "visible",
    timeout: 5000,
  }).catch(async () => {
    // fallback: panel sin class refresh
    await page.waitForSelector(panelId, { state: "visible", timeout: 5000 });
  });

  // click en el <li> cuyo texto coincide
  const option = await page.locator(`${panelId} li`, { hasText: new RegExp(`^${value}$`, "i") }).first();
  await option.click({ timeout: 5000 });

  // verificar label actualizado
  await page.waitForFunction(
    ({ lid, v }) => {
      const el = document.querySelector(lid);
      return el && el.textContent.trim().toLowerCase() === v.toLowerCase();
    },
    { lid: labelId, v: value },
    { timeout: 5000 }
  ).catch(() => {});
}

/**
 * Expande "Búsqueda Avanzada" si está colapsada.
 */
async function ensureAvanzadaOpen(page) {
  // si ya está abierto, el toggler tiene class ui-icon-minusthick; si cerrado, plusthick
  const isClosed = await page.$("legend.ui-fieldset-legend .ui-icon-plusthick");
  if (isClosed) {
    await page.click("legend.ui-fieldset-legend");
    await page.waitForSelector(SEL.fechaInicioInput, { state: "visible", timeout: 5000 });
  }
}

/**
 * Llena input datepicker PrimeFaces. Usa fill directo y dispara blur para sincronizar widget.
 */
async function setDatepicker(page, selector, value) {
  if (!value) return;
  await page.click(selector);
  await page.fill(selector, value);
  await page.keyboard.press("Escape"); // cerrar calendar popup si apareció
  // blur para que PrimeFaces registre
  await page.evaluate((sel) => document.querySelector(sel)?.blur(), selector);
}

/**
 * Cambia rows-per-page del paginador al máximo (20).
 */
async function setMaxRowsPerPage(page) {
  const select = await page.$(SEL.paginatorRpp);
  if (!select) return;
  const current = await select.evaluate((el) => el.value);
  if (current === "20") return;
  await waitJsfCycle(page, {
    trigger: () => select.selectOption("20"),
  });
}

/**
 * Abre buscador SEACE con filtros.
 *
 * @param {import('playwright').Page} page
 * @param {object} filters
 *   - objetoContratacion: "Bien"|"Servicio"|"Consultoría"|"Obra"
 *   - fechaDesde: Date | string "DD/MM/YYYY"
 *   - fechaHasta: Date | string
 *   - anio: number (default: año actual America/Lima)
 */
export async function openBuscador(page, filters = {}) {
  await withRetry(
    async () => {
      await page.goto(config.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: T.goto,
      });
    },
    { label: "goto buscador" }
  );

  // cambiar a tab "Buscador de Procedimientos de Selección"
  await page.waitForSelector(SEL.tabBuscador, { timeout: T.selector });
  await page.click(SEL.tabBuscador);

  // esperar form listo
  await page.waitForSelector(SEL.btnBuscar, { state: "visible", timeout: T.selector });

  // filtro: Objeto de Contratación
  if (filters.objetoContratacion) {
    await selectPrimeMenu(page, {
      dropdownId: SEL.objetoDropdown,
      labelId: SEL.objetoLabel,
      panelId: SEL.objetoPanel,
      value: filters.objetoContratacion,
    });
  }

  // filtros de fecha → abrir avanzada
  const needAvanzada = filters.fechaDesde || filters.fechaHasta;
  if (needAvanzada) {
    await ensureAvanzadaOpen(page);
    if (filters.fechaDesde) {
      const v = typeof filters.fechaDesde === "string" ? filters.fechaDesde : formatSeaceDate(filters.fechaDesde);
      await setDatepicker(page, SEL.fechaInicioInput, v);
    }
    if (filters.fechaHasta) {
      const v = typeof filters.fechaHasta === "string" ? filters.fechaHasta : formatSeaceDate(filters.fechaHasta);
      await setDatepicker(page, SEL.fechaFinInput, v);
    }
  }

  // disparar búsqueda, esperando XHR JSF
  await waitJsfCycle(page, {
    trigger: () => page.click(SEL.btnBuscar),
  });

  // confirmar tabla poblada (o "No se encontraron Datos")
  await page.waitForSelector(SEL.resultsTable, { timeout: T.results });

  // maximizar rows-per-page para reducir pagination
  await setMaxRowsPerPage(page).catch(() => {});
}

/**
 * Lee paginator info de la página actual.
 */
export async function getPaginatorInfo(page) {
  const el = await page.$(SEL.paginatorInfo);
  if (!el) return null;
  const txt = await el.textContent();
  return parsePaginatorInfo(txt || "");
}

/**
 * Itera todas las páginas de resultados y acumula filas.
 * @param {object} opts
 *   - maxRows: cota máxima de filas a acumular
 *   - maxPages: cota máxima de páginas a visitar
 */
export async function collectAllPages(page, { maxRows = Infinity, maxPages = 50 } = {}) {
  const all = [];
  let pageIdx = 0;

  while (pageIdx < maxPages) {
    const html = await page.$eval(SEL.resultsPanel, (el) => el.innerHTML);
    const rows = parseTable(html);
    all.push(...rows);
    if (all.length >= maxRows) return all.slice(0, maxRows);

    const next = await page.$(SEL.paginatorNext);
    if (!next) break;

    await waitJsfCycle(page, {
      trigger: () => next.click(),
    });
    pageIdx++;
  }

  return all;
}

/**
 * Busca una fila específica en la página actual.
 * Si no está, intenta paginar hasta encontrar.
 */
export async function findRow(page, { nomenclatura, nidProceso, maxPages = 20 }) {
  for (let p = 0; p < maxPages; p++) {
    const handle = await page.evaluateHandle(
      ({ sel, nom, nid }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const rows = document.querySelectorAll(sel);
        for (const r of rows) {
          const cells = r.querySelectorAll("td");
          // nomenclatura está en col idx 3 (según thead observado)
          if (nom && cells[3] && norm(cells[3].innerText) === norm(nom)) return r;
          if (nid) {
            // buscar onclick con nidProceso en el link de ficha
            const fichaLink = r.querySelector("a:has(img[src*='fichaSeleccion'])") ||
                              [...r.querySelectorAll("a[onclick]")].find((a) =>
                                (a.getAttribute("onclick") || "").includes(`'nidProceso':'${nid}'`)
                              );
            if (fichaLink && (fichaLink.getAttribute("onclick") || "").includes(`'nidProceso':'${nid}'`)) {
              return r;
            }
          }
        }
        return null;
      },
      { sel: SEL.resultsRows, nom: nomenclatura, nid: nidProceso }
    );

    if (handle.asElement()) return handle;

    const next = await page.$(SEL.paginatorNext);
    if (!next) return null;
    await waitJsfCycle(page, {
      trigger: () => next.click(),
    });
  }
  return null;
}

/**
 * Abre ficha (detalle) de una fila.
 */
export async function openFicha(page, rowHandle) {
  const rowEl = rowHandle.asElement();
  if (!rowEl) throw new Error("row handle inválido");
  const btn = await rowEl.$(SEL.fichaBtn);
  if (!btn) throw new Error("botón ficha no encontrado en fila");
  await btn.click();
  await page.waitForSelector(SEL.fichaReady, { timeout: T.ficha });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
}

/**
 * Flow: abre buscador (con filtros opcionales) → busca fila → abre ficha.
 */
export async function navigateToFicha(page, { nomenclatura, nidProceso, filters }) {
  await openBuscador(page, filters || {});
  const row = await findRow(page, { nomenclatura, nidProceso });
  if (!row) throw new Error("Proceso no encontrado");
  await openFicha(page, row);
}

export { OBJETO };
