import { createHash, randomUUID } from "node:crypto";
import type {
  ConversationId,
  ConversationInputId,
  ConversationTopicId,
  ConversationTurnDecision,
  ConversationTurnId,
  EngagementKind,
} from "@werft-ai/contracts";
import {
  placeSource,
  type StoredSourceSet,
  sourceSetOf,
  storedSourceSet,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { lockedDeletedSource } from "./deleted-sources.ts";

/** The SHA-256 a web input's retry is compared on, of its text as UTF-8. */
export function webInputBodyHash(body: string): Buffer {
  return createHash("sha256").update(body, "utf8").digest();
}

/**
 * Writes a web input's turn row, which holds its text, for the input row
 * about to point at it. `received`, with no decision, until a turn runs on it.
 */
export async function insertWebInputTurn(
  tx: Database,
  input: {
    workspaceId: string;
    agentId: string;
    conversationId: ConversationId;
    topicId: ConversationTopicId;
    requesterUserId: string;
    body: string;
    /** A timestamptz's text, kept to the microsecond. */
    receivedAt?: string;
  },
): Promise<ConversationTurnId> {
  const id = randomUUID() as ConversationTurnId;
  await tx.execute(sql`
    INSERT INTO conversation_turns (
      id, workspace_id, agent_id, conversation_id, topic_id, origin, state,
      requester_kind, requester_id, input_text, created_at
    ) VALUES (
      ${id}::uuid, ${input.workspaceId}::uuid, ${input.agentId}::uuid,
      ${input.conversationId}::uuid, ${input.topicId}::uuid, 'web_input',
      'received', 'user', ${input.requesterUserId}, ${input.body},
      COALESCE(${input.receivedAt ?? null}::timestamptz, now())
    )`);
  return id;
}

export type BeginConversationTurn = {
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  topicId: ConversationTopicId;
  /** The server's value for whom the turn serves. */
  requester: { kind: "user" | "slack_user" | "slack_bot"; id: string };
  /** What the turn starts from: its input message, and what it inherits. */
  sources: StoredSourceSet | null;
  releaseId: string | null;
  slackInstallationId: string | null;
  /** The Slack message the agent takes part in by this turn, if any. */
  engagement: {
    teamId: string;
    channelId: string;
    ts: string;
    kind: EngagementKind;
  } | null;
};

export type BegunConversationTurn =
  | { outcome: "begun"; turnId: ConversationTurnId }
  // A message among its sources, or the one it engages, is marked deleted.
  | { outcome: "source_deleted" };

/**
 * Writes a conversation turn `running`, and the engagement row pointing at
 * it, together or not at all. Each source's mark lock is taken first, so a
 * delete under way is waited for and refuses the turn, and one after it finds
 * the turn holding the message.
 */
export function beginConversationTurn(
  db: Database,
  input: BeginConversationTurn,
): Promise<BegunConversationTurn> {
  const agentId = input.agentId.toLowerCase();
  return db.transaction(async (tx) => {
    const set = sourceSetOf(input.sources);
    const engaged = input.engagement;
    const judged = storedSourceSet({
      ...set,
      direct:
        engaged === null
          ? set.direct
          : [
              ...set.direct,
              placeSource({
                teamId: engaged.teamId,
                channelId: engaged.channelId,
                ts: engaged.ts,
              }),
            ],
    });
    const deleted = await lockedDeletedSource(tx, {
      workspaceId: input.workspaceId,
      sessionId: null,
      sources: judged,
      throughTurn: null,
    });
    if (deleted !== null) return { outcome: "source_deleted" };
    const [topic] = rowsOf(
      await tx.execute(sql`
        SELECT 1 FROM conversation_topics t
        JOIN conversations c ON c.id = t.conversation_id
        WHERE t.id = ${input.topicId}::uuid
          AND c.id = ${input.conversationId}::uuid
          AND c.workspace_id = ${input.workspaceId}::uuid
          AND c.agent_id = ${agentId}::uuid`),
    );
    if (topic === undefined) {
      throw new Error(
        `topic ${input.topicId} is no topic of conversation ${input.conversationId} of agent ${agentId}`,
      );
    }
    const turnId = randomUUID() as ConversationTurnId;
    await tx.execute(sql`
      INSERT INTO conversation_turns (
        id, workspace_id, agent_id, conversation_id, topic_id, origin, state,
        requester_kind, requester_id, sources, release_id,
        slack_installation_id
      ) VALUES (
        ${turnId}::uuid, ${input.workspaceId}::uuid, ${agentId}::uuid,
        ${input.conversationId}::uuid, ${input.topicId}::uuid, 'm2',
        'running', ${input.requester.kind}, ${input.requester.id},
        ${input.sources === null ? null : JSON.stringify(input.sources)}::jsonb,
        ${input.releaseId}, ${input.slackInstallationId}::uuid
      )`);
    if (engaged !== null) {
      await tx.execute(sql`
        INSERT INTO conversation_engagements (
          workspace_id, agent_id, team_id, channel_id, ts, kind,
          conversation_turn_id
        ) VALUES (
          ${input.workspaceId}::uuid, ${agentId}::uuid, ${engaged.teamId},
          ${engaged.channelId}, ${engaged.ts}, ${engaged.kind},
          ${turnId}::uuid
        )
        ON CONFLICT DO NOTHING`);
    }
    return { outcome: "begun", turnId };
  });
}

/** How a running conversation turn ended. */
export type ConversationTurnEnd =
  | {
      state: "decided";
      decision: ConversationTurnDecision;
      reason: string | null;
      /** The agent's answer, kept as its body. */
      answer: string | null;
    }
  | { state: "no_decision" }
  | { state: "voided_by_delete" };

export type ConversationTurnEnding =
  | "recorded"
  // An admin's delete removed the turn: its result is not written.
  | "gone"
  | "already_ended";

/** Writes how a running conversation turn ended, once. */
export function endConversationTurn(
  db: Database,
  input: { turnId: ConversationTurnId; end: ConversationTurnEnd },
): Promise<ConversationTurnEnding> {
  return db.transaction(async (tx) => {
    const [turn] = rowsOf<{ state: string }>(
      await tx.execute(sql`
        SELECT state FROM conversation_turns
        WHERE id = ${input.turnId}::uuid AND origin = 'm2'
        FOR UPDATE`),
    );
    if (turn === undefined) return "gone";
    if (turn.state !== "running") return "already_ended";
    const end = input.end;
    const decided = end.state === "decided" ? end : null;
    await tx.execute(sql`
      UPDATE conversation_turns SET
        state = ${end.state},
        decision = ${decided?.decision ?? null},
        decision_reason = ${decided?.reason ?? null},
        answer_text = ${decided?.answer ?? null},
        ended_at = now()
      WHERE id = ${input.turnId}::uuid`);
    return "recorded";
  });
}

export type WebInputTurnsBackfilled = {
  backfilled: number;
  failed: { inputId: ConversationInputId; error: unknown }[];
};

/**
 * Gives each web input taken before 0344 a turn row of its own holding its
 * text, the way a web input is taken now, and keeps the text's hash for its
 * retries; the input row keeps its copy. One input per transaction, in batches of `batch`; an API
 * start runs it, and one that failed is tried again on the next.
 */
export async function backfillWebInputTurns(
  db: Database,
  options: { batch?: number } = {},
): Promise<WebInputTurnsBackfilled> {
  const batch = options.batch ?? 500;
  const result: WebInputTurnsBackfilled = { backfilled: 0, failed: [] };
  const failed = new Set<string>();
  for (;;) {
    const due = rowsOf<{ id: ConversationInputId }>(
      await db.execute(sql`
        SELECT id FROM conversation_inputs
        WHERE client_message_id IS NOT NULL AND conversation_turn_id IS NULL
          AND NOT (id = ANY(${`{${[...failed].join(",")}}`}::uuid[]))
        ORDER BY received_at, id
        LIMIT ${batch}`),
    );
    if (due.length === 0) return result;
    for (const { id } of due) {
      try {
        if (await backfillOne(db, id)) result.backfilled += 1;
      } catch (error) {
        failed.add(id);
        result.failed.push({ inputId: id, error });
      }
    }
  }
}

function backfillOne(
  db: Database,
  inputId: ConversationInputId,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [input] = rowsOf<{
      workspace_id: string;
      agent_id: string;
      topic_id: ConversationTopicId;
      conversation_id: ConversationId;
      requester_id: string;
      body: string;
      received_at: string;
    }>(
      await tx.execute(sql`
        SELECT i.workspace_id, i.agent_id, i.topic_id, t.conversation_id,
          i.requester_id, i.body, i.received_at::text AS received_at
        FROM conversation_inputs i
        JOIN conversation_topics t ON t.id = i.topic_id
        WHERE i.id = ${inputId}::uuid
          AND i.client_message_id IS NOT NULL
          AND i.conversation_turn_id IS NULL
        FOR UPDATE OF i`),
    );
    if (input === undefined) return false;
    const turnId = await insertWebInputTurn(tx, {
      workspaceId: input.workspace_id,
      agentId: input.agent_id,
      conversationId: input.conversation_id,
      topicId: input.topic_id,
      requesterUserId: input.requester_id,
      body: input.body,
      receivedAt: input.received_at,
    });
    await tx.execute(sql`
      UPDATE conversation_inputs SET
        body_sha256 = ${webInputBodyHash(input.body)},
        conversation_turn_id = ${turnId}::uuid
      WHERE id = ${inputId}::uuid`);
    return true;
  });
}
