export const appName = "Werft";

// Set by next.config.mjs. Next prefixes it on its own links, but not on plain
// fetches or on hrefs to the sibling site (/api) it does not build.
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const searchIndexRoute = "/search-index.json";
const markdownRoute = "/llms.mdx";

export function withBasePath(path: string): string {
  return `${basePath}${path}`;
}

/**
 * `/llms.mdx/<lang>/<slugs>/content.md`: the Markdown copy of one page.
 * Without the base path: Fumadocs' copy button adds it.
 */
export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [page.locale ?? "", ...page.slugs, "content.md"];
  return {
    segments,
    url: `${markdownRoute}/${segments.join("/")}`,
  };
}
