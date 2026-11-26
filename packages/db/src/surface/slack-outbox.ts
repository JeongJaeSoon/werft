import { randomUUID } from "node:crypto";
import {
  BUDGET_ACCOUNT_REFUSED_EVENT_CODE,
  BUDGET_OWNER_KIND_VALUES,
  type ConversationInputId,
  DEFAULT_USER_LOCALE,
  type PushRequestOrigin,
  pendingQuestionSchema,
  type RuntimeKind,
  rememberRuleSchema,
  type SessionEventPayload,
  SLACK_NOTICE_VERSIONS,
  SLACK_USER_CHANNEL_CODE,
  type SlackNoticeVersionEntry,
  slackOutboxChannelRefused,
  TURN_EMERGENCY_STOPPED_REASON,
  type UserLocale,
  withStoredNeutralFields,
} from "@werft-ai/contracts";
import type {
  NeutralizeEvent,
  StoredSourceSet,
  SurfaceAiLabel,
  SurfaceCardClaim,
  SurfaceCardFence,
  SurfaceCardRendered,
  SurfaceCardSettleStore,
  SurfaceConversationScope,
  SurfaceOpenPushCard,
  SurfaceOutboxFence,
  SurfaceOutboxPostedAs,
  SurfaceOutboxStore,
  SurfacePendingPrompt,
  SurfacePromptCard,
  SurfaceUnansweredTurn,
  SurfaceUnpostedInstruction,
} from "@werft-ai/platform";
import {
  SURFACE_EDIT_RATE_LIMITED_CODE,
  SURFACE_PROGRESS_EDIT_INTERVAL_MS,
  SURFACE_PROGRESS_EDIT_SPACING_MS,
  SURFACE_PROGRESS_STOPPED_CODE,
  SURFACE_PROGRESS_SUPERSEDED_CODE,
  SURFACE_RATE_LIMITED_CODE,
  SURFACE_REACTION_MAX_ATTEMPTS,
  sourceSetOf,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { releaseSuperseded } from "../agents.ts";
import { UUID } from "../control-shared.ts";
import {
  inputTexts,
  lockedDeletedSource,
  lockedTurnReadDeleted,
  outboxSources,
  servedTitle,
} from "../conversations/index.ts";
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
  executions,
  linkedAccounts,
  pendingRequests,
  pushRequests,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  slackOutboxRateBlocks,
  surfaceBindings,
  turns,
  users,
  workerLaunches,
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
import { SLACK_OUTBOX_APP_DELETED } from "./slack-app-close.ts";
import { channelLeft } from "./slack-channel-left.ts";
import {
  channelNoticeCurrent,
  channelNoticeListening,
  unnoticedSlackChannels,
} from "./slack-channel-notices.ts";
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
  progressKey: t.progressKey,
  conversationTurnId: t.conversationTurnId,
};

// The fence alone, with no lease test: a claimed row whose lease ran out is
// either reclaimed (a new token) or, mid-send, moved to `uncertain` (no
// token), and both fail this.
const fenced = (fence: SurfaceOutboxFence) =>
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

// The refusal recordBudgetAccountRefusal kept on a failed turn, and whether
// it is the session's first while the limit holds: no refusal told before
// it (on an earlier turn that ended with a post, so not completed, stopped
// or turnless) after the last completed turn ended, in the same UTC month.
// Found by the turn's attempt, the one its refused call ran in, so the
// partial (session, attempt) index bounds the read to that attempt.
const budgetRefusalOfTurn = sql<NonNullable<
  SurfaceUnansweredTurn["budgetRefusal"]
