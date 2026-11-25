import type { Folder, Node, Root } from "fumadocs-core/page-tree";

// The operation entries of the HTTP API reference, downloaded once by the
// browser. In the tree they were serialised into the HTML and every RSC
// payload of every page, so each operation grew all ~1,400 pages.
export const apiSidebarRoute = "/api-sidebar.json";

/** One operation entry; `url` is without the language prefix. */
export interface SidebarOperation {
  title: string;
  url: string;
  method?: string;
  deprecated?: boolean;
}

/** Operations by tag folder path without its language: `reference/http-api/teams`. */
export type ApiSidebar = Record<string, SidebarOperation[]>;

const tagFolderPrefix = "reference/http-api/";

/** A tag folder's id is `ko:reference/http-api/teams`. */
function tagOf(node: Folder, lang: string): string | undefined {
  const prefix = `${lang}:${tagFolderPrefix}`;
  return node.$id?.startsWith(prefix)
    ? node.$id.slice(lang.length + 1)
    : undefined;
}

/** The tree with each tag folder's children replaced. */
export function mapTagFolders(
  tree: Root,
  lang: string,
  children: (folder: Folder, tag: string) => Node[],
): Root {
  const walk = (nodes: Node[]): Node[] =>
    nodes.map((node) => {
      if (node.type !== "folder") return node;
      const tag = tagOf(node, lang);
      return {
        ...node,
        children: tag ? children(node, tag) : walk(node.children),
      };
    });
  return { ...tree, children: walk(tree.children) };
}
