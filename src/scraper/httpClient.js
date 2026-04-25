/**
 * Cliente HTTP directo para SEACE post-bootstrap.
 *
 * Una vez tenemos cookies + javax.faces.ViewState capturados con Playwright,
 * podemos hacer POSTs JSF directamente con undici. Cada request 2-3s vs 30s
 * con Playwright (10× speedup).
 *
 * Modelo:
 *   1. bootstrap() — Playwright 1× por sesión (cada ~25 min)
 *   2. fetchFichaHtml(ids) — POST directo, recibe HTML completo
 *   3. parser cheerio sobre HTML response
 */

import { Pool } from "undici";
import { CookieJar } from "tough-cookie";
import { config } from "../config/config.js";

const SEACE_HOST = "https://prod2.seace.gob.pe";
const FORM_PATH = "/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml";

export class SeaceHttpSession {
  constructor() {
    this.cookies = new CookieJar();
    this.viewState = null;
    this.bootstrapAt = 0;
    this.pool = new Pool(SEACE_HOST, {
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 5,
      pipelining: 1,
    });
  }

  /**
   * Importa cookies de un Playwright context al CookieJar de undici.
   */
  async importPlaywrightCookies(playwrightCookies) {
    for (const ck of playwrightCookies) {
      const cookieStr = `${ck.name}=${ck.value}; Path=${ck.path || "/"}; Domain=${ck.domain.replace(/^\./, "")}`;
      try {
        await this.cookies.setCookie(cookieStr, SEACE_HOST + (ck.path || "/"));
      } catch (e) {
        // ignorar cookies que tough-cookie no acepta
      }
    }
  }

  setViewState(vs) {
    this.viewState = vs;
    this.bootstrapAt = Date.now();
  }

  age() {
    return Date.now() - this.bootstrapAt;
  }

  needsRefresh(maxAgeMs = 25 * 60_000) {
    return !this.viewState || this.age() > maxAgeMs;
  }

  async cookieHeader() {
    return this.cookies.getCookieString(SEACE_HOST + FORM_PATH);
  }

  /**
   * POST JSF al form buscador. Reusa cookies + ViewState.
   *
   * @param {Record<string,string>} params - body params (form-urlencoded)
   * @returns {Promise<{html: string, status: number, headers: object}>}
   */
  async postForm(params) {
    if (!this.viewState) {
      throw new Error("HttpSession sin ViewState — llamar bootstrap primero");
    }

    const body = new URLSearchParams({
      "javax.faces.ViewState": this.viewState,
      ...params,
    });

    const cookieStr = await this.cookieHeader();

    const { statusCode, headers, body: respBody } = await this.pool.request({
      path: FORM_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-PE,es;q=0.9",
        "Cookie": cookieStr,
        "Referer": SEACE_HOST + FORM_PATH,
        "Origin": SEACE_HOST,
        "X-Requested-With": "XMLHttpRequest", // a veces JSF lo espera
      },
      body: body.toString(),
      bodyTimeout: 60_000,
      headersTimeout: 30_000,
    });

    // capturar nuevas cookies del Set-Cookie
    const setCookies = headers["set-cookie"];
    if (setCookies) {
      const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
      for (const sc of arr) {
        try {
          await this.cookies.setCookie(sc, SEACE_HOST + FORM_PATH);
        } catch {}
      }
    }

    const html = await respBody.text();

    // capturar nuevo ViewState si aparece (JSF lo rota a veces)
    const vsMatch = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
    if (vsMatch && vsMatch[1] !== this.viewState) {
      this.viewState = vsMatch[1];
    }

    return { html, status: statusCode, headers };
  }

  async close() {
    await this.pool.close().catch(() => {});
  }
}

/**
 * Singleton de sesión por proceso. Compartido entre llamadas.
 */
let _session = null;
export function getSession() {
  if (!_session) _session = new SeaceHttpSession();
  return _session;
}

export function resetSession() {
  if (_session) _session.close();
  _session = null;
}
