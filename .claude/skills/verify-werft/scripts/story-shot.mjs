#!/usr/bin/env node
// Capture one Storybook story, or one page of the web console's demo mode
// (T1: UI-only change, no stack). Needs a running `storybook dev` (or a static
// `storybook build` served over http) or `vite --mode demo`, and the repo's
// installed playwright-core with a system Chrome.
//
//   story-shot.mjs <base url> <story id | /path> <out.png> [full]
//   W=390 H=900 THEME=dark LOCALE=en story-shot.mjs http://127.0.0.1:6107 screens-members-v3--members x.png
//   W=390 story-shot.mjs http://127.0.0.1:6108 '/#/members' x.png    (demo mode routes live in the hash)
//
// An id starting with "/" is a page path; anything else is a story id. Prints
// the target, document scrollWidth/innerWidth (equal: no horizontal overflow)
// and any page error or console error the page raised.
import { chromium } from "playwright-core";

const [base, id, out, full] = process.argv.slice(2);
if (!base || !id || !out) {
  console.error(
    "usage: story-shot.mjs <base url> <story id | /path> <out.png> [full]",
  );
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
    isMobile: width < 600,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  const isPage = id.startsWith("/");
  const url = new URL(isPage ? id : "/iframe.html", base);
  if (!isPage) {
    url.searchParams.set("id", id);
    url.searchParams.set("viewMode", "story");
    url.searchParams.set("globals", `theme:${theme};locale:${locale}`);
  }
  await page.goto(url.href, { waitUntil: "load" });
  await page
    .locator(isPage ? "#root > *" : "#storybook-root > *")
    .first()
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Demo-mode data arrives after first paint; a story is settled by here.
  if (isPage) await page.waitForTimeout(1500);
  await page.screenshot({ path: out, fullPage: full === "full" });
  const { sw, iw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  console.log(`${id} ${theme} ${locale} scrollWidth/innerWidth=${sw}/${iw}`);
  for (const e of errors) console.log(e);
} finally {
  await browser.close();
}
