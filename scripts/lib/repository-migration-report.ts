/**
 * The read-only report before the repository migration (R2): which
 * workspaces, agents and active sessions touch URL repositories, and what
 * each workspace's sessions may reach before and after the migration moves
 * attributable repositories into the workspace ceiling.
 *
 * Nothing here writes. Every SQL statement runs in one `READ ONLY` snapshot
 * transaction, so the report agrees with itself and the database refuses a
 * write even if someone adds one by mistake. The report carries ids, kinds
 * and counts only: it never selects a repository's URL, auth or credential.
 *
 * `DIRECT_CHECK_SQL` is the definition in design 3.2 'direct check', kept as
 * written, so the deploy gate and the R4/R6 gate can reuse this report.
 */

import {
  type RepositoryCeiling,
  repositoryCeilingOf,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { createPostgresGitHubGateStore, type Database } from "@werft-ai/db";
import { connectionsOf } from "@werft-ai/forge-github";
import { createGitHubGate, type SessionCatalog } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

/** Repository rows that hold their own credential: the URL repositories. */
export const LEGACY_AUTH_KINDS = ["none", "basic", "bearer"] as const;
/** Sessions that ended inside this window still attribute their values. */
export const RECENT_SESSION_DAYS = 30;

/** Active = not failed or stopped (`idle` is active). `removed_at` is not read. */
export const DIRECT_CHECK_SQL = `
SELECT coalesce(a.workspace_id, s.workspace_id) AS workspace_id,
       s.id AS session_id, x.repository_id, x.via, c.auth_kind
FROM sessions s
LEFT JOIN agent_releases r ON r.id = s.agent_release_id
LEFT JOIN agents a ON a.id = r.agent_id
LEFT JOIN agent_github_settings g ON g.agent_id = r.agent_id
CROSS JOIN LATERAL (
  SELECT s.repository_id, 'primary'
  UNION ALL
  SELECT id, 'attached' FROM unnest(s.attached_repository_ids) AS id
  UNION ALL
  SELECT e, 'policy'
  FROM (SELECT CASE s.github_policy_source
                 WHEN 'release' THEN r.policy_pins #> '{github,repositories}'
                 WHEN 'agent' THEN g.repositories
               END AS list) p,
       jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(p.list) = 'array' THEN p.list ELSE '[]' END
       ) AS e
  WHERE s.attached_repository_ids IS NULL
) AS x(repository_id, via)
JOIN catalog_repositories c ON c.id = x.repository_id
WHERE s.status NOT IN ('failed', 'stopped')
  AND c.auth_kind IN ('none', 'basic', 'bearer')
`;

export type RepositoryKind = "app" | "explicit" | "legacy";
export type Via = "primary" | "attached" | "policy";

/** Runs `fn` in a read-only repeatable-read snapshot and always rolls back. */
export async function withReadOnlySnapshot<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    try {
      return await fn(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    client.release();
  }
}

export type Snapshot = {
  workspaces: Array<{ id: string; slug: string }>;
  ceilings: Array<{ workspace_id: string; repository_ceiling: unknown }>;
  repositories: Array<{
    id: string;
    auth_kind: string;
    removed: boolean;
    profiles: unknown;
  }>;
  agents: Array<{
    id: string;
    workspace_id: string;
    name: string;
    release_repository_id: string | null;
    release_profile_id: string | null;
    pinned: unknown;
  }>;
  settings: Array<{
    agent_id: string;
    repositories: unknown;
    start_repository_id: string | null;
  }>;
  sessions: Array<{
    id: string;
    status: string;
    workspace_id: string | null;
    has_agent: boolean;
    agent_id: string | null;
    profile_id: string | null;
    policy_source: string;
    repository_id: string | null;
    attached: string[] | null;
  }>;
  profiles: Array<{
    id: string;
    repository_ids: unknown;
    repository_scope: string | null;
    github_app_repositories: string;
  }>;
  workspaceProfiles: Array<{
    id: string;
    workspace_id: string;
    base_profile_id: string;
  }>;
  candidates: Array<{
    workspace_id: string | null;
    session_id: string;
    repository_id: string;
    via: Via;
    auth_kind: string;
  }>;
};

export async function readSnapshot(client: PoolClient): Promise<Snapshot> {
  const q = async <R>(sql: string): Promise<R[]> =>
    (await client.query(sql)).rows as R[];
  return {
    workspaces: await q(`SELECT id, slug FROM workspaces ORDER BY id`),
    ceilings: await q(
      `SELECT workspace_id, repository_ceiling FROM github_workspace_settings`,
    ),
    // No url, auth or credential column: the report must not carry them.
    repositories: await q(
      `SELECT id, auth_kind, removed_at IS NOT NULL AS removed, profiles
       FROM catalog_repositories ORDER BY id`,
    ),
    agents: await q(
      `SELECT a.id, a.workspace_id, a.name,
              r.repository_id AS release_repository_id,
              r.runtime_profile_id AS release_profile_id,
              r.policy_pins #> '{github,repositories}' AS pinned
       FROM agents a LEFT JOIN agent_releases r ON r.id = a.active_release_id
       ORDER BY a.id`,
    ),
    settings: await q(
      `SELECT agent_id, repositories, start_repository_id
       FROM agent_github_settings ORDER BY agent_id`,
    ),
    sessions: await q(
      `SELECT s.id, s.status, coalesce(a.workspace_id, s.workspace_id) AS workspace_id,
              s.agent_release_id IS NOT NULL AS has_agent, a.id AS agent_id, s.profile_id,
              s.github_policy_source AS policy_source, s.repository_id,
              s.attached_repository_ids AS attached
       FROM sessions s
       LEFT JOIN agent_releases r ON r.id = s.agent_release_id
       LEFT JOIN agents a ON a.id = r.agent_id
       WHERE s.status NOT IN ('failed', 'stopped')
          OR s.updated_at >= now() - interval '${RECENT_SESSION_DAYS} days'
       ORDER BY s.id`,
    ),
    profiles: await q(
      `SELECT id, repository_ids, repository_scope, github_app_repositories
       FROM installation_profiles ORDER BY id`,
    ),
    workspaceProfiles: await q(
      `SELECT id, workspace_id, base_profile_id FROM workspace_profiles ORDER BY id`,
    ),
    candidates: await q(`${DIRECT_CHECK_SQL} ORDER BY 1, 2, 3, 4`),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const sorted = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

type Ceiling =
  | { state: "absent" | "invalid" }
  | { state: "valid"; value: RepositoryCeiling };

export type ConfirmedStatus =
  | "confirmed"
  | "not_reachable"
  | "not_in_catalog"
  | "not_applicable";

export type Confirmation = Map<string, ConfirmedStatus>;
const confirmationKey = (c: {
  session_id: string;
  repository_id: string;
  via: Via;
}) => `${c.session_id}\u0000${c.repository_id}\u0000${c.via}`;

type SessionGroup = {
  kind: "agent" | "agentless";
  judged_by: "workspace_ceiling" | "profile";
  profile_id: string | null;
  session_count: number;
  before: string[];
  after: string[];
  narrowed: string[];
  widened: string[];
  widened_non_app: string[];
};

/**
 * How the snapshot's repositories, profiles and ceilings read today. The
 * write side (repository-migration-write.ts) judges with the same functions,
 * so the plan and the report cannot disagree.
 */
export function repositoryContext(snapshot: Snapshot) {
  const kindOf = new Map<string, RepositoryKind>();
  const removed = new Set<string>();
  const appIds: string[] = [];
  for (const row of snapshot.repositories) {
    const kind: RepositoryKind =
      row.auth_kind === "github_app"
        ? "app"
        : row.auth_kind === "github_app_explicit"
          ? "explicit"
          : "legacy";
    kindOf.set(row.id, kind);
    if (row.removed) removed.add(row.id);
    else if (kind === "app") appIds.push(row.id);
  }
  // The only non-App value the migration attributes is a live explicit one.
  const attributable = (id: string) =>
    kindOf.get(id) === "explicit" && !removed.has(id);

  // An operator profile's allowed ids: its own list, plus the catalog rows
  // that name it. A workspace profile reads its base.
  const baseOf = new Map(
    snapshot.workspaceProfiles.map((p) => [p.id, p.base_profile_id]),
  );
  const baseId = (profileId: string) => baseOf.get(profileId) ?? profileId;
  const profileRow = new Map(snapshot.profiles.map((p) => [p.id, p]));
  const profileIds = (profileId: string): Set<string> => {
    const base = baseId(profileId);
    // The runtime reads the profile row's list; the catalog row's own
    // `profiles` is seed metadata and not a grant.
    return new Set(strings(profileRow.get(base)?.repository_ids));
  };
  const profileSet = (profileId: string): Set<string> => {
    const ids = profileIds(profileId);
    if (
      profileRow.get(baseId(profileId))?.github_app_repositories === "installed"
    ) {
      for (const id of appIds) ids.add(id);
    }
    return ids;
  };
  // A row with no scope names no repository: the workspace's ceiling
  // judges it, as it does a `workspace` one.
  const profileScope = (profileId: string | null) => {
    if (profileId === null) return "profile";
    const row = profileRow.get(baseId(profileId));
    if (row === undefined) return "profile";
    return row.repository_scope ?? "workspace";
  };

  const ceilingOf = new Map<string, Ceiling>();
  for (const row of snapshot.ceilings) {
    const parsed = repositoryCeilingOf(row.repository_ceiling);
    ceilingOf.set(
      row.workspace_id,
      parsed !== null
        ? { state: "valid", value: parsed }
        : {
            state: row.repository_ceiling === null ? "absent" : "invalid",
          },
    );
  }
  const ceilingBefore = (workspaceId: string): Set<string> => {
    const ceiling = ceilingOf.get(workspaceId);
    if (ceiling?.state !== "valid") return new Set();
    const ids = new Set(ceiling.value.repository_ids);
    if (ceiling.value.github_app_repositories === "installed") {
      for (const id of appIds) ids.add(id);
    }
    return ids;
  };
  return {
    kindOf,
    removed,
    appIds,
    attributable,
    profileSet,
    profileScope,
    ceilingOf,
    ceilingBefore,
  };
}

/** What the migration would do to the allowed sets; reads only the snapshot. */
export function buildReport(
  snapshot: Snapshot,
  confirmation: Confirmation | null,
  generatedAt: Date,
) {
  const {
    kindOf,
    appIds,
    attributable,
    profileSet,
    profileScope,
    ceilingOf,
    ceilingBefore,
  } = repositoryContext(snapshot);

  // Attribution (design 3.2): value -> why, per workspace.
  const attributed = new Map<string, Map<string, Set<string>>>();
  const attribute = (workspaceId: string, id: string, basis: string) => {
    if (!attributable(id)) return;
    const byId = attributed.get(workspaceId) ?? new Map<string, Set<string>>();
    byId.set(id, (byId.get(id) ?? new Set()).add(basis));
    attributed.set(workspaceId, byId);
  };
  for (const agent of snapshot.agents) {
    if (agent.release_repository_id !== null) {
      attribute(
        agent.workspace_id,
        agent.release_repository_id,
        "active_release",
      );
    }
    for (const id of strings(agent.pinned)) {
      attribute(agent.workspace_id, id, "active_release");
    }
    if (agent.release_profile_id !== null) {
      for (const id of profileSet(agent.release_profile_id)) {
        attribute(agent.workspace_id, id, "release_profile");
      }
    }
  }
  for (const session of snapshot.sessions) {
    if (session.workspace_id === null) continue;
    for (const id of [session.repository_id, ...(session.attached ?? [])]) {
      if (id !== null) attribute(session.workspace_id, id, "session");
    }
  }
  const [only, ...rest] = snapshot.workspaces;
  if (only !== undefined && rest.length === 0) {
    for (const profile of snapshot.profiles) {
      for (const id of profileSet(profile.id)) {
        attribute(only.id, id, "single_workspace");
      }
    }
  }

  const everyAttributed = new Set(
    [...attributed.values()].flatMap((byId) => [...byId.keys()]),
  );
  const unattributed: Array<Record<string, unknown>> = [];
  for (const profile of snapshot.profiles) {
    for (const id of sorted(profileSet(profile.id))) {
      if (attributable(id) && !everyAttributed.has(id)) {
        unattributed.push({
          reason: "profile_list_only",
          profile_id: profile.id,
          repository_id: id,
          selectable_by: snapshot.workspaces.map((w) => w.id),
        });
      }
    }
  }
  for (const session of snapshot.sessions) {
    if (session.workspace_id !== null) continue;
    for (const id of [session.repository_id, ...(session.attached ?? [])]) {
      if (id !== null && attributable(id)) {
        unattributed.push({
          reason: "session_without_workspace",
          session_id: session.id,
          profile_id: session.profile_id,
          repository_id: id,
          selectable_by: [],
        });
      }
    }
  }

  const describe = (ids: Iterable<string>) =>
    sorted(ids).map((id) => ({ id, kind: kindOf.get(id) ?? "unknown" }));

  const workspaces = snapshot.workspaces.map((workspace) => {
    const before = ceilingBefore(workspace.id);
    // Existing ceiling values stay as they are (URL values included); the
    // migration adds live explicit values and writes `installed`.
    const after = new Set([...before, ...appIds]);
    const rawCeiling = ceilingOf.get(workspace.id);
    if (rawCeiling?.state === "valid") {
      for (const id of rawCeiling.value.repository_ids) after.add(id);
    }
    const byId = attributed.get(workspace.id) ?? new Map<string, Set<string>>();
    for (const id of byId.keys()) after.add(id);

    const groups = new Map<string, SessionGroup & { ids: Set<string> }>();
    for (const session of snapshot.sessions) {
      if (session.workspace_id !== workspace.id) continue;
      const ceilingJudged =
        session.policy_source !== "release" ||
        profileScope(session.profile_id) === "workspace";
      const profileId = ceilingJudged ? null : session.profile_id;
      const key = `${session.has_agent}|${ceilingJudged}|${profileId}`;
      const group = groups.get(key) ?? {
        kind: session.has_agent ? ("agent" as const) : ("agentless" as const),
        judged_by: ceilingJudged
          ? ("workspace_ceiling" as const)
          : ("profile" as const),
        profile_id: profileId,
        session_count: 0,
        before: [],
        after: [],
        narrowed: [],
        widened: [],
        widened_non_app: [],
        ids: new Set<string>(),
      };
      group.session_count += 1;
      groups.set(key, group);
    }
    const sessionGroups = [...groups.values()]
      .map(({ ids: _ids, ...group }) => {
        const was =
          group.judged_by === "workspace_ceiling"
            ? before
            : group.profile_id === null
              ? new Set<string>()
              : profileSet(group.profile_id);
        const narrowed = [...was].filter((id) => !after.has(id));
        const widened = [...after].filter((id) => !was.has(id));
        return {
          ...group,
          before: sorted(was),
          after: sorted(after),
          narrowed: sorted(narrowed),
          widened: sorted(widened),
          widened_non_app: sorted(
            widened.filter((id) => kindOf.get(id) === "explicit"),
          ),
        };
      })
      .sort((a, b) =>
        `${a.kind}${a.judged_by}${a.profile_id}`.localeCompare(
          `${b.kind}${b.judged_by}${b.profile_id}`,
        ),
      );

    return {
      workspace_id: workspace.id,
      slug: workspace.slug,
      ceiling_before: {
        state: rawCeiling?.state ?? "absent",
        repository_ids:
          rawCeiling?.state === "valid"
            ? describe(rawCeiling.value.repository_ids)
            : [],
        github_app_repositories:
          rawCeiling?.state === "valid"
            ? rawCeiling.value.github_app_repositories
            : null,
      },
      ceiling_after_ids: describe(after),
      attributed: [...byId.entries()]
        .map(([id, basis]) => ({ id, basis: sorted(basis) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      session_groups: sessionGroups,
    };
  });

  // (1) per URL repository: who has it, who uses it, who holds it in a ceiling.
  const legacyRepositories = snapshot.repositories
    .filter((row) => kindOf.get(row.id) === "legacy")
    .map((row) => {
      const perWorkspace = new Map<
        string,
        {
          in_ceiling: boolean;
          agents: Map<string, Set<string>>;
          active_sessions: Set<string>;
        }
      >();
      const slot = (workspaceId: string) => {
        const entry = perWorkspace.get(workspaceId) ?? {
          in_ceiling: false,
          agents: new Map<string, Set<string>>(),
          active_sessions: new Set<string>(),
        };
        perWorkspace.set(workspaceId, entry);
        return entry;
      };
      for (const [workspaceId, ceiling] of ceilingOf) {
        if (
          ceiling.state === "valid" &&
          ceiling.value.repository_ids.includes(row.id)
        ) {
          slot(workspaceId).in_ceiling = true;
        }
      }
      const names = new Map(snapshot.agents.map((a) => [a.id, a]));
      const use = (agentId: string, via: string) => {
        const agent = names.get(agentId);
        if (agent === undefined) return;
        const agents = slot(agent.workspace_id).agents;
        agents.set(agentId, (agents.get(agentId) ?? new Set()).add(via));
      };
      for (const agent of snapshot.agents) {
        if (agent.release_repository_id === row.id) {
          use(agent.id, "release_repository");
        }
        if (strings(agent.pinned).includes(row.id))
          use(agent.id, "release_pin");
      }
      // An active session names the value whatever release it runs on.
      const sessionOf = new Map(snapshot.sessions.map((s) => [s.id, s]));
      for (const candidate of snapshot.candidates) {
        if (candidate.repository_id !== row.id) continue;
        const session = sessionOf.get(candidate.session_id);
        if (candidate.workspace_id !== null) {
          slot(candidate.workspace_id).active_sessions.add(
            candidate.session_id,
          );
        }
        if (session?.agent_id != null) use(session.agent_id, "active_session");
      }
      for (const setting of snapshot.settings) {
        if (strings(setting.repositories).includes(row.id)) {
          use(setting.agent_id, "agent_settings");
        }
        if (setting.start_repository_id === row.id) {
          use(setting.agent_id, "start_repository");
        }
      }
      return {
        id: row.id,
        auth_kind: row.auth_kind,
        removed: row.removed,
        workspaces: [...perWorkspace.entries()]
          .map(([workspaceId, entry]) => ({
            workspace_id: workspaceId,
            in_ceiling: entry.in_ceiling,
            active_session_count: entry.active_sessions.size,
            agents: [...entry.agents.entries()]
              .map(([id, via]) => ({
                id,
                name: names.get(id)?.name ?? null,
                via: sorted(via),
              }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          }))
          .sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)),
        profiles: sorted(
          snapshot.profiles
            .filter((p) => strings(p.repository_ids).includes(row.id))
            .map((p) => p.id),
        ),
      };
    });

  const candidates = snapshot.candidates.map((c) => ({
    ...c,
    confirmed:
      confirmation === null
        ? ("not_applicable" as const)
        : (confirmation.get(confirmationKey(c)) ?? ("not_reachable" as const)),
  }));
  const count = (status: ConfirmedStatus) =>
    candidates.filter((c) => c.confirmed === status).length;
  const nonAppWidening = workspaces.reduce(
    (sum, w) =>
      sum + w.session_groups.reduce((n, g) => n + g.widened_non_app.length, 0),
    0,
  );

  return {
    generated_at: generatedAt.toISOString(),
    read_only: true,
    repositories: legacyRepositories,
    direct_check: {
      candidate_count: candidates.length,
      candidate_session_count: new Set(candidates.map((c) => c.session_id))
        .size,
      confirmed_count: confirmation === null ? null : count("confirmed"),
      confirmed:
        confirmation === null
          ? "not_applicable"
          : {
              status: "computed",
              excluded_not_in_catalog: count("not_in_catalog"),
              not_reachable: count("not_reachable"),
              // The gate's own filters run; whether a stored credential
              // resolves is not read.
              secret_resolution_checked: false,
            },
      // The verdict follows the candidates, never the confirmed subset.
      verdict: candidates.length === 0 ? "clear" : "candidates_present",
      candidates,
    },
    workspaces,
    non_app_widening_total: nonAppWidening,
    unattributed,
  };
}

export type Report = ReturnType<typeof buildReport>;

/**
 * Which candidates the running image's gate would let a session use. The
 * catalog and the gate are the code's own; the images before the URL
 * repository removal load URL rows, later ones do not (then pass
 * `catalog = null` and the report says `not_applicable`).
 */
export async function confirmCandidates(
  db: Database,
  catalog: SessionCatalog,
  candidates: Snapshot["candidates"],
): Promise<Confirmation> {
  const gate = createGitHubGate({
    store: createPostgresGitHubGateStore(db),
    catalog,
    connections: connectionsOf(catalog),
  });
  const result: Confirmation = new Map();
  const reachable = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = confirmationKey(candidate);
    if (!Object.hasOwn(catalog.repositories, candidate.repository_id)) {
      result.set(key, "not_in_catalog");
      continue;
    }
    if (candidate.via === "primary") {
      result.set(key, "confirmed");
      continue;
    }
    let ids = reachable.get(candidate.session_id);
    if (ids === undefined) {
      ids = new Set(
        (await gate.additionalRepositories?.(candidate.session_id)) ?? [],
      );
      reachable.set(candidate.session_id, ids);
    }
    result.set(
      key,
      ids.has(candidate.repository_id) ? "confirmed" : "not_reachable",
    );
  }
  return result;
}

/**
 * The whole report. The snapshot is one read-only transaction; the
 * confirmed pass reads through the pool afterwards (the gate's own store and
 * catalog open their own transactions), so it can trail the snapshot by the
 * time it takes to run. `catalogOf = null` is an image that cannot compute
 * it: the report says `not_applicable`.
 */
export async function generateReport(
  pool: Pool,
  catalogOf: ((db: Database) => Promise<SessionCatalog>) | null,
  now: Date = new Date(),
): Promise<Report> {
  const snapshot = await withReadOnlySnapshot(pool, readSnapshot);
  let confirmation: Confirmation | null = null;
  if (catalogOf !== null) {
    const db = drizzle(pool, { schema });
    confirmation = await confirmCandidates(
      db,
      await catalogOf(db),
      snapshot.candidates,
    );
  }
  return buildReport(snapshot, confirmation, now);
}

export function summarize(report: Report): string[] {
  const direct = report.direct_check;
  return [
    `read-only report at ${report.generated_at}`,
    `URL repositories: ${report.repositories.length}`,
    `active URL session candidates: ${direct.candidate_count} in ${direct.candidate_session_count} sessions; verdict ${direct.verdict}`,
    `confirmed: ${direct.confirmed_count ?? "not applicable"}`,
    `non-App widening: ${report.non_app_widening_total}`,
    `unattributed values: ${report.unattributed.length}`,
  ];
}
