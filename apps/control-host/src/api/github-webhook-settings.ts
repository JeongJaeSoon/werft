import type {
  GitHubWebhookSettings,
  GitHubWebhookUpdate,
  GitHubWebhookUpdateFailure,
  RetryGitHubWebhookUpdatesRequest,
  RetryGitHubWebhookUpdatesResponse,
  UpdateGitHubWebhookSettingsRequest,
  UpdateGitHubWebhookSettingsResponse,
} from "@werft-ai/contracts";
import type {
  GitHubWebhookApp,
  GitHubWebhookSettingsStore,
} from "@werft-ai/db";
import {
  type AuthorizationPolicy,
  type Caller,
  SessionServiceError,
} from "@werft-ai/platform";
import { requireSignInOwner } from "./provider-admin.ts";
import { GITHUB_WEBHOOK_PATH } from "./routes/github/github-webhook.ts";
import { parseEventsPublicUrl } from "./slack-config.ts";

/** A save keeps chasing the saved address at most this many PATCHes per App. */
const CONVERGE_ROUNDS = 3;

/** The URL an App's webhook is set to, for a saved base. */
export const githubWebhookUrlOf = (base: string): string =>
  `${base}${GITHUB_WEBHOOK_PATH}`;

/**
 * The webhook URL, read on every use so a saved address reaches every
 * replica at once; null while none is saved.
 */
export function githubWebhookUrlFrom(
  store: Pick<GitHubWebhookSettingsStore, "read">,
): () => Promise<string | null> {
  return async () => {
    const base = (await store.read())?.publicUrl ?? null;
    return base === null ? null : githubWebhookUrlOf(base);
  };
}

type Warn = (message: string, fields?: Record<string, unknown>) => void;

/**
 * The owner's GitHub webhook entrance for the whole installation. A saved
 * address commits first; then each App whose webhook points here is set to
 * it on GitHub with its own JWT, and what GitHub said comes back per App.
 * Nothing of that is kept: a failed App is retried from the answer.
 */
export function createGitHubWebhookSettingsAdmin(deps: {
  authorization: AuthorizationPolicy;
  store: GitHubWebhookSettingsStore;
  /** Every App a save sets; empty on a server without a secret store. */
  apps: () => Promise<GitHubWebhookApp[]>;
  setHook: (
    app: { appId: number; apiBase: string; privateKey: string },
    url: string,
  ) => Promise<"updated" | GitHubWebhookUpdateFailure>;
  warn: Warn;
}) {
  const view = async (
    caller: Caller,
    saved: string | null,
    apps: GitHubWebhookApp[],
  ): Promise<GitHubWebhookSettings> => ({
    webhook_public_url: saved,
    webhook_url: saved === null ? null : githubWebhookUrlOf(saved),
    apps: apps.map((app) => ({
      app_id: app.appId,
      name: app.name,
      other_workspaces: app.workspaceIds.filter((id) => id !== caller.ownerId)
        .length,
    })),
  });

  const update = async (
    app: GitHubWebhookApp,
    url: string,
  ): Promise<GitHubWebhookUpdate> => {
    const outcome =
      app.privateKey === null
        ? "key_unreadable"
        : await deps.setHook(
            {
              appId: app.appId,
              apiBase: app.apiBase,
              privateKey: app.privateKey,
            },
            url,
          );
    if (outcome === "updated") {
      return { app_id: app.appId, name: app.name, outcome };
    }
    deps.warn("A GitHub App's webhook URL was not updated", {
      app_id: app.appId,
      reason_code: outcome,
    });
    return {
      app_id: app.appId,
      name: app.name,
      outcome: "failed",
      reason_code: outcome,
    };
  };

  // Saves are serialized, their PATCHes are not: a slower PATCH of an earlier
  // save can land after a later one. After each PATCH the saved address is
  // read again, and an App left on another one is set to what is saved.
  const converge = async (
    app: GitHubWebhookApp,
    first: string,
  ): Promise<GitHubWebhookUpdate> => {
    let base = first;
    for (let round = 1; ; round++) {
      const result = await update(app, githubWebhookUrlOf(base));
      if (result.outcome !== "updated" || round === CONVERGE_ROUNDS) {
        return result;
      }
      const now = (await deps.store.read())?.publicUrl ?? null;
      if (now === null || now === base) return result;
      base = now;
    }
  };

  return {
    async read(caller: Caller): Promise<GitHubWebhookSettings> {
      await requireSignInOwner(deps.authorization, caller);
      return view(
        caller,
        (await deps.store.read())?.publicUrl ?? null,
        await deps.apps(),
      );
    },

    async change(
      caller: Caller,
      body: UpdateGitHubWebhookSettingsRequest,
    ): Promise<UpdateGitHubWebhookSettingsResponse> {
      const audit = await requireSignInOwner(deps.authorization, caller);
      const raw = body.webhook_public_url?.trim() || null;
      const value = raw === null ? null : parseEventsPublicUrl(raw);
      if (raw !== null && value === null) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The webhook address must be an https URL without a query, fragment or credentials",
          undefined,
          { reason_code: "webhook_url_invalid" },
        );
      }
      const { changed } = await deps.store.setPublicUrl({ value, audit });
      const apps = await deps.apps();
      // Clearing sends nothing: GitHub's hook config cannot turn a webhook off.
      const updates =
        changed && value !== null
          ? await Promise.all(apps.map((app) => converge(app, value)))
          : [];
      return {
        ...(await view(caller, value, apps)),
        ...(changed ? { receipt_id: audit.receiptId } : {}),
        updates,
      };
    },

    async retry(
      caller: Caller,
      body: RetryGitHubWebhookUpdatesRequest,
    ): Promise<RetryGitHubWebhookUpdatesResponse> {
      await requireSignInOwner(deps.authorization, caller);
      const saved = (await deps.store.read())?.publicUrl ?? null;
      if (saved === null) {
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          "No webhook address is saved: save one before retrying",
          undefined,
          { reason_code: "webhook_url_unset" },
        );
      }
      const apps = await deps.apps();
      const updates = await Promise.all(
        [...new Set(body.app_ids)].flatMap((appId) => {
          const matching = apps.filter((app) => app.appId === appId);
          return matching.length === 0
            ? [
                Promise.resolve<GitHubWebhookUpdate>({
                  app_id: appId,
                  name: null,
                  outcome: "failed",
                  reason_code: "not_found",
                }),
              ]
            : matching.map((app) => converge(app, saved));
        }),
      );
      return { updates };
    },
  };
}

