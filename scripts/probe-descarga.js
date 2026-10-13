// throwaway: ¿cómo se resuelve descargaDocGeneral() a una URL?
import "dotenv/config";
import fs from "node:fs/promises";
import * as cheerio from "cheerio";
import { bootstrapBatchByPage } from "../src/scraper/bootstrapHttp.js";
import { postFichaForm } from "../src/scraper/fichaHttp.js";
import { shutdownBrowser } from "../src/browserPool.js";

await bootstrapBatchByPage({
  filters: { objetoContratacion: "Obra" },
  maxPages: 1,
  onPageRows: async (rows) => {
    for (const r of rows.filter((x) => x.buttonId && x.nidProceso).slice(0, 6)) {
      const { html } = await postFichaForm({
        buttonId: r.buttonId,
        nidProceso: r.nidProceso,
        nidConvocatoria: r.nidConvocatoria,
      });
      const $ = cheerio.load(html);
      const anchors = $("a[onclick*='descargaDocGeneral']");
      if (!anchors.length) continue;

      console.log(`\n=== ${r.nomenclatura} (${anchors.length} anchors)`);
      anchors.slice(0, 2).each((_, a) => console.log("  onclick:", $(a).attr("onclick")));

      // ¿dónde se define la función?
      const defs = [];
      $("script").each((_, s) => {
        const t = $(s).html() || "";
        if (t.includes("descargaDocGeneral")) defs.push(t);
      });
      console.log(`  inline scripts con la fn: ${defs.length}`);
      defs.forEach((d, i) => {
        const idx = d.indexOf("function descargaDocGeneral");
        console.log(`  --- def ${i} ---\n${idx >= 0 ? d.slice(idx, idx + 900) : d.slice(0, 600)}`);
      });

      console.log("  <script src>:");
      $("script[src]").each((_, s) => console.log("   ", $(s).attr("src")));

      await fs.writeFile("data/debug/ficha-descarga.html", html);
      console.log("  -> data/debug/ficha-descarga.html");
      break;
    }
    return "stop";
  },
});

await shutdownBrowser();
