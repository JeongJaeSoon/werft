import { describe, expect, test } from "bun:test";

import {
  createLogger,
  logLevelFromEnv,
  MemoryLogSink,
  resolveLogLevel,
} from "./index.ts";

describe("structured logging", () => {
  test("keeps a stable event separate from the human-readable message", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });

    logger.info("API request completed", {
      event: "api.request.completed",
      operation: "api_request",
    });

    expect(sink.records[0]).toMatchObject({
      event: "api.request.completed",
      message: "API request completed",
      fields: { operation: "api_request" },
    });
    expect(sink.records[0]?.fields).not.toHaveProperty("event");
  });

  test.each([false, true])(
    "redacts sensitive text in log messages with includeMessageBodies=%s",
    (includeMessageBodies) => {
      const sink = new MemoryLogSink();
      const logger = createLogger({ sinks: [sink], includeMessageBodies });
      const canary = "SYNTHETIC_LOG_CANARY";
      const keys = [
        "password",
        "api_key",
        "access-key",
        "authorization",
        "token",
        "credential",
        "request_body",
        "prompt",
      ];

      for (const key of keys) {
        logger.error(`operation failed: ${key}=${canary}`);
        logger.warn(`operation failed: ${key}: ${canary}`);
      }

      expect(sink.records).toHaveLength(keys.length * 2);
      expect(
        sink.records.every((record) => record.message === "[REDACTED]"),
      ).toBe(true);
      expect(JSON.stringify(sink.records).includes(canary)).toBe(false);

      logger.info("checkpoint.completed");
      expect(sink.records.at(-1)?.message).toBe("checkpoint.completed");
    },
  );

  test("redacts credentials, omits message bodies, and tolerates broken sinks", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({
      sinks: [sink, { write: () => Promise.reject(new Error("unavailable")) }],
    });

    logger.info("turn.received", {
      authorization: "Bearer secret-value",
      GIT_TOKEN: "ghp_secret",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      nested: { access_token: "secret" },
      message: "also omitted",
      request_body: { message: "do not retain this" },
      content: "also omitted",
      safe: "visible",
    });
    logger.info("Bearer token-value");

    expect(sink.records).toHaveLength(2);
    expect(sink.records[0]?.fields).toEqual({
      authorization: "[REDACTED]",
      GIT_TOKEN: "[REDACTED]",
      ANTHROPIC_API_KEY: "[REDACTED]",
      AWS_SECRET_ACCESS_KEY: "[REDACTED]",
      nested: { access_token: "[REDACTED]" },
      safe: "visible",
    });
    expect(sink.records[1]?.message).toBe("[REDACTED]");
  });

  test("drops the login from a URL and keeps the rest of it", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });

    logger.warn("fetch https://agent:tok123@fake-git:3000/a.git failed", {
      remote: "https://tok123@github.com/o/r.git",
      at: "https://user:p@ss@host.test/r?by=a@b",
      mail: "someone@example.test",
    });

    expect(sink.records[0]?.message).toBe(
      "fetch https://[REDACTED]@fake-git:3000/a.git failed",
    );
    expect(sink.records[0]?.fields).toEqual({
      remote: "https://[REDACTED]@github.com/o/r.git",
      at: "https://[REDACTED]@host.test/r?by=a@b",
      mail: "someone@example.test",
    });
  });

  test("masks a multi-line value line by line and keeps the other lines", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });
    const canary = "sk-canary-1552";

    logger.warn("Execution resource failed; log tail kept", {
      log_tail: [
        "booting",
        "ZodError: [",
        '    "message": "Invalid input: expected string, received undefined"',
        `  GIT_TOKEN=${canary}`,
        `\tAuthorization: Bearer ${canary}\r`,
        "prompt: summarize the repository",
        "    at parse (/app/worker.js:10:5)",
        "",
      ].join("\n"),
      single: "Invalid input: expected string",
    });

    expect(sink.records[0]?.fields).toEqual({
      log_tail: [
        "booting",
        "ZodError: [",
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]\r",
        "[REDACTED]",
        "    at parse (/app/worker.js:10:5)",
        "",
      ].join("\n"),
      single: "[REDACTED]",
    });
    expect(JSON.stringify(sink.records).includes(canary)).toBe(false);
  });

  test("does not propagate logging preparation failures", () => {
    const logger = createLogger({
      sinks: [new MemoryLogSink()],
      now: () => {
        throw new Error("clock unavailable");
      },
    });

    expect(() => logger.info("ignored")).not.toThrow();
  });

  test("uses LOG_LEVEL compatible values and filters lower records", () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ level: "warn", sinks: [sink] });
    logger.info("not-emitted");
    logger.warn("emitted");

    expect(resolveLogLevel("DEBUG")).toBe("debug");
    expect(resolveLogLevel("not-a-level")).toBe("info");
    expect(logLevelFromEnv(undefined)).toBe("info");
    expect(logLevelFromEnv("")).toBe("info");
    expect(logLevelFromEnv("WARN")).toBe("warn");
    expect(resolveLogLevel(" warn ")).toBe(logLevelFromEnv(" warn "));
    expect(() => logLevelFromEnv("inf0")).toThrow(
      'LOG_LEVEL must be one of debug|info|warn|error, got "inf0"',
    );
    expect(sink.records.map((record) => record.message)).toEqual(["emitted"]);
  });
});

describe("M0 async flow simulation", () => {
  test("propagates API context through claim, turn, and checkpoint", async () => {
    const sink = new MemoryLogSink();
    const logger = createLogger({ sinks: [sink] });

    await logger.withContext(
      { session_id: "session-1", pod_id: "worker-1" },
      async () => {
        logger.info("api.accepted", { route: "/sessions" });
        await Promise.resolve();
        logger.info("worker.claimed");
        await logger.withContext({ turn_id: 7 }, async () => {
          logger.info("turn.started", { body: "private prompt" });
          await Promise.resolve();
          logger.info("checkpoint.stored");
        });
      },
    );

    expect(sink.records.map((record) => record.message)).toEqual([
      "api.accepted",
      "worker.claimed",
      "turn.started",
      "checkpoint.stored",
    ]);
    expect(sink.records.map((record) => record.session_id)).toEqual([
      "session-1",
      "session-1",
      "session-1",
      "session-1",
    ]);
    expect(sink.records.slice(2).map((record) => record.turn_id)).toEqual([
      7, 7,
    ]);
    expect(sink.records[2]?.fields).toBeUndefined();
  });
});
