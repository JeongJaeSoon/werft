#!/usr/bin/env node
// Capture one page of the web console's demo mode (T1: UI-only change, no
// stack). Needs a running `vite --mode demo`, and the repo's installed
// playwright-core with a system Chrome.
//
//   page-shot.mjs <base url> </path> <out.png> [full]
//   W=390 H=900 THEME=dark LOCALE=en page-shot.mjs http://127.0.0.1:6108 '/#/members' x.png
//
// Demo mode routes live in the hash. Prints the path, document
// scrollWidth/innerWidth (equal: no horizontal overflow) and any page error or
// console error the page raised.
import { chromium } from "playwright-core";

const [base, path, out, full] = process.argv.slice(2);
if (!base || !path?.startsWith("/") || !out) {
  console.error("usage: page-shot.mjs <base url> </path> <out.png> [full]");
  process.exit(2);
}
const width = Number(process.env.W ?? 1280);
const height = Number(process.env.H ?? 900);
const theme = process.env.THEME === "dark" ? "dark" : "light";
const locale = process.env.LOCALE ?? "ko";

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: theme,
    locale,
    isMobile: width < 600,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(new URL(path, base).href, { waitUntil: "load" });
  await page.locator("#root > *").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  // First paint is not the wanted state: demo data arrives later. SETTLE
  // overrides the pause.
  await page.waitForTimeout(Number(process.env.SETTLE ?? 1500));
  await page.screenshot({ path: out, fullPage: full === "full" });
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  console.log(`${path} ${theme} ${locale} scrollWidth/innerWidth=${sw}/${iw}`);
  for (const e of errors) console.log(e);
} finally {
  await browser.close();
}
