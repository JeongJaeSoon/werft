import { createHash } from "node:crypto";
import {
  auditIdOf,
  type SanitizedToolDecision,
  TOOL_AUDIT_APPROVAL_BASIS_VALUES,
  TOOL_AUDIT_RECORD_VERSION,
  type ToolAuditBasis,
} from "@werft-ai/contracts";
import type { ToolAuditOutcome } from "@werft-ai/platform";
import { and, eq, inArray } from "drizzle-orm";
import { expireByAuditRetention } from "./authz-decisions.ts";
import type { SessionRow } from "./fence.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  pendingRequests,
  permissionGrants,
  toolCallAudits,
  turns,
} from "./schema.ts";

type AuditRow = typeof toolCallAudits.$inferInsert;
type PendingRow = typeof pendingRequests.$inferSelect;

export type ToolAuditAppend = {
  session: SessionRow;
  attemptId: string;
  turn: { id: number; sequence: number };
  now: Date;
  reports: readonly SanitizedToolDecision[];
};

const isApprovalBasis = (basis: ToolAuditBasis): boolean =>
  (TOOL_AUDIT_APPROVAL_BASIS_VALUES as readonly string[]).includes(basis);

/**
 * Stores the judgments a worker reported, inside the transaction that stores
 * the same append's events: the rows and the events are both there or both
 * not. The caller holds the session row lock (`acquireFence`), which also
 * orders two appends of one session, so the checks below cannot race.
 *
 * Everything about who asked is read here, from the database; a report
 * contributes only the call, the tool, the hash of its redacted input, and
 * the judgment it saw. An approval it claims is checked against the request
 * row (design 7.3.1) and written as `unknown/approval_unverified` when it
 * does not hold.
 */
export async function insertToolCallAudits(
  tx: Database,
  append: ToolAuditAppend,
): Promise<ToolAuditOutcome> {
  const outcome: ToolAuditOutcome = {
    inserted: 0,
    duplicates: 0,
    conflicts: 0,
    unverified: 0,
  };
  if (append.reports.length === 0) return outcome;
  const { session, attemptId, turn } = append;

  const keyScope = and(
    eq(toolCallAudits.sessionId, session.id),
    eq(toolCallAudits.attemptId, attemptId),
    eq(toolCallAudits.turnId, turn.sequence),
    eq(toolCallAudits.phase, "decided"),
  );
  const stored = await tx
    .select()
    .from(toolCallAudits)
    .where(
      and(
        keyScope,
        inArray(
          toolCallAudits.callKey,
          append.reports.map((report) => report.callKey),
        ),
      ),
    );
  const storedByKey = new Map(stored.map((row) => [row.callKey, row]));

  const fresh = new Map<string, SanitizedToolDecision>();
  for (const report of append.reports) {
    const row = storedByKey.get(report.callKey);
    const twin = fresh.get(report.callKey);
    let resend: boolean;
    if (row !== undefined) {
      resend = isResendOf(row, report);
    } else if (twin !== undefined) {
      resend = isSameReport(twin, report);
    } else {
      fresh.set(report.callKey, report);
      continue;
    }
    if (resend) outcome.duplicates += 1;
    else outcome.conflicts += 1;
  }
  if (fresh.size === 0) return outcome;

  const subject = await subjectOf(tx, session, turn.id);
  const requests = await pendingOf(tx, session.id, [...fresh.values()]);
  const grants = await grantsOf(tx, [...requests.keys()]);
  const approvedElsewhere = await approvedRequests(tx, [...requests.keys()]);

  const rows: AuditRow[] = [];
  for (const report of fresh.values()) {
    let { basis, decision, pendingRequestId } = report;
    let answer: ReturnType<typeof answerCopy> | null = null;
    if (isApprovalBasis(basis)) {
      const request =
        pendingRequestId === null ? undefined : requests.get(pendingRequestId);
      const verified =
        request !== undefined &&
        verifiesApproval(report, request, {
          attemptId,
          turnRowId: turn.id,
          granted: grants.get(request.requestId),
          spent: approvedElsewhere.has(request.requestId),
          at: append.now,
        });
      if (verified) {
        answer = answerCopy(request);
        if (basis === "approval") approvedElsewhere.add(request.requestId);
      } else {
        basis = "approval_unverified";
        decision = "unknown";
        pendingRequestId = null;
        outcome.unverified += 1;
      }
    }
    rows.push({
      workspaceId: session.workspaceId,
      ownerId: session.ownerId,
      sessionId: session.id,
      turnId: turn.sequence,
      attemptId,
      callKey: report.callKey,
      phase: "decided",
      toolUseId: report.toolUseId,
      parentToolUseId: report.parentToolUseId,
      toolName: report.toolName,
      mcpServer: report.mcpServer,
      inputSha256: report.inputSha256,
      inputBytes: report.inputBytes,
      decision,
      basis,
      ...subject,
      pendingRequestId,
      answeredBy: answer?.answeredBy ?? null,
      answerSurface: answer?.answerSurface ?? null,
      answerDecisionId: answer?.answerDecisionId ?? null,
      source: "worker_report",
      recordVersion: TOOL_AUDIT_RECORD_VERSION,
    });
  }

  const inserted = await tx
    .insert(toolCallAudits)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: toolCallAudits.id });
  outcome.inserted = inserted.length;
  return outcome;
}

