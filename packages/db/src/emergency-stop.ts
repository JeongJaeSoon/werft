import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  TURN_EMERGENCY_STOPPED_REASON,
} from "@werft-ai/contracts";
import type { EmergencyStopCounts } from "@werft-ai/platform";
import { publicStatus } from "@werft-ai/platform";
import { and, eq, inArray, sql } from "drizzle-orm";
import { settleTurnPushIntents } from "./action/push-intents.ts";
import {
  INPUT_RECEIPT_OPERATIONS,
  lockSessionForControl,
  OPEN_TURN_STATUSES,
} from "./control-shared.ts";
import { cancelQueuedInput, stopExecution } from "./control-unit-of-work.ts";
import { dbNow } from "./db-clock.ts";
import { CREATE_SESSION, SESSIONS_RESOURCE } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import {
  queueMessages,
  receipts,
  sessions,
  turns,
  unassignedSessions,
} from "./schema.ts";
import { PAUSE } from "./sessions/drain.ts";
import { pauseReceiptResult } from "./sessions/pause-control.ts";
import { hasRestorePoint } from "./sessions/pause-policy.ts";
import { awaitingInputAt } from "./sessions/pending-status.ts";
import { lockChannelKind } from "./sessions/private-channel-scope.ts";
import { recordEvent, recordStatus } from "./sessions/session-events.ts";
import { settleTurnInterrupts } from "./sessions/turn-interrupts.ts";
import { rowsOf } from "./statement-rows.ts";
import { closeHeldOfFailedMirror } from "./surface/slack-input-holds.ts";

export const EMERGENCY_STOPPED = TURN_EMERGENCY_STOPPED_REASON;

/** One agent's place in one Slack channel of its install. */
export type ChannelWorkPlace = {
  workspaceId: string;
  agentId: string;
  installationId: string;
  channelId: string;
  /**
   * Every install of the channel's Slack team the agent is bound there
   * through, `installationId` among them: one stop covers them all.
   */
  installationIds: readonly string[];
};

const installsOf = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

/** One live binding a stop of its channel covers. */
export type StopScopeBinding = {
  id: string;
  installationId: string;
  /** ISO 8601, as a receipt says it. */
  emergencyStoppedAt: string | null;
  emergencyStoppedBy: string | null;
  emergencyStopReason: string | null;
  /** Gone (its identity revoked, the channel refused), its stop kept. */
  revoked: boolean;
};

/**
 * What one emergency stop covers, locked: the agent's bindings of one
 * channel across every install of the channel's Slack team it has (its
 * identity's, revoked or not, or one it was bound through), in id order:
 * each live one, and each revoked one that still holds a stop, which holds
 * until a save turns the channel on, whatever became of its binding. A
 * stop and a save of the channel take the scope's lock first, so a binding
 * a save writes (a new install's) is written before a stop or after it,
 * where it starts stopped. With `kinds`, each install's channel lock is
 * taken before the bindings, as a change of the channel's kind takes them.
 */
export async function lockStopScope(
  tx: Database,
  place: Omit<ChannelWorkPlace, "installationIds">,
  options: { kinds: boolean },
): Promise<{ installationIds: string[]; bindings: StopScopeBinding[] }> {
  const team = sql`(SELECT coalesce(i.team_id, i.id::text)
    FROM slack_installations i WHERE i.id = ${place.installationId}::uuid)`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    'emergency_stop:' || ${place.agentId.toLowerCase()} || ':' || ${team}
      || ':' || ${place.channelId}, 0))`);
  const bound = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT i.id::text AS id FROM slack_installations i
      WHERE coalesce(i.team_id, i.id::text) = ${team}
        AND (EXISTS (
          SELECT 1 FROM agent_identities a
          WHERE a.installation_id = i.id
            AND a.agent_id = ${place.agentId}::uuid)
        OR EXISTS (
          SELECT 1 FROM surface_bindings b
          WHERE b.installation_id = i.id
            AND b.agent_id = ${place.agentId}::uuid))`),
  ).map((row) => row.id);
  const installationIds = [
    ...new Set([...bound, place.installationId.toLowerCase()]),
  ].sort();
  if (options.kinds) {
    for (const id of installationIds) {
      await lockChannelKind(tx, id, place.channelId);
    }
  }
  const bindings = rowsOf<StopScopeBinding>(
    await tx.execute(sql`
      SELECT b.id::text AS id, b.installation_id::text AS "installationId",
        to_char(b.emergency_stopped_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "emergencyStoppedAt",
        b.emergency_stopped_by::text AS "emergencyStoppedBy",
        b.emergency_stop_reason AS "emergencyStopReason",
        b.revoked_at IS NOT NULL AS revoked
      FROM surface_bindings b
      WHERE b.workspace_id = ${place.workspaceId}::uuid
        AND b.agent_id = ${place.agentId}::uuid
        AND b.external_surface_id = ${place.channelId}
        AND (b.revoked_at IS NULL OR b.emergency_stopped_at IS NOT NULL)
        AND b.installation_id IN (${installsOf(installationIds)})
      ORDER BY b.id
      FOR UPDATE`),
  );
  return { installationIds, bindings };
}

