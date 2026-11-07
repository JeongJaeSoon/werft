import type {
  CountAgentsResponse,
  CreateAgentReleaseRequest,
  CreateAgentReleaseResponse,
  CreateAgentRequest,
  ListAgentsQuery,
  ListAgentsResponse,
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
  GITHUB_CEILING_NONE,
  type GitHubRefusal,
  githubFeaturesOverCeiling,
  type ModelSource,
  type SaveAgentResponse,
  type SaveRelease,
  type WorkspaceRole,
} from "@werft-ai/contracts";
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
  TEAM_NOT_ALLOWED,
  TEAM_NOT_FOUND,
} from "../musterrolle/service-errors.ts";
import type { SlackWelcome } from "../musterrolle/slack-welcome.ts";
import type {
  ActivationIntent,
  AgentReader,
  AgentRecord,
  AgentStore,
  ReleaseReason,
} from "../ports/agent-store.ts";
import type { WorkspaceKeyStore } from "../ports/api-key-store.ts";
import type { CredentialBindingStore } from "../ports/credential-binding-store.ts";
import type { GitHubSettingsStore } from "../ports/github-settings.ts";
import type { ProfileRolloutStore } from "../ports/profile-rollout-store.ts";
import {
  acceptedRuntimeVersions,
  allowedPair,
  allowedRun,
  type CatalogProfile,
  catalogProfile,
  profileModels,
  profilePinned,
  refreshWorkspaceProfilesFor,
  repositoryModeOf,
  type SessionCatalog,
  type SessionCatalogView,
  workspaceProfileRefusal,
} from "../sessions/catalog.ts";
import type { AgentPromptIdentity } from "../sessions/platform-prompt.ts";
import { sameExecutionForm } from "../sessions/profile-execution-form.ts";
import {
  profileBlockedError,
  requirePermitted,
  SessionServiceError,
  viewerOf,
} from "../sessions/session-service.ts";
import {
  assertReleaseIdentity,
  cardContentSha256,
  deriveReleaseId,
  releaseModel,
  resolveReleaseContent,
} from "./release-ids.ts";

/**
 * The release a session pins, refused when the catalog no longer runs its
 * profile as it was released. Reads no credential value.
 */
export async function resolveAgentRelease(
  deps: {
    store: Pick<AgentStore, "findRelease">;
    catalog: Pick<
      SessionCatalogView,
      "profiles" | "workspace_profiles" | "runtime_versions"
    >;
  },
  workspaceId: string,
  releaseId: string,
): Promise<AgentRelease> {
  const release = await deps.store.findRelease(workspaceId, releaseId);
  if (!release) throw NOT_FOUND();
  assertReleaseIdentity(release);
  const profileId = release.runtime_profile_id;
  await refreshWorkspaceProfilesFor(deps.catalog, [profileId]);
  const refusal = workspaceProfileRefusal(
    deps.catalog,
    workspaceId,
    profileId,
    { retiredAllowed: true },
  );
  const blocked = profileBlockedError(profileId, refusal);
  if (blocked) throw blocked;
  const profile =
    refusal === null ? catalogProfile(deps.catalog, profileId) : undefined;
  if (!profile) {
    throw new SessionServiceError(
      "PROFILE_DIGEST_MISMATCH",
      `Runtime profile ${profileId} of this release is not in this host's catalog; release the version again under a profile the catalog has`,
    );
  }
  const model = releaseModel(release);
  if (
    !profilePinned(
      profile,
      release.profile_digest,
      acceptedRuntimeVersions(deps.catalog),
    ) ||
    (model !== undefined && !profileModels(profile).includes(model))
  ) {
    throw new SessionServiceError(
      "PROFILE_DIGEST_MISMATCH",
      `Runtime profile ${release.runtime_profile_id} changed since this release; release the version again`,
    );
  }
  return release;
}

