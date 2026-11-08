import {
  type CreateInstallationProfileRequest,
  type InstallationProfileOptionsResponse,
  OPT_IN_PERMISSION_MODES,
  PERMISSION_MODE_VALUES,
  type ProfileSummary,
  type RetryProfileRolloutResponse,
  RUNTIME_KIND_VALUES,
  type RuntimeKind,
  runtimeKindSchema,
  type WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { NOT_FOUND } from "../musterrolle/service-errors.ts";
import type {
  InstallationProfileRecord,
  InstallationProfileStore,
} from "../ports/installation-profile-store.ts";
import type { ProfileRolloutStore } from "../ports/profile-rollout-store.ts";
import type { TeamActor } from "../ports/team-store.ts";
import {
  type CatalogProfileConfig,
  catalogProfileConfigSchema,
  derivationPolicyOf,
  describeConfigError,
  type SessionCatalogView,
  type WorkspaceProfiles,
} from "./catalog.ts";
import type { ProfileFeatureGate } from "./feature-gate.ts";
import { type Connections, definitionFingerprint } from "./profile-registry.ts";
import {
  deniedTools,
  mcpDenyScope,
  previousChoice,
  type ToolCatalogs,
  withKeptMcpDeny,
} from "./profile-tools.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";
import { operatorSummary } from "./workspace-profiles.ts";

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds profile.installation.manage",
    undefined,
    { reason_code: "role" },
  );

/**
 * One entry per spelling a profile's runtime version may take, the SDK's
 * and the engine build's, so the console finds a profile's catalog by it.
 */
function optionCatalogs(
  catalogs: ToolCatalogs,
): NonNullable<InstallationProfileOptionsResponse["tool_catalogs"]> {
  return catalogs.all.flatMap((catalog) => {
    const runtimeKind = runtimeKindSchema.safeParse(catalog.runtimeKind);
    if (!runtimeKind.success) return [];
    return [...new Set([catalog.sdkVersion, catalog.engineVersion])].map(
      (runtimeVersion) => ({
        id: catalog.id,
        runtime_kind: runtimeKind.data,
        runtime_version: runtimeVersion,
        tools: catalog.tools.map((tool) => ({
          name: tool.name,
          boundary: tool.boundary,
        })),
      }),
    );
  });
}

const badRequest = (message: string, reason_code: string, field?: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code,
    ...(field === undefined ? {} : { field }),
  });

/**
 * Installation ceilings made and retired in the console
 * (docs/contributing/decisions/profile-db.md §6). Only the operator, a
 * signed-in owner, writes one; what a ceiling may name (a connection, an
 * installed runtime, a repository, the unattended switch) stays the
 * installation's.
 */
