import { parseArgs } from "node:util";
import * as schema from "@werft-ai/db";
import {
  type Database,
  findWorkspace,
  registerSlackInstallation,
  type SlackInstallationStatus,
  verifySlackInstallation,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { messageOf } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { SlackConfigError, slackApiUrlFrom } from "./slack-config.ts";

// Registers the Slack app's install in a team for a workspace and marks it
// verified, with the team and bot user Slack itself reports for the bot
// token. The token comes from SLACK_BOT_TOKEN only and is never written.

/** Part of the CLI contract: scripts and the verify skill branch on these. */
export const SLACK_INSTALL_EXIT = {
  verified: 0,
  unexpected: 1,
  usage: 2,
  slack_auth_failed: 3,
  workspace_conflict: 4,
  revoked: 5,
  workspace_not_found: 6,
  app_mismatch: 7,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/slack-install.ts register --workspace <workspace_id> --app-id <app_id>
Environment: SLACK_BOT_TOKEN (required; never an argument), DATABASE_URL (required),
             SLACK_API_URL (default https://slack.com/api; http only for a local mock)
Exit codes: 0 verified, 1 unexpected error, 2 usage, 3 Slack refused the token,
            4 workspace_conflict, 5 revoked, 6 workspace not found,
            7 the token belongs to another app`;

const SLACK_HTTP_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^A[A-Z0-9]+$/;
const SLACK_ID = /^[A-Z0-9]+$/;

export class SlackInstallUsageError extends Error {}

export type SlackInstallCommand = {
  command: "register";
  workspaceId: string;
  appId: string;
};

export function parseSlackInstallCommand(argv: string[]): SlackInstallCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    // parseArgs quotes the offending option, which may be a pasted token, so
    // only its error code is turned into words.
    const code = (error as { code?: unknown }).code;
    throw new SlackInstallUsageError(
      `${code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ? "an option is missing its value" : "unknown option or argument"}\n${USAGE}`,
    );
  }
  const { workspace, "app-id": appId } = parsed.values;
  if (
    parsed.positionals.length !== 1 ||
    parsed.positionals[0] !== "register" ||
    workspace === undefined ||
    appId === undefined
  ) {
    throw new SlackInstallUsageError(USAGE);
  }
  if (!UUID.test(workspace)) {
    throw new SlackInstallUsageError(`--workspace must be a UUID\n${USAGE}`);
  }
  if (!APP_ID.test(appId)) {
    throw new SlackInstallUsageError(
      `--app-id must be a Slack app id (A…)\n${USAGE}`,
    );
  }
  return {
    command: "register",
    workspaceId: workspace.toLowerCase(),
    appId,
  };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      workspace: { type: "string" },
      "app-id": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
}

// ---------------------------------------------------------------------------
// Asking Slack whose token this is
// ---------------------------------------------------------------------------

export type SlackBotIdentity = {
  teamId: string;
  botUserId: string;
  appId: string;
};

/** Slack refused the token, it is not a bot token, or Slack was unreachable. */
export class SlackAuthTestError extends Error {}

async function slackCall(
  apiUrl: string,
  method: string,
  token: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SlackAuthTestError(
      `${method}: Slack could not be reached (${error instanceof Error ? error.name : "error"})`,
    );
  }
  const body = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (body === null) {
    throw new SlackAuthTestError(
      `${method}: HTTP ${response.status} without a JSON body`,
    );
  }
  // Failures arrive as HTTP 200 with ok:false. Only a plain error code is
  // echoed, never the body.
  if (body.ok !== true) {
    const code =
      typeof body.error === "string" && /^[a-z_]+$/.test(body.error)
        ? body.error
        : `http_${response.status}`;
    throw new SlackAuthTestError(`${method}: ${code}`);
  }
  return body;
}

function field(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * auth.test names the team and the bot user; it does not name the app, so
 * bots.info (scope users:read) reads it from the bot.
 */
export async function slackBotIdentity(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SlackBotIdentity> {
  const auth = await slackCall(apiUrl, "auth.test", token, {}, fetchImpl);
  const teamId = field(auth, "team_id");
  const botUserId = field(auth, "user_id");
  const botId = field(auth, "bot_id");
  if (!teamId || !botUserId) {
    throw new SlackAuthTestError("auth.test: no team_id or user_id");
  }
  if (!botId) {
    throw new SlackAuthTestError("auth.test: not a bot token (no bot_id)");
  }
  const info = await slackCall(
    apiUrl,
    "bots.info",
    token,
    { bot: botId },
    fetchImpl,
  );
  const bot = info.bot;
  const appId =
    typeof bot === "object" && bot !== null
      ? field(bot as Record<string, unknown>, "app_id")
      : null;
  if (!appId) throw new SlackAuthTestError("bots.info: no app_id");
  // Stored and printed as they come, so held to the shape of Slack ids.
  if (![teamId, botUserId, appId].every((id) => SLACK_ID.test(id))) {
    throw new SlackAuthTestError("Slack answered ids of an unexpected shape");
  }
  return { teamId, botUserId, appId };
}

// ---------------------------------------------------------------------------
// Recording the install
// ---------------------------------------------------------------------------

export type SlackInstallOutcome =
  | {
      outcome: "verified";
      registration: "registered" | "existing";
      installationId: string;
    }
  | { outcome: "workspace_not_found" }
  | {
      outcome: "workspace_conflict";
      otherWorkspaceId: string;
      otherStatus: SlackInstallationStatus;
    }
  | { outcome: "revoked"; installationId: string };

async function installSlackApp(
  db: Database,
  workspaceId: string,
  identity: SlackBotIdentity,
): Promise<SlackInstallOutcome> {
  if (!(await findWorkspace(db, workspaceId))) {
    return { outcome: "workspace_not_found" };
  }
  const key = { appId: identity.appId, teamId: identity.teamId };
  const registered = await registerSlackInstallation(db, {
    ...key,
    workspaceId,
  });
  if (registered.outcome === "workspace_conflict") {
    return {
      outcome: "workspace_conflict",
      otherWorkspaceId: registered.installation.workspaceId,
      otherStatus: registered.installation.status,
    };
  }
  const verified = await verifySlackInstallation(db, {
    ...key,
    botUserId: identity.botUserId,
  });
  if (verified.outcome === "not_found") {
    throw new Error(
      `Slack installation ${key.appId}/${key.teamId} vanished after registering`,
    );
  }
  if (verified.outcome === "revoked") {
    return { outcome: "revoked", installationId: verified.installation.id };
  }
  return {
    outcome: "verified",
    registration: registered.outcome,
    installationId: verified.installation.id,
  };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export type SlackInstallIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  /** Opened only once Slack has answered for the token. */
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
};

function apiUrlFrom(env: Record<string, string | undefined>): string {
  try {
    return slackApiUrlFrom(env);
  } catch (error) {
    if (error instanceof SlackConfigError) {
      throw new SlackInstallUsageError(error.message);
    }
    throw error;
  }
}

/** Returns the exit code. Nothing it writes carries the token. */
export async function runSlackInstall(
  argv: string[],
  io: SlackInstallIo,
): Promise<number> {
  const token = io.env.SLACK_BOT_TOKEN ?? "";
  // A message built from someone else's error text could in principle echo
  // the token back; scrub it on the way out regardless.
  const scrub = (line: string) =>
    token.length > 0 ? line.replaceAll(token, "[redacted]") : line;
  const fail = (code: number, message: string) => {
    io.err(scrub(`slack-install: ${message}`));
    return code;
  };
  try {
    const command = parseSlackInstallCommand(argv);
    if (!token) {
      return fail(
        SLACK_INSTALL_EXIT.usage,
        "SLACK_BOT_TOKEN is required in the environment",
      );
    }
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(SLACK_INSTALL_EXIT.usage, "DATABASE_URL is required");
    }
    const apiUrl = apiUrlFrom(io.env);

    const identity = await slackBotIdentity(apiUrl, token, io.fetch);
    if (identity.appId !== command.appId) {
      return fail(
        SLACK_INSTALL_EXIT.app_mismatch,
        `app_mismatch: the token belongs to app ${identity.appId}, not ${command.appId}`,
      );
    }

    const database = await io.openDatabase(databaseUrl);
    let result: SlackInstallOutcome;
    try {
      result = await installSlackApp(
        database.db,
        command.workspaceId,
        identity,
      );
    } finally {
      await database.close();
    }
    const where = `app ${identity.appId} in team ${identity.teamId}`;
    switch (result.outcome) {
      case "workspace_not_found":
        return fail(
          SLACK_INSTALL_EXIT.workspace_not_found,
          `workspace_not_found: workspace ${command.workspaceId} not found`,
        );
      case "workspace_conflict":
        return fail(
          SLACK_INSTALL_EXIT.workspace_conflict,
          result.otherStatus === "revoked"
            ? `workspace_conflict: ${where} belongs to workspace ${result.otherWorkspaceId} (revoked there); only that workspace can register it again`
            : `workspace_conflict: ${where} is installed for workspace ${result.otherWorkspaceId}`,
        );
      case "revoked":
        return fail(
          SLACK_INSTALL_EXIT.revoked,
          `revoked: installation ${result.installationId} (${where}) was revoked while registering; run again to reopen it`,
        );
      case "verified":
        io.out(
          JSON.stringify({
            outcome: "verified",
            registration: result.registration,
            installation_id: result.installationId,
            workspace_id: command.workspaceId,
            app_id: identity.appId,
            team_id: identity.teamId,
            bot_user_id: identity.botUserId,
          }),
        );
        return SLACK_INSTALL_EXIT.verified;
    }
  } catch (error) {
    if (error instanceof SlackInstallUsageError) {
      return fail(SLACK_INSTALL_EXIT.usage, error.message);
    }
    if (error instanceof SlackAuthTestError) {
      return fail(
        SLACK_INSTALL_EXIT.slack_auth_failed,
        `slack_auth_failed: ${error.message}`,
      );
    }
    return fail(
      SLACK_INSTALL_EXIT.unexpected,
      `unexpected error: ${messageOf(error)}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runSlackInstall(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "slack-install",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
