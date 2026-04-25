// Test standalone HTTP directo SEACE.
// Bootstrap Playwright → captura cookies + ViewState + button IDs.
// Luego HTTP POST directo a algunos procesos.

import "dotenv/config";
import { bootstrapBuscador } from "./src/scraper/bootstrapHttp.js";
import { fetchCronogramaHttp, fetchDetalleHttp } from "./src/scraper/fichaHttp.js";
import { shutdownBrowser } from "./src/browserPool.js";

const fechaDesde = "10/04/2026";
const fechaHasta = "24/04/2026";

console.log("[test] Bootstrap Playwright (1x)...");
const t0 = Date.now();

try {
  const { session, listado } = await bootstrapBuscador({
    filters: {
      objetoContratacion: "Obra",
      fechaDesde,
      fechaHasta,
    },
    maxRows: 50, // limitamos para test
    maxPages: 5,
  });

  console.log(`[test] Bootstrap: ${listado.length} rows en ${Date.now() - t0}ms`);
  console.log(`[test] ViewState capturado: ${session.viewState?.slice(0, 30)}...`);

  // sample 3 procesos para HTTP test
  const sample = listado.slice(0, 3).filter((r) => r.buttonId);
  console.log(`\n[test] HTTP cronograma sobre ${sample.length} procesos:`);

  for (const r of sample) {
    console.log(`\n--- ${r.nomenclatura} ---`);
    console.log(`  buttonId: ${r.buttonId}`);
    console.log(`  nidProceso: ${r.nidProceso}`);
    try {
      const tHttp = Date.now();
      const result = await fetchCronogramaHttp({
        nomenclatura: r.nomenclatura,
        nidProceso: r.nidProceso,
        nidConvocatoria: r.nidConvocatoria,
        buttonId: r.buttonId,
      });
      const elapsed = Date.now() - tHttp;
      console.log(`  HTTP en ${elapsed}ms`);
      if (result._error) {
        console.log(`  ERROR: ${result._error}, htmlSize=${result._htmlSize}`);
      } else {
        console.log(`  cronograma items: ${result.cronograma.length}`);
        console.log(`  presentación: ${result.fechaPresentacion?.estado} (${result.fechaPresentacion?.fin})`);
      }
    } catch (e) {
      console.log(`  FAIL: ${e.message}`);
    }
  }

  console.log("\n[test] HTTP detalle completo del primer proceso:");
  const r = sample[0];
  if (r) {
    const tHttp = Date.now();
    const detalle = await fetchDetalleHttp({
      nomenclatura: r.nomenclatura,
      nidProceso: r.nidProceso,
      nidConvocatoria: r.nidConvocatoria,
      buttonId: r.buttonId,
    });
    console.log(`  HTTP en ${Date.now() - tHttp}ms`);
    console.log(`  entidad: ${detalle.entidad?.slice(0, 80)}`);
    console.log(`  VR monto: ${detalle.vrCuantiaMonto}`);
    console.log(`  documentos: ${detalle.documentos?.length}`);
    console.log(`  cronograma rows: ${detalle.cronograma?.length}`);
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
