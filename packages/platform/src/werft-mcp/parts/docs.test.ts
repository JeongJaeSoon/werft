import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWerftMcpServer } from "../server.ts";
import { docsPart, PAGE_CHARS, SEARCH_DOCS_TOOL } from "./docs.ts";
import {
  CHUNK_CHARS,
  chunksOf,
  type DocsFile,
  docsIndex,
  docsPages,
  EXCERPT_CHARS,
  termsOf,
} from "./docs-index.ts";

const page = (title: string, body: string, description = "") =>
  `---\ntitle: "${title}"\ndescription: ${description}\n---\n\n${body}\n`;

const FILES: DocsFile[] = [
  {
    path: "index.mdx",
    text: page(
      "Werft 문서",
      '<Cards>\n  <Card title="시작" href="/getting-started" />\n</Cards>',
    ),
  },
  {
    path: "integrations/github.mdx",
    text: page(
      "GitHub",
      'import { X } from "y";\n\n## 운영자가 할 일\n\n콘솔의 **설정 > 연동 > GitHub**에서 App을 연결한다. [슬랙](/integrations/slack#연결)도 본다.\n\n<Callout type="info">\n저장소를 고르면 생긴다.\n</Callout>\n\n## 이전 주소 [#old-urls]\n\n```bash\n## not a heading\nexport A=1\n```',
      "GitHub 저장소에서 세션을 돌린다",
    ),
  },
  {
    path: "integrations/github.en.mdx",
    text: page(
      "GitHub",
      "## What the operator does\n\nConnect the App under **Settings > Integrations > GitHub** in the console.",
    ),
  },
  {
    path: "integrations/slack.mdx",
    text: page("Slack", "## 연결\n\nSlack 워크스페이스를 연결한다."),
  },
  { path: "run-server/index.mdx", text: page("서버 실행", "서버를 띄운다.") },
];

const ask = async (
  files: readonly DocsFile[],
  method: string,
  params: Record<string, unknown> = {},
  version = "v1.2.3",
) => {
  const handle = createWerftMcpServer({
    parts: [docsPart({ version }, files)],
    version,
  });
  return (await handle(
    { sessionId: "s", attemptId: "a" },
    { jsonrpc: "2.0", id: 1, method, params },
    "r",
  )) as { result?: Record<string, unknown>; error?: { code: number } };
};
const search = async (args: Record<string, unknown>, version?: string) =>
  (
    await ask(
      FILES,
      "tools/call",
      { name: SEARCH_DOCS_TOOL, arguments: args },
      version,
    )
  ).result as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent: {
      version: string;
      language: string;
      results: Record<string, unknown>[];
    };
  };

describe("the pages of a language", () => {
  test("a translation where one exists, else the Korean original, at the path the site has", () => {
    const en = docsPages(FILES, "en");
    expect(en.map((p) => [p.slug, p.file, p.translated])).toEqual([
      ["", "index.mdx", false],
      ["integrations/github", "integrations/github.en.mdx", true],
      ["integrations/slack", "integrations/slack.mdx", false],
      ["run-server", "run-server/index.mdx", false],
    ]);
    expect(docsPages(FILES, "ko").every((p) => p.translated)).toBe(true);
    expect(docsPages(FILES, "ko").map((p) => p.file)).not.toContain(
      "integrations/github.en.mdx",
    );
  });

  test("MDX is read as text: frontmatter, sections and anchors, no imports or tags, code kept whole", () => {
    const [github] = docsPages(FILES, "ko").filter(
      (p) => p.slug === "integrations/github",
    );
    expect(github?.title).toBe("GitHub");
    expect(github?.description).toBe("GitHub 저장소에서 세션을 돌린다");
    expect(github?.sections.map((s) => [s.heading, s.anchor])).toEqual([
      ["운영자가 할 일", "운영자가-할-일"],
      ["이전 주소", "old-urls"],
    ]);
    const [operator, old] = github?.sections ?? [];
    expect(operator?.text).not.toContain("import");
    expect(operator?.text).not.toContain("<Callout");
    expect(operator?.text).toContain("저장소를 고르면 생긴다.");
    // A docs link points at the public page in the same language.
    expect(operator?.text).toContain(
      "[슬랙](https://jeongjaesoon.github.io/werft/ko/integrations/slack/#연결)",
    );
    expect(old?.text).toContain("## not a heading\nexport A=1");
    const [home] = docsPages(FILES, "ko");
    expect(home?.sections[0]?.text).toBe("시작");
  });

  test("a chunk is at most CHUNK_CHARS, cut at paragraph ends", () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `문단 ${i} ${"가".repeat(90)}`,
    ).join("\n\n");
    const huge = "나".repeat(CHUNK_CHARS * 3);
    const [p] = docsPages(
      [{ path: "a.mdx", text: page("A", `## 긴 절\n\n${long}\n\n${huge}`) }],
      "ko",
    );
    const chunks = chunksOf(p as never);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks)
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(chunks.map((c) => c.text).join("")).toContain("문단 39");
  });
});

