import { createHmac, timingSafeEqual } from "node:crypto";
import {
  SLACK_ACCEPTED_MESSAGE_SUBTYPES,
  SLACK_INBOUND_EVENT_TYPES,
  SLACK_SIGNATURE_WINDOW_SECONDS,
  type SlackEventCallback,
  type SlackInboundDropReason,
  type SlackInboundEventStatus,
  slackEventCallbackSchema,
  slackEventEnvelopeSchema,
  slackUrlVerificationSchema,
} from "@werft-ai/contracts";
import type { AgentIdentityStore } from "../ports/agent-identity-store.ts";
import type { SecretStore } from "../ports/secret-store.ts";
import type { SlackAppStore } from "../ports/slack-app-store.ts";
import type {
  SlackInboundEventInput,
  SlackInboundEventStore,
} from "../ports/slack-inbound-event-store.ts";
import type { SlackInstallStore } from "../ports/slack-install-store.ts";
import type { SurfaceBindingStore } from "../ports/surface-binding-store.ts";
import { agentForSlackEvent } from "./agent-identity-service.ts";
import { slackConversationKey } from "./slack-inbox.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounds how long another API replica keeps a deleted app's secret. */
export const SLACK_SIGNING_SECRET_TTL_MS = 60_000;

export type SlackSignatureCheck = "ok" | "bad_signature" | "stale";

/** Slack's `v0` request signature, then the timestamp window. */
export function verifySlackSignature(input: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: Uint8Array;
  nowSeconds: number;
}): SlackSignatureCheck {
  const { timestamp, signature } = input;
  if (
    timestamp === null ||
    signature === null ||
    !/^\d{1,12}$/.test(timestamp)
  ) {
    return "bad_signature";
  }
  const expected = Buffer.from(
    `v0=${createHmac("sha256", input.signingSecret)
      .update(`v0:${timestamp}:`)
      .update(input.rawBody)
      .digest("hex")}`,
  );
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return "bad_signature";
  }
  return Math.abs(input.nowSeconds - Number(timestamp)) >
    SLACK_SIGNATURE_WINDOW_SECONDS
    ? "stale"
    : "ok";
}

export type SlackEventsApp = {
  workspaceId: string;
  slackAppId: string;
  appId: string;
  signingSecret: string;
};

export type SlackSigningSecrets = ReturnType<typeof createSlackSigningSecrets>;

export function createSlackSigningSecrets(deps: {
  apps: Pick<SlackAppStore, "findAgentApp">;
  secrets: Pick<SecretStore, "get">;
  ttlMs?: number;
  now?: () => number;
}) {
  const ttlMs = deps.ttlMs ?? SLACK_SIGNING_SECRET_TTL_MS;
  const now = deps.now ?? (() => Date.now());
  const cached = new Map<string, { app: SlackEventsApp; until: number }>();

  return {
    async forAgent(agentId: string): Promise<SlackEventsApp | null> {
      const key = agentId.toLowerCase();
      const hit = cached.get(key);
      if (hit && hit.until > now()) return hit.app;
      cached.delete(key);
      const record = await deps.apps.findAgentApp(key);
      if (record === null || record.appId === null) return null;
      const signingSecret = await deps.secrets.get({
        workspaceId: record.workspaceId,
        owner: { kind: "slack_app", id: record.id },
        purpose: "slack_signing_secret",
      });
      if (signingSecret === null) return null;
      const app = {
        workspaceId: record.workspaceId,
        slackAppId: record.id,
        appId: record.appId,
        signingSecret,
      };
      cached.set(key, { app, until: now() + ttlMs });
      return app;
    },
    invalidate(agentId: string): void {
      cached.delete(agentId.toLowerCase());
    },
  };
}

export type SlackEventsOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_request" }
  | { kind: "challenge"; challenge: string }
  | {
      kind: "ack";
      result: "recorded" | "duplicate" | "ignored";
      eventId?: string;
      teamId?: string;
      status?: SlackInboundEventStatus;
      reason?: SlackInboundDropReason;
    };

