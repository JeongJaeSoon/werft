import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type MockSlackOidc,
  startMockSlackOidc,
} from "@werft-ai/testkit/mock-slack-oidc";
import {
  parseSlackInstallCommand,
  runSlackInstall,
  SLACK_INSTALL_EXIT,
  SlackAuthTestError,
  type SlackInstallIo,
  SlackInstallUsageError,
  slackBotIdentity,
} from "./slack-install.ts";

const WORKSPACE = "0b6f1d2e-6a3c-4f0e-9a51-2d7c8e9f0a1b";
// Shaped like a real bot token so a leak would match what scanners look
// for; assembled at runtime so the source holds no such literal.
const TOKEN = [
  "xoxb",
  "1234567890",
  "1234567890123",
  "notarealtoken0000aaaa",
].join("-");

describe("slack-install arguments", () => {
  test("register takes a workspace UUID and a Slack app id", () => {
    expect(
      parseSlackInstallCommand([
        "register",
        "--workspace",
        WORKSPACE.toUpperCase(),
        "--app-id",
        "A0123ABC",
      ]),
    ).toEqual({
      command: "register",
      workspaceId: WORKSPACE,
      appId: "A0123ABC",
    });
  });

  test.each([
    [[]],
    [["register", "--workspace", WORKSPACE]],
    [["register", "--app-id", "A0123ABC"]],
    [["revoke", "--workspace", WORKSPACE, "--app-id", "A0123ABC"]],
    [["register", "--workspace", "ws", "--app-id", "A0123ABC"]],
    [["register", "--workspace", WORKSPACE, "--app-id", "a0123abc"]],
    [["register", "extra", "--workspace", WORKSPACE, "--app-id", "A0123ABC"]],
  ])("refuses %j", (argv) => {
    expect(() => parseSlackInstallCommand(argv)).toThrow(
      SlackInstallUsageError,
    );
  });

  test("a missing option value is named without echoing the argv", () => {
    expect(() =>
      parseSlackInstallCommand([
        "register",
        "--app-id",
        "A0123ABC",
        "--workspace",
      ]),
    ).toThrow("an option is missing its value");
  });

  test("a token passed as an argument is refused without being echoed", async () => {
    for (const argv of [
      [
        "register",
        "--workspace",
        WORKSPACE,
        "--app-id",
        "A0MOCK",
        "--token",
        TOKEN,
      ],
      [
        "register",
        "--workspace",
        WORKSPACE,
        "--app-id",
        "A0MOCK",
        `--token=${TOKEN}`,
      ],
      [
        "register",
        "--workspace",
        WORKSPACE,
        "--app-id",
        "A0MOCK",
        `--${TOKEN}`,
      ],
      ["register", "--workspace", WORKSPACE, "--app-id", "A0MOCK", TOKEN],
    ]) {
      const run = capture({
        SLACK_BOT_TOKEN: "",
        DATABASE_URL: "postgres://x",
      });
      expect(await runSlackInstall(argv, run.io)).toBe(
        SLACK_INSTALL_EXIT.usage,
      );
      expect(run.text()).not.toContain(TOKEN);
      expect(run.text()).not.toContain("notarealtoken");
    }
  });
});

function capture(env: Record<string, string | undefined>) {
  const lines: string[] = [];
  let opened = 0;
  const io: SlackInstallIo = {
    env,
    out: (line) => lines.push(`out ${line}`),
    err: (line) => lines.push(`err ${line}`),
    async openDatabase() {
      opened += 1;
      throw new Error("no database in unit tests");
    },
  };
  return {
    io,
    lines,
    opened: () => opened,
    text: () => lines.join("\n"),
  };
}

