/**
 * Evalúa si la empresa CALIFICA, NO CALIFICA o puede ir en CONSORCIO
 * para un proceso SEACE de Obra, dado sus requisitos extraídos.
 *
 * Modelo simple y explicable:
 *   - experiencia acumulada monto >= requisitoMonto → CALIFICA
 *   - experiencia acumulada < requisito pero >= (requisito * consorcioRatio) → CONSORCIO
 *   - tipo de obra coincide con especialidades empresa → suma confianza
 *
 * Devuelve razones legibles (para mostrar al cliente en el ERP).
 */

/**
 * Suma monto de obras de la empresa dentro de "antigüedad" (si aplica)
 * y opcionalmente filtradas por tipo.
 */
function experienciaAcumulada(empresa, { antiguedadMaxAnios = null, tipos = [] } = {}) {
  const now = new Date();
  const yearNow = now.getFullYear();
  const obras = (empresa.experiencia || []).filter((o) => {
    if (antiguedadMaxAnios && o.anio && yearNow - o.anio > antiguedadMaxAnios) return false;
    if (tipos.length && o.tipo && !tipos.includes(o.tipo)) return false;
    return true;
  });
  const monto = obras.reduce((acc, o) => acc + (Number(o.monto) || 0), 0);
  return { monto, obras };
}

/**
 * API principal.
 *
 * @param {object} requisitos — output de analizarRequisitos()
 * @param {object} empresa — estructura descrita en data/empresa.json
 * @param {object} opts
 *   - consorcioRatio: mínimo porcentaje del requisito que la empresa debe cubrir
 *                     para que consorcio sea viable (default 0.5 = 50%)
 */
export function evaluarProceso(requisitos, empresa, opts = {}) {
  const { consorcioRatio = 0.5 } = opts;
  const razones = [];
  const datos = {};

  const reqMonto = requisitos?.experienciaMonto ?? null;
  const tiposReq = requisitos?.tiposObraSimilar ?? [];
  const antiguedad = requisitos?.antiguedadMaxAnios ?? null;

  // 1. verificar especialidades
  const especialidadesEmpresa = new Set((empresa.especialidades || []).map((s) => s.toLowerCase()));
  const tiposMatched = tiposReq.filter((t) => especialidadesEmpresa.has(t.toLowerCase()));
  datos.tiposRequeridos = tiposReq;
  datos.tiposMatched = tiposMatched;
  if (tiposReq.length && !tiposMatched.length) {
    razones.push(
      `Tipos de obra requeridos [${tiposReq.join(", ")}] no coinciden con especialidades empresa [${[...especialidadesEmpresa].join(", ")}]`
    );
  }

  // 2. experiencia acumulada
  const { monto: expMonto, obras: expObras } = experienciaAcumulada(empresa, {
    antiguedadMaxAnios: antiguedad,
    tipos: tiposMatched, // si hay match, filtra por esos
  });
  datos.experienciaEmpresa = expMonto;
  datos.obrasContadas = expObras.length;
  datos.requisitoMonto = reqMonto;

  // 3. decisión
  let resultado = "no_califica";
  let gap = null;

  if (reqMonto == null) {
    // no pudimos extraer requisito → marcar indeterminado pero NO rechazar
    resultado = "indeterminado";
    razones.push("No se pudo extraer el monto mínimo de experiencia de las Bases.");
  } else {
    gap = reqMonto - expMonto;
    if (expMonto >= reqMonto) {
      resultado = "califica";
      razones.push(
        `Experiencia empresa S/ ${expMonto.toLocaleString("es-PE")} >= requisito S/ ${reqMonto.toLocaleString("es-PE")}`
      );
    } else if (expMonto >= reqMonto * consorcioRatio) {
      resultado = "consorcio";
      razones.push(
        `Experiencia empresa S/ ${expMonto.toLocaleString("es-PE")} cubre ${Math.round((expMonto / reqMonto) * 100)}% del requisito S/ ${reqMonto.toLocaleString("es-PE")}. Viable con consorcio (gap S/ ${gap.toLocaleString("es-PE")})`
      );
    } else {
      razones.push(
        `Experiencia empresa S/ ${expMonto.toLocaleString("es-PE")} < ${Math.round(consorcioRatio * 100)}% requisito S/ ${reqMonto.toLocaleString("es-PE")}. Gap S/ ${gap.toLocaleString("es-PE")} muy grande.`
      );
    }
  }

  // 4. si tipos no coinciden pero numéricamente califica → forzar a consorcio
  if (resultado === "califica" && tiposReq.length && !tiposMatched.length) {
    resultado = "consorcio";
    razones.push(
      "Monto califica pero especialidad no coincide. Se sugiere consorcio con especialista."
    );
  }

  // 5. sugerencia consorcio estructurada
  let sugerenciaConsorcio = null;
  if (resultado === "consorcio") {
    sugerenciaConsorcio = {
      gapMonto: Math.max(gap || 0, 0),
      especialidadIdeal: tiposReq.find((t) => !especialidadesEmpresa.has(t.toLowerCase())) || null,
      aporteEmpresaPorcentaje: reqMonto ? Math.min(Math.round((expMonto / reqMonto) * 100), 100) : null,
    };
  }

  return {
    resultado, // 'califica' | 'consorcio' | 'no_califica' | 'indeterminado'
    razones,
    datos,
    sugerenciaConsorcio,
  };
}