type Classified =
  | { status: "dropped"; dropReason: SlackInboundDropReason }
  | {
      status: "received" | "processed";
      redact?: { botUserId: string; mention: boolean };
    };

const PENDING_EVENT_FIELDS = [
  "type",
  "user",
  "channel",
  "channel_type",
  "ts",
  "thread_ts",
  "event_ts",
] as const;

function redactedEvent(
  event: SlackEventCallback["event"],
  botUserId: string,
  mention: boolean,
): SlackEventCallback["event"] {
  const kept: Record<string, unknown> = {};
  for (const field of PENDING_EVENT_FIELDS) {
    if (event[field] !== undefined) kept[field] = event[field];
  }
  kept.text = mention ? `<@${botUserId}>` : "";
  return kept as SlackEventCallback["event"];
}

const ACCEPTED_TYPES = new Set<string>(SLACK_INBOUND_EVENT_TYPES);
const ACCEPTED_SUBTYPES = new Set<string>(SLACK_ACCEPTED_MESSAGE_SUBTYPES);

function hasBotTokens(event: SlackEventCallback["event"]): boolean {
  const tokens = event.tokens as { bot?: unknown } | undefined;
  return Array.isArray(tokens?.bot) && tokens.bot.length > 0;
}

export type SlackEventsService = ReturnType<typeof createSlackEventsService>;

