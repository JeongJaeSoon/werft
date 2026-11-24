// The operator's one-shot commands in the API image, run through the control
// host's executable:
//
//   bun run apps/control-host/src/main.ts admin bootstrap-owner --email <address> --out <file>
//   bun run apps/control-host/src/main.ts admin close-session <session_id> --reason <text>
//
// bootstrap-owner issues the one-time link that makes the first owner, for that
// address alone, while the install has no live owner (first install, or every
// owner lost); running it again replaces the earlier link. The link goes into
// --out, created with mode 0600 and never overwritten, and nowhere else: the
// screen shows the file and the expiry, and the audit line names the link by id.
//
// close-session closes a session as its owner's close does, live worker
// drained and released first, for an operator who holds no API key. The
// session's stream and the audit line name operator_cli as who closed it.

import { appendFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { emailSchema, normalizeEmail } from "@werft-ai/contracts";
import { closeSessionAsOperator, type OperatorCloseResult } from "@werft-ai/db";
import {
  createLogger,
  type LogRecord,
  type LogSink,
  type StructuredLogger,
} from "@werft-ai/observability";
import { type IdentityStore, messageOf } from "@werft-ai/platform";
import { withJobDatabase } from "../job-database.ts";
import {
  DatabaseIdentityStore,
  issueSetupToken,
  setupLinkPath,
} from "./auth.ts";
import { consoleOriginFrom } from "./slack-config.ts";

export const ADMIN_USAGE = `usage: bun run apps/control-host/src/main.ts admin bootstrap-owner --email <address> --out <file>
       bun run apps/control-host/src/main.ts admin close-session <session_id> --reason <text>`;

/** PID 1's stdout: the container's log under Docker and Kubernetes alike. */
export const CONTAINER_LOG_PATH = "/proc/1/fd/1";

export type BootstrapOwnerArgs = { email: string; out: string };

export function parseBootstrapOwnerArgs(argv: string[]): BootstrapOwnerArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new Error(`${messageOf(error)}\n${ADMIN_USAGE}`);
  }
  const [command, ...extra] = parsed.positionals;
  if (command !== "bootstrap-owner" || extra.length > 0) {
    throw new Error(ADMIN_USAGE);
  }
  const { email, out } = parsed.values;
  if (!email || !emailSchema.safeParse(email.trim()).success) {
    throw new Error(`--email must be an email address\n${ADMIN_USAGE}`);
  }
  if (!out) throw new Error(`--out is required\n${ADMIN_USAGE}`);
  return { email: normalizeEmail(email), out };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { email: { type: "string" }, out: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
}

/** What --out holds, in the field names POST /v1/invites answers with. */
export function setupLinkFile(
  token: string,
  expiresAt: Date,
  consoleOrigin: string | null,
): string {
  const acceptPath = setupLinkPath(token);
  return `${JSON.stringify(
    {
      accept_path: acceptPath,
      accept_url:
        consoleOrigin === null
          ? null
          : new URL(acceptPath, consoleOrigin).toString(),
      expires_at: expiresAt.toISOString(),
    },
    null,
    2,
  )}\n`;
}

/**
 * Appends each record to `path` (the container's log); when that cannot be
 * opened or written, the record goes to stderr instead and says why, so the
 * audit line is never lost.
 */
export function containerLogSink(path = CONTAINER_LOG_PATH): LogSink {
  return {
    write(record: LogRecord) {
      try {
        appendFileSync(path, `${JSON.stringify(record)}\n`);
      } catch (error) {
        console.error(
          JSON.stringify({
            ...record,
            audit_sink: "stderr",
            audit_sink_error: `${path}: ${messageOf(error)}`,
          }),
        );
      }
    },
  };
}

/**
 * The audit line's logger. It writes at info whatever LOG_LEVEL the
 * installation runs at: a link that is issued is always on record.
 */
export function auditLogger(path = CONTAINER_LOG_PATH): StructuredLogger {
  return createLogger({ level: "info", sinks: [containerLogSink(path)] });
}

