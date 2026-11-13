import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  emailSchema,
  normalizeEmail,
  PASSWORD_RESET_TTL_MINUTES,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresLoginSettingsStore,
  type Database,
  disableLoginProvidersAsOperator,
  enablePasswordLoginAsOperator,
  issueOperatorPasswordReset,
  loginProviders,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { generatePasswordResetToken, hashWebSessionToken } from "./auth.ts";

// The way back in when sign-in is broken (design 9.3): for whoever can run a
// command in the API container, which is whoever holds the database.

export const LOGIN_RECOVERY_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  not_found: 3,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/login-recovery.ts status
       bun run apps/control-host/src/api/login-recovery.ts enable-password
       bun run apps/control-host/src/api/login-recovery.ts disable-provider (--id <provider_id> | --all)
       bun run apps/control-host/src/api/login-recovery.ts reset-password --email <owner's address>
  status           the providers, whether passwords are open to everyone, and the emergency admin
  enable-password  opens password sign-in to everyone again
  disable-provider turns the provider(s) off and ends the sessions made through them; if passwords
                   were closed and no provider is left on, opens them in the same transaction
  reset-password   prints a one-time token for a live owner (60 minutes). Setting a password with it
                   (POST /v1/auth/password-reset {"token","password"}) makes that owner the
                   emergency admin; a token nobody uses changes nothing
Environment: DATABASE_URL (required)
Output: one line of JSON on stdout. reset-password's line carries the token: keep it out of logs.
Exit codes: 0 done (also when nothing had to change); 1 unexpected error; 2 usage;
            3 no such provider, or no live owner with that address`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LoginRecoveryUsageError extends Error {}

export type LoginRecoveryCommand =
  | { command: "status" | "enable-password" }
  | { command: "disable-provider"; target: { id: string } | "all" }
  | { command: "reset-password"; email: string };

export function parseLoginRecoveryCommand(
  argv: string[],
): LoginRecoveryCommand {
  const usage = (message?: string) =>
    new LoginRecoveryUsageError(message ? `${message}\n${USAGE}` : USAGE);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    throw usage("unknown option or argument, or an option without its value");
  }
  const [command, ...extra] = parsed.positionals;
  const { id, all, email } = parsed.values;
  if (extra.length > 0) throw usage();
  const none = id === undefined && all === undefined && email === undefined;
  switch (command) {
    case "status":
    case "enable-password":
      if (!none) throw usage();
      return { command };
    case "disable-provider":
      if (email !== undefined || (id === undefined) === (all === undefined)) {
        throw usage("give one of --id and --all");
      }
      if (id === undefined) return { command, target: "all" };
      // Checked here: a malformed id would reach the uuid column as a 22P02.
      if (!UUID.test(id)) throw usage("--id must be a UUID");
      return { command, target: { id: id.toLowerCase() } };
    case "reset-password": {
      if (id !== undefined || all !== undefined || email === undefined) {
        throw usage("--email is required");
      }
      const address = emailSchema.safeParse(email);
      if (!address.success) throw usage("--email must be an email address");
      return { command, email: normalizeEmail(address.data) };
    }
    default:
      throw usage();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      id: { type: "string" },
      all: { type: "boolean" },
      email: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
}

export type LoginRecoveryIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
};

async function run(
  command: LoginRecoveryCommand,
  db: Database,
): Promise<{ exit: number; line: Record<string, unknown> }> {
  const { ok, not_found } = LOGIN_RECOVERY_EXIT;
  switch (command.command) {
    case "status": {
      const settings = await createPostgresLoginSettingsStore(db).read();
      const providers = await db
        .select({
          id: loginProviders.id,
          display_name: loginProviders.displayName,
          issuer: loginProviders.issuer,
          enabled: loginProviders.enabled,
        })
        .from(loginProviders)
        .orderBy(asc(loginProviders.displayName), asc(loginProviders.id));
      return {
        exit: ok,
        line: {
          outcome: "ok",
          password_login: settings.passwordLogin,
          emergency_admin: settings.emergencyAdmin && {
            email: settings.emergencyAdmin.email,
            // False: they could not sign in with a password now.
            eligible: settings.emergencyAdmin.eligible,
          },
          providers,
        },
      };
    }
    case "enable-password": {
      const { outcome } = await enablePasswordLoginAsOperator(db);
      return { exit: ok, line: { outcome, password_login: "on" } };
    }
    case "disable-provider": {
      const result = await disableLoginProvidersAsOperator(db, command.target);
      if (result.outcome === "not_found") {
        return { exit: not_found, line: { outcome: "not_found" } };
      }
      return {
        exit: ok,
        line: {
          outcome: "disabled",
          providers: result.providers.map((provider) => ({
            id: provider.id,
            display_name: provider.displayName,
            sessions_revoked: provider.sessionsRevoked,
          })),
          password_login_opened: result.passwordLoginOpened,
        },
      };
    }
    case "reset-password": {
      const token = generatePasswordResetToken();
      const issued = await issueOperatorPasswordReset(db, {
        id: randomUUID(),
        email: command.email,
        tokenHash: hashWebSessionToken(token),
        ttlMs: PASSWORD_RESET_TTL_MINUTES * 60_000,
        receiptId: randomUUID(),
      });
      if (issued.outcome === "not_found") {
        return { exit: not_found, line: { outcome: "not_found" } };
      }
      return {
        exit: ok,
        line: {
          outcome: "issued",
          user_id: issued.userId,
          token,
          expires_at: issued.expiresAt.toISOString(),
        },
      };
    }
  }
}

/** Returns the exit code. Only reset-password's line carries a secret. */
export async function runLoginRecovery(
  argv: string[],
  io: LoginRecoveryIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`login-recovery: ${message}`);
    return code;
  };
  try {
    const command = parseLoginRecoveryCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(LOGIN_RECOVERY_EXIT.usage, "DATABASE_URL is required");
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
    if (error instanceof LoginRecoveryUsageError) {
      return fail(LOGIN_RECOVERY_EXIT.usage, error.message);
    }
    return fail(
      LOGIN_RECOVERY_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runLoginRecovery(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "login-recovery",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