describe("slack-install against a mock Slack", () => {
  let slack: MockSlackOidc;
  let apiUrl: string;

  beforeAll(async () => {
    slack = await startMockSlackOidc({
      account: { teamId: "T0TEAM", userId: "U0PERSON" },
      bot: { token: TOKEN, appId: "A0MOCK", botUserId: "U0BOT" },
    });
    apiUrl = `${slack.listenUrl}/api`;
  });

  afterAll(async () => {
    await slack.stop();
  });

  test("auth.test and bots.info name the team, bot user and app", async () => {
    expect(await slackBotIdentity(apiUrl, TOKEN)).toEqual({
      teamId: "T0TEAM",
      botUserId: "U0BOT",
      appId: "A0MOCK",
    });
  });

  test("a refused token is an auth failure carrying Slack's error code", async () => {
    await expect(slackBotIdentity(apiUrl, `${TOKEN}x`)).rejects.toThrow(
      new SlackAuthTestError("auth.test: invalid_auth"),
    );
  });

  test("ids that do not look like Slack's are refused before they are stored or printed", async () => {
    const odd: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) =>
        String(input).endsWith("/auth.test")
          ? Response.json({
              ok: true,
              team_id: "T0TEAM\u001b[2J",
              user_id: "U0BOT",
              bot_id: "B0BOT",
            })
          : Response.json({ ok: true, bot: { app_id: "A0MOCK" } }),
      { preconnect: fetch.preconnect },
    );
    await expect(slackBotIdentity(apiUrl, TOKEN, odd)).rejects.toThrow(
      "unexpected shape",
    );
  });

  test("a user token (no bot_id) is refused", async () => {
    const userToken: typeof fetch = Object.assign(
      async () =>
        Response.json({ ok: true, team_id: "T0TEAM", user_id: "U0PERSON" }),
      { preconnect: fetch.preconnect },
    );
    await expect(slackBotIdentity(apiUrl, TOKEN, userToken)).rejects.toThrow(
      "not a bot token",
    );
  });

  test("exit codes for a missing token, a refused token, another app and an unreachable Slack", async () => {
    const env = {
      MOCK_SLACK_API_URL: apiUrl,
      DATABASE_URL: "postgres://unused",
    };
    const argv = (appId: string) => [
      "register",
      "--workspace",
      WORKSPACE,
      "--app-id",
      appId,
    ];
    const cases: [Record<string, string>, string, number, string][] = [
      [{}, "A0MOCK", SLACK_INSTALL_EXIT.usage, "SLACK_BOT_TOKEN is required"],
      [
        { SLACK_BOT_TOKEN: `${TOKEN}x` },
        "A0MOCK",
        SLACK_INSTALL_EXIT.slack_auth_failed,
        "slack_auth_failed: auth.test: invalid_auth",
      ],
      [
        { SLACK_BOT_TOKEN: TOKEN },
        "A0OTHER",
        SLACK_INSTALL_EXIT.app_mismatch,
        "app_mismatch: the token belongs to app A0MOCK, not A0OTHER",
      ],
      [
        {
          SLACK_BOT_TOKEN: TOKEN,
          MOCK_SLACK_API_URL: "http://127.0.0.1:9/api",
        },
        "A0MOCK",
        SLACK_INSTALL_EXIT.slack_auth_failed,
        "Slack could not be reached",
      ],
      [
        { SLACK_BOT_TOKEN: TOKEN, MOCK_SLACK_API_URL: "file:///etc" },
        "A0MOCK",
        SLACK_INSTALL_EXIT.usage,
        "MOCK_SLACK_API_URL must be https",
      ],
      [
        // The token would cross the network in clear text.
        {
          SLACK_BOT_TOKEN: TOKEN,
          MOCK_SLACK_API_URL: "http://slack.example.com/api",
        },
        "A0MOCK",
        SLACK_INSTALL_EXIT.usage,
        "MOCK_SLACK_API_URL must be https (http only for a local mock)",
      ],
      ...["http://[2001:db8::1]/api", "http://intranet/api"].map(
        (url): [Record<string, string>, string, number, string] => [
          { SLACK_BOT_TOKEN: TOKEN, MOCK_SLACK_API_URL: url },
          "A0MOCK",
          SLACK_INSTALL_EXIT.usage,
          "MOCK_SLACK_API_URL must be https (http only for a local mock)",
        ],
      ),
    ];
    for (const [extra, appId, code, message] of cases) {
      const run = capture({ ...env, ...extra });
      expect(await runSlackInstall(argv(appId), run.io)).toBe(code);
      expect(run.text()).toContain(message);
      expect(run.text()).not.toContain(TOKEN);
      expect(run.opened()).toBe(0);
    }
  });

  test("an unexpected error is exit 1 and is scrubbed of the token", async () => {
    const run = capture({
      SLACK_BOT_TOKEN: TOKEN,
      MOCK_SLACK_API_URL: apiUrl,
      DATABASE_URL: "postgres://unused",
    });
    run.io.openDatabase = async () => {
      throw new Error(`connect failed for ${TOKEN}`);
    };
    expect(
      await runSlackInstall(
        ["register", "--workspace", WORKSPACE, "--app-id", "A0MOCK"],
        run.io,
      ),
    ).toBe(SLACK_INSTALL_EXIT.unexpected);
    expect(run.text()).toContain("connect failed for [redacted]");
    expect(run.text()).not.toContain(TOKEN);
  });
});
