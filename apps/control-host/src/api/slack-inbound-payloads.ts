import { parseArgs } from "node:util";
import * as schema from "@werft-ai/db";
import {
  countSlackInboundPayloads,
  type Database,
  purgeProcessedSlackInboundPayloads,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";

/** Part of the CLI contract: the docs branch on these. */
export const SLACK_INBOUND_PAYLOADS_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  /** Processed rows still hold a payload: a host older than the release that clears them wrote them meanwhile. */
  incomplete: 3,
} as const;

export const SLACK_INBOUND_PAYLOADS_DEFAULT_BATCH = 1000;
const MAX_BATCH = 10_000;
// Counting only reads; a page this large is still one short statement.
// Each page is its own snapshot, so the totals are not one moment's.
const COUNT_PAGE = 10_000;

const USAGE = `Usage: bun run apps/control-host/src/api/slack-inbound-payloads.ts [--batch-size <n>]
  Clears the payload of Slack inbox rows that were processed and still hold one, the rows a
  release before the one that clears them on completion left behind. Received rows and failed
  rows are left as they are (the reconciler clears a failed row's 7 days after receipt).
  Run it once every host runs a release that clears payloads on completion. Running it again
  changes nothing more.
  --batch-size  rows per statement, each its own transaction (default ${SLACK_INBOUND_PAYLOADS_DEFAULT_BATCH}, at most ${MAX_BATCH})
Environment: DATABASE_URL (required)
Output: one line of JSON on stdout: rows holding a payload by status before and after, rows
        cleared, batches, batch size and duration. Counts only, no payload.
Exit codes: 0 done (also when nothing had to change); 1 unexpected error; 2 usage;
            3 processed rows still hold a payload afterwards; a host on an earlier release is
              still running. Run it again once it is gone.`;

export class SlackInboundPayloadsUsageError extends Error {}

export function parseSlackInboundPayloadsCommand(argv: string[]): {
  batchSize: number;
} {
  const usage = (message: string) =>
    new SlackInboundPayloadsUsageError(`${message}\n${USAGE}`);
  let values: { "batch-size"?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { "batch-size": { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw usage(`unknown argument: ${argv.join(" ")}`);
  }
  const raw = values["batch-size"];
  if (raw === undefined) {
    return { batchSize: SLACK_INBOUND_PAYLOADS_DEFAULT_BATCH };
  }
  const batchSize = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(batchSize <= MAX_BATCH)) {
    throw usage(`--batch-size must be a whole number from 1 to ${MAX_BATCH}`);
  }
  return { batchSize };
}

export type SlackInboundPayloadsIo = {
  env: Record<string, string | undefined>;
  out(line: string): void;
  err(line: string): void;
  openDatabase(
    databaseUrl: string,
  ): Promise<{ db: Database; close(): Promise<void> }>;
  /** Milliseconds; tests fix it. */
  now?: () => number;
};

/** Returns the exit code. */
export async function runSlackInboundPayloads(
  argv: string[],
  io: SlackInboundPayloadsIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`slack-inbound-payloads: ${message}`);
    return code;
  };
  try {
    const { batchSize } = parseSlackInboundPayloadsCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(
        SLACK_INBOUND_PAYLOADS_EXIT.usage,
        "DATABASE_URL is required",
      );
    }
    const now = io.now ?? (() => performance.now());
    const database = await io.openDatabase(databaseUrl);
    try {
      const started = now();
      const before = await countSlackInboundPayloads(database.db, {
        pageSize: COUNT_PAGE,
      });
      const { cleared, batches } = await purgeProcessedSlackInboundPayloads(
        database.db,
        { batchSize },
      );
      const after = await countSlackInboundPayloads(database.db, {
        pageSize: COUNT_PAGE,
      });
      const incomplete = after.processed > 0;
      io.out(
        JSON.stringify({
          outcome: incomplete ? "incomplete" : "cleared",
          before,
          after,
          cleared,
          batches,
          batch_size: batchSize,
          duration_ms: Math.round(now() - started),
        }),
      );
      return incomplete
        ? SLACK_INBOUND_PAYLOADS_EXIT.incomplete
        : SLACK_INBOUND_PAYLOADS_EXIT.ok;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof SlackInboundPayloadsUsageError) {
      return fail(SLACK_INBOUND_PAYLOADS_EXIT.usage, error.message);
    }
    return fail(
      SLACK_INBOUND_PAYLOADS_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runSlackInboundPayloads(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "slack-inbound-payloads",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
