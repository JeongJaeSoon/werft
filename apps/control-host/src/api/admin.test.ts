import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorCloseResult } from "@werft-ai/db";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import type { IdentityStore, IssueSetupLinkInput } from "@werft-ai/platform";
import {
  ADMIN_USAGE,
  auditLogger,
  auditSetupLinkIssued,
  bootstrapOwner,
  closeSession,
  containerLogSink,
  describeCloseSessionResult,
  parseBootstrapOwnerArgs,
  parseCloseSessionArgs,
  setupLinkFile,
} from "./admin.ts";

const EXPIRES = new Date("2026-11-25T10:00:00.000Z");

function fakeStore(outcome: "issued" | "owner_exists" = "issued") {
  const calls: IssueSetupLinkInput[] = [];
  const store: Pick<IdentityStore, "issueSetupLink"> = {
    async issueSetupLink(input) {
      calls.push(input);
      return outcome === "issued"
        ? { outcome, expiresAt: EXPIRES }
        : { outcome };
    },
  };
  return { store, calls };
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "bootstrap-owner-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("parseBootstrapOwnerArgs", () => {
  test("takes the address normalized and the file", () => {
    expect(
      parseBootstrapOwnerArgs([
        "bootstrap-owner",
        "--email",
        " Owner@Example.COM ",
        "--out",
        "/tmp/link.json",
      ]),
    ).toEqual({ email: "owner@example.com", out: "/tmp/link.json" });
  });

  test.each([
    [[]],
    [["setup-link", "--email", "a@example.com", "--out", "f"]],
    [["bootstrap-owner", "--out", "f"]],
    [["bootstrap-owner", "--email", "not-an-address", "--out", "f"]],
    [["bootstrap-owner", "--email", "a@example.com"]],
    [["bootstrap-owner", "--email", "a@example.com", "--out", "f", "x"]],
    // No way to hand the command a password.
    [
      [
        "bootstrap-owner",
        "--email",
        "a@example.com",
        "--out",
        "f",
        "--password",
        "p",
      ],
    ],
  ])("refuses %j with the usage", (argv) => {
    expect(() => parseBootstrapOwnerArgs(argv)).toThrow(/usage: /);
  });
});

describe("setupLinkFile", () => {
  test("names the link as POST /v1/invites does, on CONSOLE_ORIGIN", () => {
    expect(
      JSON.parse(setupLinkFile("tok", EXPIRES, "https://console.example.com")),
    ).toEqual({
      accept_path: "/bootstrap#setup=tok",
      accept_url: "https://console.example.com/bootstrap#setup=tok",
      expires_at: "2026-11-25T10:00:00.000Z",
    });
  });

  test("accept_url is null without CONSOLE_ORIGIN", () => {
    expect(JSON.parse(setupLinkFile("tok", EXPIRES, null)).accept_url).toBe(
      null,
    );
  });
});

