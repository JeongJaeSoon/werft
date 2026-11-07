import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import destinations from "./fixtures/self-hosting-language-status.json";
import approvedPages from "./fixtures/self-hosting-pages.json";

const docsRoot = join(import.meta.dir, "..", "apps/docs/content/docs");

const SELF_HOSTING = [
  ...new Set(
    Object.values(destinations)
      .filter((entry) => !("integrated" in entry))
      .flatMap((entry) => entry.paths),
  ),
];

// CI runs only the Korean api-guide, so a translation whose commands drift
// from it would document a flow nobody runs. Translating prose is free; the
// fenced code must stay byte-identical across ko, en and ja.
function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let open: string[] | undefined;
  for (const line of text.split("\n")) {
    if (open === undefined) {
      if (/^```\S*$/.test(line)) open = [line];
      // Indented or ~~~ fences are real code blocks to a Markdown parser but
      // invisible to this extractor, so refuse them instead of skipping them.
      else expect(line).not.toMatch(/^\s*(```|~~~)/);
    } else if (line === "```") {
      blocks.push([...open, line].join("\n"));
      open = undefined;
    } else {
      open.push(line);
    }
  }
  expect(open).toBeUndefined();
  return blocks;
}

function pageBlocks(name: string, locale?: string): string[] {
  const file = locale ? `${name}.${locale}.mdx` : `${name}.mdx`;
  const fallback = Object.values(destinations).some(
    (entry) =>
      entry.paths.includes(name) &&
      locale !== undefined &&
      entry.locales[locale as "en" | "ja"] === "fallback",
  );
  const source = fallback ? `${name}.mdx` : file;
  return fencedBlocks(readFileSync(join(docsRoot, source), "utf8"));
}

describe("translated pages keep the Korean code blocks", () => {
  for (const page of [
    "reference/api-guide",
    "reference/examples",
    ...SELF_HOSTING,
  ]) {
    const source = pageBlocks(page);

    test(`${page}: the Korean source keeps its expected code presence`, () => {
      const expected =
        approvedPages.find(
          (entry) => `run-server/self-hosting/${entry.path}` === page,
        )?.codeBlocks ?? "some";
      if (expected === "none") expect(source).toEqual([]);
      else expect(source.length).toBeGreaterThan(0);
    });

    for (const locale of ["en", "ja"]) {
      test(`${page}.${locale} matches ${page}`, () => {
        expect(pageBlocks(page, locale)).toEqual(source);
      });
    }
  }

  test("P01–P33 and the held pages have explicit language states", () => {
    for (const id of [
      ...Array.from(
        { length: 33 },
        (_, i) => `P${String(i + 1).padStart(2, "0")}`,
      ),
      "H01",
      "H02",
    ]) {
      expect(Object.hasOwn(destinations, id)).toBe(true);
    }
    for (const entry of Object.values(destinations)) {
      for (const path of entry.paths) {
        expect(existsSync(join(docsRoot, `${path}.mdx`))).toBe(true);
        for (const locale of ["en", "ja"] as const) {
          const translated = existsSync(
            join(docsRoot, `${path}.${locale}.mdx`),
          );
          if (entry.locales[locale] === "fallback")
            expect(translated).toBe(false);
          if (entry.locales[locale] === "unchanged")
            expect(translated).toBe(true);
        }
      }
    }
  });

  test("old guide pages use Korean fallback too", () => {
    for (const file of new Bun.Glob(
      "run-server/self-hosting/operate/*.mdx",
    ).scanSync(docsRoot)) {
      if (
        /\.(en|ja)\.mdx$|\/(session-data-flow|monitoring-datadog)\.mdx$/.test(
          file,
        )
      )
        continue;
      expect(fencedBlocks(readFileSync(join(docsRoot, file), "utf8"))).toEqual(
        [],
      );
      for (const locale of ["en", "ja"]) {
        expect(
          existsSync(join(docsRoot, file.replace(/\.mdx$/, `.${locale}.mdx`))),
        ).toBe(false);
      }
    }
  });

  test("the extractor rejects fences it cannot compare", () => {
    expect(() => fencedBlocks("~~~sh\necho a\n~~~\n")).toThrow();
    expect(() => fencedBlocks("   ```sh\necho a\n   ```\n")).toThrow();
    expect(() => fencedBlocks("```sh\necho a\n")).toThrow();
  });

  test("the extractor sees an edited block as a difference", () => {
    const original = "text\n```bash\necho a\n```\n";
    expect(fencedBlocks(original.replace("echo a", "echo b"))).not.toEqual(
      fencedBlocks(original),
    );
  });
});
