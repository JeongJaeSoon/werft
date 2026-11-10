import { describe, expect, test } from "bun:test";

import { escapeSlackControls } from "./slack-presentation.ts";

describe("escapeSlackControls without a policy", () => {
  test.each([
    ["<!here>", "&lt;!here&gt;"],
    ["<!channel>", "&lt;!channel&gt;"],
    ["<!everyone>", "&lt;!everyone&gt;"],
    ["<!subteam^S1>", "&lt;!subteam^S1&gt;"],
    ["<!subteam^S1|@oncall>", "&lt;!subteam^S1|@oncall&gt;"],
    ["<#C1|name>", "&lt;#C1|name&gt;"],
    ["<#C1>", "&lt;#C1&gt;"],
    ["<@U1>", "&lt;@U1&gt;"],
    ["<@W1>", "&lt;@W1&gt;"],
    ["<javascript:alert(1)>", "&lt;javascript:alert(1)&gt;"],
  ])("escapes %s", (input, expected) => {
    expect(escapeSlackControls(input)).toBe(expected);
  });

  test("a nested control inside a link label cannot ride along", () => {
    // Kollegium presentation.test.ts: unsafe destinations, nested case.
    const escaped = escapeSlackControls(
      "<https://example.com|notify <!channel>>",
    );
    expect(escaped).not.toContain("<!channel>");
    expect(escaped).toContain("&lt;!channel&gt;");
  });

  test("an untrusted mention is escaped while a safe link stays a link", () => {
    // Kollegium web-api.test.ts: ordinary safe mrkdwn without implicit mentions.
    expect(
      escapeSlackControls("*수요일* <@U123> <https://example.com|문서>"),
    ).toBe("*수요일* &lt;@U123&gt; <https://example.com|문서>");
    // Kollegium presentation.test.ts: links survive.
    expect(escapeSlackControls("<https://example.com/runbook|runbook>")).toBe(
      "<https://example.com/runbook|runbook>",
    );
    expect(escapeSlackControls("<mailto:ops@example.com|메일>")).toBe(
      "<mailto:ops@example.com|메일>",
    );
  });

  test("a date control notifies nobody and is kept", () => {
    const date = "<!date^1758500000^{date_short}|2025-09-22>";
    expect(escapeSlackControls(date)).toBe(date);
  });

  test.each([
    "<!date^1793600000^{date}^https://evil.example/login|웹에서 승인>",
    "<!date^1793600000^{date}^javascript:alert(1)|x>",
    "<!date^1793600000^{date}|a^https://evil.example>",
    "<!date^soon^{date}|x>",
    "<!date^1793600000^|x>",
  ])("a date control that is more than a date is escaped: %s", (date) => {
    const escaped = `&lt;${date.slice(1, -1)}&gt;`;
    expect(escapeSlackControls(date)).toBe(escaped);
    expect(escapeSlackControls(date, { maskedLinks: "expand" })).toBe(escaped);
  });

  test("bare ampersands are escaped once, entities are not doubled", () => {
    expect(escapeSlackControls("R&D &amp; ops &lt;b&gt;")).toBe(
      "R&amp;D &amp; ops &lt;b&gt;",
    );
  });

  test("ordinary text, Korean and literal stars are left as written", () => {
    // Kollegium presentation.test.ts: Korean facts and literal stars.
    const text = "**수요일** 14:00에 배포합니다.\n곱셈은 2 * 3 = 6입니다. 🚀";
    expect(escapeSlackControls(text)).toBe(text);
  });

  test("a comparison that looks like a control keeps its meaning", () => {
    expect(escapeSlackControls("if a < b and c > d")).toBe(
      "if a &lt; b and c &gt; d",
    );
    expect(escapeSlackControls("a < b\nc > d")).toBe("a &lt; b\nc > d");
  });

  test("code spans and fenced code show their controls as written", () => {
    // Slack parses `<!here>` inside backticks into a broadcast token too.
    expect(
      escapeSlackControls(
        '코드:\n```ts\nconst marker = "**literal** <@U999> & x";\n```',
      ),
    ).toBe(
      '코드:\n```ts\nconst marker = "**literal** &lt;@U999&gt; &amp; x";\n```',
    );
    expect(escapeSlackControls("run `echo <!here>` then <!here>")).toBe(
      "run `echo &lt;!here&gt;` then &lt;!here&gt;",
    );
    for (const control of [
      "<!here>",
      "<!channel>",
      "<!everyone>",
      "<!subteam^S1|@oncall>",
      "<@U1>",
      "<#C1>",
      "<https://example.com|x>",
    ]) {
      const inner = control.slice(1, -1);
      expect(escapeSlackControls(`\`${control}\``)).toBe(
        `\`&lt;${inner}&gt;\``,
      );
      expect(escapeSlackControls(`\`\`\`\n${control}\n\`\`\``)).toBe(
        `\`\`\`\n&lt;${inner}&gt;\n\`\`\``,
      );
    }
  });

  test("code ignores the policy and nested brackets", () => {
    const policy = {
      userIds: ["U1"],
      userGroupIds: ["S1"],
      special: ["here", "channel", "everyone"] as const,
    };
    expect(
      escapeSlackControls("`<@U1> <!here> <!subteam^S1>` <@U1>", policy),
    ).toBe("`&lt;@U1&gt; &lt;!here&gt; &lt;!subteam^S1&gt;` <@U1>");
    expect(escapeSlackControls("`<<!here>>` and `a<b>c`")).toBe(
      "`&lt;&lt;!here&gt;&gt;` and `a&lt;b&gt;c`",
    );
    expect(escapeSlackControls("`&lt;!here&gt; &amp; R&D`")).toBe(
      "`&lt;!here&gt; &amp; R&amp;D`",
    );
  });

  test("escaping its own output again changes nothing", () => {
    for (const text of [
      "`<!here>` <!here> ```\n<@U1> & <x>\n``` <https://a.example|a>",
      "<https://example.com|<!here>> a < b `c > d`",
    ]) {
      const once = escapeSlackControls(text, { maskedLinks: "expand" });
      expect(escapeSlackControls(once, { maskedLinks: "expand" })).toBe(once);
    }
    const policy = { userIds: ["U1"], maskedLinks: "expand" } as const;
    const once = escapeSlackControls("<@U1> `<@U1>` <@U2>", policy);
    expect(once).toBe("<@U1> `&lt;@U1&gt;` &lt;@U2&gt;");
    expect(escapeSlackControls(once, policy)).toBe(once);
  });

  test("a backtick inside a control cannot move a code boundary", () => {
    // Expanding `|`>` would join "``" and "`" into a fence around <@U1>.
    const policy = { maskedLinks: "expand", userIds: ["U1"] } as const;
    const once = escapeSlackControls("```<@U1>\n``<https://a|`>", policy);
    expect(once).toBe("```<@U1>\n``&lt;https://a|`&gt;");
    expect(escapeSlackControls(once, policy)).toBe(once);
  });

  test("a control split by a code span cannot reach Slack whole", () => {
    expect(escapeSlackControls("<!subteam^S1|`x`>")).toBe(
      "&lt;!subteam^S1|`x`>",
    );
    expect(
      escapeSlackControls("<@U1|`x`> <!here|`y`>", { userIds: ["U1"] }),
    ).toBe("&lt;@U1|`x`> &lt;!here|`y`>");
    expect(escapeSlackControls("<https://a.example/`x`|y>")).toBe(
      "&lt;https://a.example/`x`|y>",
    );
  });

  test("ordinary code renders as written", () => {
    expect(escapeSlackControls("`a < b && c`")).toBe("`a &lt; b &amp;&amp; c`");
    expect(escapeSlackControls("```html\n<b>bold</b>\n```")).toBe(
      "```html\n&lt;b&gt;bold&lt;/b&gt;\n```",
    );
  });

  test("an unclosed backtick or fence shields nothing", () => {
    expect(escapeSlackControls("unmatched ` then <!here>")).toBe(
      "unmatched ` then &lt;!here&gt;",
    );
    expect(escapeSlackControls("open ``` <!here>")).toBe(
      "open ``` &lt;!here&gt;",
    );
    expect(escapeSlackControls("`a` and ` <@U1>")).toBe(
      "`a` and ` &lt;@U1&gt;",
    );
    expect(escapeSlackControls("a `b\n<!channel>\nc` d")).toBe(
      "a `b\n&lt;!channel&gt;\nc` d",
    );
    expect(escapeSlackControls("``` <!here> `x` <!here>")).toBe(
      "``` &lt;!here&gt; `x` &lt;!here&gt;",
    );
  });
});

