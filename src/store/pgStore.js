/**
 * Store Postgres (la base del ERP en el VPS). Reemplaza a supabaseStore.
 *
 * Env:
 *   DATABASE_URL=postgres://user:pass@host:5432/db
 *   DOCS_DIR=/var/lib/seace/docs   (opcional, default ./data/docs)
 *
 * Esquema: db/schema.sql
 */

import pg from "pg";
import { saveDoc, deleteDoc, relPath } from "./docStore.js";

// numeric → Number en vez de string. Sin esto valor_referencial sale "15000.00"
// y el JSON del API lleva montos como texto.
pg.types.setTypeParser(1700, (v) => (v == null ? null : parseFloat(v)));
// int8 (count) → Number
pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

let _pool = null;

/**
 * Schema propio dentro de la base del ERP. Las queries de acá dicen `procesos`
 * a secas y resuelven a `seace.procesos`.
 *
 * No es cosmético: `procesos`, `documentos` y `empresas` son nombres que el ERP
 * casi seguro ya usa. Y el schema se reaplica entero en cada deploy, con DROP
 * VIEW adentro — eso no va cerca de las tablas del ERP. Con un rol que solo
 * tenga grants sobre este schema, un bug de acá no puede tocar nada de allá.
 */
// ponytail: hardcodeado, no configurable. db/schema.sql dice `seace` también;
// hacerlo env var crea la chance de que los dos no coincidan, y ese error es
// mudo (las tablas "no existen" y nada dice por qué).
export const SCHEMA = "seace";

export function isPgAvailable() {
  return !!process.env.DATABASE_URL;
}

export function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) throw new Error("falta DATABASE_URL en env");
  _pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    // En la conexión y no en el rol: el mismo código corre contra el VPS y
    // contra un postgres de laptop sin tocar roles.
    //
    // SIN `public` a propósito. Si estuviera y una tabla faltara en `seace`,
    // la query caería a la del ERP que se llame igual — sin error, sin aviso,
    // escribiendo en la tabla equivocada. El esquema no usa nada de public
    // (todo lo que necesita vive en pg_catalog, siempre visible).
    options: `-c search_path=${SCHEMA}`,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  _pool.on("error", (e) => console.warn(`[pg] pool error: ${e.message}`));
  return _pool;
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

const q = (sql, params) => getPool().query(sql, params);

/**
 * A timestamptz o null.
 *
 * `fechaPropuesta` sale de `finIso || fin`, y ese `fin` es el texto crudo de
 * SEACE ("25/10/2026 17:00"). Postgres lo rechaza y, como todo el run va en
 * una transacción, un solo proceso con fecha rara tiraría los 300. Mejor
 * guardar null en esa columna: la fecha legible igual queda en `cronograma`.
 */
