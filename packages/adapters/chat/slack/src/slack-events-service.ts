import { timingSafeEqual } from "node:crypto";
import {
  SLACK_ACCEPTED_MESSAGE_SUBTYPES,
  SLACK_CHANNEL_CONVERSION_SUBTYPES,
  SLACK_INBOUND_EVENT_TYPES,
  SLACK_INPUT_MIRROR_EVENT_TYPE,
  SLACK_SIGNATURE_WINDOW_SECONDS,
  type SlackEventCallback,
  type SlackInboundDropFields,
  type SlackInboundDropReason,
  type SlackInboundEventStatus,
  slackEventCallbackSchema,
  slackEventEnvelopeSchema,
  slackMirrorCorrelationIdSchema,
  slackUrlVerificationSchema,
} from "@werft-ai/contracts";
import type {
  AgentIdentityStore,
  SecretStore,
  SurfaceAppStore,
  SurfaceInboundEventInput,
  SurfaceInboundEventStore,
  SurfaceOutboxStore,
} from "@werft-ai/platform";
import {
  agentForSlackEvent,
  type SurfaceBindingStore,
  type SurfaceInstallStore,
} from "@werft-ai/platform";
import {
  SLACK_PERSON_RESET_SUBTYPES,
  slackConversationKey,
} from "./slack-inbox.ts";
import { slackRequestSignature } from "./slack-signature.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * How long a verified event may take to be recorded before it is answered
 * 503 instead: under Slack's 3 seconds, so its retry is the one that lands.
 */
export const SLACK_EVENTS_ACK_DEADLINE_MS = 2_500;
/** Bounds how long another API replica keeps a deleted app's secret. */
export const SLACK_SIGNING_SECRET_TTL_MS = 60_000;

/**
 * A Slack message, as Slack names it inside one Werft workspace. Marks keep
 * only this and a time: never the message's text.
 */
export type SlackSourceMark = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  ts: string;
  /** When Slack says the message was deleted or last edited. */
  at: Date;
};

/**
 * Marks of Slack messages someone deleted or edited. A delete wins: it drops
 * the message's edit mark, and an edit after it leaves no mark.
 */
export interface SlackSourceMarkStore {
  /** `duplicate` when the message already has its delete mark. */
  markDeleted(mark: SlackSourceMark): Promise<"recorded" | "duplicate">;
  /**
   * Keeps the latest edit time of the message; `deleted` when it has a
   * delete mark, which leaves it unchanged. `body`, the edited text, only
   * replaces the text of the message held in the judgment buffer, when this
   * is its latest edit; it is kept nowhere else.
   */
  markEdited(
    mark: SlackSourceMark,
    body?: string,
  ): Promise<"recorded" | "deleted">;
}

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
    slackRequestSignature({
      signingSecret: input.signingSecret,
      timestamp,
      rawBody: input.rawBody,
    }),
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
  apps: Pick<SurfaceAppStore, "findAgentApp">;
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

export type SlackSignedRequest = {
  agentId: string;
  rawBody: Uint8Array;
  timestamp: string | null;
  signature: string | null;
};

/**
 * The agent a webhook request is for and its app, when the request carries a
 * valid signature by that app's secret; null otherwise.
 */
export async function verifySlackRequest(
  deps: { signingSecrets: Pick<SlackSigningSecrets, "forAgent"> },
  request: SlackSignedRequest,
  now: () => Date,
): Promise<{ agentId: string; app: SlackEventsApp } | null> {
  if (!UUID.test(request.agentId)) return null;
  const agentId = request.agentId.toLowerCase();
  const app = await deps.signingSecrets.forAgent(agentId);
  if (app === null) return null;
  const check = verifySlackSignature({
    signingSecret: app.signingSecret,
    timestamp: request.timestamp,
    signature: request.signature,
    rawBody: request.rawBody,
    nowSeconds: Math.floor(now().getTime() / 1000),
  });
  return check === "ok" ? { agentId, app } : null;
}

/** The store step a verified envelope is waiting on. */
export type SlackEventsStep =
  | "mark_received"
  | "mark_verified"
  | "seen"
  | "classify"
  | "mirror_echo"
  | "record";

/** Stops an envelope at its next step once `signal` aborts. */
export type SlackEventsRun = { signal: AbortSignal; step: SlackEventsStep };

