import { describe, expect, test } from "bun:test";
import {
  SURFACE_OUTBOX_KIND_VALUES,
  type SurfaceAiLabel,
  type SurfaceCardClaim,
  type SurfaceCardSettleStore,
  type SurfaceOutboxClaim,
  type SurfaceOutboxKind,
} from "@werft-ai/platform";
import { createRowDelivery } from "./outbox-delivery.ts";
import { slackAiLabelBlock } from "./slack-ai-label.ts";
import { settleSlackCards } from "./slack-card-settle.ts";
import type { SlackBotSender, SlackSendResponse } from "./slack-config-api.ts";
import { SLACK_TEXT_MAX } from "./slack-outbox-render.ts";

// v1-b/G2: every post under the agent's name ends with the AI line while its
// conversation rollout is `on`, and is as before while it is not.

// Whether each kind carries the line; a kind missing here fails the test.
const LINE: Partial<Record<SurfaceOutboxKind, boolean>> = {
  reply: true,
  notice: true,
  failure_notice: true,
  input_notice: true,
  welcome: true,
  action_notice: true,
  model_notice: true,
  channel_notice: true,
  progress: true,
  conversation_reply: true,
  emergency_stop_notice: true,
  // A person's own words under their name.
  instruction: false,
  input_mirror: false,
  // No post.
  reaction: false,
};

const CARD_BLOCKS = [
  { type: "section", text: { type: "mrkdwn", text: "Approve the push?" } },
];

const row = (
  kind: SurfaceOutboxKind,
  over: Partial<SurfaceOutboxClaim> = {},
): SurfaceOutboxClaim => ({
  id: `row-${kind}`,
  claimToken: "claim",
  attempts: 1,
  workspaceId: "ws-1",
  agentId: "agent-1",
  slackAppId: "slack-app-1",
  installationId: "installation-1",
  kind,
  channelId: "C0ROOM1",
  threadTs: "1700000000.000100",
  slackUserId: kind === "notice" ? "U0A" : null,
  sessionId: "session-1",
  sessionLinkId: "link-1",
  body: {
    text: "Done.",
    locale: "ko",
    ...(kind === "input_notice" ? { blocks: CARD_BLOCKS } : {}),
    ...(kind === "instruction" || kind === "input_mirror"
      ? { sender: { username: "Ada (web)" } }
      : {}),
  },
  dedupeKey: `${kind}:1`,
  ...over,
});

type Sent = {
  method: "post" | "ephemeral" | "edit" | "reaction";
  text?: string;
  blocks?: unknown[];
};

const OK: SlackSendResponse = {
  httpStatus: 200,
  retryAfterHeader: null,
  body: { ok: true, ts: "1700000000.000200" },
};

async function deliver(
  claim: SurfaceOutboxClaim,
  aiLabel: SurfaceAiLabel | undefined,
  options: {
    refuseBlocks?: boolean;
    progress?: { ts: string; reposted: boolean };
  } = {},
) {
  const sent: Sent[] = [];
  let refused = options.refuseBlocks === true;
  const send =
    (method: Sent["method"]) => async (_token: string, input: object) => {
      sent.push({ method, ...(input as Omit<Sent, "method">) });
      if (!refused || !("blocks" in input)) return OK;
      refused = false;
      return { ...OK, body: { ok: false, error: "invalid_blocks" } };
    };
  const delivery = createRowDelivery({
    slack: {
      postMessage: send("post") as SlackBotSender["postMessage"],
      postEphemeral: send("ephemeral") as SlackBotSender["postEphemeral"],
      editMessage: send("edit") as NonNullable<SlackBotSender["editMessage"]>,
      addReaction: send("reaction") as NonNullable<
        SlackBotSender["addReaction"]
      >,
      userImage: async () => null,
    },
    botToken: async () => "bot",
    consoleOrigin: "https://console.example",
  });
  const outcome = await delivery.direct({
    row: claim,
    attempts: 1,
    begin: async () => ({
      agentName: "Notes Agent",
      taskTitle: null,
      ...(aiLabel === undefined ? {} : { aiLabel }),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
    }),
  });
  expect(outcome.kind).toBe("sent");
  return sent;
}

const ADA: SurfaceAiLabel = { requestedBy: "Ada" };

