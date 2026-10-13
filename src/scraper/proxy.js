/**
 * Salida por proxy. SEACE geo-bloquea: desde fuera de Perú los dos hosts
 * (prod2 y alfprod) devuelven 403 a cualquier request, con o sin UA de
 * browser. El contenedor puede vivir donde sea, pero el ÚLTIMO salto tiene
 * que tener IP peruana.
 *
 * Playwright ya lee PROXY_SERVER/USER/PASS por su cuenta (browserPool.js).
 * Esto es lo mismo para las dos rutas HTTP que no pasan por el browser:
 * el Pool de undici (httpClient.js) y el fetch global (descargaHttp.js).
 */

import { ProxyAgent, setGlobalDispatcher } from "undici";

/** Basic auth del CONNECT. Exportado para test. */
export function _authToken(user, pass) {
  if (!user) return undefined;
  return `Basic ${Buffer.from(`${user}:${pass || ""}`).toString("base64")}`;
}

let _agent;

/**
 * El ProxyAgent del proceso, o null si no hay PROXY_SERVER.
 *
 * Singleton: un solo pool de conexiones al proxy. Además arma el dispatcher
 * global, que es el único enganche que tiene `fetch()` — no acepta proxy por
 * parámetro.
 *
 * ponytail: todo el tráfico sale por acá, no hay NO_PROXY. Las únicas
 * salidas del proceso son SEACE y las APIs de LLM; que esas también pasen
 * por Lima cuesta milisegundos y ahorra una lista de excepciones.
 */
export function proxyAgent() {
  if (_agent !== undefined) return _agent;
  const uri = process.env.PROXY_SERVER;
  if (!uri) return (_agent = null);
  _agent = new ProxyAgent({
    uri,
    token: _authToken(process.env.PROXY_USER, process.env.PROXY_PASS),
  });
  setGlobalDispatcher(_agent);
  console.log(`[proxy] salida por ${new URL(uri).host}`);
  return _agent;
}
