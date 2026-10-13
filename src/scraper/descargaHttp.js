/**
 * Descarga de documentos SEACE sin Playwright.
 *
 * El anchor de la ficha dice:
 *   descargaDocGeneral('<uuid>','3','<filename>')
 * y cmsDescarga.js lo resuelve así (nidSistema==3 → descargaPriv):
 *   1. GET  alfresco/service/osce/downloadDoc?id=<uuid>&doc=cNNN&guest=false
 *      → JSONP: cNNN({"result":200,"downloadUrl":"/..."})
 *   2. GET  <ecmDomain|ecmDomainOp> + downloadUrl   → el archivo
 *
 * Alfresco es otro host: no usa cookies ni ViewState del buscador. O sea que
 * esto NO necesita sesión JSF, NO necesita navegar la ficha de nuevo, y puede
 * ir en paralelo sin el lock de httpClient.js.
 */

// ponytail: fetch global (Node 18+) en vez de undici — sigue redirects solo.
const ECM = "https://alfprod.seace.gob.pe/alfresco";
const ECM_OP = "https://prodcont2.seace.gob.pe/alfresco";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** `cNNN({...});` → el objeto. Exportado para test. */
export function _parseJsonp(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`respuesta JSONP ilegible: ${text.slice(0, 120)}`);
  return JSON.parse(m[0]);
}

/**
 * Resuelve el uuid a una URL directa y baja el archivo.
 *
 * @param {string} uuid      - primer arg de descargaDocGeneral
 * @param {string} filename  - tercer arg, solo fallback de nombre
 * @returns {Promise<{filename, buffer, size, tipo, url}>}
 */
export async function descargarDocHttp(
  uuid,
  filename,
  { timeoutMs = 600_000, counter = 1, retries = 3 } = {}
) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      return await intentarDescarga(uuid, filename, { timeoutMs, counter: counter * 100 + i });
    } catch (e) {
      lastErr = e;
      // el alf_ticket del paso 1 es de un solo uso: hay que re-resolverlo,
      // por eso el retry envuelve los DOS GETs y no solo el del archivo.
      if (i < retries) {
        console.warn(`[descarga retry ${i}/${retries}] ${filename}: ${e.message.slice(0, 80)}`);
        await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
  }
  throw lastErr;
}

async function intentarDescarga(uuid, filename, { timeoutMs, counter }) {
  // `doc` es el nombre del callback JSONP; el server lo refleja. Cualquier
  // string sirve — un contador evita Math.random() y sigue siendo único.
  const cb = `c${counter}`;
  const metaUrl = `${ECM}/service/osce/downloadDoc?id=${encodeURIComponent(uuid)}&doc=${cb}&guest=false`;

  const meta = await fetch(metaUrl, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  const json = _parseJsonp(await meta.text());

  // 200 → nube (ecmDomain), 201 → onpremise (ecmDomainOp). Otro → error.
  // result viene como string ("200"), no number — el JS original usa `==`.
  const base = String(json.result) === "200" ? ECM : String(json.result) === "201" ? ECM_OP : null;
  if (!base || !json.downloadUrl) {
    throw new Error(`alfresco result=${json.result} para ${uuid}`);
  }

  const fileUrl = base + json.downloadUrl;
  const res = await fetch(fileUrl, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bajando ${uuid}`);

  const buffer = Buffer.from(await res.arrayBuffer());

  // el server manda el nombre real en Content-Disposition; el del onclick a
  // veces trae espacios/`+` que no son el nombre en disco
  const cd = res.headers.get("content-disposition") || "";
  const served = decodeURIComponent(
    (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] || "").trim()
  );
  const name = served || filename;

  return {
    filename: name,
    buffer,
    size: buffer.length,
    tipo: (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase(),
    url: fileUrl,
  };
}
