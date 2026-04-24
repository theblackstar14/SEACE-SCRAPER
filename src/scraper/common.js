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
 * Llena input datepicker PrimeFaces de forma robusta.
 *
 * PrimeFaces usa jQuery UI datepicker internamente. La forma 100% confiable
 * es invocar `$(input).datepicker('setDate', Date)` — el mismo método que el
 * widget usa al seleccionar en el calendar. Esto actualiza tanto el input
 * visual como el state interno de PrimeFaces/jQuery UI.
 *
 * Fallback: si jQuery UI no está, emula type() + eventos.
 */
async function setDatepicker(page, selector, value) {
  if (!value) return;
  const input = page.locator(selector);
  await input.waitFor({ state: "visible", timeout: 5000 });

  // cerrar cualquier datepicker popup previamente abierto
  await page.evaluate(() => {
    if (window.jQuery?.datepicker?._hideDatepicker) {
      try {
        window.jQuery.datepicker._hideDatepicker();
      } catch {}
    }
  });

  // vía jQuery UI datepicker (preferido)
  const setOk = await page.evaluate(
    ({ sel, val }) => {
      // el selector tiene escapes CSS (\:), usamos querySelector directo
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: "input no encontrado" };

      const [dd, mm, yyyy] = val.split("/").map(Number);
      if (!dd || !mm || !yyyy) return { ok: false, reason: "fecha mal formada" };
      const date = new Date(yyyy, mm - 1, dd);

      if (window.jQuery && window.jQuery(el).datepicker) {
        try {
          // setDate actualiza input visual + state interno; onSelect handler se dispara
          window.jQuery(el).datepicker("setDate", date);
          // trigger eventos por si hay listeners extra
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          return { ok: true, via: "jQuery.datepicker" };
        } catch (e) {
          return { ok: false, reason: `jQuery.datepicker fail: ${e.message}` };
        }
      }

      // fallback crudo: set value + events
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true, via: "raw value+events" };
    },
    { sel: selector, val: value }
  );

  if (!setOk.ok) {
    console.warn(`[datepicker] ${selector} no se pudo setear: ${setOk.reason}`);
  }

  // verificar valor final
  const actual = await input.inputValue().catch(() => "");
  if (actual !== value) {
    console.warn(`[datepicker] ${selector} quedó "${actual}", esperado "${value}" (via=${setOk.via || "?"})`);
  }
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

  // log del estado de filtros antes de buscar (debug)
  const filterState = await page.evaluate(
    ({ labelId, fIni, fFin }) => ({
      objetoLabel: document.querySelector(labelId)?.textContent?.trim() || null,
      fechaIni: document.querySelector(fIni)?.value || null,
      fechaFin: document.querySelector(fFin)?.value || null,
    }),
    {
      labelId: SEL.objetoLabel,
      fIni: SEL.fechaInicioInput,
      fFin: SEL.fechaFinInput,
    }
  );
  console.log(`[openBuscador] filtros aplicados: ${JSON.stringify(filterState)}`);

  // disparar búsqueda, esperando XHR JSF
  await waitJsfCycle(page, {
    trigger: () => page.click(SEL.btnBuscar),
  });

  // confirmar tabla poblada (o "No se encontraron Datos")
  await page.waitForSelector(SEL.resultsTable, { timeout: T.results });

  // maximizar rows-per-page para reducir pagination
  await setMaxRowsPerPage(page).catch(() => {});

  // si no hay filas, dump screenshot + HTML para debug
  const rowCount = await page.$$eval(SEL.resultsRows, (rs) => rs.length).catch(() => 0);
  if (rowCount === 0 && (filters.fechaDesde || filters.fechaHasta || filters.objetoContratacion)) {
    try {
      const debugDir = "./data/debug";
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(debugDir, { recursive: true });
      const ts = Date.now();
      await page.screenshot({ path: `${debugDir}/empty-${ts}.png`, fullPage: true });
      const html = await page.content();
      await writeFile(`${debugDir}/empty-${ts}.html`, html);
      console.warn(`[openBuscador] 0 resultados con filtros — dump: ${debugDir}/empty-${ts}.{png,html}`);
    } catch (e) {
      console.warn(`[openBuscador] no pude guardar debug: ${e.message}`);
    }
  }
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
 * Dedup por nidProceso. Para temprano si:
 *   - paginator_info dice "Página X/Y" y X === Y
 *   - next click no agrega filas nuevas (página repetida)
 *   - se alcanza maxRows / maxPages
 */
