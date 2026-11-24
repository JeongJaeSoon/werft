import {
  INSTALLATION_CONFIG,
  INSTALLATION_CONFIG_KEYS,
  type InstallationConfigEntries,
  type InstallationConfigKey,
  type InstallationConfigValues,
  installationConfigEnvOf,
} from "@werft-ai/contracts";
import {
  createPostgresInstallationConfigStore,
  type Database,
  type InstallationConfigStore,
} from "@werft-ai/db";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  CATALOG_REFRESH_MS,
  InstallationConfigUnavailableError,
  type SessionBudget,
  type SessionLimits,
  type WorkerLimits,
  type WorkspaceTtls,
} from "@werft-ai/platform";

export const SETTINGS_PAGE = "Settings > Workspace > Execution limits";

/** Every role reads on the same clock, so a save reaches them all alike. */
export const INSTALLATION_CONFIG_TIMING = {
  refreshMs: CATALOG_REFRESH_MS,
  retryMs: 30_000,
  maxStaleMs: 60_000,
};

/**
 * An env value as the parser that read it before read it: a value an
 * earlier release ran on is carried in, not blocked, and one it refused is
 * not carried in. Most read a number with `Number` (so `1800.0`, `+1800`
 * and `1e3` too); the archive days took digits alone, and the dry run
 * `booleanFlag`'s four words.
 */
function envValueOf(key: InstallationConfigKey, raw: string): unknown {
  if (key === "session_archive_after_days") {
    return /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  if (key === "session_archive_dry_run") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return raw;
  }
  const trimmed = raw.trim();
  const number = Number(trimmed);
  return trimmed !== "" && Number.isFinite(number) ? number : trimmed;
}

/**
 * Keys whose earlier parser refused a blank value: only "" was unset there,
 * the one Compose's `${X:-…}` replaced, so a blank one is carried as refused.
 */
const ONLY_EMPTY_IS_UNSET: ReadonlySet<InstallationConfigKey> = new Set([
  "session_archive_after_days",
  "session_archive_dry_run",
  "workspace_stopped_ttl_sec",
  "workspace_paused_ttl_sec",
]);

/** Unset as the earlier parser saw it. */
function envUnset(key: InstallationConfigKey, raw: string): boolean {
  return ONLY_EMPTY_IS_UNSET.has(key) ? raw === "" : raw.trim() === "";
}

/**
 * Migrate's carry-over, before any role starts: the old env variables are
 * read here once and nowhere else, so every role sees the same rows. A key
 * with no saved value takes a valid one in. A wrong one is kept as a row no
 * rule accepts, which every role reads as blocked until the owner saves a
 * value, rather than running under a default nobody chose. A blank variable
 * is one nobody set: Compose passes `${X:-}` through. The warnings never
 * carry a value.
 */
export async function carryInstallationConfig(
  env: Record<string, string | undefined>,
  store: Pick<InstallationConfigStore, "readAll" | "importValue">,
): Promise<{ warnings: string[] }> {
  const present = INSTALLATION_CONFIG_KEYS.flatMap((key) => {
    const name = installationConfigEnvOf(key);
    return name !== undefined && !envUnset(key, env[name] ?? "")
      ? [{ key, name }]
      : [];
  });
  if (present.length === 0) return { warnings: [] };
  const saved = await store.readAll();
  const warnings: string[] = [];
  const ignored: string[] = [];
  for (const { key, name } of present) {
    const { schema } = INSTALLATION_CONFIG[key];
    if (key in saved) {
      ignored.push(name);
      continue;
    }
    const parsed = schema.safeParse(envValueOf(key, env[name] ?? ""));
    if (!parsed.success) {
      if (await store.importValue(key, { refused_env: name })) {
        warnings.push(
          `${name} was not carried in: it is outside what ${SETTINGS_PAGE} accepts. Until a value is saved there, what it sets is refused; then remove it`,
        );
      } else {
        ignored.push(name);
      }
      continue;
    }
    if (await store.importValue(key, parsed.data)) {
      warnings.push(
        `${name} was carried into ${SETTINGS_PAGE} and is no longer read; remove it`,
      );
    } else {
      ignored.push(name);
    }
  }
  if (ignored.length > 0) {
    warnings.push(`Ignored removed settings: ${ignored.join(", ")}`);
  }
  return { warnings };
}

/** One read of every key; a decision takes all it needs from one. */
export type InstallationConfigRead = {
  /** What applies: the saved value, else the default. Throws while blocked. */
  get<K extends InstallationConfigKey>(key: K): InstallationConfigValues[K];
};

type Entry<K extends InstallationConfigKey> =
  | { kind: "saved"; value: InstallationConfigValues[K] }
  | { kind: "default" }
  | { kind: "blocked" };

// A saved row the key's rule refuses (a value migrate could not carry in,
// or one a later release wrote) blocks the key: it never runs on a default
// nobody chose.
function entryOf<K extends InstallationConfigKey>(
  all: Record<string, unknown>,
  key: K,
): Entry<K> {
  if (!(key in all)) return { kind: "default" };
  const parsed = INSTALLATION_CONFIG[key].schema.safeParse(all[key]);
  return parsed.success
    ? { kind: "saved", value: parsed.data as InstallationConfigValues[K] }
    : { kind: "blocked" };
}

/** A saved 0 is the console's way of setting no token limit. */
const tokenLimitOf = (saved: number): number | null =>
  saved === 0 ? null : saved;

