import { parseArgs } from "node:util";
import * as schema from "@werft-ai/db";
import {
  type RestoreExecutionResult,
  type RevokeExecutionResult,
  restoreExecutionAtomic,
  revokeExecutionAtomic,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { messageOf } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";

// The operator's execution Grant command. Alpha has no Grant
// management API or UI (architecture.md 실행 권한 회수와 API key 회수), so
// this runs where keys.ts runs: inside the API image, against its database.
const USAGE = `Usage: bun run apps/control-host/src/api/grants.ts revoke <session_id> --reason <text>
       bun run apps/control-host/src/api/grants.ts restore <session_id> --reason <text>`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GrantsCommand = {
  command: "revoke" | "restore";
  sessionId: string;
  reason: string;
};

export function parseGrantsCommand(argv: string[]): GrantsCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new Error(`${messageOf(error)}\n${USAGE}`);
  }
  const [command, sessionId, ...extra] = parsed.positionals;
  if (
    (command !== "revoke" && command !== "restore") ||
    !sessionId ||
    extra.length > 0
  ) {
    throw new Error(USAGE);
  }
  if (!UUID.test(sessionId)) {
    throw new Error(`session_id must be a UUID\n${USAGE}`);
  }
  // The reason is the audit record's only account of why; an empty one
  // would leave the owner a stopped session and no explanation.
  const reason = parsed.values.reason?.trim();
  if (!reason) throw new Error(`--reason is required\n${USAGE}`);
  return { command, sessionId: sessionId.toLowerCase(), reason };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
}

/** One line for the operator, and whether the command did what it asked. */
export function describeGrantsResult(
  sessionId: string,
  result: RevokeExecutionResult | RestoreExecutionResult,
): { ok: boolean; line: string } {
  switch (result.outcome) {
    case "revoked":
      return {
        ok: true,
        line: `revoked ${sessionId} owner=${result.ownerId} auth_revision=${result.authRevision} execution=${result.executionId ?? "none"} credentials_revoked=${result.revokedCredentials} receipt=${result.receiptId} receipt_status=${result.receiptStatus}`,
      };
    case "already_revoked":
      return {
        ok: true,
        line: `already_revoked ${sessionId} revoked_at=${result.revokedAt.toISOString()} reason=${JSON.stringify(result.reason)}`,
      };
    case "restored":
      return {
        ok: true,
        line: `restored ${sessionId} owner=${result.ownerId}`,
      };
    case "not_revoked":
      return { ok: true, line: `not_revoked ${sessionId}` };
    case "not_found":
      return { ok: false, line: `session ${sessionId} not found` };
    case "closed":
      return { ok: false, line: `session ${sessionId} is closed` };
    case "unsupported":
      return {
        ok: false,
        line: `session ${sessionId} runs on a legacy pod binding with no kill path`,
      };
    case "execution_unconfirmed":
      return {
        ok: false,
        line: `session ${sessionId}: execution ${result.executionId} has not been observed gone; restore once it has`,
      };
  }
}

async function main(): Promise<void> {
  const command = parseGrantsCommand(Bun.argv.slice(2));
  const databaseUrl = Bun.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = createEnforcedPool(
    databaseUrl,
    createLogger(),
    "grants",
    JOB_POOL_TIMEOUTS,
  );
  try {
    const db = drizzle(pool, { schema });
    const input = {
      sessionId: command.sessionId,
      reason: command.reason,
      now: new Date(),
    };
    const result =
      command.command === "revoke"
        ? await revokeExecutionAtomic(db, input)
        : await restoreExecutionAtomic(db, input);
    const { ok, line } = describeGrantsResult(command.sessionId, result);
    if (ok) {
      console.log(line);
    } else {
      console.error(line);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await main();
}
