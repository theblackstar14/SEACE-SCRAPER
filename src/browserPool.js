import { chromium } from "playwright";
import { config } from "./config/config.js";

let browser = null;
let launching = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = chromium.launch({ headless: config.headless }).then((b) => {
    browser = b;
    launching = null;
    b.on("disconnected", () => { browser = null; });
    return b;
  });
  return launching;
}

export async function withPage(fn) {
  const b = await getBrowser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function shutdownBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
