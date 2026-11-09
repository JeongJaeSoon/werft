import type { SurfaceMembership } from "@werft-ai/contracts";
import { z } from "zod";
import type { AgentIdentityStore } from "../ports/agent-identity-store.ts";
import type { SlackInboundClaim } from "../ports/slack-inbound-event-store.ts";
import type {
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "../ports/surface-binding-store.ts";
import { agentForSlackEvent } from "./agent-identity-service.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import type { SlackInboundHandler } from "./slack-inbox.ts";
import type { SlackWelcome } from "./slack-welcome.ts";

// Slack refusing the token or the app, not saying the bot is out: the
// console shows these apart from a missing invite.
const CONFIG_ERRORS = new Set([
  "missing_scope",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "no_permission",
  "not_allowed_token_type",
  "ekm_access_denied",
]);

const JOINED: SurfaceMembership = { state: "joined", error: null };

function refused(
  error: unknown,
  otherwise: "awaiting_invite" | "join_failed",
): SurfaceMembership | null {
  // No answer, or a rate limit: nothing is known, so nothing is recorded.
  if (
    !(error instanceof SlackApiError) ||
    !error.answered ||
    error.code === "ratelimited"
  ) {
    return null;
  }
  if (CONFIG_ERRORS.has(error.code)) {
    return { state: "config_error", error: error.code };
  }
  return { state: otherwise, error: error.code };
}

/**
 * Asks Slack whether the bot is in the channel and joins it when it is
 * public. A private channel waits for an invite (`member_joined_channel`).
 * Null when Slack could not be asked; joining twice is harmless.
 */
export async function joinSlackChannel(
  slack: Pick<SlackBotApi, "channelMembership" | "joinChannel">,
  botToken: string,
  channelId: string,
): Promise<SurfaceMembership | null> {
  let seen: Awaited<ReturnType<SlackBotApi["channelMembership"]>>;
  try {
    seen = await slack.channelMembership(botToken, channelId);
  } catch (error) {
    // A private channel the bot is not in is one it cannot see.
    return refused(error, "awaiting_invite");
  }
  if (seen.isArchived) return { state: "join_failed", error: "is_archived" };
  if (seen.isMember) return JOINED;
  if (seen.kind !== "public_channel") {
    return { state: "awaiting_invite", error: null };
  }
  try {
    await slack.joinChannel(botToken, channelId);
  } catch (error) {
    return refused(error, "join_failed");
  }
  return JOINED;
}

const memberJoinedSchema = z.object({
  type: z.literal("member_joined_channel"),
  user: z.string().min(1),
  channel: z.string().min(1),
});

/**
 * The `slack` role's handler for `member_joined_channel`: when the one who
 * joined is this app's bot, the channel is bound if it was not (an invite
 * is how a person adds the agent to a channel), the binding is `joined`,
 * and a home hears the welcome it was waiting for. Every other event goes
 * to `next`.
 */
export function createSlackMemberJoinedHandler(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  bindings: Pick<
    SurfaceBindingStore,
    | "ensureInvitedChannel"
    | "observeLifecycle"
    | "recordJoin"
    | "requireApproval"
  >;
  welcome: Pick<SlackWelcome, "welcome">;
  slack: Pick<SlackBotApi, "channelKind">;
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  return async (claim) => {
    const parsed = memberJoinedSchema.safeParse(
      (claim.payload as { event?: unknown }).event,
    );
    if (!parsed.success) return deps.next(claim);
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped" || parsed.data.user !== agent.botUserId) {
      return;
    }
    const { channel } = parsed.data;
    // A join that a later leave already overtook must not revive the channel.
    if (
      !(await deps.bindings.observeLifecycle(
        agent.installationId,
        channel,
        lifecycleTime(claim),
      ))
    ) {
      return;
    }
    const botToken = await deps.botToken(claim.workspaceId, claim.slackAppId);
    if (botToken === null) {
      throw new Error("The Slack app has no bot token stored");
    }
    const kind = await deps.slack.channelKind(botToken, channel);
    if (kind === "dm") return;
    let binding = await deps.bindings.ensureInvitedChannel(
      agent.installationId,
      channel,
      kind,
    );
    if (
      binding === null ||
      (binding.status !== "ready" && binding.status !== "pending_approval")
    ) {
      return;
    }
    if (
      binding.status === "ready" &&
      binding.channelKind === "public_channel" &&
      kind === "private_channel"
    ) {
      binding = (await deps.bindings.requireApproval(binding.id)) ?? binding;
    }
    const at = lifecycleTime(claim);
    // A leave noted since the check above wins: no membership, no welcome.
    const recorded = await deps.bindings.recordJoin(
      agent.installationId,
      channel,
      binding.id,
      at,
    );
    if (!recorded) return;
    if (binding.home && binding.status === "ready") {
      await deps.welcome.welcome(binding.workspaceId, binding.agentId, {
        ask: false,
      });
    }
  };
}

