import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  parseSlackNoticeCommand,
  runSlackNotice,
  SLACK_NOTICE_EXIT,
  SlackNoticeUsageError,
} from "./slack-notice.ts";

describe("slack-notice arguments", () => {
  test("show takes an agent and list a workspace", () => {
    const id = randomUUID();
    expect(
      parseSlackNoticeCommand(["show", "--agent", id.toUpperCase()]),
    ).toEqual({ command: "show", agentId: id });
    expect(parseSlackNoticeCommand(["list", "--workspace", id])).toEqual({
      command: "list",
      workspaceId: id,
    });
  });

  test("anything else is a usage error", () => {
    const id = randomUUID();
    for (const argv of [
      [],
      ["show"],
      ["list"],
      ["show", "--workspace", id],
      ["list", "--agent", id],
      ["show", "--agent", id, "--workspace", id],
      ["show", "--agent", "not-a-uuid"],
      ["list", "--workspace", "not-a-uuid"],
      ["show", "--agent", id, "extra"],
      ["approve", "--agent", id],
      ["revoke", "--agent", id],
      ["show", "--agent"],
      ["show", "--agent", id, "--all"],
    ]) {
      expect(() => parseSlackNoticeCommand(argv)).toThrow(
        SlackNoticeUsageError,
      );
    }
  });

  test("a usage error, and a missing DATABASE_URL, exit 2 with nothing on stdout and no database opened", async () => {
    for (const [argv, env] of [
      [["show"], { DATABASE_URL: "postgres://db" }],
      [["show", "--agent", randomUUID()], {}],
    ] as const) {
      const out: string[] = [];
      const err: string[] = [];
      let opened = false;
      const code = await runSlackNotice([...argv], {
        env,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        openDatabase: async () => {
          opened = true;
          throw new Error("not opened");
        },
      });
      expect(code).toBe(SLACK_NOTICE_EXIT.usage);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("slack-notice:");
      expect(opened).toBe(false);
    }
  });
});