export type SlackEventsOutcome =
  | { kind: "unauthorized" }
  | { kind: "bad_request" }
  /** Not recorded within the deadline; Slack's retry is told apart by event_id. */
  | {
      kind: "unavailable";
      step: SlackEventsStep;
      eventId?: string;
      teamId?: string;
    }
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
  // An edit or a delete: its mark is made, and nothing of the event is kept.
  | { status: "processed"; marked: true }
  | {
      status: "received" | "processed";
      redact?: { botUserId: string; mention: boolean };
    };

const PENDING_EVENT_FIELDS = [
  "type",
  "user",
  // A bot's mention must not read as a person's, who would restart the
  // bots' count in the thread.
  "bot_id",
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
  // The conversion handler reads which way the channel went.
  if (event.subtype !== undefined && CONVERSION_SUBTYPES.has(event.subtype)) {
    kept.subtype = event.subtype;
  }
  kept.text = mention ? `<@${botUserId}>` : "";
  return kept as SlackEventCallback["event"];
}

const ACCEPTED_TYPES = new Set<string>(SLACK_INBOUND_EVENT_TYPES);
const ACCEPTED_SUBTYPES = new Set<string>(SLACK_ACCEPTED_MESSAGE_SUBTYPES);
const CONVERSION_SUBTYPES = new Set<string>(SLACK_CHANNEL_CONVERSION_SUBTYPES);

/** Slackbot's user id in every workspace. */
const SLACKBOT_USER_ID = "USLACK";

function shortString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 64 ? value : undefined;
}

/** The poster's app: Slack names it on the event or in its `bot_profile`. */
function postingAppId(event: SlackEventCallback["event"]): string | undefined {
  const profile = event.bot_profile as { app_id?: unknown } | undefined;
  return shortString(event.app_id) ?? shortString(profile?.app_id);
}

function dropFields(
  event: SlackEventCallback["event"],
): SlackInboundDropFields {
  const fields: SlackInboundDropFields = {};
  const botId = shortString(event.bot_id);
  const appId = postingAppId(event);
  const user = shortString(event.user);
  const subtype = shortString(event.subtype);
  const inner = event.message as { subtype?: unknown } | undefined;
  const innerSubtype = shortString(inner?.subtype);
  if (botId !== undefined) fields.bot_id = botId;
  if (appId !== undefined) fields.app_id = appId;
  if (user !== undefined) fields.user = user;
  if (subtype !== undefined) fields.subtype = subtype;
  if (innerSubtype !== undefined) fields.message = { subtype: innerSubtype };
  const metadata = metadataOf(event);
  if (metadata !== undefined) fields.metadata = metadata;
  return fields;
}

/**
 * The message metadata's type, and a web input mirror's correlation id; the
 * rest of `event_payload` may carry text or people's values, and is not read.
 */
function metadataOf(
  event: SlackEventCallback["event"],
): SlackInboundDropFields["metadata"] {
  const metadata = event.metadata as
    | { event_type?: unknown; event_payload?: unknown }
    | undefined;
  const eventType = shortString(metadata?.event_type);
  if (eventType === undefined) return undefined;
  if (eventType !== SLACK_INPUT_MIRROR_EVENT_TYPE) {
    return { event_type: eventType };
  }
  const payload = metadata?.event_payload as
    | { correlation_id?: unknown }
    | undefined;
  const correlation = slackMirrorCorrelationIdSchema.safeParse(
    payload?.correlation_id,
  );
  return correlation.success
    ? { event_type: eventType, correlation_id: correlation.data }
    : { event_type: eventType };
}

const SLACK_TS = /^\d{1,12}\.\d{1,12}$/;

type SourceChange = {
  kind: "deleted" | "edited";
  channelId: string;
  ts: string;
  /** Slack's time of the delete (`event_ts`) or of the edit (`edited.ts`). */
  at: string | undefined;
  /** An edit's new text. */
  text?: string;
};

/**
 * The message an edit or a delete changed. A parent with replies becomes a
 * tombstone instead of being deleted; a `message_changed` without `edited`
 * (an unfurl, a reply count) is no one's edit and changes nothing here.
 */
