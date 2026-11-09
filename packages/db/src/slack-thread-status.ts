import type { AdmissionState, PushRequestOrigin } from "@werft-ai/contracts";
import type {
  SlackThreadStatusClaim,
  SlackThreadStatusFacts,
  SlackThreadStatusFence,
  SlackThreadStatusReconcile,
  SlackThreadStatusStore,
} from "@werft-ai/platform";
import { exists, type SQL, sql } from "drizzle-orm";
import { actionableOfSession } from "./pending-requests.ts";
import type { Database } from "./queries.ts";
import { sessions } from "./schema.ts";
import { channelLeft } from "./slack-channel-left.ts";

type Raw = Record<string, unknown>;

const rowsOf = async (db: Database, query: SQL) =>
  ((await db.execute(query)) as unknown as { rows: Raw[] }).rows;

const dateOf = (value: unknown) =>
  value === null || value === undefined ? null : new Date(value as string);

const ms = (value: number) => sql`make_interval(secs => ${value / 1000})`;

// A link the status may still go to: its session attached, the link and its
// installation live, the thread not muted, and the bot still in its channel.
const LIVE_LINK = sql`
  l.session_id IS NOT NULL
  AND l.revoked_at IS NULL
  AND NOT l.muted
  AND NOT ${channelLeft(sql`l.installation_id`, sql`l.channel_id`)}
  AND EXISTS (
    SELECT 1 FROM slack_installations i
    WHERE i.id = l.installation_id AND i.status <> 'revoked'
  )`;

const TARGET = sql`
  l.id AS session_link_id, l.session_id, l.workspace_id, a.id AS slack_app_id,
  l.channel_id, l.thread_id`;

const TARGET_JOIN = sql`
  JOIN slack_installations si ON si.id = l.installation_id
  JOIN slack_apps a ON a.app_id = si.app_id AND a.workspace_id = l.workspace_id`;

const targetOf = (row: Raw) => ({
  sessionLinkId: row.session_link_id as string,
  sessionId: row.session_id as string,
  workspaceId: row.workspace_id as string,
  slackAppId: row.slack_app_id as string,
  channelId: row.channel_id as string,
  threadTs: row.thread_id as string,
});

const fenced = (fence: SlackThreadStatusFence) =>
  sql`session_link_id = ${fence.sessionLinkId} AND claim_token = ${fence.claimToken}`;

const RELEASED = sql`claim_token = NULL, lease_expires_at = NULL, inflight_at = NULL`;

// Drizzle leaves a column of the only table unqualified, which a subquery
// over another table with an `id` would take for its own.
const SESSION_ID = sql.raw(`"sessions"."id"`);

