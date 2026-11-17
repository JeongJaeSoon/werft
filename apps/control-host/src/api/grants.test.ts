import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeGrantsResult, parseGrantsCommand } from "./grants.ts";

const SESSION = "0B9F1C2E-6A4D-4E8B-9C3F-1D2E3F4A5B6C";

describe("grants CLI arguments", () => {
  test("revoke and restore take one session UUID and a reason", () => {
    expect(
      parseGrantsCommand(["revoke", SESSION, "--reason", " leaked token "]),
    ).toEqual({
      command: "revoke",
      sessionId: SESSION.toLowerCase(),
      reason: "leaked token",
    });
    expect(
      parseGrantsCommand(["restore", SESSION, "--reason=reissued"]),
    ).toEqual({
      command: "restore",
      sessionId: SESSION.toLowerCase(),
      reason: "reissued",
    });
  });

  test("a missing or blank reason is refused: the audit record needs one", () => {
    expect(() => parseGrantsCommand(["revoke", SESSION])).toThrow(
      "--reason is required",
    );
    expect(() =>
      parseGrantsCommand(["revoke", SESSION, "--reason", "  "]),
    ).toThrow("--reason is required");
  });

  test("an unknown command, a non-UUID, an extra argument or flag is refused", () => {
    for (const argv of [
      ["delete", SESSION, "--reason", "x"],
      ["revoke", "--reason", "x"],
      ["revoke", SESSION, "extra", "--reason", "x"],
      ["revoke", SESSION, "--reason", "x", "--owner", "o"],
    ]) {
      expect(() => parseGrantsCommand(argv)).toThrow("Usage");
    }
    expect(() =>
      parseGrantsCommand(["revoke", "not-a-uuid", "--reason", "x"]),
    ).toThrow("session_id must be a UUID");
  });

  test("the CLI prints a refusal as a message and exits 1, without a stack trace", async () => {
    // Unreachable: a refusal that still connected would hang until the kill.
    const unreachable = "postgresql://postgres:dev@203.0.113.1:5432/sessions";
    // An empty working directory has no env file Bun could auto-load into the
    // case that leaves DATABASE_URL out.
    const cwd = await mkdtemp(join(tmpdir(), "grants-cli-"));
    try {
      expect(await readdir(cwd)).toHaveLength(0);
      for (const [args, databaseUrl, message] of [
        [["revoke", SESSION], unreachable, "--reason is required"],
        [["revoke", "not-a-uuid", "--reason", "x"], unreachable, "session_id"],
        [["delete", SESSION, "--reason", "x"], unreachable, "Usage"],
        [["revoke", SESSION, "--reason", "x"], undefined, "DATABASE_URL"],
      ] as const) {
        const result = Bun.spawnSync(
          [
            "bun",
            "--no-env-file",
            "run",
            join(import.meta.dir, "grants.ts"),
            ...args,
          ],
          {
            cwd,
            env: {
              PATH: process.env.PATH ?? "",
              ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
            },
            stderr: "pipe",
            stdout: "pipe",
            timeout: 10_000,
          },
        );
        const stderr = result.stderr.toString();
        expect(result.exitCode, args.join(" ")).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(stderr.startsWith(message), stderr).toBe(true);
        expect(stderr).not.toContain("throw new Error");
        expect(stderr).not.toMatch(/^\s+at /m);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
    // Four cold spawns, each killed at 10 s: above that sum, not the 5 s default.
  }, 45_000);
});

describe("grants CLI output", () => {
  test("only a command that did what it asked exits zero", () => {
    const id = SESSION.toLowerCase();
    expect(
      describeGrantsResult(id, {
        outcome: "revoked",
        ownerId: "owner-a",
        receiptId: "r1",
        receiptStatus: "accepted",
        authRevision: 3,
        executionId: "exec-1",
        revokedCredentials: 1,
      }),
    ).toEqual({
      ok: true,
      line: `revoked ${id} owner=owner-a auth_revision=3 execution=exec-1 credentials_revoked=1 receipt=r1 receipt_status=accepted`,
    });
    expect(
      describeGrantsResult(id, {
        outcome: "already_revoked",
        revokedAt: new Date("2026-09-24T00:00:00.000Z"),
        reason: "leaked",
      }).ok,
    ).toBe(true);
    for (const result of [
      { outcome: "not_found" as const },
      { outcome: "closed" as const },
      { outcome: "unsupported" as const },
      { outcome: "execution_unconfirmed" as const, executionId: "exec-1" },
    ]) {
      expect(describeGrantsResult(id, result).ok).toBe(false);
    }
  });
});
