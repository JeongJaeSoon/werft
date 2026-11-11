import { describe, expect, test } from "bun:test";
import {
  presentPendingRequest,
  TOOL_VERB_VALUES,
  type ToolVerbMessage,
} from "@werft-ai/contracts";
import { setupDom } from "@werft-ai/ui/test-support/dom";
import { sessionsEn, sessionsJa, sessionsKo } from "../../messages/sessions.ts";

const { render } = await setupDom();
// After setupDom: this loads @werft-ai/ui, whose Radix decides at import time
// whether a DOM exists, for every later file in the run too.
const { ToolSummary } = await import("./tool-summary.tsx");

// The Slack side of this check is `packages/adapters/chat/slack/src/
// slack-prompts.view-model.test.ts`: the same requests and the same view model
// (`presentPendingRequest`), drawn there as Slack blocks and here as React.
// Keep the two REQUESTS lists equal.
const REQUESTS = [
  {
    tool: "Bash",
    input: { command: "git status", description: "Check the tree" },
  },
  {
    tool: "Write",
    input: {
      file_path: "src/a.ts",
      content: "first\nsecond\nthird\nfourth\nfifth\n",
    },
  },
  {
    tool: "Edit",
    input: {
      file_path: "src/b.ts",
      old_string: "one",
      new_string: "two\nthree",
    },
  },
  { tool: "Read", input: { file_path: "README.md" } },
  { tool: "WebFetch", input: { url: "https://example.com/docs" } },
  { tool: "mcp__docs__search", input: { query: "retention" } },
  { tool: "Frobnicate", input: {} },
] as const;

type Table = Record<string, string>;
const verbIn =
  (table: Table) =>
  (message: ToolVerbMessage): string => {
    let text = table[message.key] ?? "";
    for (const [key, value] of Object.entries(message.params ?? {})) {
      text = text.replace(`{${key}}`, () => value);
    }
    return text;
  };

describe("the web tool summary and its view model", () => {
  test("the view model has the three fields the summary is drawn from", () => {
    for (const request of REQUESTS) {
      expect(
        Object.keys(presentPendingRequest(request.tool, request.input)).sort(),
      ).toEqual(["excerpt", "target", "verb"]);
    }
  });

  test("every verb has web wording in every language", () => {
    for (const table of [sessionsKo, sessionsEn, sessionsJa] as Table[]) {
      for (const verb of TOOL_VERB_VALUES) {
        expect(table[`action.tool.${verb}`] ?? "").not.toBe("");
      }
    }
  });

  test.each([...REQUESTS])(
    "the $tool summary shows the view model's verb, target and excerpt",
    (request) => {
      const presented = presentPendingRequest(request.tool, request.input);
      const view = render(
        <ToolSummary summary={presented} verb={verbIn(sessionsEn as Table)} />,
      );
      const text = view.container.textContent ?? "";
      expect(text).toContain(verbIn(sessionsEn as Table)(presented.verb));
      if (presented.target !== null) expect(text).toContain(presented.target);
      if (presented.excerpt !== null) {
        expect(view.container.querySelector("pre,code")?.textContent).toContain(
          presented.excerpt,
        );
      }
    },
  );

  test("the fixtures exercise a target and an excerpt, or the check above proves nothing", () => {
    const presented = REQUESTS.map((request) =>
      presentPendingRequest(request.tool, request.input),
    );
    expect(presented.some((entry) => entry.target !== null)).toBe(true);
    expect(presented.some((entry) => entry.excerpt !== null)).toBe(true);
  });
});