export type GitHubWebhookSettingsAdmin = ReturnType<
  typeof createGitHubWebhookSettingsAdmin
>;

/**
 * GITHUB_WEBHOOK_BASE_URL is no longer read. The first start that finds it
 * and no saved settings carries a valid value in, once, and sets no App:
 * they were made with that address. The warnings never carry the value.
 */
export async function importGitHubWebhookBaseUrl(
  env: Record<string, string | undefined>,
  store: GitHubWebhookSettingsStore,
): Promise<string[]> {
  const raw = env.GITHUB_WEBHOOK_BASE_URL;
  if (!raw) return [];
  if ((await store.read()) !== null) {
    return ["Ignored removed settings: GITHUB_WEBHOOK_BASE_URL"];
  }
  const value = parseEventsPublicUrl(raw.trim());
  if (value === null) {
    return [
      "GITHUB_WEBHOOK_BASE_URL was not carried in: it is not an https URL without a query. Set the webhook address in Settings > Integrations > GitHub, then remove it",
    ];
  }
  return (await store.importPublicUrl(value))
    ? [
        "GITHUB_WEBHOOK_BASE_URL was carried into Settings > Integrations > GitHub and is no longer read; remove it",
      ]
    : ["Ignored removed settings: GITHUB_WEBHOOK_BASE_URL"];
}

const WEBHOOK_UNSET =
  "GitHub skills sync without push webhooks (no webhook address saved in Settings > Integrations > GitHub)";

/**
 * The store every reader uses: a read first finishes the carry-over, so no
 * request reads the address while one is still due. The start does not wait
 * for the database; it tries at once and again on a timer.
 */
export function carryOverGitHubWebhookSettings(deps: {
  env: Record<string, string | undefined>;
  store: GitHubWebhookSettingsStore;
  warn: Warn;
  info: Warn;
  retryMs: number;
}): { store: GitHubWebhookSettingsStore; started: Promise<void> } {
  let carried: Promise<void> | null = null;
  const carry = () => {
    carried ??= importGitHubWebhookBaseUrl(deps.env, deps.store).then(
      (warnings) => {
        for (const warning of warnings) deps.warn(warning);
      },
      (error: unknown) => {
        carried = null;
        throw error;
      },
    );
    return carried;
  };
  const store: GitHubWebhookSettingsStore = {
    ...deps.store,
    read: async () => {
      await carry();
      return deps.store.read();
    },
  };
  const attempt = (): Promise<void> =>
    store.read().then(
      (row) => {
        if ((row?.publicUrl ?? null) === null) deps.info(WEBHOOK_UNSET);
      },
      (error: unknown) => {
        deps.warn("GitHub webhook settings could not be read; retrying", {
          error_name: error instanceof Error ? error.name : typeof error,
        });
        setTimeout(() => {
          void attempt();
        }, deps.retryMs).unref();
      },
    );
  return { store, started: attempt() };
}
