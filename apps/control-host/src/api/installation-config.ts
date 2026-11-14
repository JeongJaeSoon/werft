import {
  INSTALLATION_CONFIG,
  INSTALLATION_CONFIG_KEYS,
  type InstallationConfig,
  type InstallationConfigKey,
  type InstallationConfigValues,
  type UpdateInstallationConfigRequest,
  type UpdateInstallationConfigResponse,
} from "@werft-ai/contracts";
import type { InstallationConfigStore } from "@werft-ai/db";
import type { AuthorizationPolicy, Caller } from "@werft-ai/platform";
import { requireSignInOwner } from "./provider-admin.ts";

const SETTINGS_PAGE = "Settings > Workspace > Execution limits";

/** An env value as the key's rule reads it: digits are a number. */
function envValueOf(raw: string): unknown {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * The old env variables are no longer read. A key with no saved value takes
 * a valid one in, once; a wrong one is not carried and blocks the key until
 * it is saved, rather than running under a default nobody chose. The
 * warnings never carry a value.
 */
export async function importInstallationConfig(
  env: Record<string, string | undefined>,
  store: Pick<InstallationConfigStore, "readAll" | "importValue">,
): Promise<{ warnings: string[]; invalid: InstallationConfigKey[] }> {
  const present = INSTALLATION_CONFIG_KEYS.filter(
    (key) => env[INSTALLATION_CONFIG[key].env] !== undefined,
  );
  if (present.length === 0) return { warnings: [], invalid: [] };
  const saved = await store.readAll();
  const warnings: string[] = [];
  const invalid: InstallationConfigKey[] = [];
  const ignored: string[] = [];
  for (const key of present) {
    const { env: name, schema } = INSTALLATION_CONFIG[key];
    if (key in saved) {
      ignored.push(name);
      continue;
    }
    const parsed = schema.safeParse(envValueOf(env[name] ?? ""));
    if (!parsed.success) {
      invalid.push(key);
      warnings.push(
        `${name} was not carried in: it is outside what ${SETTINGS_PAGE} accepts. Until a value is saved there, what it sets is refused; then remove it`,
      );
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
  return { warnings, invalid };
}

export class InstallationConfigUnavailableError extends Error {
  constructor(readonly key: InstallationConfigKey) {
    super(
      `${INSTALLATION_CONFIG[key].env} could not be carried into ${SETTINGS_PAGE}; save ${key} there`,
    );
  }
}

/**
 * Installation settings as this process applies them. Every read first
 * finishes the carry-over, so nothing runs on a default while an old env
 * value is still due. The start does not wait for the database: it tries
 * at once and again on a timer, as the catalog read does.
 *
 * Values are cached and read again once older than `refreshMs`, and at once
 * after a save through this process; another replica's save lands within
 * `refreshMs`. A failed reload keeps the last values read.
 */
export function createInstallationConfigSource(deps: {
  env: Record<string, string | undefined>;
  store: InstallationConfigStore;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  refreshMs: number;
  retryMs: number;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let invalid = new Set<InstallationConfigKey>();
  let carried: Promise<void> | null = null;
  const carry = () => {
    carried ??= importInstallationConfig(deps.env, deps.store).then(
      (result) => {
        invalid = new Set(result.invalid);
        for (const warning of result.warnings) deps.warn(warning);
      },
      (error: unknown) => {
        carried = null;
        throw error;
      },
    );
    return carried;
  };

  let cache: { saved: Record<string, unknown>; at: number } | null = null;
  // One read at a time, so a later one always lands after an earlier one.
  let loading: Promise<Record<string, unknown>> | null = null;
  const reload = (): Promise<Record<string, unknown>> => {
    if (loading !== null) return loading;
    const attempt = (async () => {
      await carry();
      return deps.store.readAll();
    })().then(
      (saved) => {
        cache = { saved, at: now() };
        return saved;
      },
      (error: unknown) => {
        if (cache === null) throw error;
        deps.warn("Installation config could not be read; keeping the last", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        return cache.saved;
      },
    );
    loading = attempt.finally(() => {
      loading = null;
    });
    return loading;
  };
  const saved = (): Promise<Record<string, unknown>> =>
    cache !== null && now() - cache.at < deps.refreshMs
      ? Promise.resolve(cache.saved)
      : reload();

  const savedValue = <K extends InstallationConfigKey>(
    all: Record<string, unknown>,
    key: K,
  ): InstallationConfigValues[K] | undefined => {
    if (!(key in all)) return undefined;
    const parsed = INSTALLATION_CONFIG[key].schema.safeParse(all[key]);
    return parsed.success
      ? (parsed.data as InstallationConfigValues[K])
      : undefined;
  };

  const start = (): Promise<void> =>
    reload().then(
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

    /**
     * What applies now: the saved value, else the default. Throws while the
     * key's old env value could not be carried in and nothing is saved.
     */
    async get<K extends InstallationConfigKey>(
      key: K,
    ): Promise<InstallationConfigValues[K]> {
      const value = savedValue(await saved(), key);
      if (value !== undefined) return value;
      if (invalid.has(key)) throw new InstallationConfigUnavailableError(key);
      return INSTALLATION_CONFIG[key].default as InstallationConfigValues[K];
    },

    /**
     * Every key as the console shows it, read fresh: a read already under
     * way may have begun before a save, so it is waited out first.
     */
    async view(): Promise<InstallationConfig> {
      await loading?.catch(() => undefined);
      cache = null;
      const all = await reload();
      return Object.fromEntries(
        INSTALLATION_CONFIG_KEYS.map((key) => {
          const value = savedValue(all, key);
          const fallback = INSTALLATION_CONFIG[key].default;
          return [
            key,
            {
              value: value ?? fallback,
              default: fallback,
              saved: value !== undefined,
            },
          ];
        }),
      ) as InstallationConfig;
    },

    store: deps.store,
  };
}

export type InstallationConfigSource = ReturnType<
  typeof createInstallationConfigSource
>;

/** The owner's view of the installation settings, and saving them. */
export function createInstallationConfigAdmin(deps: {
  authorization: AuthorizationPolicy;
  source: InstallationConfigSource;
}) {
  return {
    async read(caller: Caller): Promise<InstallationConfig> {
      await requireSignInOwner(deps.authorization, caller);
      return deps.source.view();
    },

    async change(
      caller: Caller,
      body: UpdateInstallationConfigRequest,
    ): Promise<UpdateInstallationConfigResponse> {
      const audit = await requireSignInOwner(deps.authorization, caller);
      const values = Object.fromEntries(
        Object.entries(body).filter(([, value]) => value !== undefined),
      );
      const { changed } = await deps.source.store.setValues({ values, audit });
      return {
        ...(await deps.source.view()),
        ...(changed ? { receipt_id: audit.receiptId } : {}),
      };
    },
  };
}

export type InstallationConfigAdmin = ReturnType<
  typeof createInstallationConfigAdmin
>;
