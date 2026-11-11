import { describe, expect, test } from "bun:test";
import {
  presentPendingRequest,
  presentPushRequest,
  SLACK_INTERACTION_ACTIONS,
  TOOL_VERB_VALUES,
  USER_LOCALE_VALUES,
} from "@werft-ai/contracts";
import type { SlackPromptCard } from "@werft-ai/platform";
import { SLACK_SUMMARY_MESSAGES } from "./slack-prompt-summary.ts";
import {
  type SlackPrompt,
  slackPromptMessage,
  slackRejectOnlyCard,
} from "./slack-prompts.ts";

// The web side of this check is `packages/react/src/components/session/
// tool-summary.view-model.test.tsx`: the same requests, the same view model
// (`presentPendingRequest`), drawn there as React and here as Slack blocks.
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

const SESSION = "019a0000-0000-7000-8000-0000000000a5";

const prompt = (request: (typeof REQUESTS)[number]): SlackPrompt => ({
  kind: "permission",
  sessionId: SESSION,
  requestId: "toolu_1",
  tool: request.tool,
  input: request.input,
  context: {},
  expiresAt: "2026-11-03T00:00:00Z",
});

/** Every string a card holds, the folded raw input included. */
function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(textsOf);
  }
  return [];
}

describe("the Slack permission card and its view model", () => {
  test("the view model has the three fields the card is drawn from", () => {
    for (const request of REQUESTS) {
      expect(
        Object.keys(presentPendingRequest(request.tool, request.input)).sort(),
      ).toEqual(["excerpt", "target", "verb"]);
    }
  });

  test("every verb has Slack's wording in every language", () => {
    for (const locale of USER_LOCALE_VALUES) {
      for (const verb of TOOL_VERB_VALUES) {
        expect(SLACK_SUMMARY_MESSAGES[locale][verb]).not.toBe("");
      }
    }
  });

  test.each([...REQUESTS])(
    "the $tool card shows the view model's verb, target and excerpt",
    (request) => {
      const presented = presentPendingRequest(request.tool, request.input);
      const { blocks } = slackPromptMessage(prompt(request), {
        locale: "en",
        requesterSlackUserId: null,
      });
      // The request in plain words sits above the folded raw input.
      const lines = textsOf(blocks.slice(0, 3));
      const name = presented.verb.key.slice(
        "action.tool.".length,
      ) as keyof (typeof SLACK_SUMMARY_MESSAGES)["en"];
      let verb = SLACK_SUMMARY_MESSAGES.en[name];
      for (const [key, value] of Object.entries(presented.verb.params ?? {})) {
        verb = verb.replace(`{${key}}`, () => value);
      }
      expect(lines.some((line) => line.includes(verb))).toBe(true);
      if (presented.target !== null) {
        expect(
          lines.some((line) => line.includes(presented.target ?? "")),
        ).toBe(true);
      }
      if (presented.excerpt !== null) {
        expect(
          lines.some((line) => line.includes(presented.excerpt ?? "")),
        ).toBe(true);
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

describe("the Slack push card and its view model", () => {
  const actionsOf = (blocks: unknown[]) =>
    textsOf(
      blocks.filter((block) => (block as { type: string }).type === "actions"),
    );
  const push = {
    kind: "push",
    sessionId: SESSION,
    requestId: "push-1",
    repositoryId: "repo-1",
    repositoryName: "acme/app",
    targetBranch: "agent/x",
    gitCommit: "abcdef1234567890".padEnd(40, "0"),
  } satisfies SlackPrompt;

  test("an approvable push offers approve and reject, an unapprovable one reject only, with the reason shown", () => {
    expect(presentPushRequest({ approvable: true }).approvable).toBe(true);
    const open = actionsOf(
      slackPromptMessage(push, { locale: "en", requesterSlackUserId: null })
        .blocks,
    );
    expect(open).toContain(SLACK_INTERACTION_ACTIONS.pushApprove);
    expect(open).toContain(SLACK_INTERACTION_ACTIONS.pushReject);

    const unapprovable = presentPushRequest({
      approvable: false,
      reason: "checkpoint_moved",
    });
    expect(unapprovable.approvable).toBe(false);
    expect(unapprovable.reason).not.toBeNull();
    const card = slackRejectOnlyCard(
      {
        locale: "en",
        linkUrl: null,
        display: { ...push, state: "requested" },
      } as unknown as SlackPromptCard & { display: { kind: "push" } },
      { sessionId: SESSION, requestId: "push-1" },
    );
    const rejectOnly = actionsOf(card.blocks);
    expect(rejectOnly).not.toContain(SLACK_INTERACTION_ACTIONS.pushApprove);
    expect(rejectOnly).toContain(SLACK_INTERACTION_ACTIONS.pushReject);
    expect(textsOf(card.blocks).join("\n")).toContain(":warning:");
  });
});
