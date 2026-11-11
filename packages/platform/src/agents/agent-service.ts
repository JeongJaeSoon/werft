import type {
  CountAgentsResponse,
  CreateAgentReleaseRequest,
  CreateAgentReleaseResponse,
  CreateAgentRequest,
  ListAgentsQuery,
  ListAgentsResponse,
  ListConnectionOptionsResponse,
  UpdateAgentRequest,
} from "@werft-ai/contracts";
import {
  type ActivateAgentRequest,
  type ActivateAgentResponse,
  type ActivationCredentialUnboundDetails,
  type AgentCard,
  type AgentDetail,
  type AgentGitHub,
  type AgentRelease,
  type AgentVersion,
  type BehaviorValues,
  envNameProblem,
  GITHUB_CEILING_NONE,
  type GitHubRefusal,
  githubFeaturesOverCeiling,
  type ListUsableAgentsResponse,
  type SaveAgentResponse,
  type SaveRelease,
  TEAM_LIST_LIMIT,
  type UsableAgent,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type { ExtensionRefusal } from "../extensions/resolve.ts";
import {
  checkAgentExtensions,
  type SessionExtensionsDeps,
} from "../extensions/session-extensions.ts";
import type { GitHubSettingsStore } from "../github/ports/github-settings.ts";
import { requirePermitted, SessionServiceError } from "../musterrolle/index.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  type OutsideAgentAccessSetting,
  outsideAgentsUse,
  type Principal,
} from "../musterrolle/policy.ts";
import {
  ACTOR_INACTIVE,
  NOT_FOUND,
  OUTRANKED,
  TEAM_HOLDING,
  TEAM_NOT_ALLOWED,
  TEAM_NOT_FOUND,
} from "../musterrolle/service-errors.ts";
import type {
  ActivationIntent,
  AgentReader,
  AgentRecord,
  AgentStore,
  ReleaseReason,
} from "../ports/agent-store.ts";
import type { WorkspaceKeyStore } from "../ports/api-key-store.ts";
import type { CredentialBindingStore } from "../ports/credential-binding-store.ts";
import {
  connectionModels,
  connectionOf,
  modelMoves,
  modelSuccessor,
  type SessionCatalog,
  type SessionCatalogView,
} from "../sessions/catalog.ts";
import { viewerOf } from "../sessions/index.ts";
import type { AgentWelcomable } from "../surface/ports/agent-welcomable.ts";
import type { ModelMoveStep } from "./model-move-runner.ts";
import {
  assertReleaseIdentity,
  cardContentSha256,
  deriveReleaseId,
  type ReleaseRun,
  releaseModel,
  resolveReleaseContent,
} from "./release-ids.ts";
import { type InstalledRuntimes, releaseRunOf } from "./release-run.ts";
import { buildSpecSource, releaseSpecRecord } from "./release-spec.ts";

/**
 * The release a session pins, refused when its connection no longer runs its
 * model here. Reads no credential value.
 */
export async function resolveAgentRelease(
  deps: {
    store: Pick<AgentStore, "findRelease" | "autoModelMigration">;
    catalog: Pick<SessionCatalogView, "connections">;
  },
  workspaceId: string,
  releaseId: string,
): Promise<AgentRelease> {
  const release = await deps.store.findRelease(workspaceId, releaseId);
  if (!release) throw NOT_FOUND();
  assertReleaseIdentity(release);
  const connectionId = release.connection_id;
  const connection = connectionOf(deps.catalog, connectionId);
  if (!connection) {
    throw new SessionServiceError(
      "RELEASE_SPEC_UNAVAILABLE",
      `Connection ${connectionId} of this release is disabled or not in this host's settings; release the version again on an enabled connection`,
      undefined,
      { reason_code: "connection_missing", connection_id: connectionId },
    );
  }
  const model = releaseModel(release);
  if (
    model !== undefined &&
    !connectionModels(connection).includes(model) &&
    (modelSuccessor(connection, model) === null ||
      !(await deps.store.autoModelMigration(workspaceId, release.agent_id)))
  ) {
    throw new SessionServiceError(
      "RELEASE_SPEC_UNAVAILABLE",
      `Model ${model} of this release was taken off the model list of connection ${connectionId}; release the version again on a model the connection offers`,
      undefined,
      { reason_code: "model_removed", connection_id: connectionId },
    );
  }
  return release;
}

export type NotRunnableReason = "agent_inactive" | "release_unapproved";

/**
 * Why a new session cannot run this release, or null. Approval is the
 * release's own `approved_at`, not whether it is the active one, so an older
 * approved release still runs while the agent is active.
 */
export async function releaseNotRunnableReason(
  store: Pick<AgentStore, "agentStatus">,
  workspaceId: string,
  release: Pick<AgentRelease, "agent_id" | "approved_at">,
): Promise<NotRunnableReason | null> {
  if ((await store.agentStatus(workspaceId, release.agent_id)) !== "active") {
    return "agent_inactive";
  }
  return release.approved_at === null ? "release_unapproved" : null;
}

/** The variable names a card declares (`capabilities.env`), none for a card without. */
export function declaredEnvNames(card: AgentCard): string[] {
  return (card.capabilities?.env ?? []).map((entry) => entry.name);
}

