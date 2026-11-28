import type {
  AuthorizationAction,
  CreateSettingsConnectionRequest,
  DiscoverConnectionModelsResponse,
  ListSettingsConnectionsResponse,
  SettingsChangeResponse,
  SettingsConnection,
  SettingsConnectionImpactResponse,
  SettingsCredentialView,
  SettingsEntryOrigin,
  SettingsEntryState,
} from "@werft-ai/contracts";
import {
  BILLING_NONE_ENDPOINT_MESSAGE,
  billingFitsEndpoint,
  type CatalogConnection,
  CatalogCredentialError,
  type CatalogProviderConfig,
  CONNECTION_ENDPOINT_DEFAULTS,
  type ConnectionNetwork,
  isRegisteredGitHubApp,
  MIN_CREDENTIAL_BYTES,
  type ModelFamilies,
  modelFamiliesSchema,
  resolveCredential,
} from "../catalog/index.ts";
import { rsaPrivateKey } from "../github/index.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SECRET_STORE_OFF,
  SessionServiceError,
} from "../musterrolle/index.ts";
import type { TeamActor } from "../musterrolle/ports/team-store.ts";
import type { OutboundHttp } from "../ports/outbound-http.ts";
import { listProviderModels, ModelDiscoveryError } from "./model-discovery.ts";
import type {
  SettingsConsoleResult,
  SettingsDocumentStore,
  SettingsRow,
} from "./ports/settings-document-store.ts";
import {
  type SettingsKind as DocumentSettingsKind,
  parseSettingsDocument,
  SettingsDocumentError,
  type SettingsEntries,
  type SettingsImportAdd,
} from "./settings-document.ts";

type Provider = CatalogProviderConfig;
type SettingsKind = Exclude<DocumentSettingsKind, "repository">;
type GitHubAppAuthView = Parameters<typeof isRegisteredGitHubApp>[0];

// Repositories are an owner's or an admin's, as the store's writers are;
// the console only replaces the key of one naming its own GitHub App.
const ACTION: Record<DocumentSettingsKind, AuthorizationAction> = {
  connection: "installation.settings.manage",
  repository: "workspace.manage",
};

/**
 * What a new connection's endpoint resolves to, every address judged: the
 * network the row is kept as, or why it may not be registered.
 * `address_not_allowed`: an address that is never reached (metadata,
 * loopback, link-local, the installation's own), or public and private
 * answers mixed. `unreachable`: the name did not resolve.
 */
export type EndpointNetwork =
  | { network: ConnectionNetwork }
  | {
      problem:
        | "address_not_allowed"
        | "unreachable"
        /** A private endpoint, and the installation's own hosts are not known. */
        | "installation_hosts_unavailable";
    };

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds the role this setting needs",
    undefined,
    { reason_code: "role" },
  );

function credentialOf(
  auth: unknown,
  last4: string | null,
): SettingsCredentialView {
  return auth !== null &&
    typeof auth === "object" &&
    typeof (auth as Record<string, unknown>).stored === "string"
    ? { source: "stored", last4 }
    : { source: "none" };
}

/**
 * A connection's value as the catalog will take it, refused before it is
 * sealed: a value the catalog refuses would leave the row out on every
 * read. Counted in characters too, so the last four the console shows never
 * give away half of it.
 */
function headerValue(kind: SettingsKind, id: string, value: string): string {
  const path = `connections.${id}.auth`;
  const ref = { stored: `${kind}:${id}` };
  try {
    resolveCredential(path, ref, () => value);
    if ([...value].length < MIN_CREDENTIAL_BYTES) {
      throw new CatalogCredentialError(
        path,
        ref,
        `is shorter than ${MIN_CREDENTIAL_BYTES} characters`,
      );
    }
  } catch (error) {
    if (!(error instanceof CatalogCredentialError)) throw error;
    throw new SessionServiceError("BAD_REQUEST", error.message, undefined, {
      reason_code: "invalid_entry",
    });
  }
  return value;
}

/**
 * The installation settings from the console: the owner makes connections
 * with a value they type, replaces that value or disables the row. Writes go through the settings
 * document store's own transaction and locks; no destination and no
 * operator reference is ever written here.
 */
