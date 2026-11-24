import { parseArgs } from "node:util";
import {
  type BudgetAccountId,
  budgetAccountIdSchema,
  emailSchema,
  normalizeEmail,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  type Database,
  resolveUnknownBudget,
  UNKNOWN_BUDGET_RESOLVE_MAX,
  type UnknownBudgetResolveLine,
  unknownBudgetByAccount,
  unknownBudgetLines,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { drizzle } from "drizzle-orm/node-postgres";

// An operator's view and resolve of budget reservations whose end is unknown
// (the reconciler's unknown_at). There is no route: whoever can run a command
// in the API container runs it, naming the workspace owner or admin it is
// done for.

export const BUDGET_UNKNOWN_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  refused: 4,
} as const;

const LIST_LIMIT_MAX = 1_000;
const REASON_MAX = 500;

const USAGE = `Usage: bun run apps/control-host/src/api/budget-unknown.ts list [--account <budget_account_id>] [--limit <n>]
       bun run apps/control-host/src/api/budget-unknown.ts resolve (--account <budget_account_id> | --call <call_id>...) --by <admin's address> [--refund --reason <text>] [--reason <text>] [--limit <n>] [--dry-run]
  list       the accounts holding the most reservations of unknown end and the total over every
             account, as the reconciler logs them, and the reservations themselves, the oldest mark
             first (of --account when given), at most --limit (default 100, at most ${LIST_LIMIT_MAX})
  resolve    closes the reservations named by --call (repeated), or the oldest of --account, at most
             --limit of them (default and at most ${UNKNOWN_BUDGET_RESOLVE_MAX}). By default each is charged at what it
             held; --refund charges nothing and needs --reason. Either way its hold comes off the
             account, its call stops counting as in progress, and a resolve_unknown_budget receipt is
             written. A reservation whose end is not unknown is left as it is. A late report of a
             resolved call adds its difference to the same account and month as an adjustment.
  --by       a live owner or admin of each reservation's workspace, kept as who resolved it
  --reason   why, kept on each receipt (at most ${REASON_MAX} characters)
  --dry-run  says what would be resolved and changes nothing
Environment: DATABASE_URL (required)
Output: one line of JSON on stdout.
Exit codes: 0 done (also when nothing was left to resolve); 1 unexpected error; 2 usage;
            4 refused: --by is not an owner or admin of a workspace named, or lost the role mid-run`;

export class BudgetUnknownUsageError extends Error {}

export type BudgetUnknownCommand =
  | { command: "list"; accountId?: BudgetAccountId; limit: number }
  | {
      command: "resolve";
      target:
        | { kind: "account"; accountId: BudgetAccountId; limit: number }
        | { kind: "calls"; callIds: string[] };
      by: string;
      refund: boolean;
      reason: string | null;
      dryRun: boolean;
    };

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      account: { type: "string" },
      call: { type: "string", multiple: true },
      by: { type: "string" },
      refund: { type: "boolean" },
      reason: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

export function parseBudgetUnknownCommand(
  argv: string[],
): BudgetUnknownCommand {
  const usage = (message?: string) =>
    new BudgetUnknownUsageError(message ? `${message}\n${USAGE}` : USAGE);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    throw usage("unknown option or argument, or an option without its value");
  }
  const [command, ...extra] = parsed.positionals;
  if ((command !== "list" && command !== "resolve") || extra.length > 0) {
    throw usage();
  }
  const values = parsed.values;
  const limitOf = (max: number, fallback: number) => {
    if (values.limit === undefined) return fallback;
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      throw usage(`--limit must be a whole number from 1 to ${max}`);
    }
    return limit;
  };
  // Checked here: a malformed id would reach the uuid column as a 22P02.
  const accountOf = (raw: string) => {
    const id = budgetAccountIdSchema.safeParse(raw.toLowerCase());
    if (!id.success) throw usage("--account must be a UUID");
    return id.data;
  };
  if (command === "list") {
    for (const name of ["call", "by", "refund", "reason", "dry-run"] as const) {
      if (values[name] !== undefined) throw usage(`list takes no --${name}`);
    }
    return {
      command,
      ...(values.account === undefined
        ? {}
        : { accountId: accountOf(values.account) }),
      limit: limitOf(LIST_LIMIT_MAX, 100),
    };
  }
  const calls = values.call ?? [];
  if ((values.account === undefined) === (calls.length === 0)) {
    throw usage("resolve takes --account or --call, one of the two");
  }
  if (calls.length > 0 && values.limit !== undefined) {
    throw usage("--limit goes with --account");
  }
  if (calls.length > UNKNOWN_BUDGET_RESOLVE_MAX) {
    throw usage(`at most ${UNKNOWN_BUDGET_RESOLVE_MAX} --call a run`);
  }
  if (calls.some((call) => !/^[A-Za-z0-9_.:-]{1,200}$/.test(call))) {
    throw usage("--call must be a call id");
  }
  if (values.by === undefined) throw usage("--by is required");
  const address = emailSchema.safeParse(values.by);
  if (!address.success) throw usage("--by must be an email address");
  const reason = values.reason?.trim() ?? null;
  if (reason !== null && (reason.length === 0 || reason.length > REASON_MAX)) {
    throw usage(`--reason must be 1 to ${REASON_MAX} characters`);
  }
  const refund = values.refund === true;
  if (refund && reason === null) throw usage("--refund needs --reason");
  return {
    command,
    target:
      values.account !== undefined
        ? {
            kind: "account",
            accountId: accountOf(values.account),
            limit: limitOf(
              UNKNOWN_BUDGET_RESOLVE_MAX,
              UNKNOWN_BUDGET_RESOLVE_MAX,
            ),
          }
        : { kind: "calls", callIds: calls },
    by: normalizeEmail(address.data),
    refund,
    reason,
    dryRun: values["dry-run"] === true,
  };
}

