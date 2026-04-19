import { withPage } from "../browserPool.js";
import { config } from "../config/config.js";
import * as cheerio from "cheerio";

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const normKey = (s) => norm(s).toLowerCase();

function fieldByLabel($, label) {
  const target = normKey(label);
  let val = "";
  $("td").each((_, el) => {
    if (normKey($(el).text()) === target) {
      val = norm($(el).next().text());
      return false;
    }
  });
  return val;
}

function parseDataTable($, idSuffix, headers) {
  const tbody = $(`tbody[id$='${idSuffix}_data']`).first();
  if (!tbody.length) return [];
  const result = [];
  tbody.find("tr[data-ri]").each((_, tr) => {
    const tds = $(tr).find("> td");
    if (!tds.length) return;
    const row = {};
    headers.forEach((h, i) => {
      row[h] = norm($(tds[i]).text());
    });
    const dlLinks = [];
    $(tr).find("a[onclick*='descargaDocGeneral']").each((_, a) => {
      const oc = $(a).attr("onclick") || "";
      const m = oc.match(/descargaDocGeneral\('([^']+)','([^']+)','([^']+)'/);
      if (m) dlLinks.push({ hash: m[1], sistema: m[2], filename: m[3] });
    });
    if (dlLinks.length) row.descargas = dlLinks;
    result.push(row);
  });
  return result;
}

async function findRowAndClick(page, { nomenclatura, nidProceso }) {
  await page.goto(config.baseUrl);
  await page.click("a[href='#tbBuscador\\:tab1']");
  await page.waitForTimeout(1500);
  await page.click("#tbBuscador\\:idFormBuscarProceso\\:btnBuscarSelToken");
  await page.waitForTimeout(4000);
  await page.waitForFunction(() => {
    const rs = document.querySelectorAll(
      "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr"
    );
    return rs.length > 0 && rs[0].innerText.trim().length > 10;
  }, { timeout: 15000 });

  let row = null;
  let intento = 0;
  while (!row && intento < 10) {
    row = await page.evaluateHandle(({ nom, nid }) => {
      const rows = document.querySelectorAll(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr"
      );
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      for (const r of rows) {
        const cells = r.querySelectorAll("td");
        const nomCell = cells[3] ? norm(cells[3].innerText) : "";
        if (nom && nomCell === norm(nom)) return r;
        if (nid) {
          const a = r.querySelector("a.ui-commandlink");
          if (a?.getAttribute("onclick")?.includes(`'nidProceso':'${nid}'`)) return r;
        }
      }
      return null;
    }, { nom: nomenclatura, nid: nidProceso });

    if (!row.asElement()) {
      row = null;
      const next = await page.$(".ui-paginator-next:not(.ui-state-disabled)");
      if (!next) break;
      await next.click();
      await page.waitForTimeout(2500);
      intento++;
    }
  }

  if (!row) throw new Error("Proceso no encontrado");

  const btn = await row.asElement().$("a:has(img[src*='fichaSeleccion'])");
  if (!btn) throw new Error("Botón ficha no encontrado");
  await btn.click();
  await page.waitForSelector("td:has-text('Entidad Convocante')", { timeout: 20000 });
  await page.waitForTimeout(2000);
}

export async function scrapeDetalle({ nomenclatura, nidProceso }) {
  return withPage(async (page) => {
    await findRowAndClick(page, { nomenclatura, nidProceso });
    const html = await page.content();
    const $ = cheerio.load(html);

    return {
      nomenclatura: fieldByLabel($, "Nomenclatura"),
      nConvocatoria: fieldByLabel($, "N° Convocatoria"),
      tipoCompra: fieldByLabel($, "Tipo Compra o Selección"),
      normativa: fieldByLabel($, "Normativa Aplicable"),
      versionSeace: fieldByLabel($, "Versión SEACE"),
      entidad: fieldByLabel($, "Entidad Convocante"),
      direccion: fieldByLabel($, "Direccion Legal") || fieldByLabel($, "Dirección Legal"),
      web: fieldByLabel($, "Pagina Web") || fieldByLabel($, "Página Web"),
      telefono: fieldByLabel($, "Télefono de la Entidad") || fieldByLabel($, "Teléfono de la Entidad"),
      objeto: fieldByLabel($, "Objeto de Contratación"),
      descripcion: fieldByLabel($, "Descripción del Objeto") || fieldByLabel($, "Descripción del objeto"),
      vrCuantia: fieldByLabel($, "VR / VE / Cuantía de la contratación"),
      montoDerecho: fieldByLabel($, "Monto del Derecho de Participacion") || fieldByLabel($, "Monto del Derecho de Participación"),
      montoBases: fieldByLabel($, "Monto del costo de Reproducción de las Bases"),
      fechaPublicacion: fieldByLabel($, "Fecha y hora de Publicación del reinicio"),
      reiniciadoDesde: fieldByLabel($, "Reiniciado Desde"),
      cronograma: parseDataTable($, ":dtCronograma", ["etapa", "inicio", "fin"]),
      documentos: parseDataTable($, ":dtDocumentos", ["nro", "etapa", "documento", "archivo", "fecha"]),
    };
  });
}

export async function descargarDoc({ nomenclatura, nidProceso, filename }) {
  return withPage(async (page) => {
    await findRowAndClick(page, { nomenclatura, nidProceso });

    const dlAnchor = await page.evaluateHandle((fname) => {
      const anchors = document.querySelectorAll("a[onclick*='descargaDocGeneral']");
      for (const a of anchors) {
        if ((a.getAttribute("onclick") || "").includes(fname)) return a;
      }
      return null;
    }, filename);

    const el = dlAnchor.asElement();
    if (!el) throw new Error("Archivo no encontrado en ficha");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      el.click(),
    ]);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return {
      filename: download.suggestedFilename() || filename,
      buffer: Buffer.concat(chunks),
    };
  });
}
