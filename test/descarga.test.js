// node test/descarga.test.js
import assert from "node:assert";
import { parseSizeMB } from "../src/scraper/documentos.js";
import { _parseJsonp } from "../src/scraper/descargaHttp.js";

// Alfresco devuelve result como STRING ("200"), no number. Un `===` contra
// 200 hacía fallar toda descarga — ese fue el bug al escribir esto.
const ok = _parseJsonp(
  'c1(\n {\n  "result":"200",\n  "downloadUrl":"/service/api/node/content/x/y.pdf?alf_ticket=T"\n }\n);'
);
assert.strictEqual(String(ok.result), "200");
assert.ok(ok.downloadUrl.startsWith("/service/api/node/content/"));

assert.throws(() => _parseJsonp("c1(nope);"), /ilegible/);

// sizeText del HTML de ficha → MB, para el skip por maxDocMB
assert.strictEqual(parseSizeMB("(5884 KB)"), 5884 / 1024);
assert.strictEqual(parseSizeMB("(12 MB)"), 12);
assert.strictEqual(parseSizeMB(null), null);
assert.strictEqual(parseSizeMB("sin tamaño"), null);

console.log("ok");
