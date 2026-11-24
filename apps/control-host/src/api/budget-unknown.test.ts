import { describe, expect, test } from "bun:test";
import {
  BUDGET_UNKNOWN_EXIT,
  BudgetUnknownUsageError,
  parseBudgetUnknownCommand,
  runBudgetUnknown,
} from "./budget-unknown.ts";

const ACCOUNT = "6d1c0b0e-4f5a-4c55-9a40-1f2e3d4c5b6a";

describe("budget-unknown arguments", () => {
  test("list reads an account and a limit", () => {
    expect(parseBudgetUnknownCommand(["list"])).toEqual({
      command: "list",
      limit: 100,
    });
    expect(
      parseBudgetUnknownCommand([
        "list",
        "--account",
        ACCOUNT.toUpperCase(),
        "--limit",
        "5",
      ]),
    ).toEqual({ command: "list", accountId: ACCOUNT as never, limit: 5 });
  });

  test("resolve charges by default and refunds only with a reason", () => {
    expect(
      parseBudgetUnknownCommand([
        "resolve",
        "--call",
        "ex-1",
        "--call",
        "ex-2",
        "--by",
        "Admin@Example.com",
      ]),
    ).toEqual({
      command: "resolve",
      target: { kind: "calls", callIds: ["ex-1", "ex-2"] },
      by: "admin@example.com",
      refund: false,
      reason: null,
      dryRun: false,
    });
    expect(() =>
      parseBudgetUnknownCommand([
        "resolve",
        "--call",
        "ex-1",
        "--by",
        "a@example.com",
        "--refund",
      ]),
    ).toThrow("--refund needs --reason");
    expect(
      parseBudgetUnknownCommand([
        "resolve",
        "--account",
        ACCOUNT,
        "--by",
        "a@example.com",
        "--refund",
        "--reason",
        "  never billed ",
        "--dry-run",
      ]),
    ).toMatchObject({
      target: { kind: "account", accountId: ACCOUNT, limit: 100 },
      refund: true,
      reason: "never billed",
      dryRun: true,
    });
  });

  test.each([
    [["resolve", "--by", "a@example.com"]],
    [["resolve", "--account", ACCOUNT, "--call", "x", "--by", "a@example.com"]],
    [["resolve", "--call", "x"]],
    [["resolve", "--call", "x", "--by", "not-an-address"]],
    [["resolve", "--call", "x y", "--by", "a@example.com"]],
    [["resolve", "--call", "x", "--limit", "3", "--by", "a@example.com"]],
    [
      [
        "resolve",
        "--account",
        ACCOUNT,
        "--limit",
        "101",
        "--by",
        "a@example.com",
      ],
    ],
    [["resolve", "--account", "nope", "--by", "a@example.com"]],
    [["resolve", "--call", "x", "--by", "a@example.com", "--reason", " "]],
    [["list", "--by", "a@example.com"]],
    [["list", "--limit", "0"]],
    [["purge"]],
  ])("refuses %j", (argv) => {
    expect(() => parseBudgetUnknownCommand(argv)).toThrow(
      BudgetUnknownUsageError,
    );
  });

  test("more than a run's cap of --call is refused", () => {
    const calls = Array.from({ length: 101 }, (_, i) => ["--call", `c-${i}`]);
    expect(() =>
      parseBudgetUnknownCommand([
        "resolve",
        ...calls.flat(),
        "--by",
        "a@example.com",
      ]),
    ).toThrow("at most 100 --call a run");
  });

  test("a usage error exits 2 before opening the database", async () => {
    const err: string[] = [];
    let opened = false;
    const exit = await runBudgetUnknown(
      ["resolve", "--call", "x", "--by", "a@example.com", "--refund"],
      {
        env: { DATABASE_URL: "postgres://unused" },
        out: () => {},
        err: (line) => void err.push(line),
        openDatabase: async () => {
          opened = true;
          throw new Error("not reached");
        },
      },
    );
    expect(exit).toBe(BUDGET_UNKNOWN_EXIT.usage);
    expect(opened).toBe(false);
    expect(err.join("\n")).toContain("--refund needs --reason");
  });
});
