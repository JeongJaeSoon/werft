import { z } from "zod";
import { surfaceKindSchema } from "../kollegium/surfaces.ts";
import { INT4_MAX, sha256HexSchema } from "../shared/ids.ts";

// The tool-call audit record (observability design, section 7). One row per
// judgment on one tool call. Every string in it is an id or a member of a
// closed list; there is no field for input text, a result or a reason.

export const TOOL_AUDIT_DECISION_VALUES = [
  "allow",
  "deny",
  "require_approval",
  "unknown",
] as const;
export const toolAuditDecisionSchema = z.enum(TOOL_AUDIT_DECISION_VALUES);
export type ToolAuditDecision = z.infer<typeof toolAuditDecisionSchema>;

/** The decision each basis can stand under (design 7.3.2). */
export const TOOL_AUDIT_BASIS_VERDICT = {
  trusted_tool: "allow",
  permission_mode: "allow",
  memory_read: "allow",
  approval: "allow",
  not_permitted: "deny",
  hook_deny: "deny",
  approval_denied: "deny",
  approval_expired: "deny",
  approval_cancelled: "deny",
  engine_internal: "unknown",
  unreported: "unknown",
  approval_unverified: "unknown",
  approval_asked: "require_approval",
} as const satisfies Record<string, ToolAuditDecision>;

export type ToolAuditBasis = keyof typeof TOOL_AUDIT_BASIS_VERDICT;
export const TOOL_AUDIT_BASIS_VALUES = Object.keys(
  TOOL_AUDIT_BASIS_VERDICT,
) as [ToolAuditBasis, ...ToolAuditBasis[]];
export const toolAuditBasisSchema = z.enum(TOOL_AUDIT_BASIS_VALUES);

/** Bases whose claim the API checks against `pending_requests` (design 7.3.1). */
export const TOOL_AUDIT_APPROVAL_BASIS_VALUES = [
  "approval",
  "approval_denied",
  "approval_expired",
  "approval_cancelled",
] as const satisfies readonly ToolAuditBasis[];

// A worker states what it saw. `approval_asked` is the platform's own row and
// `approval_unverified` is what the API turns a failed check into.
const WORKER_REPORT_BASIS_VALUES = TOOL_AUDIT_BASIS_VALUES.filter(
  (basis) => basis !== "approval_asked" && basis !== "approval_unverified",
) as [ToolAuditBasis, ...ToolAuditBasis[]];

export const TOOL_AUDIT_PHASE_VALUES = ["asked", "decided"] as const;
export const TOOL_AUDIT_SOURCE_VALUES = ["platform", "worker_report"] as const;
export const TOOL_AUDIT_RECORD_VERSION = 1;
export const INVALID_TOOL_NAME = "invalid_tool_name";

/** What an externally supplied id may look like; anything else is not stored. */
const AUDIT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
// `t:<tool_use_id>` or `n:<ordinal in the turn>`: the prefix keeps the two
// name spaces from colliding, so the cap is the id's 128 plus two.
const CALL_KEY_PATTERN = /^[tn]:[A-Za-z0-9_.:-]{1,128}$/;
const MCP_TOOL_PATTERN = /^mcp__([^_](?:[^_]|_(?!_))*)__.+$/;

/** An id for the audit table, or null when it is not of the allowed shape. */
export function auditIdOf(value: string | undefined | null): string | null {
  return typeof value === "string" && AUDIT_ID_PATTERN.test(value)
    ? value
    : null;
}

/** The server of an `mcp__<server>__<tool>` name, when it is a storable id. */
export function mcpServerOf(toolName: string): string | null {
  const match = MCP_TOOL_PATTERN.exec(toolName);
  return match?.[1] === undefined ? null : auditIdOf(match[1]);
}

/**
 * One judgment as a worker reports it on `append-events`. The strings are
 * loose here on purpose: a tool name from a remote MCP server or an id the
 * engine made up is stored as `invalid_tool_name` or null rather than
 * costing the whole append (`sanitizeToolDecision`).
 */
