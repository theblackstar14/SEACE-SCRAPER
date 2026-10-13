// throwaway: ¿los POST de ficha (undici) rompen la paginación (Playwright)?
// Comparten JSESSIONID, así que el POST de ficha mueve la vista JSF del server.
import "dotenv/config";
import { bootstrapBatchByPage } from "../src/scraper/bootstrapHttp.js";
import { fetchDetalleHttp } from "../src/scraper/fichaHttp.js";
import { shutdownBrowser } from "../src/browserPool.js";

const modo = process.argv[2] || "sin-ficha"; // sin-ficha | con-ficha
console.log(`modo: ${modo}`);

const porPagina = [];

await bootstrapBatchByPage({
  filters: { objetoContratacion: "Obra" },
  maxPages: 3,
  onPageRows: async (rows, _s, idx) => {
    porPagina.push(rows.map((r) => r.nomenclatura));
    if (modo === "con-ficha") {
      const r = rows.find((x) => x.buttonId && x.nidProceso);
      const d = await fetchDetalleHttp({ ...r });
      console.log(`  pág ${idx + 1}: 1 ficha -> ${d.entidad || d._error}`);
    }
  },
});

console.log("\nprimeras 3 nomenclaturas por página:");
porPagina.forEach((n, i) => console.log(`  pág ${i + 1}: ${n.slice(0, 3).join(" | ")}`));

const p1 = new Set(porPagina[0] || []);
const solapa = (porPagina[1] || []).filter((n) => p1.has(n)).length;
console.log(`\npág2 repite ${solapa}/${(porPagina[1] || []).length} de pág1 -> ${solapa ? "ROTO" : "ok"}`);

await shutdownBrowser();