export type BudgetUnknownIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
};

function lineOf(line: UnknownBudgetResolveLine) {
  if (!("held" in line)) {
    return { call_id: line.callId, outcome: line.outcome };
  }
  return {
    call_id: line.callId,
    outcome: line.outcome,
    call_kind: line.callKind,
    account_id: line.accountId,
    held_cost_usd: line.held.costUsd,
    held_tokens: line.held.tokens,
    charged_cost_usd: line.charged.costUsd,
    charged_tokens: line.charged.tokens,
    receipt_id: line.receiptId,
  };
}

async function run(
  command: BudgetUnknownCommand,
  db: Database,
): Promise<{ exit: number; line: Record<string, unknown> }> {
  const { ok, refused } = BUDGET_UNKNOWN_EXIT;
  if (command.command === "list") {
    const [report, lines] = await Promise.all([
      unknownBudgetByAccount(db, command.limit),
      unknownBudgetLines(db, {
        accountId: command.accountId,
        limit: command.limit,
      }),
    ]);
    // Named as the reconciler's log names them, so the two can be compared.
    return {
      exit: ok,
      line: {
        accounts: report.accounts.map((account) => ({
          account_id: account.accountId,
          owner_kind: account.ownerKind,
          owner_id: account.ownerId,
          unknown_count: account.count,
          held_cost_usd: account.costUsd,
          held_tokens: account.tokens,
        })),
        total: {
          account_count: report.total.accountCount,
          unknown_count: report.total.count,
          held_cost_usd: report.total.costUsd,
          held_tokens: report.total.tokens,
        },
        lines: lines.map((line) => ({
          call_id: line.callId,
          call_kind: line.callKind,
          workspace_id: line.workspaceId,
          account_id: line.accountId,
          owner_kind: line.ownerKind,
          owner_id: line.ownerId,
          period_start: line.periodStart,
          held_cost_usd: line.costUsd,
          held_tokens: line.tokens,
          unknown_at: line.unknownAt.toISOString(),
          created_at: line.createdAt.toISOString(),
          session_id: line.sessionId,
          agent_id: line.agentId,
          conversation_turn_id: line.conversationTurnId,
        })),
      },
    };
  }
  const callIds =
    command.target.kind === "calls"
      ? command.target.callIds
      : (
          await unknownBudgetLines(db, {
            accountId: command.target.accountId,
            limit: command.target.limit,
          })
        ).map((line) => line.callId);
  const runId = crypto.randomUUID();
  const resolution = command.refund ? "refunded" : "spent";
  const result = await resolveUnknownBudget(db, {
    callIds,
    by: command.by,
    resolution,
    reason: command.reason,
    dryRun: command.dryRun,
    runId,
  });
  if (result.outcome === "not_admin") {
    return {
      exit: refused,
      line: { outcome: "not_admin", workspace_ids: result.workspaceIds },
    };
  }
  const resolved = result.lines.filter(
    (line) => line.outcome === "resolved",
  ).length;
  return {
    exit: result.stoppedAt === null ? ok : refused,
    line: {
      outcome:
        result.stoppedAt !== null
          ? "not_admin"
          : result.outcome === "dry_run"
            ? "dry_run"
            : resolved > 0
              ? "resolved"
              : "unchanged",
      run_id: result.outcome === "dry_run" ? null : runId,
      resolution,
      resolved,
      stopped_at: result.stoppedAt,
      lines: result.lines.map(lineOf),
    },
  };
}

/** Returns the exit code. */
export async function runBudgetUnknown(
  argv: string[],
  io: BudgetUnknownIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`budget-unknown: ${message}`);
    return code;
  };
  try {
    const command = parseBudgetUnknownCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(BUDGET_UNKNOWN_EXIT.usage, "DATABASE_URL is required");
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
    if (error instanceof BudgetUnknownUsageError) {
      return fail(BUDGET_UNKNOWN_EXIT.usage, error.message);
    }
    return fail(
      BUDGET_UNKNOWN_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runBudgetUnknown(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "budget-unknown",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
