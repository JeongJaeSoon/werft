import { describe, expect, test } from "bun:test";
import type { InstallationConfigStore } from "@werft-ai/db";
import { InstallationConfigUnavailableError } from "@werft-ai/platform";
import {
  carryInstallationConfig,
  createInstallationConfigSource,
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

const carried = (name: string) =>
  `${name} was carried into Settings > Workspace > Execution limits and is no longer read; remove it`;
const IGNORED = "Ignored removed settings: PENDING_REQUEST_TTL_SEC";

describe("carryInstallationConfig", () => {
  test("nothing set reads nothing", async () => {
    const memory = memoryStore();
    expect(await carryInstallationConfig({}, memory.store)).toEqual({
      warnings: [],
    });
    expect(memory.calls.readAll).toBe(0);
  });

  test("a blank variable is one nobody set", async () => {
    const memory = memoryStore();
    expect(
      await carryInstallationConfig(
        { SESSION_COST_LIMIT_USD: "", WORKSPACE_ENFORCE: "  " },
        memory.store,
      ),
    ).toEqual({ warnings: [] });
    expect(memory.saved).toEqual({});
  });

  test("a valid value with nothing saved is carried in once; after that it is ignored", async () => {
    const memory = memoryStore();
    const env = { PENDING_REQUEST_TTL_SEC: " 90 " };
    expect(await carryInstallationConfig(env, memory.store)).toEqual({
      warnings: [carried("PENDING_REQUEST_TTL_SEC")],
    });
    expect(memory.saved).toEqual({ pending_request_ttl_sec: 90 });
    expect(await carryInstallationConfig(env, memory.store)).toEqual({
      warnings: [IGNORED],
    });
  });

  test("every limit the roles read from env is carried in, as each read it", async () => {
    const memory = memoryStore();
    await carryInstallationConfig(
      {
        QUEUED_INPUT_LIMIT_PER_SESSION: "5",
        STORAGE_LIMIT_BYTES: "2048",
        SESSION_COST_LIMIT_USD: "0.5",
        SESSION_TOKEN_LIMIT: "0",
        WORKSPACE_ENFORCE: "fail",
        MAX_TURN_SECONDS: "600",
        PROVIDER_MAX_RETRIES: "0",
        EXECUTION_WORKSPACE_STOPPED_TTL_SEC: "0",
        EXECUTION_WORKSPACE_PAUSED_TTL_SEC: "3600",
      },
      memory.store,
    );
    expect(memory.saved).toEqual({
      queued_input_limit_per_session: 5,
      storage_limit_bytes: 2048,
      session_cost_limit_usd: 0.5,
      session_token_limit: 0,
      workspace_enforce: "fail",
      max_turn_seconds: 600,
      provider_max_retries: 0,
      workspace_stopped_ttl_sec: 0,
      workspace_paused_ttl_sec: 3600,
    });
  });

  test("a saved value wins over the env, whatever it holds", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 600 });
    expect(
      await carryInstallationConfig(
        { PENDING_REQUEST_TTL_SEC: "nonsense" },
        memory.store,
      ),
    ).toEqual({ warnings: [IGNORED] });
    expect(memory.saved).toEqual({ pending_request_ttl_sec: 600 });
  });

  // What the earlier env parser took (`Number`), so an upgrade keeps it.
  for (const [raw, value] of [
    ["1800.0", 1800],
    ["+1800", 1800],
    ["1e3", 1000],
  ] as const) {
    test(`${JSON.stringify(raw)} is carried in as ${value}, as the earlier release read it`, async () => {
      const memory = memoryStore();
      expect(
        await carryInstallationConfig(
          { PENDING_REQUEST_TTL_SEC: raw },
          memory.store,
        ),
      ).toEqual({ warnings: [carried("PENDING_REQUEST_TTL_SEC")] });
      expect(memory.saved).toEqual({ pending_request_ttl_sec: value });
    });
  }

  // The archive read whole digits for its days and booleanFlag's four words
  // for its dry run, nothing looser.
  for (const [name, key, raw, value] of [
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", "0", 0],
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", "180", 180],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "true", true],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "1", true],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "0", false],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "false", false],
  ] as const) {
    test(`${name}=${JSON.stringify(raw)} is carried in as ${value}, as the archive read it`, async () => {
      const memory = memoryStore();
      expect(
        await carryInstallationConfig({ [name]: raw }, memory.store),
      ).toEqual({ warnings: [carried(name)] });
      expect(memory.saved).toEqual({ [key]: value });
    });
  }

  // `integerSetting` took what `Number` reads as a safe integer, blanks
  // around it included.
  for (const [raw, value] of [
    [" 30 ", 30],
    ["1e3", 1000],
    ["0x10", 16],
    ["315360000", 315_360_000],
  ] as const) {
    test(`EXECUTION_WORKSPACE_STOPPED_TTL_SEC=${JSON.stringify(raw)} is carried in as ${value}`, async () => {
      const memory = memoryStore();
      expect(
        await carryInstallationConfig(
          { EXECUTION_WORKSPACE_STOPPED_TTL_SEC: raw },
          memory.store,
        ),
      ).toEqual({
        warnings: [carried("EXECUTION_WORKSPACE_STOPPED_TTL_SEC")],
      });
      expect(memory.saved).toEqual({ workspace_stopped_ttl_sec: value });
    });
  }

  test("an empty workspace TTL is unset, as Compose's ${X:-86400} made it", async () => {
    const memory = memoryStore();
    expect(
      await carryInstallationConfig(
        {
          EXECUTION_WORKSPACE_STOPPED_TTL_SEC: "",
          EXECUTION_WORKSPACE_PAUSED_TTL_SEC: "",
        },
        memory.store,
      ),
    ).toEqual({ warnings: [] });
    expect(memory.saved).toEqual({});
  });

  // The values that used to stop a role at start.
  for (const [name, key, raw] of [
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", "29"],
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", "3e1"],
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", "+30"],
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", " 30"],
    // Only "" was unset to the archive; blank space was a refusal.
    ["SESSION_ARCHIVE_AFTER_DAYS", "session_archive_after_days", "   "],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "\t"],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "maybe"],
    ["SESSION_ARCHIVE_DRY_RUN", "session_archive_dry_run", "TRUE"],
    ["PENDING_REQUEST_TTL_SEC", "pending_request_ttl_sec", "30m"],
    ["PENDING_REQUEST_TTL_SEC", "pending_request_ttl_sec", "604801"],
    ["SESSION_COST_LIMIT_USD", "session_cost_limit_usd", "0"],
    ["SESSION_TOKEN_LIMIT", "session_token_limit", "1.5"],
    ["STORAGE_LIMIT_BYTES", "storage_limit_bytes", "lots"],
    ["WORKSPACE_ENFORCE", "workspace_enforce", "force"],
    ["MAX_TURN_SECONDS", "max_turn_seconds", "0"],
    ["PROVIDER_MAX_RETRIES", "provider_max_retries", "11"],
    // A blank one stopped the scheduler; only "" was unset.
    ["EXECUTION_WORKSPACE_STOPPED_TTL_SEC", "workspace_stopped_ttl_sec", "   "],
    ["EXECUTION_WORKSPACE_PAUSED_TTL_SEC", "workspace_paused_ttl_sec", "\t"],
    ["EXECUTION_WORKSPACE_STOPPED_TTL_SEC", "workspace_stopped_ttl_sec", "-1"],
    ["EXECUTION_WORKSPACE_PAUSED_TTL_SEC", "workspace_paused_ttl_sec", "1.5"],
    ["EXECUTION_WORKSPACE_PAUSED_TTL_SEC", "workspace_paused_ttl_sec", "abc"],
    // Past the console's range, though the earlier parser had no top.
    [
      "EXECUTION_WORKSPACE_STOPPED_TTL_SEC",
      "workspace_stopped_ttl_sec",
      "315360001",
    ],
  ] as const) {
    test(`${name}=${JSON.stringify(raw)} is kept as a refusal, and the warning never carries it`, async () => {
      const memory = memoryStore();
      const { warnings } = await carryInstallationConfig(
        { [name]: raw },
        memory.store,
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith(`${name} was not carried in`);
      expect(warnings[0]).not.toContain(raw);
      expect(memory.saved).toEqual({ [key]: { refused_env: name } });
    });
  }
});

