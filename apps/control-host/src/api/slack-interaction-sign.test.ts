import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  createSlackInteractionService,
  type SlackInteractionDeps,
  type SlackInteractionOutcome,
} from "@werft-ai/chat-slack";
import { SLACK_INTERACTION_ACTIONS } from "@werft-ai/contracts";
import type { SlackInteractionTarget } from "../wiring/slack-interaction-sign.ts";
import { createApiApp } from "./app.ts";
import { createSlackEventsLimiter } from "./rate-limit.ts";
import { registerSlackInteractionRoutes } from "./routes/surface/slack-interactions.ts";
import {
  parseSlackInteractionPress,
  runSlackInteractionSign,
  SLACK_INTERACTION_SIGN_EXIT,
  type SlackInteractionSignIo,
  SlackInteractionSignUsageError,
} from "./slack-interaction-sign.ts";

const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const APP_ID = "A0AGENT";
const SECRET = `sign-${randomBytes(16).toString("hex")}`;
const KEY_HEX = randomBytes(32).toString("hex");
const NOW_MS = Date.parse("2026-11-22T10:00:00.000Z");
const VALUE = JSON.stringify({
  s: "019a0000-0000-7000-8000-0000000000d1",
  r: "toolu_1",
});
const ARGV = [
  "--agent",
  AGENT,
  "--action-id",
  SLACK_INTERACTION_ACTIONS.permissionAllow,
  "--value",
  VALUE,
  "--channel",
  "C0CHAN",
  "--message-ts",
  "1761300000.000100",
  "--user",
  "U0PERSON",
];

/** The API's interactions route and receiver, checking with `receiverSecret`. */
function api(receiverSecret: string) {
  const outcomes: SlackInteractionOutcome[] = [];
  const receiver = createSlackInteractionService({
    signingSecrets: {
      forAgent: async (agentId: string) =>
        agentId === AGENT
          ? {
              workspaceId: "019a0000-0000-7000-8000-0000000000a1",
              slackAppId: "019a0000-0000-7000-8000-0000000000b1",
              appId: APP_ID,
              signingSecret: receiverSecret,
            }
          : null,
    },
    // The press stops at the bot token, after the signature and the payload
    // were taken; nothing past it is reached.
    botToken: async () => null,
    logger: { info() {}, warn() {} },
    now: () => new Date(NOW_MS),
  } as unknown as SlackInteractionDeps);
  const app = createApiApp({
    authMode: "api-key",
    registerPublicRoutes: (router) =>
      registerSlackInteractionRoutes(router, {
        interactions: {
          async receive(request) {
            const outcome = await receiver.receive(request);
            outcomes.push(outcome);
            return outcome;
          },
        },
        limiter: createSlackEventsLimiter(),
      }),
  });
  return { app, outcomes };
}

