import type { GitHubPolicySource } from "@werft-ai/contracts";
import { installationProfileId } from "@werft-ai/contracts";
import type { WorkspaceProfileRecord } from "./catalog.ts";
import {
  type CatalogProfileView,
  derivationPolicyOf,
  type ProfileLookup,
  usesWorkspaceCeiling,
  workspaceProfileState,
} from "./catalog.ts";
import { sameExecutionForm } from "./profile-execution-form.ts";
import { definitionFingerprint } from "./profile-registry.ts";

export const MIGRATION_RECENT_DAYS = 30;

export type MigrationAgentFact = {
  agentId: string;
  workspaceId: string;
  activeReleaseId: string | null;
  activeProfileId: string | null;
  activationRevision: number;
  behaviorRevision: number;
  tracking: "follow" | "pinned";
  modelSource: "fixed" | "profile";
  draftVersionId: string | null;
  hasSettingsRow: boolean;
  releaseRepositoryId: string | null;
  pinnedRepositories: readonly string[];
  /** The repositories the agent's own settings row lists; empty without a row. */
  settingsRepositories?: readonly string[];
  toolsBefore: readonly string[];
};

export type MigrationRepositoryFact = {
  id: string;
  authKind: string;
  removed: boolean;
};

export type MigrationWorkspaceFact = {
  id: string;
  ceiling: {
    repository_ids: readonly string[];
    github_app_repositories: "listed" | "installed";
  } | null;
  owners: readonly string[];
};

export type MigrationSessionFact = {
  workspaceId: string;
  profileId: string | null;
  hasAgent: boolean;
  /** `sessions.github_policy_source`; absent reads as agent or release by `hasAgent`. */
  policySource?: string | null;
  active: boolean;
  createdAt: string;
};

export type MigrationCopyFact = {
  id: string;
  migratedFrom: string;
  name: string;
  displayName: string | null;
  workspaceId: string | null;
  version: number;
  derivedFrom: string | null;
  definition: Record<string, unknown>;
  retired: boolean;
};

export type MigrationInput = {
  now: string;
  catalog: ProfileLookup<CatalogProfileView>;
  workspaces: readonly MigrationWorkspaceFact[];
  agents: readonly MigrationAgentFact[];
  repositories: readonly MigrationRepositoryFact[];
  sessions: readonly MigrationSessionFact[];
  copies: readonly MigrationCopyFact[];
  /** Release rows per `runtime_profile_id`, whatever their state. */
  releaseCounts?: ReadonlyMap<string, number>;
  /** Live checkpoints per `checkpoints.profile_id`. */
  checkpointCounts?: ReadonlyMap<string, number>;
  takenNames: ReadonlyMap<string, ReadonlySet<string | null>>;
  newId: () => string;
  migrationId: string;
};

export type CopySkip =
  | "retired"
  | "base_retired"
  | "base_blocked"
  | "base_changed"
  | "base_missing"
  | "not_active_or_latest"
  | "copy_unusable"
  | "older_than_copied"
  | "base_differs_in_lineage";

/** Design 1.4 step 1: what runs on a version today, before anything moves. */
export type ProfileUsage = {
  agents_on_active: number;
  pinned_releases: number;
  running_sessions: number;
  checkpoints: number;
  /** An installation version (not a migration copy) with the same execution form. */
  equivalent_installation_version: string | null;
};

export type ProfileCopyPlan = {
  source_id: string;
  workspace_id: string;
  name: string;
  version: number;
  state: string;
  /** `apply(base, version)` with the repository key left out; null where the state leaves no value. */
  effective: Record<string, unknown> | null;
  usage: ProfileUsage;
  created_by: string | null;
  reason: "active" | "latest" | "both" | null;
  decision: "copy" | "exists" | "skip";
  skip: CopySkip | null;
  target: {
    id: string;
    lineage_name: string;
    lineage_version: number;
    previous_id: string | null;
    display_name: string;
    display_name_suffixed: boolean;
    derived_from: string;
    base_fingerprint: string;
    definition: Record<string, unknown>;
    fingerprint: string;
    deny: readonly string[] | null;
    tool_catalog_id: string | null;
    permission_mode: string;
  } | null;
};