describe("escapeSlackControls with a policy", () => {
  test("keeps only the references the caller vouches for", () => {
    // Kollegium presentation.test.ts: trusted references.
    expect(
      escapeSlackControls(
        "Owner <@U123ABC> in <#C123ABC> <!here> and literal <@U999BAD>.",
        { userIds: ["U123ABC"], channelIds: ["C123ABC"] },
      ),
    ).toBe(
      "Owner <@U123ABC> in <#C123ABC> &lt;!here&gt; and literal &lt;@U999BAD&gt;.",
    );
    // Kollegium web-api.test.ts: explicitly trusted mentions only.
    expect(
      escapeSlackControls("Owner <@U123> and <@U999>.", { userIds: ["U123"] }),
    ).toBe("Owner <@U123> and &lt;@U999&gt;.");
  });

  test("groups and broad mentions need their own entries", () => {
    const policy = { userGroupIds: ["S1"], special: ["here"] as const };
    expect(escapeSlackControls("<!subteam^S1|@oncall> <!here>", policy)).toBe(
      "<!subteam^S1|@oncall> <!here>",
    );
    expect(escapeSlackControls("<!channel> <!subteam^S2>", policy)).toBe(
      "&lt;!channel&gt; &lt;!subteam^S2&gt;",
    );
  });

  test("a trusted id inside a nested control is still escaped", () => {
    expect(
      escapeSlackControls("<https://example.com|<@U1>>", { userIds: ["U1"] }),
    ).toBe("&lt;https://example.com|&lt;@U1&gt;>");
  });
});

