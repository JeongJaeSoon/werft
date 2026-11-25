import { describe, expect, test } from "bun:test";
import type { UserLocale } from "@werft-ai/contracts";
import {
  budgetRefusalTurnDedupeKey,
  type PushSource,
  type SurfaceCardClaim,
  type SurfaceCardRendered,
  type SurfaceCardSettleStore,
  type SurfaceOpenPushCard,
  type SurfaceOutboxEntry,
} from "@werft-ai/platform";
import { settleSlackCards } from "./slack-card-settle.ts";
import {
  createOutboxSlackNoticeSink,
  finalReplyText,
  slackPromptDedupeKey,
  slackTurnDedupeKey,
} from "./slack-outbox-enqueue.ts";
import {
  SLACK_OUTBOX_MESSAGES,
  SLACK_TEXT_MAX,
  slackOutboxText,
} from "./slack-outbox-render.ts";

describe("settleSlackCards", () => {
  test("a claim reached after the deadline goes back unsent, keeping its error", async () => {
    const claim = (id: string) =>
      ({
        id,
        claimToken: `token-${id}`,
        workspaceId: "w",
        slackAppId: "A",
        sessionId: "s",
        channelId: "C",
        slackTs: `1.${id}`,
        dedupeKey: `prompt:s:${id}`,
        body: { text: "card" },
        rendered: "open",
        uncertainRev: 0,
        uncertain: false,
        inherited: false,
        attempts: 0,
      }) as SurfaceCardClaim;
    const deferred: unknown[] = [];
    let claims = 0;
    const store = {
      expireInflight: async () => 0,
      markDue: async () => 0,
      claim: async () => (claims++ === 0 ? [claim("1"), claim("2")] : []),
      defer: async (fence, input) => {
        deferred.push([fence.id, input]);
        return true;
      },
    } as Partial<SurfaceCardSettleStore> as SurfaceCardSettleStore;
    let clock = 0;
    const sent: unknown[] = [];
    const pass = await settleSlackCards({
      store,
      slack: { updateMessage: async (_token, input) => void sent.push(input) },
      botToken: async () => "xoxb-test",
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      batchSize: 20,
      deadline: 1000,
      // The loop's own check passes; the clock then runs out mid-batch.
      now: () => (clock++ === 0 ? 0 : 1000),
    });
    expect(sent).toEqual([]);
    expect(deferred).toEqual([
      ["1", { retryInMs: 0, failed: false, error: null }],
      ["2", { retryInMs: 0, failed: false, error: null }],
    ]);
    expect(pass).toMatchObject({ claimed: 2, deferred: 2, sent: 0 });
  });

  test("pages past push cards that stay reject-only, so a later one still gets its Reject-only card", async () => {
    const push = (seq: number, rendered: "open" | "reject_only") =>
      ({
        id: `card-${seq}`,
        seq,
        sessionId: `session-${seq}`,
        rendered,
        sessionCheckpointRevision: 2,
        checkpointRevision: 1,
        gitCommit: "a".repeat(40),
        origin: "direct",
      }) satisfies SurfaceOpenPushCard;
    const open = [
      push(1, "reject_only"),
      push(2, "reject_only"),
      push(3, "open"),
    ];
    const marked: string[] = [];
    const store = {
      expireInflight: async () => 0,
      markDue: async () => 0,
      openPushCards: async ({ limit, afterSeq }) =>
        open
          .filter((card) => afterSeq === null || card.seq > afterSeq)
          .slice(0, limit),
      markDueById: async (id) => {
        marked.push(id);
        return true;
      },
      claim: async () => [],
    } as Partial<SurfaceCardSettleStore> as SurfaceCardSettleStore;
    const pushSource = {
      readPushSource: async () => ({
        status: "ready",
        revision: 2,
        gitCommit: "b".repeat(40),
      }),
    } as unknown as PushSource;
    const pass = await settleSlackCards({
      store,
      slack: { updateMessage: async () => {} },
      botToken: async () => null,
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      pushSource,
      batchSize: 1,
      deadline: Date.now() + 60_000,
    });
    expect(marked).toEqual(["card-3"]);
    expect(pass.due).toBe(1);
  });

  // Answer 15 (94S-2000): a private channel push whose requester left shows
  // it; the label follows the requester out and back in.
  describe("a push card whose requester left the private channel", () => {
    const stalePushSource = {
      readPushSource: async () => ({
        status: "ready",
        revision: 2,
        gitCommit: "b".repeat(40),
      }),
    } as unknown as PushSource;

    async function redraw(input: {
      rendered: SurfaceCardRendered;
      kind?: "push" | "prompt";
      stale?: boolean;
      left?: boolean;
    }) {
      const kind = input.kind ?? "push";
      const asked: unknown[] = [];
      const calls: unknown[] = [];
      const batches = [
        [
          {
            id: "card-1",
            claimToken: "fence",
            workspaceId: "w",
            slackAppId: "A",
            sessionId: "s",
            channelId: "C0PRIV",
            slackTs: "1.1",
            dedupeKey: `${kind}:s:push-1`,
            body: {
              text: "push card",
              blocks: [{ type: "section" }, { type: "actions" }],
              locale: "ko",
            },
            rendered: input.rendered,
            uncertainRev: 0,
            uncertain: false,
            inherited: false,
            attempts: 0,
          } as SurfaceCardClaim,
        ],
        [],
      ];
      const display =
        kind === "push"
          ? {
              kind: "push",
              state: "requested",
              repositoryId: "repo",
              repositoryName: "sandbox",
              gitCommit: "a".repeat(40),
              targetBranch: "agent/s",
            }
          : { kind: "question", state: "open" };
      const store = {
        markDue: async () => 0,
        openPushCards: async () => [],
        expireInflight: async () => 0,
        claim: async () => batches.shift() ?? [],
        card: async () => ({
          locale: "ko",
          linkUrl: null,
          display,
          ...(input.stale
            ? { pushRevisions: { session: 2, request: 1, origin: "direct" } }
            : {}),
        }),
        beginSend: async () => new Date(0),
        finish: async (_fence: unknown, sent: { rendered: string }) => {
          calls.push(["finish", sent.rendered]);
          return true;
        },
        skip: async () => {
          calls.push(["skip"]);
          return true;
        },
      } as unknown as SurfaceCardSettleStore;
      await settleSlackCards({
        store,
        slack: {
          updateMessage: async (_token, edit) => {
            calls.push(["edit", edit.blocks, edit.text]);
          },
        },
        botToken: async () => "xoxb-test",
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        ...(input.stale ? { pushSource: stalePushSource } : {}),
        ...(input.left === undefined
          ? {}
          : {
              requesterLeft: async (push) => {
                asked.push(push);
                return input.left === true;
              },
            }),
        batchSize: 1,
        deadline: Date.now() + 60_000,
      });
      return { calls, asked };
    }

    const label = {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: ":information_source: 요청자가 채널을 나갔어요",
        },
      ],
    };

    test.each([
      // [shown now, requester left, stale] → drawn
      ["open", false, false, "open"],
      ["open", true, false, "open_requester_left"],
      ["open_requester_left", true, false, "open_requester_left"],
      ["open_requester_left", false, false, "open"],
      ["reject_only", true, true, "reject_only_requester_left"],
      ["reject_only_requester_left", true, true, "reject_only_requester_left"],
      ["reject_only_requester_left", false, true, "reject_only"],
      ["open_requester_left", true, true, "reject_only_requester_left"],
    ] as const)(
      "%s, left %p, stale %p → %s",
      async (shown, left, stale, drawn) => {
        const { calls, asked } = await redraw({ rendered: shown, left, stale });
        expect(asked).toEqual([
          { workspaceId: "w", sessionId: "s", pushRequestId: "push-1" },
        ]);
        expect(calls.at(-1)).toEqual(
          drawn === shown ? ["skip"] : ["finish", drawn],
        );
        if (drawn === shown) return;
        const blocks = calls[0] as [string, unknown[], string];
        const hasLabel = JSON.stringify(blocks[1]).includes(
          "요청자가 채널을 나갔어요",
        );
        expect(hasLabel).toBe(drawn.endsWith("_requester_left"));
        expect(blocks[2].includes("요청자가 채널을 나갔어요")).toBe(hasLabel);
      },
    );

    test("the label goes above the buttons", async () => {
      const { calls } = await redraw({ rendered: "open", left: true });
      expect(calls[0]).toEqual([
        "edit",
        [{ type: "section" }, label, { type: "actions" }],
        "push card\n요청자가 채널을 나갔어요",
      ]);
    });

    test("as before: no requester check wired, or not a push card", async () => {
      expect((await redraw({ rendered: "open" })).calls).toEqual([["skip"]]);
      const prompt = await redraw({
        rendered: "open",
        kind: "prompt",
        left: true,
      });
      expect(prompt.asked).toEqual([]);
      expect(prompt.calls).toEqual([["skip"]]);
    });

    test("a labelled card is compared as its choice when its push goes stale", async () => {
      const marked: string[] = [];
      const card = (id: string, rendered: SurfaceOpenPushCard["rendered"]) =>
        ({
          id,
          seq: Number(id),
          sessionId: "s",
          rendered,
          sessionCheckpointRevision: 2,
          checkpointRevision: 1,
          gitCommit: "a".repeat(40),
          origin: "direct",
        }) satisfies SurfaceOpenPushCard;
      const store = {
        expireInflight: async () => 0,
        markDue: async () => 0,
        openPushCards: async ({ afterSeq }: { afterSeq: number | null }) =>
          afterSeq === null
            ? [
                card("1", "reject_only_requester_left"),
                card("2", "open_requester_left"),
              ]
            : [],
        markDueById: async (id: string) => {
          marked.push(id);
          return true;
        },
        claim: async () => [],
      } as unknown as SurfaceCardSettleStore;
      await settleSlackCards({
        store,
        slack: { updateMessage: async () => {} },
        botToken: async () => null,
        logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
        pushSource: stalePushSource,
        batchSize: 20,
        deadline: Date.now() + 60_000,
      });
      expect(marked).toEqual(["2"]);
    });
  });
});

