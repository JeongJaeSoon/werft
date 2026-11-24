import { randomUUID } from "node:crypto";
import type {
  ConversationInputId,
  ConversationInputSlackMirror,
  ConversationTopicId,
} from "@werft-ai/contracts";
import type {
  ConversationInputStore,
  ResendMirrorRequest,
  TakeWebInputRequest,
  TakeWebInputResult,
  WebInputReceipt,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { insertWebInputTurn, webInputBodyHash } from "./conversation-turns.ts";

type InputRow = {
  id: string;
  topic_id: string;
  seq: number;
  requester_id: string;
  slack_mirror: ConversationInputSlackMirror;
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
      // Compared on the text's hash as written, no trimming or normalizing,
      // so the text itself is not read again; one taken before 0344 and not
      // yet moved by the start pass is hashed here.
      const bodyHash = webInputBodyHash(request.body);
      const [earlier] = rowsOf<InputRow & { same_body: boolean }>(
        await tx.execute(sql`
          SELECT id, topic_id, seq, requester_id, slack_mirror,
            COALESCE(body_sha256, sha256(convert_to(body, 'UTF8'))) = ${bodyHash} AS same_body
          FROM conversation_inputs
          WHERE agent_id = ${agentId}::uuid AND requester_kind = 'user'
            AND requester_id = ${userId}
            AND client_message_id = ${request.clientMessageId}`),
      );
      if (earlier !== undefined) {
        return earlier.same_body
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
      // The text goes to the input's turn row; the input row points at it.
      const turnId = await insertWebInputTurn(tx, {
        workspaceId: request.workspaceId,
        agentId,
        conversationId: request.conversationId,
        topicId: topicId as ConversationTopicId,
        requesterUserId: userId,
        body: request.body,
      });
      const [row] = rowsOf<InputRow>(
        await tx.execute(sql`
          INSERT INTO conversation_inputs (
            id, workspace_id, agent_id, topic_id, seq,
            requester_kind, requester_id,
            client_message_id, body_sha256, conversation_turn_id, slack_mirror
          )
          SELECT ${randomUUID()}::uuid, ${request.workspaceId}::uuid,
            ${agentId}::uuid, ${topicId}::uuid,
            COALESCE(MAX(i.seq), 0) + 1,
            'user', ${userId},
            ${request.clientMessageId}, ${bodyHash}, ${turnId}::uuid,
            ${slackMirror}
          FROM conversation_inputs i WHERE i.topic_id = ${topicId}::uuid
          RETURNING id, topic_id, seq, requester_id, slack_mirror`),
      );
      if (row === undefined)
        throw new Error("input row is missing after its insert");
      return { outcome: "taken", receipt: receiptOf(row) };
    });
  }

  function resendMirror(
    request: ResendMirrorRequest,
  ): ReturnType<ConversationInputStore["resendMirror"]> {
    const userId = request.requesterUserId.toLowerCase();
    return db.transaction(async (tx) => {
      // FOR SHARE, as takeWebInput takes them: a suspension or offboarding
      // waits, and one committed first leaves nothing to send.
      const [user] = rowsOf(
        await tx.execute(sql`
          SELECT 1 FROM users
          WHERE id = ${userId}::uuid AND disabled_at IS NULL
          FOR SHARE`),
      );
      if (user === undefined) return "not_found";
      const [membership] = rowsOf(
        await tx.execute(sql`
          SELECT 1 FROM memberships
          WHERE workspace_id = ${request.workspaceId}::uuid
            AND user_id = ${userId}::uuid AND disabled_at IS NULL
          FOR SHARE`),
      );
      if (membership === undefined) return "not_found";
      // FOR UPDATE: two presses at once send one mirror.
      const [input] = rowsOf<{
        slack_mirror: ConversationInputSlackMirror;
        slack_ts: string | null;
      }>(
        await tx.execute(sql`
          SELECT i.slack_mirror, i.slack_ts
          FROM conversation_inputs i
          JOIN conversation_topics tp ON tp.id = i.topic_id
          WHERE i.id = ${request.inputId}::uuid
            AND i.workspace_id = ${request.workspaceId}::uuid
            AND i.agent_id = ${request.agentId.toLowerCase()}::uuid
            AND i.requester_kind = 'user'
            AND i.requester_id = ${userId}
            AND tp.conversation_id = ${request.conversationId}::uuid
          FOR UPDATE OF i`),
      );
      if (input === undefined) return "not_found";
      if (input.slack_mirror !== "unconfirmed" || input.slack_ts !== null) {
        return "not_unconfirmed";
      }
      const live = rowsOf(
        await tx.execute(sql`
          SELECT 1 FROM slack_outbox
          WHERE input_id = ${request.inputId}::uuid
            AND status IN ('pending', 'sending')`),
      );
      if (live.length > 0) return "not_unconfirmed";
      // The same post as the last one, under a new correlation id. With no
      // mirror row yet the outbox enqueues the input's first once pending.
      const correlationId = randomUUID();
      await tx.execute(sql`
        INSERT INTO slack_outbox (
          id, workspace_id, agent_id, slack_app_id, installation_id, kind,
          channel_id, thread_ts, body, dedupe_key, sources, input_id,
          correlation_id
        )
        SELECT ${randomUUID()}::uuid, so.workspace_id, so.agent_id,
          so.slack_app_id, so.installation_id, so.kind, so.channel_id,
          so.thread_ts, so.body,
          'input_mirror:' || so.input_id::text || ':' || ${correlationId},
          so.sources, so.input_id, ${correlationId}::uuid
        FROM slack_outbox so
        WHERE so.input_id = ${request.inputId}::uuid
        ORDER BY so.seq DESC LIMIT 1`);
      await tx.execute(sql`
        UPDATE conversation_inputs SET slack_mirror = 'pending'
        WHERE id = ${request.inputId}::uuid`);
      return "enqueued";
    });
  }

  return { isMember, takeWebInput, resendMirror };
}
