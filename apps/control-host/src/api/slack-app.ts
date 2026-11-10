import { parseArgs } from "node:util";
import * as schema from "@werft-ai/db";
import {
  createPostgresSlackAppStore,
  createPostgresSlackConfigTokenStore,
  type Database,
} from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import {
  createAuthorizationPolicy,
  type SecretKey,
  SessionServiceError,
  type SlackAppStore,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  createSlackAppService,
  createSlackConfigApi,
  createSlackConfigTokens,
  createSlackEventsFinalize,
  createSlackLinkAppService,
  slackEventsUrl,
} from "../wiring/chat-slack.ts";
import { loadSecretKey, SECRET_KEY_SETTING } from "./catalog-config.ts";
import {
  consoleOriginFrom,
  SlackConfigError,
  slackApiUrlFrom,
  slackEventsPublicUrlFrom,
} from "./slack-config.ts";

/** Part of the CLI contract: scripts and the verify skill branch on these. */
export const SLACK_APP_EXIT = {
  created: 0,
  unexpected: 1,
  usage: 2,
  config_token_invalid: 3,
  agent_not_found: 4,
  agent_not_active: 5,
  app_busy: 6,
  slack_error: 7,
  events_url_unset: 8,
} as const;

const USAGE = `Usage: bun run apps/control-host/src/api/slack-app.ts create --workspace <workspace_id> --agent <agent_id> [--replace-uncertain]
       bun run apps/control-host/src/api/slack-app.ts create --kind link --workspace <workspace_id> [--replace-uncertain]
       bun run apps/control-host/src/api/slack-app.ts finalize --agent <agent_id>
  --kind agent (default) makes the agent's app; --kind link makes the
  workspace's account-linking app (Sign in with Slack), which a first
  "Slack 연결" in the console would otherwise make.
  finalize sends the agent app's manifest again with its event subscription
  (<CONSOLE_ORIGIN>/v1/slack/events/<agent_id>), as an install does;
  running it again changes nothing.
Environment: DATABASE_URL and PLATFORM_SECRET_KEY (required),
             CONSOLE_ORIGIN (the console's public origin: create's OAuth redirect and finalize's events address),
             SLACK_EVENTS_PUBLIC_URL (finalize, only when events enter apart from the console: its https base)
Test only:   SLACK_API_URL (default https://slack.com/api; for the mock Slack stack)
Exit codes: 0 created, or the agent or workspace already had it, or finalized; 1 unexpected error; 2 usage;
            3 the config token is missing or Slack no longer takes it (paste a new one);
            4 agent or workspace not found, or the agent has no created app;
            5 the agent has no active release;
            6 the app is still being created or is being deleted (after checking
              api.slack.com/apps, --replace-uncertain gives up on a lost creation);
            7 Slack refused or could not be reached;
            8 finalize: no https events address is known (events_url_unset), nothing was sent`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SlackAppUsageError extends Error {}

export type SlackAppCommand =
  | ({
      command: "create";
      workspaceId: string;
      replaceUncertain: boolean;
    } & ({ kind: "agent"; agentId: string } | { kind: "link" }))
  | { command: "finalize"; agentId: string };

export function parseSlackAppCommand(argv: string[]): SlackAppCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    // parseArgs quotes the offending option; only its code is turned into words.
    const code = (error as { code?: unknown }).code;
    throw new SlackAppUsageError(
      `${code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ? "an option is missing its value" : "unknown option or argument"}\n${USAGE}`,
    );
  }
  const { workspace, agent } = parsed.values;
  if (parsed.positionals[0] === "finalize") {
    if (
      parsed.positionals.length !== 1 ||
      agent === undefined ||
      workspace !== undefined ||
      parsed.values.kind !== undefined ||
      parsed.values["replace-uncertain"] !== undefined
    ) {
      throw new SlackAppUsageError(USAGE);
    }
    if (!UUID.test(agent)) {
      throw new SlackAppUsageError(`--agent must be a UUID\n${USAGE}`);
    }
    return { command: "finalize", agentId: agent.toLowerCase() };
  }
  const kind = parsed.values.kind ?? "agent";
  if (
    parsed.positionals.length !== 1 ||
    parsed.positionals[0] !== "create" ||
    workspace === undefined ||
    (kind !== "agent" && kind !== "link") ||
    (kind === "agent") !== (agent !== undefined)
  ) {
    throw new SlackAppUsageError(USAGE);
  }
  for (const [name, value] of [
    ["--workspace", workspace],
    ["--agent", agent],
  ] as const) {
    if (value !== undefined && !UUID.test(value)) {
      throw new SlackAppUsageError(`${name} must be a UUID\n${USAGE}`);
    }
  }
  const common = {
    command: "create" as const,
    workspaceId: workspace.toLowerCase(),
    replaceUncertain: parsed.values["replace-uncertain"] === true,
  };
  return agent === undefined
    ? { ...common, kind: "link" }
    : { ...common, kind: "agent", agentId: agent.toLowerCase() };
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      kind: { type: "string" },
      workspace: { type: "string" },
      agent: { type: "string" },
      "replace-uncertain": { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
}

export type SlackAppIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  fetch?: typeof fetch;
  loadKey: (
    env: Record<string, string | undefined>,
  ) => Promise<SecretKey | null>;
  openDatabase: (
    databaseUrl: string,
  ) => Promise<{ db: Database; close(): Promise<void> }>;
};

const EXIT_BY_CODE: Partial<Record<string, number>> = {
  CONFIG_TOKEN_INVALID: SLACK_APP_EXIT.config_token_invalid,
  NOT_FOUND: SLACK_APP_EXIT.agent_not_found,
  AGENT_NOT_ACTIVE: SLACK_APP_EXIT.agent_not_active,
  SLACK_APP_CREATING: SLACK_APP_EXIT.app_busy,
  REVISION_CONFLICT: SLACK_APP_EXIT.app_busy,
  BACKEND_UNAVAILABLE: SLACK_APP_EXIT.slack_error,
};