/**
 * Everything of one agent that runs or is about to post in one Slack channel,
 * stopped at once, in the caller's transaction (the emergency stop's, which
 * holds the channel's binding). The one place a stop of a channel's work is
 * made, so a single stop function can take its place.
 *
 * - Each open task session of the channel (linked from one of its threads,
 *   or whose parent conversation is the channel's) is stopped: its running
 *   turn fails as cut off, its queued input is cancelled and its worker is
 *   fenced out, so nothing it does after this is taken. One with a restore
 *   point is paused for `emergency_stopped`, one already paused is marked
 *   so; neither resumes, and no session takes input, while the stop holds.
 *   It goes on only when a person resumes it and continues the turn.
 * - Each running conversation turn there ends without a decision: its
 *   permit takes no more provider calls and its lease is ended, so no
 *   decision it reaches is recorded.
 * - Each post to the channel not sent yet is cancelled, and every turn cut
 *   off above is marked told in its threads, so its failure is never posted.
 */
export async function stopChannelWork(
  tx: Database,
  place: ChannelWorkPlace,
  input: { now: Date; attempt: number },
): Promise<EmergencyStopCounts> {
  const counts: EmergencyStopCounts = { sessions: 0, turns: 0, posts: 0 };
  const held = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT s.id::text AS id FROM sessions s
      WHERE s.workspace_id = ${place.workspaceId}::uuid
        AND s.admission_state NOT IN ('closing', 'closed')
        AND (
          s.id IN (
            SELECT l.session_id FROM session_links l
            WHERE l.installation_id IN (${installsOf(place.installationIds)})
              AND l.channel_id = ${place.channelId}
              AND l.agent_id = ${place.agentId}::uuid
              AND l.session_id IS NOT NULL)
          -- A thread's session made but not yet linked: its link holds the
          -- key the session was made under.
          OR s.id IN (
            SELECT (r.result ->> 'session_id')::uuid
            FROM session_links l
            JOIN idempotency_keys k ON k.principal = l.workspace_id::text
              AND k.operation = ${CREATE_SESSION}
              AND k.resource = ${SESSIONS_RESOURCE}
              AND k.key = l.id::text
            JOIN receipts r ON r.id = k.receipt_id
            WHERE l.installation_id IN (${installsOf(place.installationIds)})
              AND l.channel_id = ${place.channelId}
              AND l.agent_id = ${place.agentId}::uuid
              AND l.session_id IS NULL
              AND r.result ->> 'session_id' IS NOT NULL)
          OR s.parent_conversation_id IN (
            SELECT c.id FROM conversations c
            WHERE c.workspace_id = ${place.workspaceId}::uuid
              AND c.agent_id = ${place.agentId}::uuid
              AND c.channel_id = ${place.channelId}
              -- The same channel id in another team is another channel.
              AND c.team_id = (SELECT i.team_id FROM slack_installations i WHERE i.id = ${place.installationId}::uuid))
        )
      ORDER BY s.id`),
  );
  for (const { id } of held) {
    const stopped = await stopSession(tx, id, input);
    if (stopped.paused) counts.sessions += 1;
    counts.turns += stopped.cut;
  }
  counts.turns += await stopConversationTurns(tx, place);
  counts.posts += await cancelChannelPosts(tx, place);
  return counts;
}

/**
 * A session that joins the channel while its agent is stopped there (made
 * as the stop ran, linked after it) is stopped as it joins, as the stop
 * would have. The caller holds the channel's lock, as the stop does.
 */
export async function stopJoiningSession(
  tx: Database,
  sessionId: string,
): Promise<void> {
  await stopSession(tx, sessionId, { now: await dbNow(tx), attempt: 0 });
}

async function stopSession(
  tx: Database,
  sessionId: string,
  input: { now: Date; attempt: number },
): Promise<{ paused: boolean; cut: number }> {
  const { now } = input;
  const session = await lockSessionForControl(tx, {
    sessionId,
    attempt: input.attempt,
  });
  if (session === null) return { paused: false, cut: 0 };
  const from = session.admissionState;
  // Paused already: it stays so, under the stop, until the channel is on,
  // and what waited for its resume never runs.
  if (from === "paused") {
    await stopExecution(tx, session, { now, by: "emergency stop" });
    if (session.pauseReason !== EMERGENCY_STOPPED) {
      await tx
        .update(sessions)
        .set({
          revision: sql`${sessions.revision} + 1`,
          pauseReason: EMERGENCY_STOPPED,
          updatedAt: now,
        })
        .where(eq(sessions.id, session.id));
    }
    return { paused: false, cut: 0 };
  }
  // Waiting on an operator's recovery decision or on a resume: nothing
  // runs, and what waits for one never runs either.
  if (
    from === "recovery_required" ||
    from === "stopping" ||
    from === "stopped"
  ) {
    await cancelQueuedInput(tx, session.id, { now, by: "emergency stop" });
    return { paused: false, cut: 0 };
  }
  // Only these run or are about to; a legacy pod binding has no fence to
  // stop it with.
  if (from !== "active" && from !== "pausing" && from !== "resuming") {
    return { paused: false, cut: 0 };
  }
  if (session.executionId === null && session.podId !== null) {
    return { paused: false, cut: 0 };
  }
  // Queued input never runs, open questions close, the execution is told
  // to stop and a pause or resume under way is superseded.
  const { pendingKill } = await stopExecution(tx, session, {
    now,
    by: "emergency stop",
  });
  const cut = await cutRunningTurns(tx, session.id, now);
  // Nothing is left to run: a launch the scheduler has not made yet is not
  // made, and a session that only waited for one reads idle.
  await tx
    .delete(unassignedSessions)
    .where(eq(unassignedSessions.sessionId, session.id));
  const idle = cut.length > 0 || session.status === "queued";
  // A pause stands on a committed checkpoint (pauseBlocker), so one with
  // none could never settle paused: it stays as it is, its run cut and
  // fenced, and takes no input while the stop holds (emergencyStopHolds).
  const pauses = hasRestorePoint(session);
  const into = !pauses ? from : pendingKill ? "pausing" : "paused";
  await tx
    .update(sessions)
    .set({
      revision: sql`${sessions.revision} + 1`,
      // Every request of the fenced worker is refused from now.
      ...(pendingKill ? { leaseEpoch: sql`${sessions.leaseEpoch} + 1` } : {}),
      ...(pauses
        ? { admissionState: into, pauseReason: EMERGENCY_STOPPED }
        : {}),
      ...(idle ? { status: "idle" as const } : {}),
      ...(cut.length > 0 ? { lastTurnAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(sessions.id, session.id));
  // The platform's pause, as a deleted source opens it: no person asked, so
  // the receipt has no actor; it settles once the execution is seen gone.
  if (pauses) {
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: session.ownerId,
      actor: null,
      requestId: null,
      operation: PAUSE,
      targetRef: { session_id: session.id, turn_id: null, request_id: null },
      status: pendingKill ? "accepted" : "succeeded",
      result: pendingKill ? null : await pauseReceiptResult(tx, session),
      createdAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    });
  }
  await recordStatus(tx, {
    sessionId: session.id,
    phase: publicStatus(
      idle ? "idle" : session.status,
      await awaitingInputAt(tx, session.id, await dbNow(tx)),
    ),
    extra: { admission_state: into, reason: EMERGENCY_STOPPED },
    turnRowId: null,
    now,
  });
  await recordEvent(tx, {
    sessionId: session.id,
    type: "system",
    payload: {
      type: "system",
      subtype: EMERGENCY_STOPPED,
      from_admission_state: from,
      admission_state: into,
      cut_turn_ids: cut.map((turn) => String(turn.sequence)),
    },
    turnRowId: null,
    now,
  });
  return { paused: true, cut: cut.length };
}

/**
 * The session's running turns end `failed` as cut off, as a lost lease ends
 * them: what they did after the last checkpoint is for a person to check,
 * and a person's [Continue] is the only way on from them.
 */
async function cutRunningTurns(
  tx: Database,
  sessionId: string,
  now: Date,
): Promise<{ id: number; sequence: number }[]> {
  const cut = await tx
    .update(turns)
    .set({
      status: "failed",
      endedAt: now,
      terminalReason: EMERGENCY_STOPPED,
    })
    .where(
      and(
        eq(turns.sessionId, sessionId),
        inArray(turns.status, OPEN_TURN_STATUSES),
      ),
    )
    .returning({ id: turns.id, sequence: turns.sequence });
  if (cut.length === 0) return cut;
  for (const turn of cut) {
    await settleTurnInterrupts(tx, {
      sessionId,
      turnRowId: turn.id,
      turnSequence: turn.sequence,
      terminal: "failed",
      terminalReason: EMERGENCY_STOPPED,
      at: now,
    });
    // The turn left no state to push.
    await settleTurnPushIntents(tx, {
      turnRowId: turn.id,
      completedRevision: null,
    });
  }
  const ids = cut.map((turn) => turn.id);
  await tx.delete(queueMessages).where(inArray(queueMessages.turnId, ids));
  // `result` stays the acceptance response (receiptSchema.result).
  await tx
    .update(receipts)
    .set({
      status: "failed",
      error: {
        code: "SESSION_STOPPED",
        message: "cut off by an emergency stop of its Slack channel",
      },
      updatedAt: now,
    })
    .where(
      and(
        inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
        eq(receipts.status, "accepted"),
        sql`${receipts.targetRef}->>'session_id' = ${sessionId}`,
        inArray(
          sql`${receipts.targetRef}->>'turn_id'`,
          cut.map((turn) => String(turn.sequence)),
        ),
      ),
    );
  await markCutTurnsTold(tx, sessionId);
  return cut;
}

/**
 * Every turn of the session an emergency stop cut off is told already in
 * each thread of the session, so its failure is never posted there: the
 * keys its failure row would take. Run as the stop cuts it, and as a thread
 * takes a session made around a stop.
 */
export async function markCutTurnsTold(
  tx: Database,
  sessionId: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id,
      installation_id, kind, channel_id, thread_ts, session_id,
      session_link_id, body, dedupe_key, status, error_code, sources_turn)
    SELECT gen_random_uuid(), l.workspace_id, l.agent_id, a.id,
      l.installation_id, 'failure_notice', l.channel_id, l.thread_id,
      l.session_id, l.id, '{"text":""}'::jsonb,
      'failure:' || l.id || ':' || t.sequence, 'failed',
      ${EMERGENCY_STOPPED}, t.sequence
    FROM session_links l
    JOIN turns t ON t.session_id = l.session_id
    JOIN slack_installations i ON i.id = l.installation_id
    JOIN slack_apps a ON a.app_id = i.app_id
    WHERE l.session_id = ${sessionId}::uuid
      AND t.status = 'failed'
      AND t.terminal_reason = ${EMERGENCY_STOPPED}
    ON CONFLICT (dedupe_key) DO NOTHING`);
}

