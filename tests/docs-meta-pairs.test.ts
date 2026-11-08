import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const docsRoot = join(import.meta.dir, "..", "apps/docs/content/docs");
const LOCALES = ["en", "ja"] as const;

// The docs root meta lists slugs only, so it has no label to translate.
const SLUG_ONLY_DIRS = new Set([""]);

function metaDirs(dir: string): string[] {
  const found: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  if (
    entries.some((e) => e.isFile() && /^meta(\.[a-z]+)?\.json$/.test(e.name))
  ) {
    found.push(relative(docsRoot, dir));
  }
  for (const e of entries) {
    if (e.isDirectory()) found.push(...metaDirs(join(dir, e.name)));
  }
  return found;
}

// A "---label---" separator and an "external:[label](url)" link carry a translated
// label, so only the separator's position and the link's url count.
function pageSlots(file: string): string[] {
  const meta = JSON.parse(readFileSync(file, "utf8")) as { pages?: string[] };
  return (meta.pages ?? []).map((p) =>
    /^---.*---$/.test(p)
      ? "---"
      : p.replace(/^external:\[.*\]\((.*)\)$/, "external:$1"),
  );
}

const dirs = metaDirs(docsRoot).filter((d) => !SLUG_ONLY_DIRS.has(d));

describe("sidebar meta files exist in ko, en and ja", () => {
  test("the walk finds the meta folders", () => {
    expect(dirs.length).toBeGreaterThan(10);
  });

  for (const dir of dirs) {
    const base = join(docsRoot, dir);
    test(`${dir}: meta.json + meta.en.json + meta.ja.json, same pages`, () => {
      expect(existsSync(join(base, "meta.json"))).toBe(true);
      const ko = pageSlots(join(base, "meta.json"));
      for (const locale of LOCALES) {
        const file = join(base, `meta.${locale}.json`);
        expect(existsSync(file)).toBe(true);
        if (existsSync(file)) expect(pageSlots(file)).toEqual(ko);
      }
    });
  }
});