describe("the AI line on outbox rows", () => {
  for (const kind of SURFACE_OUTBOX_KIND_VALUES) {
    test(`${kind} under rollout on`, async () => {
      const labelled = LINE[kind];
      if (labelled === undefined) throw new Error(`decide the line of ${kind}`);
      const [sent] = await deliver(row(kind), ADA);
      if (!labelled) {
        expect(JSON.stringify(sent)).not.toContain("Werft");
        return;
      }
      // A conversation's answer carries its own name, none on this row.
      const name = kind === "conversation_reply" ? undefined : "Ada";
      expect(sent?.blocks?.at(-1)).toEqual(slackAiLabelBlock("ko", name));
      // A model notice's words hold its session link.
      expect(sent?.text).toStartWith("Done.");
      expect(sent?.text).toEndWith("\n\nAI 에이전트 · Werft");
      expect(sent?.method).toBe(kind === "notice" ? "ephemeral" : "post");
    });
  }

  // The answer of a conversation turn only exists under `on`.
  for (const kind of SURFACE_OUTBOX_KIND_VALUES.filter(
    (value) => value !== "conversation_reply",
  )) {
    test(`${kind} while the rollout is off or shadow goes as before`, async () => {
      const [sent] = await deliver(row(kind), undefined);
      expect(JSON.stringify(sent)).not.toContain("Werft");
      // Only a card has blocks of its own.
      expect(sent?.blocks).toEqual(
        kind === "input_notice" ? CARD_BLOCKS : undefined,
      );
    });
  }

  test("a row with no requester has the AI line alone, never a mention", async () => {
    const [sent] = await deliver(
      row("reply", { body: { text: "Done.", mention_user_ids: ["U0A"] } }),
      { requestedBy: null },
    );
    const line = sent?.blocks?.at(-1);
    expect(line).toEqual(slackAiLabelBlock(undefined));
    expect(JSON.stringify(line)).not.toContain("<@");
  });

  test("a model notice keeps its session link beside the line", async () => {
    const [sent] = await deliver(row("model_notice"), ADA);
    expect(JSON.stringify(sent?.blocks)).toContain(
      "https://console.example/sessions/session-1",
    );
  });

  test("a reply cut to Slack's limit keeps the line whole", async () => {
    const [sent] = await deliver(
      row("reply", { body: { text: "&".repeat(16_000), locale: "en" } }),
      ADA,
    );
    expect(sent?.text?.length).toBeLessThanOrEqual(SLACK_TEXT_MAX);
    expect(sent?.text).toEndWith("…\n\nAI agent · Werft");
  });

  const sections = async (text: string) => {
    const [sent] = await deliver(row("reply", { body: { text } }), ADA);
    const blocks = (sent?.blocks ?? []) as {
      type: string;
      text?: { text: string; verbatim?: boolean };
    }[];
    expect<unknown>(blocks.at(-1)).toEqual(slackAiLabelBlock(undefined, "Ada"));
    return blocks.slice(0, -1).map((block) => {
      expect(block.text?.verbatim).toBe(true);
      expect(block.text?.text.length).toBeLessThanOrEqual(3_000);
      return block.text?.text ?? "";
    });
  };

  test("text becomes sections Slack links no name in, bare URLs still links", async () => {
    expect(
      await sections(
        "#general @ada see https://example.com/a?x=1&y=2, `https://c.example`",
      ),
    ).toEqual([
      "#general @ada see <https://example.com/a?x=1&amp;y=2>, `https://c.example`",
    ]);
  });

  test("a line too long for one section is cut and keeps the line", async () => {
    const words = "word ".repeat(1_500).trim();
    const pieces = await sections(words);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(" ")).toBe(words);

    const solid = `${"x".repeat(2_990)}&${"🚀".repeat(2_000)}`;
    const cut = await sections(solid);
    expect(cut.join("")).toBe(solid.replace("&", "&amp;"));
  });

  test("a code fence cut across sections is closed and opened again", async () => {
    const pieces = await sections(
      `\`\`\`\n${`${"y".repeat(99)}\n`.repeat(60)}\`\`\``,
    );
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.split("```")).toHaveLength(3);
    }
  });

  test("a forced cut drops no character of code", async () => {
    const code = `\`\`\`\n${"a".repeat(2_992)}\tKEEP\n\`\`\``;
    const pieces = await sections(code);
    expect(
      pieces.map((piece) => piece.replaceAll("```", "")).join(""),
    ).toContain("\tKEEP");
  });

  test("a space where code is cut stays the code's", async () => {
    for (const [open, close] of [
      ["```\n", "\n```"],
      ["`", "`"],
    ] as const) {
      const body = `const value = "${"a ".repeat(2_000)} KEEP"`;
      const pieces = await sections(`${open}${body}${close}`);
      expect(pieces.length).toBeGreaterThan(1);
      const kept = pieces.map((piece) =>
        piece.slice(open.length, -close.length),
      );
      expect(kept.join("")).toBe(body);
    }
  });

  test("inline code goes whole to the next section, or is closed across", async () => {
    const span = `\`printf *danger* ${"x".repeat(30)}\``;
    const moved = await sections(`${"a ".repeat(1_489)}${span} end`);
    expect(moved[1]).toStartWith(span);

    const long = await sections(`\`${"z ".repeat(2_000)}\``);
    expect(long.length).toBeGreaterThan(1);
    for (const piece of long) expect(piece.split("`")).toHaveLength(3);
  });

  test("a URL keeps the escapes it ends in, and stops at a bracket", async () => {
    expect(
      await sections("https://example.com/?a=1&. <https://b.example"),
    ).toEqual(["<https://example.com/?a=1&amp;>. &lt;<https://b.example>"]);
  });

  for (const kind of ["failure_notice", "notice"] as const) {
    test(`${kind}: refused blocks go again as text that keeps the line`, async () => {
      const sent = await deliver(row(kind), ADA, { refuseBlocks: true });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.blocks).toBeUndefined();
      expect(sent[1]?.text).toBe("Done.\n\nAI 에이전트 · Werft");
    });
  }

  test("a progress edit keeps the line, as blocks or as text when refused", async () => {
    const progress = { ts: "1700000000.000200", reposted: false };
    const claim = row("progress", { progressKey: "build" });
    const [edit] = await deliver(claim, ADA, { progress });
    expect(edit?.method).toBe("edit");
    expect(edit?.blocks?.at(-1)).toEqual(slackAiLabelBlock("ko", "Ada"));

    const again = await deliver(claim, ADA, { progress, refuseBlocks: true });
    expect(again.map((call) => call.method)).toEqual(["edit", "edit"]);
    expect(again[1]?.blocks).toEqual([]);
    expect(again[1]?.text).toEndWith("AI 에이전트 · Werft");
  });
});

