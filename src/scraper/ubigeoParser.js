/**
 * UBIGEO parser: extrae región / provincia / distrito desde nombre de entidad SEACE.
 *
 * Cobertura ~80% sin tabla externa. Para casos no cubiertos cae a null y
 * el LLM puede llenar `lugar_ejecucion` desde el PDF.
 *
 * Patrones SEACE:
 *   - GOBIERNO REGIONAL DE <REGION>             → región
 *   - GOBIERNO REGIONAL <REGION>                 → región
 *   - MUNICIPALIDAD PROVINCIAL DE <PROVINCIA>    → provincia
 *   - MUNICIPALIDAD DISTRITAL DE <DISTRITO>      → distrito (provincia/región se infieren con tabla)
 *   - MUNICIPALIDAD METROPOLITANA DE LIMA         → Lima
 */

// Regiones del Perú (24 + Callao + Lima Metro)
const REGIONES = [
  "AMAZONAS", "ANCASH", "ANCASH-TRANSPORTES", "APURIMAC", "AREQUIPA",
  "AYACUCHO", "CAJAMARCA", "CALLAO", "CUSCO", "HUANCAVELICA",
  "HUANUCO", "ICA", "JUNIN", "LA LIBERTAD", "LAMBAYEQUE",
  "LIMA", "LORETO", "MADRE DE DIOS", "MOQUEGUA", "PASCO",
  "PIURA", "PUNO", "SAN MARTIN", "TACNA", "TUMBES", "UCAYALI",
  "HVCA", // alias HUANCAVELICA usado en SEACE
];

const REGION_ALIAS = {
  "HVCA": "HUANCAVELICA",
  "ANCASH-TRANSPORTES": "ANCASH",
  "GR.LAMB": "LAMBAYEQUE",
  "GRSM": "SAN MARTIN",
  "GRA": "ANCASH",
  "GRP": "PIURA",
  "GRML": "LIMA",
};

/**
 * Tabla mínima distrito → provincia → región (subset común).
 * Para producción completa: cargar `data/ubigeo.json` (1900 distritos).
 */
const DISTRITOS_LIMA = [
  "ATE", "BARRANCO", "BREÑA", "CARABAYLLO", "CHACLACAYO", "CHORRILLOS",
  "CIENEGUILLA", "COMAS", "EL AGUSTINO", "INDEPENDENCIA", "JESUS MARIA",
  "LA MOLINA", "LA VICTORIA", "LIMA", "LINCE", "LOS OLIVOS", "LURIGANCHO",
  "LURIN", "MAGDALENA", "MIRAFLORES", "PACHACAMAC", "PUCUSANA", "PUEBLO LIBRE",
  "PUENTE PIEDRA", "PUNTA HERMOSA", "PUNTA NEGRA", "RIMAC", "SAN BARTOLO",
  "SAN BORJA", "SAN ISIDRO", "SAN JUAN DE LURIGANCHO", "SAN JUAN DE MIRAFLORES",
  "SAN LUIS", "SAN MARTIN DE PORRES", "SAN MIGUEL", "SANTA ANITA",
  "SANTA MARIA DEL MAR", "SANTA ROSA", "SANTIAGO DE SURCO", "SURQUILLO",
  "VILLA EL SALVADOR", "VILLA MARIA DEL TRIUNFO",
];

const DISTRITO_TO_PROVINCIA_REGION = {};
for (const d of DISTRITOS_LIMA) DISTRITO_TO_PROVINCIA_REGION[d] = { provincia: "LIMA", region: "LIMA" };

// agregar provincias importantes capital
const PROVINCIA_TO_REGION = {
  "LIMA": "LIMA",
  "TRUJILLO": "LA LIBERTAD",
  "AREQUIPA": "AREQUIPA",
  "CUSCO": "CUSCO",
  "PIURA": "PIURA",
  "CHICLAYO": "LAMBAYEQUE",
  "HUANCAYO": "JUNIN",
  "TACNA": "TACNA",
  "TUMBES": "TUMBES",
  "ICA": "ICA",
  "PUNO": "PUNO",
  "AYACUCHO": "AYACUCHO",
  "CAJAMARCA": "CAJAMARCA",
  "MOYOBAMBA": "SAN MARTIN",
  "TARAPOTO": "SAN MARTIN",
  "PUERTO MALDONADO": "MADRE DE DIOS",
  "MOQUEGUA": "MOQUEGUA",
  "CERRO DE PASCO": "PASCO",
  "HUANUCO": "HUANUCO",
  "HUARAZ": "ANCASH",
  "CHIMBOTE": "ANCASH",
  "ABANCAY": "APURIMAC",
  "HUANCAVELICA": "HUANCAVELICA",
  "PUCALLPA": "UCAYALI",
  "IQUITOS": "LORETO",
  "CHACHAPOYAS": "AMAZONAS",
};

