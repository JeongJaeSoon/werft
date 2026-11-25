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
  type DocsSection,
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
/**
 * The most one answer holds, in UTF-8 bytes. A worker reports a tool result
 * as one event, and the gateway takes at most 64 KiB in one report, so an
 * answer stays far below it, room left for how an engine frames it.
 */
export const ANSWER_BYTES = 20_000;

const CUT = `[Cut here: the rest is longer than one answer holds. Find it with ${SEARCH_DOCS_TOOL}.]`;

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** `text` within `budget` bytes, cut at a paragraph end where one is in reach. */
function cutToBytes(text: string, budget: number): string {
  if (byteLength(text) <= budget) return text;
  let cut = "";
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > budget) break;
    cut += char;
    used += size;
  }
  const paragraph = cut.lastIndexOf("\n\n");
  return paragraph > cut.length / 2 ? cut.slice(0, paragraph) : cut;
}

const RESOURCE_ROOT = "werft://docs";
// The home page has no path of its own on the site.
const HOME = "index";

function tocUri(language: DocsLanguage): string {
  return `${RESOURCE_ROOT}/${language}`;
}

function sectionUri(page: DocsPage, section: DocsSection): string {
  return section.anchor === null
    ? pageUri(page)
    : `${pageUri(page)}#${encodeURIComponent(section.anchor)}`;
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
      "The language you answer in: ko, en or ja. An agent set to answer in one language is searched in that one whatever this says; without either, the Korean original",
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
  /** The response language the session's agent fixes, if it fixes one. */
  languageOf: (sessionId: string) => Promise<DocsLanguage | null> = async () =>
    null,
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
      // The contents of each language; every page and section is read by
      // the URIs they list, not listed here: one entry per page would make
      // the list itself larger than an answer can be.
      async list() {
        return DOCS_LANGUAGES.map(
          (language): WerftMcpResource => ({
            uri: tocUri(language),
            name: `docs-${language}`,
            title: `Werft documentation: contents (${language})`,
            description:
              "Every page of the installed Werft documentation in this language, with the URI to read it",
            mimeType: "text/markdown",
          }),
        );
      },
      templates: [
        {
          uriTemplate: `${RESOURCE_ROOT}/{language}/{+path}`,
          name: "docs-page",
          title: "Werft documentation page",
          description:
            "A page of the installed Werft documentation: language ko, en or ja, path as the contents list it; add #<section> for one section",
          mimeType: "text/markdown",
        },
      ],
      async read(uri) {
        if (!uri.startsWith(`${RESOURCE_ROOT}/`)) return null;
        const [path = "", fragment, ...extra] = uri
          .slice(RESOURCE_ROOT.length + 1)
          .split("#");
        // The URI is echoed back, so only one a page or section has passes.
        if (extra.length > 0) return null;
        const [language, ...rest] = path.split("/");
        if (!(DOCS_LANGUAGES as readonly string[]).includes(language ?? "")) {
          return null;
        }
        const lang = language as DocsLanguage;
        if (rest.length === 0) {
          return fragment === undefined
            ? [{ uri, mimeType: "text/markdown", text: toc(lang) }]
            : null;
        }
        const slug = rest.join("/") === HOME ? "" : rest.join("/");
        const page = indexOf(lang).pages.find((p) => p.slug === slug);
        if (page === undefined) return null;
        if (fragment === undefined) {
          return [{ uri, mimeType: "text/markdown", text: pageResource(page) }];
        }
        let anchor: string;
        try {
          anchor = decodeURIComponent(fragment);
        } catch {
          return null;
        }
        const section = page.sections.find((s) => s.anchor === anchor);
        if (section === undefined) return null;
        return [
          {
            uri,
            mimeType: "text/markdown",
            text: sectionResource(page, section),
          },
        ];
      },
    },
  };

  function headOf(page: DocsPage): string {
    const source = sourceUrl(page, version);
    return [
      `Werft ${context.version}. Public page: ${pageUrl(page)}`,
      ...(source === null ? [] : [`Source at this version: ${source}`]),
      ...(page.translated
        ? []
        : [
            `Not translated into ${page.language} yet: this is the Korean original.`,
          ]),
    ].join("\n");
  }

  // A page that does not fit one answer comes as its sections' URIs and as
  // much of its text as fits; each section then reads on its own.
  function pageResource(page: DocsPage): string {
    const head = headOf(page);
    const text = pageText(page);
    if (byteLength(`${head}\n\n${text}`) <= ANSWER_BYTES) {
      return `${head}\n\n${text}`;
    }
    const note =
      "This page is longer than one answer holds, so it is cut below. Read any section on its own at its URI:";
    const index = cutToBytes(
      page.sections
        .filter((section) => section.anchor !== null)
        .map((section) => `- ${section.heading}: ${sectionUri(page, section)}`)
        .join("\n"),
      ANSWER_BYTES / 2,
    );
    const frame = [head, note, index, "---", "", CUT].join("\n\n");
    return [
      head,
      note,
      index,
      "---",
      cutToBytes(text, ANSWER_BYTES - byteLength(frame)),
      CUT,
    ].join("\n\n");
  }

  function sectionResource(page: DocsPage, section: DocsSection): string {
    const head = `${headOf(page)}\nSection of: ${page.title}`;
    const text = `## ${section.heading}\n\n${section.text}`;
    const whole = `${head}\n\n${text}`;
    if (byteLength(whole) <= ANSWER_BYTES) return whole;
    return `${head}\n\n${cutToBytes(text, ANSWER_BYTES - byteLength(head) - byteLength(CUT) - 4)}\n\n${CUT}`;
  }

  function searchTool() {
    return werftTool({
      name: SEARCH_DOCS_TOOL,
      description: [
        "Search the documentation of the Werft version installed here, by keyword: how to set up and use Werft (GitHub and Slack connection, agents, sessions, approvals, API keys, members, self-hosting).",
        "Returns, for each matching section: the page title, the section heading, a short excerpt, the public docs URL, the page's source at this version, and the page's resource URI to read the whole page.",
        "Results come in this agent's response language; for an agent that answers in the user's language, pass the language you answer in. A page not translated yet comes in the Korean original.",
        'Example questions: "How do I connect GitHub to Werft?", "Slack 연결은 어디서 해?", "API キーの発行方法は?".',
      ].join(" "),
      input: searchInput,
      async call({ query, language, limit }, call) {
        // The agent's own response language first; then the one the model
        // says it answers in (an agent that follows the user's); else Korean.
        const lang =
          (await languageOf(call.sessionId)) ??
          language ??
          DOCS_SOURCE_LANGUAGE;
        const hits = indexOf(lang).search(query, limit ?? 5);
        const found = hits.map(({ chunk }) => {
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
            resource: sectionUri(chunk.page, chunk.section),
            translated: chunk.page.translated,
          };
        });
        const answer = (results: typeof found) => {
          const text =
            found.length === 0
              ? `No page of the Werft ${context.version} documentation (${lang}) matches "${query}". Try other keywords, or read the contents at ${tocUri(lang)}.`
              : [
                  `Werft ${context.version} documentation (${lang}), ${results.length} result(s) for "${query}":`,
                  ...results.map(
                    (result, i) =>
                      `${i + 1}. ${result.title}${result.section === null ? "" : ` > ${result.section}`}\n   ${result.url}\n   ${result.excerpt}`,
                  ),
                  ...(results.length < found.length
                    ? [
                        `${found.length - results.length} more left out to fit one answer; search with other keywords to see them.`,
                      ]
                    : []),
                ].join("\n");
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: {
              version: context.version,
              language: lang,
              results,
            },
          };
        };
        // The text and the structured copy both travel, so both count.
        const sizeOf = (a: ReturnType<typeof answer>) =>
          byteLength(a.content[0]?.text ?? "") +
          byteLength(JSON.stringify(a.structuredContent));
        let kept = found.length;
        while (
          kept > 0 &&
          sizeOf(answer(found.slice(0, kept))) > ANSWER_BYTES
        ) {
          kept -= 1;
        }
        return answer(found.slice(0, kept));
      },
    });
  }
}