describe("createOutboxSlackNoticeSink", () => {
  const record = async (locale: UserLocale | null) => {
    const enqueued: SurfaceOutboxEntry[] = [];
    const asked: unknown[] = [];
    const sink = createOutboxSlackNoticeSink({
      async enqueue(entry) {
        enqueued.push(entry);
        return "enqueued";
      },
      async readerLocale(reader) {
        asked.push(reader);
        return locale;
      },
    });
    await sink.record({
      workspaceId: "ws-1",
      agentId: "agent-1",
      installationId: "installation-1",
      slackAppId: "slack-app-1",
      teamId: "T0ACME",
      channelId: "C0OPS",
      threadTs: "100.000100",
      slackUserId: "U0A",
      reason: "unlinked",
      notice: { message: "connect", link_url: "https://console.example/l" },
      onceKey: "installation-1:C0OPS:100.000100:U0A",
    });
    expect(asked).toEqual([
      { workspaceId: "ws-1", teamId: "T0ACME", slackUserId: "U0A" },
    ]);
    return enqueued[0]?.body;
  };

  test("writes the notice in the reader's language, English without one", async () => {
    expect(await record("en")).toEqual({
      text: "Link your Slack account on the web",
      locale: "en",
      link_url: "https://console.example/l",
    });
    expect(await record("ja")).toMatchObject({
      text: "WebでSlackアカウントを連携してください",
      locale: "ja",
    });
    expect(await record(null)).toMatchObject({
      text: "Link your Slack account on the web",
      locale: "en",
    });
  });
});

