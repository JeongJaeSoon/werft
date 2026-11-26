import {
  SLACK_CHANNEL_MEMBER_LIMIT,
  SLACK_MEMBER_CACHE_TTL_MS,
} from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  agentForSlackEvent,
  type ChannelMemberCheckable,
  type ChannelMemberQuestion,
  type ChannelMemberStore,
  type ChannelMembership,
  type SurfaceCardSettleStore,
} from "@werft-ai/platform";
import { z } from "zod";
import { SLACK_CARD_SETTLE_TIMING } from "./slack-card-settle.ts";
import { lifecycleChannelOf } from "./slack-channel-lifecycle.ts";
import {
  SLACK_CHANNEL_PAGE_SIZE,
  SlackApiError,
  type SlackChannelMemberApi,
  SlackRateLimitedError,
} from "./slack-config-api.ts";
import type { SlackInboundHandler, SlackInboxLogger } from "./slack-inbox.ts";

const PAGE_LIMIT = Math.ceil(
  SLACK_CHANNEL_MEMBER_LIMIT / SLACK_CHANNEL_PAGE_SIZE,
);

/** Why a member check answered false without knowing; logged, never shown. */
export type SlackMemberCheckUnconfirmed =
  | "no_slack_link"
  | "no_bot_token"
  | "rate_limited"
  | "slack_error"
  | "slack_unanswered"
  | "too_many_members"
  | "overtaken"
  | "failed";

/** A Slack account asked about directly, in a given install of the agent. */
export type SlackMemberQuestion = Omit<ChannelMemberQuestion, "userId"> & {
  installationId: string;
  slackUserId: string;
};

export type SlackChannelMembers = ChannelMemberCheckable & {
  /**
   * membership for one Slack account rather than a Werft user: what a
   * message addressed to that account would reach.
   */
  slackMembership(input: SlackMemberQuestion): Promise<ChannelMembership>;
  /** Reads the channel's list again in the background: a member event. */
  refill(ref: SlackChannelRef): void;
  /** Settles once no background read is waiting or running. */
  idle(): Promise<void>;
};

function unconfirmedOf(error: unknown): SlackMemberCheckUnconfirmed {
  if (error instanceof SlackRateLimitedError) return "rate_limited";
  if (error instanceof SlackApiError) {
    return error.answered ? "slack_error" : "slack_unanswered";
  }
  return "failed";
}

/** One channel's list in one install of the agent. */
export type SlackChannelRef = {
  workspaceId: string;
  agentId: string;
  installationId: string;
  channelId: string;
};

// Lists read from Slack in the background at once, and the most waiting or
// running: a read past that is dropped, and the next question asks again.
const FILLS_AT_ONCE = 8;
const FILLS_HELD_MAX = 64;
// A list this close to its TTL still answers and is read again behind it.
const REFRESH_AHEAD_MS = 60_000;
// A channel whose background read could not tell is answered unconfirmed
// for this long rather than pending, so a list does not wait on it forever.
const FILL_FAILED_HOLD_MS = 60_000;
// The most channels held at once; past it the oldest hold goes first, and
// that channel is only read again sooner.
const FILLS_FAILED_HELD_MAX = 1_024;

/**
 * The member check over Slack's `conversations.members`, one list per
 * channel of an install, cached `SLACK_MEMBER_CACHE_TTL_MS`. Every page is
 * read before the list is kept: a list cut short would hide real members.
 * `cachedMembership` never waits on Slack: what it does not find is read in
 * the background in this process, at most `FILLS_AT_ONCE` at once.
 */