describe("the keyword index", () => {
  test("Korean and Japanese by character pairs, so a word with a particle finds its stem; others by word", () => {
    expect(termsOf("저장소를 연결")).toEqual(["저장", "장소", "소를", "연결"]);
    expect(termsOf("API キー")).toEqual(["キー", "api"]);
    const index = docsIndex(docsPages(FILES, "ko"));
    expect(index.search("저장소", 3)[0]?.chunk.page.slug).toBe(
      "integrations/github",
    );
    expect(index.search("슬랙 워크스페이스 연결", 3)[0]?.chunk.page.slug).toBe(
      "integrations/slack",
    );
    expect(index.search("!!!", 3)).toEqual([]);
  });

  test("a title or heading weighs more than the body", () => {
    const files = [
      {
        path: "a.mdx",
        text: page("Approvals", "approvals approvals in passing"),
      },
      { path: "b.mdx", text: page("Other", "## Sessions\n\nsessions") },
      {
        path: "c.mdx",
        text: page(
          "More",
          "sessions are mentioned here once, among many other words of a body",
        ),
      },
    ];
    expect(
      docsIndex(docsPages(files, "ko"))
        .search("sessions", 2)
        .map((h) => h.chunk.page.slug),
    ).toEqual(["b", "c"]);
  });
});

describe(SEARCH_DOCS_TOOL, () => {
  test("results: title, section, excerpt, public URL at the section, source at this version, resource", async () => {
    const { structuredContent, content } = await search({
      query: "GitHub App 연결",
    });
    expect(structuredContent.language).toBe("ko");
    expect(structuredContent.version).toBe("v1.2.3");
    expect(structuredContent.results[0]).toEqual({
      title: "GitHub",
      section: "운영자가 할 일",
      excerpt: expect.stringContaining("App을 연결한다"),
      url: `https://jeongjaesoon.github.io/werft/ko/integrations/github/#${encodeURIComponent("운영자가-할-일")}`,
      source_url:
        "https://github.com/JeongJaeSoon/werft/blob/v1.2.3/apps/docs/content/docs/integrations/github.mdx",
      resource: "werft://docs/ko/integrations/github",
      translated: true,
    });
    expect(content[0]?.text).toContain("GitHub > 운영자가 할 일");
  });

  test("the language asked for, else Korean; a page not translated yet comes in the Korean original", async () => {
    const en = await search({ query: "GitHub console", language: "en" });
    expect(en.structuredContent.language).toBe("en");
    expect(en.structuredContent.results[0]).toMatchObject({
      section: "What the operator does",
      url: expect.stringContaining("/werft/en/integrations/github/"),
      translated: true,
    });
    const slack = await search({ query: "Slack", language: "en" });
    expect(slack.structuredContent.results[0]).toMatchObject({
      title: "Slack",
      url: expect.stringContaining("/werft/en/integrations/slack/"),
      source_url: expect.stringContaining("/integrations/slack.mdx"),
      translated: false,
    });
    const none = await search({ query: "console" });
    expect(none.structuredContent.language).toBe("ko");
  });

  test("a build that wrote no version links no source", async () => {
    const { structuredContent } = await search(
      { query: "GitHub" },
      "0.0.0-unknown",
    );
    expect(structuredContent.results[0]).not.toHaveProperty("source_url");
  });

  test("bounded: at most the limit asked, at most ten, an excerpt of at most EXCERPT_CHARS", async () => {
    expect(
      (await search({ query: "연결", limit: 1 })).structuredContent.results,
    ).toHaveLength(1);
    expect((await search({ query: "연결", limit: 11 })).isError).toBe(true);
    expect((await search({ query: "" })).isError).toBe(true);
    expect((await search({ query: "x", language: "de" })).isError).toBe(true);
    const files = [
      {
        path: "a.mdx",
        text: page(
          "A",
          `## S\n\n${"word ".repeat(400)} needle ${"word ".repeat(400)}`,
        ),
      },
    ];
    const handle = createWerftMcpServer({
      parts: [docsPart({ version: "v1" }, files)],
      version: "v1",
    });
    const answered = (await handle(
      { sessionId: "s", attemptId: "a" },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: SEARCH_DOCS_TOOL, arguments: { query: "needle" } },
      },
      "r",
    )) as { result: { structuredContent: { results: { excerpt: string }[] } } };
    const excerpt = answered.result.structuredContent.results[0]?.excerpt ?? "";
    expect(excerpt).toContain("needle");
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
  });

  test("no match says where the contents are", async () => {
    const { structuredContent, content } = await search({ query: "zzzz" });
    expect(structuredContent.results).toEqual([]);
    expect(content[0]?.text).toContain("werft://docs/ko");
  });
});

