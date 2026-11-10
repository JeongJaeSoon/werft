import { createHash } from "node:crypto";
import {
  adminDenySchema,
  type ReceiptActor,
  storedEngineSettingsSchema,
} from "@werft-ai/contracts";
import {
  applicableAdminDeny,
  type ClaimEngineSettings,
  effectiveEngineSettings,
  type MergedEngineSettings,
  mergeEngineSettings,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  agentEngineSettings,
  agentReleases,
  receipts,
  workspaceEngineSettings,
} from "./schema.ts";

/** What one claim evaluated, for its receipt. Never the rule text. */
export type ClaimRulesAudit = {
  startRevision: number | null;
  workspaceRevision: number | null;
  agentRevision: number | null;
  /** Rules by enforcement route: `mcpDeny` is enforced by the MCP egress, not sent to the engine. */
  counts: { engine: number; disallowedTools: number; mcpDeny: number };
  /** True when no source row exists at all: the claim is what it was before. */
  untouched: boolean;
};

export type ClaimEngineSettingsResult = (
  | { kind: "ok"; settings: ClaimEngineSettings }
  /** Some source cannot be trusted; the claim is refused, never sent without rules. */
  | { kind: "closed"; reason: string }
  /** The worker lacks a capability the merged rules need. */
  | { kind: "unsupported" }
) & { audit: ClaimRulesAudit };

type RuleSession = {
  workspaceId: string | null;
  agentReleaseId: string | null;
  engineSettingsStart: unknown;
};

type Evaluated = {
  merged: MergedEngineSettings;
  audit: ClaimRulesAudit;
};

const countOf = (lists: Record<string, string[] | undefined> | undefined) =>
  Object.values(lists ?? {}).reduce(
    (sum, list) => sum + (list?.length ?? 0),
    0,
  );

/**
 * The rules one claim sends, read in the claim's own transaction: the
 * workspace's, the agent's (against what the session started with) and the
 * inherited restrictions that bind the session's release. The same single
 * read decides the capability check, the receipt and the response.
 *
 * Rows are parsed structurally. The save path already ran the catalog's
 * parser, and the engine adapter is the last check, so a row that no longer
 * parses closes the claim rather than being read as "no rules".
 */
export async function claimEngineSettingsOf(
  tx: Database,
  session: RuleSession,
  supports: { engineSettings: boolean; permissionRules: boolean },
): Promise<ClaimEngineSettingsResult> {
  const { merged, audit } = await evaluate(tx, session);
  if (merged.kind === "closed") {
    return { kind: "closed", reason: merged.reason, audit };
  }
  if (
    (merged.engine !== undefined && !supports.engineSettings) ||
    (merged.disallowedTools.length > 0 && !supports.permissionRules)
  ) {
    return { kind: "unsupported", audit };
  }
  return {
    kind: "ok",
    settings: {
      ...(merged.engine === undefined ? {} : { engine: merged.engine }),
      disallowedTools: merged.disallowedTools,
    },
    audit,
  };
}

/**
 * The receipt of a claim that met saved rules: the revisions it evaluated, the
 * result and how many rules went where. A session no rule row touches writes
 * nothing, so a claim for an agent without rules is what it was.
 */
export async function recordClaimRules(
  tx: Database,
  session: { id: string; ownerId: string },
  result: ClaimEngineSettingsResult,
  actor: ReceiptActor | null = null,
): Promise<void> {
  if (result.audit.untouched) return;
  const { audit } = result;
  // The same session meeting the same revisions with the same result is one
  // receipt: a worker that cannot carry the rules retries every few seconds,
  // and each retry must not add a row.
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        session.id,
        result.kind,
        result.kind === "closed" ? result.reason : null,
        audit.startRevision,
        audit.workspaceRevision,
        audit.agentRevision,
        audit.counts,
      ]),
    )
    .digest("hex");
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  await tx
    .insert(receipts)
    .values({
      id,
      ownerId: session.ownerId,
      actor,
      requestId: null,
      operation: "resolve_session_engine_settings",
      targetRef: { session_id: session.id, turn_id: null, request_id: null },
      status: result.kind === "ok" ? "succeeded" : "failed",
      result: {
        outcome:
          result.kind === "ok"
            ? result.audit.counts.engine +
                result.audit.counts.disallowedTools +
                result.audit.counts.mcpDeny ===
              0
              ? "neutral"
              : "rules"
            : result.kind,
        ...(result.kind === "closed" ? { reason: result.reason } : {}),
        start_revision: result.audit.startRevision,
        workspace_revision: result.audit.workspaceRevision,
        agent_revision: result.audit.agentRevision,
        counts: {
          engine: result.audit.counts.engine,
          disallowed_tools: result.audit.counts.disallowedTools,
          mcp_deny: result.audit.counts.mcpDeny,
        },
      },
    })
    .onConflictDoNothing();
}

