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
 * Normaliza string para matching laxo (lowercase, sin tildes).
 */
function normLower(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Match heurístico rol requerido vs persona empresa.
 * Score: profesión exacta + especialidad keyword en rol + experiencia >= req.
 */
// alias para matchear keywords variantes en el rol
const ESPECIALIDAD_ALIAS = {
  saneamiento: ["sanitar", "sanitaria", "saneamient", "agua", "alcantarillad"],
  estructuras: ["estructur", "concreto", "armado"],
  suelos: ["suelo", "geotecnic", "mecanica de suelos"],
  electricas: ["electric", "electromec"],
  arquitectura: ["arquitect"],
  residente: ["residente", "jefe de obra"],
  costos: ["costo", "metrad", "presupuesto", "valoriz"],
  seguridad: ["seguridad", "sst", "salud ocupac"],
};

function matchRolToPersona(reqRol, persona) {
  const rolN = normLower(reqRol.rol);
  const expReqGeneral = reqRol.expGeneralMeses || 0;
  const expReqEspec = reqRol.expEspecificaMeses || 0;
  const profReq = normLower(reqRol.profesion);
  const profP = normLower(persona.profesion);
  const espP = normLower(persona.especialidad);
  const expP = persona.expMeses || 0;

  // 1. profesión debe coincidir si está especificada
  let profMatched = true;
  if (profReq && profP) {
    profMatched = profP.includes(profReq) || profReq.includes(profP);
    if (!profMatched) return null;
  }

  // 2. experiencia general suficiente
  if (expReqGeneral && expP < expReqGeneral) return null;

  // 3. matching especialidad (laxo):
  //    a) keyword directo de especialidad en rol
  //    b) keyword alias en rol
  //    c) profesión coincidió + rol no especifica subespecialidad → OK
  let especialidadMatch = false;
  let scoreMatch = 0;
  if (espP) {
    if (rolN.includes(espP)) {
      especialidadMatch = true;
      scoreMatch = 3;
    } else {
      const aliases = ESPECIALIDAD_ALIAS[espP] || [];
      if (aliases.some((a) => rolN.includes(a))) {
        especialidadMatch = true;
        scoreMatch = 2;
      }
    }
  }
  // si rol genérico (residente, asistente) y profesión coincide → match
  if (!especialidadMatch && profMatched && profReq) {
    const generico = /residente|asistente|jefe|supervisor|inspector|coordinador/.test(rolN);
    if (generico) {
      especialidadMatch = true;
      scoreMatch = 1;
    }
  }
  // si rol no menciona especialidad pero profesión coincide
  if (!especialidadMatch && profMatched && profReq) {
    const tieneSubespec = /especialista|esp\.|especialidad/.test(rolN);
    if (!tieneSubespec) {
      especialidadMatch = true;
      scoreMatch = 1;
    }
  }

  if (!especialidadMatch) return null;

  // 4. experiencia específica: si persona >= req → cumple
  const cumpleEspec = expReqEspec ? expP >= expReqEspec : true;

  return {
    persona: persona.nombres,
    cumple: cumpleEspec,
    expPersona: expP,
    expRequerida: { general: expReqGeneral, especifica: expReqEspec },
    scoreMatch, // mayor = mejor match (3 keyword exacto, 2 alias, 1 profesión solo)
  };
}

/**
 * Evalúa si la empresa puede cumplir el plantel requerido.
 * @returns {{cumple: 'si'|'parcial'|'no', cubiertos, faltantes, asignaciones}}
 */
function evaluarPlantel(plantelReq, personal) {
  if (!plantelReq?.length) {
    return { cumple: "si", cubiertos: 0, total: 0, faltantes: [], asignaciones: [] };
  }
  if (!personal?.length) {
    return {
      cumple: "no",
      cubiertos: 0,
      total: plantelReq.length,
      faltantes: plantelReq.map((r) => r.rol),
      asignaciones: [],
    };
  }

  const usados = new Set(); // dni o nombres
  const asignaciones = [];
  const faltantes = [];

  for (const req of plantelReq) {
    let mejorMatch = null;
    for (const p of personal) {
      const key = p.dni || p.nombres;
      if (usados.has(key)) continue;
      const m = matchRolToPersona(req, p);
      if (!m) continue;
      // ranking: scoreMatch desempata por experiencia
      const isBetter =
        !mejorMatch ||
        m.scoreMatch > mejorMatch.scoreMatch ||
        (m.scoreMatch === mejorMatch.scoreMatch && m.expPersona > mejorMatch.expPersona);
      if (isBetter) {
        mejorMatch = { ...m, key, rol: req.rol };
      }
    }
    if (mejorMatch) {
      usados.add(mejorMatch.key);
      asignaciones.push(mejorMatch);
    } else {
      faltantes.push(req.rol);
    }
  }

  const cubiertos = asignaciones.length;
  const total = plantelReq.length;
  let cumple = "no";
  if (cubiertos === total) cumple = "si";
  else if (cubiertos >= Math.ceil(total / 2)) cumple = "parcial";

  return { cumple, cubiertos, total, faltantes, asignaciones };
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

  // 6. plantel profesional
  const plantelReq = requisitos?.plantel || [];
  const evalPlantel = evaluarPlantel(plantelReq, empresa.personal || []);
  datos.plantel = evalPlantel;
  if (plantelReq.length) {
    if (evalPlantel.cumple === "no") {
      razones.push(
        `Plantel profesional: 0/${evalPlantel.total} roles cubiertos (faltan: ${evalPlantel.faltantes.join(", ")})`
      );
    } else if (evalPlantel.cumple === "parcial") {
      razones.push(
        `Plantel profesional: ${evalPlantel.cubiertos}/${evalPlantel.total} roles cubiertos (faltan: ${evalPlantel.faltantes.join(", ")})`
      );
    } else {
      razones.push(`Plantel profesional: ${evalPlantel.cubiertos}/${evalPlantel.total} roles cubiertos.`);
    }
    // si plantel falta y resultado era califica → bajar a consorcio
    if (resultado === "califica" && evalPlantel.cumple === "no") {
      resultado = "consorcio";
      razones.push("Monto califica pero falta plantel completo. Considerar consorcio o subcontratar especialistas.");
    }
  }

  return {
    resultado, // 'califica' | 'consorcio' | 'no_califica' | 'indeterminado'
    razones,
    datos,
    sugerenciaConsorcio,
    plantel: evalPlantel,
  };
}