export function createSlackEventsService(deps: {
  signingSecrets: Pick<SlackSigningSecrets, "forAgent">;
  inbox: SlackInboundEventStore;
  apps: Pick<SlackAppStore, "setEventsUnlessVerified">;
  identities: Pick<AgentIdentityStore, "resolveSlackEvent">;
  installs: Pick<SlackInstallStore, "revokeInstallation">;
  bindings: Pick<SurfaceBindingStore, "findLiveSlackChannel">;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function classify(
    agentId: string,
    app: SlackEventsApp,
    envelope: SlackEventCallback,
  ): Promise<Classified> {
    const { event } = envelope;
    if (envelope.api_app_id !== app.appId) {
      return { status: "dropped", dropReason: "app_mismatch" };
    }
    if (!ACCEPTED_TYPES.has(event.type)) {
      return { status: "dropped", dropReason: "unsupported_event" };
    }
    const key = { appId: envelope.api_app_id, teamId: envelope.team_id };
    if (event.type === "app_uninstalled" || event.type === "tokens_revoked") {
      if (event.type === "tokens_revoked" && !hasBotTokens(event)) {
        return { status: "dropped", dropReason: "user_tokens_only" };
      }
      const sentAt =
        envelope.event_time === undefined
          ? null
          : new Date(envelope.event_time * 1000);
      return (await deps.installs.revokeInstallation(key, sentAt)) ===
        "not_found"
        ? { status: "dropped", dropReason: "not_installed" }
        : { status: "processed" };
    }
    const resolved = await agentForSlackEvent(deps.identities, {
      ...key,
      agentId,
    });
    if (resolved.status === "dropped") {
      return { status: "dropped", dropReason: resolved.reason };
    }
    // member_joined_channel names the bot when it is invited; 94S-794
    // needs exactly that one, so the bot rules apply to messages only.
    if (event.type === "message" || event.type === "app_mention") {
      if (event.bot_id !== undefined) {
        return { status: "dropped", dropReason: "bot_message" };
      }
      if (event.user === resolved.botUserId) {
        return { status: "dropped", dropReason: "own_bot_user" };
      }
      if (
        event.type === "message" &&
        event.subtype !== undefined &&
        !ACCEPTED_SUBTYPES.has(event.subtype)
      ) {
        return { status: "dropped", dropReason: "message_subtype" };
      }
      if (typeof event.channel === "string" && event.channel_type !== "im") {
        const bound = await deps.bindings.findLiveSlackChannel(
          resolved.installationId,
          event.channel,
        );
        // A private channel without an approved, ready binding keeps no
        // text: waiting, rejected, or flipped from public since it was bound.
        const unapproved =
          bound?.status === "pending_approval" ||
          (event.channel_type === "group" &&
            !(
              bound?.status === "ready" &&
              bound.channelKind === "private_channel"
            )) ||
          // No binding to read the kind from, and the event does not say it
          // is a public channel (an app_mention carries no channel_type).
          (bound === null && event.channel_type !== "channel");
        if (unapproved) {
          const mentioned =
            event.type === "app_mention" ||
            (typeof event.text === "string" &&
              event.text.includes(`<@${resolved.botUserId}`));
          if (mentioned) {
            return {
              status: "received",
              redact: { botUserId: resolved.botUserId, mention: true },
            };
          }
          // Bound as public but private now: the handler still has to see
          // the event to demote the binding, with no text.
          return bound?.status === "ready"
            ? {
                status: "received",
                redact: { botUserId: resolved.botUserId, mention: false },
              }
            : { status: "dropped", dropReason: "channel_pending_approval" };
        }
      }
    }
    return { status: "received" };
  }

  return {
    async receive(request: {
      agentId: string;
      rawBody: Uint8Array;
      timestamp: string | null;
      signature: string | null;
    }): Promise<SlackEventsOutcome> {
      if (!UUID.test(request.agentId)) return { kind: "unauthorized" };
      const agentId = request.agentId.toLowerCase();
      const app = await deps.signingSecrets.forAgent(agentId);
      if (app === null) return { kind: "unauthorized" };
      const check = verifySlackSignature({
        signingSecret: app.signingSecret,
        timestamp: request.timestamp,
        signature: request.signature,
        rawBody: request.rawBody,
        nowSeconds: Math.floor(now().getTime() / 1000),
      });
      if (check !== "ok") return { kind: "unauthorized" };

      let body: unknown;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody),
        );
      } catch {
        return { kind: "bad_request" };
      }
      const parsed = slackEventEnvelopeSchema.safeParse(body);
      if (!parsed.success) return { kind: "bad_request" };
      const verification = slackUrlVerificationSchema.safeParse(parsed.data);
      const reached = () =>
        deps.apps.setEventsUnlessVerified(app.workspaceId, app.slackAppId, {
          state: "verified",
          checked_at: now().toISOString(),
        });
      if (verification.success) {
        await reached();
        return { kind: "challenge", challenge: verification.data.challenge };
      }
      if (parsed.data.type !== "event_callback") {
        return { kind: "ack", result: "ignored" };
      }
      // A malformed callback also matches the catch-all envelope member.
      const callback = slackEventCallbackSchema.safeParse(parsed.data);
      if (!callback.success) return { kind: "bad_request" };
      // Slack sends callbacks only to a verified URL, so the first one also
      // settles an app whose challenge was never seen here.
      await reached();
      const envelope: SlackEventCallback = callback.data;
      const ids = { eventId: envelope.event_id, teamId: envelope.team_id };
      if (await deps.inbox.seen(envelope.api_app_id, envelope.event_id)) {
        return { kind: "ack", result: "duplicate", ...ids };
      }

      const classified = await classify(agentId, app, envelope);
      const base = {
        workspaceId: app.workspaceId,
        agentId,
        slackAppId: app.slackAppId,
        teamId: envelope.team_id,
        appId: envelope.api_app_id,
        eventId: envelope.event_id,
        eventType: envelope.event.type,
        eventSubtype: envelope.event.subtype ?? null,
        eventTime:
          envelope.event_time === undefined
            ? null
            : new Date(envelope.event_time * 1000),
      };
      const { token: _token, ...unredacted } = envelope;
      const payload =
        classified.status !== "dropped" && classified.redact !== undefined
          ? {
              ...unredacted,
              event: redactedEvent(
                envelope.event,
                classified.redact.botUserId,
                classified.redact.mention,
              ),
            }
          : unredacted;
      const row: SlackInboundEventInput =
        classified.status === "dropped"
          ? { ...base, ...classified }
          : {
              ...base,
              status: classified.status,
              payload,
              conversationKey: slackConversationKey(
                app.slackAppId,
                envelope.event,
              ),
            };
      const result = await deps.inbox.record(row);
      return {
        kind: "ack",
        result,
        ...ids,
        status: classified.status,
        ...(classified.status === "dropped"
          ? { reason: classified.dropReason }
          : {}),
      };
    },
  };
}
