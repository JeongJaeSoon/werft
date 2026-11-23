import { describe, expect, test } from "bun:test";
import {
  PRIVATE_CHANNEL_SESSIONS_EXIT,
  PrivateChannelSessionsUsageError,
  parsePrivateChannelSessionsCommand,
  runPrivateChannelSessions,
} from "./private-channel-sessions.ts";

const WORKSPACE = "019A0000-0000-7000-8000-0000000000F1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";

describe("parsePrivateChannelSessionsCommand", () => {
  test("plan and apply, for everything, a workspace or an agent", () => {
    expect(parsePrivateChannelSessionsCommand(["plan"])).toEqual({
      command: "plan",
      filter: {},
    });
    expect(
      parsePrivateChannelSessionsCommand(["apply", "--workspace", WORKSPACE]),
    ).toEqual({
      command: "apply",
      filter: { workspaceId: WORKSPACE.toLowerCase() },
    });
    expect(
      parsePrivateChannelSessionsCommand(["plan", "--agent", AGENT]),
    ).toEqual({ command: "plan", filter: { agentId: AGENT } });
  });

  test.each([
    [[]],
    [["move"]],
    [["plan", "extra"]],
    [["plan", "--workspace", WORKSPACE, "--agent", AGENT]],
    [["plan", "--agent", "not-a-uuid"]],
    [["plan", "--agent"]],
    [["plan", "--dry-run"]],
  ])("%j is a usage error", (argv) => {
    expect(() => parsePrivateChannelSessionsCommand(argv)).toThrow(
      PrivateChannelSessionsUsageError,
    );
  });
});

describe("runPrivateChannelSessions", () => {
  const io = (env: Record<string, string | undefined>) => {
    const err: string[] = [];
    let opened = 0;
    return {
      err,
      opened: () => opened,
      io: {
        env,
        out: () => {},
        err: (line: string) => err.push(line),
        loadKey: async () => null,
        openDatabase: async () => {
          opened += 1;
          throw new Error("not reached");
        },
      },
    };
  };

  test("without DATABASE_URL or the master key it stops before the database", async () => {
    const none = io({});
    expect(await runPrivateChannelSessions(["plan"], none.io)).toBe(
      PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
    );
    expect(none.err[0]).toContain("DATABASE_URL is required");
    const keyless = io({ DATABASE_URL: "postgres://db.invalid/werft" });
    expect(await runPrivateChannelSessions(["apply"], keyless.io)).toBe(
      PRIVATE_CHANNEL_SESSIONS_EXIT.usage,
    );
    expect(keyless.err[0]).toContain("master_key_missing");
    expect(keyless.opened()).toBe(0);
  });
});
