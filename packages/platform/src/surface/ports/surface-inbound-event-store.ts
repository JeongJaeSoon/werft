import type {
  ConversationTopicId,
  EngagementKind,
  SlackInboundDropFields,
  SlackInboundDropReason,
} from "@werft-ai/contracts";

/**
 * One event as the events route stored it. A `dropped` row has a reason,
 * the sender fields and no payload; the others keep the envelope as Slack
 * sent it, but an edit or a delete, which keeps none.
 */
export type SurfaceInboundEventInput = {
  workspaceId: string;
  /** The agent the request URL named. */
  agentId: string;
  slackAppId: string;
  teamId: string;
  appId: string;
  eventId: string;
  eventType: string;
  eventSubtype: string | null;
  eventTime: Date | null;
} & (
  | {
      status: "dropped";
      dropReason: SlackInboundDropReason;
      dropFields: SlackInboundDropFields;
    }
  | {
      status: "received" | "processed";
      payload: Record<string, unknown>;
      /** slackConversationKey of the event; null outside a channel message. */
      conversationKey: string | null;
    }
  | {
      // Handled where it arrived, and nothing of it is kept: an edit or a
      // delete, which leaves only its mark.
      status: "processed";
      payload: null;
      conversationKey: null;
    }
);

/** A received row the `slack` role holds until its lease ends. */
export type SurfaceInboundClaim = {
  id: string;
  claimToken: string;
  /** This claim included. */
  attempts: number;
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  teamId: string;
  appId: string;
  eventId: string;
  eventType: string;
  eventSubtype: string | null;
  eventTime: Date | null;
  conversationKey: string | null;
  payload: Record<string, unknown>;
  /** The app's install in the team as of the claim; null when there is none. */
  installationStatus: "pending" | "verified" | "revoked" | null;
};

/**
 * A message a turn took before the turn's transaction took its input too,
 * taken as an input of its topic when its row completes. The row gives the
 * workspace, agent and team. A turn made since takes its input itself.
 */
export type InboundInputReceipt = {
  topicId: ConversationTopicId;
  channelId: string;
  ts: string;
  /**
   * The turn the message became: its session and its number there. The
   * input's requester is the turn's.
   */
  turn: { sessionId: string; sequence: number };
  /** How the agent took the message, kept beside the input for the session. */
  engagement: EngagementKind;
};

/**
 * An unmentioned message the receive path holds for the judgment (a0/D2):
 * its text and poster, kept in its topic until the buffer's lifetime ends.
 * Its row completes without it when a delete or edit mark of the message
 * came first, or the channel stopped listening meanwhile.
 */
export type BufferedInputReceipt = {
  topicId: ConversationTopicId;
  channelId: string;
  ts: string;
  buffered: { body: string; slackUserId: string };
};

/** What a write after a claim is fenced on. */
export type SurfaceInboundFence = Pick<
  SurfaceInboundClaim,
  "id" | "claimToken"
>;

/**
 * The Slack inbox. `(app_id, event_id)` is unique: Slack keeps `event_id`
 * across its retries, so a retry finds the row already there.
 *
 * The `slack` role drains it: `claim` leases received rows, and every write
 * after it holds only while that lease does, judged by the database clock.
 * A write that returns false or `lost` changed nothing: the lease ended and
 * the row is someone else's, or about to be.
 */
export interface SurfaceInboundEventStore {
  seen(appId: string, eventId: string): Promise<boolean>;
  record(event: SurfaceInboundEventInput): Promise<"recorded" | "duplicate">;
  /**
   * Leases up to `limit` received rows that are due and head their
   * conversation (no earlier received row with the same key), oldest
   * first, each `attempts + 1`. A row whose lease ran out with
   * `maxAttempts` spent becomes `failed` instead.
   */
  claim(options: {
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<SurfaceInboundClaim[]>;
  /**
   * Extends a held lease to `leaseMs` from now, before an effect outside
   * the inbox. Null when the lease is gone; otherwise the install's status
   * as of now.
   */
  renew(
    fence: SurfaceInboundFence,
    leaseMs: number,
  ): Promise<{
    installationStatus: SurfaceInboundClaim["installationStatus"];
  } | null>;
  /**
   * Marks the row `processed`, its payload cleared, and in the same
   * transaction takes `input`: next in its topic, or nothing when the
   * agent took that message already, and records the agent's engagement in
   * it, once per message. A buffered message is held instead, with no
   * engagement.
   */
  complete(
    fence: SurfaceInboundFence,
    input?: InboundInputReceipt | BufferedInputReceipt,
  ): Promise<boolean>;
  /** Ends the row `dropped` for `reason`, its payload and key cleared. */
  drop(
    fence: SurfaceInboundFence,
    reason: SlackInboundDropReason,
  ): Promise<boolean>;
  /**
   * Gives the row back, due again `retryInMs` later, or ends it `failed`
   * once `maxAttempts` claims are spent.
   */
  fail(
    fence: SurfaceInboundFence,
    options: { retryInMs: number; maxAttempts: number },
  ): Promise<"retry" | "failed" | "lost">;
}
