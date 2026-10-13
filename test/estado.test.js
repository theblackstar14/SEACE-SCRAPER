// node test/estado.test.js
// reconciliar() decide a quién se molesta. Si se rompe, o el cron grita todas
// las noches por lo mismo, o se come la aparición de las Bases Integradas.
import assert from "node:assert";
import {
  reconciliar,
  fingerprintDoc,
  esIntegrada,
  diasHastaIntegracion,
} from "../src/store/procesoState.js";

const NOW = "2026-10-12T00:00:00.000Z";
const base = {
  nidProceso: "1",
  resultado: "indeterminado",
  docFingerprint: "Convocatoria|Bases Administrativas|b.pdf|(500 KB)",
  integrada: false,
  diasRestantes: 30,
  diasHastaIntegracion: null,
};
const rec = (prev, act) => reconciliar(prev, { ...base, ...act }, { minDias: 15, nowIso: NOW });

// nuevo sin Bases Integradas: se sigue, no se molesta
const nuevo = rec(null, {});
assert.strictEqual(nuevo.novedad, "nuevo");
assert.strictEqual(nuevo.revisar, false);
assert.strictEqual(nuevo.vecesVisto, 1);

// nuevo QUE YA trae Integradas: sí se mira
assert.strictEqual(rec(null, { integrada: true }).revisar, true);

// visto de nuevo sin cambios: silencio (este es el caso del 95% de las noches)
const igual = rec(nuevo, {});
assert.strictEqual(igual.novedad, null);
assert.strictEqual(igual.revisar, false);
assert.strictEqual(igual.vecesVisto, 2);
assert.strictEqual(igual.primeraVez, NOW);

// aparecen las Bases Integradas: ESTA es la alerta que justifica todo
const int = rec(nuevo, { integrada: true, docFingerprint: "Integración|Bases Integradas|bi.pdf|(2 MB)" });
assert.strictEqual(int.novedad, "bases_integradas");
assert.strictEqual(int.revisar, true);

// integradas con poco plazo: avisa igual, pero diciendo que apura
const tarde = rec(nuevo, { integrada: true, diasRestantes: 9 });
assert.strictEqual(tarde.revisar, true);
assert.match(tarde.motivo, /quedan 9d/);

// cambio de evaluación (indeterminado -> califica) también despierta
assert.strictEqual(rec(nuevo, { resultado: "califica" }).novedad, "cambio_evaluacion");

// --- tipo de revisión: oportunidad vs trabajo manual ------------------------
// Las Integradas aparecieron pero el doc no se pudo evaluar: se avisa igual,
// NO como hallazgo. Si esto se mezcla, el ERP pinta de verde algo sin evaluar.
const sinEval = rec(nuevo, { integrada: true });
assert.strictEqual(sinEval.revisar, true);
assert.strictEqual(sinEval.revisarTipo, "manual");
assert.match(sinEval.motivo, /revisar a mano/);

// la misma alerta pero con evaluación real: eso sí es una oportunidad
const conEval = rec(nuevo, { integrada: true, resultado: "califica" });
assert.strictEqual(conEval.revisarTipo, "oportunidad");
assert.doesNotMatch(conEval.motivo, /revisar a mano/);

// sin alerta no hay tipo: null, no "manual"
assert.strictEqual(rec(nuevo, {}).revisarTipo, null);

// doc nuevo que no es la integración: se re-analiza, no se molesta a nadie
const anexo = rec(nuevo, { docFingerprint: "Convocatoria|Anexo|a.pdf|(10 KB)" });
assert.strictEqual(anexo.novedad, "doc_actualizado");
assert.strictEqual(anexo.revisar, false);

// aviso anticipado por cronograma: integración mañana
const pronto = rec(nuevo, { diasHastaIntegracion: 1 });
assert.strictEqual(pronto.revisar, true);
assert.match(pronto.motivo, /integración agendada en 1d/);
// ...pero no si falta una semana
assert.strictEqual(rec(nuevo, { diasHastaIntegracion: 7 }).revisar, false);

// helpers
assert.strictEqual(fingerprintDoc(null), null);
assert.strictEqual(
  fingerprintDoc({ doc: { etapa: "E", documento: "D", descargas: [{ filename: "f.pdf" }], sizeText: "(1 KB)" } }),
  "E|D|f.pdf|(1 KB)"
);
assert.strictEqual(esIntegrada({ confianza: "alta" }), true);
assert.strictEqual(esIntegrada({ confianza: "media" }), false);
assert.strictEqual(esIntegrada(undefined), false);

const crono = [{ etapa: "Integración de las Bases", finIso: "2026-10-15T00:00:00.000Z" }];
assert.strictEqual(diasHastaIntegracion(crono, Date.parse(NOW)), 3);
assert.strictEqual(diasHastaIntegracion([], Date.parse(NOW)), null);

console.log("ok");
