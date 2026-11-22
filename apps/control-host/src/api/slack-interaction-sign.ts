import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  agentIdSchema,
  apiErrorResponseSchema,
  slackBlockActionsPayloadSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import { createLogger } from "@werft-ai/observability";
import { SecretDecryptError, type SecretKey } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  postgresSlackInteractionTargets,
  type SlackInteractionTarget,
  type SlackInteractionTargets,
  slackRequestSignature,
} from "../wiring/slack-interaction-sign.ts";
import {
  loadSecretKey,
  MASTER_KEY_MISMATCH,
  MasterKeyError,
} from "./catalog-config.ts";

// Presses a card button the way Slack would: a block_actions form signed
// with the agent app's signing secret, so an operator can check a card's
// path end to end without a person clicking it.

export const SLACK_INTERACTION_SIGN_EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  not_found: 3,
  refused: 4,
  key_mismatch: 5,
} as const;

const SCRIPT = "bun run apps/control-host/src/api/slack-interaction-sign.ts";
const USAGE = `Usage: ${SCRIPT} --agent <agent_id> --action-id <id> --value <value>
         --channel <C…> --message-ts <ts> --user <U…>
         [--thread-ts <ts>] [--team <T…>] [--url <interactions url>]
  Posts one button press on a card the agent's Slack app posted to
  /v1/slack/interactions/<agent_id>, signed with that app's signing secret.
  --team     the Slack team; needed only when the app is installed in more than one
  --url      where to post; default http://127.0.0.1:$PORT/v1/slack/interactions/<agent_id>
Environment: DATABASE_URL and the master key (required): PLATFORM_SECRET_KEY, or PLATFORM_SECRET_KEY_FILE
             naming a file that holds it, as the API reads it; PORT (default 3000)
Output: one line of JSON on stdout: the HTTP status, the request id and the error code.
        The secret and the signature are never printed.
Exit codes: 0 the API answered 2xx; 1 unexpected error; 2 usage;
            3 no created Slack app with a signing secret for that agent, or no team;
            4 the API answered another status;
            5 master_key_mismatch: the stored signing secret does not open with this key
              (not the key the API runs with), or the two settings hold different keys`;

export class SlackInteractionSignUsageError extends Error {}

export type SlackInteractionPress = {
  agentId: string;
  actionId: string;
  value: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  userId: string;
  teamId?: string;
  url?: string;
};

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      "action-id": { type: "string" },
      value: { type: "string" },
      channel: { type: "string" },
      "message-ts": { type: "string" },
      "thread-ts": { type: "string" },
      user: { type: "string" },
      team: { type: "string" },
      url: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
}

