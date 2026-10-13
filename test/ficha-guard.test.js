// node test/ficha-guard.test.js
// El guard de ficha cruzada: lo único que separa "dato de otro proceso" de
// "error". Los 3 bugs de atribución que tuvimos daban HTTP 200 + HTML válido.
import assert from "node:assert";
import { parseFichaHtml } from "../src/scraper/fichaHttp.js";

const ficha = (nomen, entidad) => `
<html><body><table>
  <tr><td>Nomenclatura</td><td>${nomen}</td></tr>
  <tr><td>Entidad Convocante</td><td>${entidad}</td></tr>
</table></body></html>`;

// parseFichaHtml NO debe rellenar la nomenclatura con la pedida — si lo hace,
// el guard de fetchDetalleHttp nunca dispara.
const cruzada = parseFichaHtml(ficha("LP-SM-1-2026-MDM/CS-1", "MALVAS"), {
  nomenclatura: "LP-SM-3-2026-MDP/C-1",
});
assert.strictEqual(cruzada.nomenclatura, "LP-SM-1-2026-MDM/CS-1");
assert.notStrictEqual(cruzada.nomenclatura, "LP-SM-3-2026-MDP/C-1");

// ficha correcta: la nomenclatura parseada es la pedida
const ok = parseFichaHtml(ficha("LP-SM-3-2026-MDP/C-1", "PUCARA - JAEN"), {
  nomenclatura: "LP-SM-3-2026-MDP/C-1",
});
assert.strictEqual(ok.nomenclatura, "LP-SM-3-2026-MDP/C-1");
assert.strictEqual(ok.entidad, "PUCARA - JAEN");

// HTML que no es ficha → _error, no un objeto a medias
assert.ok(parseFichaHtml("<html><body>timeout</body></html>", {})._error);

console.log("ok");
