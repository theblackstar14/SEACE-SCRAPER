/**
 * Check end-to-end del store Postgres.
 *
 *   node scripts/check-pg.js     # usa DATABASE_URL de .env
 *
 * SEGURIDAD: de la DATABASE_URL usa SOLO host/puerto/credenciales. Se crea y
 * trabaja en una base aparte (`seace_check`), que borra y rehace en cada
 * corrida. Apuntarlo a la base del ERP no la toca: no se puede, el nombre de
 * la base está hardcodeado acá abajo.
 *
 * Aplica el esquema, mete un run con dos procesos que COMPARTEN documento, y
 * verifica lo único que puede hacer perder plata: que la retención no borre
 * un archivo que todavía le sirve a alguien.
 */
import "dotenv/config";
import assert from "node:assert";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { absPath } from "../src/store/docStore.js";

const SCRATCH_DB = "seace_check";

if (!process.env.DATABASE_URL) {
  console.error("falta DATABASE_URL en .env — ver cabecera de este archivo");
  process.exit(1);
}

// Reescribir la URL ANTES de importar pgStore: el pool se arma con lo que
// haya en env al crearse.
const url = new URL(process.env.DATABASE_URL);
const dbOriginal = url.pathname.slice(1) || "postgres";
url.pathname = `/${SCRATCH_DB}`;
process.env.DATABASE_URL = url.toString();
process.env.DOCS_DIR = process.env.DOCS_DIR || "./data/_checkdocs";

const pg = (await import("pg")).default;
const { createPgStore, getPool, closePool } = await import("../src/store/pgStore.js");

/** Recrea la base de pruebas conectándose a la de mantenimiento. */
async function recrearScratchDb() {
  const admin = new URL(process.env.DATABASE_URL);
  admin.pathname = `/${dbOriginal}`;
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query(`drop database if exists ${SCRATCH_DB} with (force)`);
    await c.query(`create database ${SCRATCH_DB}`);
  } finally {
    await c.end();
  }
  console.log(`base ${SCRATCH_DB} recreada (host ${url.hostname}:${url.port || 5432})`);
}

await recrearScratchDb();

const db = createPgStore();
const pool = getPool();
const iso = (dias) => new Date(Date.now() + dias * 86_400_000).toISOString();

