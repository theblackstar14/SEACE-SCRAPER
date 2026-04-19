import { withPage } from "../browserPool.js";
import { parseTable } from "./parser.js";
import { config } from "../config/config.js";

export async function scrapeSeace({ limit = 10 } = {}) {
  return withPage(async (page) => {
    await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("a[href='#tbBuscador\\:tab1']", { timeout: 60000 });
    await page.click("a[href='#tbBuscador\\:tab1']");
    await page.waitForTimeout(1500);
    await page.click("#tbBuscador\\:idFormBuscarProceso\\:btnBuscarSelToken");
    await page.waitForTimeout(4000);

    await page.waitForFunction(() => {
      const rs = document.querySelectorAll(
        "#tbBuscador\\:idFormBuscarProceso\\:dtProcesos tbody tr"
      );
      return rs.length > 0 && rs[0].innerText.trim().length > 10;
    }, { timeout: 15000 });

    const html = await page.$eval(
      "#tbBuscador\\:idFormBuscarProceso\\:pnlGrdResultadosProcesos",
      (el) => el.innerHTML
    );

    return parseTable(html).slice(0, limit);
  });
}
