import { describe, expect, test } from "bun:test";
import {
  CHAT_ENVELOPE_VERSION,
  type ChatInboundEnvelope,
  type ChatOutboundEnvelopeInput,
  chatInboundEnvelopeSchema,
  chatOutboundEnvelopeSchema,
  muteDecisionSchema,
  type ScopedSessionBinding,
  scopedSessionBindingSchema,
} from "./envelope.ts";
import { formatSurfaceRef, sessionLinkSchema } from "./surfaces.ts";

const WORKSPACE_ID = "019a0000-0000-7000-8000-0000000000f1";
const INSTALLATION_ID = "019a0000-0000-7000-8000-0000000000f2";
const BINDING_ID = "019a0000-0000-7000-8000-0000000000f3";
const SESSION_ID = "019a0000-0000-7000-8000-0000000000f4";
const LINK_ID = "019a0000-0000-7000-8000-0000000000f5";
const AGENT_ID = "019a0000-0000-7000-8000-0000000000f6";
const AT = "2026-09-22T01:00:00Z";

const inbound: ChatInboundEnvelope = {
  version: 1,
  interfaceKind: "slack",
  installationId: INSTALLATION_ID,
  workspaceId: WORKSPACE_ID,
  eventId: "T01:A02:Ev03",
  occurredAt: AT,
  actor: { kind: "user", id: "T01:U04" },
  servicePrincipal: { kind: "service", id: INSTALLATION_ID },
  surfaceBindingId: BINDING_ID,
  conversationKey: "1758500000.0001",
  messageId: "1758500001.0002",
  trigger: "mention",
  text: "이번 주 지표 정리해줘",
  target: null,
  metadata: { channel_id: "C01" },
};

const scope: ScopedSessionBinding = {
  workspaceId: WORKSPACE_ID,
  ownerId: "owner_1",
  surfaceBindingId: BINDING_ID,
  bindingRevision: 2,
  sessionLinkId: LINK_ID,
  sessionId: SESSION_ID,
  agentId: AGENT_ID,
  releaseId: "rel_9f2c",
};

const outbound: ChatOutboundEnvelopeInput = {
  deliveryId: "dlv_1",
  sourceEventId: "T01:A02:Ev03",
  scope,
  actor: { kind: "service", id: INSTALLATION_ID },
  audience: {
    surfaceBindingId: BINDING_ID,
    policyRevision: 2,
    authorizedActorIds: ["T01:U04"],
  },
  category: "answer",
  content: { format: "markdown", text: "*정리 결과*" },
};

describe("ChatInboundEnvelope", () => {
  test("round-trips the 03b §3 field set and nothing else", () => {
    const parsed = chatInboundEnvelopeSchema.parse(inbound);
    expect(parsed).toEqual(inbound);
    expect(Object.keys(parsed)).toEqual([
      "version",
      "interfaceKind",
      "installationId",
      "workspaceId",
      "eventId",
      "occurredAt",
      "actor",
      "servicePrincipal",
      "surfaceBindingId",
      "conversationKey",
      "messageId",
      "trigger",
      "text",
      "target",
      "metadata",
    ]);
    expect(parsed.version).toBe(CHAT_ENVELOPE_VERSION);
  });

  test("an explicit target names a session, and target is never omitted", () => {
    expect(
      chatInboundEnvelopeSchema.parse({
        ...inbound,
        target: { sessionId: SESSION_ID },
      }).target,
    ).toEqual({ sessionId: SESSION_ID });
    const { target: _omitted, ...withoutTarget } = inbound;
    expect(chatInboundEnvelopeSchema.safeParse(withoutTarget).success).toBe(
      false,
    );
  });

  test("keeps only the documented triggers and refuses a bare channel post", () => {
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        trigger: "thread_reply",
      }).success,
    ).toBe(true);
    expect(
      chatInboundEnvelopeSchema.safeParse({ ...inbound, trigger: "ambient" })
        .success,
    ).toBe(false);
  });

  test("the human and the installation cannot be swapped", () => {
    // Grant matching treats the two differently, so an adapter that fills
    // them the wrong way round would hand the human service authority.
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        actor: inbound.servicePrincipal,
        servicePrincipal: inbound.actor,
      }).success,
    ).toBe(false);
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        actor: { kind: "service", id: "install_1" },
      }).success,
    ).toBe(false);
  });

  test("the service principal is the installation the event authenticated as", () => {
    // The binder matches grants on it, so an event authenticated for A must
    // not be able to ask for B's grants.
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        servicePrincipal: { kind: "service", id: "install_other" },
      }).success,
    ).toBe(false);
  });

  test("an adapter cannot smuggle authority in beside the actor", () => {
    expect(
      chatInboundEnvelopeSchema.safeParse({ ...inbound, ownerId: "owner_1" })
        .success,
    ).toBe(false);
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        scopes: ["sessions:write"],
      }).success,
    ).toBe(false);
  });

  test("applies the alpha message byte cap to surface text", () => {
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        text: "가".repeat(12_000),
      }).success,
    ).toBe(false);
  });

  test("a Slack timestamp stays a string", () => {
    const parsed = chatInboundEnvelopeSchema.parse(inbound);
    expect(parsed.conversationKey).toBe("1758500000.0001");
    expect(
      chatInboundEnvelopeSchema.safeParse({
        ...inbound,
        conversationKey: 1758500000.0001,
      }).success,
    ).toBe(false);
  });
});

