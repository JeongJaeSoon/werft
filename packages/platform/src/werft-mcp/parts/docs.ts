import { z } from "zod";
import {
  type WerftMcpPart,
  type WerftMcpPartContext,
  type WerftMcpResource,
  werftTool,
} from "../part.ts";
import { WERFT_VERSION_UNKNOWN } from "../version.ts";
import {
  DOCS_LANGUAGES,
  DOCS_SOURCE_LANGUAGE,
  type DocsFile,
  type DocsIndex,
  type DocsLanguage,
  type DocsPage,
  docsIndex,
  docsPages,
  excerptOf,
  pageText,
  pageUrl,
  sourceUrl,
} from "./docs-index.ts";

export const SEARCH_DOCS_TOOL = "search_docs";
/** The most results one search returns. */
export const SEARCH_RESULTS_MAX = 10;
/** The most of a page one resource read returns, in characters. */
export const PAGE_CHARS = 40_000;

const RESOURCE_ROOT = "werft://docs";
// The home page has no path of its own on the site.
const HOME = "index";

function tocUri(language: DocsLanguage): string {
  return `${RESOURCE_ROOT}/${language}`;
}

export function pageUri(page: DocsPage): string {
  return `${RESOURCE_ROOT}/${page.language}/${page.slug === "" ? HOME : page.slug}`;
}

const searchInput = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Keywords to look for, in any of the three languages"),
  language: z
    .enum(DOCS_LANGUAGES)
    .optional()
    .describe(
      "The language you answer in: ko, en or ja. Without it the Korean original is searched",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_RESULTS_MAX)
    .optional()
    .describe(`How many results, 1 to ${SEARCH_RESULTS_MAX}; 5 if not given`),
});

/**
 * The installed documentation: finding a page by keyword, and the pages
 * themselves as resources. `files` are the MDX pages of apps/docs that this
 * image was built with, so what it answers is the installed version's.
 */
export function docsPart(
  context: WerftMcpPartContext,
  files: readonly DocsFile[],
): WerftMcpPart {
  const version =
    context.version === WERFT_VERSION_UNKNOWN ? null : context.version;
  // Each language's index is built on its first use.
  const indexes = new Map<DocsLanguage, DocsIndex>();
  const indexOf = (language: DocsLanguage): DocsIndex => {
    let index = indexes.get(language);
    if (index === undefined) {
      index = docsIndex(docsPages(files, language));
      indexes.set(language, index);
    }
    return index;
  };
  const toc = (language: DocsLanguage): string =>
    [
      `# Werft documentation (${language}), version ${context.version}`,
      ...indexOf(language).pages.map(
        (page) =>
          `- [${page.title}](${pageUri(page)})${page.description === "" ? "" : `: ${page.description}`}`,
      ),
    ].join("\n");

  return {
    tools: [searchTool()],
    resources: {
      async list() {
        return DOCS_LANGUAGES.flatMap((language): WerftMcpResource[] => [
          {
            uri: tocUri(language),
            name: `docs-${language}`,
            title: `Werft documentation: contents (${language})`,
            description:
              "Every page of the installed Werft documentation in this language, with its resource URI",
            mimeType: "text/markdown",
          },
          ...indexOf(language).pages.map((page) => ({
            uri: pageUri(page),
            name: `docs-${language}-${page.slug === "" ? HOME : page.slug.replaceAll("/", "-")}`,
            title: page.title,
            ...(page.description === ""
              ? {}
              : { description: page.description }),
            mimeType: "text/markdown",
          })),
        ]);
      },
      templates: [
        {
          uriTemplate: `${RESOURCE_ROOT}/{language}/{+path}`,
          name: "docs-page",
          title: "Werft documentation page",
          description:
            "A page of the installed Werft documentation; language is ko, en or ja, path as in the contents",
          mimeType: "text/markdown",
        },
      ],
      async read(uri) {
        if (!uri.startsWith(`${RESOURCE_ROOT}/`)) return null;
        const [language, ...rest] = uri
          .slice(RESOURCE_ROOT.length + 1)
          .split("/");
        if (!(DOCS_LANGUAGES as readonly string[]).includes(language ?? "")) {
          return null;
        }
        const lang = language as DocsLanguage;
        if (rest.length === 0) {
          return [{ uri, mimeType: "text/markdown", text: toc(lang) }];
        }
        const slug = rest.join("/") === HOME ? "" : rest.join("/");
        const page = indexOf(lang).pages.find((p) => p.slug === slug);
        if (page === undefined) return null;
        return [{ uri, mimeType: "text/markdown", text: pageResource(page) }];
      },
    },
  };

  function pageResource(page: DocsPage): string {
    const source = sourceUrl(page, version);
    const head = [
      `Werft ${context.version}. Public page: ${pageUrl(page)}`,
      ...(source === null ? [] : [`Source at this version: ${source}`]),
      ...(page.translated
        ? []
        : [
            `Not translated into ${page.language} yet: this is the Korean original.`,
          ]),
    ].join("\n");
    const text = pageText(page);
    const body =
      text.length <= PAGE_CHARS
        ? text
        : `${text.slice(0, PAGE_CHARS)}\n\n[The page goes on past ${PAGE_CHARS} characters. Search for the later sections with ${SEARCH_DOCS_TOOL}, or open the public page.]`;
    return `${head}\n\n${body}`;
  }

  function searchTool() {
    return werftTool({
      name: SEARCH_DOCS_TOOL,
      description: [
        "Search the documentation of the Werft version installed here, by keyword: how to set up and use Werft (GitHub and Slack connection, agents, sessions, approvals, API keys, members, self-hosting).",
        "Returns, for each matching section: the page title, the section heading, a short excerpt, the public docs URL, the page's source at this version, and the page's resource URI to read the whole page.",
        "Pass the language you answer in; results are in it, and a page not translated yet comes in the Korean original.",
        'Example questions: "How do I connect GitHub to Werft?", "Slack 연결은 어디서 해?", "API キーの発行方法は?".',
      ].join(" "),
      input: searchInput,
      async call({ query, language, limit }) {
        const lang = language ?? DOCS_SOURCE_LANGUAGE;
        const hits = indexOf(lang).search(query, limit ?? 5);
        const results = hits.map(({ chunk }) => {
          const source = sourceUrl(chunk.page, version);
          return {
            title: chunk.page.title,
            section: chunk.section.heading,
            excerpt: excerptOf(
              chunk.text === "" ? chunk.page.description : chunk.text,
              query,
            ),
            url: pageUrl(chunk.page, chunk.section.anchor),
            ...(source === null ? {} : { source_url: source }),
            resource: pageUri(chunk.page),
            translated: chunk.page.translated,
          };
        });
        const text =
          results.length === 0
            ? `No page of the Werft ${context.version} documentation (${lang}) matches "${query}". Try other keywords, or read the contents at ${tocUri(lang)}.`
            : [
                `Werft ${context.version} documentation (${lang}), ${results.length} result(s) for "${query}":`,
                ...results.map(
                  (result, i) =>
                    `${i + 1}. ${result.title}${result.section === null ? "" : ` > ${result.section}`}\n   ${result.url}\n   ${result.excerpt}`,
                ),
              ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            version: context.version,
            language: lang,
            results,
          },
        };
      },
    });
  }
}
