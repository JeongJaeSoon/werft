import { parseArgs } from "node:util";
import {
  type ConversationId,
  conversationIdSchema,
  emailSchema,
  normalizeEmail,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { type Database, deleteConversationRecords } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";

// An admin's delete of one channel conversation's records (C8). There is no
// route: whoever can run a command in the API container runs it, naming the
// workspace owner or admin it is done for.

export const CONVERSATION_RECORDS_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  not_found: 3,
  refused: 4,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/conversation-records.ts delete --conversation <conversation_id> --by <admin's address> [--dry-run]
  delete     deletes the agent's engagement rows in the channel, the channel's summary with its
             history, and the agent's buffered messages of the conversation. Messages those name
             that no turn holds are marked deleted first, and the sessions with one among their
             sources stop. Sessions, turns, their inputs, events, transcripts and checkpoints stay.
  --by       a live owner or admin of the conversation's workspace, kept as who deleted
  --dry-run  counts what would go and changes nothing
Environment: DATABASE_URL (required)
Output: one line of JSON on stdout.
Exit codes: 0 done (also when nothing was left to delete); 1 unexpected error; 2 usage;
            3 no such conversation; 4 refused: a DM conversation, or --by is not an admin`;

export class ConversationRecordsUsageError extends Error {}

export type ConversationRecordsCommand = {
  command: "delete";
  conversationId: ConversationId;
  by: string;
  dryRun: boolean;
};

export function parseConversationRecordsCommand(
  argv: string[],
): ConversationRecordsCommand {
  const usage = (message?: string) =>
    new ConversationRecordsUsageError(message ? `${message}\n${USAGE}` : USAGE);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    throw usage("unknown option or argument, or an option without its value");
  }
  const [command, ...extra] = parsed.positionals;
  if (command !== "delete" || extra.length > 0) throw usage();
  const { conversation, by } = parsed.values;
  if (conversation === undefined || by === undefined) {
    throw usage("--conversation and --by are required");
  }
  // Checked here: a malformed id would reach the uuid column as a 22P02.
  const id = conversationIdSchema.safeParse(conversation.toLowerCase());
  if (!id.success) throw usage("--conversation must be a UUID");
  const address = emailSchema.safeParse(by);
  if (!address.success) throw usage("--by must be an email address");
  return {
    command,
    conversationId: id.data,
    by: normalizeEmail(address.data),
    dryRun: parsed.values["dry-run"] === true,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      conversation: { type: "string" },
      by: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

export type ConversationRecordsIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
};

async function run(
  command: ConversationRecordsCommand,
  db: Database,
): Promise<{ exit: number; line: Record<string, unknown> }> {
  const result = await deleteConversationRecords(db, {
    conversationId: command.conversationId,
    by: command.by,
    dryRun: command.dryRun,
  });
  const { ok, not_found, refused } = CONVERSATION_RECORDS_EXIT;
  switch (result.outcome) {
    case "not_found":
      return { exit: not_found, line: { outcome: result.outcome } };
    case "dm_not_supported":
    case "not_admin":
      return { exit: refused, line: { outcome: result.outcome } };
    default:
      return {
        exit: ok,
        line: {
          outcome: result.outcome,
          conversation_id: command.conversationId,
          engagements: result.counts.engagements,
          summary_lines: result.counts.summaryLines,
          buffered: result.counts.buffered,
          turns: result.counts.turns,
          marked: result.counts.marked,
          sessions_stopped: result.sessionsStopped,
        },
      };
  }
}

/** Returns the exit code. */
export async function runConversationRecords(
  argv: string[],
  io: ConversationRecordsIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`conversation-records: ${message}`);
    return code;
  };
  try {
    const command = parseConversationRecordsCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(CONVERSATION_RECORDS_EXIT.usage, "DATABASE_URL is required");
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
    if (error instanceof ConversationRecordsUsageError) {
      return fail(CONVERSATION_RECORDS_EXIT.usage, error.message);
    }
    return fail(
      CONVERSATION_RECORDS_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runConversationRecords(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "conversation-records",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
