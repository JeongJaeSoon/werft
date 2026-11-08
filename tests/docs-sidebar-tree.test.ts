import { describe, expect, test } from "bun:test";
import type { Folder, Node, Root } from "fumadocs-core/page-tree";
import {
  buildSidebarTree,
  sidebarLabels,
} from "../apps/docs/src/lib/sidebar-tree";

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
      folder(
        "Self-hosting",
        [
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
        ],
        "/en/run-server/self-hosting",
      ),
    ]),
    folder("UI", [page("/en/ui/theme")]),
    folder("Reference", [page("/en/reference/api-guide")]),
    page("/en/sdk"),
    page("/en/contributing"),
  ],
};

const out = buildSidebarTree(tree, sidebarLabels.en);
const names = (n: Node[]) => n.map((c) => ("name" in c ? c.name : ""));
const tab = (name: string) =>
  out.children.find((c): c is Folder => c.type === "folder" && c.name === name);

function urls(node: Node): string[] {
  if (node.type === "page") return node.external ? [] : [node.url];
  if (node.type !== "folder") return [];
  return [
    ...(node.index ? [node.index.url] : []),
    ...node.children.flatMap(urls),
  ];
}

describe("buildSidebarTree", () => {
  test("makes two root folders, use and deploy", () => {
    expect(names(out.children)).toEqual(["Use", "Deploy", "/en/contributing"]);
    for (const c of out.children.slice(0, 2)) {
      expect((c as Folder).root).toBe(true);
    }
  });

  test("every folder it makes has its own id, so only one tab is active", () => {
    const ids: unknown[] = [];
    const walk = (n: Node, made: boolean) => {
      if (n.type !== "folder") return;
      if (made) ids.push(n.$id);
      for (const c of n.children) walk(c, made);
    };
    for (const t of out.children) walk(t, true);
    // the input folders carry no id here; the ones it made must all have one
    const own = ids.filter((id) => typeof id === "string");
    expect(own.length).toBeGreaterThanOrEqual(2);
    expect(new Set(own).size).toBe(own.length);
    expect((out.children[0] as Folder).$id).not.toBe(
      (out.children[1] as Folder).$id,
    );
  });

  test("use groups start, features, UI and reference", () => {
    // The first direct page child is what the tab links to.
    expect(tab("Use")?.children[0]).toMatchObject({ type: "page", url: "/en" });
    expect(names(tab("Use")?.children.slice(1) ?? [])).toEqual([
      "Get started",
      "Features",
      "UI",
      "Reference",
    ]);
    const start = tab("Use")?.children[1] as Folder;
    expect(urls(start)).toContain("/en/run-server/dev-server");
  });

  test("deploy has the index page and five sections that fold", () => {
    const deploy = tab("Deploy");
    expect(deploy?.children[0]).toMatchObject({
      type: "page",
      url: "/en/run-server/self-hosting",
    });
    const groups = (deploy?.children ?? []).filter((c) => c.type === "folder");
    expect(names(groups)).toEqual([
      "Trial",
      "Prep",
      "Install",
      "Operations",
      "Reference",
    ]);
    for (const g of groups) expect((g as Folder).defaultOpen).toBeUndefined();
  });

  test("the observability link is outside the deploy tab's URL set", () => {
    const deploy = tab("Deploy") as Folder;
    expect(urls(deploy)).not.toContain("/en/observability");
    expect(JSON.stringify(deploy)).toContain("Observability (Use)");
    expect(urls(tab("Use") as Folder)).toContain("/en/observability");
  });

  test("a tree of unlisted pages is returned unchanged", () => {
    const fallback: Root = { name: "fallback", children: [page("/en/x")] };
    expect(buildSidebarTree(fallback, sidebarLabels.en)).toBe(fallback);
  });

  test("each page sits in exactly one tab and contributing in none", () => {
    const use = urls(tab("Use") as Folder);
    const deploy = urls(tab("Deploy") as Folder);
    expect(use.filter((u) => deploy.includes(u))).toEqual([]);
    expect([...use, ...deploy]).not.toContain("/en/contributing");
  });
});
