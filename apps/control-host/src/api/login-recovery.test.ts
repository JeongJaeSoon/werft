import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  LOGIN_RECOVERY_EXIT,
  LoginRecoveryUsageError,
  parseLoginRecoveryCommand,
  runLoginRecovery,
} from "./login-recovery.ts";

describe("login-recovery arguments", () => {
  test("each command is read with the one option it takes", () => {
    const id = randomUUID();
    expect(parseLoginRecoveryCommand(["status"])).toEqual({
      command: "status",
    });
    expect(parseLoginRecoveryCommand(["enable-password"])).toEqual({
      command: "enable-password",
    });
    expect(
      parseLoginRecoveryCommand(["disable-provider", "--id", id.toUpperCase()]),
    ).toEqual({ command: "disable-provider", target: { id } });
    expect(parseLoginRecoveryCommand(["disable-provider", "--all"])).toEqual({
      command: "disable-provider",
      target: "all",
    });
    expect(
      parseLoginRecoveryCommand([
        "reset-password",
        "--email",
        "Owner@Example.com",
      ]),
    ).toEqual({ command: "reset-password", email: "owner@example.com" });
  });

  test("anything else is a usage error", () => {
    const id = randomUUID();
    for (const argv of [
      [],
      ["unlock"],
      ["status", "extra"],
      ["status", "--all"],
      ["enable-password", "--email", "owner@example.com"],
      ["disable-provider"],
      ["disable-provider", "--id", id, "--all"],
      ["disable-provider", "--id", "not-a-uuid"],
      ["disable-provider", "--email", "owner@example.com"],
      ["reset-password"],
      ["reset-password", "--email", "not an address"],
      ["reset-password", "--id", id],
      ["status", "--force"],
      ["disable-provider", "--id"],
    ]) {
      expect(() => parseLoginRecoveryCommand(argv)).toThrow(
        LoginRecoveryUsageError,
      );
    }
  });

  test("a usage error, and a missing DATABASE_URL, exit 2 with nothing on stdout and no database opened", async () => {
    for (const [argv, said] of [
      [["unlock"], "Usage:"],
      [["status"], "DATABASE_URL is required"],
    ] as const) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runLoginRecovery([...argv], {
        env: {},
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        openDatabase: () => {
          throw new Error("opened");
        },
      });
      expect(code).toBe(LOGIN_RECOVERY_EXIT.usage);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain(said);
    }
  });

  test("an unexpected error exits 1 and says only its name", async () => {
    const err: string[] = [];
    const code = await runLoginRecovery(["status"], {
      env: { DATABASE_URL: "postgresql://db.example.invalid/werft" },
      out: () => {},
      err: (line) => err.push(line),
      openDatabase: () =>
        Promise.reject(new Error("connect to db.example.invalid refused")),
    });
    expect(code).toBe(LOGIN_RECOVERY_EXIT.unexpected);
    expect(err).toEqual(["login-recovery: unexpected error: Error"]);
  });
});