function sourceOver(memory: ReturnType<typeof memoryStore>) {
  let clock = 0;
  const warnings: string[] = [];
  const source = createInstallationConfigSource({
    store: memory.store,
    warn: (message: string) => warnings.push(message),
    refreshMs: 10_000,
    retryMs: 60_000,
    maxStaleMs: 60_000,
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
    expect((await source.view()).pending_request_ttl_sec).toEqual({
      value: 1800,
      default: 1800,
      saved: false,
      blocked: false,
    });
    expect(await source.sessionLimits()).toEqual({
      queuedInputLimitPerSession: 20,
      storageLimitBytes: 1_073_741_824,
      sessionCostLimitUsd: 25,
      sessionTokenLimit: null,
    });
    expect(await source.get("workspace_enforce")).toBe("warn");
    expect(await source.workerLimits()).toEqual({
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
    });
    expect(source.loaded()).toBe(true);
  });

  test("an open is judged against the session's budget and its limit on tokens of unknown price, from one read", async () => {
    const memory = memoryStore();
    const { source, advance } = sourceOver(memory);
    expect(await source.exchangeBudget()).toEqual({
      costUsd: 25,
      tokens: null,
      unknownPriceTokens: 5_000_000,
    });
    memory.saved.unknown_price_session_token_limit = 20_000;
    advance(10_000);
    expect((await source.exchangeBudget()).unknownPriceTokens).toBe(20_000);
    // 0 is no value for it: the key is blocked, never read as "no limit".
    memory.saved.unknown_price_session_token_limit = 0;
    advance(10_000);
    await expect(source.exchangeBudget()).rejects.toBeInstanceOf(
      InstallationConfigUnavailableError,
    );
  });

  test("a saved token limit of 0 sets none; any other is the limit", async () => {
    const memory = memoryStore({ session_token_limit: 0 });
    const { source, advance } = sourceOver(memory);
    expect((await source.sessionBudget()).tokens).toBeNull();
    memory.saved.session_token_limit = 500_000;
    advance(10_000);
    expect(await source.sessionBudget()).toEqual({
      costUsd: 25,
      tokens: 500_000,
    });
  });

  test("a refused carry blocks its key until a value is saved, instead of running on the default", async () => {
    const memory = memoryStore({
      pending_request_ttl_sec: { refused_env: "PENDING_REQUEST_TTL_SEC" },
    });
    const { source } = sourceOver(memory);
    await source.started;
    await expect(source.get("pending_request_ttl_sec")).rejects.toBeInstanceOf(
      InstallationConfigUnavailableError,
    );
    expect((await source.view()).pending_request_ttl_sec).toEqual({
      value: 1800,
      default: 1800,
      saved: false,
      blocked: true,
    });
    // Saving the default itself unblocks it.
    await memory.store.setValues({
      values: { pending_request_ttl_sec: 1800 },
      audit: { userId: "u", workspaceId: "w", receiptId: "r" },
    });
    expect((await source.view()).pending_request_ttl_sec).toEqual({
      value: 1800,
      default: 1800,
      saved: true,
      blocked: false,
    });
    expect(await source.get("pending_request_ttl_sec")).toBe(1800);
  });

  test("a blocked key refuses only what reads it", async () => {
    const memory = memoryStore({
      storage_limit_bytes: { refused_env: "STORAGE_LIMIT_BYTES" },
    });
    const { source } = sourceOver(memory);
    await expect(source.sessionLimits()).rejects.toBeInstanceOf(
      InstallationConfigUnavailableError,
    );
    expect(await source.sessionBudget()).toEqual({ costUsd: 25, tokens: null });
    expect(await source.get("workspace_enforce")).toBe("warn");
    expect(await source.workerLimits()).toEqual({
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
    });
  });

  test("the worker limits come from one read, and either blocked refuses both", async () => {
    const memory = memoryStore({ max_turn_seconds: 1200 });
    const { source, advance } = sourceOver(memory);
    expect(await source.workerLimits()).toEqual({
      maxTurnSeconds: 1200,
      providerMaxRetries: 2,
    });
    memory.saved.provider_max_retries = {
      refused_env: "PROVIDER_MAX_RETRIES",
    };
    advance(10_000);
    const refused = await source.workerLimits().catch((error) => error);
    expect(refused).toBeInstanceOf(InstallationConfigUnavailableError);
    expect((refused as InstallationConfigUnavailableError).key).toBe(
      "provider_max_retries",
    );
    // The session limits read nothing of it.
    expect((await source.sessionLimits()).queuedInputLimitPerSession).toBe(20);
  });

  test("the workspace TTLs come from one read in milliseconds, and either blocked refuses both", async () => {
    const memory = memoryStore({ workspace_stopped_ttl_sec: 0 });
    const { source, advance } = sourceOver(memory);
    expect(await source.workspaceTtls()).toEqual({
      stoppedTtlMs: 0,
      pausedTtlMs: 86_400_000,
    });
    memory.saved.workspace_paused_ttl_sec = {
      refused_env: "EXECUTION_WORKSPACE_PAUSED_TTL_SEC",
    };
    advance(10_000);
    const refused = await source.workspaceTtls().catch((error) => error);
    expect(refused).toBeInstanceOf(InstallationConfigUnavailableError);
    expect((refused as InstallationConfigUnavailableError).key).toBe(
      "workspace_paused_ttl_sec",
    );
    expect(await source.workerLimits()).toEqual({
      maxTurnSeconds: 3600,
      providerMaxRetries: 2,
    });
  });

  test("a saved value that breaks the key's rule blocks the key instead of running on the default", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 0 });
    const { source } = sourceOver(memory);
    await source.started;
    await expect(source.get("pending_request_ttl_sec")).rejects.toBeInstanceOf(
      InstallationConfigUnavailableError,
    );
    expect((await source.view()).pending_request_ttl_sec.blocked).toBe(true);
  });

  test("a view that cannot read keeps what the process applies", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 60 });
    const { source } = sourceOver(memory);
    await source.started;
    expect(await source.get("pending_request_ttl_sec")).toBe(60);
    memory.fail(true);
    await expect(source.view()).rejects.toThrow("database is down");
    expect(await source.get("pending_request_ttl_sec")).toBe(60);
    expect(source.loaded()).toBe(true);
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

  test("a failed reload keeps the last values only until they are too old, then refuses", async () => {
    const memory = memoryStore({ session_cost_limit_usd: 5 });
    const { source, advance, warnings } = sourceOver(memory);
    await source.started;
    memory.fail(true);
    advance(10_000);
    expect(await source.get("session_cost_limit_usd")).toBe(5);
    expect(warnings).toEqual([
      "Installation config could not be read; keeping the last",
    ]);
    advance(50_000);
    const refused = await source.get("session_cost_limit_usd").catch((e) => e);
    expect(refused).toBeInstanceOf(InstallationConfigUnavailableError);
    expect((refused as InstallationConfigUnavailableError).key).toBeNull();
    expect(warnings.at(-1)).toBe(
      "Installation config could not be read; refusing what it sets",
    );
    memory.fail(false);
    expect(await source.get("session_cost_limit_usd")).toBe(5);
  });

  test("a database that is down at start does not block the start; nothing is applied until a read succeeds", async () => {
    const memory = memoryStore({ pending_request_ttl_sec: 90 });
    memory.fail(true);
    const { source, warnings } = sourceOver(memory);
    await source.started;
    expect(warnings).toEqual([
      "Installation config could not be read; retrying",
    ]);
    expect(source.loaded()).toBe(false);
    await expect(source.get("pending_request_ttl_sec")).rejects.toBeInstanceOf(
      InstallationConfigUnavailableError,
    );
    memory.fail(false);
    expect(await source.get("pending_request_ttl_sec")).toBe(90);
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
