import { parseArgs } from "node:util";
import {
  agentIdSchema,
  type ConversationRollout,
  conversationRolloutSchema,
  SLACK_NOTICE_VERSIONS,
  type SlackNoticeVersionEntry,
  workspaceIdSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  type Database,
  judgeSlackNotice,
  listSlackNoticeApprovals,
  type SlackNoticeApprovalRecord,
  setConversationRollout,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

// Shows the Slack notice approvals, and changes an agent's conversation
// switch. Owners and admins approve and revoke in the console.

export const SLACK_NOTICE_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  not_found: 3,
  refused: 4,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/slack-notice.ts show --agent <agent_id>
       bun run apps/control-host/src/api/slack-notice.ts list --workspace <workspace_id>
       bun run apps/control-host/src/api/slack-notice.ts set-rollout --agent <agent_id> --rollout off|shadow
  show  the agent's approval under the published notice (approved with the ids of the rows that
        count, one per Slack team of its live installs, or the reason it is not: no_notice,
        not_installed, not_approved) and every approval row it has, revoked ones too
  list  every approval row of the workspace's agents, oldest first
  set-rollout  the agent's conversation switch, as an owner or admin sets it in the console: shadow
        only while the agent is approved (refused otherwise, nothing changed), on not yet; off
        removes what the agent holds for judgment. A change writes a set_conversation_rollout
        receipt with by operator_cli; setting the value it holds changes and records nothing.
  A row names its id, agent, Slack team, notice version, who approved and revoked it, and when.
  show also names the agent's switch (rollout).
Environment: DATABASE_URL (required)
Output: one line of JSON on stdout, ids, versions and times only.
Exit codes: 0 done (set-rollout also when unchanged); 1 unexpected error; 2 usage; 3 no such agent or workspace;
            4 set-rollout refused: reason_code rollout_on_unavailable, no_notice, not_installed or not_approved`;

export class SlackNoticeUsageError extends Error {}

export type SlackNoticeCommand =
  | { command: "show"; agentId: string }
  | { command: "list"; workspaceId: string }
  | { command: "set-rollout"; agentId: string; rollout: ConversationRollout };

export function parseSlackNoticeCommand(argv: string[]): SlackNoticeCommand {
  const usage = (message?: string) =>
    new SlackNoticeUsageError(message ? `${message}\n${USAGE}` : USAGE);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    throw usage("unknown option or argument, or an option without its value");
  }
  const [command, ...extra] = parsed.positionals;
  const { agent, workspace, rollout } = parsed.values;
  if (extra.length > 0) throw usage();
  if (
    command === "set-rollout" &&
    agent !== undefined &&
    workspace === undefined &&
    rollout !== undefined
  ) {
    const id = agentIdSchema.safeParse(agent.toLowerCase());
    if (!id.success) throw usage("--agent must be a UUID");
    const value = conversationRolloutSchema.safeParse(rollout);
    if (!value.success) throw usage("--rollout must be off or shadow");
    return { command, agentId: id.data, rollout: value.data };
  }
  if (rollout !== undefined) throw usage();
  // Checked here: a malformed id would reach the uuid column as a 22P02.
  if (command === "show" && agent !== undefined && workspace === undefined) {
    const id = agentIdSchema.safeParse(agent.toLowerCase());
    if (!id.success) throw usage("--agent must be a UUID");
    return { command, agentId: id.data };
  }
  if (command === "list" && workspace !== undefined && agent === undefined) {
    const id = workspaceIdSchema.safeParse(workspace.toLowerCase());
    if (!id.success) throw usage("--workspace must be a UUID");
    return { command, workspaceId: id.data };
  }
  throw usage();
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      workspace: { type: "string" },
      rollout: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
}

export type SlackNoticeIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
  /** Tests only; the published versions otherwise. */
  versions?: readonly SlackNoticeVersionEntry[];
};

const rowOf = (record: SlackNoticeApprovalRecord) => ({
  id: record.id,
  agent_id: record.agentId,
  slack_team_id: record.slackTeamId,
  notice_version: record.version,
  approved_by: record.approvedBy,
  approved_at: record.approvedAt.toISOString(),
  revoked_by: record.revokedBy,
  revoked_at: record.revokedAt?.toISOString() ?? null,
});

async function run(
  command: SlackNoticeCommand,
  db: Database,
  versions: readonly SlackNoticeVersionEntry[],
): Promise<{ exit: number; line: Record<string, unknown> }> {
  const notFound = {
    exit: SLACK_NOTICE_EXIT.not_found,
    line: { outcome: "not_found" },
  };
  if (command.command === "list") {
    const [workspace] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, command.workspaceId));
    if (workspace === undefined) return notFound;
    const records = await listSlackNoticeApprovals(db, {
      workspaceId: command.workspaceId,
    });
    return {
      exit: SLACK_NOTICE_EXIT.ok,
      line: {
        outcome: "listed",
        workspace_id: command.workspaceId,
        approvals: records.map(rowOf),
      },
    };
  }
  const [agent] = await db
    .select({
      workspaceId: schema.agents.workspaceId,
      rollout: schema.agents.conversationRollout,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, command.agentId));
  if (agent === undefined) return notFound;
  if (command.command === "set-rollout") {
    const result = await setConversationRollout(
      db,
      {
        workspaceId: agent.workspaceId,
        agentId: command.agentId,
        rollout: command.rollout,
        by: "operator_cli",
      },
      versions,
    );
    if (result.outcome === "changed" || result.outcome === "unchanged") {
      return {
        exit: SLACK_NOTICE_EXIT.ok,
        line: {
          outcome: result.outcome,
          agent_id: command.agentId,
          before: result.before,
          after: result.after,
          buffered_dropped: result.bufferedDropped,
        },
      };
    }
    if (
      result.outcome !== "not_approved" &&
      result.outcome !== "on_unavailable"
    ) {
      return notFound;
    }
    return {
      exit: SLACK_NOTICE_EXIT.refused,
      line: {
        outcome: "refused",
        agent_id: command.agentId,
        reason_code:
          result.outcome === "not_approved"
            ? result.reason
            : "rollout_on_unavailable",
      },
    };
  }
  const judgment = await judgeSlackNotice(
    db,
    { workspaceId: agent.workspaceId, agentId: command.agentId },
    versions,
  );
  const records = await listSlackNoticeApprovals(db, {
    agentId: command.agentId,
  });
  return {
    exit: SLACK_NOTICE_EXIT.ok,
    line: {
      outcome: "shown",
      agent_id: command.agentId,
      workspace_id: agent.workspaceId,
      rollout: agent.rollout,
      approved: judgment.approved,
      ...(judgment.approved
        ? { counted: judgment.approvals.map((a) => a.approvalId) }
        : { reason: judgment.reason }),
      approvals: records.map(rowOf),
    },
  };
}

/** Returns the exit code. */
export async function runSlackNotice(
  argv: string[],
  io: SlackNoticeIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`slack-notice: ${message}`);
    return code;
  };
  try {
    const command = parseSlackNoticeCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(SLACK_NOTICE_EXIT.usage, "DATABASE_URL is required");
    }
    const database = await io.openDatabase(databaseUrl);
    try {
      const { exit, line } = await run(
        command,
        database.db,
        io.versions ?? SLACK_NOTICE_VERSIONS,
      );
      io.out(JSON.stringify(line));
      return exit;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof SlackNoticeUsageError) {
      return fail(SLACK_NOTICE_EXIT.usage, error.message);
    }
    return fail(
      SLACK_NOTICE_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runSlackNotice(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "slack-notice",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
