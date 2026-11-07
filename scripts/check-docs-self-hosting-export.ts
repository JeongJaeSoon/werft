import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import guideTargets from "../tests/fixtures/self-hosting-guide-targets.json";
import destinations from "../tests/fixtures/self-hosting-language-status.json";
import baseline from "../tests/fixtures/self-hosting-public-urls.json";

const output = join(import.meta.dir, "../apps/docs/out");
const prefix = "/run-server/self-hosting";
const failures: string[] = [];
const cache = new Map<
  string,
  {
    html: string;
    ids: Set<string>;
    links: string[];
    guides: Record<string, string>;
    headings: Set<string>;
  }
>();

function inspect(path: string) {
  const file = join(output, path, "index.html");
  const cached = cache.get(file);
  if (cached) return cached;
  const html = readFileSync(file, "utf8");
  const ids = new Set(
    [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1] ?? ""),
  );
  const links = [...html.matchAll(/\shref="([^"]*)"/g)].map((m) =>
    (m[1] ?? "").replaceAll("&amp;", "&"),
  );
  const guides: Record<string, string> = {};
  const headings = new Set<string>();
  let pending: string[] = [];
  for (const match of html.matchAll(/<(a|h[1-6])\b([^>]*)>/g)) {
    const attrs = match[2] ?? "";
    const id = attrs.match(/\bid="([^"]*)"/)?.[1];
    const href = attrs.match(/\bhref="([^"]*)"/)?.[1];
    if (match[1] !== "a") {
      pending = [];
      if (id) headings.add(id);
    } else if (id && !href) pending.push(id);
    else if (href && pending.length) {
      for (const anchor of pending) guides[anchor] = href;
      pending = [];
    }
  }
  const result = { html, ids, links, guides, headings };
  cache.set(file, result);
  return result;
}

let fragments = 0;
function routeKey(href: string) {
  const url = new URL(href, "https://docs.invalid");
  return url.pathname.replace(/\/$/, "") + decodeURIComponent(url.hash);
}
if (
  baseline.pages.length !== 45 ||
  baseline.pages.reduce((sum, page) => sum + page.fragments.length, 0) !== 435
)
  failures.push("baseline must contain exactly 45 pages and 435 fragments");
for (const old of baseline.pages) {
  const path = `${old.locale}${prefix}${old.page ? `/${old.page}` : ""}`;
  try {
    const page = inspect(path);
    const routes = (
      guideTargets as Record<string, Record<string, string | null>>
    )[old.page || "index"];
    if (routes && old.locale !== "ko") {
      const notice =
        old.locale === "en"
          ? "This page has not been translated into English yet."
          : "このページはまだ日本語に翻訳されていません。";
      if (!page.html.includes(notice))
        failures.push(`${path}: missing old-guide fallback notice`);
    }
    for (const id of old.fragments) {
      fragments++;
      if (!page.ids.has(id)) failures.push(`${path}#${id}: missing fragment`);
      if (!routes) continue;
      const expected = routes[id];
      if (expected === null) {
        if (!page.headings.has(id))
          failures.push(`${path}#${id}: missing native heading`);
      } else {
        const expectedExport = expected?.match(/^\/(ko|en|ja)\//)
          ? `/werft${expected}`
          : `/werft/${old.locale}${expected}`;
        if (
          !expected ||
          !page.guides[id] ||
          routeKey(page.guides[id]) !== routeKey(expectedExport)
        )
          failures.push(
            `${path}#${id}: guide must lead to ${expectedExport}, got ${page.guides[id]}`,
          );
      }
    }
  } catch {
    failures.push(`${path}: missing export`);
  }
}

for (const entry of Object.values(destinations)) {
  if ("integrated" in entry) continue;
  for (const path of entry.paths) {
    for (const locale of ["ko", "en", "ja"] as const) {
      const route = `${locale}/${path === "run-server/self-hosting/index" ? path.slice(0, -6) : path}`;
      const page = inspect(route);
      if (entry.locales[locale] === "fallback") {
        const notice =
          locale === "en"
            ? "This page has not been translated into English yet."
            : "このページはまだ日本語に翻訳されていません。";
        if (!page.html.includes(notice))
          failures.push(`${route}: missing fallback notice`);
      }
    }
  }
}

for (const [file, page] of cache) {
  for (const href of page.links) {
    if (!href.startsWith("/werft/") && !href.startsWith("#")) continue;
    const current = file.slice(output.length).replace(/\/index\.html$/, "/");
    const url = new URL(href, `https://docs.invalid/werft${current}`);
    const target = decodeURIComponent(url.pathname.replace(/^\/werft\//, ""));
    if (/^(api|storybook)(\/|$)/.test(target)) continue;
    const pathname = target.replace(/\/$/, "");
    const exact = join(output, pathname);
    const html = join(exact, "index.html");
    if (!existsSync(html) && !existsSync(exact)) {
      failures.push(`${current} -> ${href}: missing output`);
      continue;
    }
    if (
      url.hash &&
      existsSync(html) &&
      !inspect(pathname).ids.has(decodeURIComponent(url.hash.slice(1)))
    ) {
      failures.push(`${current} -> ${href}: missing output fragment`);
    }
  }
}

if (failures.length) {
  console.error([...new Set(failures)].join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Self-hosting export: ${baseline.pages.length} previous pages, ${fragments} fragments, ${cache.size} HTML pages checked; all links and fallback notices present.`,
  );
}
