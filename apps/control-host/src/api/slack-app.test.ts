import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { SecretKey } from "@werft-ai/platform";
import {
  parseSlackAppCommand,
  runSlackApp,
  SLACK_APP_EXIT,
  type SlackAppIo,
  SlackAppUsageError,
} from "./slack-app.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";

function io(env: Record<string, string | undefined>) {
  const err: string[] = [];
  const opened: string[] = [];
  const value: SlackAppIo = {
    env,
    out: () => {},
    err: (line) => err.push(line),
    loadKey: async () =>
      SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY"),
    openDatabase: async (url) => {
      opened.push(url);
      throw new Error("not opened in this test");
    },
  };
  return { io: value, err, opened };
}

const ENV = {
  DATABASE_URL: "postgres://unused",
  CONSOLE_ORIGIN: "http://127.0.0.1:3000",
  MOCK_SLACK_API_URL: "http://127.0.0.1:9/api",
};
const ARGS = ["create", "--workspace", WORKSPACE, "--agent", AGENT];

describe("slack-app command line", () => {
  test("exit codes stay as documented", () => {
    expect(SLACK_APP_EXIT).toEqual({
      created: 0,
      unexpected: 1,
      usage: 2,
      config_token_invalid: 3,
      agent_not_found: 4,
      agent_not_active: 5,
      app_busy: 6,
      slack_error: 7,
      events_url_unset: 8,
    });
  });

  test("parses create with lowercased ids", () => {
    expect(
      parseSlackAppCommand([
        "create",
        "--workspace",
        WORKSPACE.toUpperCase(),
        "--agent",
        AGENT,
        "--replace-uncertain",
      ]),
    ).toEqual({
      command: "create",
      kind: "agent",
      workspaceId: WORKSPACE,
      agentId: AGENT,
      replaceUncertain: true,
    });
  });

  test("parses create --kind link with no agent", () => {
    expect(
      parseSlackAppCommand([
        "create",
        "--kind",
        "link",
        "--workspace",
        WORKSPACE.toUpperCase(),
      ]),
    ).toEqual({
      command: "create",
      kind: "link",
      workspaceId: WORKSPACE,
      replaceUncertain: false,
    });
  });

  test("parses finalize with a lowercased agent", () => {
    expect(
      parseSlackAppCommand(["finalize", "--agent", AGENT.toUpperCase()]),
    ).toEqual({ command: "finalize", agentId: AGENT });
  });

  test.each([
    [[]],
    [["finalize"]],
    [["finalize", "--agent", "nope"]],
    [["finalize", "--workspace", WORKSPACE, "--agent", AGENT]],
    [["finalize", "--agent", AGENT, "--kind", "agent"]],
    [["finalize", "--agent", AGENT, "--replace-uncertain"]],
    [["create", "--workspace", WORKSPACE]],
    [["create", "--kind", "link", "--workspace", WORKSPACE, "--agent", AGENT]],
    [["create", "--kind", "manual", "--workspace", WORKSPACE]],
    [["create", "--kind", "link"]],
    [["delete", "--workspace", WORKSPACE, "--agent", AGENT]],
    [["create", "--workspace", "nope", "--agent", AGENT]],
    [["create", "--workspace", WORKSPACE, "--agent"]],
    [[...ARGS, "--token", "x"]],
  ])("refuses %j as usage", (argv) => {
    expect(() => parseSlackAppCommand(argv)).toThrow(SlackAppUsageError);
  });

  test.each([
    ["DATABASE_URL", { ...ENV, DATABASE_URL: undefined }],
    ["CONSOLE_ORIGIN", { ...ENV, CONSOLE_ORIGIN: undefined }],
    [
      "MOCK_SLACK_API_URL",
      { ...ENV, MOCK_SLACK_API_URL: "http://slack.example/api" },
    ],
  ])("a missing or unsafe %s is usage, before the database", async (_, env) => {
    const run = io(env);
    expect(await runSlackApp(ARGS, run.io)).toBe(SLACK_APP_EXIT.usage);
    expect(run.opened).toEqual([]);
    expect(run.err.join("\n")).toContain("slack-app:");
  });

  test("without a master key it stops before the database", async () => {
    const run = io(ENV);
    run.io.loadKey = async () => null;
    expect(await runSlackApp(ARGS, run.io)).toBe(SLACK_APP_EXIT.usage);
    expect(run.err.join("\n")).toContain("PLATFORM_SECRET_KEY");
    expect(run.opened).toEqual([]);
  });

  test("an unexpected failure is exit 1 and prints only the error's name", async () => {
    const run = io(ENV);
    expect(await runSlackApp(ARGS, run.io)).toBe(SLACK_APP_EXIT.unexpected);
    expect(run.err.join("\n")).toContain("unexpected error: Error");
    expect(run.err.join("\n")).not.toContain("not opened in this test");
  });
});
