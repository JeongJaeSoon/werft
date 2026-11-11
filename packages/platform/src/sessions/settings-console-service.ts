import type {
  AuthorizationAction,
  CreateSettingsConnectionRequest,
  CreateSettingsMcpServerRequest,
  ListSettingsConnectionsResponse,
  ListSettingsMcpServersResponse,
  SettingsChangeResponse,
  SettingsConnection,
  SettingsConnectionImpactResponse,
  SettingsCredentialView,
  SettingsEntryOrigin,
  SettingsEntryState,
  SettingsMcpServer,
} from "@werft-ai/contracts";
import { requirePermitted, SessionServiceError } from "../musterrolle/index.ts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type {
  SettingsConsoleResult,
  SettingsDocumentStore,
  SettingsRow,
} from "../ports/settings-document-store.ts";
import type { TeamActor } from "../ports/team-store.ts";
import {
  BILLING_NONE_ENDPOINT_MESSAGE,
  billingFitsEndpoint,
  type CatalogMcpServerConfig,
  type CatalogProviderConfig,
  CONNECTION_ENDPOINT_DEFAULTS,
  type ModelFamilies,
  modelFamiliesSchema,
} from "./catalog.ts";
import {
  type SettingsKind as DocumentSettingsKind,
  parseSettingsDocument,
  SettingsDocumentError,
  type SettingsEntries,
  type SettingsImportAdd,
} from "./settings-document.ts";

type Provider = CatalogProviderConfig;
type SettingsKind = Exclude<DocumentSettingsKind, "repository">;

const ACTION: Record<SettingsKind, AuthorizationAction> = {
  connection: "installation.settings.manage",
  mcp: "installation.settings.manage",
};

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds the role this setting needs",
    undefined,
    { reason_code: "role" },
  );

const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
    undefined,
    { reason_code: "secret_store_off" },
  );

function credentialOf(
  auth: unknown,
  last4: string | null,
): SettingsCredentialView {
  if (auth === null || typeof auth !== "object") return { source: "none" };
  const ref = auth as Record<string, unknown>;
  if (typeof ref.stored === "string") return { source: "stored", last4 };
  return {
    source: "external",
    ...(typeof ref.value_env === "string" ? { value_env: ref.value_env } : {}),
    ...(typeof ref.secret_id === "string" ? { secret_id: ref.secret_id } : {}),
  };
}

/**
 * The installation settings from the console (settings-replace-file-catalog.md
 * §2-§4): the owner makes connections and MCP servers with a value they
 * type, replaces that value or disables the row. Writes go through the settings
 * document store's own transaction and locks; no destination and no
 * operator reference is ever written here.
 */
export function createSettingsConsoleService(deps: {
  authorization: AuthorizationPolicy;
  store: SettingsDocumentStore;
  /** This replica's `<kind>:<id>` rows whose credential did not resolve. */
  leftOut: () => ReadonlyArray<{ entry: string }>;
  secretStoreOn: boolean;
  /** EGRESS_CREDENTIAL_ALLOWLIST as `host:port`, or null when not given. */
  credentialHosts: readonly string[] | null;
  /** Reads the settings again after a write committed; never throws. */
  reread: () => Promise<void>;
}) {
  const { store } = deps;

  async function writer(
    caller: Caller,
    kind: SettingsKind,
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
        auto_mode: "supported" | "unsupported" | "unknown";
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
        auto_mode: row.autoMode ?? "unknown",
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

  function parsed(
    section: "connections" | "mcp_servers",
    id: string,
    entry: Record<string, unknown>,
  ): SettingsImportAdd {
    let entries: SettingsEntries;
    try {
      entries = parseSettingsDocument({
        version: 1,
        connections: {},
        repositories: {},
        mcp_servers: {},
        [section]: { [id]: entry },
      });
    } catch (error) {
      invalid(error);
    }
    if (section === "connections") {
      return {
        kind: "connection",
        id,
        entry: entries.connections[id] as Provider,
      };
    }
    return {
      kind: "mcp",
      id,
      entry: entries.mcp_servers[id] as CatalogMcpServerConfig,
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
              ? `${id} takes its credential from the operator's deployment; the console only shows and disables it`
              : result.reason === "not_external"
                ? `${id} already keeps its own value: replace the value instead`
                : result.reason === "alias_taken"
                  ? `${id} cannot move to a stored value: another connection is, or was, exactly what it is now`
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
    value: string | null,
  ): Promise<SettingsChangeResponse> {
    const actor = await writer(caller, kind);
    const entry = add();
    if (value !== null && !deps.secretStoreOn) throw STORE_OFF();
    return settled(await store.create(entry, value, actor), entry.id);
  }

  async function onRow(
    caller: Caller,
    kind: SettingsKind,
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
            auto_mode: meta.auto_mode,
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

    async listMcpServers(
      caller: Caller,
    ): Promise<ListSettingsMcpServersResponse> {
      await writer(caller, "mcp");
      const items = await rowItems<SettingsMcpServer>(
        "mcp",
        (id, entry, meta) => {
          const server = entry as CatalogMcpServerConfig;
          return {
            id,
            origin: meta.origin,
            state: meta.state,
            url: server.url,
            credential_ref: server.credential_ref,
            workspaces: [...server.workspaces],
            credential: credentialOf(server.auth, meta.last4),
            created_at: meta.created_at,
            disabled_at: meta.disabled_at,
          };
        },
      );
      return { items };
    },

    createConnection(caller: Caller, request: CreateSettingsConnectionRequest) {
      return create(
        caller,
        "connection",
        () => {
          const add = parsed("connections", request.id, {
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
      );
    },

    createMcpServer(caller: Caller, request: CreateSettingsMcpServerRequest) {
      return create(
        caller,
        "mcp",
        () =>
          parsed("mcp_servers", request.id, {
            url: request.url,
            credential_ref: request.credential_ref,
            auth: { kind: "bearer", stored: true },
            workspaces: request.workspaces,
          }),
        request.value,
      );
    },

    setCredential(
      caller: Caller,
      kind: SettingsKind,
      id: string,
      value: string,
    ) {
      if (!deps.secretStoreOn) {
        return writer(caller, kind).then(() => {
          throw STORE_OFF();
        });
      }
      return onRow(caller, kind, id, (actor) =>
        store.setValue({ kind, id }, value, actor),
      );
    },

    convertConnection(caller: Caller, id: string, value: string) {
      if (!deps.secretStoreOn) {
        return writer(caller, "connection").then(() => {
          throw STORE_OFF();
        });
      }
      return onRow(caller, "connection", id, (actor) =>
        store.convertConnection(id, value, actor),
      );
    },

    setConnectionAutoMode(
      caller: Caller,
      id: string,
      autoMode: "supported" | "unsupported" | "unknown",
    ) {
      return onRow(caller, "connection", id, (actor) =>
        store.setConnectionAutoMode(id, autoMode, actor),
      );
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

    setMcpWorkspaces(caller: Caller, id: string, workspaces: string[]) {
      // The catalog's rule for the field (catalogMcpServerSchema).
      if (new Set(workspaces).size !== workspaces.length) {
        return Promise.reject(
          new SessionServiceError(
            "BAD_REQUEST",
            "workspaces: must not repeat a workspace",
            undefined,
            { reason_code: "invalid_entry" },
          ),
        );
      }
      return onRow(caller, "mcp", id, (actor) =>
        store.setMcpWorkspaces(id, workspaces, actor),
      );
    },
  };
}

export type SettingsConsoleService = ReturnType<
  typeof createSettingsConsoleService
>;
