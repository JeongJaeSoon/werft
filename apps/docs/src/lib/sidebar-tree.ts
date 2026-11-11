import type { Folder, Node, Root } from "fumadocs-core/page-tree";
import type { Locale } from "./i18n";
import { SECTION_DEPLOY, SECTION_USE } from "./sidebar-sections";

export interface SidebarLabels {
  use: string;
  start: string;
  features: string;
  reference: string;
  deploy: string;
  observabilityLink: string;
}

export const sidebarLabels: Record<Locale, SidebarLabels> = {
  ko: {
    use: "가이드",
    start: "시작",
    features: "기능",
    reference: "레퍼런스",
    deploy: "셀프 호스팅",
    observabilityLink: "관측 (가이드)",
  },
  en: {
    use: "Guides",
    start: "Get started",
    features: "Features",
    reference: "Reference",
    deploy: "Self-hosting",
    observabilityLink: "Observability (Guides)",
  },
  ja: {
    use: "ガイド",
    start: "はじめに",
    features: "機能",
    reference: "リファレンス",
    deploy: "セルフホスト",
    observabilityLink: "観測 (ガイド)",
  },
};

// Each top-level content entry belongs to one of two sections. The files and URLs
// stay where they are; only the tree the sidebar shows is rebuilt.
const HOME = ["index"];
const FEATURES = [
  "agents",
  "sessions",
  "messages",
  "approvals",
  "integrations",
  "api-keys",
  "achievements",
  "observability",
];
const UI = ["ui"];
const REFERENCE = ["reference", "sdk"];

/** `/en/sessions/start` -> `sessions`; the home page `/en` -> `index`. */
function slugOf(node: Node): string {
  const url =
    node.type === "page"
      ? node.url
      : node.type === "folder"
        ? (node.index?.url ?? firstUrl(node.children))
        : undefined;
  return url?.split("/")[2] || "index";
}

function firstUrl(nodes: Node[]): string | undefined {
  for (const n of nodes) {
    if (n.type === "page") return n.url;
    if (n.type === "folder") {
      const u = n.index?.url ?? firstUrl(n.children);
      if (u) return u;
    }
  }
}

/** A folder's own page followed by its children, so a group lists them flat. */
function flatten(node: Node): Node[] {
  if (node.type !== "folder") return [node];
  return [...(node.index ? [node.index] : []), ...node.children];
}

function group(name: string, children: Node[]): Folder {
  return {
    type: "folder",
    $id: `group:${name}`,
    name,
    children,
    defaultOpen: true,
  };
}

/** Turns the `---label---` sections of a folder into collapsible groups. */
function sectionsToFolders(children: Node[]): Node[] {
  const out: Node[] = [];
  let current: Folder | undefined;
  for (const child of children) {
    if (child.type === "separator") {
      current = {
        type: "folder",
        $id: `section:${child.name}`,
        name: child.name ?? "",
        children: [],
      };
      out.push(current);
    } else if (current) {
      current.children.push(child);
    } else {
      out.push(child);
    }
  }
  return out;
}

/** Splits the content tree into two separator-headed sections, "use" and "deploy". */
export function buildSidebarTree(tree: Root, labels: SidebarLabels): Root {
  const top = new Map<string, Node[]>();
  for (const node of tree.children) {
    const key = slugOf(node);
    top.set(key, [...(top.get(key) ?? []), node]);
  }
  // The loader also transforms the fallback tree of unlisted pages; leave it be.
  if (!top.has("getting-started")) return tree;
  const pick = (slugs: string[]) => slugs.flatMap((s) => top.get(s) ?? []);

  // `run-server` holds the trial server page and the self-hosting folder.
  const runServer = (top.get("run-server") ?? []).flatMap(flatten);
  const trialServer = runServer.filter((n) => n.type === "page");
  const selfHosting = runServer.find((n): n is Folder => n.type === "folder");
  const observability = pick(["observability"]).find((n) => n.type === "page");

  const use: Node[] = [
    ...pick(HOME),
    group(labels.start, [
      ...pick(["getting-started"]).flatMap(flatten),
      ...trialServer,
    ]),
    group(labels.features, pick(FEATURES)),
    ...pick(UI),
    group(labels.reference, pick(REFERENCE).flatMap(flatten)),
  ];

  const sections = sectionsToFolders(selfHosting?.children ?? []);
  // Observability is documented under "use"; the deploy section only links to it.
  // The fourth section is "operations"; the meta's leading `index` is a plain
  // child here, so it is not counted.
  const metrics = sections.filter((n) => n.type === "folder")[3];
  if (metrics?.type === "folder" && observability?.type === "page") {
    metrics.children.push({
      type: "page",
      name: labels.observabilityLink,
      url: observability.url,
    });
  }
  const deploy: Node[] = [
    ...(selfHosting?.index ? [selfHosting.index] : []),
    ...sections,
  ];

  // The contributing guide is reached from the header link only; the layout
  // drops it from the sidebar, but it stays here so the llms index lists it.
  return {
    ...tree,
    children: [
      { type: "separator", $id: SECTION_USE, name: labels.use },
      ...use,
      { type: "separator", $id: SECTION_DEPLOY, name: labels.deploy },
      ...deploy,
      ...pick(["contributing"]),
    ],
  };
}
