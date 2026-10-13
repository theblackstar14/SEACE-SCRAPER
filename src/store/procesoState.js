/**
 * Estado por proceso entre corridas.
 *
 * Sin esto, cada run descubre los mismos procesos sin saber que ya los vio, y
 * no hay forma de contestar la única pregunta que importa en un cron nocturno:
 * ¿qué cambió desde ayer?
 *
 * El cambio que importa es UNO: las Bases Integradas. Medido sobre procesos
 * reales, la Integración ocurre 12-22 días antes de la presentación (mediana
 * 21), y hasta ese momento las Bases publicadas son plantillas estándar sin
 * montos — por eso el 100% de las evaluaciones salía `indeterminado`. La
 * ventana para evaluar con datos reales es de ~1 semana: un scan semanal se la
 * pierde, uno nocturno no.
 *
 * Persistencia: Postgres si hay DATABASE_URL, si no JSON en
 * data/state/procesos.json. La lógica (reconciliar) es pura y no sabe de
 * ninguno de los dos — se puede correr el pipeline en una laptop sin DB.
 */

import fs from "node:fs/promises";
import path from "node:path";

const STATE_FILE = "./data/state/procesos.json";
const MS_DAY = 86_400_000;

let mem = null; // { [nidProceso]: estado }  (solo backend JSON)
let _pgStore = null;

/**
 * El store de pg se importa en caliente para que `pg` sea opcional: sin
 * DATABASE_URL el paquete ni se carga.
 */
async function pgOrNull() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pgStore) {
    const { createPgStore } = await import("./pgStore.js");
    _pgStore = createPgStore();
  }
  return _pgStore;
}

async function load() {
  if (mem) return mem;
  try {
    mem = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    mem = {};
  }
  return mem;
}

async function persist() {
  if (!mem) return;
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(mem, null, 2), "utf8");
  } catch (e) {
    console.warn(`[procesoState] no pude persistir: ${e.message}`);
  }
}

/**
 * Huella del documento seleccionado, SIN descargarlo.
 *
 * Sale de la tabla de documentos de la ficha, que ya tenemos tras un POST de
 * 280ms. Si no cambió respecto de ayer, el documento es el mismo y no hace
 * falta bajar 44MB ni gastar una llamada al LLM. Es el mismo dato que produce
 * la señal de alerta, así que ahorro y señal salen del mismo lugar.
 */
export function fingerprintDoc(docSelected) {
  const d = docSelected?.doc;
  if (!d) return null;
  return [d.etapa, d.documento, d.descargas?.[0]?.filename, d.sizeText]
    .map((x) => x || "")
    .join("|");
}

/** ¿Este documento son las Bases Integradas de verdad? */
export function esIntegrada(docSelected) {
  // selectBasesIntegradas devuelve 'alta' exactamente cuando matcheó
  // etapa "Integración de las Bases" + documento "Bases Integradas".
  return docSelected?.confianza === "alta";
}

/** Días hasta la Integración según el cronograma, o null si no figura. */
export function diasHastaIntegracion(cronograma, now = Date.now()) {
  const e = (cronograma || []).find((x) => /Integraci.n de las Bases/i.test(x.etapa || ""));
  if (!e?.finIso) return null;
  return Math.round((new Date(e.finIso).getTime() - now) / MS_DAY);
}

/**
 * Compara el proceso visto hoy contra el estado guardado y decide si un humano
 * tiene que mirarlo. PURA — sin IO, sin Date.now() implícito.
 *
 * @param {object|null} prev   estado guardado (null = primera vez)
 * @param {object} actual      { nidProceso, nomenclatura, entidad, valorReferencial,
 *                               fechaPropuesta, diasRestantes, resultado, score,
 *                               docFingerprint, integrada, docEtapa, docHash,
 *                               diasHastaIntegracion }
 * @param {object} opts        { minDias, nowIso }
 * @returns {object} estado nuevo con { novedad, revisar, motivo }
 */