function readOf(all: Record<string, unknown>): InstallationConfigRead {
  return {
    get(key) {
      const entry = entryOf(all, key);
      if (entry.kind === "saved") return entry.value;
      if (entry.kind === "blocked") {
        throw new InstallationConfigUnavailableError(key);
      }
      return INSTALLATION_CONFIG[key]
        .default as InstallationConfigValues[typeof key];
    },
  };
}

/**
 * Installation settings as a role applies them; it only reads. The start
 * does not wait for the database: it tries at once and again on a timer.
 *
 * Values are cached and read again once older than `refreshMs`, and at once
 * after a save through this process; another process's save lands within
 * `refreshMs`. A failed reload keeps the last values for up to
 * `maxStaleMs`: past that, what they set is refused, so a lowered limit is
 * never ignored for long by one process that cannot read.
 */
export function createInstallationConfigSource(options: {
  store: Pick<InstallationConfigStore, "readAll">;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  refreshMs?: number;
  retryMs?: number;
  maxStaleMs?: number;
  now?: () => number;
}) {
  const deps = { ...INSTALLATION_CONFIG_TIMING, ...options };
  const now = deps.now ?? Date.now;
  let cache: { saved: Record<string, unknown>; at: number } | null = null;
  // One read at a time, so a later one always lands after an earlier one.
  // A failed read leaves the cache as it was.
  let loading: Promise<Record<string, unknown>> | null = null;
  const load = (): Promise<Record<string, unknown>> => {
    if (loading !== null) return loading;
    loading = deps.store
      .readAll()
      .then((saved) => {
        cache = { saved, at: now() };
        return saved;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };
  const saved = async (): Promise<Record<string, unknown>> => {
    if (cache !== null && now() - cache.at < deps.refreshMs) {
      return cache.saved;
    }
    try {
      return await load();
    } catch (error) {
      const fields = {
        error_name: error instanceof Error ? error.name : typeof error,
      };
      if (cache !== null && now() - cache.at < deps.maxStaleMs) {
        deps.warn(
          "Installation config could not be read; keeping the last",
          fields,
        );
        return cache.saved;
      }
      deps.warn(
        "Installation config could not be read; refusing what it sets",
        fields,
      );
      throw new InstallationConfigUnavailableError(null);
    }
  };

  const start = (): Promise<void> =>
    load().then(
      () => undefined,
      (error: unknown) => {
        deps.warn("Installation config could not be read; retrying", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        setTimeout(() => {
          void start();
        }, deps.retryMs).unref();
      },
    );

  return {
    started: start(),

    /** False until a first read has succeeded. */
    loaded: () => cache !== null,

    /** Every key from one read. */
    async read(): Promise<InstallationConfigRead> {
      return readOf(await saved());
    },

    async get<K extends InstallationConfigKey>(
      key: K,
    ): Promise<InstallationConfigValues[K]> {
      return readOf(await saved()).get(key);
    },

    /** The limits a session is held to, all from one read. */
    async sessionLimits(): Promise<SessionLimits> {
      const read = readOf(await saved());
      return {
        queuedInputLimitPerSession: read.get("queued_input_limit_per_session"),
        storageLimitBytes: read.get("storage_limit_bytes"),
        sessionCostLimitUsd: read.get("session_cost_limit_usd"),
        sessionTokenLimit: tokenLimitOf(read.get("session_token_limit")),
      };
    },

    /** Only the spend limits: an exchange or a launch needs no other key. */
    async sessionBudget(): Promise<SessionBudget> {
      const read = readOf(await saved());
      return {
        costUsd: read.get("session_cost_limit_usd"),
        tokens: tokenLimitOf(read.get("session_token_limit")),
      };
    },

    /** What a launch reserved now is pinned to, both from one read. */
    async workerLimits(): Promise<WorkerLimits> {
      const read = readOf(await saved());
      return {
        maxTurnSeconds: read.get("max_turn_seconds"),
        providerMaxRetries: read.get("provider_max_retries"),
      };
    },

    /** What a scheduler pass reclaims workspaces by, both from one read. */
    async workspaceTtls(): Promise<WorkspaceTtls> {
      const read = readOf(await saved());
      return {
        stoppedTtlMs: read.get("workspace_stopped_ttl_sec") * 1_000,
        pausedTtlMs: read.get("workspace_paused_ttl_sec") * 1_000,
      };
    },

    /**
     * Every key as the console shows it, read fresh: a read already under
     * way may have begun before a save, so it is waited out first. A failed
     * read fails the view and keeps the values the process applies.
     */
    async view(): Promise<InstallationConfigEntries> {
      await loading?.catch(() => undefined);
      const all = await load();
      return Object.fromEntries(
        INSTALLATION_CONFIG_KEYS.map((key) => {
          const entry = entryOf(all, key);
          const fallback = INSTALLATION_CONFIG[key].default;
          return [
            key,
            {
              value: entry.kind === "saved" ? entry.value : fallback,
              default: fallback,
              saved: entry.kind === "saved",
              blocked: entry.kind === "blocked",
            },
          ];
        }),
      ) as InstallationConfigEntries;
    },
  };
}

export type InstallationConfigSource = ReturnType<
  typeof createInstallationConfigSource
>;

/** A role's source, read from its own pool. */
export function installationConfigOf(
  db: Database,
  logger: Pick<StructuredLogger, "warn">,
): InstallationConfigSource {
  return createInstallationConfigSource({
    store: createPostgresInstallationConfigStore(db),
    warn: (message, fields) => logger.warn(message, fields ?? {}),
  });
}