// One event per block, as the runtime's codec gives them.
const said = (fields: Record<string, unknown>) => ({
  type: "assistant",
  payload: { type: "assistant", ...fields },
});
const text = (value: string) => said({ text: value });
const tool = said({
  tool_call: { id: "tu_1", name: "Read", input: {} },
});

describe("finalReplyText", () => {
  test("keeps what came after the last tool call, across events", () => {
    expect(
      finalReplyText([
        text("Looking."),
        tool,
        text("Found it."),
        said({ thinking: "hm" }),
        text("Here it is."),
        // The engine's own message is not read.
        said({ message: { content: [{ type: "text", text: "not shown" }] } }),
      ]),
    ).toBe("Found it.\n\nHere it is.");
  });

  test("is empty when the turn ended on a tool call or said nothing", () => {
    expect(finalReplyText([text("Looking."), tool])).toBe("");
    expect(finalReplyText([{ type: "assistant", payload: null }])).toBe("");
  });
});

describe("slackOutboxText", () => {
  const link = `\n\n<https://console.example/sessions/s1|${SLACK_OUTBOX_MESSAGES.en.link}>`;

  test("labels the link in the body's language, English without one", () => {
    const url = "https://console.example/sessions/s1";
    expect(slackOutboxText({ text: "Done", link_url: url })).toBe(
      `Done\n\n<${url}|Open on the web>`,
    );
    expect(slackOutboxText({ text: "Done", link_url: url, locale: "ko" })).toBe(
      `Done\n\n<${url}|웹에서 열기>`,
    );
    expect(slackOutboxText({ text: "完了", link_url: url, locale: "ja" })).toBe(
      `完了\n\n<${url}|Webで開く>`,
    );
  });

  test("every language has every word the outbox adds", () => {
    const keys = Object.keys(SLACK_OUTBOX_MESSAGES.ko).sort();
    for (const messages of Object.values(SLACK_OUTBOX_MESSAGES)) {
      expect(Object.keys(messages).sort()).toEqual(keys);
      for (const text of Object.values(messages)) {
        expect(text.trim()).not.toBe("");
      }
    }
  });

  test("escapes every control and appends the link unescaped", () => {
    expect(
      slackOutboxText({
        text: "<!channel> <@U1> <#C1> <!subteam^S1>",
        link_url: "https://console.example/sessions/s1",
      }),
    ).toBe(
      `&lt;!channel&gt; &lt;@U1&gt; &lt;#C1&gt; &lt;!subteam^S1&gt;${link}`,
    );
  });

  test("writes a masked link out so its label cannot hide the address", () => {
    expect(
      slackOutboxText({ text: "<https://evil.example/login|웹에서 승인>" }),
    ).toBe("웹에서 승인 (https://evil.example/login)");
  });

  test("writes Markdown as mrkdwn, still expanding links and escaping mentions", () => {
    expect(
      slackOutboxText({
        text: "- **브랜치:** `<@U2>`\n[웹에서 승인](https://evil.example/login) [<@U2>](https://a.test)",
      }),
    ).toBe(
      "• *브랜치:* `&lt;@U2&gt;`\n웹에서 승인 (https://evil.example/login) &lt;@U2&gt; (https://a.test)",
    );
  });

  test.each([
    [
      "<!date^1793600000^{date}^https://evil.example/login|웹에서 승인>",
      "&lt;!date^1793600000^{date}^https://evil.example/login|웹에서 승인&gt;",
    ],
    [
      "<!here> <!subteam^S1|@oncall>",
      "&lt;!here&gt; &lt;!subteam^S1|@oncall&gt;",
    ],
    ["<@U1> <#C1|general>", "&lt;@U1&gt; &lt;#C1|general&gt;"],
    [
      "<https://evil.example|웹에서 승인>",
      "웹에서 승인 (https://evil.example)",
    ],
    [
      "[웹에서 승인](https://evil.example)",
      "웹에서 승인 (https://evil.example)",
    ],
    [
      "<!date^1793600000^{date_short}|2026-11-02>",
      "<!date^1793600000^{date_short}|2026-11-02>",
    ],
    [
      "<!date^1793600000^{date}&#94;https://evil.example|x>",
      "<!date^1793600000^{date}&amp;#94;https://evil.example|x>",
    ],
  ])("a model's %s reaches Slack as %s", (text, posted) => {
    expect(slackOutboxText({ text })).toBe(posted);
  });

  test("lets through only the mentions the body names", () => {
    expect(
      slackOutboxText({
        text: "<@U1> <@U2> <!here>",
        mention_user_ids: ["U1"],
      }),
    ).toBe("<@U1> &lt;@U2&gt; &lt;!here&gt;");
  });

  test("drops a link Slack would read as more than a link", () => {
    expect(
      slackOutboxText({ text: "hi", link_url: "https://x.example/a|b>" }),
    ).toBe("hi");
    expect(slackOutboxText({ text: "hi", link_url: "" })).toBe("hi");
    expect(slackOutboxText({ text: "hi", link_url: "javascript:x" })).toBe(
      "hi",
    );
  });

  test("cuts to Slack's limit, never inside an escape or a surrogate pair", () => {
    const room = SLACK_TEXT_MAX - link.length;
    const url = "https://console.example/sessions/s1";
    const entity = slackOutboxText({
      text: `${"a".repeat(room - 3)}&&&&`,
      link_url: url,
    });
    expect(entity.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(entity).toEndWith(`aa…${link}`);

    const emoji = slackOutboxText({
      text: `${"a".repeat(room - 2)}😀😀`,
      link_url: url,
    });
    expect(emoji.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(emoji).toEndWith(`a…${link}`);
    // Throws on a lone surrogate.
    expect(() => encodeURIComponent(emoji)).not.toThrow();
  });

  test("a cut that leaves a code fence open escapes what the fence held", () => {
    const cut = slackOutboxText({
      text: `\`\`\`\n<!channel> <@U2> <@U1>\n${"a".repeat(SLACK_TEXT_MAX)}\n\`\`\``,
      mention_user_ids: ["U1"],
    });
    expect(cut.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(cut).toStartWith("```\n&lt;!channel&gt; &lt;@U2&gt; &lt;@U1&gt;\n");
    expect(cut).toEndWith("a…");
    // A fence still closed after the cut shows its control as written.
    expect(
      slackOutboxText({ text: `\`<!here>\` ${"b".repeat(SLACK_TEXT_MAX)}` }),
    ).toStartWith("`&lt;!here&gt;` b");
  });

  test("leaves text that fits alone", () => {
    const fits = "b".repeat(SLACK_TEXT_MAX);
    expect(slackOutboxText({ text: fits })).toBe(fits);
  });
});

test("one dedupe key per turn and kind", () => {
  expect(slackTurnDedupeKey("completed", "l1", 2)).toBe("reply:l1:2");
  expect(slackTurnDedupeKey("failed", "l1", 2)).toBe("failure:l1:2");
  // A budget refusal's row stands in for the failed turn's notice.
  expect(budgetRefusalTurnDedupeKey("l1", 2)).toBe(
    slackTurnDedupeKey("failed", "l1", 2),
  );
});

test("one dedupe key per request and thread, the request id last and whole", () => {
  expect(slackPromptDedupeKey("permission", "l1", "r:1")).toBe("prompt:l1:r:1");
  expect(slackPromptDedupeKey("question", "l1", "r2")).toBe("prompt:l1:r2");
  expect(slackPromptDedupeKey("push", "l1", "p1")).toBe("push:l1:p1");
});