export function reconciliar(prev, actual, { minDias = 15, nowIso } = {}) {
  let novedad = null;
  let motivo = null;
  let revisar = false;

  if (!prev) {
    novedad = "nuevo";
    motivo = "visto por primera vez";
    // Un proceso nuevo solo merece atención humana si ya trae Bases reales.
    // Si no, entra en seguimiento y la alerta llega cuando se integren.
    revisar = actual.integrada === true;
  } else if (actual.integrada && !prev.integrada) {
    novedad = "bases_integradas";
    revisar = true;
    motivo =
      actual.diasRestantes != null && actual.diasRestantes < minDias
        ? `Bases Integradas publicadas, pero quedan ${actual.diasRestantes}d (< ${minDias}) — decidir o soltar`
        : `Bases Integradas publicadas — ${actual.diasRestantes ?? "?"}d para presentar`;
  } else if (actual.resultado !== prev.resultado) {
    novedad = "cambio_evaluacion";
    revisar = true;
    motivo = `evaluación ${prev.resultado} → ${actual.resultado}`;
  } else if (actual.docFingerprint && actual.docFingerprint !== prev.docFingerprint) {
    novedad = "doc_actualizado";
    // Documento nuevo que no es la Integración: una fe de erratas, un anexo.
    // Se re-analiza, pero no se molesta a nadie salvo que cambie el resultado
    // (y en ese caso entra por la rama de arriba en el run siguiente).
    motivo = "documento actualizado en la ficha";
  }

  // Aviso anticipado: la Integración está agendada en el cronograma y todavía
  // no apareció. Es lo que hace accionable el cron — "mañana mirá estos".
  const dInt = actual.diasHastaIntegracion;
  if (!actual.integrada && dInt != null && dInt >= 0 && dInt <= 2) {
    revisar = true;
    motivo = motivo
      ? `${motivo}; integración en ${dInt}d`
      : `integración agendada en ${dInt}d — Bases reales inminentes`;
  }

  // ¿Por qué se pide atención? No es lo mismo "esto califica, mirá" que "no
  // pude leerlo, miralo vos". El segundo no es una oportunidad: es trabajo
  // manual, y mezclarlos hace que el ERP pinte de verde algo que nadie evaluó.
  const revisarTipo = !revisar ? null : actual.resultado === "indeterminado" ? "manual" : "oportunidad";
  if (revisarTipo === "manual") {
    motivo = `${motivo} — sin evaluación automática, revisar a mano`;
  }

  return {
    ...actual,
    primeraVez: prev?.primeraVez || nowIso,
    ultimaVez: nowIso,
    vecesVisto: (prev?.vecesVisto || 0) + 1,
    novedad,
    revisar,
    revisarTipo,
    motivo,
  };
}

/** Estado guardado de un proceso, o null. */
export async function getEstado(nidProceso) {
  const pg = await pgOrNull();
  if (pg) return pg.getEstado(nidProceso);
  const s = await load();
  return s[nidProceso] || null;
}

/** Guarda los estados reconciliados de un run completo. */
export async function saveEstados(estados) {
  const pg = await pgOrNull();
  if (pg) return pg.saveEstados(estados);
  const s = await load();
  for (const e of estados) {
    if (e?.nidProceso) s[e.nidProceso] = e;
  }
  await persist();
}

/**
 * Olvida procesos cuyo plazo venció hace más de `dias`. Sin esto el archivo
 * crece para siempre con procesos que ya no existen para nadie.
 */
export async function purgarVencidos({ dias = 60, now = Date.now() } = {}) {
  const pg = await pgOrNull();
  if (pg) return pg.purgarEstados({ dias });
  const s = await load();
  let n = 0;
  for (const [k, v] of Object.entries(s)) {
    if (!v.fechaPropuesta) continue;
    const t = new Date(v.fechaPropuesta).getTime();
    if (Number.isFinite(t) && now - t > dias * MS_DAY) {
      delete s[k];
      n++;
    }
  }
  if (n) await persist();
  return n;
}

export async function stats() {
  const pg = await pgOrNull();
  if (pg) {
    const { rows } = await (await import("./pgStore.js")).getPool().query(
      `select count(*)::int procesos,
              count(*) filter (where not integrada)::int "enSeguimiento",
              count(*) filter (where integrada)::int "conBasesIntegradas"
       from procesos_estado`
    );
    return rows[0];
  }
  const s = await load();
  const v = Object.values(s);
  return {
    procesos: v.length,
    enSeguimiento: v.filter((x) => !x.integrada).length,
    conBasesIntegradas: v.filter((x) => x.integrada).length,
  };
}
