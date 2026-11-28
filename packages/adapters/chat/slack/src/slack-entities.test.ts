import { describe, expect, test } from "bun:test";
import { unescapeSlackText } from "./slack-entities.ts";
import { escapeSlackControls } from "./slack-presentation.ts";
import { withoutBotMention } from "./slack-session-handler.ts";

describe("unescapeSlackText", () => {
  test("reads the three entities Slack escapes", () => {
    expect(unescapeSlackText("A &amp;&amp; B &lt; C &gt; D")).toBe(
      "A && B < C > D",
    );
  });

  test("reads &amp;amp; once", () => {
    expect(unescapeSlackText("&amp;amp;")).toBe("&amp;");
    expect(unescapeSlackText("&amp;lt;")).toBe("&lt;");
  });

  test("leaves other HTML entities alone", () => {
    expect(unescapeSlackText("&quot; &#39; &nbsp; &copy; &amp")).toBe(
      "&quot; &#39; &nbsp; &copy; &amp",
    );
  });

  test("keeps code block and inline code lines", () => {
    const text =
      "```\nif a &amp;&amp; b {}\nx &lt;T&gt; y\n```\nrun `a &amp;&amp; b`";
    expect(unescapeSlackText(text)).toBe(
      "```\nif a && b {}\nx <T> y\n```\nrun `a && b`",
    );
  });

  test("a line mixing notation and entities", () => {
    expect(
      unescapeSlackText(
        "<#C1> <https://x.dev/a?b=1&amp;c=2|a &amp; b> &lt;!here&gt;",
      ),
    ).toBe("<#C1> <https://x.dev/a?b=1&c=2|a & b> <!here>");
  });

  test("what the bot writes is escaped as before", () => {
    expect(escapeSlackControls("A && B <x> `c`", undefined)).toBe(
      "A &amp;&amp; B &lt;x&gt; `c`",
    );
  });

  test("an escaped mention is not the bot's mention", () => {
    const raw = "&lt;@UBOT&gt; deploy &amp;&amp; test";
    expect(withoutBotMention(raw, "UBOT")).toBe(raw);
    expect(unescapeSlackText(withoutBotMention(raw, "UBOT"))).toBe(
      "<@UBOT> deploy && test",
    );
  });

  test("the real mention is cut before the entities are read", () => {
    expect(
      unescapeSlackText(withoutBotMention("<@UBOT> a &amp;&amp; b", "UBOT")),
    ).toBe("a && b");
  });
});