> | null>`(
  CASE WHEN ${turns.status} <> 'completed' THEN (
    SELECT jsonb_build_object(
      'owner', r.payload->>'budget_owner',
      'first', NOT EXISTS (
        SELECT 1 FROM events p
        WHERE p.session_id = r.session_id
          AND p.type = 'error'
          AND p.payload->>'code' = ${BUDGET_ACCOUNT_REFUSED_EVENT_CODE}
          AND p.payload ? 'budget_owner'
          AND p.id < r.id
          AND EXISTS (
            SELECT 1 FROM ${turns} pt
            WHERE pt.id = p.turn_id
              AND pt.sequence < ${turns.sequence}
              AND pt.status IN ('failed', 'outcome_unknown'))
          AND p.created_at >= date_trunc('month', r.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AND p.created_at > coalesce((
            SELECT max(ct.ended_at) FROM ${turns} ct
            WHERE ct.session_id = r.session_id
              AND ct.status = 'completed'
              AND ct.sequence < ${turns.sequence}), '-infinity')))
    FROM events r
    WHERE r.session_id = ${turns.sessionId}
      AND r.attempt_id = ${turns.attemptId}
      AND r.turn_id = ${turns.id}
      AND r.type = 'error'
      AND r.payload->>'code' = ${BUDGET_ACCOUNT_REFUSED_EVENT_CODE}
      AND r.payload->>'budget_owner' IN (${sqlLiterals(BUDGET_OWNER_KIND_VALUES)})
    ORDER BY r.id
    LIMIT 1)
  END
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

// Only the notice that a channel waits for approval (a `notice` of no
// session) may go to a channel whose binding waits, or was rejected and has no live binding since. A
// channel the bot left takes nothing at all, a notice included: the bot is
// not in it.
const channelNotWaiting = (row: SQL) => sql`(
  NOT ${channelLeft(sql`${row}.installation_id`, sql`${row}.channel_id`)}
  AND ((${row}.kind = 'notice' AND ${row}.session_id IS NULL) OR NOT EXISTS (
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
// thread) still taking it, and for an input notice its request still
// waiting: a card's own request, or, for a turn's notice from before the
// cards, any of its turn's. Checked again at claim, since a row can wait out
// a backoff after any of it changed.
const addressed = (
  db: Database,
  row: SQL,
  noticeVersions: readonly SlackNoticeVersionEntry[],
) => sql`(
  ${requestWaits(db, row)}
  AND EXISTS (
    SELECT 1 FROM slack_installations i
    WHERE i.id = ${row}.installation_id AND i.status <> 'revoked'
  )
  -- A channel notice waits on its channel instead: claim holds it.
  AND (${row}.kind = 'channel_notice' OR ${channelNotWaiting(row)})
  -- A channel whose agent was stopped in an emergency takes nothing from it
  -- but the line that says so, until it is turned on again.
  AND (${row}.kind = 'emergency_stop_notice' OR NOT EXISTS (
    SELECT 1 FROM surface_bindings b
    WHERE b.installation_id = ${row}.installation_id
      AND b.external_surface_id = ${row}.channel_id
      AND b.revoked_at IS NULL
      AND b.emergency_stopped_at IS NOT NULL
  ))
  AND (${row}.kind <> 'channel_notice' OR ${channelNoticeCurrent(row, noticeVersions)})
  AND (${row}.session_id IS NULL OR EXISTS (
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

// The rate limits Slack's 429s set (slack_outbox_rate_blocks) that still
// cover row `row`: its channel's posts (a reaction: the install's reactions.add) and,
// for a progress update, which may edit, the install's chat.update.
const rateBlocks = (row: SQL) => sql`
  SELECT b.blocked_until FROM slack_outbox_rate_blocks b
  WHERE b.installation_id = ${row}.installation_id
    AND b.scope IN (
      CASE WHEN ${row}.kind = 'reaction' THEN 'reactions.add'
        ELSE 'channel:' || ${row}.channel_id END,
      CASE WHEN ${row}.kind = 'progress' THEN 'chat.update' END)
    AND b.blocked_until > now()`;

// The AI line of row `row` (v1-b/G2): null unless its agent's conversation
// rollout is `on`. Its name is that of whoever sent the turn the row's key
// names: a turn's answer or failure, a card, a push's result. A push a turn's
// intent made is that turn's sender's: its `requested_by` is the session's
// creator. A row of any other key, or a sender who is no user, has the line
// alone.
const aiLabelOf = (row: SQL) => sql`(
  SELECT json_build_object('requestedBy', (
    SELECT u.display_name FROM users u WHERE u.id = CASE
      WHEN ${row}.dedupe_key LIKE 'reply:%' OR ${row}.dedupe_key LIKE 'failure:%'
        OR ${row}.dedupe_key LIKE 'prompt:%' THEN (
        SELECT rt.actor_id FROM turns rt
        WHERE rt.session_id = ${row}.session_id
          AND rt.sequence = ${row}.sources_turn)
      WHEN ${row}.dedupe_key LIKE 'push:%' OR ${row}.dedupe_key LIKE 'action:%' THEN (
        SELECT CASE WHEN pi.id IS NULL
            THEN (p.requested_by ->> 'actor_user_id')::uuid
            ELSE it.actor_id END
        FROM push_requests p
        LEFT JOIN push_intents pi ON pi.push_request_id = p.id
        LEFT JOIN turns it ON it.id = pi.turn_id
        WHERE p.session_id = ${row}.session_id
          AND p.id::text = split_part(${row}.dedupe_key, ':',
            CASE WHEN ${row}.dedupe_key LIKE 'push:%' THEN 3 ELSE 2 END)
        ORDER BY pi.turn_id LIMIT 1)
      WHEN ${row}.dedupe_key LIKE 'intent:%' THEN (
        SELECT it.actor_id FROM push_intents pi
        JOIN turns it ON it.id = pi.turn_id
        WHERE pi.session_id = ${row}.session_id
          AND pi.id::text = split_part(${row}.dedupe_key, ':', 2))
    END))
  FROM agents a
  WHERE a.id = ${row}.agent_id AND a.conversation_rollout = 'on'
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
}: Omit<SurfacePendingPrompt, "prompt"> & {
  requestId: string;
  stored: { kind?: string; questions?: unknown };
  expiresAt: Date;
}): SurfacePendingPrompt[] {
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
): Promise<SurfacePromptCard | null> {
  const [prefix, , ...rest] = row.dedupeKey.split(":");
  const requestId = rest.join(":");
  let display: SurfacePromptCard["display"] | null = null;
  let decidedVia: SurfacePromptCard["decidedVia"] = null;
  let pushRevisions: SurfacePromptCard["pushRevisions"];
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

const cardFenced = (fence: SurfaceCardFence) =>
  sql`id = ${fence.id} AND settle_claim_token = ${fence.claimToken}`;

const CARD_RELEASED = sql`
  settle_claim_token = NULL, settle_lease_expires_at = NULL,
  settle_inflight_at = NULL`;

// What a drawn card leaves the row: open or reject-only waits for the next
// change, an end state is final.
const settledAs = (rendered: SQL) =>
  sql`CASE WHEN coalesce(${rendered}, 'open') IN ${CHOICES} THEN NULL ELSE 'settled' END`;

/**
 * A session's parent conversation as the outbox claim reads it; a DM
 * conversation keeps no team of its own, so its install's is it.
 */
const conversationScopeOf = (sessionId: SQL, installationId: SQL) =>
  sql<SurfaceConversationScope | null>`(
    SELECT json_build_object(
      'kind', cv.kind,
      'teamId', COALESCE(cv.team_id, si.team_id),
      'channelId', cv.channel_id
    )
    FROM sessions s
    JOIN conversations cv ON cv.id = s.parent_conversation_id
    JOIN slack_installations si ON si.id = ${installationId}
    WHERE s.id = ${sessionId}
  )`;

/** The `slack` role's redraws of posted cards (design slack-approval-ui §4). */
function createPostgresSlackCardSettleStore(
  db: Database,
): SurfaceCardSettleStore {
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

    async markChoiceCardsDueIn({ installationId, channelId, windowMs }) {
      const inChannel = sql`${SENT_CARD} AND ${SHOWS_CHOICE}
        AND (o.dedupe_key LIKE 'push:%' OR o.dedupe_key LIKE 'prompt:%')
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
        rendered: row.rendered as SurfaceOpenPushCard["rendered"],
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
            pick.inherited, st.settle_attempts,
            ${aiLabelOf(sql.raw("st"))} AS ai_label,
            ${conversationScopeOf(sql`st.session_id`, sql`st.installation_id`)} AS conversation_scope`),
      );
      return rows.map(
        (row): SurfaceCardClaim => ({
          id: row.id as string,
          claimToken: row.settle_claim_token as string,
          workspaceId: row.workspace_id as string,
          slackAppId: row.slack_app_id as string,
          sessionId: (row.session_id as string | null) ?? null,
          channelId: row.channel_id as string,
          slackTs: row.slack_ts as string,
          dedupeKey: row.dedupe_key as string,
          body: row.body as SurfaceCardClaim["body"],
          rendered: (row.settle_rendered as SurfaceCardRendered | null) ?? null,
          uncertainRev: Number(row.settle_uncertain_rev),
          uncertain: Boolean(row.uncertain),
          inherited: Boolean(row.inherited),
          attempts: Number(row.settle_attempts),
          ...(row.ai_label == null
            ? {}
            : { aiLabel: row.ai_label as SurfaceAiLabel }),
          conversationScope:
            (row.conversation_scope as SurfaceConversationScope | null) ?? null,
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
  options: {
    neutralize?: NeutralizeEvent;
    /** The notice versions a `channel_notice` row is judged by. */
    noticeVersions?: readonly SlackNoticeVersionEntry[];
    /** Defaults to `SURFACE_PROGRESS_EDIT_INTERVAL_MS`. */
    progressIntervalMs?: number;
  } = {},
): SurfaceOutboxStore {
  const noticeVersions = options.noticeVersions ?? SLACK_NOTICE_VERSIONS;
  const progressIntervalMs =
    options.progressIntervalMs ?? SURFACE_PROGRESS_EDIT_INTERVAL_MS;
  return {
    threadStatus: createPostgresSlackThreadStatusStore(db),

    async enqueue(input, whileHome) {
      if (slackOutboxChannelRefused(input.channelId)) {
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

    async aiLabelFor({ agentId, sessionId, turnId }) {
      const [row] = rowsOf<{ ai_label: SurfaceAiLabel | null }>(
        await db.execute(sql`
          WITH o AS (SELECT ${agentId}::uuid AS agent_id,
            ${sessionId}::uuid AS session_id, ${turnId}::int AS sources_turn,
            'failure:' AS dedupe_key)
          SELECT ${aiLabelOf(sql.raw("o"))} AS ai_label FROM o`),
      );
      return row?.ai_label ?? null;
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
      // Owed nothing more: a muted link; one that reports turns, once no
      // turn past its mark lacks its report row (its last report is in);
      // else no turn still owes its instruction. Under the row locks, so an enqueue that
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
              THEN NOT EXISTS (
                -- Past the mark with its report row not yet in. Unlike
                -- advanceAnswered, an outcome_unknown turn with its failure
                -- row counts as in: the session is closed, so nobody will
                -- confirm it now.
                SELECT 1 FROM ${turns} t
                WHERE t.session_id = l2.session_id
                  AND t.sequence > l2.answered_through
                  AND t.status NOT IN (${STOPPED_TURNS})
                  AND NOT (t.status IN (${ENDED_WITH_POST_TURNS}) AND (
                    t.created_at < l2.created_at OR EXISTS (
                      SELECT 1 FROM ${t} o
                      WHERE o.dedupe_key = (CASE WHEN t.status = 'completed'
                          THEN 'reply' ELSE 'failure' END)
                        || ':' || l2.id || ':' || t.sequence
                    )))
              )
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
      return rows.flatMap(
        ({ channel, ...row }): SurfaceUnpostedInstruction[] =>
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
        sender_name: string | null;
        sender_slack_user_id: string | null;
        locale: UserLocale | null;
      }>(
        await db.execute(sql`
        SELECT i.id AS input_id, i.workspace_id, i.agent_id,
          a.id AS slack_app_id, inst.id AS installation_id,
          p.channel_id, p.thread_ts,
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
      const texts = await inputTexts(
        db,
        rows.map((row) => row.input_id),
      );
      return rows
        .flatMap((row) => {
          const body = texts.get(row.input_id);
          return body === undefined ? [] : [{ ...row, body }];
        })
        .map((row) => ({
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
          terminalReason: turns.terminalReason,
          sessionPaused: sql<boolean>`${sessions.admissionState} = 'paused'`,
          attemptId: turns.attemptId,
          requesterSlackUserId: linkedAccounts.externalUserId,
          locale: starterLocale,
          budgetRefusal: budgetRefusalOfTurn,
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
        ({
          turnRowId,
          status,
          attemptId: _,
          ...row
        }): SurfaceUnansweredTurn => ({
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

    unnoticedChannels: (limit) =>
      unnoticedSlackChannels(db, { limit, versions: noticeVersions }),

    async capacityWaits(limit, waitedMs) {
      // The key the adapter's slackCapacityWaitDedupeKey makes, spelled in SQL.
      const key = sql`'capacity_wait:' || ${sessionLinks.id} || ':' || ${workerLaunches.executionId} || ':' || ${workerLaunches.generation}`;
      return db
        .select({
          sessionLinkId: sessionLinks.id,
          sessionId: sessions.id,
          workspaceId: sessionLinks.workspaceId,
          agentId: sessionLinks.agentId,
          slackAppId: slackApps.id,
          installationId: sessionLinks.installationId,
          channelId: sessionLinks.channelId,
          threadTs: sessionLinks.threadId,
          locale: starterLocale,
          executionId: workerLaunches.executionId,
          generation: workerLaunches.generation,
        })
        .from(workerLaunches)
        .innerJoin(executions, eq(executions.id, workerLaunches.executionId))
        .innerJoin(sessions, eq(sessions.id, workerLaunches.sessionId))
        .innerJoin(sessionLinks, eq(sessionLinks.sessionId, sessions.id))
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, sessionLinks.installationId),
        )
        .innerJoin(slackApps, eq(slackApps.appId, slackInstallations.appId))
        .where(
          and(
            isNull(workerLaunches.slotReleasedAt),
            // Claimed before the pass cleared the wait: it runs already.
            isNull(workerLaunches.claimedAttemptId),
            eq(executions.desiredState, "running"),
            lte(
              workerLaunches.capacityWaitSince,
              sql`clock_timestamp() - make_interval(secs => ${waitedMs / 1_000})`,
            ),
            // The threads that hear of a turn's failure hear of its wait.
            isNull(sessionLinks.revokedAt),
            eq(sessionLinks.muted, false),
            reportsTurns(sql.raw('"session_links"')),
            isNull(sessionLinks.closedAt),
            ne(slackInstallations.status, "revoked"),
            sql`NOT EXISTS (SELECT 1 FROM ${t} o WHERE o.dedupe_key = ${key})`,
          ),
        )
        .orderBy(asc(workerLaunches.capacityWaitSince))
        .limit(limit);
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
        conversationScope: conversationScopeOf(
          sql`${sessions.id}`,
          sql`${sessionLinks.installationId}`,
        ),
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
      const prompts: SurfacePendingPrompt[][] = [];
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
          }): SurfacePendingPrompt => ({
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
          conversationScope: conversationScopeOf(
            sql`${t.sessionId}`,
            sql`${t.installationId}`,
          ),
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
      const { conversationScope, ...card } = row;
      const drawn = await promptCardOf(db, {
        ...card,
        sessionId: input.sessionId.toLowerCase(),
      });
      return drawn === null ? null : { ...drawn, conversationScope };
    },

    cards: createPostgresSlackCardSettleStore(db),

    async expireSending() {
      return db.transaction(async (tx) => {
        const expired = and(
          eq(t.status, "sending"),
          sql`${t.leaseExpiresAt} <= now()`,
        );
        // A reaction Slack may hold is asked for again, not left uncertain.
        await tx
          .update(t)
          .set({
            status: "pending",
            errorCode: "lease_expired",
            nextAttemptAt: sql`now()`,
            ...released,
          })
          .where(
            and(
              expired,
              eq(t.kind, "reaction"),
              sql`${t.attempts} < ${SURFACE_REACTION_MAX_ATTEMPTS}`,
              // One an emergency stop marked is not asked for again.
              sql`${t.errorCode} IS DISTINCT FROM ${TURN_EMERGENCY_STOPPED_REASON}`,
            ),
          );
        const lost = await tx
          .update(t)
          .set({ status: "uncertain", errorCode: "lease_expired", ...released })
          .where(expired)
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
          .set({
            status: "failed",
            // A row enqueued after its app's delete, by a session still
            // running, is refused for that.
            errorCode: sql`CASE WHEN EXISTS (
              SELECT 1 FROM slack_apps a
              WHERE a.id = ${t.slackAppId} AND a.state = 'deleted'
            ) THEN ${SLACK_OUTBOX_APP_DELETED} ELSE 'not_addressed' END`,
            ...released,
          })
          .where(
            and(
              eq(t.status, "pending"),
              // A held row has no thread to check yet; its hold ends it.
              sql`${t.heldForInputId} IS NULL`,
              // A model notice an earlier release wrote to a person is the
              // API start pass's (moveModelNoticesOffPeople): it moves the
              // row to its session's thread, so it is not closed before.
              sql`NOT (${t.kind} = 'model_notice' AND ${t.channelId} ~ '^[UW]')`,
              sql`NOT ${addressed(tx, sql.raw('"slack_outbox"'), noticeVersions)}`,
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
      // A progress update a newer one overtook, or of a message that
      // stopped, never goes. Skipping the rows a send holds, so this waits
      // on no lock.
      await db.execute(sql`
        UPDATE slack_outbox o SET
          status = 'failed',
          error_code = CASE WHEN EXISTS (
            SELECT 1 FROM slack_outbox s
            WHERE s.installation_id = o.installation_id AND s.progress_key = o.progress_key
              AND (s.error_code = ${SURFACE_PROGRESS_STOPPED_CODE}
                OR ((s.status = 'uncertain' OR s.error_code = 'missing_ts') AND s.progress_ts IS NULL))
          ) THEN ${SURFACE_PROGRESS_STOPPED_CODE} ELSE ${SURFACE_PROGRESS_SUPERSEDED_CODE} END,
          claim_token = NULL,
          lease_expires_at = NULL
        WHERE o.id IN (
          SELECT p.id FROM slack_outbox p
          WHERE p.kind = 'progress' AND p.status = 'pending'
            AND (p.claim_token IS NULL OR p.lease_expires_at <= now())
            AND EXISTS (
              SELECT 1 FROM slack_outbox n
              WHERE n.installation_id = p.installation_id AND n.progress_key = p.progress_key
                AND (n.seq > p.seq OR n.error_code = ${SURFACE_PROGRESS_STOPPED_CODE}
                  OR ((n.status = 'uncertain' OR n.error_code = 'missing_ts') AND n.progress_ts IS NULL))
            )
          FOR UPDATE OF p SKIP LOCKED
        )`);
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
              AND NOT EXISTS (${rateBlocks(sql.raw("c"))})
              AND ${addressed(db, sql.raw("c"), noticeVersions)}
              -- Held while its channel is not one the agent reads.
              AND (c.kind <> 'channel_notice'
                OR ${channelNoticeListening(sql.raw("c"), noticeVersions)})
              -- A progress message's newest update alone, one send at a
              -- time, and none before the interval after the last send or
              -- a Retry-After an update it overtook was told.
              AND (c.kind <> 'progress' OR NOT EXISTS (
                SELECT 1 FROM slack_outbox p
                WHERE p.installation_id = c.installation_id AND p.progress_key = c.progress_key AND p.id <> c.id
                  AND (p.seq > c.seq
                    OR p.status = 'sending'
                    OR (p.status = 'pending' AND p.claim_token IS NOT NULL
                      AND p.lease_expires_at > now())
                    OR p.next_attempt_at > now())
              ))
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
          // A DM conversation keeps no team of its own; its install's is it.
          // A conversation's answer has no session: its turn's conversation.
          conversationScope: sql<SurfaceConversationScope | null>`(
            SELECT json_build_object(
              'kind', cv.kind,
              'teamId', COALESCE(cv.team_id, si.team_id),
              'channelId', cv.channel_id
            )
            FROM conversations cv
            JOIN slack_installations si ON si.id = ${t.installationId}
            WHERE cv.id = COALESCE(
              (SELECT s.parent_conversation_id FROM sessions s
               WHERE s.id = ${t.sessionId}),
              (SELECT ct.conversation_id FROM conversation_turns ct
               WHERE ct.id = ${t.conversationTurnId}))
          )`,
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
        // The install before the row, as an app delete takes them: a delete
        // that revoked it and has not committed yet is waited for here, so a
        // row it claimed too late to sweep still never goes out.
        const [install] = await tx
          .select({ status: slackInstallations.status })
          .from(slackInstallations)
          .where(
            sql`${slackInstallations.id} = (SELECT installation_id FROM slack_outbox WHERE id = ${fence.id})`,
          )
          .for("share");
        if (install?.status === "revoked") return false;
        // A progress message's begins go one at a time, before any row lock.
        const [keyed] = await tx
          .select({
            progressKey: t.progressKey,
            installationId: t.installationId,
            channelId: t.channelId,
            kind: t.kind,
          })
          .from(t)
          .where(eq(t.id, fence.id));
        if (keyed?.progressKey) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`slack_outbox_progress:${keyed.installationId}:${keyed.progressKey}`}, 0))`,
          );
        }
        // The channel's binding before the row, as an emergency stop takes
        // them: a stop under way is waited for, and once it holds the row
        // ends as the stop ended the channel's unsent posts.
        if (keyed !== undefined && keyed.kind !== "emergency_stop_notice") {
          const [binding] = rowsOf<{ stopped: boolean }>(
            await tx.execute(sql`
              SELECT b.emergency_stopped_at IS NOT NULL AS stopped
              FROM surface_bindings b
              WHERE b.installation_id = ${keyed.installationId}::uuid
                AND b.external_surface_id = ${keyed.channelId}
                AND b.revoked_at IS NULL
              FOR SHARE`),
          );
          if (binding?.stopped === true) {
            const ended = await tx
              .update(t)
              .set({
                status: "failed",
                errorCode: TURN_EMERGENCY_STOPPED_REASON,
                ...released,
              })
              .where(and(fenced(fence), eq(t.status, "pending")))
              .returning({ inputId: t.inputId });
            for (const { inputId } of ended) {
              if (inputId !== null) {
                await closeHeldOfFailedMirror(
                  tx,
                  inputId as ConversationInputId,
                );
              }
            }
            return false;
          }
        }
        const [row] = await tx
          .select({
            workspaceId: t.workspaceId,
            agentId: t.agentId,
            sessionId: t.sessionId,
            sessionLinkId: t.sessionLinkId,
            sources: t.sources,
            throughTurn: t.sourcesTurn,
            progressKey: t.progressKey,
            installationId: t.installationId,
            conversationTurnId: t.conversationTurnId,
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
        // Read again under the message's lock, as a claim made beside
        // another pass's may not have seen it: the update edits the post the
        // last sent one left. A post Slack never confirmed (uncertain, or
        // no ts in its answer) may be in Slack: with no ts known the message
        // stops, and after an edit it may have been the one post again.
        let progress: { ts: string | null; reposted: boolean } | undefined;
        if (row.progressKey !== null) {
          const [state] = rowsOf<{
            busy: boolean;
            superseded: boolean;
            wait_until: string | null;
            stopped: boolean;
            ts: string | null;
            reposted: boolean;
          }>(
            await tx.execute(sql`
              WITH me AS (SELECT seq FROM slack_outbox WHERE id = ${fence.id}::uuid),
              k AS (
                SELECT seq, status, error_code, slack_ts, progress_ts, next_attempt_at
                FROM slack_outbox
                WHERE installation_id = ${row.installationId}::uuid
                  AND progress_key = ${row.progressKey} AND id <> ${fence.id}::uuid
              )
              SELECT
                EXISTS (SELECT 1 FROM k WHERE status = 'sending') AS busy,
                EXISTS (SELECT 1 FROM k, me WHERE k.seq > me.seq) AS superseded,
                (SELECT max(next_attempt_at) FROM k
                 WHERE next_attempt_at > now())::text AS wait_until,
                EXISTS (
                  SELECT 1 FROM k WHERE error_code = ${SURFACE_PROGRESS_STOPPED_CODE}
                    OR ((status = 'uncertain' OR error_code = 'missing_ts') AND progress_ts IS NULL)
                ) AS stopped,
                (SELECT slack_ts FROM k WHERE status = 'sent'
                 ORDER BY seq DESC LIMIT 1) AS ts,
                EXISTS (
                  SELECT 1 FROM k WHERE progress_ts IS NOT NULL AND (
                    status = 'uncertain' OR error_code = 'missing_ts'
                    OR (status = 'sent' AND slack_ts <> progress_ts))
                ) AS reposted`),
          );
          if (state === undefined) return false;
          if (state.stopped || state.superseded) {
            await tx
              .update(t)
              .set({
                status: "failed",
                errorCode: state.stopped
                  ? SURFACE_PROGRESS_STOPPED_CODE
                  : SURFACE_PROGRESS_SUPERSEDED_CODE,
                ...released,
              })
              .where(eq(t.id, fence.id));
            return false;
          }
          if (state.busy) return false;
          if (state.wait_until !== null) {
            await tx
              .update(t)
              .set({
                ...released,
                nextAttemptAt: sql`${state.wait_until}::timestamptz`,
              })
              .where(eq(t.id, fence.id));
            return false;
          }
          progress = { ts: state.ts, reposted: state.reposted };
        }
        // A title cut or made from the session's first message: that
        // message's direct sources. Their marks are taken with the row's, in
        // one order, so the title read below sees a delete under way.
        const [title] =
          row.sessionId === null
            ? []
            : rowsOf<{ sources: StoredSourceSet }>(
                await tx.execute(sql`
                  SELECT jsonb_build_object(
                    'direct', tt.sources -> 'direct', 'inherited', '[]'::jsonb
                  ) AS sources
                  FROM sessions s
                  JOIN turns tt ON tt.session_id = s.id AND tt.sequence = 1
                  WHERE s.id = ${row.sessionId}
                    AND s.title_source IN ('derived', 'generated')
                    AND jsonb_typeof(tt.sources -> 'direct') = 'array'`),
              );
        if (title !== undefined) {
          await lockedDeletedSource(tx, {
            ...row,
            sources: {
              ...(row.sources ?? { inherited: [] }),
              direct: [...(row.sources?.direct ?? []), ...title.sources.direct],
            },
          });
        }
        // A row whose sources hold a message Slack deleted is never sent;
        // a delete that comes once it is sending leaves what went out.
        // A turn's set that overflowed has no session to recover what was
        // cut: held, as the turn's decision was, to its channel's deletes.
        if (
          row.sources !== null &&
          (row.conversationTurnId !== null && sourceSetOf(row.sources).overflow
            ? (await lockedTurnReadDeleted(tx, row.conversationTurnId))
                ?.deleted !== false
            : (await lockedDeletedSource(tx, row)) !== null)
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
        // A 429 another row of this pass, or another replica, ran into since
        // this one was claimed: released, unsent and uncounted, until then.
        // Last before the send, after every lock waited for above.
        const [limit] = rowsOf<{ until: string | null }>(
          await tx.execute(sql`
            SELECT (SELECT max(blocked_until) FROM (${rateBlocks(sql.raw("o"))}) l)::text AS until
            FROM slack_outbox o WHERE o.id = ${fence.id}::uuid`),
        );
        if (limit?.until != null) {
          await tx
            .update(t)
            .set({
              ...released,
              nextAttemptAt: sql`${limit.until}::timestamptz`,
            })
            .where(eq(t.id, fence.id));
          return "rate_limited" as const;
        }
        const rows = await tx
          .update(t)
          .set({
            status: "sending",
            attempts: sql`${t.attempts} + 1`,
            ...(progress === undefined ? {} : { progressTs: progress.ts }),
          })
          .where(
            and(
              eq(t.id, fence.id),
              // The marks' locks may have been waited for.
              sql`${t.leaseExpiresAt} > clock_timestamp()`,
              channelNotWaiting(sql.raw('"slack_outbox"')),
              sql`(${t.kind} <> 'channel_notice' OR (${channelNoticeListening(sql.raw('"slack_outbox"'), noticeVersions)} AND ${channelNoticeCurrent(sql.raw('"slack_outbox"'), noticeVersions)}))`,
            ),
          )
          .returning({ id: t.id });
        if (rows.length === 0) return false;
        // Every progress edit that begins, whatever comes of it, moves the
        // install's chat.update block one spacing past the later of the block
        // and now: edits from every replica average one a spacing, and edits
        // begun side by side are paid for after.
        if (progress?.ts != null) {
          const blocks = slackOutboxRateBlocks;
          await tx
            .insert(blocks)
            .values({
              installationId: row.installationId,
              scope: "chat.update",
              blockedUntil: sql`now() + ${ms(SURFACE_PROGRESS_EDIT_SPACING_MS)}`,
            })
            .onConflictDoUpdate({
              target: [blocks.installationId, blocks.scope],
              set: {
                blockedUntil: sql`greatest(${blocks.blockedUntil}, now()) + ${ms(SURFACE_PROGRESS_EDIT_SPACING_MS)}`,
              },
            });
        }
        // Who the row goes out as, read under those locks. A task is a
        // session with a Slack link: the row's own, or, for a row sent
        // outside its thread (a direct message), an open one. Its title as a
        // reader is served it: none once Slack deleted what it came from.
        const [sender] = rowsOf<{
          posted_as: SurfaceOutboxPostedAs;
          ai_label: SurfaceAiLabel | null;
        }>(
          await tx.execute(sql`
            SELECT json_build_object(
              'agentName', a.name,
              'taskTitle', (
                SELECT ${servedTitle("s")} FROM sessions s
                WHERE s.id = ${row.sessionId}::uuid AND (
                  ${row.sessionLinkId}::uuid IS NOT NULL OR EXISTS (
                    SELECT 1 FROM session_links l
                    WHERE l.session_id = s.id AND l.closed_at IS NULL
                  )
                )
              )
            ) AS posted_as, ${aiLabelOf(sql.raw("o"))} AS ai_label
            FROM agents a, slack_outbox o
            WHERE a.id = ${row.agentId}::uuid AND o.id = ${fence.id}::uuid`),
        );
        if (sender === undefined) return true;
        return {
          ...sender.posted_as,
          ...(progress === undefined ? {} : { progress }),
          ...(sender.ai_label === null ? {} : { aiLabel: sender.ai_label }),
        };
      });
    },

    async settle(fence, given) {
      const setOf = (outcome: typeof given) =>
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
              // The next update of a progress message waits this long.
              nextAttemptAt: sql`CASE WHEN ${t.kind} = 'progress' THEN now() + ${ms(progressIntervalMs)} ELSE ${t.nextAttemptAt} END`,
            }
          : outcome.status === "pending"
            ? {
                status: "pending" as const,
                errorCode: outcome.errorCode,
                // A progress message's next call, a retry too, waits the
                // interval at least.
                nextAttemptAt: sql`now() + CASE WHEN ${t.kind} = 'progress' THEN greatest(${ms(outcome.retryInMs)}, ${ms(progressIntervalMs)}) ELSE ${ms(outcome.retryInMs)} END`,
              }
            : {
                status: outcome.status,
                errorCode: outcome.errorCode,
                // A call that ended a progress row still spaces the next, by
                // the Retry-After it was given up on too.
                nextAttemptAt: sql`CASE WHEN ${t.kind} = 'progress' THEN now() + greatest(${ms(outcome.status === "failed" ? (outcome.retryInMs ?? 0) : 0)}, ${ms(progressIntervalMs)}) ELSE ${t.nextAttemptAt} END`,
              };
      return db.transaction(async (tx) => {
        // A retry put back while the channel's agent is emergency-stopped
        // ends here instead, so it never goes out once the channel is on.
        // The row first, so a stop marking it waits for this: a retry put
        // back before the mark is cancelled as the channel is turned on.
        if (given.status === "pending") {
          await tx.execute(
            sql`SELECT 1 FROM slack_outbox WHERE id = ${fence.id}::uuid FOR UPDATE`,
          );
        }
        const [stopped] =
          given.status === "pending"
            ? rowsOf(
                await tx.execute(sql`
                  SELECT 1 FROM slack_outbox o
                  JOIN surface_bindings b
                    ON b.installation_id = o.installation_id
                    AND b.external_surface_id = o.channel_id
                  WHERE o.id = ${fence.id}::uuid
                    AND o.kind <> 'emergency_stop_notice'
                    AND (o.error_code = ${TURN_EMERGENCY_STOPPED_REASON} OR (
                      b.revoked_at IS NULL
                      AND b.emergency_stopped_at IS NOT NULL))`),
              )
            : [];
        const outcome: typeof given = stopped
          ? { status: "failed", errorCode: TURN_EMERGENCY_STOPPED_REASON }
          : given;
        const limitedMs =
          outcome.status === "pending" &&
          (outcome.errorCode === SURFACE_RATE_LIMITED_CODE ||
            outcome.errorCode === SURFACE_EDIT_RATE_LIMITED_CODE)
            ? outcome.retryInMs
            : null;
        const [row] = await tx
          .update(t)
          .set({
            ...setOf(outcome),
            ...released,
            // SET reads the old status: still pending means beginSend never
            // ran. A rate-limited call gives back the attempt beginSend took.
            attempts:
              limitedMs === null
                ? sql`CASE WHEN ${t.status} = 'pending' THEN ${t.attempts} + 1 ELSE ${t.attempts} END`
                : sql`CASE WHEN ${t.status} = 'sending' THEN ${t.attempts} - 1 ELSE ${t.attempts} END`,
          })
          .where(fenced(fence))
          .returning({
            sessionId: t.sessionId,
            workspaceId: t.workspaceId,
            inputId: t.inputId,
            installationId: t.installationId,
            channelId: t.channelId,
            threadTs: t.threadTs,
            progressTs: t.progressTs,
            kind: t.kind,
          });
        if (row === undefined) return false;
        // The limit holds the install's other rows it covers too (claim,
        // beginSend): an edit's is chat.update's, a post's its channel's,
        // a progress update's post where its edit found none included.
        if (limitedMs !== null) {
          const blocks = slackOutboxRateBlocks;
          await tx
            .insert(blocks)
            .values({
              installationId: row.installationId,
              scope:
                row.kind === "reaction"
                  ? "reactions.add"
                  : outcome.status === "pending" &&
                      outcome.errorCode === SURFACE_EDIT_RATE_LIMITED_CODE
                    ? "chat.update"
                    : `channel:${row.channelId}`,
              blockedUntil: sql`now() + ${ms(limitedMs)}`,
            })
            .onConflictDoUpdate({
              target: [blocks.installationId, blocks.scope],
              set: {
                blockedUntil: sql`greatest(${blocks.blockedUntil}, excluded.blocked_until)`,
              },
            });
        }
        // A post into the thread is a moment to show its status again soon;
        // an edit of one, or a reaction, is not.
        if (
          outcome.status === "sent" &&
          row.sessionId &&
          row.kind !== "reaction" &&
          row.progressTs !== outcome.slackTs
        ) {
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
