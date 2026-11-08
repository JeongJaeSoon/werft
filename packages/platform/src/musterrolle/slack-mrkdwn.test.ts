import { describe, expect, test } from "bun:test";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.ts";

const ZW = "\u200B";

describe("markdownToSlackMrkdwn", () => {
  test("bold, strikethrough and headings use Slack's single markers", () => {
    expect(markdownToSlackMrkdwn("a **bold** b ~~gone~~ c")).toBe(
      "a *bold* b ~gone~ c",
    );
    expect(markdownToSlackMrkdwn("# Title\n### **Sub** ##\n## C#")).toBe(
      "*Title*\n*Sub*\n*C#*",
    );
  });

  test("a marker touching a letter gets a zero-width space so Slack still formats it", () => {
    expect(markdownToSlackMrkdwn("이 **굵게**는 앞**굵게**")).toBe(
      `이 *굵게*${ZW}는 앞${ZW}*굵게*`,
    );
    expect(markdownToSlackMrkdwn("~~취소~~다")).toBe(`~취소~${ZW}다`);
    expect(markdownToSlackMrkdwn("(**ok**).")).toBe("(*ok*).");
  });

  test("links become Slack links; unsafe destinations stay readable", () => {
    expect(markdownToSlackMrkdwn("[예시 링크](https://example.com)")).toBe(
      "<https://example.com|예시 링크>",
    );
    expect(
      markdownToSlackMrkdwn(
        '[wiki](https://en.wikipedia.org/wiki/A_(b) "t") ![img](https://x.test/i.png)',
      ),
    ).toBe(
      "<https://en.wikipedia.org/wiki/A_(b)|wiki> <https://x.test/i.png|img>",
    );
    expect(markdownToSlackMrkdwn("[https://a.test](https://a.test)")).toBe(
      "<https://a.test>",
    );
    expect(markdownToSlackMrkdwn("[x](javascript:alert(1))")).toBe(
      "x (javascript:alert(1))",
    );
    expect(markdownToSlackMrkdwn("[a|b](https://a.test)")).toBe(
      "a|b (https://a.test)",
    );
  });

  test("lists become bullets, nested by indentation", () => {
    expect(
      markdownToSlackMrkdwn(
        [
          "- one",
          "  - nested",
          "    * deeper",
          "  + back",
          "- two",
          "1. first",
          "   - under first",
          "- [ ] todo",
          "- [x] done",
        ].join("\n"),
      ),
    ).toBe(
      [
        "• one",
        "    ◦ nested",
        "        ▸ deeper",
        "    ◦ back",
        "• two",
        "1. first",
        "    ◦ under first",
        "• ☐ todo",
        "• ☒ done",
      ].join("\n"),
    );
  });

  test("a table becomes one line per row, never a code block", () => {
    expect(
      markdownToSlackMrkdwn(
        [
          "before",
          "| 이름 | **값** |",
          "| :--- | ---: |",
          "| alpha | `1|2` |",
          "| [link](https://a.test) | 한 |",
          "after",
        ].join("\n"),
      ),
    ).toBe(
      [
        "before",
        "*alpha* — 값: `1|2`",
        "*link (https://a.test)* — 값: 한",
        "after",
      ].join("\n"),
    );
  });

  test("code spans and blocks stay as they are; a fence loses only its language", () => {
    const input = [
      "`a**b**c` and `[x](https://a.test)`",
      "```ts",
      'const x = "**not bold**"; // - [y](z)',
      "# not a heading",
      "```",
      "- **브랜치:** `e2e-branch`",
    ].join("\n");
    expect(markdownToSlackMrkdwn(input)).toBe(
      [
        "`a**b**c` and `[x](https://a.test)`",
        "```",
        'const x = "**not bold**"; // - [y](z)',
        "# not a heading",
        "```",
        "• *브랜치:* `e2e-branch`",
      ].join("\n"),
    );
  });

  test("bold may wrap a code span", () => {
    expect(markdownToSlackMrkdwn("**run `x` now**")).toBe("*run `x` now*");
  });

  test("leaves text Slack already reads alone", () => {
    const slack =
      "*bold* _it_ ~s~ <https://a.test|a> > quote\n2 * 3 * 4 snake_case";
    expect(markdownToSlackMrkdwn(slack)).toBe(slack);
  });

  test("the reply from the 4620 capture", () => {
    const reply = [
      "# 변환 확인",
      "",
      "이 문장에는 **굵게** 표시가 들어 있습니다.",
      "",
      "~~취소~~",
      "",
      "[예시 링크](https://example.com)",
      "",
      "- 첫 번째 항목",
      "  - 하위 항목",
      "- 두 번째 항목",
      "",
      "| 이름 | 값 |",
      "| --- | --- |",
      "| alpha | 1 |",
      "",
      "`a**b**c`",
      "",
      "```ts",
      'const text: string = "**not bold**";',
      "```",
      "",
      "- **브랜치:** `e2e-branch`",
    ].join("\n");
    expect(markdownToSlackMrkdwn(reply)).toBe(
      [
        "*변환 확인*",
        "",
        "이 문장에는 *굵게* 표시가 들어 있습니다.",
        "",
        "~취소~",
        "",
        "<https://example.com|예시 링크>",
        "",
        "• 첫 번째 항목",
        "    ◦ 하위 항목",
        "• 두 번째 항목",
        "",
        "*alpha* — 값: 1",
        "",
        "`a**b**c`",
        "",
        "```",
        'const text: string = "**not bold**";',
        "```",
        "",
        "• *브랜치:* `e2e-branch`",
      ].join("\n"),
    );
  });

  test("link destinations and bare URLs keep their characters", () => {
    expect(
      markdownToSlackMrkdwn(
        "[**Open**](https://a.test/a**b**c) https://a.test/x~~y~~z <https://a.test/**k**>",
      ),
    ).toBe(
      "<https://a.test/a**b**c|*Open*> https://a.test/x~~y~~z <https://a.test/**k**>",
    );
    expect(markdownToSlackMrkdwn("# see https://a.test/**x**")).toBe(
      "*see https://a.test/**x***",
    );
  });

  test("double-backtick spans and tilde fences are code too", () => {
    expect(markdownToSlackMrkdwn("`` a **b** `` and ``x`y``")).toBe(
      "`` a **b** `` and ``x`y``",
    );
    expect(markdownToSlackMrkdwn("~~~ts\n**literal**\n~~~\n**after**")).toBe(
      "```\n**literal**\n```\n*after*",
    );
  });

  test("fences inside a fence stay as written", () => {
    const nested = "```md\n~~~\n**x** ``y``\n~~~\n```";
    expect(markdownToSlackMrkdwn(nested)).toBe(
      "```\n~~~\n**x** ``y``\n~~~\n```",
    );
  });

  test("a tilde fence holding a backtick fence stays as written", () => {
    const tilde = "~~~md\n**literal**\n```\nx\n```\n~~~\n**after**";
    expect(markdownToSlackMrkdwn(tilde)).toBe(
      "~~~md\n**literal**\n```\nx\n```\n~~~\n*after*",
    );
  });

  test("a table's row list stays within a fixed multiple of its source", () => {
    const wide = `| h | b |\n|---|---|\n| ${"x".repeat(10_000)} | b |\n${"| a | b |\n".repeat(8_000)}`;
    expect(markdownToSlackMrkdwn(wide).length).toBeLessThan(wide.length * 2);
    const ragged = `|h|\n|-|\n${"|".repeat(1_000)}\n${"|x|\n".repeat(24_000)}`;
    expect(markdownToSlackMrkdwn(ragged).length).toBeLessThan(ragged.length);
    const sparse = `|${"h|".repeat(2_000)}\n|${"-|".repeat(2_000)}\n${"|x|\n".repeat(2_000)}`;
    expect(markdownToSlackMrkdwn(sparse).length).toBeLessThan(sparse.length);
    const longHeader = `|a|${"H".repeat(10_000)}|\n|-|-|\n${"|x|y|\n".repeat(1_000)}`;
    expect(markdownToSlackMrkdwn(longHeader).length).toBeLessThan(100_000);
    // A cut must not land inside a code span kept for later.
    const codeHeader = `|a|${"x".repeat(38)}\`code\`|\n|-|-|\n${"|x|y|\n".repeat(100)}`;
    expect(markdownToSlackMrkdwn(codeHeader)).toContain(
      `*x* — ${"x".repeat(38)}co: y`,
    );
    const longCode = `|a|\`${"H".repeat(10_000)}\`|\n|-|-|\n${"|x|y|\n".repeat(100)}`;
    expect(markdownToSlackMrkdwn(longCode).length).toBeLessThan(100_000);
  });

  test("a table ends before a quote and keeps its code spans", () => {
    expect(markdownToSlackMrkdwn("| x |\n| --- |\n| ``a`b`` |\n> q | z")).toBe(
      "*``a`b``*\n> q | z",
    );
  });

  test("a list right after a table is not part of it", () => {
    expect(
      markdownToSlackMrkdwn(
        "| Name |\n| --- |\n| Alice |\n- **Note:** choose A | B\n1. Pick A | B",
      ),
    ).toBe("*Alice*\n• *Note:* choose A | B\n1. Pick A | B");
  });

  test("a blank line inside a list keeps the nesting", () => {
    expect(
      markdownToSlackMrkdwn("- a\n\n  - b\n\n  text\n- c\nplain\n  - d"),
    ).toBe("• a\n\n    ◦ b\n\n  text\n• c\nplain\n• d");
  });

  test("unclosed markers stay linear on a long line", () => {
    const started = performance.now();
    const spaces = " ".repeat(50_000);
    markdownToSlackMrkdwn(
      [
        "**a ".repeat(25_000),
        "~~a ".repeat(25_000),
        `# a${spaces}x`,
        "| a |",
        `|-${spaces}x`,
        "a|b",
        `${spaces}|x`,
        "``x```".repeat(10_000),
        "~~~x\n".repeat(10_000),
        `${"~~~x\n".repeat(10_000)}\`\`\`\nx\n\`\`\`\n~~~`,
        Array.from({ length: 250 }, (_, i) => `${"~".repeat(252 - i)}x`).join(
          "\n",
        ),
        "a\n".repeat(31_250),
        Array(16_000).fill("h").join("|"),
        Array(16_000).fill("-").join("|"),
        ...Array(16_000).fill("|"),
      ].join("\n"),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("leaves text holding the placeholder characters untouched", () => {
    const odd = "\uE000 **x**";
    expect(markdownToSlackMrkdwn(odd)).toBe(odd);
  });

  // Slack's own URL finder reads on to the next space, past a closing backtick.
  describe("a code span ending in a URL keeps its closing backtick", () => {
    const cases: [string, string, string][] = [
      [
        "1: letters right after the span",
        "`origin`은 `http://egress-proxy:3129/repository/sandbox/.git`이고, 연결돼요",
        `\`origin\`은 \`http://egress-proxy:3129/repository/sandbox/.git\`${ZW}이고, 연결돼요`,
      ],
      [
        "2: a space after the span",
        "`https://a.test/x` 를 보세요",
        "`https://a.test/x` 를 보세요",
      ],
      [
        "3: punctuation after the span",
        "`https://a.test/x`.",
        "`https://a.test/x`.",
      ],
      ["4: code that is not a URL", "`gh`로 조회해요", "`gh`로 조회해요"],
      [
        "5: letters on both sides",
        "앞`https://a.test`뒤",
        `앞\`https://a.test\`${ZW}뒤`,
      ],
      [
        "6: a fence closing on the URL's line",
        "```\nhttps://a.test/x```이어서",
        "```\nhttps://a.test/x\n```이어서",
      ],
      [
        "7: a double-backtick span",
        "``https://a.test/x``이고",
        `\`https://a.test/x\`${ZW}이고`,
      ],
      [
        "8: a table cell, drawn in a row line",
        "| h |\n| --- |\n| `https://a.test`이고 |",
        `*\`https://a.test\`${ZW}이고*`,
      ],
      [
        "9: a closing parenthesis after the span",
        "(`https://a.test/x`)",
        "(`https://a.test/x`)",
      ],
      [
        "10: code in a link label",
        "[`https://a.test`이고](https://b.test)",
        `\`https://a.test\`${ZW}이고 (https://b.test)`,
      ],
    ];
    for (const [name, input, expected] of cases) {
      test(name, () => {
        expect(markdownToSlackMrkdwn(input)).toBe(expected);
      });
    }

    test("a double-backtick span inside a fence keeps its backticks", () => {
      expect(markdownToSlackMrkdwn("```md\n``https://a.test/x``\n```")).toBe(
        "```\n``https://a.test/x``\n```",
      );
      expect(markdownToSlackMrkdwn("~~~\n``https://a.test/x``\n~~~")).toBe(
        "```\n``https://a.test/x``\n```",
      );
    });

    // escapeSlackControls reads the span as code and escapes the `<` in it.
    test("code is found where escaping finds it, even across a <", () => {
      expect(markdownToSlackMrkdwn("`<https://a.test`이고>")).toBe(
        `\`<https://a.test\`${ZW}이고>`,
      );
    });

    test("a long span with a URL early on stays linear", () => {
      const span = `\`${"https://a.test/".repeat(16_000)} \`이고`;
      const started = performance.now();
      expect(markdownToSlackMrkdwn(span)).toBe(span);
      expect(performance.now() - started).toBeLessThan(200);
    });

    test("an upper-case scheme is a URL too", () => {
      expect(markdownToSlackMrkdwn("`HTTPS://a.test/x`이고")).toBe(
        `\`HTTPS://a.test/x\`${ZW}이고`,
      );
    });
  });
});