export async function collectAllPages(page, { maxRows = Infinity, maxPages = 50 } = {}) {
  const all = [];
  const seen = new Set();
  let pageIdx = 0;
  let consecutiveDupPages = 0;

  while (pageIdx < maxPages) {
    const html = await page.$eval(SEL.resultsPanel, (el) => el.innerHTML);
    const rows = parseTable(html);

    let newInPage = 0;
    for (const r of rows) {
      const key = r.nidProceso || `${r.nomenclatura}|${r.fechaPublicacion}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(r);
        newInPage++;
      }
    }

    if (all.length >= maxRows) return all.slice(0, maxRows);

    // si esta página no aportó nuevas filas, probable fin (paginator no cierra bien)
    if (newInPage === 0) {
      consecutiveDupPages++;
      if (consecutiveDupPages >= 2) {
        console.log(`[collectAllPages] stop: 2 páginas sin filas nuevas (${all.length} únicas)`);
        break;
      }
    } else {
      consecutiveDupPages = 0;
    }

    // check paginator: si página actual === total, stop
    const info = await getPaginatorInfo(page);
    if (info && info.page >= info.pages) {
      break;
    }

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
 * Prioriza matching por nidProceso en onclick (robusto frente a diffs de texto).
 * Fallback: compara nomenclatura normalizada.
 * Si no está, intenta paginar hasta encontrar.
 */
export async function findRow(page, { nomenclatura, nidProceso, maxPages = 20 }) {
  for (let p = 0; p < maxPages; p++) {
    const handle = await page.evaluateHandle(
      ({ sel, nom, nid }) => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
        const rows = document.querySelectorAll(sel);
        for (const r of rows) {
          // 1. match por nidProceso en CUALQUIER onclick de la fila (más robusto)
          if (nid) {
            const links = r.querySelectorAll("a[onclick]");
            for (const a of links) {
              const oc = a.getAttribute("onclick") || "";
              if (oc.includes(`'nidProceso':'${nid}'`)) {
                return r;
              }
            }
          }
          // 2. fallback: nomenclatura en cualquier <td>
          if (nom) {
            const cells = r.querySelectorAll("td");
            for (const c of cells) {
              if (norm(c.innerText) === norm(nom)) return r;
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
 *
 * IMPORTANTE: el botón ficha es solo <a><img></a>. Con block de imgs
 * activado (headless perf), el <img> no carga → <a> queda 0×0 → Playwright
 * marca "not visible" y el click falla con timeout.
 *
 * Workaround: disparar click vía DOM directo (el.click()) — bypassa
 * chequeos de visibilidad. El onclick handler se ejecuta igual.
 */
export async function openFicha(page, rowHandle) {
  const rowEl = rowHandle.asElement();
  if (!rowEl) throw new Error("row handle inválido");
  const btn = await rowEl.$(SEL.fichaBtn);
  if (!btn) throw new Error("botón ficha no encontrado en fila");

  // esperar navegación o mutación post-submit, en paralelo al click
  const navWait = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: T.ficha })
    .catch(() => null);

  await btn.evaluate((el) => el.click());

  await navWait;
  await page.waitForSelector(SEL.fichaReady, { timeout: T.ficha });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
}

/**
 * Navega DIRECTO a la ficha usando PrimeFaces.addSubmitParam + submit del form.
 * Requiere nidProceso + nidConvocatoria (ambos capturados del listado).
 *
 * Mucho más rápido y robusto que buscar por paginación.
 * Basado en el onclick real del link "Ficha Selección":
 *   PrimeFaces.addSubmitParam('tbBuscador:idFormBuscarProceso', {
 *     'ntipo': '1',
 *     'nidConvocatoria': '...',
 *     'nidProceso': '...',
 *     'nidSistema': '3',
 *     'ptoRetorno': 'LOCAL'
 *   }).submit('tbBuscador:idFormBuscarProceso');
 */
export async function navigateToFichaDirect(page, { nidProceso, nidConvocatoria, nidSistema = "3" }) {
  if (!nidProceso || !nidConvocatoria) {
    throw new Error("navigateToFichaDirect requiere nidProceso + nidConvocatoria");
  }

  await withRetry(
    async () => {
      await page.goto(config.baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: T.goto,
      });
    },
    { label: "goto baseUrl (fichaDirect)" }
  );

  // asegurar tab buscador activo (el form vive en ese tab)
  await page.waitForSelector(SEL.tabBuscador, { timeout: T.selector });
  await page.click(SEL.tabBuscador);
  await page.waitForSelector(SEL.btnBuscar, { state: "visible", timeout: T.selector });

  // disparar submit del form con params de ficha
  const navResp = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: T.ficha })
    .catch(() => null);

  await page.evaluate(
    ({ nidProceso, nidConvocatoria, nidSistema }) => {
      const formId = "tbBuscador:idFormBuscarProceso";
      // eslint-disable-next-line no-undef
      if (typeof PrimeFaces === "undefined" || !PrimeFaces.addSubmitParam) {
        throw new Error("PrimeFaces no disponible");
      }
      // eslint-disable-next-line no-undef
      PrimeFaces.addSubmitParam(formId, {
        ntipo: "1",
        nidConvocatoria,
        nidProceso,
        nidSistema,
        ptoRetorno: "LOCAL",
      }).submit(formId);
    },
    { nidProceso, nidConvocatoria, nidSistema }
  );

  await navResp;

  // esperar panel ficha listo (o texto "Entidad Convocante")
  await page.waitForSelector(SEL.fichaReady, { timeout: T.ficha });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
}

/**
 * Flow legacy (fallback): abre buscador → busca fila → abre ficha.
 * Usar solo si NO tenemos nidConvocatoria (raro).
 */
export async function navigateToFichaViaBuscador(page, { nomenclatura, nidProceso, filters }) {
  await openBuscador(page, filters || {});
  const row = await findRow(page, { nomenclatura, nidProceso });
  if (!row) throw new Error("Proceso no encontrado");
  await openFicha(page, row);
}

/**
 * Flow actual: SIEMPRE via buscador.
 *
 * El "direct nav" via PrimeFaces.addSubmitParam está ROTO por diseño JSF:
 * el componente que dispara la acción (`:rowIdx:btnId`) debe existir en el
 * ViewState del servidor, y solo existe si la tabla ya fue renderizada con
 * esa fila específica. No hay atajo confiable.
 *
 * Con el datepicker ahora funcional y filtros aplicándose bien, via-buscador
 * es rápido: la fila target casi siempre está en página 1-2 del listado
 * filtrado. findRow por nidProceso match es O(1) en la página actual.
 */
export async function navigateToFicha(page, { nomenclatura, nidProceso, nidConvocatoria, filters }) {
  return navigateToFichaViaBuscador(page, { nomenclatura, nidProceso, filters });
}

export { OBJETO };