const memberLeftSchema = z.object({
  type: z.literal("member_left_channel"),
  user: z.string().min(1),
  channel: z.string().min(1),
});

// join and leave events carry no `ts`; `event_ts` ("<seconds>.<micros>") is
// the time Slack stamped them, and the envelope's time is the fallback. An
// integer of microseconds, since a Date would tie two events in one ms.
function lifecycleTime(claim: SlackInboundClaim): number | null {
  const stamp = (claim.payload.event as { event_ts?: unknown } | undefined)
    ?.event_ts;
  const parts =
    typeof stamp === "string"
      ? /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(stamp)
      : null;
  if (parts) {
    const us =
      Number(parts[1]) * 1_000_000 + Number((parts[2] ?? "").padEnd(6, "0"));
    // Past 2^53 two stamps would collapse into one number and mis-order.
    if (Number.isSafeInteger(us)) return us;
  }
  return claim.eventTime === null ? null : claim.eventTime.getTime() * 1000;
}

/**
 * The `slack` role's handler for `member_left_channel`: when the one who
 * left is this app's bot (it was removed, or left), a private channel's
 * binding waits for approval again, so a later invite does not bring back
 * the old approval. Every other event goes to `next`.
 */
export function createSlackMemberLeftHandler(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  bindings: Pick<SurfaceBindingStore, "botLeft">;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  return async (claim) => {
    const parsed = memberLeftSchema.safeParse(
      (claim.payload as { event?: unknown }).event,
    );
    if (!parsed.success) return deps.next(claim);
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped" || parsed.data.user !== agent.botUserId) {
      return;
    }
    await deps.bindings.botLeft(
      agent.installationId,
      parsed.data.channel,
      lifecycleTime(claim),
    );
  };
}

export type SlackChannelJoiner = (
  binding: SurfaceBindingRecord,
) => Promise<SurfaceMembership | null>;

/**
 * Joins a live channel binding's channel and records what Slack said on
 * the binding. Null, and nothing recorded, for the DM row, a binding that
 * is off, an app with no bot token, or a Slack that did not answer.
 */
export function createSlackChannelJoiner(deps: {
  bindings: Pick<SurfaceBindingStore, "setMembership">;
  slack: Pick<SlackBotApi, "channelMembership" | "joinChannel">;
  botToken(workspaceId: string, agentId: string): Promise<string | null>;
}): SlackChannelJoiner {
  return async (binding) => {
    if (binding.channelId === null || binding.mode === "off") return null;
    const botToken = await deps.botToken(binding.workspaceId, binding.agentId);
    if (botToken === null) return null;
    const membership = await joinSlackChannel(
      deps.slack,
      botToken,
      binding.channelId,
    );
    if (
      membership !== null &&
      (binding.membership?.state !== membership.state ||
        binding.membership.error !== membership.error)
    ) {
      await deps.bindings.setMembership(
        binding.id,
        membership,
        binding.membership,
      );
    }
    return membership;
  };
}
