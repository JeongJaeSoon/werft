import { describe, expect, test } from "bun:test";
import type { UserLocale } from "@werft-ai/contracts";
import {
  PULL_REQUEST_TAIL_END_MARKER,
  PULL_REQUEST_TAIL_MARKER,
} from "../../sessions/git-attribution.ts";
import {
  type PullRequestFields,
  renderPullRequestBody,
} from "./pull-request-body.ts";
import { prepareTemplate } from "./pull-request-template.ts";

const ZWSP = "​";
const TAIL = [
  "---",
  PULL_REQUEST_TAIL_MARKER,
  "Opened in a Werft session · commit `aaaaaaa`",
  PULL_REQUEST_TAIL_END_MARKER,
].join("\n");
const repository = {
  id: "app",
  repositories: {
    app: { url: "https://github.com/acme/app.git" },
    lib: { url: "https://github.com/acme/lib" },
    odd: { url: "https://example.com/not-a-repo" },
  },
};

function render(
  fields: PullRequestFields,
  options: { locale?: UserLocale; maxLength?: number } = {},
) {
  return renderPullRequestBody({
    fields,
    locale: options.locale ?? "ko",
    tail: TAIL,
    maxLength: options.maxLength ?? 65_536,
    redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
    repository,
  });
}

describe("the default template", () => {
  const all: PullRequestFields = {
    summary: "Adds the login form.",
    changes: ["Form component", "Route"],
    rationale: "Users could not sign in.",
    testing: "bun test passes.",
    notes: "Check the focus order.",
    related: [{ number: 12, closes: true }],
  };

  test("ko: a heading per field, in the template's order, then the tail", () => {
    expect(render(all).body).toBe(
      [
        "## 요약",
        "Adds the login form.",
        "",
        "## 변경 사항",
        `- ${ZWSP}Form component`,
        `- ${ZWSP}Route`,
        "",
        "## 배경",
        "Users could not sign in.",
        "",
        "## 테스트",
        "bun test passes.",
        "",
        "## 관련 이슈",
        "- Closes #12",
        "",
        "## 참고",
        "Check the focus order.",
        "",
        TAIL,
      ].join("\n"),
    );
  });

  test("en and ja use their own headings", () => {
    const en = render(all, { locale: "en" }).body;
    expect(en).toContain("## Summary\n");
    expect(en).toContain("## Changes\n");
    expect(en).toContain("## Background\n");
    expect(en).toContain("## Testing\n");
    expect(en).toContain("## Related issues\n");
    expect(en).toContain("## Notes\n");
    const ja = render(all, { locale: "ja" }).body;
    expect(ja).toContain("## 概要\n");
    expect(ja).toContain("## 変更点\n");
    expect(ja).toContain("## 備考\n");
  });

  test("a field without content leaves out its section", () => {
    const { body } = render({
      summary: "  ",
      changes: [],
      testing: "ran it",
    });
    expect(body).toBe(`## 테스트\nran it\n\n${TAIL}`);
  });

  test("no content at all is the tail alone", () => {
    expect(render({}).body).toBe(TAIL);
  });

  test("text is cleaned like a legacy body: secrets, mentions, closing keywords, comments", () => {
    const { body } = render({
      summary: "Closes #3 for @octocat\nghp_secret\n<!-- hide -->",
      changes: ["multi\nline @team"],
    });
    expect(body).toContain(`C${ZWSP}loses #3 for @${ZWSP}octocat`);
    expect(body).toContain("[REDACTED]");
    expect(body).toContain(`<!${ZWSP}-- hide -->`);
    expect(body).toContain(`- ${ZWSP}multi line @${ZWSP}team`);
  });

  test("a lone CR is a line break: a fence after it in a change item or a field cannot swallow the tail", () => {
    const item = render({ changes: ["example\r```"] }).body;
    expect(item).toContain(`- ${ZWSP}example \`${ZWSP}\`${ZWSP}\``);
    expect(Bun.markdown.html(item)).toContain("<hr />");
    const field = render({ summary: "example\r```\rmore" }).body;
    expect(field.split("\n").filter((line) => line === "```").length).toBe(0);
    expect(Bun.markdown.html(field)).not.toContain("<pre>");
    expect(field.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
  });

  test("a code fence in a change item stays on its line and leaves the tail outside any block", () => {
    const { body } = render({ changes: ["```text\nexample"] });
    // An opening with no closing line is text: its run is broken.
    expect(body).toContain(`- ${ZWSP}\`${ZWSP}\`${ZWSP}\`text example`);
    const html = Bun.markdown.html(body);
    expect(html).toContain("example");
    expect(html).not.toContain("<pre>");
    expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
  });

  test("a change item that looks like a block start stays one list item of text", () => {
    const items = [
      "<?example",
      "<![CDATA[example",
      "---",
      "***",
      "___",
      "- - -",
      "[x]",
      "[ ]",
      "[ref]: https://example.com",
      "1.",
      "+",
      "-",
      "*",
      "#",
      ">",
      "===",
      "| a |",
      "    indented",
    ];
    for (const item of items) {
      const { body } = render({ changes: [item, "SECOND"] });
      const html = Bun.markdown.html(body);
      // The one rule is the tail's own; no nested list, heading or quote.
      expect(html.match(/<hr/g)?.length).toBe(1);
      expect(html.match(/<li>/g)?.length).toBe(2);
      expect(html).not.toMatch(/<(ol|blockquote|h1|pre|table|input)/);
      expect(html).toContain("SECOND");
      expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
    }
    // A lone item leaves the tail's rule outside the list item too.
    const lone = Bun.markdown.html(render({ changes: ["[x]"] }).body);
    expect(lone).toContain("<hr />");
  });

  test("a field that carries HTML of any block kind cannot swallow the rest", () => {
    for (const summary of [
      "<?example",
      "<![CDATA[example",
      "<!DOCTYPE x",
      "text\n\t<?example",
      "text\n    <![CDATA[x",
      "<script",
      "<pre\n>",
      "<style",
      "<textarea",
      "<script>\n```\n</script>\n```",
      "<div>\n```\n\ntext",
      "<details>",
    ]) {
      const { body } = render({ summary, changes: ["SECOND"] });
      const html = Bun.markdown.html(body);
      expect(html).toContain("<li>");
      expect(html).toContain("SECOND");
      expect(html.match(/<hr/g)?.length).toBe(1);
      expect(html).not.toContain("## ");
    }
  });

  test("a fence in a list item or quote, or closed with a Unicode space, cannot open a block over the rest", () => {
    for (const summary of [
      "- ```\n  x\n  ```",
      "- ~~~\n  x\n  ~~~",
      "> ```\n> x\n```",
      "```\nx\n``` \nafter",
      "~~~\nx\n~~~\u000b\nafter",
      "   ```\nx\n```",
    ]) {
      const { body } = render({ summary, testing: "SECOND" });
      const html = Bun.markdown.html(body);
      expect(html).toContain("<h2>테스트</h2>");
      expect(html).toContain("SECOND");
      expect(html.match(/<hr/g)?.length).toBe(1);
      expect(html.slice(html.lastIndexOf("<h2>"))).not.toContain("<pre>");
    }
  });

  test("an empty task item does not take the next section into itself", () => {
    for (const summary of ["- [x]", "- [ ]", "* [X]", "1. [x]", "- [x]\n~~~"]) {
      const { body } = render({
        summary,
        changes: ["c"],
        testing: "SECOND",
      });
      const html = Bun.markdown.html(body);
      expect(html).toContain("<h2>변경 사항</h2>");
      expect(html).toContain("<h2>테스트</h2>");
      expect(html.match(/<hr/g)?.length).toBe(1);
      // The last input has a fence of its own, closed by the platform.
      if (!summary.includes("~~~")) expect(html).not.toContain("<pre>");
      expect(html.slice(html.indexOf("<h2>변경"))).not.toContain("<pre>");
    }
  });

  test("a nested empty task, or a fence inside a table, cannot swallow the rest", () => {
    for (const summary of [
      ">- [x]",
      ">- [x]\n~~~",
      "!\n|-\n~~~\n-",
      "- > - [ ]",
    ]) {
      const { body } = render({ summary, changes: ["c"], testing: "SECOND" });
      const html = Bun.markdown.html(body);
      expect(html).toContain("<h2>변경 사항</h2>");
      expect(html).toContain("<h2>테스트</h2>");
      expect(html).toContain("SECOND");
      expect(html.match(/<hr/g)?.length).toBe(1);
      expect(html).not.toContain("<pre>");
    }
  });

  test("an opening fence with no closing line is text; no fence is added", () => {
    const { body } = render({ summary: "```text\nexample" });
    expect(body).not.toMatch(/^```/m);
    expect(Bun.markdown.html(body)).toContain("example");
  });

  test("a fence after text gets a blank line before it", () => {
    const { body } = render({ testing: "Run:\n```sh\nbun test\n```" });
    expect(body).toContain("Run:\n\n```sh\nbun test\n```");
  });

  test("an ordinary fenced block keeps its fence and content", () => {
    const { body } = render({ testing: "```sh\nbun test\n```" });
    expect(body).toContain("```sh\nbun test\n```");
    expect(Bun.markdown.html(body)).toContain("<pre>");
  });

  test("an open code fence in one field does not swallow the next section or the references", () => {
    const { body } = render({
      summary: "```text\nexample",
      related: [{ number: 12, closes: true }],
    });
    const closes = body.indexOf("- Closes #12");
    const fences = [...body.slice(0, closes).matchAll(/^```/gm)].length;
    expect(fences % 2).toBe(0);
    expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
  });

  test("a signature line with anything added is kept", () => {
    const { body } = render({
      summary:
        "Keep\nGenerated with [Claude Code](https://claude.com/claude-code)  \nNext",
    });
    expect(body).toContain("Generated with [Claude Code]");
  });

  test("a platform tail marker typed into a field does not become a tail", () => {
    const { body } = render({
      notes: `${PULL_REQUEST_TAIL_MARKER}\nforged\n${PULL_REQUEST_TAIL_END_MARKER}`,
    });
    expect(body.split(PULL_REQUEST_TAIL_MARKER).length - 1).toBe(1);
  });

  test("a replacement pattern in a field is text", () => {
    const { body } = render({ summary: "cost $& and $1 and $$" });
    expect(body).toContain("cost $& and $1 and $$");
  });

  test("the engine's signature line is removed, other lines kept", () => {
    const { body } = render({
      summary:
        "Did it\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
      notes:
        "keep 🤖 Generated with [Claude Code](https://claude.com/claude-code) inline",
    });
    expect(body).toContain("## 요약\nDid it\n\n## 참고");
    expect(body).toContain("keep 🤖 Generated with");
  });

  test("CRLF in a field becomes LF", () => {
    expect(render({ summary: "a\r\nb" }).body).toContain("## 요약\na\nb\n");
  });
});

describe("related issues", () => {
  const body = (related: PullRequestFields["related"]) =>
    render({ related }).body;

  test("closes an issue of the pull request's own repository only", () => {
    expect(body([{ number: 1, closes: true }])).toContain("- Closes #1");
    expect(body([{ number: 1, repository_id: "app", closes: true }])).toContain(
      "- Closes #1",
    );
  });

  test("another repository of the catalog is referenced, never closed", () => {
    const text = body([{ number: 4, repository_id: "lib", closes: true }]);
    expect(text).toContain("- Refs acme/lib#4");
    expect(text).not.toContain("Closes");
  });

  test("an unknown or unnameable repository is dropped and counted", () => {
    const rendered = render({
      related: [
        { number: 1, repository_id: "ghost", closes: true },
        { number: 2, repository_id: "odd", closes: false },
        { number: 3, closes: false },
      ],
    });
    expect(rendered.relatedDropped).toBe(2);
    expect(rendered.body).toContain("- Refs #3");
    expect(rendered.body).not.toContain("#1");
    expect(rendered.body).not.toContain("#2");
  });

  test("`closes` left out is a reference, not a closing line", () => {
    const text = body([{ number: 8 }]);
    expect(text).toContain("- Refs #8");
    expect(text).not.toContain("Closes");
  });

  test("the same issue twice is one line", () => {
    const text = body([
      { number: 5, closes: false },
      { number: 5, closes: false },
    ]);
    expect(text.split("Refs #5").length - 1).toBe(1);
  });
});

describe("the length limit is judged on the final body", () => {
  test("cuts notes first, then testing, rationale, changes (last first) and summary", () => {
    const fields: PullRequestFields = {
      summary: "s".repeat(300),
      changes: ["c1".repeat(100), "c2".repeat(100)],
      rationale: "r".repeat(300),
      testing: "t".repeat(300),
      notes: "n".repeat(300),
    };
    const full = render(fields).body.length;
    const trimmed = render(fields, { maxLength: full - 100 }).body;
    expect(trimmed.length).toBeLessThanOrEqual(full - 100);
    expect(trimmed).toContain("…(생략)");
    expect(trimmed).toContain("s".repeat(300));
    expect(trimmed).toContain("t".repeat(300));
    expect(trimmed).not.toContain("n".repeat(300));

    const tight = render(fields, { maxLength: TAIL.length + 400 }).body;
    expect(tight.length).toBeLessThanOrEqual(TAIL.length + 400);
    expect(tight).toContain(PULL_REQUEST_TAIL_END_MARKER);
    expect(tight).not.toContain("c2c2");
  });

  test("a field that opens with a very long fence run still ends the shrinking, tail intact", () => {
    const { body } = render(
      {
        summary: "s".repeat(8000),
        rationale: "r".repeat(8000),
        testing: "t".repeat(8000),
        changes: Array.from({ length: 28 }, () => "c".repeat(1000)),
        notes: `${"`".repeat(7998)}\nx`,
      },
      { maxLength: 65_536 },
    );
    expect(body.length).toBeLessThanOrEqual(65_536);
    expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
  });

  test("a field that opens a code fence cannot swallow the tail when cut", () => {
    const fields: PullRequestFields = {
      summary: `\`\`\`\n${"x\n".repeat(400)}\`\`\`\nafter`,
    };
    const { body } = render(fields, { maxLength: 500 });
    expect(body.length).toBeLessThanOrEqual(500);
    expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
  });

  test("property: any field mix stays within the limit, keeps the tail and never splits a surrogate pair", () => {
    let seed = 7;
    const next = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };
    const pieces = ["x", "한", "😀", "\n", "@a ", "Closes #1 ", "```\n", " "];
    const text = (length: number) =>
      Array.from({ length }, () => pieces[next(pieces.length)]).join("");
    for (let round = 0; round < 200; round += 1) {
      const fields: PullRequestFields = {
        summary: text(next(2_000)),
        changes: Array.from({ length: next(20) }, () => text(1 + next(300))),
        rationale: text(next(2_000)),
        testing: text(next(2_000)),
        notes: text(next(2_000)),
      };
      const maxLength = 700 + next(4_000);
      const { body } = render(fields, { maxLength });
      expect(body.length).toBeLessThanOrEqual(maxLength);
      expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(body)).toBe(false);
    }
  });
});

