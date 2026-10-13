// throwaway: ¿el POST de ficha colisiona cuando va concurrente sobre un mismo ViewState?
import "dotenv/config";
import pLimit from "p-limit";
import { bootstrapBatchByPage } from "../src/scraper/bootstrapHttp.js";
import { fetchDetalleHttp } from "../src/scraper/fichaHttp.js";
import { shutdownBrowser } from "../src/browserPool.js";

const N = 4;

await bootstrapBatchByPage({
  filters: { objetoContratacion: "Obra" },
  maxPages: 1,
  onPageRows: async (rows) => {
    const muestra = rows.filter((r) => r.buttonId && r.nidProceso).slice(0, N);
    console.log("\nesperado (del listado):");
    muestra.forEach((r) => console.log(`  ${r.nomenclatura}  <-  ${r.entidad}`));

    for (const modo of ["serial", "concurrente"]) {
      const lim = pLimit(modo === "serial" ? 1 : N);
      const out = await Promise.all(
        muestra.map((r) =>
          lim(async () => {
            const d = await fetchDetalleHttp({ ...r }).catch((e) => ({ _error: e.message }));
            return `  ${r.nomenclatura}  ->  ${d.entidad || d._error}  (${d.fechaPresentacion?.fin || "s/f"})`;
          })
        )
      );
      console.log(`\n${modo}:`);
      out.forEach((l) => console.log(l));
    }
    return "stop";
  },
});

await shutdownBrowser();
