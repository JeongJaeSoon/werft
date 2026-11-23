import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  DEFAULT_USER_LOCALE,
  type PushRequestOrigin,
  pendingQuestionSchema,
  type RuntimeKind,
  rememberRuleSchema,
  type SessionEventPayload,
  SLACK_USER_CHANNEL_CODE,
  slackOutboxChannelRefused,
  type UserLocale,
  withStoredNeutralFields,
} from "@werft-ai/contracts";
import type {
  NeutralizeEvent,
  SlackCardClaim,
  SlackCardFence,
  SlackCardRendered,
  SlackCardSettleStore,
  SlackOpenPushCard,
  SlackOutboxFence,
  SlackOutboxStore,
  SlackPendingPrompt,
  SlackPromptCard,
  SlackUnansweredTurn,
  SlackUnpostedInstruction,
  StoredSourceSet,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { releaseSuperseded } from "../agents.ts";
import { UUID } from "../control-shared.ts";
import { lockedDeletedSource, outboxSources } from "../conversations/index.ts";
import {
  mirrorsInstructions,
  postsPrompts,
  reportsTurns,
} from "../link-posting.ts";
import {
  catalogName,
  createPostgresPushRequests,
  toolSummaryContext,
} from "../push-requests.ts";
import type { Database } from "../queries.ts";
import {
  agents,
  attempts,
  events,
  linkedAccounts,
  pendingRequests,
  pushRequests,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  surfaceBindings,
  turns,
  users,
} from "../schema.ts";
import {
  actionableNow,
  actionableOfTurn,
  actionableRequest,
  CLOSE,
  createPostgresPendingRequests,
} from "../sessions/index.ts";
import { sqlLiterals } from "../sql-literals.ts";
import { rowsOf } from "../statement-rows.ts";
import { channelLeft } from "./slack-channel-left.ts";
import {
  closeHeldOfFailedMirror,
  inputMirrorThread,
  markMirrorUnconfirmed,
  mirrorFailed,
  mirrorPosted,
} from "./slack-input-holds.ts";
import { ms, type Raw, released } from "./slack-shared.ts";
import {
  createPostgresSlackThreadStatusStore,
  touchSlackThreadStatus,
} from "./slack-thread-status.ts";

const t = slackOutbox;

/** An outbox row that names a Slack user as its channel (slackOutboxChannelRefused). */
export class SlackOutboxUserChannelError extends Error {
  readonly code = SLACK_USER_CHANNEL_CODE;

  constructor(readonly kind: string) {
    super(`A ${kind} outbox row may not name a Slack user as its channel`);
    this.name = "SlackOutboxUserChannelError";
  }
}

// A turn stopped before it had anything to post.
const STOPPED_TURNS = sqlLiterals(["interrupted", "cancelled"]);
// A turn that ended with something to post: its reply, its failure, or an
// outcome an operator may yet confirm.
const ENDED_WITH_POST = ["completed", "failed", "outcome_unknown"];
const ENDED_WITH_POST_TURNS = sqlLiterals(ENDED_WITH_POST);

const entry = {
  workspaceId: t.workspaceId,
  agentId: t.agentId,
  slackAppId: t.slackAppId,
  installationId: t.installationId,
  kind: t.kind,
  channelId: t.channelId,
  threadTs: t.threadTs,
  slackUserId: t.slackUserId,
  sessionId: t.sessionId,
  sessionLinkId: t.sessionLinkId,
  body: t.body,
  dedupeKey: t.dedupeKey,
  sources: t.sources,
  sourcesTurn: t.sourcesTurn,
  inputId: t.inputId,
  correlationId: t.correlationId,
  heldForInputId: t.heldForInputId,
};

// The fence alone, with no lease test: a claimed row whose lease ran out is
// either reclaimed (a new token) or, mid-send, moved to `uncertain` (no
// token), and both fail this.
const fenced = (fence: SlackOutboxFence) =>
  and(eq(t.id, fence.id), eq(t.claimToken, fence.claimToken));

// A turn asked from the web or the API after its thread was linked, with no
// `instruction` row yet, or, `settled`, none past its sends: an answer waits
// for it, a backoff included, so it never goes first. A platform turn has no
// channel; NULL here would make `NOT owesInstruction` drop its answer.
const owesInstruction = (turn: SQL, link: SQL, settled = false) => sql`(
  coalesce(${turn}.channel IN ('web', 'api'), false)
  AND ${turn}.created_at >= ${link}.created_at
  AND ${mirrorsInstructions(link)}
  AND NOT EXISTS (
    SELECT 1 FROM slack_outbox oi
    WHERE oi.dedupe_key = 'instruction:' || ${link}.id || ':' || ${turn}.sequence
      ${settled ? sql`AND oi.status NOT IN ('pending', 'sending')` : sql``}
  )
)`;

// The thread's language: that of whoever started the session, its first
// turn's actor, else the person whose message opened the link.
const starterLocale = sql<UserLocale | null>`(
  SELECT su.locale FROM users su
  WHERE su.id = coalesce(
    (SELECT st.actor_id FROM turns st
     WHERE st.session_id = ${sessionLinks.sessionId} AND st.sequence = 1),
    ${sessionLinks.createdBy}
  )
)`;

// The request id of a card's key: whatever follows the link id, which holds
// no colon (slackPromptDedupeKey).
const promptRequestId = (row: SQL, prefix: "prompt:" | "push:") => {
  const from = prefix.length + 1;
  return sql`substr(${row}.dedupe_key, ${sql.raw(String(from))} + position(':' in substr(${row}.dedupe_key, ${sql.raw(String(from))})))`;
};

// Only the notice that a channel waits for approval may go to a channel
// whose binding waits, or was rejected and has no live binding since. A
// channel the bot left takes nothing at all, a notice included: the bot is
// not in it.
const channelNotWaiting = (row: SQL) => sql`(
  NOT ${channelLeft(sql`${row}.installation_id`, sql`${row}.channel_id`)}
  AND (${row}.kind = 'notice' OR NOT EXISTS (
    SELECT 1 FROM surface_bindings b
    WHERE b.installation_id = ${row}.installation_id
      AND b.external_surface_id = ${row}.channel_id
      AND (
        (b.status = 'pending_approval' AND b.revoked_at IS NULL)
        OR (b.status = 'revoked' AND b.approved_at IS NULL
            AND b.surface_kind = 'private_channel')
      )
      AND NOT EXISTS (
        SELECT 1 FROM surface_bindings r
        WHERE r.installation_id = b.installation_id
          AND r.external_surface_id = b.external_surface_id
          AND r.status = 'ready' AND r.revoked_at IS NULL
      )
  ))
)`;

// Where a row may still go: an installation not revoked, for a session's row
// the link it names (a row from before the column: its session's link in its
// thread) still taking it (a
// `model_notice` is a direct message with no thread, so it skips that), and for an
// input notice its request still waiting: a card's own request, or, for a
// turn's notice from before the cards, any of its turn's. Checked again at
// claim, since a row can wait out a backoff after any of it changed.
const addressed = (db: Database, row: SQL) => sql`(
  ${requestWaits(db, row)}
  AND EXISTS (
    SELECT 1 FROM slack_installations i
    WHERE i.id = ${row}.installation_id AND i.status <> 'revoked'
  )
  AND ${channelNotWaiting(row)}
  AND (${row}.session_id IS NULL OR ${row}.kind = 'model_notice' OR EXISTS (
    SELECT 1 FROM session_links l
    WHERE l.id = ${row}.session_link_id AND ${linkTakes(row)}
  ) OR (${row}.session_link_id IS NULL AND EXISTS (
    SELECT 1 FROM session_links l
    WHERE l.session_id = ${row}.session_id
      AND l.installation_id = ${row}.installation_id
      AND l.channel_id = ${row}.channel_id
      AND l.thread_id = ${row}.thread_ts
      AND ${linkTakes(row)}
  )))
)`;

// A closed link takes no new row but the notice that one of its own rows
// went uncertain: its last report must not vanish unconfirmed. The share
// lock orders this against closeFinishedLinks.
async function linkTakesNew(
  tx: Database,
  linkId: string,
  dedupeKey: string,
): Promise<boolean> {
  const [link] = await tx
    .select({ closedAt: sessionLinks.closedAt })
    .from(sessionLinks)
    .where(eq(sessionLinks.id, linkId))
    .for("share");
  if (link === undefined || link.closedAt === null) return true;
  const lost = dedupeKey.startsWith(UNCERTAIN_PREFIX)
    ? dedupeKey.slice(UNCERTAIN_PREFIX.length)
    : null;
  if (lost === null || !UUID.test(lost)) return false;
  const [own] = await tx
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, lost), eq(t.sessionLinkId, linkId)))
    .limit(1);
  return own !== undefined;
}