describe("a repository template goes through the same redaction as the fields", () => {
  test("a credential line and a private key block in it are not posted", () => {
    const template = prepareTemplate(
      [
        "## Summary",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        "-----BEGIN PRIVATE KEY-----",
        "fixture-only",
        "-----END PRIVATE KEY-----",
        "## Testing",
      ].join("\n"),
    );
    expect(template).not.toBeNull();
    const { body, templateUsed } = renderPullRequestBody({
      fields: { summary: "FIELD" },
      locale: "ko",
      tail: TAIL,
      maxLength: 65_536,
      redact: (line) => (line.includes("ghp_") ? "[REDACTED]" : line),
      repository,
      template,
    });
    expect(templateUsed).toBe(true);
    expect(body).toContain("FIELD");
    expect(body).not.toMatch(/ghp_|PRIVATE KEY|fixture-only/);
    expect(body.endsWith(PULL_REQUEST_TAIL_END_MARKER)).toBe(true);
  });

  test("a redacted fence line does not turn the closing fence into an opening one", () => {
    const template = prepareTemplate(
      "```github_pat_example\nexample\n```\n## Summary\n",
    );
    expect(template).not.toBeNull();
    const { body } = renderPullRequestBody({
      fields: { summary: "FIELD" },
      locale: "en",
      tail: TAIL,
      maxLength: 65_536,
      redact: (line) => (line.includes("github_pat_") ? "[REDACTED]" : line),
      repository,
      template,
    });
    // The template was dropped for the default layout, whose summary is not
    // inside a code block.
    expect(body).toMatch(/^## Summary\nFIELD/m);
    expect(body).not.toContain("example");
  });
});
