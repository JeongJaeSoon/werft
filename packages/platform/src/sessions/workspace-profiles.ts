import {
  type CreateWorkspaceProfileRequest,
  type ListProfilesResponse,
  mcpNamesOf,
  type ProfileDerivationPolicy,
  type ProfileSummary,
  WORKSPACE_PROFILE_POLICY,
  type WorkspaceProfileChangeResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import { NOT_FOUND } from "../musterrolle/service-errors.ts";
import type { InstallationProfileRecord } from "../ports/installation-profile-store.ts";
import type { ProfileRolloutStore } from "../ports/profile-rollout-store.ts";
import type { TeamActor } from "../ports/team-store.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  type CatalogProfileView,
  catalogProfileConfigSchema,
  derivationPolicyOf,
  isUnmetered,
  modelMoves,
  profileAllowsRepository,
  profileFingerprint,
  profileModels,
  refreshWorkspaceProfilesFor,
  repositoryModeOf,
  type SessionCatalogView,
  sessionCatalogView,
  type WorkspaceProfileRecord,
  type WorkspaceProfiles,
  workspaceProfileState,
} from "./catalog.ts";
import { latestReads } from "./profile-registry.ts";
import {
  deniedTools,
  mcpDenyScope,
  previousChoice,
  type StoredDeny,
  shownDeny,
  withKeptMcpDeny,
} from "./profile-tools.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

/**
 * How often a process reads the versions again on its own, for the lookups
 * that do not read them first (a session's runtime in a list, for one).
 */
export const WORKSPACE_PROFILE_REFRESH_MS = 10_000;

/**
 * The versions in `store`, read again on `refresh`. A refresh joins a read
 * that began recently enough, else starts one; a failed read keeps what was
 * read before.
 */
export function createWorkspaceProfiles(
  store: Pick<WorkspaceProfileStore, "listAll">,
  now: () => number = Date.now,
  policy: ProfileDerivationPolicy = WORKSPACE_PROFILE_POLICY,
): WorkspaceProfiles {
  let records: ReadonlyMap<string, WorkspaceProfileRecord> = new Map();
  return {
    policy,
    get records() {
      return records;
    },
    refresh: latestReads(
      () => store.listAll(),
      (rows) => {
        records = new Map(rows.map((row) => [row.id, row]));
      },
      now,
    ),
  };
}

/** Only a catalog given tool catalogs lists a deny; without them none is known. */
function denyField(
  catalog: SessionCatalogView,
  stored: StoredDeny | undefined,
  tools: readonly string[],
  runtime: { kind: string; version: string },
): { deny?: string[] | null } {
  return catalog.tool_catalogs === undefined
    ? {}
    : { deny: shownDeny(catalog.tool_catalogs, stored ?? {}, tools, runtime) };
}

/** The `mcp__` blocks beside `deny`, which stays the catalog's; no key when none. */
function mcpDenyField(names: readonly string[] | null | undefined): {
  mcp_deny?: string[];
} {
  const mcp = mcpNamesOf(names);
  return mcp.length > 0 ? { mcp_deny: mcp } : {};
}

function modelSuccessorsField(profile: CatalogProfileView) {
  const moves = modelMoves(profile);
  return moves.length === 0
    ? {}
    : {
        model_successors: Object.fromEntries(
          moves.map(({ from, to }) => [from, to]),
        ),
      };
}

/** `trustedId` is the operator profile a repository's allow list names. */
function summaryOf(
  catalog: SessionCatalogView,
  id: string,
  trustedId: string,
  profile: CatalogProfileView,
  stored?: StoredDeny,
) {
  return {
    id,
    model: profile.model,
    models: profileModels(profile),
    ...modelSuccessorsField(profile),
    tools: [...profile.tools],
    ...denyField(catalog, stored, profile.tools, {
      kind: profile.runtime_kind,
      version: profile.runtime_version,
    }),
    ...mcpDenyField(profile.mcp_deny),
    permission_mode: profile.permission_mode,
    runtime_kind: profile.runtime_kind,
    runtime_version: profile.runtime_version,
    billing: isUnmetered(profile) ? ("none" as const) : ("metered" as const),
    repository_mode: repositoryModeOf(profile),
    repository_ids:
      repositoryModeOf(profile) === "none"
        ? []
        : Object.keys(catalog.repositories)
            .filter((repositoryId) =>
              profileAllowsRepository(catalog, trustedId, repositoryId),
            )
            .sort(),
  };
}