function io(
  app: ReturnType<typeof api>["app"],
  overrides: Partial<SlackInteractionSignIo> & {
    target?: SlackInteractionTarget | null;
  } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: { url: string; init: RequestInit }[] = [];
  const target =
    overrides.target === undefined
      ? { appId: APP_ID, signingSecret: SECRET, teamIds: ["T0TEAM"] }
      : overrides.target;
  const { fetch: send, target: _, ...rest } = overrides;
  const value: SlackInteractionSignIo = {
    env: {
      DATABASE_URL: "postgres://cli-test/db",
      PLATFORM_SECRET_KEY: KEY_HEX,
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    openTargets: async () => ({
      targets: { forAgent: async () => target },
      close: async () => {},
    }),
    fetch: async (url, init) => {
      sent.push({ url, init });
      return send ? send(url, init) : app.request(url, init);
    },
    now: () => NOW_MS,
    ...rest,
  };
  return { io: value, out, err, sent };
}

describe("slack-interaction-sign against the API's interactions receiver", () => {
  test("a press signed with the app's secret is taken and reaches the action", async () => {
    const { app, outcomes } = api(SECRET);
    const run = io(app);
    expect(await runSlackInteractionSign(ARGV, run.io)).toBe(
      SLACK_INTERACTION_SIGN_EXIT.ok,
    );
    expect(outcomes).toEqual([
      { kind: "ok", body: { ok: true }, result: "refused:no_bot_token" },
    ]);
    expect(run.sent[0]?.url).toBe(
      `http://127.0.0.1:3000/v1/slack/interactions/${AGENT}`,
    );
    const line = JSON.parse(run.out[0] ?? "");
    expect(line).toEqual({
      status: 200,
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      error_code: null,
    });
    expect(run.err).toEqual([]);
  });

  test("the payload carries what the receiver reads", async () => {
    const run = io(api(SECRET).app);
    await runSlackInteractionSign(
      [...ARGV, "--thread-ts", "1761300000.000001"],
      run.io,
    );
    const body = new URLSearchParams(
      new TextDecoder().decode(run.sent[0]?.init.body as Uint8Array),
    );
    expect(JSON.parse(body.get("payload") ?? "")).toMatchObject({
      type: "block_actions",
      api_app_id: APP_ID,
      team: { id: "T0TEAM" },
      user: { id: "U0PERSON" },
      channel: { id: "C0CHAN" },
      message: { ts: "1761300000.000100", thread_ts: "1761300000.000001" },
      actions: [
        { action_id: SLACK_INTERACTION_ACTIONS.permissionAllow, value: VALUE },
      ],
    });
  });

  test("a press signed with another secret is refused as 401", async () => {
    const { app, outcomes } = api(`other-${SECRET}`);
    const run = io(app);
    expect(await runSlackInteractionSign(ARGV, run.io)).toBe(
      SLACK_INTERACTION_SIGN_EXIT.refused,
    );
    expect(outcomes).toEqual([{ kind: "unauthorized" }]);
    expect(JSON.parse(run.out[0] ?? "")).toEqual({
      status: 401,
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      error_code: "UNAUTHORIZED",
    });
  });

  test("a press signed more than five minutes ago is refused as 401", async () => {
    const { app, outcomes } = api(SECRET);
    const run = io(app, { now: () => NOW_MS - 301_000 });
    expect(await runSlackInteractionSign(ARGV, run.io)).toBe(
      SLACK_INTERACTION_SIGN_EXIT.refused,
    );
    expect(outcomes).toEqual([{ kind: "unauthorized" }]);
    expect(JSON.parse(run.out[0] ?? "").error_code).toBe("UNAUTHORIZED");
  });

  test("no line, taken or refused, carries the secret or the signature", async () => {
    const runs = [
      io(api(SECRET).app),
      io(api(`other-${SECRET}`).app),
      io(api(SECRET).app, {
        fetch: async () => {
          throw new Error(`refused with ${SECRET}`);
        },
      }),
      io(api(SECRET).app, {
        openTargets: async () => {
          throw new Error(`boom ${SECRET}`);
        },
      }),
    ];
    for (const run of runs) await runSlackInteractionSign(ARGV, run.io);
    const signatures = runs.flatMap((run) =>
      run.sent.map(
        (sent) => new Headers(sent.init.headers).get("X-Slack-Signature") ?? "",
      ),
    );
    expect(signatures.filter((value) => value.startsWith("v0="))).toHaveLength(
      3,
    );
    const printed = runs.flatMap((run) => [...run.out, ...run.err]).join("\n");
    expect(printed.length).toBeGreaterThan(0);
    for (const secret of [SECRET, KEY_HEX, ...signatures]) {
      expect(printed.includes(secret)).toBe(false);
    }
    expect(printed).not.toContain("v0=");
  });

  test("an agent without a created app, or one installed in several teams, is exit 3", async () => {
    const app = api(SECRET).app;
    const none = io(app, { target: null });
    expect(await runSlackInteractionSign(ARGV, none.io)).toBe(
      SLACK_INTERACTION_SIGN_EXIT.not_found,
    );
    const several = io(app, {
      target: { appId: APP_ID, signingSecret: SECRET, teamIds: ["T1", "T2"] },
    });
    expect(await runSlackInteractionSign(ARGV, several.io)).toBe(
      SLACK_INTERACTION_SIGN_EXIT.not_found,
    );
    expect(several.err[0]).toContain("--team");
    expect([...none.sent, ...several.sent]).toEqual([]);
    const chosen = io(app, {
      target: { appId: APP_ID, signingSecret: SECRET, teamIds: ["T1", "T2"] },
    });
    expect(
      await runSlackInteractionSign([...ARGV, "--team", "T2"], chosen.io),
    ).toBe(SLACK_INTERACTION_SIGN_EXIT.ok);
  });

  test("--url replaces the address; the settings are required", async () => {
    const app = api(SECRET).app;
    const run = io(app);
    await runSlackInteractionSign(
      [
        ...ARGV,
        "--url",
        `http://api.internal:8080/v1/slack/interactions/${AGENT}`,
      ],
      run.io,
    );
    expect(run.sent[0]?.url).toBe(
      `http://api.internal:8080/v1/slack/interactions/${AGENT}`,
    );
    for (const env of [
      { PLATFORM_SECRET_KEY: KEY_HEX },
      { DATABASE_URL: "postgres://cli-test/db" },
      { DATABASE_URL: "postgres://cli-test/db", PLATFORM_SECRET_KEY: "short" },
    ]) {
      const missing = io(app, { env });
      expect(await runSlackInteractionSign(ARGV, missing.io)).toBe(
        SLACK_INTERACTION_SIGN_EXIT.usage,
      );
      expect(missing.sent).toEqual([]);
    }
  });
});

describe("parseSlackInteractionPress", () => {
  const refused = (argv: string[]) => {
    try {
      parseSlackInteractionPress(argv);
    } catch (error) {
      expect(error).toBeInstanceOf(SlackInteractionSignUsageError);
      return (error as Error).message.split("\n")[0];
    }
    throw new Error("parsed");
  };

  test("takes a press and lowercases the agent id", () => {
    expect(
      parseSlackInteractionPress(
        ARGV.map((arg) => (arg === AGENT ? AGENT.toUpperCase() : arg)),
      ),
    ).toEqual({
      agentId: AGENT,
      actionId: SLACK_INTERACTION_ACTIONS.permissionAllow,
      value: VALUE,
      channelId: "C0CHAN",
      messageTs: "1761300000.000100",
      userId: "U0PERSON",
    });
  });

  test("refuses what the receiver would refuse, before anything is read", () => {
    const without = (name: string) => {
      const at = ARGV.indexOf(name);
      return [...ARGV.slice(0, at), ...ARGV.slice(at + 2)];
    };
    const swap = (name: string, value: string) =>
      ARGV.map((arg, i) => (ARGV[i - 1] === name ? value : arg));
    expect(refused(without("--user"))).toBe("missing --user");
    expect(refused(swap("--agent", "agent-1"))).toBe("--agent must be a UUID");
    expect(refused(swap("--channel", "C0-CHAN"))).toBe(
      "not a Slack block_actions press: channel.id",
    );
    expect(refused(swap("--message-ts", "1761300000"))).toBe(
      "not a Slack block_actions press: message.ts",
    );
    expect(refused([...ARGV, "--url", "file:///etc/passwd"])).toBe(
      "--url must be an http or https URL",
    );
    expect(refused([...ARGV, "--verbose"])).toBe(
      "unknown option or argument, or an option without its value",
    );
    expect(refused([...ARGV, "extra"])).toBe(
      "unknown option or argument, or an option without its value",
    );
  });
});
