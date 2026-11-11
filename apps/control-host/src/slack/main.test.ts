import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Database } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import { SecretKey, usesConsoleApp } from "@werft-ai/platform";
import {
  slackRepositoryViews,
  slackRoleSettings,
  slackRoleStartup,
  slackSessionHandler,
} from "./main.ts";

const KEY = randomBytes(32).toString("hex");
const base = {
  DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
  PLATFORM_SECRET_KEY: KEY,
};

function failure(start: () => unknown): string {
  try {
    start();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("slack role startup", () => {
  test("takes the master key and reads no provider key", () => {
    const { secretKey } = slackRoleStartup(base);
    expect(secretKey).toBeInstanceOf(SecretKey);
  });

  test("refuses a leftover file catalog until it is unset", () => {
    expect(
      failure(() => slackRoleStartup({ ...base, PLATFORM_CONFIG_DIR: "/c" })),
    ).toContain("PLATFORM_CONFIG_DIR no longer read");
    expect(
      failure(() => slackRoleStartup({ ...base, SESSION_CATALOG_JSON: "{}" })),
    ).toContain("SESSION_CATALOG_JSON no longer read");
    expect(
      slackRoleStartup({ ...base, PLATFORM_CONFIG_DIR: "" }),
    ).toBeDefined();
  });

  test("a bad master key or setting stops it before any pass", () => {
    expect(
      failure(() => slackRoleStartup({ ...base, PLATFORM_SECRET_KEY: "abc" })),
    ).toContain("PLATFORM_SECRET_KEY");
    expect(
      failure(() => slackRoleStartup({ DATABASE_URL: base.DATABASE_URL })),
    ).toContain("PLATFORM_SECRET_KEY is required");
    expect(
      failure(() => slackRoleStartup({ ...base, SLACK_ROLE_LEASE_SEC: "0" })),
    ).toContain("SLACK_ROLE_LEASE_SEC");
    expect(
      failure(() => slackRoleStartup({ PLATFORM_SECRET_KEY: KEY })),
    ).toContain("DATABASE_URL or QUEUE_DATABASE_URL is required");
  });

  // One pass child serves pass after pass, each building a handler: a timer
  // a handler starts outlives its pass and keeps reading a closed pool.
  test("a pass's handler leaves no timer running in the pass child", () => {
    const { secretKey } = slackRoleStartup(base);
    const original = globalThis.setInterval;
    const started: ReturnType<typeof setInterval>[] = [];
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const timer = original(...args);
      started.push(timer);
      return timer;
    }) as typeof setInterval;
    try {
      for (let pass = 0; pass < 3; pass += 1) {
        slackSessionHandler({
          db: {} as Database,
          pool: {
            connect: () => {
              throw new Error("no connection is opened");
            },
          },
          environment: {
            EXECUTION_SLOT_LIMIT: "10",
            MAX_TURN_SECONDS: "3600",
            PROVIDER_MAX_RETRIES: "2",
            QUEUED_INPUT_LIMIT_PER_SESSION: "20",
            SESSION_COST_LIMIT_USD: "25",
            STORAGE_LIMIT_BYTES: "1073741824",
          },
          logger: createLogger({ level: "error", sinks: [] }),
          secretKey,
          leaseMs: 60_000,
        });
      }
    } finally {
      globalThis.setInterval = original;
      for (const timer of started) clearInterval(timer);
    }
    expect(started.length).toBe(0);
  });

  test("settings default to a 60s lease, batches of 10 and half the pass timeout", () => {
    expect(slackRoleSettings({})).toEqual({
      batchSize: 10,
      leaseMs: 60_000,
      passBudgetMs: 30_000,
    });
  });
});

describe("slackRepositoryViews", () => {
  test("a console App repository keeps its github_app mark without credentials", () => {
    const views = slackRepositoryViews(
      [
        {
          id: "web",
          github_repository_id: null,
          owner: "acme",
          name: "web",
          url: "https://github.com/acme/web.git",
          branch: "main",
          source: "console",
          version: 1,
          created_at: "2026-11-01T00:00:00.000Z",
          updated_at: "2026-11-01T00:00:00.000Z",
        },
      ],
      {},
    );
    const web = views.web;
    if (web === undefined) throw new Error("web missing");
    expect("auth" in web).toBe(false);
    expect(usesConsoleApp(web)).toBe(true);
  });
});
