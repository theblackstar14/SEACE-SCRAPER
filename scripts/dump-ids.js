// throwaway: dumpea los IDs reales del form buscador para re-sincronizar SEL
import "dotenv/config";
import { withPage, shutdownBrowser } from "../src/browserPool.js";
import { config } from "../src/config/config.js";
import { SEL, T } from "../src/scraper/selectors.js";

await withPage(async (page) => {
  await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: T.goto });
  await page.waitForSelector(SEL.tabBuscador, { timeout: T.selector });
  await page.click(SEL.tabBuscador);
  await page.waitForSelector(SEL.btnBuscar, { state: "visible", timeout: T.selector });

  const info = await page.evaluate(() => {
    const out = { selectOneMenus: [], calendars: [], inputs: [] };
    for (const el of document.querySelectorAll(".ui-selectonemenu")) {
      const label = el.querySelector(".ui-selectonemenu-label");
      const panel = document.getElementById(el.id + "_panel");
      out.selectOneMenus.push({
        id: el.id,
        labelText: label?.textContent?.trim() || null,
        opciones: panel
          ? [...panel.querySelectorAll("li")].map((li) => li.textContent.trim()).slice(0, 8)
          : [],
      });
    }
    for (const el of document.querySelectorAll(".ui-calendar input")) {
      out.calendars.push(el.id);
    }
    for (const el of document.querySelectorAll("#tbBuscador\\:idFormBuscarProceso input[id]")) {
      out.inputs.push(el.id);
    }
    return out;
  });

  console.log(JSON.stringify(info, null, 2));
});

await shutdownBrowser();