export type AgentMovePlan = {
  agent_id: string;
  from_profile_id: string;
  to_profile_id: string | null;
  decision: "move" | "stay";
  stay_reason: string | null;
  has_settings_row: boolean;
  expected: {
    active_release_id: string;
    activation_revision: number;
    behavior_revision: number;
    tracking: "follow" | "pinned";
    model_source: "fixed" | "profile";
  };
  tracking_after: "follow" | "pinned";
  tools_before: readonly string[];
  tools_after: readonly string[] | null;
  draft_open: boolean;
};

export type CeilingAddition = {
  repository_id: string;
  source: { kind: "profile" | "agent_pin"; id: string };
};

export type CeilingNotAdded = {
  repository_id: string;
  reason: "url" | "removed" | "not_in_catalog" | "app_installed";
  source: { kind: "profile" | "agent_pin"; id: string };
};

/**
 * Sessions of one kind in the report window. Those judged by the workspace
 * ceiling gain `widened_repositories`; the rest keep what their profile lists.
 */
export type MigrationSessionAccess = {
  sessions: number;
  judged_by_ceiling: number;
  unchanged: number;
  widened_repositories: string[];
  /**
   * The explicit repository ids a session may use, before and after the
   * top-up: the workspace ceiling's for a session it judges, else the ids its
   * profile lists (the same before and after).
   */
  by_profile: Array<{
    profile_id: string | null;
    judged_by_ceiling: boolean;
    sessions: number;
    before: string[];
    after: string[];
  }>;
};

export type WorkspacePlan = {
  workspace_id: string;
  actor_user_id: string | null;
  profiles: ProfileCopyPlan[];
  agents: AgentMovePlan[];
  /** Design seed-ceiling 5: the allowed sets before and after, by kind of session. */
  session_access: {
    ceiling_before: string[];
    ceiling_after: string[];
    agent_sessions: MigrationSessionAccess;
    /** Agents whose own settings list a repository the top-up now lets through. */
    agents_widened: Array<{ agent_id: string; repositories: string[] }>;
    agentless_on_copied_profiles: MigrationSessionAccess;
    other_profile_sessions: MigrationSessionAccess;
  };
  ceiling: {
    before: MigrationWorkspaceFact["ceiling"];
    additions: CeilingAddition[];
    not_added: CeilingNotAdded[];
    after: MigrationWorkspaceFact["ceiling"];
  };
  sessions: {
    agentless_on_copied_profiles: number;
    agentless_recent: number;
    agent_recent: number;
    widened_repositories: string[];
  };
};

export type MigrationPlan = {
  version: 1;
  migration_id: string;
  generated_at: string;
  preconditions: {
    r2_complete: boolean;
    active_releases_without_settings: string[];
    null_ceiling_workspaces: string[];
    workspaces_without_owner: string[];
  };
  workspaces: WorkspacePlan[];
};

const byId = <T extends { id: string }>(a: T, b: T) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

const sortedUnique = (values: Iterable<string>) => [...new Set(values)].sort();

const SUFFIX_LIMIT = 40;

