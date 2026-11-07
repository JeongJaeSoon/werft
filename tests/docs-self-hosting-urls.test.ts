import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { remarkHeading } from "fumadocs-core/mdx-plugins";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import guideTargets from "./fixtures/self-hosting-guide-targets.json";
import pages from "./fixtures/self-hosting-pages.json";
import baseline from "./fixtures/self-hosting-public-urls.json";

const root = join(import.meta.dir, "../apps/docs/content/docs");
const prefix = "run-server/self-hosting";
const held = /operate\/(session-data-flow|monitoring-datadog)$/;

interface Node {
  type: string;
  name?: string;
  url?: string;
  attributes?: { type: string; name: string; value: string }[];
  data?: { hProperties?: { id?: string } };
  children?: Node[];
}

function readPage(path: string, locale: string) {
  const base = join(root, path || "index");
  const localized = `${base}.${locale}.mdx`;
  const source =
    locale !== "ko" && existsSync(localized) ? localized : `${base}.mdx`;
  return readFileSync(source, "utf8");
}

const inspected = new Map<
  string,
  {
    ids: string[];
    links: string[];
    nativeIds: string[];
    guides: Record<string, string>;
  }
>();

function inspect(text: string) {
  const cached = inspected.get(text);
  if (cached) return cached;
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMdx)
    .use(remarkHeading);
  const tree = processor.runSync(
    processor.parse(text.replace(/^---\n[\s\S]*?\n---\n/, "")),
  ) as Node;
  const ids: string[] = [];
  const links: string[] = [];
  const nativeIds: string[] = [];
  const guides: Record<string, string> = {};
  let pending: string[] = [];
  function walk(node: Node) {
    const id = node.data?.hProperties?.id;
    if (id) {
      ids.push(id);
      nativeIds.push(id);
      pending = [];
    }
    if (node.name === "a") {
      const id = node.attributes?.find((a) => a.name === "id")?.value;
      if (id) {
        ids.push(id);
        pending.push(id);
      }
    }
    if (node.type === "link" && node.url) {
      links.push(node.url);
      for (const anchor of pending) guides[anchor] = node.url;
      pending = [];
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(tree);
  const result = { ids, links, nativeIds, guides };
  inspected.set(text, result);
  return result;
}

function targetExists(href: string, current: string, locale: string) {
  if (!href.startsWith("/") && !href.startsWith("#")) return true;
  const url = new URL(href, `https://docs.invalid/${locale}/${current}`);
  const targetLocale = url.pathname.match(/^\/(ko|en|ja)\//)?.[1] ?? locale;
  let path = decodeURIComponent(url.pathname)
    .replace(/^\/(ko|en|ja)\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  if (path.startsWith("reference/http-api/")) return true;
  if (!path) path = "index";
  const source = existsSync(join(root, `${path}.mdx`)) ? path : `${path}/index`;
  try {
    const target = inspect(readPage(source, targetLocale));
    return (
      !url.hash || target.ids.includes(decodeURIComponent(url.hash.slice(1)))
    );
  } catch {
    return false;
  }
}

function previousRouteProblems(
  text: string,
  old: (typeof baseline.pages)[number],
) {
  const { ids, nativeIds, guides } = inspect(text);
  const routes = (
    guideTargets as Record<string, Record<string, string | null>>
  )[old.page || "index"];
  return old.fragments.filter((id) => {
    if (!ids.includes(id)) return true;
    if (held.test(old.page)) return false;
    const expected = routes?.[id];
    if (expected === null) return !nativeIds.includes(id);
    return (
      !expected ||
      guides[id] !== expected ||
      !targetExists(expected, `${prefix}/${old.page || "index"}`, old.locale)
    );
  });
}

// This fixture predates the rewrite. It is deliberately not regenerated from
// the new pages: doing so would make deleted public fragments invisible.
describe("self-hosting public URL contract", () => {
  test("the baseline contains all previous pages and fragments", () => {
    expect(baseline.pages).toHaveLength(45);
    expect(
      baseline.pages.reduce((count, page) => count + page.fragments.length, 0),
    ).toBe(435);
  });

  test("deleting an actual guide link breaks its previous routes", () => {
    const old = baseline.pages.find(
      (page) => page.locale === "ko" && page.page === "operate/metrics",
    );
    expect(old).toBeDefined();
    if (!old) return;
    const text = readPage(`${prefix}/operate/metrics`, "ko");
    const mutated = text.replace(/\[Kubernetes 지표 수집\]\([^\n)]+\)/, "");
    expect(mutated).not.toBe(text);
    expect(previousRouteProblems(mutated, old)).not.toEqual([]);
  });

  test("sending an actual guide to the wrong existing page breaks its previous routes", () => {
    const old = baseline.pages.find(
      (page) => page.locale === "ko" && page.page === "operate/metrics",
    );
    expect(old).toBeDefined();
    if (!old) return;
    const text = readPage(`${prefix}/operate/metrics`, "ko");
    const mutated = text.replace(
      /\[Kubernetes 지표 수집\]\([^\n)]+\)/,
      "[지표 수집](/run-server/self-hosting/reference/storage#계약)",
    );
    expect(mutated).not.toBe(text);
    expect(previousRouteProblems(mutated, old)).not.toEqual([]);
  });
  for (const old of baseline.pages) {
    const path = `${prefix}${old.page ? `/${old.page}` : "/index"}`;
    test(`${old.locale}/${old.page}: previous public fragments survive`, () => {
      const { ids } = inspect(readPage(path, old.locale));
      expect(previousRouteProblems(readPage(path, old.locale), old)).toEqual(
        [],
      );
      expect(new Set(ids).size).toBe(ids.length);
    });
  }

  test("new pages and guide links reach real source pages and fragments", () => {
    const broken: string[] = [];
    for (const file of new Bun.Glob(`${prefix}/**/*.mdx`).scanSync(root)) {
      if (/\.(en|ja)\.mdx$/.test(file) || held.test(file.replace(/\.mdx$/, "")))
        continue;
      const path = file.replace(/\.mdx$/, "");
      for (const locale of ["ko", "en", "ja"]) {
        for (const href of inspect(readPage(path, locale)).links) {
          if (!targetExists(href, path, locale))
            broken.push(`${locale}/${file} -> ${href}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("reader, outcome and page kind match the approved destinations", () => {
    for (const page of pages) {
      const text = readPage(`${prefix}/${page.path}`, "ko");
      expect(text).toContain(`pageId: "${page.id}"`);
      expect(text).toContain(`audience: "${page.audience}"`);
      expect(text).toContain(`outcome: "${page.outcome}"`);
      expect(text).toContain(`docType: "${page.type}"`);
      if (page.type !== "설치" && page.type !== "작업") continue;
      const headings = [
        "무엇을 하게 되나",
        "준비물",
        "단계",
        "확인",
        "자주 막히는 곳",
        "되돌리기",
        "다음에 읽을 곳",
      ];
      const offsets = headings.map((h) => text.indexOf(`\n## ${h}\n`));
      expect(
        offsets.every(
          (offset, i) =>
            offset >= 0 && (i === 0 || offset > (offsets[i - 1] ?? -1)),
        ),
      ).toBe(true);
    }
  });

  test("the contract detects a removed old fragment and a nonexistent target", () => {
    expect(inspect("## 남긴 절\n").ids).not.toContain("삭제한-절");
    expect(
      targetExists("/run-server/self-hosting/missing", `${prefix}/index`, "ko"),
    ).toBe(false);
    expect(targetExists("#missing", `${prefix}/index`, "ko")).toBe(false);
  });
});