function sourceChange(event: SlackEventCallback["event"]): SourceChange | null {
  if (event.type !== "message") return null;
  const tsOf = (value: unknown) =>
    typeof value === "string" && SLACK_TS.test(value) ? value : undefined;
  const channelId = shortString(event.channel);
  const previous = event.previous_message as { ts?: unknown } | undefined;
  let kind: SourceChange["kind"];
  let ts: string | undefined;
  let at: string | undefined;
  let text: string | undefined;
  if (event.subtype === "message_deleted") {
    at = tsOf(event.event_ts);
    kind = "deleted";
    ts = tsOf(event.deleted_ts) ?? tsOf(previous?.ts);
  } else if (event.subtype === "message_changed") {
    const inner = event.message as
      | {
          subtype?: unknown;
          edited?: { ts?: unknown } | null;
          ts?: unknown;
          text?: unknown;
        }
      | undefined;
    if (inner?.subtype === "tombstone") {
      kind = "deleted";
      at = tsOf(event.event_ts);
    } else if (typeof inner?.edited === "object" && inner.edited !== null) {
      kind = "edited";
      at = tsOf(inner.edited.ts);
      if (typeof inner.text === "string") text = inner.text;
    } else return null;
    ts = tsOf(inner.ts) ?? tsOf(previous?.ts);
  } else return null;
  return channelId === undefined || ts === undefined
    ? null
    : { kind, channelId, ts, at, ...(text === undefined ? {} : { text }) };
}

function hasBotTokens(event: SlackEventCallback["event"]): boolean {
  const tokens = event.tokens as { bot?: unknown } | undefined;
  return Array.isArray(tokens?.bot) && tokens.bot.length > 0;
}

/** An envelope's app, as a transport that proved the sender names it. */
export type SlackEventsAppRef = Omit<SlackEventsApp, "signingSecret">;

export type SlackVerifiedEnvelope = {
  agentId: string;
  app: SlackEventsAppRef;
  body: unknown;
};

function jsonOf(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(rawBody),
    );
  } catch {
    return undefined;
  }
}

/** What an unparsed body says it is, for the log of an unanswered event. */
function idsOf(body: unknown): { eventId?: string; teamId?: string } {
  const fields = body as { event_id?: unknown; team_id?: unknown } | undefined;
  const eventId = shortString(fields?.event_id);
  const teamId = shortString(fields?.team_id);
  return {
    ...(eventId === undefined ? {} : { eventId }),
    ...(teamId === undefined ? {} : { teamId }),
  };
}

export type SlackEventsService = ReturnType<typeof createSlackEventsService>;

