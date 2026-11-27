import { parseArgs } from "node:util";
import {
  agentIdSchema,
  type ConversationRollout,
  conversationRolloutSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { type Database, setConversationRollout } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

// Shows and changes an agent's conversation switch. The Slack notice
// approval it once listed is retired, and its rows are not read.

export const SLACK_NOTICE_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  not_found: 3,
  refused: 4,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/slack-notice.ts show --agent <agent_id>
       bun run apps/control-host/src/api/slack-notice.ts set-rollout --agent <agent_id> --rollout off|shadow
  show  the agent's conversation switch (rollout) and workspace
  set-rollout  the agent's conversation switch, as an owner or admin sets it in the console: on is
        not open yet; off removes what the agent holds for judgment. A change writes a
        set_conversation_rollout receipt with by operator_cli; setting the value it holds changes
        and records nothing.
Environment: DATABASE_URL (required)
Output: one line of JSON on stdout, ids and values only.
Exit codes: 0 done (set-rollout also when unchanged); 1 unexpected error; 2 usage; 3 no such agent;
            4 set-rollout refused: reason_code rollout_on_unavailable`;

export class SlackNoticeUsageError extends Error {}

export type SlackNoticeCommand =
  | { command: "show"; agentId: string }
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
  const { agent, rollout } = parsed.values;
  if (extra.length > 0) throw usage();
  if (
    command === "set-rollout" &&
    agent !== undefined &&
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
  if (command === "show" && agent !== undefined) {
    const id = agentIdSchema.safeParse(agent.toLowerCase());
    if (!id.success) throw usage("--agent must be a UUID");
    return { command, agentId: id.data };
  }
  throw usage();
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
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
};

async function run(
  command: SlackNoticeCommand,
  db: Database,
): Promise<{ exit: number; line: Record<string, unknown> }> {
  const notFound = {
    exit: SLACK_NOTICE_EXIT.not_found,
    line: { outcome: "not_found" },
  };
  const [agent] = await db
    .select({
      workspaceId: schema.agents.workspaceId,
      rollout: schema.agents.conversationRollout,
    })
    .from(schema.agents)
    .where(eq(schema.agents.id, command.agentId));
  if (agent === undefined) return notFound;
  if (command.command === "set-rollout") {
    const result = await setConversationRollout(db, {
      workspaceId: agent.workspaceId,
      agentId: command.agentId,
      rollout: command.rollout,
      by: "operator_cli",
    });
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
    if (result.outcome !== "on_unavailable") return notFound;
    return {
      exit: SLACK_NOTICE_EXIT.refused,
      line: {
        outcome: "refused",
        agent_id: command.agentId,
        reason_code: "rollout_on_unavailable",
      },
    };
  }
  return {
    exit: SLACK_NOTICE_EXIT.ok,
    line: {
      outcome: "shown",
      agent_id: command.agentId,
      workspace_id: agent.workspaceId,
      rollout: agent.rollout,
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
      const { exit, line } = await run(command, database.db);
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
