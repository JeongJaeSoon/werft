import { describe, expect, test } from "bun:test";
import type {
  ConversationId,
  ConversationInputId,
  ConversationTopicId,
} from "@werft-ai/contracts";
import type {
  ConversationInputStore,
  ResendMirrorRequest,
  TakeWebInputRequest,
  TakeWebInputResult,
} from "../ports/conversation-input-store.ts";
import type { ConversationKey } from "../ports/conversation-store.ts";
import {
  type ConversationPostGrant,
  createWebInputService,
  type ReceiveWebInput,
} from "./web-inputs.ts";

const allow: ConversationPostGrant = {
  action: "conversation.post",
  conversationId: "c1" as ConversationId,
  decision: { outcome: "allow", reason_code: "ok" },
};

function harness(options: {
  member?: boolean;
  taken?: TakeWebInputResult["outcome"];
  resent?: Awaited<ReturnType<ConversationInputStore["resendMirror"]>>;
}) {
  const keys: ConversationKey[] = [];
  const takes: TakeWebInputRequest[] = [];
  const resends: ResendMirrorRequest[] = [];
  const inputs: ConversationInputStore = {
    isMember: async () => options.member ?? true,
    resendMirror: async (request) => {
      resends.push(request);
      return options.resent ?? "enqueued";
    },
    takeWebInput: async (request) => {
      takes.push(request);
      const outcome = options.taken ?? "taken";
      if (outcome !== "taken" && outcome !== "replayed") return { outcome };
      return {
        outcome,
        receipt: {
          inputId: "00000000-0000-4000-8000-000000000001" as never,
          topicId:
            "00000000-0000-4000-8000-000000000002" as ConversationTopicId,
          seq: 1,
          requester: { kind: "user", id: request.requesterUserId },
          slackMirror: "not_target",
        },
      };
    },
  };
  const service = createWebInputService({
    conversations: {
      findOrCreateConversation: async (key) => {
        keys.push(key);
        return { ...key, id: "c1" as ConversationId };
      },
    },
    inputs,
  });
  return { service, keys, takes, resends };
}

const dmInput = (
  overrides: Partial<ReceiveWebInput> = {},
): ReceiveWebInput => ({
  grant: allow,
  workspaceId: "ws",
  agentId: "a1",
  requesterUserId: "u1",
  place: { kind: "dm" },
  topicId: null,
  clientMessageId: "msg-1",
  body: "hello",
  ...overrides,
});

describe("web input receipt", () => {
  test("takes nothing without an allowing conversation.post decision", async () => {
    for (const grant of [
      null,
      { ...allow, decision: { outcome: "deny", reason_code: "role" } },
      { ...allow, action: "session.submit" },
    ] as (ConversationPostGrant | null)[]) {
      const { service, takes, keys } = harness({});
      expect(await service.receive(dmInput({ grant }))).toEqual({
        outcome: "refused",
        reason: "not_allowed",
      });
      expect(takes).toEqual([]);
      expect(keys).toEqual([]);
    }
  });

  test("a decision on another conversation allows nothing here", async () => {
    const { service, takes } = harness({});
    expect(
      await service.receive(
        dmInput({
          grant: { ...allow, conversationId: "c2" as ConversationId },
        }),
      ),
    ).toEqual({ outcome: "refused", reason: "not_allowed" });
    expect(takes).toEqual([]);
  });

  test("refuses a malformed key or an empty text before anything else", async () => {
    const { service, takes } = harness({});
    for (const clientMessageId of ["", "a b", "x".repeat(129), "msg/1"]) {
      expect(await service.receive(dmInput({ clientMessageId }))).toEqual({
        outcome: "invalid",
        field: "client_message_id",
      });
    }
    expect(await service.receive(dmInput({ body: "" }))).toEqual({
      outcome: "invalid",
      field: "body",
    });
    expect(takes).toEqual([]);
  });

  test("a DM is the person's conversation; the request carries the server's requester", async () => {
    const { service, keys, takes } = harness({});
    expect(await service.receive(dmInput())).toMatchObject({
      outcome: "taken",
      receipt: { requester: { kind: "user", id: "u1" } },
    });
    expect(keys).toEqual([
      { kind: "dm", workspaceId: "ws", agentId: "a1", personUserId: "u1" },
    ]);
    expect(takes).toEqual([
      {
        workspaceId: "ws",
        agentId: "a1",
        requesterUserId: "u1",
        conversationId: "c1" as ConversationId,
        topicId: null,
        clientMessageId: "msg-1" as never,
        body: "hello",
      },
    ]);
  });

  test("a channel input is the channel's conversation", async () => {
    const { service, keys } = harness({});
    await service.receive(
      dmInput({ place: { kind: "channel", teamId: "T1", channelId: "C1" } }),
    );
    expect(keys).toEqual([
      {
        kind: "channel",
        workspaceId: "ws",
        agentId: "a1",
        teamId: "T1",
        channelId: "C1",
      },
    ]);
  });

  test("a non-member is refused before a conversation is made", async () => {
    const { service, keys, takes } = harness({ member: false });
    expect(await service.receive(dmInput())).toEqual({
      outcome: "refused",
      reason: "not_member",
    });
    expect(keys).toEqual([]);
    expect(takes).toEqual([]);
  });

  test("maps the store's outcomes", async () => {
    expect(
      await harness({ taken: "body_mismatch" }).service.receive(dmInput()),
    ).toEqual({ outcome: "conflict" });
    expect(
      await harness({ taken: "replayed" }).service.receive(dmInput()),
    ).toMatchObject({ outcome: "replayed" });
    for (const reason of [
      "not_member",
      "unlinked",
      "topic_not_found",
    ] as const) {
      expect(
        await harness({ taken: reason }).service.receive(dmInput()),
      ).toEqual({ outcome: "refused", reason });
    }
  });
});

describe("sending a web input's Slack mirror again", () => {
  const inputId = "00000000-0000-4000-8000-0000000000aa" as ConversationInputId;
  const resend = (grant: ConversationPostGrant | null) => ({
    grant,
    workspaceId: "ws",
    agentId: "a1",
    requesterUserId: "u1",
    inputId,
  });

  test("asks the store for the person's own input, in the conversation the grant was for", async () => {
    const { service, resends } = harness({});
    expect(await service.resendMirror(resend(allow))).toEqual({
      outcome: "enqueued",
    });
    expect(resends).toEqual([
      {
        workspaceId: "ws",
        agentId: "a1",
        requesterUserId: "u1",
        conversationId: "c1" as ConversationId,
        inputId,
      },
    ]);
  });

  test("sends nothing without an allowing conversation.post decision", async () => {
    for (const grant of [
      null,
      { ...allow, decision: { outcome: "deny", reason_code: "role" } },
      { ...allow, action: "session.submit" },
    ] as (ConversationPostGrant | null)[]) {
      const { service, resends } = harness({});
      expect(await service.resendMirror(resend(grant))).toEqual({
        outcome: "refused",
        reason: "not_allowed",
      });
      expect(resends).toEqual([]);
    }
  });

  test("an input not found, or not unconfirmed, says so", async () => {
    expect(
      await harness({ resent: "not_found" }).service.resendMirror(
        resend(allow),
      ),
    ).toEqual({ outcome: "refused", reason: "not_found" });
    expect(
      await harness({ resent: "not_unconfirmed" }).service.resendMirror(
        resend(allow),
      ),
    ).toEqual({ outcome: "not_unconfirmed" });
  });
});