/**
 * A card that declares a name the platform sets itself could never start a
 * session, so it is refused where it is saved and where its release is
 * activated, not at the first session.
 */
export function assertDeclaredEnvNames(card: AgentCard): void {
  const reserved = declaredEnvNames(card).find(
    (name) => envNameProblem(name) === "reserved",
  );
  if (reserved !== undefined) {
    throw new SessionServiceError(
      "VARIABLE_NAME_RESERVED",
      `The card declares ${reserved}, a name the platform sets itself`,
    );
  }
}

/** The names the release's card declares; none when the release is gone. */
export async function agentEnvNames(
  store: Pick<AgentStore, "findRelease" | "findVersion">,
  workspaceId: string,
  releaseId: string,
): Promise<string[]> {
  const release = await store.findRelease(workspaceId, releaseId);
  if (!release) return [];
  const version = await store.findVersion(
    workspaceId,
    release.agent_id,
    release.version_id,
  );
  return version ? declaredEnvNames(version.card) : [];
}

export function createAgentService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentStore;
  catalog: SessionCatalog;
  credentials: Pick<CredentialBindingStore, "unboundRefs">;
  /** The home channel's welcome; absent where Slack is not wired. */
  welcome?: Pick<AgentWelcomable, "activated">;
  /** Where an agent key's agent is read; absent, every key is refused. */
  keys?: Pick<WorkspaceKeyStore, "find">;
  /** The ceiling a release's `github` is checked against; absent: all off. */
  githubSettings?: Pick<GitHubSettingsStore, "get">;
  /** Axis A, as the policy reads it; absent: `use`. */
  outsideAgents?: OutsideAgentAccessSetting;
  /** The runtime version a new release of each kind runs. */
  runtimes: InstalledRuntimes;
  extensions?: SessionExtensionsDeps;
}) {
  const { authorization, store, catalog, credentials } = deps;
  const outsideAgents = deps.outsideAgents ?? outsideAgentsUse;
  async function extensionRefusal(
    workspaceId: string,
    agentId: string,
    run: Pick<ReleaseRun, "runtime" | "tools">,
  ): Promise<ExtensionRefusal | null> {
    if (!deps.extensions) return null;
    const checked = await checkAgentExtensions(deps.extensions, {
      workspaceId,
      agentId,
      runtimeKind: run.runtime.kind,
      tools: [...run.tools],
    });
    return checked.ok ? null : checked.refusal;
  }
  const AGENT_MANAGERS = MANAGEMENT_ROLES["agent.manage"] ?? [];
  // Who names any live team as an agent's managing team, as setManagingTeam.
  const TEAM_ASSIGNERS = MANAGEMENT_ROLES["agent.admin.manage"] ?? [];

  // An agent with a settings row takes its GitHub settings from `PUT
  // …/github/settings`; a release no longer carries them (design 3.6).
  const githubSettingsOwned = () =>
    new SessionServiceError(
      "ALREADY_EXISTS",
      "github: this agent's GitHub settings are saved with PUT /v1/agents/{id}/github/settings, not in a release",
      undefined,
      { field: "github", reason_code: "github_settings_exist" },
    );

  const githubInvalid = (
    field: string,
    reason: GitHubRefusal | "release_repository_outside",
  ) =>
    new SessionServiceError("BAD_REQUEST", `${field}: ${reason}`, undefined, {
      field,
      reason_code: reason,
    });

  /**
   * A release's GitHub settings as asked (design github-agent.md §4): App
   * repositories of the catalog, the release's own among them, no
   * allow-list without Actions, nothing over the workspace's ceiling. The
   * gate cuts the release down again at every token issue.
   */
  async function checkGitHub(
    ownerId: string,
    repositoryId: string | null,
    github: AgentGitHub,
  ): Promise<void> {
    for (const [index, id] of github.repositories.entries()) {
      const field = `github.repositories.${index}`;
      const repository = Object.hasOwn(catalog.repositories, id)
        ? catalog.repositories[id]
        : undefined;
      if (repository === undefined) {
        throw githubInvalid(field, "repository_not_allowed");
      }
      // A PAT cannot be narrowed to a permission set.
      if (repository.auth?.kind !== "github_app") {
        throw githubInvalid(field, "app_required");
      }
    }
    if (repositoryId !== null && !github.repositories.includes(repositoryId)) {
      throw githubInvalid("github.repositories", "release_repository_outside");
    }
    if (github.actions_allow.length > 0 && !github.features.actions) {
      throw githubInvalid("github.actions_allow", "actions_off");
    }
    const ceiling =
      (await deps.githubSettings?.get(ownerId))?.ceiling ?? GITHUB_CEILING_NONE;
    const [over] = githubFeaturesOverCeiling(github.features, ceiling);
    if (over !== undefined) {
      throw githubInvalid(`github.features.${over}`, "over_workspace_ceiling");
    }
  }

  // A release is refused here for what its sessions would be refused for,
  // so Slack, which names no repository, gets one that can start.
  function releaseRepositoryRefusal(
    repositoryId: string | null,
  ): string | null {
    if (
      repositoryId === null ||
      Object.hasOwn(catalog.repositories, repositoryId)
    ) {
      return null;
    }
    return `Repository ${repositoryId} is not in the catalog`;
  }

  /** What a release on the connection runs; refused when it cannot run here. */
  function usableRun(connectionId: string): ReleaseRun {
    const found = releaseRunOf(catalog, deps.runtimes, connectionId);
    if (!found.ok) {
      throw new SessionServiceError(
        "UNSUPPORTED_CAPABILITY",
        found.message,
        undefined,
        { reason_code: found.reason_code },
      );
    }
    return found.run;
  }

  /** The spec a release of `identity` on `run`'s connection pins. */
  function specOf(
    id: string,
    identity: Pick<AgentRelease, "connection_id" | "runtime_config_snapshot">,
    run: ReleaseRun,
  ) {
    const built = buildSpecSource({
      release: { id, ...identity },
      connection: run.connection,
    });
    if (!built.ok) {
      throw new SessionServiceError(
        "UNSUPPORTED_CAPABILITY",
        `The release's spec cannot be made: ${built.message}`,
        undefined,
        { reason_code: "spec_invalid" },
      );
    }
    return releaseSpecRecord(built.source);
  }

  function personOf(caller: Caller): string {
    const userId = caller.actor?.userId;
    if (!userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "This principal does not hold agent.manage",
      );
    }
    return userId;
  }

  async function onWorkspace(
    caller: Caller,
    action: "agent.read" | "agent.create",
  ): Promise<string> {
    await requirePermitted(authorization, caller, action, {
      kind: "workspace",
      id: caller.ownerId,
    });
    return personOf(caller);
  }

  // The rows are judged in the store, by the same rule as agent.read on one
  // agent.
  async function agentReader(caller: Caller): Promise<AgentReader> {
    const userId = await onWorkspace(caller, "agent.read");
    return {
      userId,
      outsideAccess: await outsideAgents.access(caller.ownerId),
    };
  }

  async function manageAgent(caller: Caller, agentId: string) {
    await requirePermitted(authorization, caller, "agent.manage", {
      kind: "agent",
      id: agentId,
    });
    return personOf(caller);
  }

  // A key that may start sessions on its agent has to find the release to
  // name; it reads that one agent and nothing its admins manage.
  async function keysOwnAgent(
    caller: Caller,
    query: ListAgentsQuery,
  ): Promise<ListAgentsResponse> {
    // Read by the principal the policy re-reads below, so the agent asked
    // about is the one bound to the key that decision judges.
    const principal = caller.subject.principal;
    const key =
      principal?.kind === "api_key" && principal.workspace_id !== null
        ? await deps.keys?.find(principal.workspace_id, principal.id)
        : null;
    const agentId = key?.kind === "agent" ? key.agentId : null;
    if (!agentId || query.include === "summary") {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only an agent key lists agents, and only its own agent without include=summary",
      );
    }
    await requirePermitted(authorization, caller, "session.submit", {
      kind: "session",
      id: null,
      agent_id: agentId,
    });
    const detail = await store.get(caller.ownerId, agentId);
    const own = detail?.agent;
    // The same narrowing the workspace list does, so a filter never names
    // an agent it does not match.
    const needle = query.q?.toLowerCase();
    const kept =
      own &&
      (needle === undefined ||
        own.name.toLowerCase().includes(needle) ||
        own.slug.includes(needle)) &&
      (query.ids === undefined ||
        query.ids.some((id) => id.toLowerCase() === own.id.toLowerCase())) &&
      (query.connection_id === undefined ||
        detail.active_release?.connection_id === query.connection_id);
    return { items: kept ? [own] : [], next_cursor: null };
  }

  function refusalCode(error: unknown): string | null {
    if (!(error instanceof SessionServiceError)) return null;
    const reason = (error.details as { reason_code?: unknown } | null)
      ?.reason_code;
    return (
      typeof reason === "string" ? reason : error.code.toLowerCase()
    ).slice(0, 128);
  }

  type ReleaseOutcome =
    | { status: "applied"; releaseId: string }
    | { status: "superseded" }
    | { status: "failed"; reason: string }
    | { status: "retry" };

  /**
   * The one way a release is made and activated for an agent (design 2.1):
   * the checks of `createRelease`, then `activate` under the revisions the
   * save was based on. Refusals are an outcome, not a throw, so the caller
   * can keep them on the draft.
   */
  async function releaseAgent(
    caller: Principal,
    userId: string,
    input: {
      agentId: string;
      version: AgentVersion;
      connectionId: string;
      /** The active release the save was read from. */
      active: AgentRelease | null;
      expectedActivationRevision: number;
      intent: Exclude<ActivationIntent, { kind: "direct" }>;
      reason: ReleaseReason;
      requireRoles?: readonly WorkspaceRole[];
    },
  ): Promise<ReleaseOutcome> {
    const { version, connectionId, active } = input;
    const failed = (reason: string): ReleaseOutcome => ({
      status: "failed",
      reason,
    });
    // Rollout, migration and unlock re-release a stored card without a save,
    // so the reserved-name check cannot live only on the save path.
    if (
      declaredEnvNames(version.card).some(
        (name) => envNameProblem(name) === "reserved",
      )
    ) {
      return failed("variable_name_reserved");
    }
    let run: ReleaseRun;
    try {
      run = usableRun(connectionId);
    } catch (error) {
      const reason = refusalCode(error);
      if (reason === null) throw error;
      return failed(reason);
    }
    if ((await extensionRefusal(caller.ownerId, input.agentId, run)) !== null) {
      return failed("release_refused");
    }
    // An agent with a settings row has the row decide, and its release has
    // no GitHub pin or repository. One without keeps the active release's
    // (design 3.5).
    const hasRow = await store.hasGitHubSettings(input.agentId);
    const carry = !hasRow;
    const repositoryId = carry ? (active?.repository_id ?? null) : null;
    const github = carry ? active?.policy_pins.github : undefined;
    if (releaseRepositoryRefusal(repositoryId) !== null) {
      return failed("release_refused");
    }
    if (github !== undefined) {
      try {
        await checkGitHub(caller.ownerId, repositoryId, github);
      } catch (error) {
        const reason = refusalCode(error);
        if (reason === null) throw error;
        return failed(reason);
      }
    }
    const resolved = resolveReleaseContent(
      version.card,
      run,
      catalog.mcp_servers,
    );
    if (!resolved.ok) {
      return failed(
        resolved.error.field === "card.model"
          ? "model_not_in_connection"
          : "release_refused",
      );
    }
    const identity = {
      agent_id: version.agent_id,
      card_sha256: version.content_sha256,
      repository_id: repositoryId,
      ...resolved.content,
      policy_pins: {
        ...resolved.content.policy_pins,
        ...(github === undefined ? {} : { github }),
      },
    };
    const releaseId = deriveReleaseId(identity);
    const inserted = await store.insertRelease({
      principal: caller,
      workspaceId: caller.ownerId,
      managerRoles: AGENT_MANAGERS,
      ...(input.requireRoles === undefined
        ? {}
        : { requireRoles: input.requireRoles }),
      // Judged under the agent's lock: a first settings row saved since the
      // read above makes what was carried wrong.
      refuseGitHubWhenSettings: carry,
      reason: input.reason,
      release: {
        id: releaseId,
        version_id: version.id,
        created_by: userId,
        note: null,
        ...identity,
        spec: specOf(releaseId, identity, run),
      },
    });
    switch (inserted.outcome) {
      case "not_found":
        throw NOT_FOUND();
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      case "github_settings_exist":
        return { status: "retry" };
      default:
        assertReleaseIdentity(inserted.release);
    }
    // The id it was inserted under, the one derived above.
    const missing = await credentials.unboundRefs(caller.ownerId, releaseId);
    if (missing.length > 0) return failed("credential_unbound");
    const activated = await store.activate({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId: input.agentId,
      releaseId,
      expectedRevision: input.expectedActivationRevision,
      approvedBy: userId,
      managerRoles: AGENT_MANAGERS,
      ...(input.requireRoles === undefined
        ? {}
        : { requireRoles: input.requireRoles }),
      intent: input.intent,
      reason: input.reason,
    });
    switch (activated.outcome) {
      case "not_found":
        throw NOT_FOUND();
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      case "conflict":
        return { status: "retry" };
      case "superseded":
        return { status: "superseded" };
      case "unchanged":
        return { status: "applied", releaseId };
      default:
        await deps.welcome?.activated(caller.ownerId, input.agentId, releaseId);
        return { status: "applied", releaseId };
    }
  }

  function behaviorValues(connectionId: string, model: string): BehaviorValues {
    return { connection_id: connectionId, model };
  }

  function withBehavior(record: AgentRecord): AgentDetail {
    const cardOf = (versionId: string) =>
      record.versions.find((version) => version.id === versionId)?.card;
    const active = record.active_release;
    const activeCard = active ? cardOf(active.version_id) : undefined;
    const { draft } = record;
    const draftCard = draft ? cardOf(draft.version_id) : undefined;
    return {
      ...record,
      effective_behavior: {
        applied:
          active && activeCard
            ? behaviorValues(
                active.connection_id,
                releaseModel(active) ?? activeCard.model,
              )
            : null,
        draft:
          draft && draftCard
            ? behaviorValues(draft.connection_id, draftCard.model)
            : null,
      },
    };
  }

  const MAX_SAVE_ATTEMPTS = 3;

  /**
   * Z1, a card save (design 2.2). Saves what was sent, then, when it changes
   * what the agent runs, asks `releaseAgent` for it. The card version is kept
   * whatever the release does. What the request left out is read from the
   * agent and checked again under its lock; if the agent moved, or the ground
   * the release was judged on did, the save is judged again.
   */
  async function saveAgent(
    caller: Caller,
    userId: string,
    agentId: string,
    fields: {
      name?: string;
      description?: string | null;
      auto_model_migration?: boolean;
      card?: AgentCard;
      connection_id?: string;
    },
  ): Promise<SaveAgentResponse> {
    if (fields.card !== undefined) assertDeclaredEnvNames(fields.card);
    const done = (record: AgentRecord, release: SaveRelease) => ({
      ...withBehavior(record),
      release,
    });
    const nothing: SaveRelease = {
      status: "unchanged",
      reason: null,
      release_id: null,
      version_id: null,
    };
    const identity = {
      ...(fields.name === undefined ? {} : { name: fields.name }),
      ...(fields.description === undefined
        ? {}
        : { description: fields.description }),
      ...(fields.auto_model_migration === undefined
        ? {}
        : { autoModelMigration: fields.auto_model_migration }),
    } as const;
    const versionOfCard = (
      record: AgentRecord,
      sent: AgentCard | undefined,
    ) => {
      if (sent === undefined) return null;
      const sha = cardContentSha256(sent);
      return (
        record.versions.find((version) => version.content_sha256 === sha)?.id ??
        null
      );
    };
    const refused = (outcome: "not_found" | "actor_inactive" | "outranked") => {
      if (outcome === "not_found") return NOT_FOUND();
      return outcome === "actor_inactive" ? ACTOR_INACTIVE() : OUTRANKED();
    };
    const asked =
      fields.card !== undefined || fields.connection_id !== undefined;
    for (let attempt = 1; ; attempt++) {
      const record = await store.get(caller.ownerId, agentId);
      if (!record) throw NOT_FOUND();
      const active = record.active_release;
      const { draft } = record;
      const cardOf = (versionId: string | undefined) =>
        record.versions.find((version) => version.id === versionId)?.card;
      const newest = record.versions.at(-1)?.card;
      const base =
        fields.card ??
        cardOf(active?.version_id) ??
        cardOf(draft?.version_id) ??
        newest;
      // The card that would be released, sent or not: a save that names only
      // a connection re-releases the stored one.
      if (asked && base !== undefined) assertDeclaredEnvNames(base);
      const connectionId =
        fields.connection_id ??
        active?.connection_id ??
        draft?.connection_id ??
        null;
      if (!asked || connectionId === null || base === undefined) {
        const result = await store.update({
          principal: caller,
          workspaceId: caller.ownerId,
          agentId,
          ...identity,
          ...(fields.card === undefined
            ? {}
            : {
                card: {
                  card: fields.card,
                  contentSha256: cardContentSha256(fields.card),
                },
              }),
          updatedBy: userId,
          managerRoles: AGENT_MANAGERS,
        });
        if (result.outcome === "updated")
          return done(result.detail, {
            ...nothing,
            version_id: versionOfCard(result.detail, fields.card),
          });
        if (result.outcome === "stale") continue;
        throw refused(result.outcome);
      }
      const card = base;
      const explicit =
        fields.card !== undefined && fields.connection_id !== undefined;
      const result = await store.update({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        ...identity,
        card: { card, contentSha256: cardContentSha256(card) },
        behavior: {
          connectionId,
          ...(explicit
            ? {}
            : {
                basedOn: {
                  behaviorRevision: record.behavior_revision,
                  activationRevision: record.agent.activation_revision,
                },
              }),
        },
        updatedBy: userId,
        managerRoles: AGENT_MANAGERS,
      });
      if (result.outcome === "stale") {
        if (attempt < MAX_SAVE_ATTEMPTS) continue;
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          "The agent keeps changing; try the save again",
        );
      }
      if (result.outcome !== "updated") throw refused(result.outcome);
      const { saved } = result;
      const version = result.detail.versions.find(
        (v) => v.id === saved?.versionId,
      );
      if (!saved || !version)
        throw new Error("a behavioral save has a version");
      if (saved.status === "unchanged")
        return done(result.detail, { ...nothing, version_id: saved.versionId });
      // Only the release is asked again when the ground moved under it. The
      // save keeps the revision it was given, so a later save that landed in
      // between wins and this one ends superseded instead of being re-issued.
      let outcome: Awaited<ReturnType<typeof releaseAgent>>;
      let running = active;
      let expectedRevision = record.agent.activation_revision;
      for (let tries = 1; ; tries++) {
        outcome = await releaseAgent(caller, userId, {
          agentId,
          version,
          connectionId,
          active: running,
          expectedActivationRevision: expectedRevision,
          intent: {
            kind: "save",
            behaviorRevision: saved.behaviorRevision,
            draftVersionId: saved.versionId,
          },
          reason:
            active && connectionId !== active.connection_id
              ? "connection_changed"
              : "card_saved",
        });
        if (outcome.status !== "retry") break;
        if (tries >= MAX_SAVE_ATTEMPTS) {
          outcome = { status: "failed", reason: "revision_conflict" };
          break;
        }
        const moved = await store.get(caller.ownerId, agentId);
        if (!moved) throw NOT_FOUND();
        running = moved.active_release;
        expectedRevision = moved.agent.activation_revision;
      }
      let release: SaveRelease;
      if (outcome.status === "failed") {
        const kept = await store.recordDraftFailure({
          workspaceId: caller.ownerId,
          agentId,
          behaviorRevision: saved.behaviorRevision,
          draftVersionId: saved.versionId,
          failure: outcome.reason,
        });
        release = kept
          ? {
              status: "failed",
              reason: outcome.reason,
              release_id: null,
              version_id: saved.versionId,
            }
          : {
              status: "superseded",
              reason: null,
              release_id: null,
              version_id: saved.versionId,
            };
      } else if (outcome.status === "applied") {
        release = {
          status: "applied",
          reason: null,
          release_id: outcome.releaseId,
          version_id: saved.versionId,
        };
      } else {
        release = {
          status: "superseded",
          reason: null,
          release_id: null,
          version_id: saved.versionId,
        };
      }
      const fresh = await store.get(caller.ownerId, agentId);
      if (!fresh) throw NOT_FOUND();
      return done(fresh, release);
    }
  }

  const resolveRelease = (workspaceId: string, releaseId: string) =>
    resolveAgentRelease({ store, catalog }, workspaceId, releaseId);

  // The person a model migration acts for must still be an owner or admin; a
  // team right left over from a demotion is not enough.
  const ROLLOUT_ROLES: readonly WorkspaceRole[] = ["owner", "admin"];

  const migrationPrincipal = (
    workspaceId: string,
    actorUserId: string,
  ): Principal => ({
    ownerId: workspaceId,
    actor: {
      principal: { kind: "user", id: actorUserId },
      userId: actorUserId,
      workspaceId,
      apiKeyId: null,
    },
  });

  async function migrateModel(input: {
    workspaceId: string;
    agentId: string;
  }): Promise<ModelMoveStep> {
    const { workspaceId, agentId } = input;
    let move: {
      from: string;
      to: string;
      releaseId: string;
      revision: number;
    } | null = null;
    try {
      const record = await store.get(workspaceId, agentId);
      const active = record?.active_release ?? null;
      if (!record || !active) return { status: "skipped" };
      const from = releaseModel(active);
      if (from === undefined) return { status: "skipped" };
      const connection = connectionOf(catalog, active.connection_id);
      if (connection === undefined) return { status: "skipped" };
      const to = modelSuccessor(connection, from);
      if (to === null) return { status: "skipped" };
      const found = {
        from,
        to,
        releaseId: active.id,
        revision: record.agent.activation_revision,
      };
      move = found;
      const failed = (reason: string): ModelMoveStep => ({
        status: "failed",
        reason,
        ...found,
      });
      const actorUserId =
        (await store.activationActor(workspaceId, agentId, active.id)) ??
        active.approved_by;
      if (actorUserId === null) return failed("actor_inactive");
      const principal = migrationPrincipal(workspaceId, actorUserId);
      const activeVersion = record.versions.find(
        (version) => version.id === active.version_id,
      );
      if (!activeVersion) return failed("release_refused");
      const card = { ...activeVersion.card, model: to };
      const contentSha256 = cardContentSha256(card);
      const saved = await store.update({
        principal,
        workspaceId,
        agentId,
        card: { card, contentSha256 },
        updatedBy: actorUserId,
        managerRoles: AGENT_MANAGERS,
        requireRoles: ROLLOUT_ROLES,
      });
      if (saved.outcome === "stale") return { status: "superseded" };
      if (saved.outcome === "not_found") return { status: "skipped" };
      if (saved.outcome !== "updated") return failed("actor_inactive");
      const version = saved.detail.versions.find(
        (candidate) => candidate.content_sha256 === contentSha256,
      );
      if (!version) throw new Error("a model-only card version is stored");
      const outcome = await releaseAgent(principal, actorUserId, {
        agentId,
        version,
        connectionId: active.connection_id,
        active,
        expectedActivationRevision: record.agent.activation_revision,
        intent: {
          kind: "model_migration",
          expected: {
            activeReleaseId: active.id,
            activationRevision: record.agent.activation_revision,
            behaviorRevision: record.behavior_revision,
          },
          from,
          to,
        },
        reason: "model_migration",
        requireRoles: ROLLOUT_ROLES,
      });
      if (outcome.status === "applied") return { status: "applied", from, to };
      if (outcome.status === "failed") return failed(outcome.reason);
      return { status: "superseded" };
    } catch (error) {
      if (error instanceof SessionServiceError) {
        if (error.code === "NOT_FOUND") return { status: "skipped" };
        if (error.code === "FORBIDDEN" && move !== null) {
          return { status: "failed", reason: "actor_inactive", ...move };
        }
      }
      throw error;
    }
  }

  return {
    resolveRelease,
    notRunnableReason: (
      workspaceId: string,
      release: Pick<AgentRelease, "agent_id" | "approved_at">,
    ) => releaseNotRunnableReason(store, workspaceId, release),
    migrateModel,
    envNames: (workspaceId: string, releaseId: string) =>
      agentEnvNames(store, workspaceId, releaseId),

    async listAgents(
      caller: Caller,
      query: ListAgentsQuery,
    ): Promise<ListAgentsResponse> {
      if (caller.actor?.principal.kind === "api_key") {
        return keysOwnAgent(caller, query);
      }
      const reader = await agentReader(caller);
      const page = await store.list(caller.ownerId, query, reader);
      if (query.include !== "summary") return page;
      // The store leaves out each agent whose settings the caller may not
      // read; that row goes without a summary. Sessions are counted only
      // where the caller could list them.
      const summaries = await store.summaries(
        caller.ownerId,
        page.items.map((agent) => agent.id),
        viewerOf(caller),
      );
      return {
        ...page,
        items: page.items.map((agent) => {
          const summary = summaries.get(agent.id);
          return summary ? { ...agent, summary } : agent;
        }),
      };
    },

    /** The enabled connections a release may name, with their models. */
    async listConnections(
      caller: Caller,
    ): Promise<ListConnectionOptionsResponse> {
      await agentReader(caller);
      return {
        items: Object.entries(catalog.connections)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, connection]) => ({
            id,
            kind: connection.provider.kind,
            billing:
              connection.provider.billing === "none" ? "none" : "metered",
            models: connectionModels(connection),
            model_successors: Object.fromEntries(
              modelMoves(connection).map(({ from, to }) => [from, to]),
            ),
          })),
      };
    },

    /**
     * The agents the caller could start a session with now (94S-902): the
     * scope check of a start, then the store's usage predicate, then the
     * checks a start makes on the release itself (its connection still in
     * the catalog and its spec verified, every credential bound). A start refused for
     * any of them is not listed.
     */
    async listUsableAgents(caller: Caller): Promise<ListUsableAgentsResponse> {
      const keyAgentId = caller.actor?.agentId ?? null;
      await requirePermitted(authorization, caller, "session.submit", {
        kind: "session",
        id: null,
        ...(keyAgentId === null ? {} : { agent_id: keyAgentId }),
      });
      const candidates = await store.listUsable(
        caller.ownerId,
        {
          userId: caller.actor?.userId ?? null,
          keyAgentId,
          outsideUse: (await outsideAgents.access(caller.ownerId)) === "use",
        },
        TEAM_LIST_LIMIT,
      );
      const items: UsableAgent[] = [];
      for (const agent of candidates) {
        const releaseId = agent.active_release_id;
        if (releaseId === null) continue;
        try {
          await resolveAgentRelease(
            { store, catalog },
            caller.ownerId,
            releaseId,
          );
        } catch (error) {
          if (error instanceof SessionServiceError) continue;
          throw error;
        }
        if ((await credentials.unboundRefs(caller.ownerId, releaseId)).length) {
          continue;
        }
        items.push({
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          description: agent.description,
          managing_team_name: agent.managing_team_name,
          active_release_id: releaseId,
        });
      }
      return { items };
    },

    async countAgents(caller: Caller): Promise<CountAgentsResponse> {
      return {
        counts: await store.count(caller.ownerId, await agentReader(caller)),
      };
    },

    async getAgent(caller: Caller, agentId: string): Promise<AgentDetail> {
      await requirePermitted(authorization, caller, "agent.settings_read", {
        kind: "agent",
        id: agentId,
      });
      const detail = await store.get(caller.ownerId, agentId);
      if (!detail) throw NOT_FOUND();
      return withBehavior(detail);
    },

    async createAgent(
      caller: Caller,
      request: CreateAgentRequest,
    ): Promise<SaveAgentResponse> {
      // Any member may; the store makes them the agent's admin (D3).
      const userId = await onWorkspace(caller, "agent.create");
      assertDeclaredEnvNames(request.card);
      const card = request.card;
      const result = await store.create({
        principal: caller,
        workspaceId: caller.ownerId,
        slug: request.slug,
        name: request.name,
        ...(request.description === undefined
          ? {}
          : { description: request.description }),
        managingTeam: {
          id: request.managing_team_id,
          managerRoles: TEAM_ASSIGNERS,
        },
        card,
        contentSha256: cardContentSha256(card),
        createdBy: userId,
      });
      switch (result.outcome) {
        case "slug_taken":
          throw new SessionServiceError(
            "ALREADY_EXISTS",
            `An agent with slug ${request.slug} already exists`,
          );
        case "team_not_found":
          throw TEAM_NOT_FOUND();
        case "team_not_allowed":
          throw TEAM_NOT_ALLOWED();
        case "team_holding":
          throw TEAM_HOLDING();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          if (request.connection_id === undefined) {
            return {
              ...withBehavior(result.detail),
              release: {
                status: "unchanged",
                reason: null,
                release_id: null,
                version_id: result.detail.versions.at(-1)?.id ?? null,
              },
            };
          }
          return saveAgent(caller, userId, result.detail.agent.id, {
            card,
            connection_id: request.connection_id,
          });
      }
    },

    async updateAgent(
      caller: Caller,
      agentId: string,
      request: UpdateAgentRequest,
    ): Promise<SaveAgentResponse> {
      const userId = await manageAgent(caller, agentId);
      return saveAgent(caller, userId, agentId, {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined
          ? {}
          : { description: request.description }),
        ...(request.auto_model_migration === undefined
          ? {}
          : { auto_model_migration: request.auto_model_migration }),
        ...(request.card === undefined ? {} : { card: request.card }),
        ...(request.connection_id === undefined
          ? {}
          : { connection_id: request.connection_id }),
      });
    },

    async createRelease(
      caller: Caller,
      agentId: string,
      request: CreateAgentReleaseRequest,
    ): Promise<CreateAgentReleaseResponse> {
      const userId = await manageAgent(caller, agentId);
      const version = await store.findVersion(
        caller.ownerId,
        agentId,
        request.version_id,
      );
      if (!version) throw NOT_FOUND();
      // Checked ahead of the other refusals so it is the answer; the store
      // checks again under the agent's lock against a concurrent first save.
      if (
        request.github !== undefined &&
        (await store.hasGitHubSettings(agentId))
      ) {
        throw githubSettingsOwned();
      }
      const run = usableRun(request.connection_id);
      const repositoryId = request.repository_id ?? null;
      const refused = releaseRepositoryRefusal(repositoryId);
      if (refused !== null) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `repository_id: ${refused}`,
        );
      }
      const resolved = resolveReleaseContent(
        version.card,
        run,
        catalog.mcp_servers,
      );
      if (!resolved.ok) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `${resolved.error.field}: ${resolved.error.message}`,
        );
      }
      // A release made from a card edit keeps the GitHub settings of the
      // active one, so the edit cannot drop them. An agent with its own
      // settings row has no release pins to keep: the row decides. Kept
      // settings are checked as sent ones are: the edit may move the release
      // to another repository.
      const github =
        request.github ??
        ((await store.hasGitHubSettings(agentId))
          ? undefined
          : (await store.get(caller.ownerId, agentId))?.active_release
              ?.policy_pins.github);
      if (github !== undefined) {
        await checkGitHub(caller.ownerId, repositoryId, github);
      }
      const identity = {
        // As stored: PostgreSQL returns a uuid in lower case.
        agent_id: version.agent_id,
        card_sha256: version.content_sha256,
        repository_id: repositoryId,
        ...resolved.content,
        policy_pins: {
          ...resolved.content.policy_pins,
          ...(github === undefined ? {} : { github }),
        },
      };
      const result = await store.insertRelease({
        principal: caller,
        workspaceId: caller.ownerId,
        managerRoles: AGENT_MANAGERS,
        refuseGitHubWhenSettings: request.github !== undefined,
        reason: "direct",
        release: {
          id: deriveReleaseId(identity),
          version_id: version.id,
          created_by: userId,
          note: request.note ?? null,
          ...identity,
          spec: specOf(deriveReleaseId(identity), identity, run),
        },
      });
      switch (result.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "github_settings_exist":
          throw githubSettingsOwned();
        default:
          assertReleaseIdentity(result.release);
          return {
            release: result.release,
            created: result.outcome === "created",
          };
      }
    },

    async activateAgent(
      caller: Caller,
      agentId: string,
      request: ActivateAgentRequest,
    ): Promise<ActivateAgentResponse> {
      const userId = await manageAgent(caller, agentId);
      const release = await resolveRelease(caller.ownerId, request.release_id);
      if (release.agent_id !== agentId.toLowerCase()) throw NOT_FOUND();
      // A release can predate the reserved list; its card is judged now.
      const version = await store.findVersion(
        caller.ownerId,
        release.agent_id,
        release.version_id,
      );
      if (version) assertDeclaredEnvNames(version.card);
      // Checked again when each session starts, so a binding revoked after
      // this point stops the next session rather than this activation.
      const missing = await credentials.unboundRefs(caller.ownerId, release.id);
      if (missing.length > 0) {
        const details: ActivationCredentialUnboundDetails = {
          reason_code: "credential_unbound",
          missing,
        };
        throw new SessionServiceError(
          "CREDENTIAL_UNBOUND",
          `Release ${release.id} uses credentials not bound to this agent: ${missing.join(", ")}`,
          undefined,
          details,
        );
      }
      const snapshotRuntime = release.runtime_config_snapshot.runtime as
        | ReleaseRun["runtime"]
        | undefined;
      const extensions = snapshotRuntime
        ? await extensionRefusal(caller.ownerId, release.agent_id, {
            runtime: snapshotRuntime,
            tools: release.effective_tools.tools,
          })
        : null;
      if (extensions !== null) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          extensions.message,
          undefined,
          { reason_code: extensions.code, bundle: extensions.name },
        );
      }
      const result = await store.activate({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        releaseId: release.id,
        expectedRevision: request.expected_revision,
        approvedBy: userId,
        managerRoles: AGENT_MANAGERS,
        // A person's own activation, a rollback included: it takes a new
        // behavior revision.
        intent: { kind: "direct" },
        reason: "direct",
      });
      switch (result.outcome) {
        case "superseded":
          throw new Error("a direct activation was superseded");
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `Activation revision is ${result.revision}, not ${request.expected_revision}`,
          );
        case "unchanged":
          return {
            active_release_id: release.id,
            previous_release_id: null,
            activation_revision: result.revision,
            receipt_id: null,
          };
        default:
          await deps.welcome?.activated(caller.ownerId, agentId, release.id);
          return {
            active_release_id: release.id,
            previous_release_id: result.previousReleaseId,
            activation_revision: result.revision,
            receipt_id: result.receiptId,
          };
      }
    },
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