/** An old `ws_` version as the one that answers its own write describes it; it is no longer listed. */
export function workspaceSummary(
  catalog: SessionCatalogView,
  record: WorkspaceProfileRecord,
): ProfileSummary {
  const base = Object.hasOwn(catalog.profiles, record.base_profile_id)
    ? catalog.profiles[record.base_profile_id]
    : undefined;
  const listed = {
    ...(base
      ? summaryOf(
          catalog,
          record.id,
          record.base_profile_id,
          derivationPolicyOf(catalog).apply(base, record),
          record,
        )
      : {
          id: record.id,
          model: record.model,
          models: [
            record.model,
            ...record.models.filter((m) => m !== record.model),
          ],
          tools: [...record.tools],
          ...mcpDenyField(record.deny),
          permission_mode: record.permission_mode,
          runtime_kind: "claude_agent_sdk" as const,
          runtime_version: record.base_runtime_version,
          billing: record.base_billing,
          repository_mode: record.base_repository_mode,
          repository_ids: [],
        }),
  };
  return {
    ...listed,
    ...(base
      ? {}
      : denyField(catalog, record, record.tools, {
          kind: listed.runtime_kind,
          version: listed.runtime_version,
        })),
    source: "workspace",
    workspace: {
      name: record.name,
      version: record.version,
      base_profile_id: record.base_profile_id,
      state: workspaceProfileState(catalog, record),
      created_by: record.created_by,
      created_at: record.created_at.toISOString(),
      retired_by: record.retired_by,
      retired_at: record.retired_at?.toISOString() ?? null,
    },
  };
}

/**
 * An installation ceiling as listed, whatever its state: one that does not
 * run here is described from its stored definition. Undefined for an id
 * with neither (a row that no longer parses).
 *
 * `written` is a row this process just committed, so the answer to that
 * write holds even when the snapshot has not read it yet: a new row is
 * `usable` (the write was refused otherwise) and a retired one `retired`.
 */
export function operatorSummary(
  catalog: SessionCatalogView,
  id: string,
  written?: { record: InstallationProfileRecord; connectionId: string | null },
): ProfileSummary | undefined {
  const entry = catalog.installation?.get(id);
  const definition =
    entry?.definition ??
    (written && catalogProfileConfigSchema.safeParse(written.record.definition))
      ?.data;
  const profile = Object.hasOwn(catalog.profiles, id)
    ? catalog.profiles[id]
    : definition &&
      sessionCatalogView({
        profiles: { [id]: definition },
        repositories: {},
      }).profiles[id];
  if (!profile) return undefined;
  const record = written?.record ?? entry?.record;
  const current =
    entry?.record !== undefined &&
    (written === undefined ||
      (entry.record.retired_at?.getTime() ===
        written.record.retired_at?.getTime() &&
        entry.record.blocked_at?.getTime() ===
          written.record.blocked_at?.getTime()));
  const state = current
    ? entry.state
    : written?.record.blocked_at
      ? "blocked"
      : written?.record.retired_at
        ? "retired"
        : "usable";
  const { repository_mode, repository_ids, ...summary } = summaryOf(
    catalog,
    id,
    id,
    profile,
    record,
  );
  // A row with no repository scope says nothing about repositories, so the
  // answer carries neither field (in memory it reads `optional`).
  const namesNoRepository = record?.repository_scope === null;
  const repositoryIds =
    current || !written || repository_mode === "none"
      ? repository_ids
      : [
          ...new Set([
            ...repository_ids,
            ...(written.record.repository_ids ?? []).filter((repositoryId) =>
              Object.hasOwn(catalog.repositories, repositoryId),
            ),
          ]),
        ].sort();
  return {
    ...summary,
    ...(namesNoRepository
      ? {}
      : { repository_mode, repository_ids: repositoryIds }),
    source: "operator",
    ...((entry || written) && record
      ? {
          installation: {
            name: record.display_name ?? record.name,
            version: record.version,
            origin: record.origin,
            state,
            connection_id:
              entry?.connection_id ?? written?.connectionId ?? null,
            title_model: profile.title_model ?? null,
            project_settings: profile.project_settings ?? {
              claude_md: false,
            },
            previous_id: record.previous_id,
            derived_from: record.derived_from ?? null,
            created_by: record.created_by,
            created_at: record.created_at.toISOString(),
            retired_by: record.retired_by,
            retired_at: record.retired_at?.toISOString() ?? null,
            blocked_by: record.blocked_by,
            blocked_at: record.blocked_at?.toISOString() ?? null,
            github_app_repositories: record.github_app_repositories,
          },
        }
      : {}),
  };
}

