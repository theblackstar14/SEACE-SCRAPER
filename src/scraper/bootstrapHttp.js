/**
 * Bootstrap Playwright para obtener cookies + ViewState que el HTTP client reusa.
 *
 * Flow:
 *   1. Playwright abre buscador
 *   2. Aplica filtros (objeto, fechas)
 *   3. Submit
 *   4. Pagina y captura TODOS los rows con sus button IDs
 *   5. Captura cookies + javax.faces.ViewState
 *   6. Retorna { session, listado: [...] }
 *
 * Después de bootstrap, todos los detalles se hacen via HTTP directo.
 */

import * as cheerio from "cheerio";
import { withPage } from "../browserPool.js";
import { openBuscador, collectAllPages } from "./common.js";
import { SEL } from "./selectors.js";
import { getSession, resetSession } from "./httpClient.js";

/**
 * Extrae el button ID de la celda Acciones de cada row.
 * El onclick tiene formato:
 *   PrimeFaces.addSubmitParam('tbBuscador:idFormBuscarProceso',{
 *     'tbBuscador:idFormBuscarProceso:dtProcesos:60:j_idt377':'tbBuscador:...:j_idt377',
 *     ...
 *   }).submit('tbBuscador:idFormBuscarProceso');
 *
 * El button ID es la key cuyo formato es ":dtProcesos:N:j_idtXXX" y aparece como ambos key y value.
 */
function extractFichaButtonId(htmlRow) {
  const $ = cheerio.load(htmlRow);
  const fichaLink = $("a:has(img[src*='fichaSeleccion'])").first();
  if (!fichaLink.length) return null;
  const onclick = fichaLink.attr("onclick") || "";
  // busca el button id que contiene :dtProcesos:N:j_idt
  const m = onclick.match(/'(tbBuscador:idFormBuscarProceso:dtProcesos:\d+:j_idt\d+)'/);
  return m ? m[1] : null;
}

/**
 * Extrae ViewState del HTML actual de la página.
 */
async function captureViewState(page) {
  return page.evaluate(() => {
    const el = document.querySelector('input[name="javax.faces.ViewState"]');
    return el?.value || null;
  });
}

/**
 * BATCH-POR-PAGINA: pagina el listado y para CADA página, invoca un callback
 * con las rows de esa página ANTES de paginar a la siguiente.
 *
 * Esto resuelve el bug de view tree state: los button IDs son válidos solo
 * mientras la página correspondiente está visible. Si paginás más, el server
 * pierde referencia.
 *
 * @param {object} opts
 *   - filters: filtros buscador
 *   - onPageRows: async (rowsOfThisPage, session, pageIdx) => any
 *     callback ejecutado con las rows de cada página. Bloquea la paginación
 *     hasta que termina (await).
 *   - maxPages: cota
 */