async function main() {
  await pool.query(await fs.readFile("db/schema.sql", "utf8"));
  console.log("schema aplicado");

  // --- run con 2 procesos. VIGENTE vence en 20d, VENCIDO venció hace 30d.
  const runId = db.newRunId();
  const procesos = [
    { id: "100", nomenclatura: "LP-VIGENTE-1", entidad: "MUNI A", valorReferencial: 1500000.5,
      fechaPropuesta: iso(20), diasRestantes: 20, estado: "activo", score: 70,
      evaluacion: { resultado: "califica", razones: ["ok"] }, warnings: [], region: "LIMA",
      documentos: [{ etapa: "Integración de las Bases", documento: "Bases Integradas", sizeText: "(900 KB)",
        descargas: [{ uuid: "0c9f-uuid-alfresco", filename: "bases.pdf", tipo: "pdf" }] }] },
    { id: "200", nomenclatura: "LP-VENCIDO-2", entidad: "MUNI B", valorReferencial: 900000,
      fechaPropuesta: iso(-30), diasRestantes: -30, estado: "vencido", score: 20,
      evaluacion: { resultado: "indeterminado", razones: [] }, warnings: ["x"], region: "CUSCO" },
  ];
  await db.saveRun(runId, { runAt: new Date().toISOString(), filters: {}, empresa: {}, resumen: { duracionMs: 1 }, procesos });

  // --- el MISMO documento en los dos procesos: debe escribirse una sola vez
  const buf = Buffer.from("bases integradas de prueba");
  const hash = createHash("sha256").update(buf).digest("hex");
  for (const nid of ["100", "200"]) {
    await db.saveDocumento({ nidProceso: nid, buffer: buf, hashSha256: hash, filename: "bases.pdf", tipo: "pdf", sizeBytes: buf.length });
  }
  const { rows: docs } = await pool.query(`select * from documentos`);
  assert.strictEqual(docs.length, 1, "doc compartido debe guardarse una vez");
  await fs.access(absPath(docs[0].path));
  assert.strictEqual((await db.getDocumentos("100")).length, 1);

  // --- estado
  await db.saveEstados([
    { nidProceso: "100", nomenclatura: "LP-VIGENTE-1", entidad: "MUNI A", fechaPropuesta: iso(20),
      diasRestantes: 20, resultado: "califica", score: 70, docFingerprint: "f1", docHash: hash,
      integrada: true, primeraVez: iso(-1), ultimaVez: iso(0), vecesVisto: 2,
      novedad: "bases_integradas", revisar: true, revisarTipo: "oportunidad",
      motivo: "Bases Integradas publicadas" },
    { nidProceso: "200", nomenclatura: "LP-VENCIDO-2", fechaPropuesta: iso(-30),
      resultado: "indeterminado", integrada: false, vecesVisto: 1, revisar: false,
      primeraVez: iso(-40), ultimaVez: iso(0) },
  ]);
  const e100 = await db.getEstado("100");
  assert.strictEqual(e100.integrada, true);
  assert.strictEqual(e100.vecesVisto, 2);
  assert.strictEqual(e100.docHash, hash);
  assert.strictEqual(e100.revisarTipo, "oportunidad");
  assert.strictEqual((await db.getAlertas())[0].revisar_tipo, "oportunidad");

  // --- vista ERP: dias_restantes_hoy se calcula al leer, no es el del run
  const p100 = await db.getProceso("100");
  assert.ok(Math.abs(p100.dias_restantes_hoy - 20) <= 1, `dias_restantes_hoy=${p100.dias_restantes_hoy}`);
  assert.strictEqual(p100.revisar, true);
  assert.strictEqual(p100.pinned, false);
  assert.strictEqual(typeof p100.valor_referencial, "number", "numeric debe salir como number");
  // el uuid de Alfresco debe sobrevivir: es lo que habilita la descarga en vivo
  assert.strictEqual(p100.documentos[0].descargas[0].uuid, "0c9f-uuid-alfresco");

  // --- filtros
  assert.strictEqual((await db.queryProcesos({ resultado: "califica" })).total, 1);
  assert.strictEqual((await db.queryProcesos({ minDias: 15 })).total, 1);
  assert.strictEqual((await db.queryProcesos({ revisar: true })).total, 1);
  assert.strictEqual((await db.queryProcesos({ search: "VENCIDO" })).total, 1);
  assert.strictEqual((await db.queryProcesos({ region: "lima" })).total, 1);
  assert.strictEqual((await db.getAlertas()).length, 1);
  // orderBy no whitelisteado no debe llegar al SQL
  assert.strictEqual((await db.queryProcesos({ orderBy: "1; drop table runs" })).total, 2);

  // --- RETENCIÓN. El doc lo comparten un proceso vencido y uno vigente:
  // NO se puede borrar. Este es el caso que justifica guardar por hash.
  let purgables = (await db.purgarDocumentos({ dryRun: true })).candidatos;
  assert.strictEqual(purgables.length, 0, "doc compartido con un proceso vigente NO es purgable");

  // desligamos el vigente: ahora solo lo referencia el vencido hace 30d
  await pool.query(`delete from proceso_documentos where nid_proceso = '100'`);
  purgables = (await db.purgarDocumentos({ dryRun: true })).candidatos;
  assert.strictEqual(purgables.length, 1, "solo-vencido SÍ es purgable");

  // ...salvo que el ERP lo haya pineado
  await db.pin("200", { pinnedBy: "gabriel", nota: "vamos a postular" });
  assert.strictEqual((await db.purgarDocumentos({ dryRun: true })).candidatos.length, 0, "pin debe proteger");
  assert.strictEqual((await db.getProceso("200")).pinned, true);

  await db.unpin("200");
  const purga = await db.purgarDocumentos();
  assert.strictEqual(purga.borrados, 1);
  await assert.rejects(fs.access(absPath(docs[0].path)), "el archivo debe desaparecer del disco");
  assert.strictEqual((await pool.query(`select * from documentos`)).rows.length, 0);

  // --- fecha en formato SEACE crudo: debe entrar como null, no reventar el run
  await db.saveRun(db.newRunId(), {
    runAt: new Date().toISOString(), filters: {}, empresa: {}, resumen: {},
    procesos: [{ id: "300", nomenclatura: "LP-FECHA-RARA", fechaPropuesta: "25/10/2026 17:00", warnings: [] }],
  });
  assert.strictEqual((await db.getProceso("300")).fecha_propuesta, null);

  // --- empresa
  await pool.query(
    `insert into empresas (razon_social, ruc, capacidad_contratacion_capeco, especialidades)
     values ('TEST SAC','20512345678',15000000,array['edificacion'])`
  );
  const emp = await db.updateEmpresaActiva({ capacidadContratacionCAPECO: 20000000, personal: [{ nombres: "Ing X" }] });
  assert.strictEqual(emp.capacidadContratacionCAPECO, 20000000);
  assert.strictEqual(emp.personal[0].nombres, "Ing X");
  assert.strictEqual((await db.getEmpresaActiva()).razonSocial, "TEST SAC");

  // --- purga de estados vencidos
  assert.strictEqual(await db.purgarEstados({ dias: 15 }), 1);
  assert.strictEqual(await db.getEstado("200"), null);
  assert.ok(await db.getEstado("100"));

  // dos runs: el de arriba y el de la fecha rara. getLastRun devuelve el último.
  assert.strictEqual((await db.listRuns()).length, 2);
  assert.strictEqual((await db.getLastRun()).procesos.length, 1);

  console.log("ok");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
