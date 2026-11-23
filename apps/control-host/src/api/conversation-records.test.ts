import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { conversationIdSchema } from "@werft-ai/contracts";
import {
  CONVERSATION_RECORDS_EXIT,
  ConversationRecordsUsageError,
  parseConversationRecordsCommand,
  runConversationRecords,
} from "./conversation-records.ts";

describe("conversation-records arguments", () => {
  test("delete is read with its conversation, its admin and an optional dry run", () => {
    const id = randomUUID();
    expect(
      parseConversationRecordsCommand([
        "delete",
        "--conversation",
        id.toUpperCase(),
        "--by",
        "Admin@Example.com",
      ]),
    ).toEqual({
      command: "delete",
      conversationId: conversationIdSchema.parse(id),
      by: "admin@example.com",
      dryRun: false,
    });
    expect(
      parseConversationRecordsCommand([
        "delete",
        "--conversation",
        id,
        "--by",
        "admin@example.com",
        "--dry-run",
      ]),
    ).toMatchObject({ dryRun: true });
  });

  test("anything else is a usage error", () => {
    const id = randomUUID();
    for (const argv of [
      [],
      ["purge", "--conversation", id, "--by", "admin@example.com"],
      ["delete"],
      ["delete", "--conversation", id],
      ["delete", "--by", "admin@example.com"],
      ["delete", "--conversation", "not-a-uuid", "--by", "admin@example.com"],
      ["delete", "--conversation", id, "--by", "not an address"],
      ["delete", "--conversation", id, "--by", "admin@example.com", "extra"],
      ["delete", "--conversation", id, "--by", "admin@example.com", "--all"],
      ["delete", "--conversation"],
    ]) {
      expect(() => parseConversationRecordsCommand(argv)).toThrow(
        ConversationRecordsUsageError,
      );
    }
  });

  test("a usage error, and a missing DATABASE_URL, exit 2 with nothing on stdout and no database opened", async () => {
    const valid = [
      "delete",
      "--conversation",
      randomUUID(),
      "--by",
      "admin@example.com",
    ];
    for (const [argv, said] of [
      [["delete"], "Usage:"],
      [valid, "DATABASE_URL is required"],
    ] as const) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runConversationRecords([...argv], {
        env: {},
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        openDatabase: () => {
          throw new Error("opened");
        },
      });
      expect(code).toBe(CONVERSATION_RECORDS_EXIT.usage);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain(said);
    }
  });

  test("an unexpected error exits 1 and says only its name", async () => {
    const err: string[] = [];
    const code = await runConversationRecords(
      ["delete", "--conversation", randomUUID(), "--by", "admin@example.com"],
      {
        env: { DATABASE_URL: "postgresql://db.example.invalid/werft" },
        out: () => {},
        err: (line) => err.push(line),
        openDatabase: () =>
          Promise.reject(new Error("connect to db.example.invalid refused")),
      },
    );
    expect(code).toBe(CONVERSATION_RECORDS_EXIT.unexpected);
    expect(err).toEqual(["conversation-records: unexpected error: Error"]);
  });
});