export async function bootstrapBatchByPage({ filters = {}, onPageRows, maxPages = 50 } = {}) {
  resetSession();
  const session = getSession();

  return withPage(async (page) => {
    const t0 = Date.now();
    await openBuscador(page, filters);

    const vs = await captureViewState(page);
    if (!vs) throw new Error("No se pudo capturar ViewState");
    session.setViewState(vs);

    const cookies = await page.context().cookies();
    await session.importPlaywrightCookies(cookies);

    let pageIdx = 0;
    let totalRows = 0;
    const allRows = [];

    while (pageIdx < maxPages) {
      const rowsData = await page.$$eval(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr[data-ri]",
        (trs) => {
          return trs.map((tr) => {
            const cells = tr.querySelectorAll("td");
            const cellTxt = (i) => (cells[i]?.innerText || "").trim();
            const fichaA = tr.querySelector("a:has(img[src*='fichaSeleccion'])") ||
                           [...tr.querySelectorAll("a[onclick]")].find((a) =>
                             (a.getAttribute("onclick") || "").includes("nidProceso") &&
                             !(a.getAttribute("onclick") || "").includes("frmListaCodigoSnip")
                           );
            const onclick = fichaA?.getAttribute("onclick") || "";
            const btnIdMatch = onclick.match(/'(tbBuscador:idFormBuscarProceso:dtProcesos:\d+:j_idt\d+)'/);
            const procMatch = onclick.match(/'nidProceso'\s*:\s*'([^']+)'/);
            const convMatch = onclick.match(/'nidConvocatoria'\s*:\s*'([^']+)'/);
            return {
              nro: cellTxt(0),
              entidad: cellTxt(1),
              fechaPublicacion: cellTxt(2),
              nomenclatura: cellTxt(3),
              reiniciadoDesde: cellTxt(4),
              objetoContratacion: cellTxt(5),
              descripcion: cellTxt(6),
              vrCuantiaRaw: cellTxt(9),
              moneda: cellTxt(10),
              versionSeace: cellTxt(11),
              buttonId: btnIdMatch?.[1] || null,
              nidProceso: procMatch?.[1] || null,
              nidConvocatoria: convMatch?.[1] || null,
            };
          });
        }
      );

      // parse VR a number
      for (const r of rowsData) {
        const cleanVR = String(r.vrCuantiaRaw || "").replace(/[^\d.,-]/g, "");
        if (cleanVR && cleanVR !== "---") {
          const decimal = cleanVR.match(/[.,]\d{1,2}$/) ? "." + cleanVR.slice(-2) : "";
          const intStr = decimal ? cleanVR.slice(0, -3) : cleanVR;
          const num = Number(intStr.replace(/[^\d]/g, "") + decimal);
          r.vrCuantia = Number.isFinite(num) ? num : null;
        } else {
          r.vrCuantia = null;
        }
        delete r.vrCuantiaRaw;
      }

      console.log(`[bootstrap-batch] página ${pageIdx + 1}: ${rowsData.length} rows`);
      totalRows += rowsData.length;
      allRows.push(...rowsData);

      // CALLBACK: procesa estas rows ANTES de paginar
      // (los button IDs solo son válidos mientras esta página está visible)
      if (onPageRows) {
        await onPageRows(rowsData, session, pageIdx);
      }

      // siguiente página
      const next = await page.$(SEL.paginatorNext);
      if (!next) break;

      const respPromise = page
        .waitForResponse(
          (r) => r.url().includes("buscadorPublico") && r.request().method() === "POST",
          { timeout: 25_000 }
        )
        .catch(() => null);
      await next.click();
      await respPromise;

      // re-capturar ViewState
      const newVs = await captureViewState(page);
      if (newVs) session.setViewState(newVs);

      // re-importar cookies (pueden haber rotado)
      const newCookies = await page.context().cookies();
      await session.importPlaywrightCookies(newCookies);

      pageIdx++;
    }

    console.log(`[bootstrap-batch] total ${totalRows} rows en ${Date.now() - t0}ms (${pageIdx + 1} pages)`);
    return { session, totalRows, pages: pageIdx + 1, allRows };
  });
}

/**
 * Bootstrap: abre buscador con filtros, captura cookies + ViewState + button IDs.
 * Versión OLD que pagina todo y captura en memoria. NO usar para HTTP fetch
 * porque los button IDs ya no son válidos tras paginar (use bootstrapBatchByPage).
 *
 * @returns {{ session: SeaceHttpSession, listado: Array, totalCapturados: number }}
 */