export function parseSlackInteractionPress(
  argv: string[],
): SlackInteractionPress {
  const usage = (message?: string) =>
    new SlackInteractionSignUsageError(
      message ? `${message}\n${USAGE}` : USAGE,
    );
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse(argv).values;
  } catch {
    throw usage("unknown option or argument, or an option without its value");
  }
  const required = [
    "agent",
    "action-id",
    "value",
    "channel",
    "message-ts",
    "user",
  ] as const;
  const missing = required.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw usage(`missing ${missing.map((name) => `--${name}`).join(", ")}`);
  }
  const agent = agentIdSchema.safeParse(values.agent);
  if (!agent.success) throw usage("--agent must be a UUID");
  if (values.url !== undefined && !isHttpUrl(values.url)) {
    throw usage("--url must be an http or https URL");
  }
  const press: SlackInteractionPress = {
    agentId: agent.data.toLowerCase(),
    actionId: values["action-id"] ?? "",
    value: values.value ?? "",
    channelId: values.channel ?? "",
    messageTs: values["message-ts"] ?? "",
    userId: values.user ?? "",
    ...(values["thread-ts"] === undefined
      ? {}
      : { threadTs: values["thread-ts"] }),
    ...(values.team === undefined ? {} : { teamId: values.team }),
    ...(values.url === undefined ? {} : { url: values.url }),
  };
  // The receiver's own schema, with placeholder app and team: what it would
  // refuse as 400 is refused here before anything is read or signed.
  const check = slackBlockActionsPayloadSchema.safeParse(
    blockActions(press, {
      appId: "A0CHECK",
      teamId: press.teamId ?? "T0CHECK",
    }),
  );
  if (!check.success) {
    const fields = [
      ...new Set(check.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw usage(`not a Slack block_actions press: ${fields.join(", ")}`);
  }
  return press;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The fields the interactions receiver reads, as Slack sends them. */
function blockActions(
  press: SlackInteractionPress,
  target: { appId: string; teamId: string },
  nowMs = Date.now(),
) {
  return {
    type: "block_actions",
    api_app_id: target.appId,
    team: { id: target.teamId },
    user: { id: press.userId },
    channel: { id: press.channelId },
    container: {
      type: "message",
      message_ts: press.messageTs,
      channel_id: press.channelId,
    },
    message: {
      ts: press.messageTs,
      ...(press.threadTs === undefined ? {} : { thread_ts: press.threadTs }),
    },
    // Not a real Slack trigger: a press that opens a modal fails at
    // views.open, past the signature check.
    trigger_id: `werft-cli.${randomUUID()}`,
    actions: [
      {
        type: "button",
        action_id: press.actionId,
        value: press.value,
        action_ts: (nowMs / 1000).toFixed(6),
      },
    ],
  };
}

export type SlackInteractionSignIo = {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  openTargets: (
    databaseUrl: string,
    key: SecretKey,
  ) => Promise<{ targets: SlackInteractionTargets; close(): Promise<void> }>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Reads the file PLATFORM_SECRET_KEY_FILE names; the default reads the disk. */
  readFile?: (path: string) => string;
  now?: () => number;
};

const REQUEST_TIMEOUT_MS = 10_000;
// The API's request ids are UUIDs; anything else in that place is not
// printed, since a server at --url could echo the signature back there.
const REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the exit code. No line it writes carries the secret. */
export async function runSlackInteractionSign(
  argv: string[],
  io: SlackInteractionSignIo,
): Promise<number> {
  const { usage, not_found, unexpected } = SLACK_INTERACTION_SIGN_EXIT;
  const fail = (code: number, message: string) => {
    io.err(`slack-interaction-sign: ${message}`);
    return code;
  };
  try {
    const press = parseSlackInteractionPress(argv);
    const databaseUrl = io.env.DATABASE_URL;
    if (!databaseUrl) return fail(usage, "DATABASE_URL is required");
    const key = loadSecretKey(io.env, io.readFile);
    const opened = await io.openTargets(databaseUrl, key);
    let target: SlackInteractionTarget | null;
    try {
      target = await opened.targets.forAgent(press.agentId);
    } finally {
      await opened.close();
    }
    if (target === null) {
      return fail(
        not_found,
        "no created Slack app with a signing secret for that agent",
      );
    }
    const teamId = press.teamId ?? onlyTeam(target.teamIds);
    if (teamId === null) {
      return fail(
        not_found,
        target.teamIds.length === 0
          ? "the agent's Slack app is installed in no team; give --team"
          : `the agent's Slack app is installed in several teams (${target.teamIds.join(", ")}); give --team`,
      );
    }
    const nowMs = (io.now ?? Date.now)();
    const rawBody = new TextEncoder().encode(
      new URLSearchParams({
        payload: JSON.stringify(
          blockActions(press, { appId: target.appId, teamId }, nowMs),
        ),
      }).toString(),
    );
    const timestamp = String(Math.floor(nowMs / 1000));
    const port = io.env.PORT || "3000";
    const url =
      press.url ??
      `http://127.0.0.1:${port}/v1/slack/interactions/${press.agentId}`;
    let response: Response;
    try {
      response = await io.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": slackRequestSignature({
            signingSecret: target.signingSecret,
            timestamp,
            rawBody,
          }),
        },
        body: rawBody,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return fail(
        unexpected,
        `the request failed: ${error instanceof Error ? error.name : typeof error}`,
      );
    }
    const answered = await answerOf(response);
    io.out(JSON.stringify(answered));
    return response.ok
      ? SLACK_INTERACTION_SIGN_EXIT.ok
      : SLACK_INTERACTION_SIGN_EXIT.refused;
  } catch (error) {
    if (error instanceof SlackInteractionSignUsageError) {
      return fail(usage, error.message);
    }
    if (error instanceof MasterKeyError) {
      return fail(
        error.code === "master_key_mismatch"
          ? SLACK_INTERACTION_SIGN_EXIT.key_mismatch
          : usage,
        `${error.code}: ${error.message}`,
      );
    }
    if (error instanceof SecretDecryptError) {
      return fail(
        SLACK_INTERACTION_SIGN_EXIT.key_mismatch,
        MASTER_KEY_MISMATCH,
      );
    }
    return fail(
      unexpected,
      `unexpected error: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

function onlyTeam(teamIds: string[]): string | null {
  return teamIds.length === 1 ? (teamIds[0] ?? null) : null;
}

async function answerOf(response: Response) {
  const text = await response.text().catch(() => "");
  let error: { code: string; request_id: string | null } | null = null;
  try {
    const parsed = apiErrorResponseSchema.safeParse(JSON.parse(text));
    if (parsed.success) error = parsed.data.error;
  } catch {
    // Not JSON: only the status and the header say anything.
  }
  return {
    status: response.status,
    request_id:
      [response.headers.get("X-Request-Id"), error?.request_id].find(
        (id) => typeof id === "string" && REQUEST_ID.test(id),
      ) ?? null,
    error_code: error?.code ?? null,
  };
}

if (import.meta.main) {
  process.exitCode = await runSlackInteractionSign(Bun.argv.slice(2), {
    env: process.env,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    async openTargets(databaseUrl, key) {
      const pool = createEnforcedPool(
        databaseUrl,
        createLogger(),
        "slack-interaction-sign",
        JOB_POOL_TIMEOUTS,
      );
      return {
        targets: postgresSlackInteractionTargets(
          drizzle(pool, { schema }),
          key,
        ),
        close: () => pool.end(),
      };
    },
    fetch: (url, init) => fetch(url, init),
  });
}