describe("ScopedSessionBinding and ChatOutboundEnvelope", () => {
  test("a binding names the release the session is pinned to", () => {
    expect(scopedSessionBindingSchema.parse(scope)).toEqual(scope);
    const { releaseId: _omitted, ...withoutRelease } = scope;
    expect(scopedSessionBindingSchema.safeParse(withoutRelease).success).toBe(
      false,
    );
  });

  test("an outbound envelope carries the audience it was created against", () => {
    const parsed = chatOutboundEnvelopeSchema.parse(outbound);
    expect(parsed.audience.policyRevision).toBe(2);
    expect(parsed.scope.sessionLinkId).toBe(LINK_ID);
    expect(
      chatOutboundEnvelopeSchema.safeParse({
        ...outbound,
        content: { format: "html", text: "<b>x</b>" },
      }).success,
    ).toBe(false);
    expect(
      chatOutboundEnvelopeSchema.safeParse({ ...outbound, category: "debug" })
        .success,
    ).toBe(false);
  });

  test("the audience is captured on the binding the delivery is scoped to", () => {
    expect(chatOutboundEnvelopeSchema.safeParse(outbound).success).toBe(true);
    const mismatched = chatOutboundEnvelopeSchema.safeParse({
      ...outbound,
      audience: {
        ...outbound.audience,
        surfaceBindingId: "019a0000-0000-7000-8000-0000000000f7",
      },
    });
    expect(mismatched.success).toBe(false);
    expect(mismatched.error?.issues.map((issue) => issue.path)).toEqual([
      ["audience", "surfaceBindingId"],
    ]);
  });

  test("a delivery goes to the thread unless it says otherwise", () => {
    expect(chatOutboundEnvelopeSchema.parse(outbound).visibility).toBe(
      "thread",
    );
    expect(
      chatOutboundEnvelopeSchema.parse({ ...outbound, visibility: "thread" })
        .visibility,
    ).toBe("thread");
  });

  test("channel and requester-only deliveries are named but not supported yet", () => {
    for (const visibility of ["channel", "requester_only"]) {
      const result = chatOutboundEnvelopeSchema.safeParse({
        ...outbound,
        visibility,
      });
      expect(result.success).toBe(false);
      expect(
        result.error?.issues.map((issue) => [issue.path, issue.message]),
      ).toEqual([[["visibility"], "unsupported visibility"]]);
    }
    expect(
      chatOutboundEnvelopeSchema.safeParse({ ...outbound, visibility: "dm" })
        .success,
    ).toBe(false);
  });

  test("the surface ref a session link is keyed by is never null", () => {
    expect(formatSurfaceRef("C01", "1758500000.0001")).toBe(
      "C01:1758500000.0001",
    );
    const link = {
      id: LINK_ID,
      workspace_id: WORKSPACE_ID,
      owner_id: "owner_1",
      session_id: SESSION_ID,
      surface: "slack",
      installation_id: INSTALLATION_ID,
      surface_binding_id: BINDING_ID,
      surface_ref: formatSurfaceRef("C01", "1758500000.0001"),
      channel_id: "C01",
      thread_id: "1758500000.0001",
      agent_id: AGENT_ID,
      release_id: "rel_9f2c",
      role: "primary",
      visibility: "summary",
      muted: false,
      revision: 0,
      created_by: null,
      created_at: AT,
      revoked_at: null,
    };
    expect(sessionLinkSchema.parse(link).surface_ref).toBe(
      "C01:1758500000.0001",
    );
    expect(
      sessionLinkSchema.safeParse({ ...link, surface_ref: "" }).success,
    ).toBe(false);
    expect(
      sessionLinkSchema.safeParse({ ...link, role: "shadow" }).success,
    ).toBe(false);
  });
});

describe("MuteDecision", () => {
  test("separates sending, suppressing and deferring", () => {
    expect(muteDecisionSchema.parse({ action: "send" })).toEqual({
      action: "send",
    });
    expect(
      muteDecisionSchema.safeParse({
        action: "suppress",
        reason: "binding muted",
      }).success,
    ).toBe(true);
    expect(muteDecisionSchema.safeParse({ action: "suppress" }).success).toBe(
      false,
    );
    expect(
      muteDecisionSchema.safeParse({
        action: "defer",
        until: AT,
        reason: "rate limited",
      }).success,
    ).toBe(true);
    // `off` is admission, not output: it never reaches a mute decision.
    expect(muteDecisionSchema.safeParse({ action: "off" }).success).toBe(false);
  });
});