describe("the docs as resources", () => {
  test("a contents page per language and every page, from the same index", async () => {
    const { result } = await ask(FILES, "resources/list");
    const uris = (result?.resources as { uri: string }[]).map((r) => r.uri);
    expect(uris).toContain("werft://docs/ko");
    expect(uris).toContain("werft://docs/ja");
    expect(uris).toContain("werft://docs/en/index");
    expect(uris).toContain("werft://docs/ko/integrations/github");
    expect(uris.filter((u) => u.startsWith("werft://docs/en/"))).toHaveLength(
      4,
    );
    const templates = (await ask(FILES, "resources/templates/list")).result;
    expect(templates).toMatchObject({
      resourceTemplates: [{ uriTemplate: "werft://docs/{language}/{+path}" }],
    });
  });

  test("contents and a page read as Markdown with the version and the public URL", async () => {
    const toc = (await ask(FILES, "resources/read", { uri: "werft://docs/en" }))
      .result as { contents: { text: string }[] };
    expect(toc.contents[0]?.text).toContain("version v1.2.3");
    expect(toc.contents[0]?.text).toContain(
      "[GitHub](werft://docs/en/integrations/github)",
    );
    const read = (
      await ask(FILES, "resources/read", {
        uri: "werft://docs/ja/integrations/slack",
      })
    ).result as { contents: { text: string; mimeType: string }[] };
    expect(read.contents[0]?.mimeType).toBe("text/markdown");
    expect(read.contents[0]?.text).toContain(
      "https://jeongjaesoon.github.io/werft/ja/integrations/slack/",
    );
    expect(read.contents[0]?.text).toContain("Not translated into ja yet");
    expect(read.contents[0]?.text).toContain("## 연결");
    expect(
      (await ask(FILES, "resources/read", { uri: "werft://docs/ko/nope" }))
        .error?.code,
    ).toBe(-32002);
    expect(
      (await ask(FILES, "resources/read", { uri: "werft://docs/de" })).error
        ?.code,
    ).toBe(-32002);
  });

  test("a page longer than PAGE_CHARS is cut, and says so", async () => {
    const files = [
      { path: "big.mdx", text: page("Big", "가 ".repeat(PAGE_CHARS)) },
    ];
    const read = (
      await ask(files, "resources/read", { uri: "werft://docs/ko/big" })
    ).result as { contents: { text: string }[] };
    expect(read.contents[0]?.text.length).toBeLessThan(PAGE_CHARS + 600);
    expect(read.contents[0]?.text).toContain(SEARCH_DOCS_TOOL);
  });
});

describe("the documentation of this checkout", () => {
  const dir = join(import.meta.dir, "../../../../../apps/docs/content/docs");
  const files: DocsFile[] = readdirSync(dir, {
    recursive: true,
    encoding: "utf8",
  })
    .filter((path) => path.endsWith(".mdx"))
    .map((path) => ({ path, text: readFileSync(join(dir, path), "utf8") }));

  test("every language has every page, each with a title", () => {
    const counts = (["ko", "en", "ja"] as const).map((language) => {
      const pages = docsPages(files, language);
      for (const p of pages) expect(p.title).not.toBe("");
      return pages.length;
    });
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBeGreaterThan(50);
  });

  test("the questions this server is for find their page", () => {
    const find = (language: "ko" | "en" | "ja", query: string) =>
      docsIndex(docsPages(files, language))
        .search(query, 5)
        .map((hit) => hit.chunk.page.slug);
    expect(find("ko", "GitHub App 연결")).toContain("integrations/github");
    expect(find("en", "connect Slack workspace")).toContain(
      "integrations/slack",
    );
    expect(find("ja", "API キー 発行")).toContain("api-keys");
  });
});