describe("bootstrapOwner", () => {
  test("writes the link to a new 0600 file and audits it without the token", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const { store, calls } = fakeStore();
      const sink = new MemoryLogSink();
      const out = join(dir, "owner-link.json");
      const result = await bootstrapOwner(
        { email: "owner@example.com", out },
        {
          store,
          consoleOrigin: "https://console.example.com",
          audit: createLogger({ sinks: [sink] }),
        },
      );
      expect(result).toEqual({
        outcome: "issued",
        path: out,
        expiresAt: EXPIRES,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.email).toBe("owner@example.com");
      expect(calls[0]?.ttlMs).toBe(24 * 60 * 60 * 1000);
      expect((await stat(out)).mode & 0o777).toBe(0o600);
      const written = JSON.parse(await readFile(out, "utf8"));
      const token = String(written.accept_path).split("#setup=")[1] ?? "";
      expect(token.length).toBeGreaterThanOrEqual(43);

      expect(sink.records).toHaveLength(1);
      const line = JSON.stringify(sink.records[0]);
      expect(sink.records[0]).toMatchObject({
        event: "setup_link_issued",
        fields: {
          setup_link_id: calls[0]?.id,
          email: "owner@example.com",
          expires_at: "2026-11-25T10:00:00.000Z",
        },
      });
      expect(line).not.toContain(token);
      expect(line).not.toContain("#setup=");
      expect(line).not.toContain("/bootstrap");
    } finally {
      await cleanup();
    }
  });

  test("never overwrites an existing file and issues nothing then", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const out = join(dir, "taken.json");
      await writeFile(out, "keep");
      const { store, calls } = fakeStore();
      await expect(
        bootstrapOwner(
          { email: "owner@example.com", out },
          { store, consoleOrigin: null, audit: createLogger({ sinks: [] }) },
        ),
      ).rejects.toThrow(/must not exist yet/);
      expect(calls).toHaveLength(0);
      expect(await readFile(out, "utf8")).toBe("keep");
    } finally {
      await cleanup();
    }
  });

  test("removes the file and audits nothing when an owner exists", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const out = join(dir, "owner-link.json");
      const sink = new MemoryLogSink();
      const result = await bootstrapOwner(
        { email: "owner@example.com", out },
        {
          store: fakeStore("owner_exists").store,
          consoleOrigin: null,
          audit: createLogger({ sinks: [sink] }),
        },
      );
      expect(result).toEqual({ outcome: "owner_exists" });
      await expect(stat(out)).rejects.toThrow();
      expect(sink.records).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test("audits a link it issued even when the file cannot be written", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const out = join(dir, "owner-link.json");
      const sink = new MemoryLogSink();
      const { store, calls } = fakeStore();
      // Not a URL: making the file's accept_url throws after the issue.
      await expect(
        bootstrapOwner(
          { email: "owner@example.com", out },
          {
            store,
            consoleOrigin: "not an origin",
            audit: createLogger({ sinks: [sink] }),
          },
        ),
      ).rejects.toThrow();
      expect(calls).toHaveLength(1);
      await expect(stat(out)).rejects.toThrow();
      expect(sink.records).toHaveLength(1);
      expect(sink.records[0]?.event).toBe("setup_link_issued");
    } finally {
      await cleanup();
    }
  });
});