/**
 * The `mcp__` tool names saved rules deny for the session, or null when the
 * rules cannot be read. Callers treat null as "deny every MCP tool": the
 * platform enforces these at call time because the engine adapter takes no
 * `mcp__` rule in deny or ask.
 */
export async function mcpDeniedBy(
  executor: Database,
  session: RuleSession,
): Promise<string[] | null> {
  const { merged } = await evaluate(executor, session);
  return merged.kind === "closed" ? null : merged.mcpDeny;
}

async function evaluate(
  tx: Database,
  session: RuleSession,
): Promise<Evaluated> {
  const audit: ClaimRulesAudit = {
    startRevision: null,
    workspaceRevision: null,
    agentRevision: null,
    counts: { engine: 0, disallowedTools: 0, mcpDeny: 0 },
    untouched: true,
  };
  const start = session.engineSettingsStart as { revision?: unknown } | null;
  if (typeof start?.revision === "number") {
    audit.startRevision = start.revision;
    audit.untouched = false;
  }
  const closed = (reason: string): Evaluated => ({
    merged: { kind: "closed", reason },
    audit: { ...audit, untouched: false },
  });

  let workspace = null;
  if (session.workspaceId !== null) {
    const [row] = await tx
      .select()
      .from(workspaceEngineSettings)
      .where(eq(workspaceEngineSettings.workspaceId, session.workspaceId))
      .limit(1);
    if (row !== undefined) {
      audit.workspaceRevision = row.revision;
      audit.untouched = false;
      const parsed = storedEngineSettingsSchema.safeParse({
        permissions: row.permissions,
        auto_mode: row.autoMode,
      });
      if (!parsed.success) return closed("workspace_rules");
      workspace = parsed.data;
    }
  }

  let agentRow = null;
  let adminDeny: ReturnType<typeof applicableAdminDeny> = [];
  if (session.agentReleaseId !== null) {
    const [release] = await tx
      .select({ agentId: agentReleases.agentId })
      .from(agentReleases)
      .where(eq(agentReleases.id, session.agentReleaseId))
      .limit(1);
    if (release === undefined) return closed("release_unresolvable");
    const [row] = await tx
      .select()
      .from(agentEngineSettings)
      .where(eq(agentEngineSettings.agentId, release.agentId))
      .limit(1);
    if (row !== undefined) {
      audit.agentRevision = row.revision;
      audit.untouched = false;
      const parsed = storedEngineSettingsSchema.safeParse({
        permissions: row.permissions,
        auto_mode: row.autoMode,
      });
      const inherited = adminDenySchema.safeParse(row.adminDeny);
      if (!parsed.success) return closed("agent_rules");
      if (!inherited.success) return closed("admin_deny");
      agentRow = { ...parsed.data, revision: row.revision };
      adminDeny = applicableAdminDeny(inherited.data, session.agentReleaseId);
    }
  }

  const merged = mergeEngineSettings({
    workspace,
    agent: effectiveEngineSettings({
      start: session.engineSettingsStart,
      row: agentRow,
    }),
    adminDeny,
  });
  if (merged.kind === "closed") audit.untouched = false;
  if (merged.kind === "rules") {
    audit.counts = {
      engine:
        countOf(merged.engine?.permissions) + countOf(merged.engine?.autoMode),
      disallowedTools: merged.disallowedTools.length,
      mcpDeny: merged.mcpDeny.length,
    };
  }
  return { merged, audit };
}