/** Picked field by field: a profile also holds its provider credential. */
export function listCatalogProfiles(
  catalog: SessionCatalogView,
  workspaceId: string | null,
): ListProfilesResponse {
  const byId = (a: { id: string }, b: { id: string }) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const operator = [
    ...new Set([
      ...Object.keys(catalog.profiles),
      ...(catalog.installation?.keys() ?? []),
    ]),
  ].flatMap((id) => {
    // A version an admin made belongs to that workspace alone.
    const owner = catalog.installation?.get(id)?.record?.workspace_id;
    if (owner != null && owner !== workspaceId) return [];
    const summary = operatorSummary(catalog, id);
    return summary ? [summary] : [];
  });
  // The old `ws_` versions are not listed: a profile is one kind now, and
  // what ran on them keeps its release.
  return { items: operator.sort(byId) };
}

const OUTRANKED = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "The caller no longer holds workspace.manage",
    undefined,
    { reason_code: "role" },
  );

export function createWorkspaceProfileService(deps: {
  authorization: AuthorizationPolicy;
  store: WorkspaceProfileStore;
  catalog: SessionCatalogView & { workspace_profiles: WorkspaceProfiles };
  /** Adds each profile version's rollout in the caller's workspace to a list. */
  rollouts?: Pick<ProfileRolloutStore, "summaries">;
  newId?: () => string;
}) {
  const { authorization, store, catalog } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function manager(caller: Caller): Promise<TeamActor> {
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person changes a workspace profile",
        undefined,
        { reason_code: "role" },
      );
    }
    return { principal: caller, workspaceId, userId };
  }

  function changed(
    record: WorkspaceProfileRecord,
    receiptId: string | null,
  ): WorkspaceProfileChangeResponse {
    return {
      profile: workspaceSummary(catalog, record),
      receipt_id: receiptId,
    };
  }

  // After a write has committed, a failed read must not report it failed:
  // the answer comes from the written row, and a retry would save again.
  async function reread(): Promise<void> {
    await catalog.workspace_profiles.refresh().catch(() => undefined);
  }

  return {
    async list(caller: Caller): Promise<ListProfilesResponse> {
      await reread();
      const listed = listCatalogProfiles(
        catalog,
        caller.actor?.workspaceId ?? null,
      );
      const workspaceId = caller.actor?.workspaceId;
      if (deps.rollouts === undefined || !workspaceId) return listed;
      const rollouts = await deps.rollouts.summaries(workspaceId);
      // Who was refused names agents the caller may not otherwise see.
      const names = await manager(caller).then(
        () => true,
        (error: unknown) => {
          if (error instanceof SessionServiceError) return false;
          throw error;
        },
      );
      return {
        items: listed.items.map((item) => {
          const found = rollouts.get(item.id);
          const rollout =
            found !== undefined && !names
              ? { ...found, failed_agents: [] }
              : found;
          return rollout !== undefined && item.installation !== undefined
            ? { ...item, installation: { ...item.installation, rollout } }
            : item;
        }),
      };
    },

    async create(
      caller: Caller,
      request: CreateWorkspaceProfileRequest,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await manager(caller);
      await refreshWorkspaceProfilesFor(catalog, [request.base_profile_id], {
        strict: true,
      });
      const base = Object.hasOwn(catalog.profiles, request.base_profile_id)
        ? catalog.profiles[request.base_profile_id]
        : undefined;
      // Another workspace's version reads as unknown whatever its state, so
      // this comes before the state is looked at.
      const baseWorkspace = catalog.installation?.get(request.base_profile_id)
        ?.record?.workspace_id;
      const foreignBase =
        baseWorkspace != null && baseWorkspace !== actor.workspaceId;
      const baseState = foreignBase
        ? undefined
        : catalog.installation?.get(request.base_profile_id)?.state;
      if (baseState !== undefined && baseState !== "usable") {
        throw new SessionServiceError(
          "BAD_REQUEST",
          baseState === "retired"
            ? `Operator profile ${request.base_profile_id} is retired: pick a newer version`
            : `Operator profile ${request.base_profile_id} does not run here (${baseState}): pick a usable one`,
          undefined,
          { reason_code: baseState, field: "base_profile_id" },
        );
      }
      if (!base || foreignBase) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          `Unknown operator profile ${request.base_profile_id}`,
          undefined,
          { reason_code: "unknown_base", field: "base_profile_id" },
        );
      }
      // A deny weighs the latest version, so it reads them now; the store
      // refuses the save if another one lands before it.
      // An allow list reads them too: it must not drop the `mcp__` blocks of
      // a version this replica has not read yet.
      await catalog.workspace_profiles.refresh();
      const previous = [...catalog.workspace_profiles.records.values()]
        .filter(
          (record) =>
            record.workspace_id === actor.workspaceId &&
            record.name === request.name,
        )
        .reduce<WorkspaceProfileRecord | undefined>(
          (latest, record) =>
            latest === undefined || record.version > latest.version
              ? record
              : latest,
          undefined,
        );
      if (
        request.unblock_mcp_tools?.length &&
        request.previous_id === undefined
      ) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "unblock_mcp_tools needs previous_id: the version it was read from",
          undefined,
          { reason_code: "mcp_unblock_no_previous", field: "previous_id" },
        );
      }
      if (
        request.previous_id !== undefined &&
        request.previous_id !== previous?.id
      ) {
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          previous === undefined
            ? `${request.name} has no version yet`
            : `The latest version of ${request.name} is ${previous.id}: make the next one from it`,
          undefined,
          { reason_code: "stale_previous", latest_id: previous?.id ?? null },
        );
      }
      const previousRead =
        previous &&
        previousChoice(catalog.tool_catalogs, previous, previous.tools);
      const baseCatalog = catalog.tool_catalogs?.for(
        base.runtime_kind,
        base.runtime_version,
      );
      const asked =
        request.deny === undefined
          ? undefined
          : deniedTools({
              catalog: baseCatalog,
              deny: request.deny,
              accept: request.accept_added_tools,
              base: {
                tools: base.tools,
                // An allow-list base names no catalog: only its tools bound the version.
                sameCatalog:
                  baseCatalog !== undefined &&
                  catalog.installation?.get(request.base_profile_id)?.record
                    ?.tool_catalog_id === baseCatalog.id,
              },
              previous: previousRead,
              mcp: mcpDenyScope(
                catalog.mcp_servers,
                base.mcp_deny,
                previous?.deny,
              ),
            });
      const narrowing = {
        model: request.model,
        models: [...new Set(request.models)],
        tools: asked?.tools ?? [...new Set(request.tools ?? [])],
        permission_mode: request.permission_mode,
      };
      // Whichever way the tools were named, the version keeps the `mcp__`
      // blocks of the one before it, and holds all of its base's.
      const denied = withKeptMcpDeny({
        catalog: baseCatalog,
        tools: narrowing.tools,
        denied: asked,
        previous,
        baseMcpDeny: base.mcp_deny,
        requested: asked?.mcpDeny,
        unblock: request.unblock_mcp_tools,
      });
      const refusal = derivationPolicyOf(catalog).refusal(base, narrowing);
      if (refusal !== null) {
        throw new SessionServiceError(
          "BAD_REQUEST",
          refusal.message,
          undefined,
          {
            reason_code: "widens_base",
            field: refusal.field,
          },
        );
      }
      const receiptId = newId();
      const result = await store.create({
        actor,
        receiptId,
        name: request.name,
        baseProfileId: request.base_profile_id,
        base: {
          fingerprint: profileFingerprint(base),
          runtimeVersion: base.runtime_version,
          billing: isUnmetered(base) ? "none" : "metered",
          repositoryMode: repositoryModeOf(base),
        },
        narrowing,
        deny: denied?.deny ?? null,
        toolCatalogId: denied?.toolCatalogId ?? null,
        ...(denied || request.unblock_mcp_tools?.length
          ? {
              previousVersion: previous?.version ?? null,
              ...(previousRead?.drift ? { previousDenyDrift: true } : {}),
            }
          : {}),
      });
      switch (result.outcome) {
        case "actor_inactive":
          throw OUTRANKED();
        case "version_taken":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `Another version of ${request.name} was saved at the same time; save again to make the next one`,
          );
        default:
          await reread();
          return changed(result.record, receiptId);
      }
    },

    async retire(
      caller: Caller,
      profileId: string,
    ): Promise<WorkspaceProfileChangeResponse> {
      const actor = await manager(caller);
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
  };
}

export type WorkspaceProfileService = ReturnType<
  typeof createWorkspaceProfileService
>;