export function createPostgresSlackThreadStatusStore(
  db: Database,
): SlackThreadStatusStore {
  const factsOf = async (sessionIds: string[]) => {
    if (sessionIds.length === 0)
      return new Map<string, SlackThreadStatusFacts>();
    const turnIs = (statuses: SQL) =>
      sql<boolean>`EXISTS (SELECT 1 FROM turns t WHERE t.session_id = ${SESSION_ID} AND t.status IN (${statuses}))`;
    const rows = await db
      .select({
        id: sessions.id,
        admissionState: sessions.admissionState,
        executionRevoked: sql<boolean>`${sessions.executionRevokedAt} IS NOT NULL`,
        checkpointRevision: sessions.checkpointRevision,
        unknownTurn: turnIs(sql`'outcome_unknown'`),
        runningTurn: turnIs(sql`'running', 'needs_input'`),
        queuedTurn: turnIs(sql`'queued'`),
        answerableRequest: exists(actionableOfSession(db)),
        requestedPushes: sql<
          { checkpoint_revision: number; git_commit: string; origin: string }[]
        >`coalesce((
          SELECT json_agg(json_build_object(
            'checkpoint_revision', p.checkpoint_revision,
            'git_commit', p.git_commit,
            'origin', p.origin) ORDER BY p.created_at)
          FROM push_requests p
          WHERE p.session_id = ${SESSION_ID} AND p.state = 'requested'
        ), '[]'::json)`,
        actionStages: sql<
          { kind: "push_intent" | "pull_request"; id: string; state: string }[]
        >`coalesce((
          SELECT json_agg(stage ORDER BY stage.created_at) FROM (
            SELECT 'push_intent' AS kind, i.id, i.status AS state, i.created_at
            FROM push_intents i
            WHERE i.session_id = ${SESSION_ID} AND i.status IN ('deferred', 'pinned')
            UNION ALL
            SELECT 'pull_request', p.id, p.pr_state, p.created_at
            FROM push_requests p
            WHERE p.session_id = ${SESSION_ID} AND p.pr_state IN ('due', 'opening')
          ) stage
        ), '[]'::json)`,
      })
      .from(sessions)
      .where(
        sql`${sessions.id} IN (${sql.join(
          sessionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      );
    return new Map(
      rows.map((row) => [
        row.id,
        {
          admissionState: row.admissionState as AdmissionState,
          executionRevoked: Boolean(row.executionRevoked),
          unknownTurn: Boolean(row.unknownTurn),
          checkpointRevision: row.checkpointRevision,
          answerableRequest: Boolean(row.answerableRequest),
          runningTurn: Boolean(row.runningTurn),
          queuedTurn: Boolean(row.queuedTurn),
          actionStages: row.actionStages.map(({ kind, id, state }) => ({
            kind,
            id,
            state,
          })),
          requestedPushes: row.requestedPushes.map((push) => ({
            checkpointRevision: push.checkpoint_revision,
            gitCommit: push.git_commit,
            origin: push.origin as PushRequestOrigin,
          })),
        } satisfies SlackThreadStatusFacts,
      ]),
    );
  };

  // Design §4 rule 6, one statement whatever holds the lease: the bound is
  // computed from the columns before the update, and never moves next_at
  // earlier than a Retry-After or an earlier bound.
  const recordUncertain = (start: SQL, windowMs: number) => sql`
    uncertain_rev = uncertain_rev + 1,
    uncertain_latest_at = greatest(uncertain_latest_at, ${start}),
    next_at = greatest(next_at, greatest(uncertain_latest_at, ${start}) + ${ms(windowMs)})`;

  return {
    async expireInflight({ graceMs, windowMs }) {
      const rows = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status SET
            ${recordUncertain(sql`inflight_at`, windowMs)},
            ${RELEASED}
          WHERE inflight_at IS NOT NULL
            AND lease_expires_at + ${ms(graceMs)} <= now()
          RETURNING session_link_id`,
      );
      return rows.length;
    },

    async claim({ limit, leaseMs, graceMs }) {
      const rows = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status st SET
            claim_token = gen_random_uuid(),
            lease_expires_at = now() + ${ms(leaseMs)}
          FROM (
            SELECT c.session_link_id, c.claim_token IS NOT NULL AS inherited
            FROM slack_thread_status c
            JOIN session_links l ON l.id = c.session_link_id
            WHERE ${LIVE_LINK}
              AND c.disabled_reason IS NULL
              AND c.inflight_at IS NULL
              AND (c.claim_token IS NULL OR c.lease_expires_at + ${ms(graceMs)} <= now())
              AND (c.next_at IS NULL OR c.next_at <= now())
              AND (c.dirty_rev > c.sent_rev OR c.uncertain_latest_at IS NOT NULL)
            ORDER BY c.next_at NULLS FIRST, c.session_link_id
            LIMIT ${limit}
            FOR UPDATE OF c SKIP LOCKED
          ) pick, session_links l ${TARGET_JOIN}
          WHERE st.session_link_id = pick.session_link_id
            AND l.id = st.session_link_id
          RETURNING ${TARGET}, st.claim_token, st.dirty_rev, st.uncertain_rev,
            st.uncertain_latest_at IS NOT NULL AS uncertain, pick.inherited,
            st.sent_status, st.sent_at`,
      );
      return rows.map(
        (row): SlackThreadStatusClaim => ({
          ...targetOf(row),
          claimToken: row.claim_token as string,
          dirtyRev: Number(row.dirty_rev),
          uncertainRev: Number(row.uncertain_rev),
          uncertain: Boolean(row.uncertain),
          inherited: Boolean(row.inherited),
          sentStatus: (row.sent_status as string | null) ?? null,
          sentAt: dateOf(row.sent_at),
        }),
      );
    },

    async facts(sessionId) {
      return (await factsOf([sessionId])).get(sessionId) ?? null;
    },

    async beginSend(fence, minLeaseLeftMs) {
      const [row] = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status SET inflight_at = now()
          WHERE ${fenced(fence)}
            AND NOT EXISTS (
              SELECT 1 FROM session_links ll
              WHERE ll.id = slack_thread_status.session_link_id
                AND ${channelLeft(sql`ll.installation_id`, sql`ll.channel_id`)}
            )
            AND lease_expires_at > now() + ${ms(minLeaseLeftMs)}
          RETURNING inflight_at`,
      );
      return row === undefined ? null : dateOf(row.inflight_at);
    },

    async finish(fence, sent) {
      // inflight_at is this send's own start, to the microsecond.
      const rows = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status SET
            sent_rev = greatest(sent_rev, ${sent.dirtyRev}),
            sent_status = ${sent.status},
            sent_at = inflight_at,
            uncertain_latest_at = CASE
              WHEN uncertain_rev = ${sent.uncertainRev}
                AND inflight_at >= uncertain_latest_at + ${ms(sent.windowMs)}
              THEN NULL ELSE uncertain_latest_at END,
            next_at = CASE
              WHEN uncertain_rev = ${sent.uncertainRev}
                AND inflight_at >= uncertain_latest_at + ${ms(sent.windowMs)}
              THEN NULL ELSE next_at END,
            ${RELEASED}
          WHERE ${fenced(fence)} AND inflight_at IS NOT NULL
          RETURNING session_link_id`,
      );
      return rows.length > 0;
    },

    async skip(fence, dirtyRev) {
      const rows = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status SET
            sent_rev = greatest(sent_rev, ${dirtyRev}),
            ${RELEASED}
          WHERE ${fenced(fence)}
          RETURNING session_link_id`,
      );
      return rows.length > 0;
    },

    async uncertain(fence, startedAt, windowMs) {
      // The row's own start while the lease is still this writer's; the
      // writer's reading of it otherwise.
      const start = sql`coalesce(
        CASE WHEN claim_token = ${fence.claimToken} THEN inflight_at END,
        ${startedAt.toISOString()}::timestamptz)`;
      await db.execute(sql`
        UPDATE slack_thread_status SET
          ${recordUncertain(start, windowMs)},
          inflight_at = CASE WHEN claim_token = ${fence.claimToken} THEN NULL ELSE inflight_at END,
          lease_expires_at = CASE WHEN claim_token = ${fence.claimToken} THEN NULL ELSE lease_expires_at END,
          claim_token = CASE WHEN claim_token = ${fence.claimToken} THEN NULL ELSE claim_token END
        WHERE session_link_id = ${fence.sessionLinkId}`);
    },

    async defer(fence, retryInMs) {
      const rows = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status SET
            next_at = greatest(next_at, now() + ${ms(retryInMs)}),
            ${RELEASED}
          WHERE ${fenced(fence)}
          RETURNING session_link_id`,
      );
      return rows.length > 0;
    },

    async disable(fence, reason) {
      const rows = await rowsOf(
        db,
        sql`
          UPDATE slack_thread_status SET
            disabled_reason = ${reason},
            disabled_at = now(),
            ${RELEASED}
          WHERE ${fenced(fence)}
          RETURNING session_link_id`,
      );
      return rows.length > 0;
    },

    async reconcileBatch({ limit, disabledForMs }) {
      await db.execute(sql`
        UPDATE slack_thread_status st SET
          disabled_reason = NULL,
          disabled_at = NULL,
          dirty_rev = st.dirty_rev + 1
        FROM session_links l
        JOIN slack_installations i ON i.id = l.installation_id
        WHERE l.id = st.session_link_id
          AND st.disabled_reason IS NOT NULL
          AND (st.disabled_at + ${ms(disabledForMs)} <= now()
            OR i.verified_at > st.disabled_at)`);
      const rows = await rowsOf(
        db,
        sql`
          SELECT ${TARGET}, st.sent_status, st.sent_at
          FROM session_links l
          ${TARGET_JOIN}
          LEFT JOIN slack_thread_status st ON st.session_link_id = l.id
          WHERE ${LIVE_LINK}
            AND (st.session_link_id IS NULL OR (
              st.sent_status IS DISTINCT FROM 'closed'
              AND st.disabled_reason IS NULL))
          ORDER BY st.reconciled_at NULLS FIRST, l.id
          LIMIT ${limit}`,
      );
      const facts = await factsOf(rows.map((row) => row.session_id as string));
      return rows.flatMap((row): SlackThreadStatusReconcile[] => {
        const found = facts.get(row.session_id as string);
        return found === undefined
          ? []
          : [
              {
                ...targetOf(row),
                sentStatus: (row.sent_status as string | null) ?? null,
                sentAt: dateOf(row.sent_at),
                facts: found,
              },
            ];
      });
    },

    async reconciled(marks) {
      if (marks.length === 0) return;
      const values = sql.join(
        marks.map(
          (mark) => sql`(${mark.sessionLinkId}::uuid, ${mark.dirty}::boolean)`,
        ),
        sql`, `,
      );
      // A new row is due either way (dirty_rev over sent_rev 0); on an
      // existing one the inserted rev less one is the step.
      await db.execute(sql`
        INSERT INTO slack_thread_status AS st (session_link_id, reconciled_at, dirty_rev)
        SELECT v.id, now(), CASE WHEN v.dirty THEN 2 ELSE 1 END
        FROM (VALUES ${values}) AS v(id, dirty)
        ORDER BY v.id
        ON CONFLICT (session_link_id) DO UPDATE SET
          reconciled_at = now(),
          dirty_rev = st.dirty_rev + EXCLUDED.dirty_rev - 1`);
    },
  };
}

/** Raises the dirty rev of a session's live links (a post in its thread). */
export async function touchSlackThreadStatus(
  db: Database,
  sessionId: string,
): Promise<void> {
  await db.execute(sql`SELECT slack_thread_status_touch(${sessionId}::uuid)`);
}