export const toolDecisionReportSchema = z
  .object({
    call_key: z.string().regex(CALL_KEY_PATTERN),
    tool_name: z.string().min(1).max(512),
    tool_use_id: z.string().max(512).optional(),
    parent_tool_use_id: z.string().max(512).optional(),
    // Of the redacted input in canonical form; both or neither.
    input_sha256: sha256HexSchema.optional(),
    input_bytes: z.number().int().min(0).max(INT4_MAX).optional(),
    decision: toolAuditDecisionSchema.exclude(["require_approval"]),
    basis: z.enum(WORKER_REPORT_BASIS_VALUES),
    pending_request_id: z.string().max(512).optional(),
    // Over the arguments before redaction, to be compared and thrown away.
    approval_input_hash: sha256HexSchema.optional(),
  })
  .strict()
  .superRefine((report, context) => {
    if (TOOL_AUDIT_BASIS_VERDICT[report.basis] !== report.decision) {
      context.addIssue({
        code: "custom",
        message: `basis ${report.basis} is not a ${report.decision}`,
      });
    }
    if (
      (report.input_sha256 === undefined) !==
      (report.input_bytes === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "input_sha256 and input_bytes come together",
      });
    }
  });
export type ToolDecisionReport = z.infer<typeof toolDecisionReportSchema>;

/** The most reports one append may carry. */
export const TOOL_DECISIONS_PER_APPEND_MAX = 500;

/**
 * The request field: a malformed item becomes null instead of failing the
 * request, because one bad report must not hold up the events next to it.
 * The API drops the nulls and counts them (`tool_audit.dropped`).
 */
export const toolDecisionsFieldSchema = z
  .array(toolDecisionReportSchema.or(z.unknown().transform(() => null)))
  .max(TOOL_DECISIONS_PER_APPEND_MAX);

/** A report once its strings are cleaned: what the platform hands the store. */
export type SanitizedToolDecision = {
  callKey: string;
  toolName: string;
  mcpServer: string | null;
  toolUseId: string | null;
  parentToolUseId: string | null;
  inputSha256: string | null;
  inputBytes: number | null;
  decision: ToolAuditDecision;
  basis: ToolAuditBasis;
  pendingRequestId: string | null;
  approvalInputHash: string | null;
};

export function sanitizeToolDecision(
  report: ToolDecisionReport,
): SanitizedToolDecision {
  const toolName = auditIdOf(report.tool_name) ?? INVALID_TOOL_NAME;
  return {
    callKey: report.call_key,
    toolName,
    mcpServer: toolName === INVALID_TOOL_NAME ? null : mcpServerOf(toolName),
    toolUseId: auditIdOf(report.tool_use_id),
    parentToolUseId: auditIdOf(report.parent_tool_use_id),
    inputSha256: report.input_sha256 ?? null,
    inputBytes: report.input_bytes ?? null,
    decision: report.decision,
    basis: report.basis,
    pendingRequestId: auditIdOf(report.pending_request_id),
    approvalInputHash: report.approval_input_hash ?? null,
  };
}

/** The stored record (design 7.3). */
export const toolCallAuditEntrySchema = z
  .object({
    id: z.uuid(),
    at: z.date(),
    workspace_id: z.uuid().nullable(),
    owner_id: z.string().min(1),
    session_id: z.uuid(),
    turn_id: z.number().int().positive(),
    attempt_id: z.string().min(1),
    call_key: z.string().regex(CALL_KEY_PATTERN),
    phase: z.enum(TOOL_AUDIT_PHASE_VALUES),
    tool_use_id: z.string().regex(AUDIT_ID_PATTERN).nullable(),
    parent_tool_use_id: z.string().regex(AUDIT_ID_PATTERN).nullable(),
    tool_name: z.string().regex(AUDIT_ID_PATTERN),
    mcp_server: z.string().regex(AUDIT_ID_PATTERN).nullable(),
    input_sha256: sha256HexSchema.nullable(),
    input_bytes: z.number().int().min(0).nullable(),
    decision: toolAuditDecisionSchema,
    basis: toolAuditBasisSchema,
    agent_id: z.uuid().nullable(),
    agent_release_id: z.string().nullable(),
    actor_user_id: z.uuid().nullable(),
    principal_kind: z.string().nullable(),
    principal_id: z.string().nullable(),
    surface: surfaceKindSchema.nullable(),
    pending_request_id: z.string().regex(AUDIT_ID_PATTERN).nullable(),
    answered_by: z.record(z.string(), z.unknown()).nullable(),
    answer_surface: surfaceKindSchema.nullable(),
    answer_decision_id: z.uuid().nullable(),
    source: z.enum(TOOL_AUDIT_SOURCE_VALUES),
    record_version: z.literal(TOOL_AUDIT_RECORD_VERSION),
  })
  .strict();
export type ToolCallAuditEntry = z.infer<typeof toolCallAuditEntrySchema>;