export async function insertAskedToolCallAudit(
  tx: Database,
  input: {
    session: SessionRow;
    attemptId: string;
    turn: { id: number; sequence: number };
    requestId: string;
    toolUseId: string | null;
    tool: SanitizedToolName;
  },
): Promise<void> {
  const { session, turn } = input;
  // The worker mints the request id and the registration takes any non-empty
  // string, so it passes the same filter as every other id from outside.
  const requestId = auditIdOf(input.requestId);
  await tx
    .insert(toolCallAudits)
    .values({
      workspaceId: session.workspaceId,
      ownerId: session.ownerId,
      sessionId: session.id,
      turnId: turn.sequence,
      attemptId: input.attemptId,
      callKey:
        input.toolUseId !== null
          ? `t:${input.toolUseId}`
          : `r:${requestId ?? createHash("sha256").update(input.requestId).digest("hex").slice(0, 32)}`,
      phase: "asked",
      toolUseId: input.toolUseId,
      toolName: input.tool.name,
      mcpServer: input.tool.mcpServer,
      inputSha256: null,
      inputBytes: null,
      decision: "require_approval",
      basis: "approval_asked",
      ...(await subjectOf(tx, session, turn.id)),
      pendingRequestId: requestId,
      source: "platform",
      recordVersion: TOOL_AUDIT_RECORD_VERSION,
    })
    .onConflictDoNothing();
}

export type SanitizedToolName = { name: string; mcpServer: string | null };

export function expireToolCallAudits(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  return expireByAuditRetention(db, toolCallAudits, input);
}

async function subjectOf(
  tx: Database,
  session: SessionRow,
  turnRowId: number,
): Promise<
  Pick<
    AuditRow,
    | "agentId"
    | "agentReleaseId"
    | "actorUserId"
    | "principalKind"
    | "principalId"
    | "surface"
  >
> {
  const [turn] = await tx
    .select({ actorId: turns.actorId, channel: turns.channel })
    .from(turns)
    .where(eq(turns.id, turnRowId))
    .limit(1);
  const [release] =
    session.agentReleaseId === null
      ? []
      : await tx
          .select({ agentId: agentReleases.agentId })
          .from(agentReleases)
          .where(eq(agentReleases.id, session.agentReleaseId))
          .limit(1);
  const principal =
    session.createdByUserId !== null
      ? { kind: "user", id: session.createdByUserId }
      : session.createdByApiKeyId !== null
        ? { kind: "api_key", id: session.createdByApiKeyId }
        : null;
  return {
    agentId: release?.agentId ?? null,
    agentReleaseId: session.agentReleaseId,
    actorUserId: turn?.actorId ?? null,
    principalKind: principal?.kind ?? null,
    principalId: principal?.id ?? null,
    surface: turn?.channel ?? session.channel ?? null,
  };
}

