#!/usr/bin/env node
/**
 * CLI: corre pipeline de Obra SEACE y guarda JSON.
 *
 * Uso:
 *   node src/cli/run-obra.js                              # defaults (últimos 15 días, limit 30)
 *   node src/cli/run-obra.js --dias 30 --limit 50
 *   node src/cli/run-obra.js --desde 01/04/2026 --hasta 24/04/2026
 *   node src/cli/run-obra.js --empresa ./data/empresa.json --out ./data/output
 *   node src/cli/run-obra.js --skip-pdf                   # debug: no baja PDFs
 */
import fs from "node:fs/promises";
import { runObraPipeline } from "../pipeline/orchestrator.js";
import { createJsonStore } from "../store/jsonStore.js";
import { formatSeaceDate } from "../scraper/common.js";
import { shutdownBrowser } from "../browserPool.js";

function parseArgs(argv) {
  const args = { dias: 15, limit: 30, empresa: "./data/empresa.json", out: "./data/output" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--dias") args.dias = Number(next), i++;
    else if (a === "--limit") args.limit = Number(next), i++;
    else if (a === "--desde") args.desde = next, i++;
    else if (a === "--hasta") args.hasta = next, i++;
    else if (a === "--empresa") args.empresa = next, i++;
    else if (a === "--out") args.out = next, i++;
    else if (a === "--concurrency") args.concurrency = Number(next), i++;
    else if (a === "--skip-pdf") args.skipPdf = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        `Usage: node src/cli/run-obra.js [opts]\n` +
          `  --dias N           últimos N días de publicación (default 15)\n` +
          `  --desde DD/MM/YYYY fecha inicio publicación (override --dias)\n` +
          `  --hasta DD/MM/YYYY fecha fin publicación (default hoy)\n` +
          `  --limit N          max procesos a analizar (default 30)\n` +
          `  --concurrency N    scrapes en paralelo (default 2)\n` +
          `  --empresa PATH     empresa.json (default ./data/empresa.json)\n` +
          `  --out DIR          carpeta de salida (default ./data/output)\n` +
          `  --skip-pdf         no descarga/analiza PDFs (rápido para debug)\n`
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  // resolver fechas
  let fechaDesde = args.desde;
  let fechaHasta = args.hasta || formatSeaceDate(new Date());
  if (!fechaDesde) {
    const hoy = new Date();
    const desde = new Date(hoy.getTime() - args.dias * 24 * 60 * 60 * 1000);
    fechaDesde = formatSeaceDate(desde);
  }

  // cargar empresa
  const empresa = JSON.parse(await fs.readFile(args.empresa, "utf8"));

  console.log(`\n🏗️  SEACE Obra Pipeline`);
  console.log(`   Empresa:  ${empresa.razonSocial} (RUC ${empresa.ruc})`);
  console.log(`   Rango:    ${fechaDesde} → ${fechaHasta}`);
  console.log(`   Límite:   ${args.limit} procesos`);
  console.log(`   SkipPDF:  ${!!args.skipPdf}\n`);

  const store = createJsonStore(args.out);
  const runId = store.newRunId();

  try {
    const payload = await runObraPipeline({
      empresa,
      filters: {
        objetoContratacion: "Obra",
        fechaDesde,
        fechaHasta,
        allPages: true,
      },
      limit: args.limit,
      concurrency: args.concurrency || 2,
      skipPdf: !!args.skipPdf,
    });

    const file = await store.saveRun(runId, payload);
    console.log(`\n✅ Guardado en: ${file}`);
    console.log(`\n📊 Resumen:`);
    console.log(`   Listados:        ${payload.resumen.totalListados}`);
    console.log(`   Analizados:      ${payload.resumen.analizados}`);
    console.log(`   Activos:         ${payload.resumen.activos}`);
    console.log(`   Califican:       ${payload.resumen.califican}`);
    console.log(`   Consorcio:       ${payload.resumen.consorcio}`);
    console.log(`   No califican:    ${payload.resumen.noCalifican}`);
    console.log(`   Indeterminados:  ${payload.resumen.indeterminados}`);
    console.log(`   Duración:        ${(payload.resumen.duracionMs / 1000).toFixed(1)}s`);
  } finally {
    await shutdownBrowser();
  }
}

main().catch((e) => {
  console.error("❌ Pipeline falló:", e);
  shutdownBrowser().finally(() => process.exit(1));
});