describe("a redrawn card", () => {
  async function redraw(aiLabel: SurfaceAiLabel | undefined) {
    const claim: SurfaceCardClaim = {
      id: "card-1",
      claimToken: "claim",
      workspaceId: "ws-1",
      slackAppId: "slack-app-1",
      sessionId: "session-1",
      channelId: "C0ROOM1",
      slackTs: "1700000000.000200",
      // A turn's notice from before the cards, still waiting.
      dedupeKey: "input:link-1:1",
      body: { text: "Approve?", blocks: CARD_BLOCKS, locale: "en" },
      rendered: null,
      uncertainRev: 0,
      uncertain: false,
      inherited: false,
      attempts: 0,
      ...(aiLabel === undefined ? {} : { aiLabel }),
    };
    let claims = 0;
    const store = {
      expireInflight: async () => 0,
      markDue: async () => 0,
      claim: async () => (claims++ === 0 ? [claim] : []),
      turnWaits: async () => true,
      beginSend: async () => new Date(),
      finish: async () => true,
    } as Partial<SurfaceCardSettleStore> as SurfaceCardSettleStore;
    const sent: { text: string; blocks: unknown[] }[] = [];
    await settleSlackCards({
      store,
      slack: {
        updateMessage: async (_token, input) => void sent.push(input),
      },
      botToken: async () => "bot",
      logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
      batchSize: 20,
      deadline: Date.now() + 60_000,
    });
    return sent[0];
  }

  test("ends with the AI line under rollout on", async () => {
    const card = await redraw(ADA);
    expect(card?.blocks).toEqual([
      ...CARD_BLOCKS,
      slackAiLabelBlock("en", "Ada"),
    ]);
    expect(card?.text).toBe("Approve?\n\nAI agent · Werft");
  });

  test("is as before while the rollout is off or shadow", async () => {
    const card = await redraw(undefined);
    expect(card).toMatchObject({ text: "Approve?", blocks: CARD_BLOCKS });
  });
});