/**
 * The agent's conversation turns in the channel end without a decision:
 * one running (its permit takes no more provider calls), and one still
 * waiting in the queue or leased to a runtime (it is never handed out or
 * taken). The queue's lock first, as every queue change takes it, then
 * each turn's permit before the turn, as a provider call and a turn's end
 * take them.
 */
async function stopConversationTurns(
  tx: Database,
  place: ChannelWorkPlace,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('conversation_turn_queue'))`,
  );
  const open = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT ct.id::text AS id FROM conversation_turns ct
      JOIN conversations c ON c.id = ct.conversation_id
      WHERE ct.workspace_id = ${place.workspaceId}::uuid
        AND ct.agent_id = ${place.agentId}::uuid
        AND c.channel_id = ${place.channelId}
        AND c.team_id = (SELECT i.team_id FROM slack_installations i WHERE i.id = ${place.installationId}::uuid)
        AND (ct.state = 'running' OR EXISTS (
          SELECT 1 FROM conversation_turn_queue q
          WHERE q.turn_id = ct.id AND q.state IN ('queued', 'leased')))
      ORDER BY ct.id`),
  ).map((row) => row.id);
  if (open.length === 0) {
    await endWaitingMentionTries(tx, place);
    return 0;
  }
  const ids = sql.join(
    open.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    SELECT 1 FROM conversation_turn_permits
    WHERE turn_id IN (${ids}) ORDER BY turn_id FOR UPDATE`);
  const ended = rowsOf<{ id: string }>(
    await tx.execute(sql`
      UPDATE conversation_turns SET state = 'no_decision',
        ended_at = clock_timestamp()
      WHERE id IN (${ids}) AND state = 'running'
      RETURNING id::text AS id`),
  );
  await tx.execute(sql`
    UPDATE conversation_turn_permits
    SET expires_at = LEAST(expires_at, clock_timestamp())
    WHERE turn_id IN (${ids})`);
  // A call under way (a decided turn's closing one too) is regranted no more.
  await tx.execute(sql`
    UPDATE conversation_calls
    SET expires_at = LEAST(expires_at, clock_timestamp())
    WHERE conversation_turn_id IN (${ids}) AND state = 'in_flight'`);
  const dequeued = rowsOf<{ id: string }>(
    await tx.execute(sql`
    UPDATE conversation_turn_queue
    SET state = 'ended',
      outcome = ${JSON.stringify({ outcome: "failed", reason: EMERGENCY_STOPPED })}::jsonb,
      ended_at = clock_timestamp(), turn_nonce = NULL, turn_ciphertext = NULL
    WHERE turn_id IN (${ids}) AND state IN ('queued', 'leased')
    RETURNING turn_id::text AS id`),
  );
  await endWaitingMentionTries(tx, place);
  return new Set([...ended, ...dequeued].map((row) => row.id)).size;
}

/**
 * A mention's try in the channel that ended with no decision and keeps its
 * input for a try again (one its runtime reported before the stop, ended
 * by it, or one waiting out its delay) is ended by the stop: no try follows
 * it once the channel is on, and its input goes.
 */
async function endWaitingMentionTries(tx: Database, place: ChannelWorkPlace) {
  await tx.execute(sql`
    UPDATE conversation_turn_queue q
    SET outcome = ${JSON.stringify({ outcome: "failed", reason: EMERGENCY_STOPPED })}::jsonb,
      turn_nonce = NULL, turn_ciphertext = NULL, input_kept_until = NULL
    FROM conversation_turns ct
    JOIN conversations c ON c.id = ct.conversation_id
    WHERE q.turn_id = ct.id AND q.state = 'ended'
      AND q.turn_ciphertext IS NOT NULL
      AND ct.origin = 'm2' AND ct.state = 'no_decision'
      AND ct.workspace_id = ${place.workspaceId}::uuid
      AND ct.agent_id = ${place.agentId}::uuid
      AND c.channel_id = ${place.channelId}
      AND c.team_id = (SELECT i.team_id FROM slack_installations i WHERE i.id = ${place.installationId}::uuid)`);
}

/**
 * Every post to the channel from the agent's installs that has not gone yet,
 * a progress message's next edit and a held row included, is cancelled; the
 * stop's own line is not. A send already under way is Slack's by now, and a
 * retry of it while the stop holds ends failed (settle). Run again as the
 * channel is turned on, so nothing held back by the stop goes out late.
 */
export async function cancelChannelPosts(
  tx: Database,
  place: Pick<
    ChannelWorkPlace,
    "agentId" | "installationId" | "installationIds" | "channelId"
  >,
): Promise<number> {
  // The agent's through any of its installs in the channel's Slack team
  // (one whose binding is gone too, as a refused channel's notice is), and
  // never another agent's an install went on to.
  const covered = sql`(agent_id = ${place.agentId}::uuid
    AND installation_id IN (${installsOf(place.installationIds)}))`;
  const cancelled = rowsOf<{ input_id: string | null }>(
    await tx.execute(sql`
      UPDATE slack_outbox
      SET status = 'failed', error_code = ${EMERGENCY_STOPPED},
        claim_token = NULL, lease_expires_at = NULL
      WHERE ${covered}
        AND channel_id = ${place.channelId}
        AND status = 'pending'
        AND kind <> 'emergency_stop_notice'
      RETURNING input_id::text AS input_id`),
  );
  // A send under way keeps its claim, but is marked: a retry of it ends
  // failed even after the channel is on again (settle).
  await tx.execute(sql`
    UPDATE slack_outbox SET error_code = ${EMERGENCY_STOPPED}
    WHERE ${covered}
      AND channel_id = ${place.channelId}
      AND status = 'sending'
      AND kind <> 'emergency_stop_notice'`);
  // A mirror cancelled here never reached Slack: what it held closes too,
  // in id order, as every path that takes several inputs does.
  for (const inputId of [
    ...new Set(
      cancelled.flatMap((row) => (row.input_id === null ? [] : [row.input_id])),
    ),
  ].sort()) {
    await closeHeldOfFailedMirror(tx, inputId as ConversationInputId);
  }
  return cancelled.length;
}

/** The channel's one line that its agent was stopped, once per stop. */
export async function enqueueEmergencyStopNotice(
  tx: Database,
  place: ChannelWorkPlace & { receiptId: string; text: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id,
      installation_id, kind, channel_id, thread_ts, body, dedupe_key)
    SELECT ${randomUUID()}::uuid, ${place.workspaceId}::uuid,
      ${place.agentId}::uuid, a.id, i.id, 'emergency_stop_notice',
      ${place.channelId}, '', ${JSON.stringify({ text: place.text })}::jsonb,
      ${`emergency-stop:${place.receiptId}`}
    FROM slack_installations i
    JOIN slack_apps a ON a.app_id = i.app_id
    WHERE i.id = ${place.installationId}::uuid
    ON CONFLICT (dedupe_key) DO NOTHING`);
}