function toTs(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// columnas por las que se puede ordenar. Whitelist: `orderBy` viene del
// query string y va concatenado al SQL (no se puede parametrizar un ORDER BY).
const ORDENABLES = new Set([
  "score",
  "dias_restantes_hoy",
  "valor_referencial",
  "fecha_propuesta",
  "created_at",
  "nomenclatura",
  "entidad",
]);

export function createPgStore() {
  return {
    /** Inserta run + sus procesos. Transaccional: o entra todo o nada. */
    async saveRun(runId, payload) {
      const t0 = Date.now();
      const client = await getPool().connect();
      try {
        await client.query("begin");
        await client.query(
          `insert into runs (run_id, started_at, finished_at, filtros, resumen, duracion_ms, pipeline_mode, empresa)
           values ($1,$2,now(),$3,$4,$5,$6,$7)
           on conflict (run_id) do update set
             finished_at = excluded.finished_at,
             resumen = excluded.resumen,
             duracion_ms = excluded.duracion_ms`,
          [
            runId,
            payload.runAt,
            payload.filters || {},
            payload.resumen || {},
            payload.resumen?.duracionMs ?? null,
            payload.resumen?.pipelineMode || "http",
            payload.empresa || {},
          ]
        );

        // ponytail: un INSERT por proceso. Son 30-300 por noche en una red
        // local; batchear con unnest ahorraría ~100ms y cuesta legibilidad.
        for (const p of payload.procesos || []) {
          await client.query(
            `insert into procesos (
               nid_proceso, nid_convocatoria, run_id, nomenclatura, entidad, descripcion,
               descripcion_corta, objeto, valor_referencial, moneda, fecha_publicacion,
               fecha_propuesta, dias_restantes, estado, region, provincia, distrito,
               lugar_ejecucion, cronograma, documentos, documento_usado, calidad_texto, llm_used,
               requisitos, plantel, evaluacion, warnings, doc_hash, score
             ) values (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
             )
             on conflict (nid_proceso, run_id) do update set
               evaluacion = excluded.evaluacion,
               score = excluded.score,
               requisitos = excluded.requisitos,
               documentos = excluded.documentos,
               doc_hash = excluded.doc_hash,
               updated_at = now()`,
            [
              p.id,
              p.nidConvocatoria ?? null,
              runId,
              p.nomenclatura ?? null,
              p.entidad ?? null,
              p.descripcion ?? null,
              p.descripcionCorta ?? null,
              p.objeto ?? null,
              p.valorReferencial ?? null,
              p.moneda ?? null,
              p.fechaPublicacion ?? null,
              toTs(p.fechaPropuesta),
              p.diasRestantes ?? null,
              p.estado ?? null,
              p.region ?? null,
              p.provincia ?? null,
              p.distrito ?? null,
              p.lugarEjecucion ?? null,
              JSON.stringify(p.cronograma ?? null),
              JSON.stringify(p.documentos ?? null),
              JSON.stringify(p.documentoUsado ?? null),
              JSON.stringify(p.calidadTexto ?? null),
              JSON.stringify(p.llmUsed ?? null),
              JSON.stringify(p.requisitos ?? null),
              JSON.stringify(p.plantel ?? []),
              JSON.stringify(p.evaluacion ?? null),
              p.warnings ?? [],
              p.docHash ?? null,
              p.score ?? null,
            ]
          );
        }
        await client.query("commit");
        console.log(
          `[pg] saveRun ${runId}: 1 run + ${payload.procesos?.length || 0} procesos en ${Date.now() - t0}ms`
        );
        return { runId, procesos: payload.procesos?.length || 0 };
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /**
     * Guarda el archivo en disco (si no estaba) y lo liga al proceso.
     * Idempotente por hash: re-correr el run no duplica nada.
     */
    async saveDocumento({ nidProceso, buffer, hashSha256, filename, tipo, sizeBytes, etapa, documento }) {
      const rel = buffer ? (await saveDoc(buffer, hashSha256, tipo)).rel : relPath(hashSha256, tipo);
      await q(
        `insert into documentos (hash_sha256, filename, tipo, size_bytes, path)
         values ($1,$2,$3,$4,$5)
         on conflict (hash_sha256) do update set last_seen_at = now()`,
        [hashSha256, filename, tipo ?? null, sizeBytes ?? buffer?.length ?? null, rel]
      );
      await q(
        `insert into proceso_documentos (nid_proceso, hash_sha256, etapa, documento)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [nidProceso, hashSha256, etapa ?? null, documento ?? null]
      );
      return { path: rel };
    },

    async getDocumentos(nidProceso) {
      const { rows } = await q(
        `select d.*, pd.etapa, pd.documento
         from proceso_documentos pd join documentos d using (hash_sha256)
         where pd.nid_proceso = $1
         order by d.created_at desc`,
        [nidProceso]
      );
      return rows;
    },

    /**
     * Borra los documentos que ya no le sirven a nadie (ver vista
     * documentos_purgables): vencidos hace >7d y sin pin.
     *
     * Archivo primero, fila después: si el borrado del archivo falla no se
     * pierde el registro de que existe. Al revés quedarían huérfanos en disco
     * que nada vuelve a nombrar.
     */
    async purgarDocumentos({ dryRun = false } = {}) {
      const { rows } = await q(`select hash_sha256, path, size_bytes, filename from documentos_purgables`);
      if (dryRun) return { borrados: 0, bytes: 0, candidatos: rows };
      let borrados = 0;
      let bytes = 0;
      for (const d of rows) {
        await deleteDoc(d.path);
        await q(`delete from documentos where hash_sha256 = $1`, [d.hash_sha256]);
        borrados++;
        bytes += Number(d.size_bytes || 0);
      }
      return { borrados, bytes, candidatos: rows };
    },

    async pin(nidProceso, { pinnedBy, nota } = {}) {
      await q(
        `insert into pines (nid_proceso, pinned_by, nota) values ($1,$2,$3)
         on conflict (nid_proceso) do update set pinned_by = excluded.pinned_by, nota = excluded.nota`,
        [nidProceso, pinnedBy ?? null, nota ?? null]
      );
      return { nidProceso, pinned: true };
    },

    async unpin(nidProceso) {
      await q(`delete from pines where nid_proceso = $1`, [nidProceso]);
      return { nidProceso, pinned: false };
    },

    // ---- estado por proceso (lo consume procesoState.js) -------------------

    async getEstado(nidProceso) {
      const { rows } = await q(`select * from procesos_estado where nid_proceso = $1`, [nidProceso]);
      return rows[0] ? fromEstadoRow(rows[0]) : null;
    },

    async saveEstados(estados) {
      const client = await getPool().connect();
      try {
        await client.query("begin");
        for (const e of estados) {
          if (!e?.nidProceso) continue;
          await client.query(
            `insert into procesos_estado (
               nid_proceso, nomenclatura, entidad, valor_referencial, fecha_propuesta,
               dias_restantes, resultado, score, doc_fingerprint, doc_hash, doc_etapa,
               integrada, dias_hasta_integracion, primera_vez, ultima_vez, veces_visto,
               novedad, revisar, revisar_tipo, motivo
             ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             on conflict (nid_proceso) do update set
               nomenclatura = excluded.nomenclatura,
               entidad = excluded.entidad,
               valor_referencial = excluded.valor_referencial,
               fecha_propuesta = excluded.fecha_propuesta,
               dias_restantes = excluded.dias_restantes,
               resultado = excluded.resultado,
               score = excluded.score,
               doc_fingerprint = excluded.doc_fingerprint,
               doc_hash = excluded.doc_hash,
               doc_etapa = excluded.doc_etapa,
               integrada = excluded.integrada,
               dias_hasta_integracion = excluded.dias_hasta_integracion,
               ultima_vez = excluded.ultima_vez,
               veces_visto = excluded.veces_visto,
               novedad = excluded.novedad,
               revisar = excluded.revisar,
               revisar_tipo = excluded.revisar_tipo,
               motivo = excluded.motivo`,
            [
              e.nidProceso, e.nomenclatura ?? null, e.entidad ?? null,
              e.valorReferencial ?? null, toTs(e.fechaPropuesta), e.diasRestantes ?? null,
              e.resultado ?? null, e.score ?? null, e.docFingerprint ?? null,
              e.docHash ?? null, e.docEtapa ?? null, !!e.integrada,
              e.diasHastaIntegracion ?? null, toTs(e.primeraVez), toTs(e.ultimaVez),
              e.vecesVisto ?? 1, e.novedad ?? null, !!e.revisar, e.revisarTipo ?? null,
              e.motivo ?? null,
            ]
          );
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /** Olvida procesos vencidos hace más de `dias`. */
    async purgarEstados({ dias = 60 } = {}) {
      const { rowCount } = await q(
        `delete from procesos_estado
         where fecha_propuesta is not null and fecha_propuesta < now() - ($1 || ' days')::interval`,
        [String(dias)]
      );
      return rowCount;
    },

    // ---- lectura para el ERP ----------------------------------------------

    async queryProcesos({
      resultado, estado, minScore, minDias, minMonto, maxMonto,
      region, provincia, distrito, cumplePlantel, search,
      revisar, pinned, integrada,
      orderBy = "score", direction = "desc", limit = 100, offset = 0,
    } = {}) {
      const w = [];
      const p = [];
      const add = (sql, val) => { p.push(val); w.push(sql.replace("?", `$${p.length}`)); };

      if (resultado) add("evaluacion->>'resultado' = ?", resultado);
      if (estado) add("estado = ?", estado);
      if (minScore != null) add("score >= ?", minScore);
      if (minDias != null) add("dias_restantes_hoy >= ?", minDias);
      if (minMonto != null) add("valor_referencial >= ?", minMonto);
      if (maxMonto != null) add("valor_referencial <= ?", maxMonto);
      if (region) add("region ilike ?", region);
      if (provincia) add("provincia ilike ?", provincia);
      if (distrito) add("distrito ilike ?", distrito);
      if (cumplePlantel) add("evaluacion->'plantel'->>'cumple' = ?", cumplePlantel);
      if (revisar != null) add("revisar = ?", !!revisar);
      if (pinned != null) add("pinned = ?", !!pinned);
      if (integrada != null) add("integrada = ?", !!integrada);
      if (search) {
        p.push(`%${search}%`);
        w.push(`(nomenclatura ilike $${p.length} or entidad ilike $${p.length} or descripcion ilike $${p.length})`);
      }

      const where = w.length ? `where ${w.join(" and ")}` : "";
      const col = ORDENABLES.has(orderBy) ? orderBy : "score";
      const dir = direction === "asc" ? "asc" : "desc";

      const { rows: cnt } = await q(`select count(*)::int as total from procesos_erp ${where}`, p);
      const { rows } = await q(
        `select * from procesos_erp ${where} order by ${col} ${dir} nulls last limit $${p.length + 1} offset $${p.length + 2}`,
        [...p, Math.min(limit, 500), offset]
      );
      return { data: rows, total: cnt[0]?.total || 0 };
    },

    async getProceso(nidProceso) {
      const { rows } = await q(`select * from procesos_erp where nid_proceso = $1`, [nidProceso]);
      return rows[0] || null;
    },

    /** Lo que hay que mirar hoy: la salida del cron nocturno. */
    async getAlertas({ limit = 100 } = {}) {
      const { rows } = await q(
        // oportunidad primero: lo que la máquina sí pudo evaluar vale más que
        // lo que dejó pendiente de lectura humana.
        `select nid_proceso, nomenclatura, entidad, novedad, revisar_tipo, motivo, score,
                dias_restantes_hoy, valor_referencial, pinned,
                evaluacion ->> 'resultado' as resultado
         from procesos_erp where revisar
         order by (revisar_tipo = 'oportunidad') desc, score desc nulls last limit $1`,
        [limit]
      );
      return rows;
    },

    async getUbicacionesDistintas() {
      const { rows } = await q(
        `select
           array_remove(array_agg(distinct region), null)    as regiones,
           array_remove(array_agg(distinct provincia), null) as provincias,
           array_remove(array_agg(distinct distrito), null)  as distritos
         from procesos_latest`
      );
      const r = rows[0] || {};
      return {
        regiones: (r.regiones || []).sort(),
        provincias: (r.provincias || []).sort(),
        distritos: (r.distritos || []).sort(),
      };
    },

    async getLastRun() {
      const { rows } = await q(`select * from runs order by started_at desc limit 1`);
      const run = rows[0];
      if (!run) return null;
      const { rows: procesos } = await q(
        `select * from procesos where run_id = $1 order by score desc nulls last`,
        [run.run_id]
      );
      return { run, procesos };
    },

    async listRuns(limit = 50) {
      const { rows } = await q(
        `select run_id, started_at, finished_at, resumen, duracion_ms
         from runs order by started_at desc limit $1`,
        [Math.min(limit, 200)]
      );
      return rows;
    },

    // ---- empresa ----------------------------------------------------------

    async getEmpresaActiva() {
      const { rows } = await q(`select * from empresas where activa order by id limit 1`);
      return rows[0] ? fromEmpresaRow(rows[0]) : null;
    },

    async updateEmpresaActiva(payload) {
      const map = {
        razonSocial: "razon_social",
        ruc: "ruc",
        capacidadContratacionCAPECO: "capacidad_contratacion_capeco",
        especialidades: "especialidades",
        experiencia: "experiencia",
        personal: "personal",
      };
      const sets = [];
      const vals = [];
      for (const [k, col] of Object.entries(map)) {
        if (payload[k] === undefined) continue;
        vals.push(col === "experiencia" || col === "personal" ? JSON.stringify(payload[k]) : payload[k]);
        sets.push(`${col} = $${vals.length}`);
      }
      if (!sets.length) return this.getEmpresaActiva();
      const { rows } = await q(
        `update empresas set ${sets.join(", ")}
         where id = (select id from empresas where activa order by id limit 1)
         returning *`,
        vals
      );
      if (!rows[0]) throw new Error("empresa activa no encontrada");
      return fromEmpresaRow(rows[0]);
    },

    newRunId() {
      const d = new Date();
      const tag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return `${tag}-${Date.now().toString().slice(-6)}`;
    },
  };
}

function fromEmpresaRow(r) {
  return {
    razonSocial: r.razon_social,
    ruc: r.ruc,
    // null y no 0: `Number(null)` da 0, y un 0 se lee como "capacidad cero"
    // en vez de "no cargada". Las dos desactivan el filtro de monto, pero
    // solo una es honesta en pantalla.
    capacidadContratacionCAPECO:
      r.capacidad_contratacion_capeco == null ? null : Number(r.capacidad_contratacion_capeco),
    especialidades: r.especialidades || [],
    experiencia: r.experiencia || [],
    personal: r.personal || [],
  };
}

/** snake_case de la DB → el shape que espera reconciliar(). */
function fromEstadoRow(r) {
  return {
    nidProceso: r.nid_proceso,
    nomenclatura: r.nomenclatura,
    entidad: r.entidad,
    valorReferencial: r.valor_referencial,
    fechaPropuesta: r.fecha_propuesta?.toISOString?.() || r.fecha_propuesta,
    diasRestantes: r.dias_restantes,
    resultado: r.resultado,
    score: r.score,
    docFingerprint: r.doc_fingerprint,
    docHash: r.doc_hash,
    docEtapa: r.doc_etapa,
    integrada: r.integrada,
    diasHastaIntegracion: r.dias_hasta_integracion,
    primeraVez: r.primera_vez?.toISOString?.() || r.primera_vez,
    ultimaVez: r.ultima_vez?.toISOString?.() || r.ultima_vez,
    vecesVisto: r.veces_visto,
    novedad: r.novedad,
    revisar: r.revisar,
    revisarTipo: r.revisar_tipo,
    motivo: r.motivo,
  };
}