export function createSettingsConsoleService(deps: {
  authorization: AuthorizationPolicy;
  store: SettingsDocumentStore;
  /** This replica's `<kind>:<id>` rows whose credential did not resolve. */
  leftOut: () => ReadonlyArray<{ entry: string }>;
  secretStoreOn: boolean;
  /**
   * The credential allowlists as `host:port`, read as the egress proxy
   * reads them; null when neither is given.
   */
  credentialHosts: readonly string[] | null;
  /** Reads the settings again after a write committed; never throws. */
  reread: () => Promise<void>;
  /**
   * Resolves a new connection's endpoint and judges it. Absent, nothing is
   * resolved and the row keeps no network: the proxy's lists then decide.
   */
  endpointNetwork?: (endpoint: string) => Promise<EndpointNetwork>;
  /** Asking a connection's provider which models it serves. */
  discovery: {
    /** The connection with its credential resolved on this replica. */
    connection: (id: string) => CatalogConnection | undefined;
    /**
     * Resolves once `connection` reads the settings as stored now, a key
     * just changed on another replica included.
     */
    caughtUp?: () => Promise<void>;
    /** Why the API may not send a key to this endpoint; null when it may. */
    urlProblem: (url: string) => string | null;
    http: OutboundHttp;
    /**
     * For a connection registered as private, in place of `urlProblem` and
     * `http`: held to private addresses and off the installation's own,
     * as the egress proxy holds its calls.
     */
    privateHttp?: OutboundHttp;
    /** Ids, outcomes and counts only. */
    log?: (fields: Record<string, unknown>) => void;
  };
}) {
  const { store } = deps;

  async function writer(
    caller: Caller,
    kind: DocumentSettingsKind,
  ): Promise<TeamActor> {
    await requirePermitted(deps.authorization, caller, ACTION[kind], {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person manages the installation settings",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  function stateOf(kind: SettingsKind, row: SettingsRow): SettingsEntryState {
    if (row.disabledAt !== null) return "disabled";
    const auth = (row.entry as { auth?: { stored?: unknown } }).auth;
    if (typeof auth?.stored === "string" && row.last4 === null) {
      return "needs_value";
    }
    const ref = `${kind}:${row.id}`;
    if (deps.leftOut().some((left) => left.entry === ref)) return "unresolved";
    return "active";
  }

  async function rowItems<T>(
    kind: SettingsKind,
    view: (
      id: string,
      entry: unknown,
      meta: {
        origin: SettingsEntryOrigin;
        state: SettingsEntryState;
        last4: string | null;
        created_at: string;
        disabled_at: string | null;
        models: readonly string[];
        model_families: ModelFamilies | null;
      },
    ) => T | null,
  ): Promise<T[]> {
    const rows = await store.listRows(kind);
    const items: Array<{ id: string; item: T }> = [];
    for (const row of rows) {
      const item = view(row.id, row.entry, {
        origin: row.origin,
        state: stateOf(kind, row),
        last4: row.last4,
        created_at: row.createdAt.toISOString(),
        disabled_at: row.disabledAt?.toISOString() ?? null,
        models: row.models ?? [],
        model_families: row.modelFamilies ?? null,
      });
      if (item !== null) items.push({ id: row.id, item });
    }
    return items
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ item }) => item);
  }

  function invalid(error: unknown): never {
    if (error instanceof SettingsDocumentError) {
      throw new SessionServiceError(
        "BAD_REQUEST",
        error.message.replace(/^The settings document is invalid: /, ""),
        undefined,
        { reason_code: "invalid_entry" },
      );
    }
    throw error;
  }

  function parsedConnection(
    id: string,
    entry: Record<string, unknown>,
  ): SettingsImportAdd {
    let entries: SettingsEntries;
    try {
      entries = parseSettingsDocument({
        version: 1,
        connections: { [id]: entry },
        repositories: {},
      });
    } catch (error) {
      invalid(error);
    }
    return {
      kind: "connection",
      id,
      entry: entries.connections[id] as Provider,
    };
  }

  async function settled(
    result: SettingsConsoleResult,
    id: string,
  ): Promise<SettingsChangeResponse> {
    switch (result.outcome) {
      case "done":
        await deps.reread();
        return { id, receipt_id: result.receiptId };
      case "actor_inactive":
        throw OUTRANKED();
      case "not_found":
        throw new SessionServiceError(
          "NOT_FOUND",
          `No settings row ${id} the console manages`,
        );
      case "conflict":
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          result.reason === "already_exists"
            ? `${id} is taken: an id is never reused, even after it is disabled`
            : result.reason === "not_stored"
              ? `${id} holds no credential of its own to set`
              : result.reason === "not_disabled"
                ? `${id} is not disabled`
                : result.reason === "definition_active"
                  ? `${id} cannot be enabled: another connection in use is, or was, exactly what it is`
                  : result.reason === "needs_value"
                    ? `${id} cannot be enabled: its stored value is gone, make a new connection instead`
                    : `${id} is disabled`,
          undefined,
          { reason_code: result.reason },
        );
    }
  }

  async function create(
    caller: Caller,
    kind: SettingsKind,
    add: () => SettingsImportAdd,
    value: string,
    // After the role and the entry are checked: nothing is resolved for a
    // caller who may not write, or for an entry that would be refused.
    registered?: (
      entry: SettingsImportAdd,
    ) => Promise<
      { network: ConnectionNetwork; acknowledgedPrivate: boolean } | undefined
    >,
  ): Promise<SettingsChangeResponse> {
    const actor = await writer(caller, kind);
    const entry = add();
    const checked = headerValue(kind, entry.id, value);
    if (!deps.secretStoreOn) throw SECRET_STORE_OFF();
    const as = await registered?.(entry);
    return settled(
      as === undefined
        ? await store.create(entry, checked, actor)
        : await store.create(entry, checked, actor, as),
      entry.id,
    );
  }

  const refused = (
    reason: string,
    message: string,
    code: "BAD_REQUEST" | "BACKEND_UNAVAILABLE" = "BAD_REQUEST",
  ) =>
    new SessionServiceError(code, message, undefined, { reason_code: reason });

  /**
   * The network a new connection is kept as, by what its endpoint resolves
   * to now. Private needs the caller's acknowledgement and is the only kind
   * that may be plain http or unbilled; the proxy holds the row to it on
   * every call after.
   */
  async function networkOf(
    id: string,
    provider: Provider,
    acknowledged: boolean,
  ): Promise<
    { network: ConnectionNetwork; acknowledgedPrivate: boolean } | undefined
  > {
    if (deps.endpointNetwork === undefined) return undefined;
    const judged = await deps.endpointNetwork(provider.endpoint);
    if ("problem" in judged) {
      if (judged.problem === "installation_hosts_unavailable") {
        throw refused(
          judged.problem,
          `connections.${id}.endpoint: this installation's own addresses could not be told just now; nothing was saved, try again`,
          "BACKEND_UNAVAILABLE",
        );
      }
      throw judged.problem === "unreachable"
        ? refused(
            "endpoint_unreachable",
            `connections.${id}.endpoint: the name did not resolve; nothing was saved`,
            "BACKEND_UNAVAILABLE",
          )
        : refused(
            "address_not_allowed",
            `connections.${id}.endpoint: resolves to an address a connection may never reach`,
          );
    }
    if (judged.network === "private") {
      if (!acknowledged) {
        throw refused(
          "private_address_unacknowledged",
          `connections.${id}.endpoint: is on the internal network. Werft sends this server each session's whole conversation and this connection's key; send acknowledge_private: true once you have checked it is a model server you run`,
        );
      }
      return { network: "private", acknowledgedPrivate: true };
    }
    if (new URL(provider.endpoint).protocol !== "https:") {
      throw refused(
        "url_insecure",
        `connections.${id}.endpoint: plain http is only for an endpoint on the internal network`,
      );
    }
    if (provider.billing === "none") {
      throw refused(
        "invalid_entry",
        `connections.${id}.billing: billing none needs an endpoint on the internal network`,
      );
    }
    return { network: "public", acknowledgedPrivate: false };
  }

  async function onRow(
    caller: Caller,
    kind: DocumentSettingsKind,
    id: string,
    write: (actor: TeamActor) => Promise<SettingsConsoleResult>,
  ): Promise<SettingsChangeResponse> {
    const actor = await writer(caller, kind);
    return settled(await write(actor), id);
  }

  return {
    async listConnections(
      caller: Caller,
    ): Promise<ListSettingsConnectionsResponse> {
      await writer(caller, "connection");
      const items = await rowItems<SettingsConnection>(
        "connection",
        (id, entry, meta) => {
          const provider = entry as Provider;
          return {
            id,
            origin: meta.origin,
            state: meta.state,
            kind: provider.kind,
            endpoint: provider.endpoint,
            billing: provider.billing === "none" ? "none" : "per_token",
            auth_kind: provider.auth.kind,
            models: [...meta.models],
            model_families: meta.model_families,
            credential: credentialOf(provider.auth, meta.last4),
            created_at: meta.created_at,
            disabled_at: meta.disabled_at,
          };
        },
      );
      return {
        items,
        credential_hosts:
          deps.credentialHosts === null ? null : [...deps.credentialHosts],
        endpoint_defaults: { ...CONNECTION_ENDPOINT_DEFAULTS },
      };
    },

    async connectionImpact(
      caller: Caller,
      id: string,
    ): Promise<SettingsConnectionImpactResponse> {
      await writer(caller, "connection");
      const rows = await store.listRows("connection");
      if (!rows.some((row) => row.id === id)) {
        throw new SessionServiceError(
          "NOT_FOUND",
          `No settings row ${id} the console manages`,
        );
      }
      const use = await store.connectionUse({ connectionId: id });
      return {
        id,
        agent_count: use.agents,
        session_count: use.sessions,
        judge_used: use.judgeNamed,
      };
    },

    /**
     * Asks the connection's provider which models it serves, with the
     * connection's own key, and marks the saved ones. Writes nothing; only
     * the API's credential allowlist may be called, closed when it is unset.
     */
    async discoverConnectionModels(
      caller: Caller,
      id: string,
    ): Promise<DiscoverConnectionModelsResponse> {
      await writer(caller, "connection");
      const row = (await store.listRows("connection")).find(
        (listed) => listed.id === id,
      );
      if (row === undefined) {
        throw new SessionServiceError(
          "NOT_FOUND",
          `No settings row ${id} the console manages`,
        );
      }
      const conflict = (reason: string, message: string) =>
        new SessionServiceError("REVISION_CONFLICT", message, undefined, {
          reason_code: reason,
        });
      if ((row.entry as Provider).kind === "openai_decisions") {
        throw conflict(
          "kind_unsupported",
          `${id} is the achievement judge's: no agent runs on its models`,
        );
      }
      const state = stateOf("connection", row);
      if (state === "disabled") throw conflict("disabled", `${id} is disabled`);
      if (state === "needs_value") {
        throw conflict("needs_value", `${id} has no stored value yet`);
      }
      await deps.discovery.caughtUp?.();
      // A row made a moment ago may be on another replica's read only.
      let connection = deps.discovery.connection(id);
      if (connection === undefined) {
        await deps.reread();
        connection = deps.discovery.connection(id);
      }
      if (connection === undefined) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          `${id}'s credential is not resolved on this server yet; try again`,
          undefined,
          { reason_code: "credential_unresolved" },
        );
      }
      const privateHttp =
        connection.network === "private"
          ? deps.discovery.privateHttp
          : undefined;
      const problem =
        privateHttp === undefined
          ? deps.discovery.urlProblem(connection.provider.endpoint)
          : null;
      if (problem !== null) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "This installation does not allow the connection's key to be sent to its endpoint",
          undefined,
          { reason_code: problem },
        );
      }
      let listed: Awaited<ReturnType<typeof listProviderModels>>;
      try {
        listed = await listProviderModels(
          connection.provider,
          privateHttp ?? deps.discovery.http,
        );
      } catch (error) {
        if (!(error instanceof ModelDiscoveryError)) throw error;
        deps.discovery.log?.({
          connection_id: id,
          outcome: error.reason,
          provider_status: error.status,
        });
        const retryable =
          error.reason === "provider_unreachable" ||
          error.reason === "provider_failed";
        throw new SessionServiceError(
          retryable ? "BACKEND_UNAVAILABLE" : "BAD_REQUEST",
          error.message,
          undefined,
          {
            reason_code: error.reason,
            ...(error.status === null ? {} : { provider_status: error.status }),
          },
        );
      }
      const saved = row.models ?? [];
      const listedIds = new Set(listed.models.map((model) => model.id));
      const missing = saved.filter((model) => !listedIds.has(model));
      deps.discovery.log?.({
        connection_id: id,
        outcome: "listed",
        models: listed.models.length,
        skipped: listed.skipped,
        missing: missing.length,
        truncated: listed.truncated,
      });
      return {
        models: listed.models.map((model) => ({
          ...model,
          selected: saved.includes(model.id),
        })),
        missing,
        skipped: listed.skipped,
        truncated: listed.truncated,
      };
    },

    createConnection(caller: Caller, request: CreateSettingsConnectionRequest) {
      return create(
        caller,
        "connection",
        () => {
          const add = parsedConnection(request.id, {
            kind: request.kind,
            ...(request.endpoint === undefined
              ? {}
              : { endpoint: request.endpoint }),
            auth: { kind: request.auth_kind, stored: true },
            ...(request.billing === undefined
              ? {}
              : { billing: request.billing }),
          });
          // A default is public, the ceiling refuses it with billing none,
          // and the endpoint never changes: the row would stay unusable. A
          // named endpoint is the caller's and keeps today's rule.
          if (
            (request.endpoint ?? "").trim() === "" &&
            !billingFitsEndpoint(add.entry as Provider)
          ) {
            throw new SessionServiceError(
              "BAD_REQUEST",
              `connections.${request.id}.billing: ${BILLING_NONE_ENDPOINT_MESSAGE}`,
              undefined,
              { reason_code: "invalid_entry" },
            );
          }
          return add;
        },
        request.value,
        (add) =>
          networkOf(
            request.id,
            add.entry as Provider,
            request.acknowledge_private === true,
          ),
      );
    },

    /**
     * Replaces the value of a row that keeps its own. Of the repositories
     * only one naming its own GitHub App, whose value is the App's private
     * key, refused unless it is one; its id and App stay as they are. URL
     * repositories stay out of the console.
     */
    setCredential(
      caller: Caller,
      kind: DocumentSettingsKind,
      id: string,
      value: string,
    ) {
      if (!deps.secretStoreOn) {
        return writer(caller, kind).then(() => {
          throw SECRET_STORE_OFF();
        });
      }
      return onRow(caller, kind, id, async (actor) => {
        if (kind !== "repository") {
          return store.setValue(
            { kind, id },
            headerValue(kind, id, value),
            actor,
          );
        }
        const row = (await store.listRows("repository")).find(
          (listed) => listed.id === id,
        );
        const auth = (row?.entry as { auth?: GitHubAppAuthView } | undefined)
          ?.auth;
        if (auth?.kind !== "github_app" || isRegisteredGitHubApp(auth)) {
          return { outcome: "not_found" as const };
        }
        return store.setValue({ kind, id }, rsaPrivateKey(value), actor);
      });
    },

    setConnectionModels(
      caller: Caller,
      id: string,
      request: { models: string[]; model_families?: unknown },
    ) {
      const models = [...new Set(request.models)];
      if (models.length !== request.models.length) {
        return Promise.reject(
          new SessionServiceError(
            "BAD_REQUEST",
            "models: must not repeat a model",
            undefined,
            { reason_code: "invalid_entry" },
          ),
        );
      }
      // Left out keeps the stored series; an explicit null clears them.
      const families =
        request.model_families === undefined || request.model_families === null
          ? null
          : modelFamiliesSchema.safeParse(request.model_families);
      if (families !== null && !families.success) {
        return Promise.reject(
          new SessionServiceError(
            "BAD_REQUEST",
            `model_families: ${families.error.issues.map((issue) => issue.message).join("; ")}`,
            undefined,
            { reason_code: "invalid_entry" },
          ),
        );
      }
      return onRow(caller, "connection", id, (actor) =>
        store.setConnectionModels(
          id,
          {
            models,
            ...(request.model_families === undefined
              ? {}
              : { model_families: families === null ? null : families.data }),
          },
          actor,
        ),
      );
    },

    disable(caller: Caller, kind: SettingsKind, id: string) {
      return onRow(caller, kind, id, (actor) =>
        store.disable({ kind, id }, actor),
      );
    },

    enableConnection(caller: Caller, id: string) {
      return onRow(caller, "connection", id, (actor) =>
        store.enableConnection(id, actor),
      );
    },
  };
}

export type SettingsConsoleService = ReturnType<
  typeof createSettingsConsoleService
>;