/** The agent a session of this release introduces itself as, read now. */
export async function agentPromptIdentity(
  store: Pick<AgentStore, "findRelease" | "get" | "findVersion">,
  workspaceId: string,
  releaseId: string,
): Promise<AgentPromptIdentity | null> {
  const release = await store.findRelease(workspaceId, releaseId);
  if (!release) return null;
  const [detail, version] = await Promise.all([
    store.get(workspaceId, release.agent_id),
    store.findVersion(workspaceId, release.agent_id, release.version_id),
  ]);
  if (!detail || !version) return null;
  return {
    name: detail.agent.name,
    description: detail.agent.description,
    language: version.card.language,
  };
}

export function createAgentService(deps: {
  authorization: AuthorizationPolicy;
  store: AgentStore;
  catalog: SessionCatalog;
  credentials: Pick<CredentialBindingStore, "unboundRefs">;
  /** The home channel's welcome; absent where Slack is not wired. */
  welcome?: Pick<SlackWelcome, "activated">;
  /** Where an agent key's agent is read; absent, every key is refused. */
  keys?: Pick<WorkspaceKeyStore, "find">;
  /** The ceiling a release's `github` is checked against; absent: all off. */
  githubSettings?: Pick<GitHubSettingsStore, "get">;
  /** Axis A, as the policy reads it; absent: `use`. */
  outsideAgents?: OutsideAgentAccessSetting;
  /** Where a profile's newest version is read; absent: no agent is pinned. */
  profileLineage?: Pick<ProfileRolloutStore, "inspect">;
}) {
  const { authorization, store, catalog, credentials } = deps;
  const outsideAgents = deps.outsideAgents ?? outsideAgentsUse;
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
   * repositories its profile allows, the release's own among them, no
   * allow-list without Actions, nothing over the workspace's ceiling. The
   * gate cuts the release down again at every token issue.
   */
  async function checkGitHub(
    ownerId: string,
    profileId: string,
    profile: CatalogProfile,
    repositoryId: string | null,
    github: AgentGitHub,
  ): Promise<void> {
    // A release without a repository on an `optional` profile attaches
    // them (session-repository-attachment.md decision 4); `none` never does.
    if (repositoryModeOf(profile) === "none") {
      throw githubInvalid("github", "repository_none");
    }
    for (const [index, id] of github.repositories.entries()) {
      const field = `github.repositories.${index}`;
      const pair = allowedPair(catalog, profileId, id);
      if (pair === null) throw githubInvalid(field, "repository_not_allowed");
      // A PAT cannot be narrowed to a permission set.
      if (pair.repository.auth?.kind !== "github_app") {
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
    profileId: string,
    profile: CatalogProfile,
    repositoryId: string | null,
  ): string | null {
    if (allowedRun(catalog, profileId, repositoryId) !== null) return null;
    const mode = repositoryModeOf(profile);
    if (mode === "required" && repositoryId === null) {
      return `Profile ${profileId} needs a repository: send repository_id`;
    }
    if (mode === "none" && repositoryId !== null) {
      return `Profile ${profileId} runs without a repository: omit repository_id`;
    }
    return `Repository ${repositoryId} is not in the catalog or does not allow profile ${profileId}`;
  }

  async function usableProfile(
    workspaceId: string,
    profileId: string,
  ): Promise<CatalogProfile> {
    await refreshWorkspaceProfilesFor(catalog, [profileId], { strict: true });
    const workspaceRefusal = workspaceProfileRefusal(
      catalog,
      workspaceId,
      profileId,
    );
    if (workspaceRefusal !== null) {
      throw (
        profileBlockedError(profileId, workspaceRefusal) ??
        new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          workspaceRefusal.message,
          undefined,
          { reason_code: workspaceRefusal.state },
        )
      );
    }
    const profile = catalogProfile(catalog, profileId);
    if (!profile) {
      throw new SessionServiceError(
        "UNSUPPORTED_CAPABILITY",
        `Unknown runtime_profile_id ${profileId}`,
        undefined,
        { reason_code: "profile_unknown" },
      );
    }
    return profile;
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
      (query.runtime_profile_id === undefined ||
        detail.active_release?.runtime_profile_id ===
          query.runtime_profile_id) &&
      (query.managing_team === undefined || own.managing_team_id === null);
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
      profileId: string;
      /** The active release the save was read from. */
      active: AgentRelease | null;
      expectedActivationRevision: number;
      intent: Exclude<ActivationIntent, { kind: "direct" }>;
      reason: ReleaseReason;
      requireRoles?: readonly WorkspaceRole[];
    },
  ): Promise<ReleaseOutcome> {
    const { version, profileId, active } = input;
    const failed = (reason: string): ReleaseOutcome => ({
      status: "failed",
      reason,
    });
    let profile: CatalogProfile;
    try {
      profile = await usableProfile(caller.ownerId, profileId);
    } catch (error) {
      const reason = refusalCode(error);
      if (reason === null) throw error;
      return failed(reason);
    }
    // An agent with a settings row has the row decide, and its release has
    // no GitHub pin or repository. One without keeps the active release's,
    // which only a `none` profile has no use for (design 3.5).
    const hasRow = await store.hasGitHubSettings(input.agentId);
    const carry = !hasRow && repositoryModeOf(profile) !== "none";
    const repositoryId = carry ? (active?.repository_id ?? null) : null;
    const github = carry ? active?.policy_pins.github : undefined;
    if (
      allowedRun(
        catalog,
        profileId,
        repositoryId,
        hasRow ? "agent" : "release",
      ) === null
    ) {
      return failed("release_refused");
    }
    if (github !== undefined) {
      try {
        await checkGitHub(
          caller.ownerId,
          profileId,
          profile,
          repositoryId,
          github,
        );
      } catch (error) {
        const reason = refusalCode(error);
        if (reason === null) throw error;
        return failed(reason);
      }
    }
    const resolved = resolveReleaseContent(
      version.card,
      profileId,
      profile,
      catalog.mcp_servers,
    );
    if (!resolved.ok) {
      return failed(
        resolved.error.field === "card.model"
          ? "model_not_in_profile"
          : resolved.error.field === "card.capabilities.tools"
            ? "tool_not_in_profile"
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
        id: deriveReleaseId(identity),
        version_id: version.id,
        created_by: userId,
        note: null,
        ...identity,
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
    const releaseId = inserted.release.id;
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

  function behaviorValues(
    profileId: string,
    card: AgentCard,
    model: string,
    modelSource: ModelSource,
  ): BehaviorValues {
    return {
      runtime_profile_id: profileId,
      model,
      model_source: modelSource,
      title_model: catalogProfile(catalog, profileId)?.title_model ?? null,
      agent_instructions: card.agent_instructions ?? null,
    };
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
                active.runtime_profile_id,
                activeCard,
                releaseModel(active) ?? activeCard.model,
                record.model_source,
              )
            : null,
        draft:
          draft && draftCard
            ? behaviorValues(
                draft.runtime_profile_id,
                draftCard,
                draftCard.model,
                draft.model_source,
              )
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
      card?: AgentCard;
      runtime_profile_id?: string;
      model_source?: ModelSource;
    },
  ): Promise<SaveAgentResponse> {
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
      fields.card !== undefined ||
      fields.runtime_profile_id !== undefined ||
      fields.model_source !== undefined;
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
      const profileId =
        fields.runtime_profile_id ??
        active?.runtime_profile_id ??
        draft?.runtime_profile_id ??
        null;
      if (!asked || profileId === null || base === undefined) {
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
      await refreshWorkspaceProfilesFor(catalog, [profileId], { strict: true });
      const profile = catalogProfile(catalog, profileId);
      const runningModel = releaseModel(active);
      // A save that names no source keeps the current one while it keeps the
      // running model, and is a person's own choice of model otherwise. An
      // agent with nothing running follows its profile (design 2.6).
      const modelSource: ModelSource =
        fields.model_source ??
        (active
          ? base.model === runningModel
            ? record.model_source
            : "fixed"
          : (draft?.model_source ?? "profile"));
      // The card's model is the model it runs, so a followed profile's
      // default is written into the card before it is hashed.
      const card =
        modelSource === "profile" && profile
          ? { ...base, model: profile.model }
          : base;
      const explicit =
        fields.card !== undefined &&
        fields.runtime_profile_id !== undefined &&
        fields.model_source !== undefined;
      const result = await store.update({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        ...identity,
        card: { card, contentSha256: cardContentSha256(card) },
        behavior: {
          runtimeProfileId: profileId,
          modelSource,
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
          profileId,
          active: running,
          expectedActivationRevision: expectedRevision,
          intent: {
            kind: "save",
            behaviorRevision: saved.behaviorRevision,
            draftVersionId: saved.versionId,
            modelSource,
          },
          reason:
            active && profileId !== active.runtime_profile_id
              ? "profile_changed"
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

  async function followLatestProfile(
    caller: Caller,
    userId: string,
    agentId: string,
  ): Promise<SaveAgentResponse> {
    const record = await store.get(caller.ownerId, agentId);
    if (!record) throw NOT_FOUND();
    const active = record.active_release;
    const seen =
      active === null || deps.profileLineage === undefined
        ? null
        : await deps.profileLineage.inspect({
            agentId,
            targetProfileId: active.runtime_profile_id,
            activeProfileId: active.runtime_profile_id,
          });
    if (active === null || seen === null || seen.latest === null) {
      throw new SessionServiceError(
        "BAD_REQUEST",
        "The agent runs no profile that has a newer version",
        undefined,
        { reason_code: "no_profile_lineage" },
      );
    }
    const answer = (
      fresh: AgentRecord,
      release: SaveRelease,
    ): SaveAgentResponse => ({ ...withBehavior(fresh), release });
    const version_id = null;
    let release: SaveRelease;
    if (seen.latest.id !== active.runtime_profile_id) {
      // Not a save: the agent's draft is neither read nor replaced.
      const outcome = await rolloutRelease({
        workspaceId: caller.ownerId,
        agentId,
        actorUserId: userId,
        targetProfileId: seen.latest.id,
        raise: {
          principal: caller,
          // What the lineage check above was judged on.
          seen: {
            activationRevision: record.agent.activation_revision,
            behaviorRevision: record.behavior_revision,
          },
        },
      });
      release =
        outcome.status === "applied"
          ? {
              status: "applied",
              reason: null,
              release_id: outcome.releaseId,
              version_id,
            }
          : outcome.status === "failed"
            ? {
                status: "failed",
                reason: outcome.reason,
                release_id: null,
                version_id,
              }
            : {
                status: outcome.status === "retry" ? "failed" : "superseded",
                reason: outcome.status === "retry" ? "revision_conflict" : null,
                release_id: null,
                version_id,
              };
    } else {
      const followed = await store.followProfile({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        expectedActivationRevision: record.agent.activation_revision,
        managerRoles: AGENT_MANAGERS,
      });
      if (followed.outcome === "not_found") throw NOT_FOUND();
      if (followed.outcome === "actor_inactive") throw ACTOR_INACTIVE();
      if (followed.outcome === "outranked") throw OUTRANKED();
      release = {
        status: followed.outcome === "superseded" ? "superseded" : "unchanged",
        reason: null,
        release_id: null,
        version_id,
      };
    }
    const fresh = await store.get(caller.ownerId, agentId);
    if (!fresh) throw NOT_FOUND();
    return answer(fresh, release);
  }

  const resolveRelease = (workspaceId: string, releaseId: string) =>
    resolveAgentRelease({ store, catalog }, workspaceId, releaseId);

  // Going back to a release whose profile runs differently from the newest
  // version of its lineage ends the agent's following (design 2.4).
  async function runsBehindLineage(
    agentId: string,
    release: AgentRelease,
  ): Promise<boolean> {
    if (deps.profileLineage === undefined) return false;
    const seen = await deps.profileLineage.inspect({
      agentId,
      targetProfileId: release.runtime_profile_id,
      activeProfileId: release.runtime_profile_id,
    });
    return (
      seen.latest !== null &&
      seen.active !== null &&
      !sameExecutionForm(seen.active.definition, seen.latest.definition)
    );
  }

  // The person a rollout acts for must still be an owner or admin; a team
  // right left over from a demotion is not enough (design 2.3).
  const ROLLOUT_ROLES: readonly WorkspaceRole[] = ["owner", "admin"];

  /**
   * One agent's step of a profile rollout (design 2.3): the agent's release
   * moved to the newest version of the profile, on its own card, or on a
   * card whose model is the profile's new default when the agent follows
   * that. Judged again under the agent's lock; a refusal, including a
   * person who lost their role, is an outcome for the item.
   */
  async function rolloutRelease(input: {
    workspaceId: string;
    agentId: string;
    actorUserId: string | null;
    targetProfileId: string;
    /** A person's own request: their principal and agent-manager rights, not a rollout's. */
    raise?: {
      principal: Principal;
      /** The revisions the caller decided on; a rollback since then must not be overwritten. */
      seen: { activationRevision: number; behaviorRevision: number };
    };
  }): Promise<ReleaseOutcome> {
    const { workspaceId, agentId, actorUserId, targetProfileId, raise } = input;
    if (actorUserId === null)
      return { status: "failed", reason: "actor_inactive" };
    const principal: Principal = raise?.principal ?? {
      ownerId: workspaceId,
      actor: {
        principal: { kind: "user", id: actorUserId },
        userId: actorUserId,
        workspaceId,
        apiKeyId: null,
      },
    };
    const roles = raise ? {} : { requireRoles: ROLLOUT_ROLES };
    try {
      const record = await store.get(workspaceId, agentId);
      const active = record?.active_release ?? null;
      if (!record || !active) return { status: "superseded" };
      if (
        raise &&
        (record.agent.activation_revision !== raise.seen.activationRevision ||
          record.behavior_revision !== raise.seen.behaviorRevision)
      ) {
        return { status: "retry" };
      }
      const activeVersion = record.versions.find(
        (version) => version.id === active.version_id,
      );
      if (!activeVersion)
        return { status: "failed", reason: "release_refused" };
      let profile: CatalogProfile;
      try {
        profile = await usableProfile(workspaceId, targetProfileId);
      } catch (error) {
        if (refusalCode(error) === null) throw error;
        return { status: "failed", reason: "profile_unusable" };
      }
      let version = activeVersion;
      if (
        record.model_source === "profile" &&
        activeVersion.card.model !== profile.model
      ) {
        const card = { ...activeVersion.card, model: profile.model };
        const contentSha256 = cardContentSha256(card);
        const saved = await store.update({
          principal,
          workspaceId,
          agentId,
          card: { card, contentSha256 },
          updatedBy: actorUserId,
          managerRoles: AGENT_MANAGERS,
          ...roles,
        });
        if (saved.outcome === "stale") return { status: "retry" };
        if (saved.outcome === "not_found") return { status: "superseded" };
        if (saved.outcome !== "updated") {
          return { status: "failed", reason: "actor_inactive" };
        }
        const written = saved.detail.versions.find(
          (candidate) => candidate.content_sha256 === contentSha256,
        );
        if (!written) throw new Error("a model-only card version is stored");
        version = written;
      }
      return await releaseAgent(principal, actorUserId, {
        agentId,
        version,
        profileId: targetProfileId,
        active,
        expectedActivationRevision:
          raise?.seen.activationRevision ?? record.agent.activation_revision,
        intent: {
          kind: raise ? "raise" : "rollout",
          behaviorRevision:
            raise?.seen.behaviorRevision ?? record.behavior_revision,
          targetProfileId,
        },
        reason: "profile_rollout",
        ...roles,
      });
    } catch (error) {
      if (error instanceof SessionServiceError) {
        if (error.code === "FORBIDDEN") {
          return { status: "failed", reason: "actor_inactive" };
        }
        if (error.code === "NOT_FOUND") return { status: "superseded" };
      }
      throw error;
    }
  }

  return {
    resolveRelease,
    rolloutRelease,
    promptIdentity: (workspaceId: string, releaseId: string) =>
      agentPromptIdentity(store, workspaceId, releaseId),

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
      let card = request.card;
      if (
        request.runtime_profile_id !== undefined &&
        (request.model_source ?? "profile") === "profile"
      ) {
        await refreshWorkspaceProfilesFor(
          catalog,
          [request.runtime_profile_id],
          {
            strict: true,
          },
        );
        const profile = catalogProfile(catalog, request.runtime_profile_id);
        if (profile) card = { ...card, model: profile.model };
      }
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
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          if (request.runtime_profile_id === undefined) {
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
            runtime_profile_id: request.runtime_profile_id,
            ...(request.model_source === undefined
              ? {}
              : { model_source: request.model_source }),
          });
      }
    },

    async updateAgent(
      caller: Caller,
      agentId: string,
      request: UpdateAgentRequest,
    ): Promise<SaveAgentResponse> {
      const userId = await manageAgent(caller, agentId);
      if (request.follow_latest_profile === true) {
        return followLatestProfile(caller, userId, agentId);
      }
      return saveAgent(caller, userId, agentId, {
        ...(request.name === undefined ? {} : { name: request.name }),
        ...(request.description === undefined
          ? {}
          : { description: request.description }),
        ...(request.card === undefined ? {} : { card: request.card }),
        ...(request.runtime_profile_id === undefined
          ? {}
          : { runtime_profile_id: request.runtime_profile_id }),
        ...(request.model_source === undefined
          ? {}
          : { model_source: request.model_source }),
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
      const profileId = request.runtime_profile_id;
      const profile = await usableProfile(caller.ownerId, profileId);
      const repositoryId = request.repository_id ?? null;
      const refused = releaseRepositoryRefusal(
        profileId,
        profile,
        repositoryId,
      );
      if (refused !== null) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `repository_id: ${refused}`,
        );
      }
      const resolved = resolveReleaseContent(
        version.card,
        profileId,
        profile,
        catalog.mcp_servers,
      );
      if (!resolved.ok) {
        throw new SessionServiceError(
          "UNSUPPORTED_CAPABILITY",
          `${resolved.error.field}: ${resolved.error.message}`,
        );
      }
      // A release made from a card edit keeps the GitHub settings of the
      // active one, so the edit cannot drop them. One on a `none` profile has
      // nothing for them to act on, and an agent with its own settings row
      // has no release pins to keep: the row decides. Kept settings are
      // checked as sent ones are: the edit may move the release to another
      // repository.
      const github =
        request.github ??
        (repositoryModeOf(profile) === "none" ||
        (await store.hasGitHubSettings(agentId))
          ? undefined
          : (await store.get(caller.ownerId, agentId))?.active_release
              ?.policy_pins.github);
      if (github !== undefined) {
        await checkGitHub(
          caller.ownerId,
          profileId,
          profile,
          repositoryId,
          github,
        );
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
      const result = await store.activate({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        releaseId: release.id,
        expectedRevision: request.expected_revision,
        approvedBy: userId,
        managerRoles: AGENT_MANAGERS,
        // A person's own activation, a rollback included: it takes a new
        // behavior revision, and the model source follows design 2.4.
        intent: {
          kind: "direct",
          releaseRunsProfileDefault:
            releaseModel(release) ===
            catalogProfile(catalog, release.runtime_profile_id)?.model,
          pinsProfile: await runsBehindLineage(agentId, release),
        },
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
