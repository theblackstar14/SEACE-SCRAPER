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
    else if (a === "--headed") args.headed = true;
    else if (a === "--slow-mo") args.slowMo = Number(next) || 250, i++;
    else if (a === "--no-llm") args.noLlm = true;
    else if (a === "--llm-always") args.llmAlways = true;
    else if (a === "--prefer-claude") args.llmProvider = "claude";
    else if (a === "--prefer-gemini") args.llmProvider = "gemini";
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
          `  --skip-pdf         no descarga/analiza PDFs (rápido para debug)\n` +
          `  --headed           abre Chromium visible (debug visual)\n` +
          `  --slow-mo N        delay en ms entre acciones (default 250 si --headed)\n` +
          `  --no-llm           desactiva LLM aunque haya keys configuradas\n` +
          `  --llm-always       usa LLM para TODOS los procesos (no solo fallback)\n` +
          `  --prefer-claude    fuerza usar Claude (si hay key)\n` +
          `  --prefer-gemini    fuerza usar Gemini (si hay key)\n`
      );
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  // aplicar modo headed antes de importar browserPool (via env)
  if (args.headed) {
    process.env.HEADLESS = "false";
    process.env.SLOW_MO = String(args.slowMo || 250);
  }

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

  const claudeKey = !!process.env.ANTHROPIC_API_KEY;
  const geminiKey = !!process.env.GEMINI_API_KEY;
  const llmDisponible = claudeKey || geminiKey;
  const useLlm = llmDisponible && !args.noLlm;
  const llmPolicy = args.llmAlways ? "always" : "fallback";
  const llmProvider = args.llmProvider || "auto";

  const providerLabel = !useLlm
    ? llmDisponible ? "off (--no-llm)" : "off (sin API keys)"
    : llmProvider === "auto"
      ? `✨ ON auto [${[claudeKey && "claude", geminiKey && "gemini"].filter(Boolean).join("+")}]`
      : `✨ ON forced ${llmProvider}`;

  console.log(`\n🏗️  SEACE Obra Pipeline`);
  console.log(`   Empresa:  ${empresa.razonSocial} (RUC ${empresa.ruc})`);
  console.log(`   Rango:    ${fechaDesde} → ${fechaHasta}`);
  console.log(`   Límite:   ${args.limit} procesos`);
  console.log(`   SkipPDF:  ${!!args.skipPdf}`);
  console.log(`   LLM:      ${providerLabel} (${llmPolicy})\n`);

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
      useLlm,
      llmPolicy,
      llmProvider,
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
    console.log(`   Escaneados:      ${payload.resumen.escaneados}`);
    console.log(`   Templates:       ${payload.resumen.templates}`);
    if (payload.resumen.llmEnabled) {
      const byProvider = payload.procesos
        .filter((p) => p.llmUsed?.provider)
        .reduce((acc, p) => {
          acc[p.llmUsed.provider] = (acc[p.llmUsed.provider] || 0) + 1;
          return acc;
        }, {});
      const breakdown = Object.entries(byProvider).map(([k, v]) => `${k}:${v}`).join(", ");
      console.log(`   ✨ LLM:           ${payload.resumen.llmUsed} procesos${breakdown ? ` (${breakdown})` : ""}`);
    }
    console.log(`   Duración:        ${(payload.resumen.duracionMs / 1000).toFixed(1)}s`);
  } finally {
    await shutdownBrowser();
  }
}

main().catch((e) => {
  console.error("❌ Pipeline falló:", e);
  shutdownBrowser().finally(() => process.exit(1));
});