async function finalize(
  agentId: string,
  deps: Parameters<typeof createSlackAppService>[0] & { apps: SlackAppStore },
  io: SlackAppIo,
): Promise<number> {
  const app = await deps.apps.findAgentApp(agentId);
  if (app === null) {
    io.err("slack-app: NOT_FOUND: the agent has no created Slack app");
    return SLACK_APP_EXIT.agent_not_found;
  }
  const publicUrl = slackEventsPublicUrlFrom(io.env);
  const result = await createSlackEventsFinalize({
    apps: createSlackAppService(deps),
    agents: deps.apps,
    publicUrl,
  })({ workspaceId: app.workspaceId, agentId, slackAppId: app.id });
  const warnings = result.warnings.map((warning) => warning.code);
  if (!result.finalized) {
    io.err(
      `slack-app: ${warnings.join(",")}: set CONSOLE_ORIGIN to the https console origin (or SLACK_EVENTS_PUBLIC_URL to the funnel's https base when events enter apart from it); nothing was sent`,
    );
    return SLACK_APP_EXIT.events_url_unset;
  }
  io.out(
    JSON.stringify({
      outcome: "finalized",
      slack_app_id: app.id,
      app_id: app.appId,
      agent_id: agentId,
      request_url:
        publicUrl === null ? null : slackEventsUrl(publicUrl, agentId),
      warnings,
    }),
  );
  return SLACK_APP_EXIT.created;
}

/** Returns the exit code. Nothing it writes carries a secret. */
export async function runSlackApp(
  argv: string[],
  io: SlackAppIo,
): Promise<number> {
  const fail = (code: number, message: string) => {
    io.err(`slack-app: ${message}`);
    return code;
  };
  try {
    const command = parseSlackAppCommand(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) {
      return fail(SLACK_APP_EXIT.usage, "DATABASE_URL is required");
    }
    const consoleOrigin = consoleOriginFrom(io.env);
    if (consoleOrigin === null && command.command === "create") {
      return fail(
        SLACK_APP_EXIT.usage,
        "CONSOLE_ORIGIN is required: the app's OAuth redirect is on the console's origin",
      );
    }
    const api = createSlackConfigApi({
      apiUrl: slackApiUrlFrom(io.env),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    const key = await io.loadKey(io.env);
    if (key === null) {
      return fail(
        SLACK_APP_EXIT.usage,
        "the master key is not set (PLATFORM_SECRET_KEY); the app's secrets have nowhere to go",
      );
    }

    const database = await io.openDatabase(databaseUrl);
    try {
      const deps = {
        authorization: createAuthorizationPolicy({}),
        apps: createPostgresSlackAppStore(database.db, key),
        tokens: createSlackConfigTokens({
          store: createPostgresSlackConfigTokenStore(database.db, key),
          api,
        }),
        api,
        consoleOrigin,
      };
      if (command.command === "finalize") {
        return await finalize(command.agentId, deps, io);
      }
      if (command.kind === "link") {
        const result = await createSlackLinkAppService(
          deps,
        ).createLinkAppAsOperator(command.workspaceId, {
          replace_uncertain: command.replaceUncertain,
        });
        io.out(
          JSON.stringify({
            outcome: result.created ? "created" : "exists",
            kind: "link",
            slack_app_id: result.slack_app.id,
            app_id: result.slack_app.app_id,
            client_id: result.slack_app.client_id,
            redirect_url: result.slack_app.redirect_url,
            created_by_token_user: result.slack_app.created_by_token_user,
            warnings: result.warnings,
          }),
        );
        return SLACK_APP_EXIT.created;
      }
      const service = createSlackAppService(deps);
      const result = await service.createAgentAppAsOperator(
        command.workspaceId,
        command.agentId,
        { replace_uncertain: command.replaceUncertain },
      );
      io.out(
        JSON.stringify({
          outcome: result.created ? "created" : "exists",
          slack_app_id: result.slack_app.id,
          app_id: result.slack_app.app_id,
          agent_id: result.slack_app.agent_id,
          created_by_token_user: result.slack_app.created_by_token_user,
          warnings: result.warnings,
          next: `Install it from the agent's page in the console, or with a signed-in console session: POST /v1/agents/${result.slack_app.agent_id}/slack/install/start`,
        }),
      );
      return SLACK_APP_EXIT.created;
    } finally {
      await database.close();
    }
  } catch (error) {
    if (error instanceof SlackAppUsageError) {
      return fail(SLACK_APP_EXIT.usage, error.message);
    }
    if (error instanceof SlackConfigError) {
      return fail(SLACK_APP_EXIT.usage, error.message);
    }
    if (error instanceof SessionServiceError) {
      // These carry codes and ids only, never a token or a secret.
      const reason = error.details ? ` ${JSON.stringify(error.details)}` : "";
      return fail(
        EXIT_BY_CODE[error.code] ?? SLACK_APP_EXIT.unexpected,
        `${error.code}: ${error.message}${reason}`,
      );
    }
    return fail(
      SLACK_APP_EXIT.unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

if (import.meta.main) {
  process.exitCode = await runSlackApp(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    loadKey: async (env) =>
      env[SECRET_KEY_SETTING] ? loadSecretKey(env) : null,
    async openDatabase(databaseUrl) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "slack-app",
        JOB_POOL_TIMEOUTS,
      );
      return { db: drizzle(pool, { schema }), close: () => pool.end() };
    },
  });
}