function freeName(
  wanted: string,
  workspaceId: string,
  taken: MigrationInput["takenNames"],
  used: Set<string>,
): { name: string; suffixed: boolean } {
  const isTaken = (name: string) => {
    const scopes = taken.get(name);
    return (
      used.has(name) ||
      (scopes !== undefined && (scopes.has(null) || scopes.has(workspaceId)))
    );
  };
  if (!isTaken(wanted)) return { name: wanted, suffixed: false };
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${wanted.slice(0, SUFFIX_LIMIT - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return { name: candidate, suffixed: true };
  }
}

function copiedDefinition(
  catalog: ProfileLookup<CatalogProfileView>,
  record: WorkspaceProfileRecord,
): Record<string, unknown> | null {
  const entry = catalog.installation?.get(record.base_profile_id);
  const base = entry?.definition ?? entry?.record?.definition;
  if (typeof base !== "object" || base === null) return null;
  const { repository: _repository, ...rest } = base as Record<string, unknown>;
  const applied = derivationPolicyOf(catalog).apply(
    rest as unknown as CatalogProfileView,
    record,
  ) as unknown as Record<string, unknown>;
  return applied;
}

export function planMigration(input: MigrationInput): MigrationPlan {
  const { catalog } = input;
  const records = [...(catalog.workspace_profiles?.records.values() ?? [])];
  const newest = new Map<string, number>();
  for (const record of records) {
    const key = `${record.workspace_id}\u0000${record.name}`;
    newest.set(key, Math.max(newest.get(key) ?? 0, record.version));
  }
  const latestOf = (record: WorkspaceProfileRecord) =>
    newest.get(`${record.workspace_id}\u0000${record.name}`) === record.version;
  const repositoryById = new Map(input.repositories.map((r) => [r.id, r]));
  const now = Date.parse(input.now);
  const recentFrom = now - MIGRATION_RECENT_DAYS * 86_400_000;
  const copyBySource = new Map(input.copies.map((c) => [c.migratedFrom, c]));
  const copyIds = new Set(input.copies.map((c) => c.id));
  const equivalentVersion = (
    definition: Record<string, unknown>,
  ): string | null => {
    const ids = [...(catalog.installation?.entries() ?? [])]
      .filter(([id, entry]) => {
        if (copyIds.has(id)) return false;
        const form = entry.definition ?? entry.record?.definition;
        return (
          typeof form === "object" &&
          form !== null &&
          sameExecutionForm(form as Record<string, unknown>, definition)
        );
      })
      .map(([id]) => id)
      .sort();
    return ids[0] ?? null;
  };

  const activeIn = (workspaceId: string) =>
    input.agents.filter(
      (agent) => agent.workspaceId === workspaceId && agent.activeReleaseId,
    );
  const withoutRow = input.agents
    .filter((agent) => agent.activeReleaseId && !agent.hasSettingsRow)
    .map((agent) => agent.agentId)
    .sort();
  const nullCeiling = input.workspaces
    .filter((w) => w.ceiling === null)
    .map((w) => w.id)
    .sort();
  const noOwner = input.workspaces
    .filter((w) => w.owners.length === 0)
    .map((w) => w.id)
    .sort();

  const workspaces: WorkspacePlan[] = [];
  for (const workspace of [...input.workspaces].sort(byId)) {
    const wsRecords = records
      .filter((record) => record.workspace_id === workspace.id)
      .sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : a.version - b.version,
      );
    const wsAgents = activeIn(workspace.id);
    const activeProfiles = new Set(
      wsAgents.flatMap((a) => (a.activeProfileId ? [a.activeProfileId] : [])),
    );
    const usedNames = new Set<string>();
    const lineages = new Map<
      string,
      {
        name: string;
        last: number;
        lastId: string | null;
        display: string;
        derivedFrom: string;
        lastSource: number;
      }
    >();
    const profiles: ProfileCopyPlan[] = [];
    for (const record of wsRecords) {
      const state = workspaceProfileState(catalog, record);
      const isActive = activeProfiles.has(record.id);
      const isLatest = latestOf(record);
      const reason =
        isActive && isLatest
          ? "both"
          : isActive
            ? "active"
            : isLatest
              ? "latest"
              : null;
      const plan: ProfileCopyPlan = {
        source_id: record.id,
        workspace_id: record.workspace_id,
        name: record.name,
        version: record.version,
        state,
        effective: null,
        usage: {
          agents_on_active: wsAgents.filter(
            (a) => a.activeProfileId === record.id,
          ).length,
          pinned_releases: input.releaseCounts?.get(record.id) ?? 0,
          running_sessions: input.sessions.filter(
            (s) => s.active && s.profileId === record.id,
          ).length,
          checkpoints: input.checkpointCounts?.get(record.id) ?? 0,
          equivalent_installation_version: null,
        },
        created_by: record.created_by,
        reason,
        decision: "skip",
        skip: null,
        target: null,
      };
      profiles.push(plan);
      // A changed or missing base leaves no effective value (catalog.ts
      // catalogProfile); every other state reports one, copied or not.
      const definition =
        state === "base_changed" || state === "base_missing"
          ? null
          : copiedDefinition(catalog, record);
      plan.effective = definition;
      if (definition !== null) {
        plan.usage.equivalent_installation_version =
          equivalentVersion(definition);
      }
      if (state !== "usable") {
        plan.skip = state;
        continue;
      }
      if (reason === null && !copyBySource.has(record.id)) {
        plan.skip = "not_active_or_latest";
        continue;
      }
      if (definition === null) {
        plan.skip = "base_missing";
        continue;
      }
      const existing = copyBySource.get(record.id);
      const baseFingerprint =
        catalog.installation?.get(record.base_profile_id)?.record
          ?.fingerprint ?? "";
      let lineage = lineages.get(record.name);
      if (lineage === undefined) {
        const prior = input.copies
          .filter(
            (c) =>
              c.workspaceId === workspace.id &&
              c.displayName !== null &&
              wsRecords.some(
                (r) => r.id === c.migratedFrom && r.name === record.name,
              ),
          )
          .sort((a, b) => a.version - b.version);
        const last = prior[prior.length - 1];
        if (last !== undefined) {
          const lastSource = Math.max(
            0,
            ...prior.map(
              (c) => records.find((r) => r.id === c.migratedFrom)?.version ?? 0,
            ),
          );
          lineage = {
            name: last.name,
            last: last.version,
            lastId: last.id,
            display: last.displayName as string,
            derivedFrom: prior[0]?.derivedFrom ?? record.base_profile_id,
            lastSource,
          };
        } else {
          const free = freeName(
            record.name,
            workspace.id,
            input.takenNames,
            usedNames,
          );
          usedNames.add(free.name);
          lineage = {
            name: `wl_${input.newId()}`,
            last: 0,
            lastId: null,
            display: free.name,
            derivedFrom: record.base_profile_id,
            lastSource: 0,
          };
        }
        lineages.set(record.name, lineage);
      }
      const suffixed = lineage.display !== record.name;
      if (existing !== undefined) {
        const holds =
          !existing.retired &&
          existing.workspaceId === workspace.id &&
          sameExecutionForm(existing.definition, definition);
        plan.decision = holds ? "exists" : "skip";
        plan.skip = holds ? null : "copy_unusable";
        plan.target = {
          id: existing.id,
          lineage_name: existing.name,
          lineage_version: existing.version,
          previous_id: null,
          display_name: existing.displayName ?? lineage.display,
          display_name_suffixed: suffixed,
          derived_from: existing.derivedFrom ?? record.base_profile_id,
          base_fingerprint: baseFingerprint,
          definition: existing.definition,
          fingerprint: definitionFingerprint(
            existing.name,
            existing.definition as never,
          ),
          deny: record.deny ?? null,
          tool_catalog_id: record.tool_catalog_id ?? null,
          permission_mode: String(
            existing.definition.permission_mode ?? record.permission_mode,
          ),
        };
        continue;
      }
      if (lineage.derivedFrom !== record.base_profile_id) {
        plan.skip = "base_differs_in_lineage";
        continue;
      }
      if (record.version < lineage.lastSource) {
        plan.skip = "older_than_copied";
        continue;
      }
      const version = lineage.last + 1;
      const id = installationProfileId(lineage.name, version);
      plan.decision = "copy";
      plan.target = {
        id,
        lineage_name: lineage.name,
        lineage_version: version,
        previous_id: lineage.lastId,
        display_name: lineage.display,
        display_name_suffixed: suffixed,
        derived_from: lineage.derivedFrom,
        base_fingerprint: baseFingerprint,
        definition,
        fingerprint: definitionFingerprint(lineage.name, definition as never),
        deny: record.deny ?? null,
        tool_catalog_id: record.tool_catalog_id ?? null,
        permission_mode: record.permission_mode,
      };
      lineage.last = version;
      lineage.lastId = id;
      lineage.lastSource = record.version;
    }

    const targetOf = new Map(
      profiles
        .filter((p) => p.target !== null && p.skip === null)
        .map((p) => [p.source_id, p]),
    );
    const agents: AgentMovePlan[] = [];
    for (const agent of wsAgents.sort((a, b) =>
      a.agentId < b.agentId ? -1 : 1,
    )) {
      const from = agent.activeProfileId;
      if (from === null || !records.some((r) => r.id === from)) continue;
      const source = records.find(
        (r) => r.id === from,
      ) as WorkspaceProfileRecord;
      const copy = targetOf.get(from);
      const stay = (reason: string): AgentMovePlan => ({
        agent_id: agent.agentId,
        from_profile_id: from,
        to_profile_id: null,
        decision: "stay",
        stay_reason: reason,
        has_settings_row: agent.hasSettingsRow,
        expected: expectedOf(agent),
        tracking_after: agent.tracking,
        tools_before: agent.toolsBefore,
        tools_after: null,
        draft_open: agent.draftVersionId !== null,
      });
      if (copy === undefined || copy.target === null) {
        const profile = profiles.find((p) => p.source_id === from);
        agents.push(stay(profile?.skip ?? "not_copied"));
        continue;
      }
      if (workspace.owners.length === 0) {
        agents.push(stay("no_live_owner"));
        continue;
      }
      agents.push({
        agent_id: agent.agentId,
        from_profile_id: from,
        to_profile_id: copy.target.id,
        decision: "move",
        stay_reason: null,
        has_settings_row: agent.hasSettingsRow,
        expected: expectedOf(agent),
        tracking_after: latestOf(source) ? agent.tracking : "pinned",
        tools_before: agent.toolsBefore,
        tools_after: [...((copy.target.definition.tools as string[]) ?? [])],
        draft_open: agent.draftVersionId !== null,
      });
    }

    const additions: CeilingAddition[] = [];
    const notAdded: CeilingNotAdded[] = [];
    const held = new Set(workspace.ceiling?.repository_ids ?? []);
    const seen = new Set<string>();
    const consider = (
      repositoryId: string,
      source: CeilingAddition["source"],
    ) => {
      if (held.has(repositoryId) || seen.has(repositoryId)) return;
      const repository = repositoryById.get(repositoryId);
      if (repository === undefined) {
        notAdded.push({
          repository_id: repositoryId,
          reason: "not_in_catalog",
          source,
        });
      } else if (repository.removed) {
        notAdded.push({
          repository_id: repositoryId,
          reason: "removed",
          source,
        });
      } else if (repository.authKind === "github_app") {
        notAdded.push({
          repository_id: repositoryId,
          reason: "app_installed",
          source,
        });
      } else if (repository.authKind !== "github_app_explicit") {
        notAdded.push({ repository_id: repositoryId, reason: "url", source });
      } else {
        seen.add(repositoryId);
        additions.push({ repository_id: repositoryId, source });
      }
    };
    for (const profile of profiles) {
      if (profile.decision === "skip" || profile.target === null) continue;
      const record = records.find((r) => r.id === profile.source_id);
      const base = catalog.installation?.get(record?.base_profile_id ?? "");
      if (
        base?.repository_scope !== "profile" &&
        base?.repository_scope !== undefined
      )
        continue;
      for (const id of sortedUnique(base?.repository_ids ?? [])) {
        consider(id, { kind: "profile", id: profile.source_id });
      }
    }
    for (const move of agents) {
      if (move.decision !== "move" || move.has_settings_row) continue;
      const agent = wsAgents.find((a) => a.agentId === move.agent_id);
      if (agent === undefined) continue;
      for (const id of sortedUnique([
        ...(agent.releaseRepositoryId ? [agent.releaseRepositoryId] : []),
        ...agent.pinnedRepositories,
      ])) {
        consider(id, { kind: "agent_pin", id: agent.agentId });
      }
    }
    additions.sort((a, b) => (a.repository_id < b.repository_id ? -1 : 1));
    const after =
      workspace.ceiling === null
        ? null
        : {
            ...workspace.ceiling,
            repository_ids: sortedUnique([
              ...workspace.ceiling.repository_ids,
              ...additions.map((a) => a.repository_id),
            ]),
          };

    const copied = new Set(
      profiles.filter((p) => p.decision !== "skip").map((p) => p.source_id),
    );
    const inW = input.sessions.filter(
      (s) =>
        s.workspaceId === workspace.id &&
        (s.active || Date.parse(s.createdAt) >= recentFrom),
    );
    const widenedIds = additions.map((a) => a.repository_id);
    const ceilingBefore = sortedUnique(workspace.ceiling?.repository_ids ?? []);
    const ceilingAfter =
      after === null ? [] : sortedUnique(after.repository_ids);
    const ownRepositories = (profileId: string | null) => {
      if (profileId === null) return [];
      const baseId =
        catalog.workspace_profiles?.records.get(profileId)?.base_profile_id ??
        profileId;
      return sortedUnique(
        catalog.installation?.get(baseId)?.repository_ids ?? [],
      );
    };
    const access = (
      list: readonly MigrationSessionFact[],
    ): MigrationSessionAccess => {
      const groups = new Map<
        string,
        { profile_id: string | null; judged: boolean; sessions: number }
      >();
      for (const s of list) {
        const judged = usesWorkspaceCeiling(
          catalog,
          s.profileId,
          (s.policySource ??
            (s.hasAgent ? "agent" : "release")) as GitHubPolicySource,
        );
        const key = `${s.profileId ?? ""}\u0000${judged}`;
        const group = groups.get(key) ?? {
          profile_id: s.profileId,
          judged,
          sessions: 0,
        };
        group.sessions += 1;
        groups.set(key, group);
      }
      const byProfile = [...groups.values()]
        .sort((a, b) =>
          (a.profile_id ?? "") < (b.profile_id ?? "")
            ? -1
            : (a.profile_id ?? "") > (b.profile_id ?? "")
              ? 1
              : Number(a.judged) - Number(b.judged),
        )
        .map((g) => {
          const own = g.judged ? null : ownRepositories(g.profile_id);
          return {
            profile_id: g.profile_id,
            judged_by_ceiling: g.judged,
            sessions: g.sessions,
            before: own ?? ceilingBefore,
            after: own ?? ceilingAfter,
          };
        });
      const judged = byProfile
        .filter((g) => g.judged_by_ceiling)
        .reduce((sum, g) => sum + g.sessions, 0);
      return {
        sessions: list.length,
        judged_by_ceiling: judged,
        unchanged: list.length - judged,
        widened_repositories: judged > 0 ? widenedIds : [],
        by_profile: byProfile,
      };
    };
    const added = new Set(widenedIds);
    const wasThere = new Set(workspace.ceiling?.repository_ids ?? []);
    const agentsWidened = wsAgents
      .flatMap((agent) => {
        const gained = sortedUnique(agent.settingsRepositories ?? []).filter(
          (id) => added.has(id) && !wasThere.has(id),
        );
        return gained.length > 0
          ? [{ agent_id: agent.agentId, repositories: gained }]
          : [];
      })
      .sort((a, b) => (a.agent_id < b.agent_id ? -1 : 1));
    workspaces.push({
      workspace_id: workspace.id,
      actor_user_id: workspace.owners[0] ?? null,
      profiles,
      agents,
      session_access: {
        ceiling_before: ceilingBefore,
        ceiling_after: ceilingAfter,
        agent_sessions: access(inW.filter((s) => s.hasAgent)),
        agents_widened: agentsWidened,
        agentless_on_copied_profiles: access(
          inW.filter(
            (s) =>
              !s.hasAgent && s.profileId !== null && copied.has(s.profileId),
          ),
        ),
        other_profile_sessions: access(
          inW.filter(
            (s) =>
              !s.hasAgent && !(s.profileId !== null && copied.has(s.profileId)),
          ),
        ),
      },
      ceiling: {
        before: workspace.ceiling,
        additions,
        not_added: notAdded,
        after,
      },
      sessions: {
        agentless_on_copied_profiles: inW.filter(
          (s) => !s.hasAgent && s.profileId !== null && copied.has(s.profileId),
        ).length,
        agentless_recent: inW.filter((s) => !s.hasAgent).length,
        agent_recent: inW.filter((s) => s.hasAgent).length,
        widened_repositories: additions.map((a) => a.repository_id),
      },
    });
  }

  return {
    version: 1,
    migration_id: input.migrationId,
    generated_at: input.now,
    preconditions: {
      r2_complete: withoutRow.length === 0,
      active_releases_without_settings: withoutRow,
      null_ceiling_workspaces: nullCeiling,
      workspaces_without_owner: noOwner,
    },
    workspaces,
  };
}

function expectedOf(agent: MigrationAgentFact): AgentMovePlan["expected"] {
  return {
    active_release_id: agent.activeReleaseId as string,
    activation_revision: agent.activationRevision,
    behavior_revision: agent.behaviorRevision,
    tracking: agent.tracking,
    model_source: agent.modelSource,
  };
}

export function migrationRefusal(plan: MigrationPlan): string | null {
  const { preconditions: p } = plan;
  if (!p.r2_complete) {
    return `R2 is not complete: ${p.active_releases_without_settings.length} active release(s) have no GitHub settings row`;
  }
  if (p.null_ceiling_workspaces.length > 0) {
    return `${p.null_ceiling_workspaces.length} workspace(s) have no repository ceiling`;
  }
  return null;
}