/** The audit line of an issued link. Never the token or the link. */
export function auditSetupLinkIssued(
  logger: StructuredLogger,
  link: { id: string; email: string; expiresAt: Date },
): void {
  logger.info("Setup link issued", {
    event: "setup_link_issued",
    setup_link_id: link.id,
    email: link.email,
    expires_at: link.expiresAt.toISOString(),
  });
}

export type BootstrapOwnerOutcome =
  | { outcome: "issued"; path: string; expiresAt: Date }
  | { outcome: "owner_exists" };

/**
 * The file is created before the link is issued, so a path that cannot be
 * written leaves the earlier link in place; it is removed again when no link
 * is issued or the write fails. The audit line goes out as soon as the link
 * is issued, so a link that is live is on record even when the file write fails.
 */
export async function bootstrapOwner(
  args: BootstrapOwnerArgs,
  deps: {
    store: Pick<IdentityStore, "issueSetupLink">;
    consoleOrigin: string | null;
    audit: StructuredLogger;
  },
): Promise<BootstrapOwnerOutcome> {
  const path = resolve(args.out);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    throw new Error(
      `--out ${path}: ${messageOf(error)} (the file must not exist yet)`,
    );
  }
  let issued: Awaited<ReturnType<typeof issueSetupToken>> = null;
  try {
    // open's mode is narrowed by the umask only; this holds it at 0600.
    await handle.chmod(0o600);
    issued = await issueSetupToken(deps.store, args.email);
    if (issued !== null) {
      auditSetupLinkIssued(deps.audit, {
        id: issued.id,
        email: args.email,
        expiresAt: issued.expiresAt,
      });
      await handle.writeFile(
        setupLinkFile(issued.token, issued.expiresAt, deps.consoleOrigin),
      );
      await handle.sync();
    }
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  if (issued === null) {
    await rm(path, { force: true });
    return { outcome: "owner_exists" };
  }
  return { outcome: "issued", path, expiresAt: issued.expiresAt };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CloseSessionArgs = { sessionId: string; reason: string };

export function parseCloseSessionArgs(argv: string[]): CloseSessionArgs {
  let parsed: ReturnType<typeof parseClose>;
  try {
    parsed = parseClose(argv);
  } catch (error) {
    throw new Error(`${messageOf(error)}\n${ADMIN_USAGE}`);
  }
  const [command, sessionId, ...extra] = parsed.positionals;
  if (command !== "close-session" || !sessionId || extra.length > 0) {
    throw new Error(ADMIN_USAGE);
  }
  if (!UUID.test(sessionId)) {
    throw new Error(`session_id must be a UUID\n${ADMIN_USAGE}`);
  }
  // The owner finds the session closed by someone who is not in the
  // workspace; the reason is all they are told of why.
  const reason = parsed.values.reason?.trim();
  if (!reason) throw new Error(`--reason is required\n${ADMIN_USAGE}`);
  return { sessionId: sessionId.toLowerCase(), reason };
}

function parseClose(argv: string[]) {
  return parseArgs({
    args: argv,
    options: { reason: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
}

/** One line for the operator, and whether the session is closed or closing. */
export function describeCloseSessionResult(
  sessionId: string,
  result: OperatorCloseResult,
): { ok: boolean; line: string } {
  switch (result.outcome) {
    case "accepted":
      return {
        ok: true,
        line: `${result.admissionState} ${sessionId} owner=${result.ownerId} receipt=${result.receiptId} receipt_status=${result.receiptStatus}`,
      };
    case "already_closed":
      return { ok: true, line: `already_closed ${sessionId}` };
    case "closing":
      return {
        ok: true,
        line: `closing ${sessionId} receipt=${result.receiptId ?? "none"}`,
      };
    case "not_found":
      return { ok: false, line: `session ${sessionId} not found` };
    case "recovery_required":
      return {
        ok: false,
        line: `session ${sessionId} needs a recovery decision, not a close: no worker runs for it; end it with a recovery close (decision: close)`,
      };
    case "checkpoint_unavailable":
      return {
        ok: false,
        line: `session ${sessionId}: no trusted checkpoint covers its last turn, so it cannot close on its work; grants.ts revoke stops its worker without one`,
      };
    case "unsupported":
      return {
        ok: false,
        line: `session ${sessionId} runs on a legacy pod binding with no kill path`,
      };
    case "rejected":
      return {
        ok: false,
        line: `session ${sessionId} is ${result.admissionState}; only an active, paused or stopped session closes`,
      };
  }
}

/** The audit line of a close the operator asked for. */
export function auditSessionCloseRequested(
  logger: StructuredLogger,
  close: {
    sessionId: string;
    ownerId: string;
    receiptId: string;
    admissionState: string;
    reason: string;
    at: Date;
  },
): void {
  logger.info("Session close requested by the operator", {
    event: "session_close_requested",
    by: "operator_cli",
    session_id: close.sessionId,
    owner_id: close.ownerId,
    receipt_id: close.receiptId,
    admission_state: close.admissionState,
    reason: close.reason,
    requested_at: close.at.toISOString(),
  });
}

/** The close, and its audit line as soon as it is committed. */
export async function closeSession(
  args: CloseSessionArgs,
  deps: {
    close: (
      input: Parameters<typeof closeSessionAsOperator>[1],
    ) => Promise<OperatorCloseResult>;
    audit: StructuredLogger;
    now?: () => Date;
  },
): Promise<OperatorCloseResult> {
  const at = (deps.now ?? (() => new Date()))();
  const result = await deps.close({ ...args, now: at });
  if (result.outcome === "accepted") {
    auditSessionCloseRequested(deps.audit, {
      sessionId: args.sessionId,
      ownerId: result.ownerId,
      receiptId: result.receiptId,
      admissionState: result.admissionState,
      reason: args.reason,
      at,
    });
  }
  return result;
}

async function runCloseSession(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let args: CloseSessionArgs;
  try {
    args = parseCloseSessionArgs(argv);
  } catch (error) {
    console.error(messageOf(error));
    return 2;
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 1;
  }
  const poolLogger = createLogger({
    sinks: [{ write: (record) => console.error(JSON.stringify(record)) }],
  });
  try {
    const result = await withJobDatabase(
      "close-session",
      databaseUrl,
      poolLogger,
      ({ db }) =>
        closeSession(args, {
          close: (input) => closeSessionAsOperator(db, input),
          audit: auditLogger(),
        }),
    );
    const { ok, line } = describeCloseSessionResult(args.sessionId, result);
    (ok ? console.log : console.error)(line);
    return ok ? 0 : 1;
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }
}

/** `admin ...` from main.ts; the exit code. */
export async function runAdmin(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (argv[0] === "close-session") return runCloseSession(argv, env);
  let args: BootstrapOwnerArgs;
  let consoleOrigin: string | null;
  try {
    args = parseBootstrapOwnerArgs(argv);
    consoleOrigin = consoleOriginFrom(env);
  } catch (error) {
    console.error(messageOf(error));
    return 2;
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 1;
  }
  // stdout carries the path and the expiry alone; the pool's own lines go to
  // stderr.
  const poolLogger = createLogger({
    sinks: [{ write: (record) => console.error(JSON.stringify(record)) }],
  });
  try {
    const result = await withJobDatabase(
      "bootstrap-owner",
      databaseUrl,
      poolLogger,
      ({ db }) =>
        bootstrapOwner(args, {
          store: new DatabaseIdentityStore(db),
          consoleOrigin,
          audit: auditLogger(),
        }),
    );
    if (result.outcome === "owner_exists") {
      console.error(
        "A live owner exists, so no setup link is issued. An owner invites people from the console.",
      );
      return 1;
    }
    console.log(`file: ${result.path}`);
    console.log(`expires_at: ${result.expiresAt.toISOString()}`);
    return 0;
  } catch (error) {
    console.error(messageOf(error));
    return 1;
  }
}