export async function bootstrapBuscador({ filters = {}, maxRows = 1000, maxPages = 50 } = {}) {
  resetSession(); // empezar limpio
  const session = getSession();

  return withPage(async (page) => {
    const t0 = Date.now();

    // 1. abre buscador con filtros
    await openBuscador(page, filters);

    // 2. captura ViewState
    const vs = await captureViewState(page);
    if (!vs) throw new Error("No se pudo capturar javax.faces.ViewState");
    session.setViewState(vs);

    // 3. captura cookies del context y las pasa al HttpSession
    const cookies = await page.context().cookies();
    await session.importPlaywrightCookies(cookies);

    // 4. paginar listado capturando rows con button IDs
    const allRows = [];
    let pageIdx = 0;
    const seen = new Set();
    let consecutiveDups = 0;

    while (pageIdx < maxPages) {
      // extraer rows de la página actual con button IDs
      const rowsData = await page.$$eval(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr[data-ri]",
        (trs) => {
          return trs.map((tr) => {
            const cells = tr.querySelectorAll("td");
            const cellTxt = (i) => (cells[i]?.innerText || "").trim();

            // extraer button ID y nidProceso/nidConvocatoria del fichaLink
            const fichaA = tr.querySelector("a:has(img[src*='fichaSeleccion'])") ||
                           [...tr.querySelectorAll("a[onclick]")].find((a) =>
                             (a.getAttribute("onclick") || "").includes("nidProceso") &&
                             !(a.getAttribute("onclick") || "").includes("frmListaCodigoSnip")
                           );
            const onclick = fichaA?.getAttribute("onclick") || "";
            const btnIdMatch = onclick.match(/'(tbBuscador:idFormBuscarProceso:dtProcesos:\d+:j_idt\d+)'/);
            const procMatch = onclick.match(/'nidProceso'\s*:\s*'([^']+)'/);
            const convMatch = onclick.match(/'nidConvocatoria'\s*:\s*'([^']+)'/);

            return {
              nro: cellTxt(0),
              entidad: cellTxt(1),
              fechaPublicacion: cellTxt(2),
              nomenclatura: cellTxt(3),
              reiniciadoDesde: cellTxt(4),
              objetoContratacion: cellTxt(5),
              descripcion: cellTxt(6),
              vrCuantiaRaw: cellTxt(9),
              moneda: cellTxt(10),
              versionSeace: cellTxt(11),
              buttonId: btnIdMatch?.[1] || null,
              nidProceso: procMatch?.[1] || null,
              nidConvocatoria: convMatch?.[1] || null,
            };
          });
        }
      );

      // dedup + agregar
      let nuevos = 0;
      for (const r of rowsData) {
        if (!r.nidProceso) continue;
        if (seen.has(r.nidProceso)) continue;
        seen.add(r.nidProceso);
        // parsear monto VR
        const cleanVR = String(r.vrCuantiaRaw || "").replace(/[^\d.,-]/g, "");
        if (cleanVR && cleanVR !== "---") {
          const parts = cleanVR.split(",");
          const decimal = parts[parts.length - 1]?.includes(".")
            ? "." + parts[parts.length - 1].split(".")[1]
            : "";
          const intPart = cleanVR.split(/[.,]/).filter((s, i, arr) => i < arr.length - (decimal ? 1 : 0)).join("");
          const num = Number(intPart + decimal);
          r.vrCuantia = Number.isFinite(num) ? num : null;
        } else {
          r.vrCuantia = null;
        }
        delete r.vrCuantiaRaw;
        allRows.push(r);
        nuevos++;
        if (allRows.length >= maxRows) break;
      }

      if (allRows.length >= maxRows) break;

      if (nuevos === 0) {
        consecutiveDups++;
        if (consecutiveDups >= 2) break;
      } else {
        consecutiveDups = 0;
      }

      // siguiente página
      const next = await page.$(SEL.paginatorNext);
      if (!next) break;

      const respPromise = page
        .waitForResponse(
          (r) => r.url().includes("buscadorPublico") && r.request().method() === "POST",
          { timeout: 25_000 }
        )
        .catch(() => null);
      await next.click();
      await respPromise;

      // re-capturar ViewState porque puede rotar
      const newVs = await captureViewState(page);
      if (newVs && newVs !== session.viewState) session.setViewState(newVs);

      pageIdx++;
    }

    console.log(
      `[bootstrap] ${allRows.length} rows capturadas con buttonId, ` +
        `${pageIdx + 1} páginas en ${Date.now() - t0}ms`
    );

    return {
      session,
      listado: allRows,
      totalCapturados: allRows.length,
    };
  });
}