describe("containerLogSink", () => {
  test("the audit logger writes even when LOG_LEVEL is error", async () => {
    const { dir, cleanup } = await scratch();
    const before = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "error";
    try {
      const path = join(dir, "pid1-stdout");
      auditSetupLinkIssued(auditLogger(path), {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@example.com",
        expiresAt: EXPIRES,
      });
      expect(await readFile(path, "utf8")).toContain(
        '"event":"setup_link_issued"',
      );
    } finally {
      if (before === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = before;
      await cleanup();
    }
  });

  test("appends the audit line to the container log", async () => {
    const { dir, cleanup } = await scratch();
    try {
      const path = join(dir, "pid1-stdout");
      const logger = createLogger({ sinks: [containerLogSink(path)] });
      auditSetupLinkIssued(logger, {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@example.com",
        expiresAt: EXPIRES,
      });
      const [line, rest] = (await readFile(path, "utf8")).split("\n");
      expect(rest).toBe("");
      expect(JSON.parse(line ?? "")).toMatchObject({
        event: "setup_link_issued",
      });
    } finally {
      await cleanup();
    }
  });

  test("falls back to stderr, saying so on the same line", () => {
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createLogger({
        sinks: [containerLogSink("/nonexistent-dir/pid1-stdout")],
      });
      auditSetupLinkIssued(logger, {
        id: "00000000-0000-4000-8000-000000000001",
        email: "owner@example.com",
        expiresAt: EXPIRES,
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(stderr.mock.calls[0]?.[0]));
      expect(line).toMatchObject({
        event: "setup_link_issued",
        audit_sink: "stderr",
      });
      expect(line.audit_sink_error).toContain("/nonexistent-dir/pid1-stdout");
    } finally {
      stderr.mockRestore();
    }
  });
});

const SESSION = "0b6f3c1e-8d2a-4e5f-9a7b-1c2d3e4f5a6b";

describe("parseCloseSessionArgs", () => {
  test("takes the session id lowercased and the reason trimmed", () => {
    expect(
      parseCloseSessionArgs([
        "close-session",
        SESSION.toUpperCase(),
        "--reason",
        "  idle worker holds the node ",
      ]),
    ).toEqual({ sessionId: SESSION, reason: "idle worker holds the node" });
  });

  test.each([
    [["close-session"]],
    [["close-session", "not-a-uuid", "--reason", "r"]],
    [["close-session", SESSION]],
    [["close-session", SESSION, "--reason", "   "]],
    [["close-session", SESSION, "--reason", "r", "extra"]],
    [["close-session", SESSION, "--reason", "r", "--force"]],
  ])("refuses %j with the usage", (argv) => {
    expect(() => parseCloseSessionArgs(argv)).toThrow(ADMIN_USAGE);
  });
});

describe("describeCloseSessionResult", () => {
  const cases: [OperatorCloseResult, boolean, string][] = [
    [
      {
        outcome: "accepted",
        ownerId: "ws-1",
        receiptId: "r-1",
        receiptStatus: "accepted",
        admissionState: "closing",
      },
      true,
      `closing ${SESSION} owner=ws-1 receipt=r-1 receipt_status=accepted`,
    ],
    [
      {
        outcome: "accepted",
        ownerId: "ws-1",
        receiptId: "r-2",
        receiptStatus: "succeeded",
        admissionState: "closed",
      },
      true,
      `closed ${SESSION} owner=ws-1 receipt=r-2 receipt_status=succeeded`,
    ],
    [{ outcome: "already_closed" }, true, `already_closed ${SESSION}`],
    [
      { outcome: "closing", receiptId: null },
      true,
      `closing ${SESSION} receipt=none`,
    ],
    [{ outcome: "not_found" }, false, `session ${SESSION} not found`],
  ];
  test.each(cases)("%j", (result, ok, line) => {
    expect(describeCloseSessionResult(SESSION, result)).toEqual({ ok, line });
  });

  test.each([
    [{ outcome: "recovery_required" }, "recovery close"],
    [{ outcome: "checkpoint_unavailable" }, "grants.ts revoke"],
    [{ outcome: "unsupported" }, "legacy pod binding"],
    [{ outcome: "rejected", admissionState: "terminating" }, "is terminating"],
  ] as [OperatorCloseResult, string][])(
    "%j is a refusal that says what to do",
    (result, says) => {
      const described = describeCloseSessionResult(SESSION, result);
      expect(described.ok).toBe(false);
      expect(described.line).toContain(says);
    },
  );
});

describe("closeSession", () => {
  const AT = new Date("2026-11-25T03:00:00.000Z");

  test("audits an accepted close with who and when", async () => {
    const sink = new MemoryLogSink();
    const inputs: unknown[] = [];
    const result = await closeSession(
      { sessionId: SESSION, reason: "idle worker" },
      {
        close: async (input) => {
          inputs.push(input);
          return {
            outcome: "accepted",
            ownerId: "ws-1",
            receiptId: "r-1",
            receiptStatus: "accepted",
            admissionState: "closing",
          };
        },
        audit: createLogger({ sinks: [sink] }),
        now: () => AT,
      },
    );
    expect(result.outcome).toBe("accepted");
    expect(inputs).toEqual([
      { sessionId: SESSION, reason: "idle worker", now: AT },
    ]);
    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      event: "session_close_requested",
      fields: {
        by: "operator_cli",
        session_id: SESSION,
        owner_id: "ws-1",
        receipt_id: "r-1",
        admission_state: "closing",
        reason: "idle worker",
        requested_at: "2026-11-25T03:00:00.000Z",
      },
    });
  });

  test.each([
    [{ outcome: "already_closed" }],
    [{ outcome: "not_found" }],
    [{ outcome: "checkpoint_unavailable" }],
  ] as [OperatorCloseResult][])(
    "writes no audit line for %j",
    async (outcome) => {
      const sink = new MemoryLogSink();
      await closeSession(
        { sessionId: SESSION, reason: "r" },
        { close: async () => outcome, audit: createLogger({ sinks: [sink] }) },
      );
      expect(sink.records).toHaveLength(0);
    },
  );
});