const UNCERTAIN_PREFIX = "uncertain:";

// Whether link `l` still takes the row: not revoked, unmuted, and posting
// the row's kind. Not `closed_at`: a closed link's last report still goes.
const linkTakes = (row: SQL) => sql`(
  l.revoked_at IS NULL
  AND NOT l.muted
  AND CASE ${row}.kind
    WHEN 'instruction' THEN ${mirrorsInstructions(sql.raw("l"))}
    WHEN 'input_notice' THEN ${postsPrompts(sql.raw("l"))}
    ELSE ${reportsTurns(sql.raw("l"))}
  END
)`;

// An input notice's request still waits on a person: a card's own request,
// or, for a turn's notice from before the cards, any of its turn's. The
// same rule the card's buttons stay up under (design slack-approval-ui §4).
const requestWaits = (db: Database, row: SQL) => sql`(
  CASE WHEN ${row}.kind = 'input_notice' AND ${row}.dedupe_key LIKE 'prompt:%' THEN EXISTS (
    ${actionableRequest(db, promptRequestId(row, "prompt:"), sql`${row}.session_id`)}
  ) WHEN ${row}.kind = 'input_notice' AND ${row}.dedupe_key LIKE 'push:%' THEN EXISTS (
    SELECT 1 FROM push_requests p
    WHERE p.id::text = ${promptRequestId(row, "push:")}
      AND p.session_id = ${row}.session_id
      AND p.state = 'requested'
  ) WHEN ${row}.kind = 'input_notice' THEN EXISTS (
    SELECT 1 FROM ${turns}
    WHERE ${turns.sessionId} = ${row}.session_id
      AND ${turns.sequence} = split_part(${row}.dedupe_key, ':', 3)::int
      AND EXISTS (${actionableOfTurn(db)})
  ) ELSE true END
)`;

/** A question request's card, or none when its stored questions are bad. */
// A stored offer that does not parse is no offer: the card then has no
// session button rather than one the answer path would refuse.
function rememberOfferOf(
  stored: unknown,
): { rememberOffer: { toolName: string; ruleContent?: string }[] } | object {
  const parsed = rememberRuleSchema.array().min(1).safeParse(stored);
  if (!parsed.success) return {};
  return {
    rememberOffer: parsed.data.map((rule) => ({
      toolName: rule.tool_name,
      ...(rule.rule_content === undefined
        ? {}
        : { ruleContent: rule.rule_content }),
    })),
  };
}

function questionPrompt({
  requestId,
  stored,
  expiresAt,
  ...row
}: Omit<SlackPendingPrompt, "prompt"> & {
  requestId: string;
  stored: { kind?: string; questions?: unknown };
  expiresAt: Date;
}): SlackPendingPrompt[] {
  const questions = pendingQuestionSchema
    .array()
    .min(1)
    .safeParse(stored.questions);
  return stored.kind === "question" && questions.success
    ? [
        {
          ...row,
          prompt: {
            kind: "question",
            requestId,
            questions: questions.data,
            expiresAt: expiresAt.toISOString(),
          },
        },
      ]
    : [];
}

/**
 * A posted card's request as stored, for its redraw: in the card's own
 * language, with where and by whom it was decided. Null for a key that
 * names no card, or a request outside the owner's sessions.
 */
async function promptCardOf(
  db: Database,
  row: {
    ownerId: string;
    workspaceId: string;
    teamId: string;
    dedupeKey: string;
    body: unknown;
    sessionId: string;
  },
): Promise<SlackPromptCard | null> {
  const [prefix, , ...rest] = row.dedupeKey.split(":");
  const requestId = rest.join(":");
  let display: SlackPromptCard["display"] | null = null;
  let decidedVia: SlackPromptCard["decidedVia"] = null;
  let pushRevisions: SlackPromptCard["pushRevisions"];
  if (prefix === "push") {
    const push = await createPostgresPushRequests(db).displayOf(
      row.ownerId,
      row.sessionId,
      requestId,
    );
    if (push === null) return null;
    display = { kind: "push", ...push };
    const [facts] = await db
      .select({
        principal: sql<
          string | null
        >`${pushRequests.decidedBy} -> 'principal' ->> 'kind'`,
        request: pushRequests.checkpointRevision,
        origin: pushRequests.origin,
        session: sessions.checkpointRevision,
      })
      .from(pushRequests)
      .innerJoin(sessions, eq(sessions.id, pushRequests.sessionId))
      .where(eq(pushRequests.id, requestId.toLowerCase()))
      .limit(1);
    if (facts !== undefined) {
      // A Slack press decides as the installation; anyone else is the web's.
      decidedVia =
        facts.principal === null
          ? null
          : facts.principal === "installation"
            ? "slack"
            : "web";
      pushRevisions = {
        session: facts.session,
        request: facts.request,
        origin: facts.origin as PushRequestOrigin,
      };
    }
  } else if (prefix === "prompt") {
    display = await createPostgresPendingRequests(db).displayOf(
      row.ownerId,
      row.sessionId,
      requestId,
    );
    if (display === null) return null;
    const [facts] = await db
      .select({ surface: pendingRequests.answerSurface })
      .from(pendingRequests)
      .where(
        and(
          eq(pendingRequests.requestId, requestId),
          eq(pendingRequests.sessionId, row.sessionId),
        ),
      )
      .limit(1);
    const surface = facts?.surface ?? null;
    decidedVia =
      surface === null ? null : surface === "slack" ? "slack" : "web";
  }
  if (display === null) return null;
  let deciderSlackUserId: string | null = null;
  if (display.decidedByUserId !== null) {
    const [linked] = await db
      .select({ slackUserId: linkedAccounts.externalUserId })
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.workspaceId, row.workspaceId),
          eq(linkedAccounts.userId, display.decidedByUserId),
          eq(linkedAccounts.provider, "slack"),
          eq(linkedAccounts.externalTenant, row.teamId),
          eq(linkedAccounts.status, "active"),
        ),
      )
      .limit(1);
    deciderSlackUserId = linked?.slackUserId ?? null;
  }
  const body = row.body as { locale?: UserLocale; link_url?: string };
  return {
    locale: body.locale ?? DEFAULT_USER_LOCALE,
    linkUrl: body.link_url ?? null,
    decidedVia,
    deciderSlackUserId,
    display,
    ...(pushRevisions === undefined ? {} : { pushRevisions }),
  };
}

// The sent cards a redraw may still be owed (slack_outbox_settle_idx).
const SENT_CARD = sql`
  o.kind = 'input_notice' AND o.status = 'sent' AND o.slack_ts IS NOT NULL
  AND o.settle_state IS DISTINCT FROM 'abandoned'`;

// Every SlackCardChoice: the card still waits on its request.
const CHOICES = sql.raw(
  "('open', 'reject_only', 'open_requester_left', 'reject_only_requester_left')",
);

const SHOWS_CHOICE = sql`coalesce(o.settle_rendered, 'open') IN ${CHOICES}`;

const cardFenced = (fence: SlackCardFence) =>
  sql`id = ${fence.id} AND settle_claim_token = ${fence.claimToken}`;

const CARD_RELEASED = sql`
  settle_claim_token = NULL, settle_lease_expires_at = NULL,
  settle_inflight_at = NULL`;