export function createSlackChannelMembers(deps: {
  store: ChannelMemberStore;
  slack: SlackChannelMemberApi;
  botToken(workspaceId: string, agentId: string): Promise<string | null>;
  logger: Pick<SlackInboxLogger, "warn">;
  /**
   * A failure of Werft's own store, rethrown rather than read as
   * unconfirmed, so the policy answers it undecided.
   */
  storageUnavailable?: (error: unknown) => boolean;
  now?: () => number;
}): SlackChannelMembers {
  const now = deps.now ?? Date.now;
  const warnUnconfirmed = (
    ref: Omit<SlackChannelRef, "installationId">,
    reason: SlackMemberCheckUnconfirmed,
    error?: unknown,
  ) => {
    deps.logger.warn("Slack channel members unconfirmed; not a member", {
      event: "slack.member_check.unconfirmed",
      reason,
      workspace_id: ref.workspaceId,
      agent_id: ref.agentId,
      channel_id: ref.channelId,
      ...(error instanceof SlackApiError ? { slack_error: error.code } : {}),
    });
  };

  // The whole list from Slack, kept for a read that began at `checkedAt`;
  // or why it is not known.
  async function readList(
    ref: SlackChannelRef,
    checkedAt: Date,
  ): Promise<ReadonlySet<string> | SlackMemberCheckUnconfirmed> {
    const botToken = await deps.botToken(ref.workspaceId, ref.agentId);
    if (botToken === null) return "no_bot_token";
    const members = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page += 1) {
      if (page === PAGE_LIMIT) return "too_many_members";
      const answer = await deps.slack.channelMembers(botToken, {
        channelId: ref.channelId,
        cursor,
      });
      for (const id of answer.memberIds) members.add(id);
      if (members.size > SLACK_CHANNEL_MEMBER_LIMIT) return "too_many_members";
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    // A list the store refused was overtaken (a member event, a revoke):
    // it answers nothing, and the next question reads again.
    if (
      !(await deps.store.remember(
        ref.installationId,
        ref.channelId,
        [...members],
        checkedAt,
      ))
    ) {
      return "overtaken";
    }
    return members;
  }

  async function subjectOf(
    input: ChannelMemberQuestion,
  ): Promise<{ installationId: string; slackUserId: string } | null> {
    let subject: { installationId: string; slackUserId: string } | null;
    try {
      subject = await deps.store.subject(input);
    } catch (error) {
      if (deps.storageUnavailable?.(error)) throw error;
      return null;
    }
    if (subject === null) warnUnconfirmed(input, "no_slack_link");
    return subject;
  }

  async function membership(
    input: ChannelMemberQuestion,
  ): Promise<ChannelMembership> {
    const subject = await subjectOf(input);
    return subject === null
      ? "unconfirmed"
      : slackMembership({ ...input, ...subject });
  }

  async function slackMembership(
    input: SlackMemberQuestion,
  ): Promise<ChannelMembership> {
    const of = (member: boolean): ChannelMembership =>
      member ? "member" : "not_member";
    try {
      const read = await deps.store.cached(
        input.installationId,
        input.channelId,
      );
      if (read.memberIds !== null) {
        return of(read.memberIds.includes(input.slackUserId));
      }
      const list = await readList(input, read.checkedAt);
      if (list === "overtaken") {
        // A newer read was kept first, and its list answers; a void leaves
        // none, and the person stays out.
        const after = await deps.store.cached(
          input.installationId,
          input.channelId,
        );
        if (after.memberIds !== null) {
          return of(after.memberIds.includes(input.slackUserId));
        }
      }
      if (typeof list === "string") {
        warnUnconfirmed(input, list);
        return "unconfirmed";
      }
      return of(list.has(input.slackUserId));
    } catch (error) {
      if (deps.storageUnavailable?.(error)) throw error;
      warnUnconfirmed(input, unconfirmedOf(error), error);
      return "unconfirmed";
    }
  }

  const fills = new Map<string, Promise<void>>();
  const failedUntil = new Map<string, number>();
  const waiting: (() => void)[] = [];
  let reading = 0;
  const keyOf = (ref: SlackChannelRef) =>
    `${ref.installationId}/${ref.channelId}`;
  async function slot(): Promise<void> {
    if (reading < FILLS_AT_ONCE) {
      reading += 1;
      return;
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  function free(): void {
    const next = waiting.shift();
    if (next === undefined) reading -= 1;
    else next();
  }
  function hold(key: string): void {
    const at = now();
    for (const [held, until] of failedUntil) {
      if (until <= at) failedUntil.delete(held);
    }
    failedUntil.delete(key);
    if (failedUntil.size >= FILLS_FAILED_HELD_MAX) {
      const oldest = failedUntil.keys().next();
      if (!oldest.done) failedUntil.delete(oldest.value);
    }
    failedUntil.set(key, at + FILL_FAILED_HOLD_MS);
  }
  // Whether a failed read still holds the channel; a hold past is dropped.
  function holding(key: string): boolean {
    const until = failedUntil.get(key);
    if (until === undefined) return false;
    if (until > now()) return true;
    failedUntil.delete(key);
    return false;
  }
  function fill(ref: SlackChannelRef): void {
    const key = keyOf(ref);
    if (fills.has(key) || fills.size >= FILLS_HELD_MAX) return;
    const run = (async () => {
      await slot();
      try {
        const read = await deps.store.cached(ref.installationId, ref.channelId);
        const list = await readList(ref, read.checkedAt);
        if (typeof list === "string") {
          warnUnconfirmed(ref, list);
          // Overtaken is a newer void, whose own read follows: no failure.
          if (list !== "overtaken") hold(key);
        } else {
          failedUntil.delete(key);
        }
      } catch (error) {
        warnUnconfirmed(ref, unconfirmedOf(error), error);
        hold(key);
      } finally {
        free();
        fills.delete(key);
      }
    })();
    fills.set(key, run);
  }

  return {
    async isMember(input) {
      return (await membership(input)) === "member";
    },
    membership,
    slackMembership,
    async cachedMembership(input) {
      const subject = await subjectOf(input);
      if (subject === null) return "unconfirmed";
      const ref = { ...input, installationId: subject.installationId };
      let read: Awaited<ReturnType<ChannelMemberStore["cached"]>>;
      try {
        read = await deps.store.cached(ref.installationId, ref.channelId);
      } catch (error) {
        if (deps.storageUnavailable?.(error)) throw error;
        return "unconfirmed";
      }
      if (read.memberIds !== null) {
        if (
          read.fetchedAt !== null &&
          read.fetchedAt.getTime() +
            SLACK_MEMBER_CACHE_TTL_MS -
            read.checkedAt.getTime() <
            REFRESH_AHEAD_MS &&
          !holding(keyOf(ref))
        ) {
          fill(ref);
        }
        return read.memberIds.includes(subject.slackUserId)
          ? "member"
          : "not_member";
      }
      if (holding(keyOf(ref))) return "unconfirmed";
      fill(ref);
      return "pending";
    },
    refill(ref) {
      failedUntil.delete(keyOf(ref));
      fill(ref);
    },
    async idle() {
      while (fills.size > 0) await Promise.all([...fills.values()]);
    },
  };
}

const memberChangeSchema = z.object({
  type: z.enum([
    "member_joined_channel",
    "member_left_channel",
    "channel_left",
    "group_left",
  ]),
  channel: z.string().min(1),
});

// Slack tells a channel made private as a message in it.
const madePrivateSchema = z.object({
  type: z.literal("message"),
  subtype: z.literal("channel_convert_to_private"),
  channel: z.string().min(1),
});

/**
 * The `slack` role's first handler: anyone joining or leaving a channel,
 * the bot included, the channel made private, or the channel being
 * archived, unarchived, renamed or deleted, voids that channel's member
 * list for this app's install before the event goes on to `next`. Someone
 * joining or leaving, or the channel made private, then has the list read
 * again in the background (`refill`), so lists across sessions find it; the
 * void alone already keeps someone who left out. Someone joining or leaving
 * also redraws the channel's push, tool permission and question cards,
 * whose requester may be the one.
 */
export function createSlackMemberCacheInvalidator(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  members: Pick<ChannelMemberStore, "forget">;
  refill?: (ref: SlackChannelRef) => void;
  cards?: Pick<SurfaceCardSettleStore, "markChoiceCardsDueIn">;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  return async (claim) => {
    const event = (claim.payload as { event?: unknown }).event;
    const parsed = memberChangeSchema.safeParse(event);
    const madePrivate = madePrivateSchema.safeParse(event);
    // An archive, a rename or a delete voids the list too: who may read the
    // channel is asked again.
    const channel = parsed.success
      ? parsed.data.channel
      : madePrivate.success
        ? madePrivate.data.channel
        : lifecycleChannelOf(event);
    if (channel !== null) {
      const agent = await agentForSlackEvent(deps.agents, {
        appId: claim.appId,
        teamId: claim.teamId,
        agentId: claim.agentId,
      });
      if (agent.status === "resolved") {
        await deps.members.forget(agent.installationId, channel);
        if (parsed.success || madePrivate.success) {
          deps.refill?.({
            workspaceId: agent.workspaceId,
            agentId: agent.agentId,
            installationId: agent.installationId,
            channelId: channel,
          });
        }
        if (parsed.success) {
          await deps.cards?.markChoiceCardsDueIn({
            installationId: agent.installationId,
            channelId: channel,
            windowMs: SLACK_CARD_SETTLE_TIMING.windowMs,
          });
        }
      }
    }
    return deps.next(claim);
  };
}