async function pendingOf(
  tx: Database,
  sessionId: string,
  reports: readonly SanitizedToolDecision[],
): Promise<Map<string, PendingRow>> {
  const ids = [
    ...new Set(
      reports
        .filter((report) => isApprovalBasis(report.basis))
        .flatMap((report) =>
          report.pendingRequestId === null ? [] : [report.pendingRequestId],
        ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(pendingRequests)
    .where(
      and(
        eq(pendingRequests.sessionId, sessionId),
        inArray(pendingRequests.requestId, ids),
      ),
    );
  return new Map(rows.map((row) => [row.requestId, row]));
}

async function grantsOf(
  tx: Database,
  requestIds: string[],
): Promise<Map<string, { turnId: number; attemptId: string | null }>> {
  if (requestIds.length === 0) return new Map();
  const rows = await tx
    .select({
      requestId: permissionGrants.requestId,
      turnId: permissionGrants.turnId,
      attemptId: permissionGrants.attemptId,
    })
    .from(permissionGrants)
    .where(inArray(permissionGrants.requestId, requestIds));
  return new Map(rows.map((row) => [row.requestId, row]));
}

async function approvedRequests(
  tx: Database,
  requestIds: string[],
): Promise<Set<string>> {
  if (requestIds.length === 0) return new Set();
  const rows = await tx
    .select({ requestId: toolCallAudits.pendingRequestId })
    .from(toolCallAudits)
    .where(
      and(
        inArray(toolCallAudits.pendingRequestId, requestIds),
        eq(toolCallAudits.phase, "decided"),
        eq(toolCallAudits.basis, "approval"),
      ),
    );
  return new Set(rows.flatMap((row) => (row.requestId ? [row.requestId] : [])));
}

function verifiesApproval(
  report: SanitizedToolDecision,
  request: PendingRow,
  context: {
    attemptId: string;
    turnRowId: number;
    granted: { turnId: number; attemptId: string | null } | undefined;
    spent: boolean;
    at: Date;
  },
): boolean {
  if (request.kind !== "permission") return false;
  if (request.tool === null || request.tool !== report.toolName) return false;
  if (
    report.approvalInputHash === null ||
    request.inputHash !== report.approvalInputHash
  ) {
    return false;
  }
  if (!basisMatchesRow(report.basis, request, context.at)) return false;
  if (
    report.basis === "approval" &&
    !servesThisCall(report, request, context)
  ) {
    return false;
  }
  if (report.basis === "approval" && context.spent) return false;
  return true;
}

function basisMatchesRow(
  basis: ToolAuditBasis,
  request: PendingRow,
  at: Date,
): boolean {
  const decision = answerDecision(request);
  switch (basis) {
    case "approval":
      return decision === "allow" && request.answeredBy !== null;
    case "approval_denied":
      return decision === "deny" && request.answeredBy !== null;
    case "approval_expired":
      return decision === null && endedBy(request, at) === "expired";
    case "approval_cancelled":
      return decision === null && endedBy(request, at) === "cancelled";
    default:
      return false;
  }
}

// An expiry sweep also sets `resolvedAt`, but never before `expiresAt`: a row
// resolved earlier than that was ended by something else.
function endedBy(
  request: PendingRow,
  at: Date,
): "expired" | "cancelled" | null {
  if (request.settledOutcome === "expired") return "expired";
  if (request.settledOutcome === "cancelled") return "cancelled";
  if (request.resolvedAt !== null) {
    return request.resolvedAt.getTime() >= request.expiresAt.getTime()
      ? "expired"
      : "cancelled";
  }
  return request.expiresAt.getTime() <= at.getTime() ? "expired" : null;
}

function servesThisCall(
  report: SanitizedToolDecision,
  request: PendingRow,
  context: {
    attemptId: string;
    turnRowId: number;
    granted: { turnId: number; attemptId: string | null } | undefined;
  },
): boolean {
  const sameCall =
    report.toolUseId !== null &&
    request.toolUseId === report.toolUseId &&
    request.attemptId === context.attemptId &&
    request.turnId === context.turnRowId;
  if (sameCall) return true;
  const grant = context.granted;
  return (
    grant !== undefined &&
    grant.turnId === context.turnRowId &&
    grant.attemptId === context.attemptId
  );
}

function answerDecision(request: PendingRow): "allow" | "deny" | null {
  const answer = request.answer as { decision?: unknown } | null;
  return answer?.decision === "allow" || answer?.decision === "deny"
    ? answer.decision
    : null;
}

function answerCopy(request: PendingRow) {
  return {
    answeredBy: request.answeredBy,
    answerSurface: request.answerSurface as AuditRow["answerSurface"],
    answerDecisionId: request.answerDecisionId,
  };
}

function isResendOf(
  row: typeof toolCallAudits.$inferSelect,
  report: SanitizedToolDecision,
): boolean {
  const unverified =
    row.basis === "approval_unverified" && isApprovalBasis(report.basis);
  return (
    row.toolName === report.toolName &&
    row.inputSha256 === report.inputSha256 &&
    row.inputBytes === report.inputBytes &&
    row.toolUseId === report.toolUseId &&
    row.parentToolUseId === report.parentToolUseId &&
    (unverified ||
      (row.basis === report.basis &&
        row.decision === report.decision &&
        row.pendingRequestId === report.pendingRequestId))
  );
}

function isSameReport(
  a: SanitizedToolDecision,
  b: SanitizedToolDecision,
): boolean {
  return (
    a.toolName === b.toolName &&
    a.inputSha256 === b.inputSha256 &&
    a.inputBytes === b.inputBytes &&
    a.toolUseId === b.toolUseId &&
    a.parentToolUseId === b.parentToolUseId &&
    a.pendingRequestId === b.pendingRequestId &&
    a.basis === b.basis &&
    a.decision === b.decision
  );
}
