import { describe, expect, test } from "bun:test";
import type { InstallationConfigStore } from "@werft-ai/db";
import {
  createInstallationConfigSource,
  InstallationConfigUnavailableError,
  importInstallationConfig,
} from "./installation-config.ts";

function memoryStore(initial: Record<string, unknown> = {}) {
  const saved: Record<string, unknown> = { ...initial };
  const calls = { readAll: 0, importValue: 0 };
  let failing = false;
  const store: InstallationConfigStore = {
    async readAll() {
      calls.readAll++;
      if (failing) throw new Error("database is down");
      return { ...saved };
    },
    async setValues({ values }) {
      Object.assign(saved, values);
      return { changed: true };
    },
    async importValue(key, value) {
      calls.importValue++;
      if (failing) throw new Error("database is down");
      if (key in saved) return false;
      saved[key] = value;
      return true;
    },
  };
  return {
    store,
    saved,
    calls,
    fail: (on: boolean) => {
      failing = on;
    },
  };
}

const CARRIED =
  "PENDING_REQUEST_TTL_SEC was carried into Settings > Workspace > Execution limits and is no longer read; remove it";
const IGNORED = "Ignored removed settings: PENDING_REQUEST_TTL_SEC";

describe("importInstallationConfig", () => {
  test("nothing set reads nothing", async () => {
    const memory = memoryStore();
    expect(await importInstallationConfig({}, memory.store)).toEqual({
      warnings: [],
      invalid: [],
    });
    expect(memory.calls.readAll).toBe(0);
  });

  test("a valid value with nothing saved is carried in once; after that it is ignored", async () => {
    const memory = memoryStore();
    const env = { PENDING_REQUEST_TTL_SEC: " 90 " };
    expect(await importInstallationConfig(env, memory.store)).toEqual({
      warnings: [CARRIED],
      invalid: [],
    });
    expect(memory.saved).toEqual({ pending_request_ttl_sec: 90 });
    expect(await importInstallationConfig(env, memory.store)).toEqual({
      warnings: [IGNORED],
      invalid: [],
    });
  });

  test("a saved value wins over the env, whatever it holds", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 600 });
    expect(
      await importInstallationConfig(
        { PENDING_REQUEST_TTL_SEC: "nonsense" },
        memory.store,
      ),
    ).toEqual({ warnings: [IGNORED], invalid: [] });
    expect(memory.saved).toEqual({ pending_request_ttl_sec: 600 });
  });

  // The values that used to stop the API at start.
  for (const raw of ["0", "-1", "0.001", "1e12", "30m", "", "604801"]) {
    test(`${JSON.stringify(raw)} is not carried in, and the warning never carries it`, async () => {
      const memory = memoryStore();
      const { warnings, invalid } = await importInstallationConfig(
        { PENDING_REQUEST_TTL_SEC: raw },
        memory.store,
      );
      expect(invalid).toEqual(["pending_request_ttl_sec"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith(
        "PENDING_REQUEST_TTL_SEC was not carried in",
      );
      if (raw !== "") expect(warnings[0]).not.toContain(raw);
      expect(memory.saved).toEqual({});
    });
  }
});

function sourceOver(
  memory: ReturnType<typeof memoryStore>,
  env: Record<string, string> = {},
) {
  let clock = 0;
  const warnings: string[] = [];
  const source = createInstallationConfigSource({
    env,
    store: memory.store,
    warn: (message) => warnings.push(message),
    refreshMs: 10_000,
    retryMs: 60_000,
    now: () => clock,
  });
  return {
    source,
    warnings,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createInstallationConfigSource", () => {
  test("nothing saved is the default", async () => {
    const { source } = sourceOver(memoryStore());
    expect(await source.get("pending_request_ttl_sec")).toBe(1800);
    expect(await source.view()).toEqual({
      pending_request_ttl_sec: { value: 1800, default: 1800, saved: false },
    });
  });

  test("the carry-over lands before the first read, so the old value applies, not the default", async () => {
    const memory = memoryStore();
    const { source, warnings } = sourceOver(memory, {
      PENDING_REQUEST_TTL_SEC: "90",
    });
    expect(await source.get("pending_request_ttl_sec")).toBe(90);
    await source.started;
    expect(warnings).toEqual([CARRIED]);
    expect(memory.calls.importValue).toBe(1);
  });

  test("a wrong env value blocks the key until a value is saved, instead of running on the default", async () => {
    const memory = memoryStore();
    const { source } = sourceOver(memory, { PENDING_REQUEST_TTL_SEC: "30m" });
    await source.started;
    await expect(source.get("pending_request_ttl_sec")).rejects.toBeInstanceOf(
      InstallationConfigUnavailableError,
    );
    await memory.store.setValues({
      values: { pending_request_ttl_sec: 120 },
      audit: { userId: "u", workspaceId: "w", receiptId: "r" },
    });
    expect((await source.view()).pending_request_ttl_sec).toEqual({
      value: 120,
      default: 1800,
      saved: true,
    });
    expect(await source.get("pending_request_ttl_sec")).toBe(120);
  });

  test("values are read again only once older than the refresh interval", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 60 });
    const { source, advance } = sourceOver(memory);
    await source.started;
    const reads = memory.calls.readAll;
    memory.saved.pending_request_ttl_sec = 75;
    expect(await source.get("pending_request_ttl_sec")).toBe(60);
    expect(memory.calls.readAll).toBe(reads);
    advance(10_000);
    expect(await source.get("pending_request_ttl_sec")).toBe(75);
  });

  test("a failed reload keeps the last values read", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 60 });
    const { source, advance, warnings } = sourceOver(memory);
    await source.started;
    memory.fail(true);
    advance(10_000);
    expect(await source.get("pending_request_ttl_sec")).toBe(60);
    expect(warnings).toEqual([
      "Installation config could not be read; keeping the last",
    ]);
  });

  test("a database that is down at start does not block the start; the first read that reaches it carries the env in", async () => {
    const memory = memoryStore();
    memory.fail(true);
    const { source, warnings } = sourceOver(memory, {
      PENDING_REQUEST_TTL_SEC: "90",
    });
    await source.started;
    expect(warnings).toEqual([
      "Installation config could not be read; retrying",
    ]);
    await expect(source.get("pending_request_ttl_sec")).rejects.toThrow(
      "database is down",
    );
    memory.fail(false);
    expect(await source.get("pending_request_ttl_sec")).toBe(90);
    expect(warnings.at(-1)).toBe(CARRIED);
  });

  test("a save shows at once in the view of the process that made it", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 60 });
    const { source } = sourceOver(memory);
    await source.started;
    expect(await source.get("pending_request_ttl_sec")).toBe(60);
    await memory.store.setValues({
      values: { pending_request_ttl_sec: 300 },
      audit: { userId: "u", workspaceId: "w", receiptId: "r" },
    });
    expect((await source.view()).pending_request_ttl_sec.value).toBe(300);
    expect(await source.get("pending_request_ttl_sec")).toBe(300);
  });
});