describe("escapeSlackControls with maskedLinks: expand", () => {
  const expand = { maskedLinks: "expand" } as const;

  test("a safe masked link shows where it goes", () => {
    expect(
      escapeSlackControls(
        "<https://evil.example/login|웹에서 승인> and <https://a.example>",
        expand,
      ),
    ).toBe("웹에서 승인 (https://evil.example/login) and <https://a.example>");
    expect(escapeSlackControls("<mailto:a@b.example|mail>", expand)).toBe(
      "mail (mailto:a@b.example)",
    );
  });

  test("an unsafe or nested masked link is escaped as before", () => {
    expect(escapeSlackControls("<javascript:alert(1)|click>", expand)).toBe(
      "&lt;javascript:alert(1)|click&gt;",
    );
    expect(escapeSlackControls("<https://example.com|<!here>>", expand)).toBe(
      "&lt;https://example.com|&lt;!here&gt;>",
    );
  });

  test("a label's text stays text, and code shows its link as written", () => {
    expect(
      escapeSlackControls("<https://example.com|!here @channel>", expand),
    ).toBe("!here @channel (https://example.com)");
    expect(
      escapeSlackControls(
        "`<https://example.com|x>` <https://b.example|y>",
        expand,
      ),
    ).toBe("`&lt;https://example.com|x&gt;` y (https://b.example)");
  });

  test("keep is the default", () => {
    expect(escapeSlackControls("<https://example.com|x>")).toBe(
      "<https://example.com|x>",
    );
    expect(
      escapeSlackControls("<https://example.com|x>", { maskedLinks: "keep" }),
    ).toBe("<https://example.com|x>");
  });
});