export function createInstallationProfileService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<InstallationProfileStore, "create" | "retire" | "setBlocked">;
  rollouts: Pick<ProfileRolloutStore, "retryFailed">;
  catalog: SessionCatalogView & { workspace_profiles: WorkspaceProfiles };
  connections: () => Connections;
  allowUnattended: boolean;
  runtimes: ProfileFeatureGate;
  newId?: () => string;
}) {
  const { authorization, store, catalog, runtimes } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function operator(caller: Caller): Promise<TeamActor> {
    await requirePermitted(
      authorization,
      caller,
      "profile.installation.manage",
      {
        kind: "workspace",
        id: caller.ownerId,
      },
    );
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person changes an installation profile",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  /**
   * Who may define a profile (`profile.define`: owner and admin), and
   * whether this one is the owner, who alone sets the runtime, connection
   * and billing.
   */
  async function definer(
    caller: Caller,
  ): Promise<{ actor: TeamActor; owner: boolean }> {
    await requirePermitted(authorization, caller, "profile.define", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person defines a profile",
        undefined,
        { reason_code: "role" },
      );
    }
    const decision = await authorization
      .authorize(
        {
          subject: caller.subject,
          action: "profile.installation.manage",
          resource: {
            kind: "workspace",
            id: caller.ownerId,
            owner_scope: caller.ownerId,
          },
          request_id: caller.requestId,
        },
        { record: false },
      )
      .catch(() => null);
    return {
      actor: { principal: caller, workspaceId, userId },
      owner: decision?.outcome === "allow",
    };
  }

  // After a write has committed, a failed read must not report it failed.
  async function reread(): Promise<void> {
    await catalog.workspace_profiles.refresh().catch(() => undefined);
  }

  function changed(
    record: InstallationProfileRecord,
    receiptId: string | null,
    connectionId: string | null = null,
  ): WorkspaceProfileChangeResponse {
    const profile: ProfileSummary | undefined = operatorSummary(
      catalog,
      record.id,
      { record, connectionId },
    );
    if (!profile) {
      throw new Error(`installation profile ${record.id} did not list`);
    }
    return { profile, receipt_id: receiptId };
  }

  function modesOf(kind: CatalogProfileConfig["runtime_kind"]) {
    return PERMISSION_MODE_VALUES.filter(
      (mode) => runtimes.refusal(kind, { permission_mode: mode }) === null,
    );
  }

  /**
   * The version `previous_id` names, read now when this replica has not
   * yet: a deny is weighed against it, so an unread one refuses the save.
   */
  async function previousOf(
    previousId: string,
  ): Promise<InstallationProfileRecord> {
    if (!catalog.installation?.get(previousId)?.record) {
      await catalog.workspace_profiles.refresh();
    }
    const record = catalog.installation?.get(previousId)?.record;
    if (!record) {
      throw badRequest(
        `Unknown profile ${previousId}`,
        "unknown_previous",
        "previous_id",
      );
    }
    return record;
  }

  async function toolsOf(
    request: CreateInstallationProfileRequest,
    runtime: { kind: RuntimeKind; version: string },
    base?: {
      readonly tools: readonly string[];
      readonly sameCatalog: boolean;
      readonly mcpDeny?: readonly string[] | undefined;
    },
  ) {
    const toolCatalog = catalog.tool_catalogs?.for(
      runtime.kind,
      runtime.version,
    );
    if (request.deny === undefined) {
      const tools = [...new Set(request.tools ?? [])];
      // An allow list is not a deny, but a version still keeps the `mcp__`
      // blocks of the one it follows. Read from memory: a missing previous
      // is refused where the save is stored.
      const kept = withKeptMcpDeny({
        catalog: toolCatalog,
        tools,
        denied: undefined,
        previous:
          request.previous_id === undefined
            ? undefined
            : catalog.installation?.get(request.previous_id)?.record,
        baseMcpDeny: base?.mcpDeny,
        unblock: request.unblock_mcp_tools,
      });
      return {
        tools,
        denied: kept && { ...kept, previousDrift: false },
      };
    }
    const previous =
      request.previous_id === undefined
        ? undefined
        : await previousOf(request.previous_id);
    const previousRead =
      previous &&
      previousChoice(
        catalog.tool_catalogs,
        previous,
        catalogProfileConfigSchema.safeParse(previous.definition).data?.tools ??
          [],
      );
    const asked = deniedTools({
      catalog: toolCatalog,
      deny: request.deny,
      accept: request.accept_added_tools,
      // An admin's profile may not open what its source blocks, under the
      // names the runtime knows them by (`Task` is `Agent`).
      ...(base === undefined ? {} : { base }),
      previous: previousRead,
      mcp: mcpDenyScope(catalog.mcp_servers, base?.mcpDeny, previous?.deny),
    });
    const denied =
      withKeptMcpDeny({
        catalog: toolCatalog,
        tools: asked.tools,
        denied: asked,
        previous,
        baseMcpDeny: base?.mcpDeny,
        requested: asked.mcpDeny,
        unblock: request.unblock_mcp_tools,
      }) ?? asked;
    return {
      tools: asked.tools,
      denied: { ...denied, previousDrift: previousRead?.drift === true },
    };
  }

  /** What an owner names, or an admin's source version already holds. */
  type Fixed = {
    runtime_kind: RuntimeKind;
    runtime_version: string;
    provider: CatalogProfileConfig["provider"];
    title_model?: string | undefined;
    project_settings?: CatalogProfileConfig["project_settings"] | undefined;
  };

  /** The owner's runtime and connection, from the request. */
  function ownerFixed(request: CreateInstallationProfileRequest): {
    fixed: Fixed;
    connectionId: string;
  } {
    for (const field of [
      "connection_id",
      "runtime_kind",
      "runtime_version",
    ] as const) {
      if (request[field] === undefined) {
        throw badRequest(`${field} is required`, "missing_field", field);
      }
    }
    if (request.derived_from !== undefined) {
      throw badRequest(
        "Only an admin's profile names the one it narrows",
        "not_allowed",
        "derived_from",
      );
    }
    const connections = deps.connections();
    const connectionId = request.connection_id as string;
    if (!Object.hasOwn(connections, connectionId)) {
      throw badRequest(
        `Unknown connection ${connectionId}`,
        "unknown_connection",
        "connection_id",
      );
    }
    return {
      connectionId,
      fixed: {
        runtime_kind: request.runtime_kind as RuntimeKind,
        runtime_version: request.runtime_version as string,
        provider: connections[connectionId] as Fixed["provider"],
        title_model: request.title_model,
        project_settings: request.project_settings,
      },
    };
  }

  function definitionOf(
    request: CreateInstallationProfileRequest,
    fixed: Fixed,
    tools: readonly string[],
  ): CatalogProfileConfig {
    if (!request.models.includes(request.model)) {
      throw badRequest(
        "model must be one of models",
        "model_not_in_models",
        "model",
      );
    }
    // No `repository` key: a profile names no repository.
    const parsed = catalogProfileConfigSchema.safeParse({
      runtime_kind: fixed.runtime_kind,
      runtime_version: fixed.runtime_version,
      model: request.model,
      models: [...new Set(request.models)],
      ...(fixed.title_model === undefined
        ? {}
        : { title_model: fixed.title_model }),
      tools: [...tools],
      permission_mode: request.permission_mode,
      provider: fixed.provider,
      ...(fixed.project_settings === undefined
        ? {}
        : { project_settings: fixed.project_settings }),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(
        `The profile is invalid: ${describeConfigError(parsed.error)}`,
        "invalid_profile",
        issue?.path.join(".") ?? "",
      );
    }
    return parsed.data;
  }

  /**
   * An admin's profile narrows a version it may see: the previous version's
   * source, or `derived_from` for a first one. Runtime, connection, billing
   * and title model are the source's, never the request's.
   */
  async function adminSource(
    request: CreateInstallationProfileRequest,
    workspaceId: string,
  ) {
    for (const field of [
      "connection_id",
      "runtime_kind",
      "runtime_version",
      "title_model",
      "project_settings",
    ] as const) {
      if (request[field] !== undefined) {
        throw badRequest(
          `${field} is the source profile's: only the owner sets it`,
          "source_field",
          field,
        );
      }
    }
    let sourceId = request.derived_from;
    if (request.previous_id !== undefined) {
      const previous = await previousOf(request.previous_id);
      if (previous.workspace_id !== workspaceId || !previous.derived_from) {
        throw badRequest(
          `Unknown profile ${request.previous_id}`,
          "unknown_previous",
          "previous_id",
        );
      }
      sourceId = previous.derived_from;
    }
    if (sourceId === undefined) {
      throw badRequest(
        "A new profile names the one it narrows",
        "missing_field",
        "derived_from",
      );
    }
    // Read again: a source retired on another replica must not pass here,
    // and a version made a moment ago may not be read yet.
    await catalog.workspace_profiles.refresh();
    const entry = catalog.installation?.get(sourceId);
    const other = entry?.record?.workspace_id;
    const base = Object.hasOwn(catalog.profiles, sourceId)
      ? catalog.profiles[sourceId]
      : undefined;
    // Another workspace's version reads as unknown whatever its state.
    if (
      !entry ||
      !entry.definition ||
      !base ||
      (other != null && other !== workspaceId)
    ) {
      throw badRequest(
        `Unknown profile ${sourceId}`,
        "unknown_base",
        "derived_from",
      );
    }
    if (entry.state !== "usable") {
      throw badRequest(
        entry.state === "retired"
          ? `Profile ${sourceId} is retired: pick a newer version`
          : `Profile ${sourceId} does not run here (${entry.state}): pick a usable one`,
        entry.state,
        "derived_from",
      );
    }
    return {
      sourceId,
      base,
      definition: entry.definition,
      connectionId: entry.connection_id ?? null,
    };
  }

  return {
    async options(caller: Caller): Promise<InstallationProfileOptionsResponse> {
      await definer(caller);
      return {
        connections: Object.entries(deps.connections())
          .map(([id, provider]) => ({
            id,
            kind: provider.kind,
            billing:
              provider.billing === "none"
                ? ("none" as const)
                : ("metered" as const),
          }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        runtimes: RUNTIME_KIND_VALUES.map((kind) => ({
          runtime_kind: kind,
          permission_modes: modesOf(kind),
        })).filter((runtime) => runtime.permission_modes.length > 0),
        ...(catalog.tool_catalogs === undefined
          ? {}
          : { tool_catalogs: optionCatalogs(catalog.tool_catalogs) }),
        unattended_allowed: deps.allowUnattended,
      };
    },

    async create(
      caller: Caller,
      request: CreateInstallationProfileRequest,
    ): Promise<WorkspaceProfileChangeResponse> {
      const { actor, owner } = await definer(caller);
      // The owner names the runtime; an admin narrows a version it may see.
      // A new version of a workspace profile is written that way by either
      // role, as it keeps its source.
      const ofWorkspace =
        owner &&
        request.previous_id !== undefined &&
        (await previousOf(request.previous_id)).workspace_id != null;
      const admin =
        owner && !ofWorkspace
          ? undefined
          : await adminSource(request, actor.workspaceId);
      const own = admin ? undefined : ownerFixed(request);
      const fixed: Fixed = admin
        ? {
            runtime_kind: admin.definition.runtime_kind,
            runtime_version: admin.definition.runtime_version,
            provider: admin.definition.provider,
            title_model: admin.definition.title_model,
            project_settings: admin.definition.project_settings,
          }
        : (own as NonNullable<typeof own>).fixed;
      const connectionId = admin
        ? admin.connectionId
        : (own as NonNullable<typeof own>).connectionId;
      const { tools, denied } = await toolsOf(
        request,
        { kind: fixed.runtime_kind, version: fixed.runtime_version },
        admin && {
          tools: admin.base.tools,
          mcpDeny: admin.base.mcp_deny,
          // An allow-list source names no catalog: only its tools bound it.
          sameCatalog:
            catalog.installation?.get(admin.sourceId)?.record
              ?.tool_catalog_id ===
            catalog.tool_catalogs?.for(
              fixed.runtime_kind,
              fixed.runtime_version,
            )?.id,
        },
      );
      const definition = definitionOf(request, fixed, tools);
      if (admin) {
        const refusal = derivationPolicyOf(catalog).refusal(admin.base, {
          model: request.model,
          models: [...new Set(request.models)],
          tools,
          permission_mode: request.permission_mode,
        });
        if (refusal !== null) {
          throw badRequest(refusal.message, "widens_base", refusal.field);
        }
      }
      if (
        (OPT_IN_PERMISSION_MODES as readonly string[]).includes(
          definition.permission_mode,
        ) &&
        !deps.allowUnattended
      ) {
        throw badRequest(
          `${definition.permission_mode} needs PLATFORM_ALLOW_UNATTENDED_PERMISSIONS=true on this installation`,
          "unattended_not_allowed",
          "permission_mode",
        );
      }
      const refusal = runtimes.refusal(definition.runtime_kind, definition);
      if (refusal !== null) {
        throw badRequest(refusal, "runtime_not_installed", "runtime_kind");
      }
      const receiptId = newId();
      const result = await store.create({
        actor,
        receiptId,
        name: request.name,
        scope: admin
          ? {
              kind: "workspace",
              workspaceId: actor.workspaceId,
              derivedFrom: admin.sourceId,
            }
          : { kind: "installation" },
        previousId: request.previous_id ?? null,
        definition,
        permission_mode: definition.permission_mode,
        fingerprint: definitionFingerprint(request.name, definition),
        deny: denied?.deny ?? null,
        toolCatalogId: denied?.toolCatalogId ?? null,
        connectionId,
        ...(denied?.previousDrift ? { previousDenyDrift: true } : {}),
      });
      switch (result.outcome) {
        case "name_taken":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `A profile named ${request.name} already exists`,
            undefined,
            { reason_code: "name_taken", field: "name" },
          );
        case "unchanged":
          // Nothing was written: the latest version already runs this.
          await reread();
          return changed(result.record, null, connectionId);
        case "actor_inactive":
          throw OUTRANKED();
        case "stale_previous":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            result.latestId === null
              ? `${request.name} has no version yet`
              : `The latest version of ${request.name} is ${result.latestId}: make the next one from it`,
            undefined,
            { reason_code: "stale_previous", latest_id: result.latestId },
          );
        case "id_taken":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `${result.id} is already a profile id: pick another name`,
            undefined,
            { reason_code: "id_taken", field: "name" },
          );
        case "unknown_previous":
          throw badRequest(
            `Unknown profile ${request.previous_id}`,
            "unknown_previous",
            "previous_id",
          );
        default:
          await reread();
          return changed(result.record, receiptId, connectionId);
      }
    },

    async retire(
      caller: Caller,
      profileId: string,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await operator(caller);
      // A row whose definition no longer parses is not listed, so it is not
      // found here either rather than retired with nothing to answer.
      await reread();
      if (operatorSummary(catalog, profileId) === undefined) throw NOT_FOUND();
      const receiptId = newId();
      const result = await store.retire({ actor, receiptId, profileId });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw OUTRANKED();
        default:
          await reread();
          return changed(
            result.record,
            result.outcome === "retired" ? receiptId : null,
          );
      }
    },

    /**
     * A person's retry of one agent a profile rollout failed for: the one way
     * a failed item runs again (design 2.3). The item is judged afresh.
     */
    async retryRollout(
      caller: Caller,
      profileId: string,
      agentId: string,
    ): Promise<RetryProfileRolloutResponse> {
      const actor = await operator(caller);
      const retried = await deps.rollouts.retryFailed({
        workspaceId: actor.workspaceId,
        targetProfileId: profileId,
        agentId,
      });
      return { retried };
    },

    /**
     * Stops (`blocked`) or lets run again everything on one ceiling, the
     * workspace versions over it and their running sessions included.
     */
    async setBlocked(
      caller: Caller,
      profileId: string,
      blocked: boolean,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await operator(caller);
      await reread();
      if (operatorSummary(catalog, profileId) === undefined) throw NOT_FOUND();
      const receiptId = newId();
      const result = await store.setBlocked({
        actor,
        receiptId,
        profileId,
        blocked,
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw OUTRANKED();
        default:
          await reread();
          return changed(
            result.record,
            result.outcome === "changed" ? receiptId : null,
          );
      }
    },
  };
}

export type InstallationProfileService = ReturnType<
  typeof createInstallationProfileService
>;
