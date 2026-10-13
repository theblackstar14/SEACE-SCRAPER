/**
 * Check mínimo del evaluador. Correr: node test/evaluator.test.js
 * ponytail: sin framework — assert basta para dos bugs concretos.
 */
import assert from "node:assert/strict";
import { evaluarProceso } from "../src/analyzer/evaluator.js";

const empresa = {
  especialidades: ["edificacion", "saneamiento", "muros"],
  experiencia: [
    { tipo: "edificacion", monto: 2_800_000, anio: 2022 },
    { tipo: "saneamiento", monto: 5_000_000, anio: 2021 },
  ],
};

// Bug 1: monto 0 = "no aplica", no un requisito que cumplimos
for (const monto of [0, null, undefined]) {
  const r = evaluarProceso({ experienciaMonto: monto, tiposObraSimilar: [] }, empresa);
  assert.equal(r.resultado, "indeterminado", `monto=${monto} debería ser indeterminado`);
}

// Bug 2: tipos deben matchear sin importar tildes ni mayúsculas
for (const tipo of ["edificacion", "Edificacion", "Edificación", "EDIFICACIÓN"]) {
  const r = evaluarProceso(
    { experienciaMonto: 2_000_000, tiposObraSimilar: [tipo] },
    empresa
  );
  assert.equal(r.resultado, "califica", `tipo=${tipo} debería calificar`);
  assert.equal(r.datos.experienciaEmpresa, 2_800_000, `tipo=${tipo}: experiencia mal filtrada`);
}

// no-regresión: tipo que no hacemos sigue sin calificar
const otro = evaluarProceso(
  { experienciaMonto: 2_000_000, tiposObraSimilar: ["Carretera"] },
  empresa
);
assert.equal(otro.resultado, "consorcio", "tipo ajeno: monto califica pero especialidad no");
assert.equal(otro.sugerenciaConsorcio.especialidadIdeal, "Carretera");

console.log("ok");
