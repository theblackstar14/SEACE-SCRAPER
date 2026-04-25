// Test standalone HTTP directo SEACE.
// Sin paginar - solo procesos de PRIMERA página para validar HTTP.
// Si funciona, el bug confirmado es el state-tracking de paginación.

import "dotenv/config";
import fs from "node:fs/promises";
import { bootstrapBuscador } from "./src/scraper/bootstrapHttp.js";
import { fetchCronogramaHttp, fetchDetalleHttp, postFichaForm } from "./src/scraper/fichaHttp.js";
import { shutdownBrowser } from "./src/browserPool.js";

const fechaDesde = "10/04/2026";
const fechaHasta = "24/04/2026";

console.log("[test] Bootstrap (NO paginar — solo página 1)...");
const t0 = Date.now();

try {
  const { session, listado } = await bootstrapBuscador({
    filters: {
      objetoContratacion: "Obra",
      fechaDesde,
      fechaHasta,
    },
    maxRows: 15, // primera página solamente
    maxPages: 1, // forzar NO paginar
  });

  console.log(`[test] Bootstrap: ${listado.length} rows en ${Date.now() - t0}ms`);
  console.log(`[test] ViewState: ${session.viewState?.slice(0, 30)}...`);

  if (!listado.length) {
    console.error("[test] FAIL: 0 rows capturadas");
    process.exit(1);
  }

  // dump buttonIds para debug
  console.log("\n[test] ButtonIds capturados:");
  listado.slice(0, 5).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.nomenclatura} -> ${r.buttonId}`);
  });

  // probar 3 primeros con HTTP
  console.log("\n[test] HTTP cronograma sobre primeros 3:");
  const sample = listado.slice(0, 3).filter((r) => r.buttonId);

  for (const r of sample) {
    console.log(`\n--- ${r.nomenclatura} (${r.nidProceso}) ---`);
    try {
      const tHttp = Date.now();
      const result = await fetchCronogramaHttp({
        nomenclatura: r.nomenclatura,
        nidProceso: r.nidProceso,
        nidConvocatoria: r.nidConvocatoria,
        buttonId: r.buttonId,
      });
      const elapsed = Date.now() - tHttp;
      if (result._error) {
        console.log(`  FAIL en ${elapsed}ms: ${result._error}, htmlSize=${result._htmlSize}`);
        // dump primer response para inspeccionar
        if (sample.indexOf(r) === 0) {
          await fs.mkdir("./data/debug", { recursive: true });
          const { html } = await postFichaForm({
            buttonId: r.buttonId,
            nidProceso: r.nidProceso,
            nidConvocatoria: r.nidConvocatoria,
          });
          await fs.writeFile("./data/debug/http-response.html", html, "utf8");
          console.log(`  HTML guardado: ./data/debug/http-response.html (${html.length} chars)`);
          // primeros 500 chars del body
          const bodyStart = html.indexOf("<body");
          if (bodyStart >= 0) {
            console.log(`  body inicio:`, html.slice(bodyStart, bodyStart + 400).replace(/\s+/g, " "));
          }
        }
      } else {
        console.log(`  OK en ${elapsed}ms`);
        console.log(`    cronograma items: ${result.cronograma.length}`);
        console.log(`    presentación: ${result.fechaPresentacion?.estado} (${result.fechaPresentacion?.fin})`);
      }
    } catch (e) {
      console.log(`  EXCEPTION: ${e.message}`);
    }
  }

  await session.close();
  await shutdownBrowser();
  console.log(`\n[test] DONE total ${Date.now() - t0}ms`);
} catch (e) {
  console.error("[test] FAIL:", e.message);
  console.error(e.stack);
  await shutdownBrowser();
  process.exit(1);
}