// What a drawn card leaves the row: open or reject-only waits for the next
// change, an end state is final.
const settledAs = (rendered: SQL) =>
  sql`CASE WHEN coalesce(${rendered}, 'open') IN ${CHOICES} THEN NULL ELSE 'settled' END`;

/** The `slack` role's redraws of posted cards (design slack-approval-ui §4). */
function createPostgresSlackCardSettleStore(
  db: Database,
): SlackCardSettleStore {
  // Design §4 rule 6, as the thread status writer has it.
  const recordUncertain = (start: SQL, windowMs: number) => sql`
    settle_uncertain_rev = settle_uncertain_rev + 1,
    settle_uncertain_latest_at = greatest(settle_uncertain_latest_at, ${start}),
    settle_next_at = greatest(settle_next_at, greatest(settle_uncertain_latest_at, ${start}) + ${ms(windowMs)})`;

  const markDueWhere = async (where: SQL) =>
    (
      await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox o SET settle_state = 'due'
          WHERE ${SENT_CARD} AND ${where}
          RETURNING o.id`),
      )
    ).length;

  return {
    markDue() {
      return markDueWhere(
        sql`o.settle_state IS NULL AND ${SHOWS_CHOICE}
          AND NOT ${requestWaits(db, sql.raw("o"))}`,
      );
    },

    async markDueAt(card) {
      return (
        (await markDueWhere(
          sql`o.channel_id = ${card.channelId} AND o.slack_ts = ${card.slackTs}`,
        )) > 0
      );
    },

    async markPushCardsDueIn({ installationId, channelId, windowMs }) {
      const inChannel = sql`${SENT_CARD} AND ${SHOWS_CHOICE}
        AND o.dedupe_key LIKE 'push:%'
        AND o.installation_id = ${installationId}
        AND o.channel_id = ${channelId}`;
      // One statement, so a redraw's finish lands wholly before or after it.
      // A card being drawn now may have read the membership before this
      // change: its edit is taken as uncertain (as recordUncertain does), so
      // finish keeps it owed and it is drawn again a window later.
      const drawing = sql`o.settle_claim_token IS NOT NULL`;
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox o SET
            settle_state = 'due',
            settle_uncertain_rev = settle_uncertain_rev
              + CASE WHEN ${drawing} THEN 1 ELSE 0 END,
            settle_uncertain_latest_at = CASE WHEN ${drawing}
              THEN greatest(settle_uncertain_latest_at, now())
              ELSE settle_uncertain_latest_at END,
            settle_next_at = CASE WHEN ${drawing}
              THEN greatest(settle_next_at,
                greatest(settle_uncertain_latest_at, now()) + ${ms(windowMs)})
              ELSE settle_next_at END
          WHERE ${inChannel}
            AND (o.settle_state IS NULL OR ${drawing})
          RETURNING o.id`),
      );
      return rows.length;
    },

    async markDueById(id) {
      return (
        (await markDueWhere(sql`o.id = ${id} AND o.settle_state IS NULL`)) > 0
      );
    },

    async openPushCards({ limit, afterSeq }) {
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          SELECT o.id, o.seq, o.session_id, coalesce(o.settle_rendered, 'open') AS rendered,
            s.checkpoint_revision AS session_revision,
            p.checkpoint_revision, p.git_commit, p.origin
          FROM slack_outbox o
          JOIN push_requests p
            ON p.id::text = ${promptRequestId(sql.raw("o"), "push:")}
            AND p.session_id = o.session_id
          JOIN sessions s ON s.id = o.session_id
          WHERE ${SENT_CARD} AND o.settle_state IS NULL
            AND o.dedupe_key LIKE 'push:%' AND p.state = 'requested'
            AND ${SHOWS_CHOICE}
            AND (s.checkpoint_revision IS DISTINCT FROM p.checkpoint_revision
              OR o.settle_rendered LIKE 'reject_only%')
            AND (${afterSeq}::bigint IS NULL OR o.seq > ${afterSeq}::bigint)
          ORDER BY o.seq
          LIMIT ${limit}`),
      );
      return rows.map((row) => ({
        id: row.id as string,
        seq: Number(row.seq),
        sessionId: row.session_id as string,
        rendered: row.rendered as SlackOpenPushCard["rendered"],
        sessionCheckpointRevision:
          row.session_revision === null ? null : Number(row.session_revision),
        checkpointRevision: Number(row.checkpoint_revision),
        gitCommit: row.git_commit as string,
        origin: row.origin as PushRequestOrigin,
      }));
    },

    async expireInflight({ graceMs, windowMs }) {
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox SET
            ${recordUncertain(sql`settle_inflight_at`, windowMs)},
            ${CARD_RELEASED}
          WHERE settle_inflight_at IS NOT NULL
            AND settle_lease_expires_at + ${ms(graceMs)} <= now()
          RETURNING id`),
      );
      return rows.length;
    },

    async claim({ limit, leaseMs, graceMs, only }) {
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox st SET
            settle_claim_token = gen_random_uuid(),
            settle_lease_expires_at = now() + ${ms(leaseMs)}
          FROM (
            SELECT o.id, o.settle_claim_token IS NOT NULL AS inherited
            FROM slack_outbox o
            WHERE ${SENT_CARD}
              AND NOT ${channelLeft(sql`o.installation_id`, sql`o.channel_id`)}
              AND o.settle_inflight_at IS NULL
              AND (o.settle_claim_token IS NULL
                OR o.settle_lease_expires_at + ${ms(graceMs)} <= now())
              AND (o.settle_next_at IS NULL OR o.settle_next_at <= now())
              AND (o.settle_state = 'due' OR o.settle_uncertain_latest_at IS NOT NULL)
              ${only === undefined ? sql`` : sql`AND o.channel_id = ${only.channelId} AND o.slack_ts = ${only.slackTs}`}
            ORDER BY o.settle_next_at NULLS FIRST, o.seq
            LIMIT ${limit}
            FOR UPDATE OF o SKIP LOCKED
          ) pick
          WHERE st.id = pick.id
          RETURNING st.id, st.settle_claim_token, st.workspace_id,
            st.slack_app_id, st.session_id, st.channel_id, st.slack_ts,
            st.dedupe_key, st.body, st.settle_rendered, st.settle_uncertain_rev,
            st.settle_uncertain_latest_at IS NOT NULL AS uncertain,
            pick.inherited, st.settle_attempts`),
      );
      return rows.map(
        (row): SlackCardClaim => ({
          id: row.id as string,
          claimToken: row.settle_claim_token as string,
          workspaceId: row.workspace_id as string,
          slackAppId: row.slack_app_id as string,
          sessionId: (row.session_id as string | null) ?? null,
          channelId: row.channel_id as string,
          slackTs: row.slack_ts as string,
          dedupeKey: row.dedupe_key as string,
          body: row.body as SlackCardClaim["body"],
          rendered: (row.settle_rendered as SlackCardRendered | null) ?? null,
          uncertainRev: Number(row.settle_uncertain_rev),
          uncertain: Boolean(row.uncertain),
          inherited: Boolean(row.inherited),
          attempts: Number(row.settle_attempts),
        }),
      );
    },

    async card(claim) {
      const [row] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: slackOutbox.workspaceId,
          teamId: slackInstallations.teamId,
          dedupeKey: slackOutbox.dedupeKey,
          body: slackOutbox.body,
          sessionId: slackOutbox.sessionId,
        })
        .from(slackOutbox)
        .innerJoin(sessions, eq(sessions.id, slackOutbox.sessionId))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, slackOutbox.installationId),
        )
        .where(eq(slackOutbox.id, claim.id))
        .limit(1);
      if (!row || row.sessionId === null) return null;
      return promptCardOf(db, { ...row, sessionId: row.sessionId });
    },

    async turnWaits(claim) {
      const [row] = await rowsOf<Raw>(
        await db.execute(sql`SELECT ${requestWaits(db, sql.raw("o"))} AS waits
          FROM slack_outbox o WHERE o.id = ${claim.id}`),
      );
      return Boolean(row?.waits);
    },

    async beginSend(fence, minLeaseLeftMs) {
      const [row] = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox SET settle_inflight_at = now()
          WHERE ${cardFenced(fence)}
            AND NOT ${channelLeft(sql`slack_outbox.installation_id`, sql`slack_outbox.channel_id`)}
            AND settle_lease_expires_at > now() + ${ms(minLeaseLeftMs)}
          RETURNING settle_inflight_at`),
      );
      return row === undefined
        ? null
        : new Date(row.settle_inflight_at as string);
    },

    async finish(fence, sent) {
      // settle_inflight_at is this edit's own start, to the microsecond.
      const clears = sql`settle_uncertain_rev = ${sent.uncertainRev}
        AND settle_inflight_at >= settle_uncertain_latest_at + ${ms(sent.windowMs)}`;
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox SET
            settle_rendered = ${sent.rendered},
            settle_state = ${settledAs(sql`${sent.rendered}::text`)},
            settle_error = NULL,
            settle_uncertain_latest_at = CASE WHEN ${clears}
              THEN NULL ELSE settle_uncertain_latest_at END,
            settle_next_at = CASE WHEN ${clears}
              THEN NULL ELSE settle_next_at END,
            ${CARD_RELEASED}
          WHERE ${cardFenced(fence)} AND settle_inflight_at IS NOT NULL
          RETURNING id`),
      );
      return rows.length > 0;
    },

    async skip(fence) {
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox SET
            settle_state = ${settledAs(sql`settle_rendered`)},
            ${CARD_RELEASED}
          WHERE ${cardFenced(fence)}
          RETURNING id`),
      );
      return rows.length > 0;
    },

    async uncertain(fence, startedAt, windowMs) {
      // The row's own start while the lease is still this writer's; the
      // writer's reading of it otherwise.
      const mine = sql`settle_claim_token = ${fence.claimToken}`;
      const start = sql`coalesce(
        CASE WHEN ${mine} THEN settle_inflight_at END,
        ${startedAt.toISOString()}::timestamptz)`;
      await db.execute(sql`
        UPDATE slack_outbox SET
          ${recordUncertain(start, windowMs)},
          settle_inflight_at = CASE WHEN ${mine} THEN NULL ELSE settle_inflight_at END,
          settle_lease_expires_at = CASE WHEN ${mine} THEN NULL ELSE settle_lease_expires_at END,
          settle_claim_token = CASE WHEN ${mine} THEN NULL ELSE settle_claim_token END
        WHERE id = ${fence.id}`);
    },

    async defer(fence, input) {
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox SET
            settle_next_at = greatest(settle_next_at, now() + ${ms(input.retryInMs)}),
            settle_attempts = settle_attempts + ${input.failed ? 1 : 0},
            settle_error = coalesce(${input.error}::text, settle_error),
            ${CARD_RELEASED}
          WHERE ${cardFenced(fence)}
          RETURNING id`),
      );
      return rows.length > 0;
    },

    async abandon(fence, error) {
      const rows = await rowsOf<Raw>(
        await db.execute(sql`
          UPDATE slack_outbox SET
            settle_state = 'abandoned',
            settle_error = ${error},
            ${CARD_RELEASED}
          WHERE ${cardFenced(fence)}
          RETURNING id`),
      );
      return rows.length > 0;
    },
  };
}

export function createPostgresSlackOutboxStore(
  db: Database,
  // Fills the neutral fields of an event stored before they were written,
  // so a reply read ahead of the fill still has its text.
  options: { neutralize?: NeutralizeEvent } = {},
): SlackOutboxStore {
  return {
    threadStatus: createPostgresSlackThreadStatusStore(db),

    async enqueue(input, whileHome) {
      if (slackOutboxChannelRefused(input.kind, input.channelId)) {
        throw new SlackOutboxUserChannelError(input.kind);
      }
      return db.transaction(async (tx) => {
        if (whileHome) {
          const [home] = await tx
            .select({ id: surfaceBindings.id })
            .from(surfaceBindings)
            .where(
              and(
                eq(surfaceBindings.id, whileHome.bindingId),
                eq(surfaceBindings.agentId, input.agentId),
                eq(surfaceBindings.home, true),
                eq(surfaceBindings.status, "ready"),
                ne(surfaceBindings.mode, "off"),
                isNull(surfaceBindings.revokedAt),
              ),
            )
            .for("share");
          const [live] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, input.agentId),
                eq(agents.activeReleaseId, whileHome.releaseId),
              ),
            )
            .for("share");
          if (!home || !live) return "not_home";
          // A statement of its own, after the lock: R1 → R2 → R1 leaves R1
          // active again, and only a newer activation says it is a rollback.
          if (await releaseSuperseded(tx, input.agentId, whileHome.releaseId)) {
            return "not_home";
          }
          if (input.kind === "welcome") {
            // The key covers one binding. A channel bound again after the
            // install was disconnected has a new binding, and older rows
            // keyed each release: the channel heard it all the same. Channel
            // ids are only unique within a Slack team.
            const team = tx
              .select({ teamId: slackInstallations.teamId })
              .from(slackInstallations)
              .where(eq(slackInstallations.id, input.installationId));
            const [heard] = await tx
              .select({ id: t.id })
              .from(t)
              .innerJoin(
                slackInstallations,
                eq(slackInstallations.id, t.installationId),
              )
              .where(
                and(
                  eq(t.kind, "welcome"),
                  eq(t.agentId, input.agentId),
                  eq(t.channelId, input.channelId),
                  inArray(slackInstallations.teamId, team),
                ),
              )
              .limit(1);
            if (heard) return "duplicate";
          }
        }
        if (
          input.sessionLinkId != null &&
          !(await linkTakesNew(tx, input.sessionLinkId, input.dedupeKey))
        ) {
          return "link_closed";
        }
        // A row of no session (an input's mirror) keeps its sources as given.
        const sources =
          input.sources == null
            ? null
            : input.sessionId === null
              ? input.sources
              : await outboxSources(tx, input.sessionId, input.sources);
        // A row bound for a web input's thread waits for its post, unless
        // the thread is known, or its mirror failed for good. The share
        // lock orders this against a settle, which locks the input before
        // it frees or closes the rows held for it.
        let place = {};
        if (input.heldForInputId != null) {
          await tx.execute(sql`
            SELECT 1 FROM conversation_inputs
            WHERE id = ${input.heldForInputId}::uuid FOR SHARE`);
          const thread = await inputMirrorThread(tx, input.heldForInputId);
          if (thread !== null) place = { ...thread, heldForInputId: null };
          else if (await mirrorFailed(tx, input.heldForInputId)) {
            place = { status: "failed", errorCode: "input_unplaced" };
          }
        }
        const [row] = await tx
          .insert(t)
          .values({ ...input, ...place, sources, id: randomUUID() })
          .onConflictDoNothing({ target: t.dedupeKey })
          .returning({ id: t.id });
        return row ? "enqueued" : "duplicate";
      });
    },

    async readerLocale(reader) {
      // A stale link still names who reads; at most one row is not revoked.
      const [row] = await db
        .select({ locale: users.locale })
        .from(linkedAccounts)
        .innerJoin(users, eq(users.id, linkedAccounts.userId))
        .where(
          and(
            eq(linkedAccounts.workspaceId, reader.workspaceId),
            eq(linkedAccounts.provider, "slack"),
            eq(linkedAccounts.externalTenant, reader.teamId),
            eq(linkedAccounts.externalUserId, reader.slackUserId),
            ne(linkedAccounts.status, "revoked"),
          ),
        )
        .limit(1);
      return row?.locale ?? null;
    },

    async advanceAnswered() {
      // Writes only links whose mark moves, so a quiet pass writes nothing.
      const rows = rowsOf<unknown>(
        await db.execute(sql`
        UPDATE session_links l SET answered_through = m.mark
        FROM (
          SELECT l2.id, coalesce(
            (SELECT min(t.sequence) - 1 FROM ${turns} t
             WHERE t.session_id = l2.session_id
               AND t.sequence > l2.answered_through
               AND NOT (
                 t.status IN (${STOPPED_TURNS})
                 OR (t.status IN (${ENDED_WITH_POST_TURNS})
                   AND t.created_at < l2.created_at)
                 -- Not outcome_unknown: an operator may yet confirm it
                 -- completed, and then it owes its reply.
                 OR (t.status IN ('completed', 'failed') AND EXISTS (
                   SELECT 1 FROM ${t} o
                   WHERE o.dedupe_key = (CASE WHEN t.status = 'completed' THEN 'reply' ELSE 'failure' END)
                     || ':' || l2.id || ':' || t.sequence
                 ))
               )),
            (SELECT max(t.sequence) FROM ${turns} t WHERE t.session_id = l2.session_id),
            0
          ) AS mark
          FROM session_links l2
          WHERE l2.session_id IS NOT NULL
            AND l2.revoked_at IS NULL
            AND NOT l2.muted
            AND ${reportsTurns(sql.raw("l2"))}
            AND l2.closed_at IS NULL
        ) m
        WHERE l.id = m.id AND m.mark > l.answered_through
        RETURNING l.id
      `),
      );
      return rows.length;
    },

    async closeFinishedLinks(limit) {
      // Owed nothing more: a muted link; one that reports turns, once its
      // mark is past the last turn (its last report is in); else no turn
      // still owes its instruction. Under the row locks, so an enqueue that
      // holds one is waited for.
      const rows = rowsOf<unknown>(
        await db.execute(sql`
        UPDATE session_links l SET closed_at = now(), closed_reason = c.reason
        FROM (
          SELECT l2.id, CASE WHEN EXISTS (
            SELECT 1 FROM idempotency_keys k
            JOIN receipts r ON r.id = k.receipt_id
            WHERE k.principal = s.owner_id::text
              AND k.operation = ${CLOSE}
              AND k.resource = s.id::text
              AND r.status IN ('accepted', 'succeeded')
          ) THEN 'completed' ELSE 'abandoned' END AS reason
          FROM session_links l2
          JOIN ${sessions} s ON s.id = l2.session_id
          WHERE s.admission_state = 'closed'
            AND l2.closed_at IS NULL
            AND l2.revoked_at IS NULL
            AND (l2.muted OR CASE WHEN ${reportsTurns(sql.raw("l2"))}
              THEN l2.answered_through >= coalesce(
                (SELECT max(t.sequence) FROM ${turns} t
                 WHERE t.session_id = l2.session_id), 0)
              ELSE NOT EXISTS (
                SELECT 1 FROM ${turns} ot
                WHERE ot.session_id = l2.session_id
                  AND ot.sequence > l2.answered_through
                  AND ot.status NOT IN (${STOPPED_TURNS})
                  AND ${owesInstruction(sql.raw("ot"), sql.raw("l2"))}
              ) END)
          ORDER BY l2.created_at
          LIMIT ${limit}
          FOR UPDATE OF l2 SKIP LOCKED
        ) c
        WHERE l.id = c.id
        RETURNING l.id
      `),
      );
      return rows.length;
    },

    async unpostedInstructions(limit) {
      const rows = await db
        .select({
          sessionLinkId: sessionLinks.id,
          sessionId: turns.sessionId,
          workspaceId: sessionLinks.workspaceId,
          agentId: sessionLinks.agentId,
          slackAppId: slackApps.id,
          installationId: sessionLinks.installationId,
          channelId: sessionLinks.channelId,
          threadTs: sessionLinks.threadId,
          turnId: turns.sequence,
          sources: turns.sources,
          channel: turns.channel,
          message: turns.message,
          senderName: users.displayName,
          senderSlackUserId: linkedAccounts.externalUserId,
          locale: starterLocale,
        })
        .from(sessionLinks)
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, sessionLinks.installationId),
        )
        .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
        .innerJoin(turns, eq(turns.sessionId, sessionLinks.sessionId))
        .leftJoin(users, eq(users.id, turns.actorId))
        .leftJoin(
          linkedAccounts,
          and(
            eq(linkedAccounts.workspaceId, sessionLinks.workspaceId),
            eq(linkedAccounts.userId, turns.actorId),
            eq(linkedAccounts.provider, "slack"),
            eq(linkedAccounts.externalTenant, slackInstallations.teamId),
            eq(linkedAccounts.status, "active"),
          ),
        )
        .where(
          and(
            isNull(sessionLinks.revokedAt),
            eq(sessionLinks.muted, false),
            mirrorsInstructions(sql.raw('"session_links"')),
            isNull(sessionLinks.closedAt),
            ne(slackInstallations.status, "revoked"),
            // By a range per link, as unansweredTurns finds its turns.
            sql`${turns.id} = ANY (ARRAY(
              SELECT open.id FROM session_links ol
              CROSS JOIN LATERAL (
                SELECT ot.id FROM ${turns} ot
                WHERE ot.session_id = ol.session_id
                  AND ot.sequence > ol.answered_through
                  AND ot.status NOT IN (${STOPPED_TURNS})
                  AND ${owesInstruction(sql.raw("ot"), sql.raw("ol"))}
                ORDER BY ot.sequence
                LIMIT ${limit}
              ) open
              WHERE ol.revoked_at IS NULL
                AND NOT ol.muted
                AND ${mirrorsInstructions(sql.raw("ol"))}
                AND ol.closed_at IS NULL
            ))`,
            sql`${owesInstruction(sql.raw('"turns"'), sql.raw('"session_links"'))}`,
          ),
        )
        .orderBy(
          asc(turns.createdAt),
          asc(turns.sessionId),
          asc(turns.sequence),
        )
        .limit(limit);
      return rows.flatMap(({ channel, ...row }): SlackUnpostedInstruction[] =>
        channel === "web" || channel === "api" ? [{ ...row, channel }] : [],
      );
    },

    async unmirroredInputs(limit) {
      // Where each goes: its topic's thread; else the top of its channel;
      // else, in a DM, the person's D channel a placed topic of the same
      // conversation (that person's and agent's alone) names.
      const rows = rowsOf<{
        input_id: ConversationInputId;
        workspace_id: string;
        agent_id: string;
        slack_app_id: string;
        installation_id: string;
        channel_id: string;
        thread_ts: string;
        body: string;
        sender_name: string | null;
        sender_slack_user_id: string | null;
        locale: UserLocale | null;
      }>(
        await db.execute(sql`
        SELECT i.id AS input_id, i.workspace_id, i.agent_id,
          a.id AS slack_app_id, inst.id AS installation_id,
          p.channel_id, p.thread_ts, i.body,
          u.display_name AS sender_name, la.external_user_id AS sender_slack_user_id,
          u.locale
        FROM conversation_inputs i
        JOIN conversation_topics tp ON tp.id = i.topic_id
        JOIN conversations c ON c.id = tp.conversation_id
        CROSS JOIN LATERAL (
          SELECT x.team_id, x.channel_id, x.thread_ts FROM (
            SELECT 1 AS rank, tp.slack_team_id AS team_id,
              tp.slack_channel_id AS channel_id, tp.slack_thread_ts AS thread_ts
            WHERE tp.slack_thread_ts IS NOT NULL
            UNION ALL
            SELECT 2, c.team_id, c.channel_id, ''
            WHERE c.kind = 'channel'
            UNION ALL
            (SELECT 3, o.slack_team_id, o.slack_channel_id, ''
             FROM conversation_topics o
             WHERE o.conversation_id = c.id AND o.agent_id = i.agent_id
               AND c.kind = 'dm' AND c.person_user_id::text = i.requester_id
               AND o.slack_channel_id IS NOT NULL
             ORDER BY o.created_at DESC, o.id
             LIMIT 1)
          ) x ORDER BY x.rank LIMIT 1
        ) p
        JOIN slack_apps a ON a.workspace_id = i.workspace_id
          AND a.agent_id = i.agent_id AND a.kind = 'agent' AND a.state = 'created'
        JOIN slack_installations inst ON inst.app_id = a.app_id
          AND inst.team_id = p.team_id AND inst.status <> 'revoked'
        JOIN users u ON u.id::text = i.requester_id
        LEFT JOIN linked_accounts la ON la.workspace_id = i.workspace_id
          AND la.user_id = u.id AND la.provider = 'slack'
          AND la.external_tenant = p.team_id AND la.status = 'active'
        WHERE i.slack_mirror = 'pending' AND i.slack_ts IS NULL
          AND i.requester_kind = 'user'
          AND NOT EXISTS (
            SELECT 1 FROM slack_outbox so
            WHERE so.dedupe_key = 'input_mirror:' || i.id::text)
          -- An unplaced topic waits on its first mirror, whose post places it.
          AND (tp.slack_thread_ts IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM conversation_inputs e
            WHERE e.topic_id = i.topic_id AND e.seq < i.seq
              AND e.slack_mirror IN ('pending', 'unconfirmed')
              AND e.slack_ts IS NULL))
        ORDER BY i.received_at, i.id
        LIMIT ${limit}`),
      );
      return rows.map((row) => ({
        inputId: row.input_id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        slackAppId: row.slack_app_id,
        installationId: row.installation_id,
        channelId: row.channel_id,
        threadTs: row.thread_ts,
        body: row.body,
        senderName: row.sender_name,
        senderSlackUserId: row.sender_slack_user_id,
        locale: row.locale,
      }));
    },

    async closeOverdueHeld(holdMs) {
      return db.transaction(async (tx) => {
        const overdue = await tx
          .select({ id: t.id, inputId: t.heldForInputId })
          .from(t)
          .where(
            and(
              sql`${t.heldForInputId} IS NOT NULL`,
              eq(t.status, "pending"),
              sql`${t.createdAt} <= now() - make_interval(secs => ${holdMs / 1000})`,
            ),
          );
        if (overdue.length === 0) return 0;
        // The inputs first, as a settle takes them, then only the rows read
        // above: the other order, or a row committed since, deadlocks with
        // a mirror's settle.
        const inputIds = [
          ...new Set(
            overdue.flatMap((row) =>
              row.inputId === null ? [] : [row.inputId],
            ),
          ),
        ];
        await tx.execute(sql`
          SELECT 1 FROM conversation_inputs
          WHERE id = ANY(${`{${inputIds.join(",")}}`}::uuid[])
          ORDER BY id FOR UPDATE`);
        const closed = await tx
          .update(t)
          .set({ status: "failed", errorCode: "input_unplaced", ...released })
          .where(
            and(
              inArray(
                t.id,
                overdue.map((row) => row.id),
              ),
              sql`${t.heldForInputId} IS NOT NULL`,
              eq(t.status, "pending"),
            ),
          )
          .returning({ inputId: t.heldForInputId });
        await markMirrorUnconfirmed(tx, [
          ...new Set(
            closed.flatMap((row) =>
              row.inputId === null ? [] : [row.inputId],
            ),
          ),
        ]);
        return closed.length;
      });
    },

    matchMirrorEcho(echo) {
      return db.transaction(async (tx) => {
        const candidates = await tx
          .select({
            id: t.id,
            workspaceId: t.workspaceId,
            inputId: t.inputId,
            installationId: t.installationId,
            channelId: t.channelId,
            threadTs: t.threadTs,
          })
          .from(t)
          .where(
            and(
              eq(t.correlationId, echo.correlationId),
              // The echo may come before Slack's answer to the send.
              inArray(t.status, ["sending", "uncertain"]),
              eq(t.kind, "input_mirror"),
              eq(t.workspaceId, echo.workspaceId),
              eq(t.slackAppId, echo.slackAppId),
              eq(t.channelId, echo.channelId),
            ),
          )
          .limit(2)
          .for("update");
        const [only] = candidates;
        if (only === undefined || only.inputId === null) return "no_candidate";
        if (candidates.length > 1) return "ambiguous";
        await tx
          .update(t)
          .set({
            status: "sent",
            slackTs: echo.ts,
            errorCode: null,
            ...released,
          })
          .where(eq(t.id, only.id));
        await mirrorPosted(tx, { ...only, inputId: only.inputId }, echo.ts);
        return "linked";
      });
    },

    async unansweredTurns(limit) {
      // The keys platform's slackTurnDedupeKey makes, spelled in SQL.
      const prefix = sql`CASE WHEN ${turns.status} = 'completed' THEN 'reply' ELSE 'failure' END`;
      const rows = await db
        .select({
          sessionLinkId: sessionLinks.id,
          sessionId: sessions.id,
          workspaceId: sessionLinks.workspaceId,
          agentId: sessionLinks.agentId,
          slackAppId: slackApps.id,
          installationId: sessionLinks.installationId,
          channelId: sessionLinks.channelId,
          threadTs: sessionLinks.threadId,
          turnRowId: turns.id,
          turnId: turns.sequence,
          sources: turns.sources,
          status: turns.status,
          attemptId: turns.attemptId,
          requesterSlackUserId: linkedAccounts.externalUserId,
          locale: starterLocale,
        })
        .from(sessionLinks)
        .innerJoin(sessions, eq(sessions.id, sessionLinks.sessionId))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, sessionLinks.installationId),
        )
        .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
        .innerJoin(turns, eq(turns.sessionId, sessionLinks.sessionId))
        .leftJoin(
          linkedAccounts,
          and(
            eq(linkedAccounts.workspaceId, sessionLinks.workspaceId),
            eq(
              linkedAccounts.userId,
              sql`coalesce(${turns.actorId}, ${sessionLinks.createdBy})`,
            ),
            eq(linkedAccounts.provider, "slack"),
            eq(linkedAccounts.externalTenant, slackInstallations.teamId),
            eq(linkedAccounts.status, "active"),
          ),
        )
        .where(
          and(
            // The turns past each live link's mark, found first by a range
            // per link; joined on its own, the planner sorts every turn. The
            // LIMIT keeps the range per link (unlimited, it is flattened
            // into a scan of all turns), and a pass takes no more anyway.
            // Turns with nothing left to send are skipped before it, so the
            // ones behind a turn holding the mark are still reached.
            sql`${turns.id} = ANY (ARRAY(
              SELECT open.id FROM session_links ol
              CROSS JOIN LATERAL (
                SELECT ot.id FROM ${turns} ot
                WHERE ot.session_id = ol.session_id
                  AND ot.sequence > ol.answered_through
                  AND ot.status IN (${ENDED_WITH_POST_TURNS})
                  AND ot.created_at >= ol.created_at
                  AND NOT EXISTS (
                    SELECT 1 FROM ${t} oo
                    WHERE oo.dedupe_key = (CASE WHEN ot.status = 'completed' THEN 'reply'
                        ELSE 'failure' END)
                      || ':' || ol.id || ':' || ot.sequence
                  )
                  AND NOT ${owesInstruction(sql.raw("ot"), sql.raw("ol"), true)}
                ORDER BY ot.sequence
                LIMIT ${limit}
              ) open
              WHERE ol.revoked_at IS NULL
                AND NOT ol.muted
                AND ${reportsTurns(sql.raw("ol"))}
                AND ol.closed_at IS NULL
            ))`,
            isNull(sessionLinks.revokedAt),
            // A muted thread, or one that hears of no turns, gets no answer.
            eq(sessionLinks.muted, false),
            reportsTurns(sql.raw('"session_links"')),
            isNull(sessionLinks.closedAt),
            ne(slackInstallations.status, "revoked"),
            inArray(turns.status, ENDED_WITH_POST),
            // A turn from before the thread is not the thread's to answer.
            gte(turns.createdAt, sessionLinks.createdAt),
            sql`NOT EXISTS (
              SELECT 1 FROM ${t} o
              WHERE o.dedupe_key = ${prefix} || ':' || ${sessionLinks.id} || ':' || ${turns.sequence}
            )`,
            sql`NOT ${owesInstruction(sql.raw('"turns"'), sql.raw('"session_links"'), true)}`,
          ),
        )
        // Not by turns.id, which walks every turn in the table; within a
        // thread, its own order.
        .orderBy(
          asc(turns.createdAt),
          asc(turns.sessionId),
          asc(turns.sequence),
        )
        .limit(limit);
      const completed = rows.filter(
        (row) => row.status === "completed" && row.attemptId !== null,
      );
      const said =
        completed.length === 0
          ? []
          : await db
              .select({
                turnId: events.turnId,
                type: events.type,
                payload: events.payload,
                neutral: events.neutral,
                runtimeKind: sql<RuntimeKind | null>`${sessions.runtimeSpec} -> 'runtime' ->> 'kind'`,
              })
              .from(events)
              .innerJoin(sessions, eq(sessions.id, events.sessionId))
              .innerJoin(
                turns,
                and(
                  eq(turns.id, events.turnId),
                  eq(turns.attemptId, events.attemptId),
                ),
              )
              .where(
                and(
                  inArray(
                    events.turnId,
                    completed.map((row) => row.turnRowId),
                  ),
                  inArray(events.type, ["assistant", "tool_use"]),
                  // Subagent output is the subagent's, not the turn's answer.
                  sql`${events.payload}->>'parent_tool_use_id' IS NULL`,
                ),
              )
              .orderBy(asc(events.turnId), asc(events.sourceSequence));
      return rows.map(
        ({ turnRowId, status, attemptId: _, ...row }): SlackUnansweredTurn => ({
          ...row,
          state: status === "completed" ? "completed" : "failed",
          events: said
            .filter((event) => event.turnId === turnRowId)
            .map(({ type, payload, neutral, runtimeKind }) => ({
              type,
              payload:
                neutral !== null || options.neutralize === undefined
                  ? withStoredNeutralFields(payload, neutral)
                  : options.neutralize(runtimeKind, {
                      event: type,
                      data: payload,
                    } as SessionEventPayload).data,
            })),
        }),
      );
    },

    async unpromptedRequests(limit) {
      const target = {
        sessionLinkId: sessionLinks.id,
        sessionId: sessions.id,
        workspaceId: sessionLinks.workspaceId,
        agentId: sessionLinks.agentId,
        slackAppId: slackApps.id,
        installationId: sessionLinks.installationId,
        channelId: sessionLinks.channelId,
        threadTs: sessionLinks.threadId,
        locale: starterLocale,
      };
      const live = and(
        isNull(sessionLinks.revokedAt),
        eq(sessionLinks.muted, false),
        postsPrompts(sql.raw('"session_links"')),
        isNull(sessionLinks.closedAt),
        ne(slackInstallations.status, "revoked"),
      );
      const requester = (actorId: SQL) =>
        and(
          eq(linkedAccounts.workspaceId, sessionLinks.workspaceId),
          eq(
            linkedAccounts.userId,
            sql`coalesce(${actorId}, ${sessionLinks.createdBy})`,
          ),
          eq(linkedAccounts.provider, "slack"),
          eq(linkedAccounts.externalTenant, slackInstallations.teamId),
          eq(linkedAccounts.status, "active"),
        );
      const asked = await db
        .select({
          ...target,
          requesterSlackUserId: linkedAccounts.externalUserId,
          requestId: pendingRequests.requestId,
          sources: turns.sources,
          sourcesTurn: turns.sequence,
          payload: pendingRequests.payload,
          expiresAt: pendingRequests.expiresAt,
        })
        .from(pendingRequests)
        .innerJoin(sessions, eq(sessions.id, pendingRequests.sessionId))
        .innerJoin(attempts, eq(attempts.id, pendingRequests.attemptId))
        .innerJoin(turns, eq(turns.id, pendingRequests.turnId))
        .innerJoin(sessionLinks, eq(sessionLinks.sessionId, sessions.id))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, sessionLinks.installationId),
        )
        .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
        .leftJoin(linkedAccounts, requester(sql`${turns.actorId}`))
        .where(
          and(
            actionableNow(),
            live,
            sql`NOT EXISTS (
              SELECT 1 FROM ${t} o
              WHERE o.dedupe_key = 'prompt:' || ${sessionLinks.id} || ':' || ${pendingRequests.requestId}
            )`,
          ),
        )
        .orderBy(asc(pendingRequests.createdAt), asc(pendingRequests.requestId))
        .limit(limit);
      const waiting = await db
        .select({
          ...target,
          requesterSlackUserId: linkedAccounts.externalUserId,
          requestId: pushRequests.id,
          // The turn whose intent made the request; a request no intent
          // made, the session's latest turn when it was asked, which holds
          // every source before it.
          // An intent's turn with no sources gives none.
          sources: sql<StoredSourceSet | null>`CASE WHEN EXISTS (
              SELECT 1 FROM push_intents pi
              WHERE pi.push_request_id = ${pushRequests.id})
            THEN (SELECT it.sources FROM push_intents pi
              JOIN ${turns} it ON it.id = pi.turn_id
              WHERE pi.push_request_id = ${pushRequests.id}
              ORDER BY pi.turn_id LIMIT 1)
            ELSE (SELECT lt.sources FROM ${turns} lt
              WHERE lt.session_id = ${sessions.id}
                AND lt.created_at <= ${pushRequests.createdAt}
              ORDER BY lt.sequence DESC LIMIT 1)
            END`,
          // The sequence of that same turn.
          sourcesTurn: sql<number | null>`CASE WHEN EXISTS (
              SELECT 1 FROM push_intents pi
              WHERE pi.push_request_id = ${pushRequests.id})
            THEN (SELECT it.sequence FROM push_intents pi
              JOIN ${turns} it ON it.id = pi.turn_id
              WHERE pi.push_request_id = ${pushRequests.id}
              ORDER BY pi.turn_id LIMIT 1)
            ELSE (SELECT lt.sequence FROM ${turns} lt
              WHERE lt.session_id = ${sessions.id}
                AND lt.created_at <= ${pushRequests.createdAt}
              ORDER BY lt.sequence DESC LIMIT 1)
            END`,
          repositoryId: pushRequests.repositoryId,
          repositoryName: catalogName(sql`${pushRequests.repositoryId}`),
          targetBranch: pushRequests.targetBranch,
          gitCommit: pushRequests.gitCommit,
        })
        .from(pushRequests)
        .innerJoin(sessions, eq(sessions.id, pushRequests.sessionId))
        .innerJoin(sessionLinks, eq(sessionLinks.sessionId, sessions.id))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, sessionLinks.installationId),
        )
        .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
        .leftJoin(
          linkedAccounts,
          requester(sql`(${pushRequests.requestedBy}->>'actor_user_id')::uuid`),
        )
        .where(
          and(
            eq(pushRequests.state, "requested"),
            live,
            sql`NOT EXISTS (
              SELECT 1 FROM ${t} o
              WHERE o.dedupe_key = 'push:' || ${sessionLinks.id} || ':' || ${pushRequests.id}
            )`,
          ),
        )
        .orderBy(asc(pushRequests.createdAt), asc(pushRequests.id))
        .limit(limit);
      const prompts: SlackPendingPrompt[][] = [];
      // One at a time: most tools read nothing, a GitHub tool a row or two.
      for (const { requestId, payload, expiresAt, ...row } of asked) {
        const stored = payload as {
          kind?: string;
          tool?: string;
          input?: unknown;
          questions?: unknown;
          remember_offer?: unknown;
        };
        if (stored.kind !== "permission" || typeof stored.tool !== "string") {
          prompts.push(
            questionPrompt({ requestId, stored, expiresAt, ...row }),
          );
          continue;
        }
        const input = stored.input ?? null;
        prompts.push([
          {
            ...row,
            prompt: {
              kind: "permission",
              requestId,
              tool: stored.tool,
              input,
              context: await toolSummaryContext(
                db,
                row.sessionId,
                stored.tool,
                input,
              ),
              ...rememberOfferOf(stored.remember_offer),
              expiresAt: expiresAt.toISOString(),
            },
          },
        ]);
      }
      return [
        ...prompts.flat(),
        ...waiting.map(
          ({
            requestId,
            repositoryId,
            repositoryName,
            targetBranch,
            gitCommit,
            ...row
          }): SlackPendingPrompt => ({
            ...row,
            prompt: {
              kind: "push",
              requestId,
              repositoryId,
              repositoryName,
              targetBranch,
              gitCommit,
            },
          }),
        ),
      ];
    },

    async promptCard(input) {
      if (!UUID.test(input.sessionId)) return null;
      const [row] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: t.workspaceId,
          teamId: slackInstallations.teamId,
          dedupeKey: t.dedupeKey,
          body: t.body,
        })
        .from(t)
        .innerJoin(sessions, eq(sessions.id, t.sessionId))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, t.installationId),
        )
        .where(
          and(
            eq(t.sessionId, input.sessionId.toLowerCase()),
            eq(t.kind, "input_notice"),
            eq(t.channelId, input.channelId),
            eq(t.slackTs, input.slackTs),
          ),
        )
        .limit(1);
      if (!row) return null;
      // slackPromptDedupeKey: `<prefix>:<link id>:<request id>`.
      const [, , ...rest] = row.dedupeKey.split(":");
      if (rest.join(":") !== input.requestId) return null;
      return promptCardOf(db, {
        ...row,
        sessionId: input.sessionId.toLowerCase(),
      });
    },

    cards: createPostgresSlackCardSettleStore(db),

    async expireSending() {
      return db.transaction(async (tx) => {
        const lost = await tx
          .update(t)
          .set({ status: "uncertain", errorCode: "lease_expired", ...released })
          .where(
            and(eq(t.status, "sending"), sql`${t.leaseExpiresAt} <= now()`),
          )
          .returning({ id: t.id, ...entry });
        await markMirrorUnconfirmed(
          tx,
          lost.flatMap((row) => (row.inputId === null ? [] : [row.inputId])),
        );
        return lost;
      });
    },

    async closeUnaddressed() {
      return db.transaction(async (tx) => {
        const closed = await tx
          .update(t)
          .set({ status: "failed", errorCode: "not_addressed", ...released })
          .where(
            and(
              eq(t.status, "pending"),
              // A held row has no thread to check yet; its hold ends it.
              sql`${t.heldForInputId} IS NULL`,
              sql`NOT ${addressed(tx, sql.raw('"slack_outbox"'))}`,
            ),
          )
          .returning({
            id: t.id,
            kind: t.kind,
            channelId: t.channelId,
            inputId: t.inputId,
          });
        // A mirror closed here never reached Slack: what it held closes too.
        // In id order, as every path that takes several inputs does.
        for (const inputId of [
          ...new Set(
            closed.flatMap((row) =>
              row.inputId === null ? [] : [row.inputId],
            ),
          ),
        ].sort()) {
          await closeHeldOfFailedMirror(tx, inputId as ConversationInputId);
        }
        return closed.map(({ inputId: _, ...row }) => row);
      });
    },

    async untoldUncertain(limit) {
      // The key platform's drain gives the notice, spelled in SQL.
      return db
        .select({ id: t.id, ...entry })
        .from(t)
        .where(
          and(
            eq(t.kind, "reply"),
            eq(t.status, "uncertain"),
            sql`${t.sessionId} IS NOT NULL`,
            sql`NOT EXISTS (
              SELECT 1 FROM ${t} n WHERE n.dedupe_key = 'uncertain:' || ${t.id}
            )`,
          ),
        )
        .orderBy(asc(t.seq))
        .limit(limit);
    },

    async claim({ limit, leaseMs }) {
      const rows = await db
        .update(t)
        .set({
          claimToken: sql`gen_random_uuid()`,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        })
        .where(
          sql`${t.id} IN (
            SELECT c.id FROM slack_outbox c
            WHERE c.status = 'pending'
              AND (c.claim_token IS NULL OR c.lease_expires_at <= now())
              AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
              AND c.held_for_input_id IS NULL
              AND ${addressed(db, sql.raw("c"))}
            ORDER BY c.seq
            LIMIT ${limit}
            FOR UPDATE OF c SKIP LOCKED
          )`,
        )
        .returning({
          id: t.id,
          claimToken: t.claimToken,
          attempts: t.attempts,
          seq: t.seq,
          ...entry,
        });
      return rows
        .sort((a, b) => a.seq - b.seq)
        .map(({ seq: _, claimToken, attempts, ...row }) => ({
          ...row,
          // Counted once this attempt is decided: beginSend, or a settle
          // that never began, so a claim whose lease lapses unsent is free.
          attempts: attempts + 1,
          // Set by this very update.
          claimToken: claimToken as string,
        }));
    },

    beginSend(fence) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            workspaceId: t.workspaceId,
            sessionId: t.sessionId,
            sources: t.sources,
            throughTurn: t.sourcesTurn,
          })
          .from(t)
          .where(
            and(
              fenced(fence),
              eq(t.status, "pending"),
              sql`${t.leaseExpiresAt} > now()`,
            ),
          )
          .for("update");
        if (row === undefined) return false;
        // A row whose sources hold a message Slack deleted is never sent;
        // a delete that comes once it is sending leaves what went out.
        if (
          row.sources !== null &&
          (await lockedDeletedSource(tx, row)) !== null
        ) {
          await tx
            .update(t)
            .set({
              status: "voided_by_delete",
              errorCode: "source_deleted",
              ...released,
            })
            .where(eq(t.id, fence.id));
          return "voided_by_delete" as const;
        }
        const rows = await tx
          .update(t)
          .set({ status: "sending", attempts: sql`${t.attempts} + 1` })
          .where(
            and(
              eq(t.id, fence.id),
              // The marks' locks may have been waited for.
              sql`${t.leaseExpiresAt} > clock_timestamp()`,
              channelNotWaiting(sql.raw('"slack_outbox"')),
            ),
          )
          .returning({ id: t.id });
        return rows.length > 0;
      });
    },

    async settle(fence, outcome) {
      const set =
        outcome.status === "sent"
          ? {
              status: "sent" as const,
              slackTs: outcome.slackTs,
              errorCode: null,
              // A posted card shows its buttons until its request moves on.
              settleRendered: sql`CASE WHEN ${t.kind} = 'input_notice' THEN 'open' ELSE ${t.settleRendered} END`,
              // A push card is drawn once more at once: its requester may
              // have left the channel before it was posted.
              settleState: sql`CASE WHEN ${t.kind} = 'input_notice' AND ${t.dedupeKey} LIKE 'push:%' THEN 'due' ELSE ${t.settleState} END`,
            }
          : outcome.status === "pending"
            ? {
                status: "pending" as const,
                errorCode: outcome.errorCode,
                nextAttemptAt: sql`now() + make_interval(secs => ${outcome.retryInMs / 1000})`,
              }
            : { status: outcome.status, errorCode: outcome.errorCode };
      return db.transaction(async (tx) => {
        const [row] = await tx
          .update(t)
          .set({
            ...set,
            ...released,
            // SET reads the old status: still pending means beginSend never ran.
            attempts: sql`CASE WHEN ${t.status} = 'pending' THEN ${t.attempts} + 1 ELSE ${t.attempts} END`,
          })
          .where(fenced(fence))
          .returning({
            sessionId: t.sessionId,
            workspaceId: t.workspaceId,
            inputId: t.inputId,
            installationId: t.installationId,
            channelId: t.channelId,
            threadTs: t.threadTs,
          });
        if (row === undefined) return false;
        // A post into the thread is a moment to show its status again soon.
        if (outcome.status === "sent" && row.sessionId) {
          await touchSlackThreadStatus(tx, row.sessionId);
        }
        if (row.inputId === null) return true;
        const inputId = row.inputId as ConversationInputId;
        // The post is the mirrored input's alias from the moment it is known,
        // and the rows held for its thread go there.
        if (outcome.status === "sent") {
          const linked = await mirrorPosted(
            tx,
            { ...row, inputId },
            outcome.slackTs,
          );
          if (linked === "topic_alias_taken") return linked;
        } else if (outcome.status === "uncertain") {
          await markMirrorUnconfirmed(tx, [inputId]);
        } else if (outcome.status === "failed") {
          // Never in Slack: what waited for its thread is not sent elsewhere.
          await closeHeldOfFailedMirror(tx, inputId);
        }
        return true;
      });
    },
  };
}
