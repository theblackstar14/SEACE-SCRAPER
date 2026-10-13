import assert from "node:assert";
import test from "node:test";
import { getGlobalDispatcher } from "undici";

// el singleton se arma UNA vez por proceso, así que el env va antes del import
process.env.PROXY_SERVER = "http://127.0.0.1:9999";
process.env.PROXY_USER = "u";
process.env.PROXY_PASS = "p";
const { proxyAgent, _authToken } = await import("../src/scraper/proxy.js");

test("auth token", () => {
  assert.strictEqual(_authToken(undefined, "p"), undefined);
  assert.strictEqual(_authToken("u", "p"), "Basic dTpw");
  // proxy sin password: el `:` tiene que estar igual o el server corta el header
  assert.strictEqual(_authToken("u"), `Basic ${Buffer.from("u:").toString("base64")}`);
});

test("el agent queda como dispatcher global (lo que ve fetch)", () => {
  const a = proxyAgent();
  assert.ok(a, "con PROXY_SERVER debe haber agent");
  assert.strictEqual(getGlobalDispatcher(), a);
  assert.strictEqual(proxyAgent(), a, "singleton");
});
