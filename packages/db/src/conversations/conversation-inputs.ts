import { randomUUID } from "node:crypto";
import type {
  ConversationInputId,
  ConversationInputSlackMirror,
  ConversationTopicId,
} from "@werft-ai/contracts";
import type {
  ConversationInputStore,
  TakeWebInputRequest,
  TakeWebInputResult,
  WebInputReceipt,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

type InputRow = {
  id: string;
  topic_id: string;
  seq: number;
  requester_id: string;
  slack_mirror: ConversationInputSlackMirror;
  body: string;
};

function receiptOf(row: InputRow): WebInputReceipt {
  return {
    inputId: row.id as ConversationInputId,
    topicId: row.topic_id as ConversationTopicId,
    seq: row.seq,
    requester: { kind: "user", id: row.requester_id },
    slackMirror: row.slack_mirror,
  };
}

export function createPostgresConversationInputStore(
  db: Database,
): ConversationInputStore {
  // A suspended account keeps its memberships, so the user row is read too.
  const enabledMember = (workspaceId: string, userId: string) => sql`
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${workspaceId}::uuid AND m.user_id = ${userId}::uuid
      AND m.disabled_at IS NULL AND u.disabled_at IS NULL`;

  async function isMember(workspaceId: string, userId: string) {
    return (
      rowsOf(await db.execute(enabledMember(workspaceId, userId))).length > 0
    );
  }

  function takeWebInput(
    request: TakeWebInputRequest,
  ): Promise<TakeWebInputResult> {
    const agentId = request.agentId.toLowerCase();
    const userId = request.requesterUserId.toLowerCase();
    return db.transaction(async (tx) => {
      // Retries of one key wait here for each other, so a new topic is
      // opened once; the unique index backs this up.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`web_input:${agentId}:${userId}:${request.clientMessageId}`}, 0))`);
      // FOR SHARE: a suspension or offboarding waits for this receipt. In
      // the order they take: the user, then the membership, each locked on
      // its own, since a joined row re-read after a lock wait is still the
      // old snapshot's.
      const [user] = rowsOf(
        await tx.execute(sql`
          SELECT 1 FROM users
          WHERE id = ${userId}::uuid AND disabled_at IS NULL
          FOR SHARE`),
      );
      if (user === undefined) return { outcome: "not_member" };
      const [membership] = rowsOf(
        await tx.execute(sql`
          SELECT 1 FROM memberships
          WHERE workspace_id = ${request.workspaceId}::uuid
            AND user_id = ${userId}::uuid AND disabled_at IS NULL
          FOR SHARE`),
      );
      if (membership === undefined) return { outcome: "not_member" };
      const [earlier] = rowsOf<InputRow>(
        await tx.execute(sql`
          SELECT id, topic_id, seq, requester_id, slack_mirror, body
          FROM conversation_inputs
          WHERE agent_id = ${agentId}::uuid AND requester_kind = 'user'
            AND requester_id = ${userId}
            AND client_message_id = ${request.clientMessageId}`),
      );
      if (earlier !== undefined) {
        // Compared as written: no trimming, no normalizing.
        return earlier.body === request.body
          ? { outcome: "replayed", receipt: receiptOf(earlier) }
          : { outcome: "body_mismatch" };
      }
      const [conversation] = rowsOf<{ kind: string; team_id: string | null }>(
        await tx.execute(sql`
          SELECT kind, team_id FROM conversations
          WHERE id = ${request.conversationId}::uuid
            AND workspace_id = ${request.workspaceId}::uuid
            AND agent_id = ${agentId}::uuid`),
      );
      if (conversation === undefined) {
        throw new Error(
          `conversation ${request.conversationId} is no conversation of agent ${agentId}`,
        );
      }
      // Read here, not before the transaction, so an unlink racing this
      // receipt either commits first and is seen, or waits for it.
      const links = rowsOf<{ external_tenant: string }>(
        await tx.execute(sql`
          SELECT external_tenant FROM linked_accounts
          WHERE workspace_id = ${request.workspaceId}::uuid
            AND user_id = ${userId}::uuid
            AND provider = 'slack' AND status = 'active'
          FOR SHARE`),
      );
      if (
        conversation.kind === "channel" &&
        !links.some((link) => link.external_tenant === conversation.team_id)
      ) {
        return { outcome: "unlinked" };
      }
      const slackMirror: ConversationInputSlackMirror =
        links.length > 0 ? "pending" : "not_target";
      let topicId: string;
      if (request.topicId === null) {
        topicId = randomUUID();
        await tx.execute(sql`
          INSERT INTO conversation_topics (
            id, workspace_id, agent_id, conversation_id, conversation_kind
          ) VALUES (
            ${topicId}::uuid, ${request.workspaceId}::uuid, ${agentId}::uuid,
            ${request.conversationId}::uuid, ${conversation.kind}
          )`);
      } else {
        // One taker per topic at a time, as for a Slack input, so the
        // topic's highest number plus one is free.
        const [topic] = rowsOf<{ id: string }>(
          await tx.execute(sql`
            SELECT id FROM conversation_topics
            WHERE id = ${request.topicId}::uuid
              AND conversation_id = ${request.conversationId}::uuid
              AND agent_id = ${agentId}::uuid
            FOR UPDATE`),
        );
        if (topic === undefined) return { outcome: "topic_not_found" };
        topicId = topic.id;
      }
      const [row] = rowsOf<InputRow>(
        await tx.execute(sql`
          INSERT INTO conversation_inputs (
            id, workspace_id, agent_id, topic_id, seq,
            requester_kind, requester_id,
            client_message_id, body, slack_mirror
          )
          SELECT ${randomUUID()}::uuid, ${request.workspaceId}::uuid,
            ${agentId}::uuid, ${topicId}::uuid,
            COALESCE(MAX(i.seq), 0) + 1,
            'user', ${userId},
            ${request.clientMessageId}, ${request.body}, ${slackMirror}
          FROM conversation_inputs i WHERE i.topic_id = ${topicId}::uuid
          RETURNING id, topic_id, seq, requester_id, slack_mirror, body`),
      );
      if (row === undefined)
        throw new Error("input row is missing after its insert");
      return { outcome: "taken", receipt: receiptOf(row) };
    });
  }

  return { isMember, takeWebInput };
}