/**
 * Normaliza string para match: uppercase, sin tildes, trim.
 */
function norm(s) {
  return String(s || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolución cascada: dado un distrito, devuelve {distrito, provincia, region}.
 */
function resolveFromDistrito(distrito) {
  const d = norm(distrito);
  const hit = DISTRITO_TO_PROVINCIA_REGION[d];
  if (hit) return { distrito: d, provincia: hit.provincia, region: hit.region };
  return { distrito: d, provincia: null, region: null };
}

function resolveFromProvincia(provincia) {
  const p = norm(provincia);
  const region = PROVINCIA_TO_REGION[p] || null;
  return { distrito: null, provincia: p, region };
}

function resolveFromRegion(region) {
  let r = norm(region);
  if (REGION_ALIAS[r]) r = REGION_ALIAS[r];
  if (REGIONES.includes(r) || Object.values(REGION_ALIAS).includes(r)) {
    return { distrito: null, provincia: null, region: r };
  }
  return { distrito: null, provincia: null, region: null };
}

/**
 * Extrae ubicación desde nombre de entidad SEACE.
 * @returns {{distrito, provincia, region}} con nulls si no se pudo resolver
 */
export function parseUbicacionFromEntidad(entidad) {
  if (!entidad) return { distrito: null, provincia: null, region: null };
  const e = norm(entidad);

  // 1. MUNICIPALIDAD METROPOLITANA DE LIMA
  if (/MUNICIPALIDAD METROPOLITANA DE LIMA/.test(e)) {
    return { distrito: "LIMA", provincia: "LIMA", region: "LIMA" };
  }

  // 2. MUNICIPALIDAD DISTRITAL DE X
  let m = e.match(/MUNICIPALIDAD DISTRITAL DE\s+([A-ZÑ\s]+?)(?:[,\-/]|$)/);
  if (m) return resolveFromDistrito(m[1].trim());

  // 3. MUNICIPALIDAD PROVINCIAL DE X
  m = e.match(/MUNICIPALIDAD PROVINCIAL DE\s+([A-ZÑ\s]+?)(?:[,\-/]|$)/);
  if (m) return resolveFromProvincia(m[1].trim());

  // 4. GOBIERNO REGIONAL DE/DEL X
  m = e.match(/GOBIERNO REGIONAL\s+(?:DE|DEL)?\s*([A-ZÑ\s]+?)(?:[,\-/]|$)/);
  if (m) return resolveFromRegion(m[1].trim());

  // 5. fallback: buscar nombre de región en cualquier parte
  for (const r of REGIONES) {
    if (e.includes(r)) return resolveFromRegion(r);
  }

  // 6. fallback: alias conocidos
  for (const [alias, region] of Object.entries(REGION_ALIAS)) {
    if (e.includes(alias)) return resolveFromRegion(region);
  }

  return { distrito: null, provincia: null, region: null };
}

/**
 * Mismo, pero también admite hint del LLM (lugar_ejecucion del PDF).
 * Si entidad no resuelve, intenta extraer del texto libre.
 */
export function parseUbicacionMixed(entidad, lugarEjecucion = null) {
  const fromEnt = parseUbicacionFromEntidad(entidad);
  if (fromEnt.region) return fromEnt;

  if (lugarEjecucion) {
    const t = norm(lugarEjecucion);
    // patterns:
    //   "Distrito de X, Provincia de Y, Departamento de Z"
    //   "Departamento: X, Provincia: Y, Distrito: Z"
    let m = t.match(/DEPARTAMENTO\s*:?\s*(?:DE\s+)?([A-ZÑ\s]+?)(?:[,\.\:]|$)/);
    if (m) {
      const r = resolveFromRegion(m[1].trim());
      if (r.region) return r;
    }
    m = t.match(/DISTRITO\s*:?\s*(?:DE\s+)?([A-ZÑ\s]+?)(?:[,\.\:]|$)/);
    if (m) {
      const r = resolveFromDistrito(m[1].trim());
      if (r.region || r.provincia) return r;
    }
    m = t.match(/PROVINCIA\s*:?\s*(?:DE\s+)?([A-ZÑ\s]+?)(?:[,\.\:]|$)/);
    if (m) {
      const r = resolveFromProvincia(m[1].trim());
      if (r.region) return r;
    }
  }

  return fromEnt; // null nulls
}
