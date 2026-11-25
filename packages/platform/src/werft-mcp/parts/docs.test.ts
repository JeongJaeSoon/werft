import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createWerftMcpServer } from "../server.ts";
import { ANSWER_BYTES, docsPart, SEARCH_DOCS_TOOL } from "./docs.ts";
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

  test("a repeated heading's anchor is numbered, as the docs site numbers it", () => {
    const [p] = docsPages(
      [
        {
          path: "a.mdx",
          text: page(
            "A",
            "## 다음 단계\n\n하나\n\n## 다음 단계\n\n둘\n\n## 다음 단계\n\n셋",
          ),
        },
      ],
      "ko",
    );
    expect(p?.sections.map((s) => s.anchor)).toEqual([
      "다음-단계",
      "다음-단계-1",
      "다음-단계-2",
    ]);
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
      resource: `werft://docs/ko/integrations/github#${encodeURIComponent("운영자가-할-일")}`,
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
  test("the list is a contents page per language; pages are read by their URIs", async () => {
    const { result } = await ask(FILES, "resources/list");
    expect((result?.resources as { uri: string }[]).map((r) => r.uri)).toEqual([
      "werft://docs/ko",
      "werft://docs/en",
      "werft://docs/ja",
    ]);
    const templates = (await ask(FILES, "resources/templates/list")).result;
    expect(templates).toMatchObject({
      resourceTemplates: [{ uriTemplate: "werft://docs/{language}/{+path}" }],
    });
  });

  test("contents, a page and a section read as Markdown with the version and the public URL", async () => {
    const toc = (await ask(FILES, "resources/read", { uri: "werft://docs/en" }))
      .result as { contents: { text: string }[] };
    expect(toc.contents[0]?.text).toContain("version v1.2.3");
    expect(toc.contents[0]?.text).toContain(
      "[GitHub](werft://docs/en/integrations/github)",
    );
    expect(toc.contents[0]?.text).toContain(
      "[Werft 문서](werft://docs/en/index)",
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
    const section = (
      await ask(FILES, "resources/read", {
        uri: "werft://docs/ko/integrations/github#old-urls",
      })
    ).result as { contents: { text: string }[] };
    expect(section.contents[0]?.text).toContain("## 이전 주소");
    expect(section.contents[0]?.text).not.toContain("운영자가 할 일");
    for (const uri of [
      "werft://docs/ko/nope",
      "werft://docs/de",
      "werft://docs/ko#x",
      "werft://docs/ko/integrations/github#nope",
      "werft://docs/ko/integrations/github#%E0%A4%A",
    ]) {
      expect((await ask(FILES, "resources/read", { uri })).error?.code).toBe(
        -32002,
      );
    }
  });

  test("a page longer than one answer comes as its sections' URIs and its start; a long section is cut and says so", async () => {
    const sections = Array.from(
      { length: 30 },
      (_, i) => `## 절 ${i}\n\n${"가나다 ".repeat(400)}`,
    ).join("\n\n");
    const files = [
      { path: "big.mdx", text: page("Big", sections) },
      {
        path: "one.mdx",
        text: page("One", `## 긴 절\n\n${"라 ".repeat(ANSWER_BYTES)}`),
      },
    ];
    const text = async (uri: string) =>
      (
        (await ask(files, "resources/read", { uri })).result as {
          contents: { text: string }[];
        }
      ).contents[0]?.text ?? "";
    const big = await text("werft://docs/ko/big");
    expect(new TextEncoder().encode(big).length).toBeLessThanOrEqual(
      ANSWER_BYTES,
    );
    expect(big).toContain(
      `- 절 29: werft://docs/ko/big#${encodeURIComponent("절-29")}`,
    );
    expect(big).toContain("## 절 0");
    expect(big).toContain(SEARCH_DOCS_TOOL);
    const last = await text(
      `werft://docs/ko/big#${encodeURIComponent("절-29")}`,
    );
    expect(last).toContain("## 절 29");
    const long = await text(
      `werft://docs/ko/one#${encodeURIComponent("긴-절")}`,
    );
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(
      ANSWER_BYTES,
    );
    expect(long).toContain(SEARCH_DOCS_TOOL);
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
    // The page named for the subject comes first, over pages that only
    // mention it beside a common word.
    expect(find("ko", "GitHub 연결")[0]).toBe("integrations/github");
    expect(find("en", "connect GitHub")[0]).toBe("integrations/github");
    expect(find("en", "API key")[0]).toBe("api-keys");
    expect(find("ja", "API キーの発行方法は?")[0]).toBe("api-keys");
  });

  test("a query term no page has does not hide the pages that have the rest", () => {
    const index = docsIndex(docsPages(files, "en"));
    expect(index.search("API key qqqzzzunknown", 1)[0]?.chunk.page.slug).toBe(
      "api-keys",
    );
    expect(index.search("qqqzzzunknown", 1)).toEqual([]);
  });

  test("no answer over the real docs is larger than ANSWER_BYTES", async () => {
    const handle = createWerftMcpServer({
      parts: [docsPart({ version: "v0.6.0" }, files)],
      version: "v0.6.0",
    });
    const answer = async (method: string, params: Record<string, unknown>) => {
      const answered = (await handle(
        { sessionId: "s", attemptId: "a" },
        { jsonrpc: "2.0", id: 1, method, params },
        "r",
      )) as { result?: unknown };
      expect(answered.result).toBeDefined();
      return new TextEncoder().encode(JSON.stringify(answered)).length;
    };
    // The JSON-RPC frame around an answer.
    const limit = ANSWER_BYTES + 4_096;
    expect(await answer("resources/list", {})).toBeLessThanOrEqual(limit);
    for (const language of ["ko", "en", "ja"] as const) {
      expect(
        await answer("resources/read", { uri: `werft://docs/${language}` }),
      ).toBeLessThanOrEqual(limit);
      for (const p of docsPages(files, language)) {
        const uri = `werft://docs/${language}/${p.slug === "" ? "index" : p.slug}`;
        expect(await answer("resources/read", { uri })).toBeLessThanOrEqual(
          limit,
        );
        for (const s of p.sections) {
          if (s.anchor === null) continue;
          expect(
            await answer("resources/read", {
              uri: `${uri}#${encodeURIComponent(s.anchor)}`,
            }),
          ).toBeLessThanOrEqual(limit);
        }
      }
      for (const query of [
        "GitHub 接続 設定 エージェント セッション 承認",
        "설정 연결 에이전트 세션 승인 워크스페이스",
        "configuration agent session approval workspace",
      ]) {
        expect(
          await answer("tools/call", {
            name: SEARCH_DOCS_TOOL,
            arguments: { query, language, limit: 10 },
          }),
        ).toBeLessThanOrEqual(limit);
      }
    }
  });
});
