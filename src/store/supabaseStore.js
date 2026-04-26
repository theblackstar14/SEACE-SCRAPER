/**
 * Supabase store: persiste runs, procesos, documentos en Postgres.
 * Drop-in replacement de jsonStore para uso productivo.
 *
 * Env requeridas:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (NO la anon — necesitamos write)
 *
 * Uso:
 *   import { createSupabaseStore } from "./store/supabaseStore.js";
 *   const store = createSupabaseStore();
 *   await store.saveRun(runId, payload);
 */

import { createClient } from "@supabase/supabase-js";

let _client = null;

export function getSupabaseClient() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en env");
  }
  _client = createClient(url, key, {
    auth: { persistSession: false },
  });
  return _client;
}

export function isSupabaseAvailable() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * @returns {object} interfaz con saveRun, getLastRun, listRuns, getProceso, queryProcesos
 */
export function createSupabaseStore() {
  const supabase = getSupabaseClient();

  return {
    /**
     * Inserta run completo + procesos asociados.
     * Si run_id ya existe, hace upsert.
     */
    async saveRun(runId, payload) {
      const t0 = Date.now();
      // 1. inserta o updatea run
      const { error: runErr } = await supabase
        .from("runs")
        .upsert(
          {
            run_id: runId,
            started_at: payload.runAt,
            finished_at: new Date().toISOString(),
            filtros: payload.filters,
            resumen: payload.resumen,
            duracion_ms: payload.resumen?.duracionMs,
            pipeline_mode: payload.resumen?.pipelineMode || "playwright",
            empresa: payload.empresa,
          },
          { onConflict: "run_id" }
        );
      if (runErr) throw new Error(`runs upsert: ${runErr.message}`);

      // 2. procesos en batch (Supabase soporta hasta ~1000 rows / request)
      const procesosRows = (payload.procesos || []).map((p) => ({
        nid_proceso: p.id,
        nid_convocatoria: p.nidConvocatoria,
        run_id: runId,
        nomenclatura: p.nomenclatura,
        entidad: p.entidad,
        descripcion: p.descripcion,
        descripcion_corta: p.descripcionCorta,
        objeto: p.objeto,
        valor_referencial: p.valorReferencial,
        moneda: p.moneda,
        region: p.region,
        provincia: p.provincia,
        distrito: p.distrito,
        lugar_ejecucion: p.lugarEjecucion,
        fecha_publicacion: p.fechaPublicacion,
        fecha_propuesta: p.fechaPropuesta,
        dias_restantes: p.diasRestantes,
        estado: p.estado,
        cronograma: p.cronograma,
        documento_usado: p.documentoUsado,
        calidad_texto: p.calidadTexto,
        llm_used: p.llmUsed,
        requisitos: p.requisitos,
        plantel: p.plantel || [],
        evaluacion: p.evaluacion,
        warnings: p.warnings,
        score: p.score,
      }));

      if (procesosRows.length) {
        const { error: procErr } = await supabase
          .from("procesos")
          .upsert(procesosRows, { onConflict: "nid_proceso,run_id" });
        if (procErr) throw new Error(`procesos upsert: ${procErr.message}`);
      }

      console.log(
        `[supabase] saveRun ${runId}: 1 run + ${procesosRows.length} procesos en ${Date.now() - t0}ms`
      );
      return { runId, procesos: procesosRows.length };
    },

    /**
     * Inserta documento (filename + storage_path).
     */
    async saveDocumento({ nidProceso, filename, tipo, sizeBytes, storagePath, hashSha256 }) {
      const { error } = await supabase.from("documentos").insert({
        nid_proceso: nidProceso,
        filename,
        tipo,
        size_bytes: sizeBytes,
        storage_path: storagePath,
        hash_sha256: hashSha256,
      });
      if (error) throw new Error(`documentos insert: ${error.message}`);
    },

    async getLastRun() {
      const { data: run, error } = await supabase
        .from("runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!run) return null;
      const { data: procesos } = await supabase
        .from("procesos")
        .select("*")
        .eq("run_id", run.run_id)
        .order("score", { ascending: false });
      return { run, procesos: procesos || [] };
    },

    async listRuns(limit = 50) {
      const { data, error } = await supabase
        .from("runs")
        .select("run_id, started_at, finished_at, resumen, duracion_ms")
        .order("started_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    },

    async getProceso(nidProceso) {
      const { data, error } = await supabase
        .from("procesos_latest")
        .select("*")
        .eq("nid_proceso", nidProceso)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async queryProcesos({
      resultado,
      estado,
      minScore,
      minDias,
      minMonto,
      maxMonto,
      region,
      provincia,
      distrito,
      cumplePlantel,    // 'si' | 'parcial' | 'no'
      search,           // búsqueda libre en nomenclatura/entidad
      orderBy = "score",
      direction = "desc",
      limit = 100,
      offset = 0,
    } = {}) {
      let q = supabase.from("procesos_latest").select("*", { count: "exact" });
      if (resultado) q = q.eq("evaluacion->>resultado", resultado);
      if (estado) q = q.eq("estado", estado);
      if (minScore != null) q = q.gte("score", minScore);
      if (minDias != null) q = q.gte("dias_restantes", minDias);
      if (minMonto != null) q = q.gte("valor_referencial", minMonto);
      if (maxMonto != null) q = q.lte("valor_referencial", maxMonto);
      if (region) q = q.ilike("region", region);
      if (provincia) q = q.ilike("provincia", provincia);
      if (distrito) q = q.ilike("distrito", distrito);
      if (cumplePlantel) q = q.eq("evaluacion->plantel->>cumple", cumplePlantel);
      if (search) {
        const s = `%${search}%`;
        q = q.or(`nomenclatura.ilike.${s},entidad.ilike.${s},descripcion.ilike.${s}`);
      }
      q = q.order(orderBy, { ascending: direction === "asc" }).range(offset, offset + limit - 1);
      const { data, error, count } = await q;
      if (error) throw error;
      return { data: data || [], total: count || 0 };
    },

    /**
     * Devuelve regiones/provincias/distritos distintos para alimentar filtros UI.
     */
    async getUbicacionesDistintas() {
      const { data, error } = await supabase
        .from("procesos_latest")
        .select("region, provincia, distrito")
        .not("region", "is", null);
      if (error) throw error;
      const regiones = new Set();
      const provincias = new Set();
      const distritos = new Set();
      for (const r of data || []) {
        if (r.region) regiones.add(r.region);
        if (r.provincia) provincias.add(r.provincia);
        if (r.distrito) distritos.add(r.distrito);
      }
      return {
        regiones: [...regiones].sort(),
        provincias: [...provincias].sort(),
        distritos: [...distritos].sort(),
      };
    },

    async getDocumentos(nidProceso) {
      const { data, error } = await supabase
        .from("documentos")
        .select("*")
        .eq("nid_proceso", nidProceso)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },

    /**
     * Lee la empresa activa (la primera por default).
     */
    async getEmpresaActiva() {
      const { data, error } = await supabase
        .from("empresas")
        .select("*")
        .eq("activa", true)
        .order("id")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        razonSocial: data.razon_social,
        ruc: data.ruc,
        capacidadContratacionCAPECO: Number(data.capacidad_contratacion_capeco),
        especialidades: data.especialidades || [],
        experiencia: data.experiencia || [],
        personal: data.personal || [],
      };
    },

    newRunId() {
      const d = new Date();
      const tag = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return `${tag}-${Date.now().toString().slice(-6)}`;
    },
  };
}