export function createSlackEventsService(deps: {
  signingSecrets: Pick<SlackSigningSecrets, "forAgent">;
  inbox: SurfaceInboundEventStore;
  apps: Pick<SurfaceAppStore, "setEventsUnlessVerified" | "markEventsReceived">;
  identities: Pick<AgentIdentityStore, "resolveSlackEvent">;
  installs: Pick<SurfaceInstallStore, "revokeInstallation">;
  bindings: Pick<SurfaceBindingStore, "findLiveSlackChannel" | "wasRejected">;
  sourceMarks: SlackSourceMarkStore;
  /** Links an uncertain mirror to its post when Slack sends the post back. */
  mirrorEchoes: Pick<SurfaceOutboxStore, "matchMirrorEcho">;
  ackDeadlineMs?: number;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const ackDeadlineMs = deps.ackDeadlineMs ?? SLACK_EVENTS_ACK_DEADLINE_MS;

  // This app's own post that names a mirror's request: its ts is that
  // mirror's, if exactly one uncertain mirror has the id. Text never counts.
  async function matchMirrorEcho(
    app: SlackEventsAppRef,
    event: SlackEventCallback["event"],
  ) {
    const correlationId = metadataOf(event)?.correlation_id;
    const channel = shortString(event.channel);
    const ts = typeof event.ts === "string" ? event.ts : undefined;
    if (
      correlationId === undefined ||
      channel === undefined ||
      ts === undefined ||
      !SLACK_TS.test(ts) ||
      event.subtype === "message_changed" ||
      event.subtype === "message_deleted"
    ) {
      return;
    }
    await deps.mirrorEchoes.matchMirrorEcho({
      workspaceId: app.workspaceId,
      slackAppId: app.slackAppId,
      correlationId: slackMirrorCorrelationIdSchema.parse(correlationId),
      channelId: channel,
      ts,
    });
  }

  async function classify(
    agentId: string,
    app: SlackEventsAppRef,
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
    // Ahead of the bot rules: a bot's post is deleted or edited like a
    // person's, and the event names neither.
    const change = sourceChange(event);
    if (change !== null) {
      const mark = {
        workspaceId: app.workspaceId,
        teamId: envelope.team_id,
        channelId: change.channelId,
        ts: change.ts,
        at:
          change.at !== undefined
            ? new Date(Number(change.at) * 1000)
            : envelope.event_time === undefined
              ? now()
              : new Date(envelope.event_time * 1000),
      };
      await (change.kind === "deleted"
        ? deps.sourceMarks.markDeleted(mark)
        : deps.sourceMarks.markEdited(mark, change.text));
      return { status: "processed", marked: true };
    }
    // member_joined_channel names the bot when it is invited; the
    // member-joined handler needs exactly that one, so the bot rules apply
    // to messages only.
    if (event.type === "message" || event.type === "app_mention") {
      // This app's own posts come back as events; an instruction posted under
      // its sender's name carries no bot user, only the app. Judged before
      // the allow list, which may name other bots.
      if (
        event.user === resolved.botUserId ||
        postingAppId(event) === app.appId
      ) {
        return { status: "dropped", dropReason: "own_bot_user" };
      }
      // Another agent of this install is never heard over Slack, even when
      // a stale allow list still names its bot.
      if (
        typeof event.user === "string" &&
        resolved.werftBotUserIds.includes(event.user)
      ) {
        return { status: "dropped", dropReason: "werft_agent_bot" };
      }
      // Slackbot's notes (left a channel, reminders) are no one's request,
      // and an answer to its DM fails.
      if (event.user === SLACKBOT_USER_ID) {
        return { status: "dropped", dropReason: "slackbot" };
      }
      // Another bot is heard only when the agent allows it and it mentions
      // the agent directly, outside a DM.
      if (event.bot_id !== undefined) {
        if (resolved.allowedBotUserIds.length === 0) {
          return { status: "dropped", dropReason: "bot_allowlist_empty" };
        }
        if (
          typeof event.user === "string" &&
          !resolved.allowedBotUserIds.includes(event.user)
        ) {
          return { status: "dropped", dropReason: "bot_not_allowed" };
        }
        if (
          !(
            typeof event.user === "string" &&
            event.channel_type !== "im" &&
            (event.type === "app_mention" ||
              (typeof event.text === "string" &&
                new RegExp(`<@${resolved.botUserId}(?:\\||>)`).test(
                  event.text,
                )))
          )
        ) {
          return { status: "dropped", dropReason: "bot_message" };
        }
      }
      if (
        event.type === "message" &&
        event.subtype !== undefined &&
        !ACCEPTED_SUBTYPES.has(event.subtype) &&
        !CONVERSION_SUBTYPES.has(event.subtype) &&
        // A person's file or /me line in a thread starts the bots' count
        // there over.
        !(
          SLACK_PERSON_RESET_SUBTYPES.has(event.subtype) &&
          typeof event.thread_ts === "string" &&
          event.bot_id === undefined
        )
      ) {
        return { status: "dropped", dropReason: "message_subtype" };
      }
      if (typeof event.channel === "string" && event.channel_type !== "im") {
        const bound = await deps.bindings.findLiveSlackChannel(
          resolved.installationId,
          event.channel,
        );
        // The bot left this channel: whatever arrives (a late event, a
        // mention) takes no text and no answer, since the bot is not there.
        if (bound?.status === "left") {
          return { status: "dropped", dropReason: "channel_left" };
        }
        // Slack deleted this channel: nothing in it is taken or answered.
        if (bound?.status === "gone") {
          return { status: "dropped", dropReason: "channel_gone" };
        }
        // A conversion moves the channel's kind whatever its binding waits
        // for; its text is not kept.
        if (
          event.type === "message" &&
          event.subtype !== undefined &&
          CONVERSION_SUBTYPES.has(event.subtype)
        ) {
          return {
            status: "received",
            redact: { botUserId: resolved.botUserId, mention: false },
          };
        }
        // A private channel without an approved, ready binding keeps no
        // text: waiting, rejected, or flipped from public since it was bound.
        const unapproved =
          bound?.status === "pending_approval" ||
          (event.channel_type === "group" &&
            !(
              bound?.status === "ready" &&
              bound.channelKind === "private_channel"
            )) ||
          // An app_mention carries no channel_type, so a channel with no
          // live binding is told apart by what became of its last one.
          (bound === null &&
            event.channel_type !== "channel" &&
            (await deps.bindings.wasRejected(
              resolved.installationId,
              event.channel,
            )));
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

  /**
   * Handles an envelope whose sender is already proven: by the request
   * signature over HTTP, or by the connection a Socket Mode transport would
   * hold. `body` is the parsed JSON, undefined when it was not readable.
   */
  async function receiveEnvelope(
    verified: SlackVerifiedEnvelope,
    run?: SlackEventsRun,
  ): Promise<SlackEventsOutcome> {
    const { agentId, app, body } = verified;
    const next = (step: SlackEventsStep) => {
      run?.signal.throwIfAborted();
      if (run) run.step = step;
    };
    next("mark_received");
    // Before the body is read: only the sender's proof says Slack reached here.
    await deps.apps.markEventsReceived(app.workspaceId, app.slackAppId, now());

    const parsed = slackEventEnvelopeSchema.safeParse(body);
    if (!parsed.success) return { kind: "bad_request" };
    const verification = slackUrlVerificationSchema.safeParse(parsed.data);
    const reached = () =>
      deps.apps.setEventsUnlessVerified(app.workspaceId, app.slackAppId, {
        state: "verified",
        checked_at: now().toISOString(),
      });
    if (verification.success) {
      next("mark_verified");
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
    next("mark_verified");
    await reached();
    const envelope: SlackEventCallback = callback.data;
    const ids = { eventId: envelope.event_id, teamId: envelope.team_id };
    next("seen");
    if (await deps.inbox.seen(envelope.api_app_id, envelope.event_id)) {
      return { kind: "ack", result: "duplicate", ...ids };
    }

    next("classify");
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
      classified.status !== "dropped" &&
      "redact" in classified &&
      classified.redact !== undefined
        ? {
            ...unredacted,
            event: redactedEvent(
              envelope.event,
              classified.redact.botUserId,
              classified.redact.mention,
            ),
          }
        : unredacted;
    const row: SurfaceInboundEventInput =
      classified.status === "dropped"
        ? { ...base, ...classified, dropFields: dropFields(envelope.event) }
        : "marked" in classified
          ? {
              ...base,
              status: "processed",
              payload: null,
              conversationKey: null,
            }
          : {
              ...base,
              status: classified.status,
              payload,
              conversationKey: slackConversationKey(
                app.slackAppId,
                envelope.event,
              ),
            };
    // Before the record: a match that throws leaves the event to Slack's
    // retry, which a recorded event would answer as a duplicate.
    if (
      classified.status === "dropped" &&
      classified.dropReason === "own_bot_user"
    ) {
      next("mirror_echo");
      await matchMirrorEcho(app, envelope.event);
    }
    next("record");
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
  }

  /**
   * Runs the envelope, and past the deadline answers `unavailable` and stops
   * it at its next step. A record already sent may still commit; Slack's retry
   * then finds it by event_id, so the event is kept once.
   */
  async function withinAckDeadline(
    verified: SlackVerifiedEnvelope,
  ): Promise<SlackEventsOutcome> {
    const deadline = new AbortController();
    const run: SlackEventsRun = {
      signal: deadline.signal,
      step: "mark_received",
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((done) => {
      timer = setTimeout(() => {
        deadline.abort();
        done("late");
      }, ackDeadlineMs);
    });
    const work = receiveEnvelope(verified, run);
    try {
      const first = await Promise.race([work, late]);
      if (first !== "late") return first;
    } finally {
      clearTimeout(timer);
    }
    // Its failure, an abort or the slow store's, is Slack's retry to repair.
    work.catch(() => {});
    return { kind: "unavailable", step: run.step, ...idsOf(verified.body) };
  }

  return {
    receiveEnvelope,
    async receive(request: SlackSignedRequest): Promise<SlackEventsOutcome> {
      const verified = await verifySlackRequest(deps, request, now);
      if (verified === null) return { kind: "unauthorized" };
      const { signingSecret: _, ...app } = verified.app;
      return withinAckDeadline({
        agentId: verified.agentId,
        app,
        body: jsonOf(request.rawBody),
      });
    },
  };
}
