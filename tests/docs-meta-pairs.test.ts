import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Folder, Node, Root } from "fumadocs-core/page-tree";
import {
  SECTION_DEPLOY,
  SECTION_USE,
} from "../apps/docs/src/lib/sidebar-sections";
import {
  buildSidebarTree,
  sidebarLabels,
} from "../apps/docs/src/lib/sidebar-tree";

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

// The sidebar's two tabs are rebuilt from the metas by buildSidebarTree.
const page = (url: string, name = url): Node => ({ type: "page", name, url });
const folder = (name: string, children: Node[], index?: string): Node => ({
  type: "folder",
  name,
  children,
  ...(index ? { index: { type: "page", name, url: index } } : {}),
});

const tree: Root = {
  name: "docs",
  children: [
    page("/en"),
    folder("Get started", [page("/en/getting-started/install")]),
    folder("Sessions", [page("/en/sessions/start")]),
    page("/en/observability"),
    folder("Run", [
      page("/en/run-server/dev-server"),
      folder("Self-hosting", [
        // The loader turns the meta's `index` entry into the first child.
        page("/en/run-server/self-hosting"),
        { type: "separator", name: "Trial" },
        page("/en/run-server/self-hosting/try-kind"),
        { type: "separator", name: "Prep" },
        page("/en/run-server/self-hosting/access"),
        { type: "separator", name: "Install" },
        page("/en/run-server/self-hosting/kubernetes"),
        { type: "separator", name: "Operations" },
        page("/en/run-server/self-hosting/capacity"),
        { type: "separator", name: "Reference" },
        page("/en/run-server/self-hosting/reference"),
      ]),
    ]),
    folder("UI", [page("/en/ui/theme")]),
    folder("Reference", [page("/en/reference/api-guide")]),
    page("/en/sdk"),
    page("/en/contributing"),
  ],
};

const out = buildSidebarTree(tree, sidebarLabels.en);
const names = (n: Node[]) => n.map((c) => ("name" in c ? c.name : ""));
const separatorAt = (id: string) =>
  out.children.findIndex((c) => c.type === "separator" && c.$id === id);
// Everything between the two separators, then everything after the second
// up to the trailing contributing page.
const useNodes = out.children.slice(
  separatorAt(SECTION_USE) + 1,
  separatorAt(SECTION_DEPLOY),
);
const deployNodes = out.children.slice(separatorAt(SECTION_DEPLOY) + 1, -1);
const all = (nodes: Node[]) => nodes.flatMap(urls);

function urls(node: Node): string[] {
  if (node.type === "page") return node.external ? [] : [node.url];
  if (node.type !== "folder") return [];
  return [
    ...(node.index ? [node.index.url] : []),
    ...node.children.flatMap(urls),
  ];
}

describe("buildSidebarTree", () => {
  test("one sidebar: a use section, a deploy section, then contributing", () => {
    expect(out.children[0]).toEqual({
      type: "separator",
      $id: SECTION_USE,
      name: "Guides",
    });
    expect(out.children[separatorAt(SECTION_DEPLOY)]).toEqual({
      type: "separator",
      $id: SECTION_DEPLOY,
      name: "Self-hosting",
    });
    expect(separatorAt(SECTION_DEPLOY)).toBeGreaterThan(1);
    expect(out.children.at(-1)).toMatchObject({
      type: "page",
      url: "/en/contributing",
    });
    // No root folder: a root folder would bring the tab dropdown back.
    const roots: Node[] = [];
    const walk = (n: Node) => {
      if (n.type !== "folder") return;
      if (n.root) roots.push(n);
      for (const c of n.children) walk(c);
    };
    for (const c of out.children) walk(c);
    expect(roots).toEqual([]);
  });

  test("every folder it makes has its own id", () => {
    const ids: unknown[] = [];
    const walk = (n: Node) => {
      if (n.type !== "folder") return;
      ids.push(n.$id);
      for (const c of n.children) walk(c);
    };
    for (const c of out.children) walk(c);
    // the input folders carry no id here; the ones it made must all have one
    const own = ids.filter((id) => typeof id === "string");
    expect(own.length).toBeGreaterThanOrEqual(2);
    expect(new Set(own).size).toBe(own.length);
  });

  test("use groups start, features, UI and reference", () => {
    expect(useNodes[0]).toMatchObject({ type: "page", url: "/en" });
    expect(names(useNodes.slice(1))).toEqual([
      "Get started",
      "Features",
      "UI",
      "Reference",
    ]);
    expect(urls(useNodes[1] as Folder)).toContain("/en/run-server/dev-server");
  });

  test("deploy has the index page and five sections that fold", () => {
    expect(deployNodes[0]).toMatchObject({
      type: "page",
      url: "/en/run-server/self-hosting",
    });
    const groups = deployNodes.filter((c) => c.type === "folder");
    expect(names(groups)).toEqual([
      "Trial",
      "Prep",
      "Install",
      "Operations",
      "Reference",
    ]);
    for (const g of groups) expect((g as Folder).defaultOpen).toBeUndefined();
  });

  test("deploy links to observability inside Operations, as a plain page", () => {
    const operations = deployNodes.find(
      (c): c is Folder => c.type === "folder" && c.name === "Operations",
    );
    const link = operations?.children.at(-1);
    expect(link).toMatchObject({
      type: "page",
      name: "Observability (Guides)",
      url: "/en/observability",
    });
    // An external link would skip the site's base path.
    expect((link as { external?: boolean }).external).toBeUndefined();
    expect(all(useNodes)).toContain("/en/observability");
  });

  test("a tree of unlisted pages is returned unchanged", () => {
    const fallback: Root = { name: "fallback", children: [page("/en/x")] };
    expect(buildSidebarTree(fallback, sidebarLabels.en)).toBe(fallback);
  });

  test("each page sits in exactly one section and contributing in none", () => {
    const use = all(useNodes);
    const deploy = all(deployNodes);
    // The only shared URL is the deploy section's link to observability.
    expect(use.filter((u) => deploy.includes(u))).toEqual([
      "/en/observability",
    ]);
    expect([...use, ...deploy]).not.toContain("/en/contributing");
  });
});
