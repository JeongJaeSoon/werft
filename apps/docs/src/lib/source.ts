import { type LoaderPlugin, llms, loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import { i18n, type Locale, messages } from "./i18n";
import { openapi, slugifyTag } from "./openapi";
import { withBasePath } from "./shared";
import { buildSidebarTree, sidebarLabels } from "./sidebar-tree";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
    postprocess: { includeProcessedMarkdown: true },
  },
  meta: { schema: metaSchema },
});

// `external:[..](/api/)` in a meta.json names a sibling site on the same
// Pages origin; it renders as a plain <a>, so the base path is added here. The
// generated reference folder has no meta.json to title it.
const pageTreeFixes: LoaderPlugin = {
  name: "page-tree-fixes",
  transformPageTree: {
    file(node) {
      // The sidebar never shows a description, but the tree is serialised into
      // the HTML and every RSC payload of every page. Operation descriptions run
      // to several paragraphs, so keeping them made the static site ~1.3 GB.
      const { description: _description, ...slim } = node;
      if (slim.external && slim.url.startsWith("/")) {
        return { ...slim, url: withBasePath(slim.url) };
      }
      return slim;
    },
    folder(node, folderPath) {
      return folderPath === "reference/http-api"
        ? { ...node, name: "HTTP API" }
        : node;
    },
    root(tree) {
      const locale = (this.locale ?? i18n.defaultLanguage) as Locale;
      return buildSidebarTree(tree, sidebarLabels[locale]);
    },
  },
};

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({
      baseDir: "reference/http-api",
      groupBy: "tag",
      slugify: slugifyTag,
      meta: true,
    }),
  },
  {
    baseUrl: "/",
    i18n,
    plugins: [openapi.loaderPlugin(), pageTreeFixes],
  },
);

export const docsLlms = llms(source, {
  // Operation items carry a method badge as their name; the title is plain text.
  renderName: (node, { lang }) => {
    if (node.type === "page")
      return source.getNodePage(node, lang)?.data.title ?? String(node.name);
    return node.type === "folder"
      ? String(node.name)
      : messages[(lang ?? i18n.defaultLanguage) as Locale].siteTitle;
  },
  // Operation descriptions run to several paragraphs; an index line keeps the first.
  renderDescription: (node, { lang }) => {
    const description =
      node.type === "page"
        ? source.getNodePage(node, lang)?.data.description
        : undefined;
    return description?.split("\n")[0] ?? "";
  },
  renderPage: async (page) => {
    const heading = `# ${page.data.title} (${withBasePath(page.url)})`;
    if (page.type === "openapi")
      return `${heading}\n\n${page.data.description ?? ""}`;
    return `${heading}\n\n${await page.data.getText("processed")}`;
  },
});

/** A content page in another language whose own translation does not exist yet. */
export function isUntranslated(page: { path: string; locale?: string }) {
  return (
    page.locale !== i18n.defaultLanguage &&
    !page.path.endsWith(`.${page.locale}.mdx`)
  );
}
