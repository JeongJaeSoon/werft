import { randomUUID } from "node:crypto";
import type { ProfileRollout } from "@werft-ai/contracts";
import {
  type BackfillReport,
  type ClaimedRolloutItem,
  type ProfileRolloutStore,
  type RolloutProfile,
  sameExecutionForm,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import { lockWrites } from "./installation-profiles.ts";
import type { Database } from "./queries.ts";

/** An item leased this many times without a result is a crash loop. */
export const ROLLOUT_MAX_CLAIMS = 5;

// Versions of one profile share this key; a catalog row (no name) has none.
const LINEAGE = (alias: string) =>
  sql.raw(
    `CASE WHEN ${alias}.display_name IS NOT NULL THEN ${alias}.workspace_id::text || ':' || ${alias}.display_name WHEN ${alias}.name IS NOT NULL THEN 'name:' || ${alias}.name END`,
  );

type ProfileRow = {
  id: string;
  version: number;
  definition: Record<string, unknown>;
  deny: string[] | null;
  lineage: string | null;
  created_by: string | null;
};

type Follower = ProfileRow & { agent_id: string; revision: number };

const profileOf = (row: ProfileRow): RolloutProfile => ({
  id: row.id,
  version: row.version,
  definition: row.definition,
  deny: row.deny,
});

const rows = async <T>(db: Database, query: SQL): Promise<T[]> =>
  rowsOf<T>(await db.execute(query));

/** Whether no later version of the profile's lineage exists. */
export async function isNewestProfile(
  tx: Database,
  profileId: string,
): Promise<boolean> {
  const later = await rows(
    tx,
    sql`SELECT 1 FROM installation_profiles p
      JOIN installation_profiles n
        ON n.origin = 'console' AND ${LINEAGE("n")} = ${LINEAGE("p")}
        AND n.version > p.version
      WHERE p.id = ${profileId} LIMIT 1`,
  );
  return later.length === 0;
}

/**
 * A person brought the agent to the newest profile by hand, so its refused
 * items are over: `applied` where the agent now runs the item's target,
 * `superseded` for an older one.
 */
export async function resolveFailedItems(
  tx: Database,
  agentId: string,
): Promise<void> {
  await tx.execute(
    sql`UPDATE profile_rollout_items i
      SET status = CASE WHEN r.target_profile_id = ar.runtime_profile_id
            THEN 'applied' ELSE 'superseded' END,
          reason_code = NULL, locked_by = NULL, locked_until = NULL,
          updated_at = now()
      FROM profile_rollouts r, agents a, agent_releases ar
      WHERE i.rollout_id = r.id AND r.kind = 'profile_update'
        AND i.agent_id = ${agentId}::uuid
        AND i.status = 'failed'
        AND a.id = i.agent_id AND ar.id = a.active_release_id`,
  );
}

export async function openRolloutStep(
  db: Database,
  agentId: string,
  activeReleaseId: string | null,
): Promise<{
  status: "pending" | "failed";
  reason: string | null;
  target_profile_id: string;
} | null> {
  if (activeReleaseId === null) return null;
  const [newest] = await rows<{
    status: string;
    reason_code: string | null;
    target_profile_id: string;
  }>(
    db,
    sql`SELECT i.status, i.reason_code, r.target_profile_id
      FROM profile_rollout_items i
      JOIN profile_rollouts r
        ON r.id = i.rollout_id AND r.kind = 'profile_update'
      JOIN installation_profiles tp ON tp.id = r.target_profile_id
      JOIN agent_releases ar ON ar.id = ${activeReleaseId}
      JOIN installation_profiles ap ON ap.id = ar.runtime_profile_id
      WHERE i.agent_id = ${agentId}::uuid
        AND ${LINEAGE("tp")} IS NOT NULL
        AND ${LINEAGE("tp")} = ${LINEAGE("ap")}
      ORDER BY tp.version DESC, i.generation DESC LIMIT 1`,
  );
  if (newest === undefined) return null;
  if (newest.status !== "pending" && newest.status !== "failed") return null;
  return {
    status: newest.status,
    reason: newest.reason_code,
    target_profile_id: newest.target_profile_id,
  };
}

/** Whether the agent's active release runs a version of the target's lineage. */
export async function runsLineageOf(
  tx: Database,
  agentId: string,
  targetProfileId: string,
): Promise<boolean> {
  const found = await rows(
    tx,
    sql`SELECT 1 FROM agents a
      JOIN agent_releases r ON r.id = a.active_release_id
      JOIN installation_profiles active ON active.id = r.runtime_profile_id
      JOIN installation_profiles target ON target.id = ${targetProfileId}
      WHERE a.id = ${agentId}
        AND ${LINEAGE("active")} IS NOT NULL
        AND ${LINEAGE("active")} = ${LINEAGE("target")}`,
  );
  return found.length > 0;
}

/** Each lineage's newest version, whatever its state (design 2.3). */
async function latestPerLineage(tx: Database) {
  const found = await rows<ProfileRow>(
    tx,
    sql`SELECT DISTINCT ON (lineage) id, version, definition, deny, lineage, created_by
      FROM (
        SELECT p.id, p.version, p.definition, p.deny, p.created_by, ${LINEAGE("p")} AS lineage
        FROM installation_profiles p WHERE p.origin = 'console'
      ) l WHERE lineage IS NOT NULL
      ORDER BY lineage, version DESC`,
  );
  return new Map(found.map((row) => [row.lineage as string, row]));
}

/** Following agents with the console profile they run. */
async function followers(tx: Database, lineage?: string): Promise<Follower[]> {
  const found = await rows<Follower>(
    tx,
    sql`SELECT a.id AS agent_id, a.activation_revision AS revision,
        p.id, p.version, p.definition, p.deny, p.created_by, ${LINEAGE("p")} AS lineage
      FROM agents a
      JOIN agent_releases r ON r.id = a.active_release_id
      JOIN installation_profiles p ON p.id = r.runtime_profile_id
      WHERE a.profile_tracking = 'follow' AND p.origin = 'console'
        ${lineage === undefined ? sql`` : sql`AND ${LINEAGE("p")} = ${lineage}`}`,
  );
  return found.filter((row) => row.lineage !== null);
}

export async function writeProfileRollout(
  tx: Database,
  input: {
    profileId: string;
    previous: {
      definition: Record<string, unknown>;
      deny: readonly string[] | null | undefined;
    };
    definition: Record<string, unknown>;
    deny: readonly string[] | null | undefined;
    createdBy: string;
  },
): Promise<{ rolloutId: string; items: number } | null> {
  if (sameExecutionForm(input.previous, input)) {
    return null;
  }
  const [named] = await rows<{ lineage: string | null }>(
    tx,
    sql`SELECT ${LINEAGE("p")} AS lineage FROM installation_profiles p
      WHERE p.id = ${input.profileId}`,
  );
  const lineage = named?.lineage ?? null;
  if (lineage === null) return null;
  const rolloutId = randomUUID();
  const made = await rows<{ id: string }>(
    tx,
    sql`INSERT INTO profile_rollouts (id, kind, target_profile_id, created_by)
      VALUES (${rolloutId}, 'profile_update', ${input.profileId}, ${input.createdBy})
      ON CONFLICT (target_profile_id, kind) DO NOTHING RETURNING id`,
  );
  if (made.length === 0) return null;
  await tx.execute(
    sql`UPDATE profile_rollout_items i
      SET status = 'superseded', locked_by = NULL, locked_until = NULL,
          updated_at = now()
      FROM profile_rollouts r
      JOIN installation_profiles p ON p.id = r.target_profile_id
      WHERE i.rollout_id = r.id AND r.kind = 'profile_update'
        AND r.id <> ${rolloutId} AND i.status = 'pending'
        AND ${LINEAGE("p")} = ${lineage}`,
  );
  let items = 0;
  for (const agent of await followers(tx, lineage)) {
    if (agent.id === input.profileId || sameExecutionForm(agent, input)) {
      continue;
    }
    const put = await rows(
      tx,
      sql`INSERT INTO profile_rollout_items (rollout_id, agent_id, generation)
        VALUES (${rolloutId}, ${agent.agent_id}, ${agent.revision})
        ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
    );
    items += put.length;
  }
  return { rolloutId, items };
}

/** Followers running a form that is not their lineage's newest. */
async function behindLatest(tx: Database) {
  const latest = await latestPerLineage(tx);
  const behind = (await followers(tx)).filter((agent) => {
    const newest = latest.get(agent.lineage as string);
    return (
      newest !== undefined &&
      newest.id !== agent.id &&
      !sameExecutionForm(agent, newest)
    );
  });
  return { latest, behind };
}

/** Lineages the writer (or a sweep) has already written a rollout for. */
async function lineagesWithRollouts(tx: Database) {
  const found = await rows<{ lineage: string }>(
    tx,
    sql`SELECT DISTINCT ${LINEAGE("p")} AS lineage FROM profile_rollouts r
      JOIN installation_profiles p ON p.id = r.target_profile_id
      WHERE r.kind = 'profile_update'`,
  );
  return new Set(found.map((row) => row.lineage));
}

export function createPostgresProfileRolloutStore(
  db: Database,
): ProfileRolloutStore {
  return {
    async claim({ leaseMs, limit }) {
      const token = randomUUID();
      await db.execute(sql`
        UPDATE profile_rollout_items
        SET status = 'failed', reason_code = 'retries_exhausted',
            locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE status = 'pending' AND attempts >= ${ROLLOUT_MAX_CLAIMS}
          AND (locked_until IS NULL OR locked_until < now())
          AND rollout_id IN (SELECT id FROM profile_rollouts WHERE kind = 'profile_update')`);
      const claimed = await rows(
        db,
        sql`WITH picked AS (
            SELECT rollout_id, agent_id, generation FROM profile_rollout_items
            WHERE status = 'pending' AND attempts < ${ROLLOUT_MAX_CLAIMS}
              AND (locked_until IS NULL OR locked_until < now())
              AND rollout_id IN (SELECT id FROM profile_rollouts WHERE kind = 'profile_update')
            ORDER BY created_at, rollout_id, agent_id
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
          UPDATE profile_rollout_items i
          SET locked_by = ${token},
              locked_until = now() + ${leaseMs} * interval '1 millisecond',
              attempts = i.attempts + 1, updated_at = now()
          FROM picked
          WHERE i.rollout_id = picked.rollout_id
            AND i.agent_id = picked.agent_id
            AND i.generation = picked.generation
          RETURNING i.agent_id`,
      );
      if (claimed.length === 0) return [];
      const held = await rows<{
        rollout_id: string;
        agent_id: string;
        generation: number;
        workspace_id: string;
        target_profile_id: string;
        created_by: string | null;
      }>(
        db,
        sql`SELECT i.rollout_id, i.agent_id, i.generation, a.workspace_id,
            r.target_profile_id, r.created_by
          FROM profile_rollout_items i
          JOIN profile_rollouts r ON r.id = i.rollout_id
          JOIN agents a ON a.id = i.agent_id
          WHERE i.locked_by = ${token}
          ORDER BY i.created_at, i.rollout_id, i.agent_id`,
      );
      return held.map(
        (row): ClaimedRolloutItem => ({
          rolloutId: row.rollout_id,
          agentId: row.agent_id,
          generation: row.generation,
          claim: token,
          workspaceId: row.workspace_id,
          targetProfileId: row.target_profile_id,
          actorUserId: row.created_by,
        }),
      );
    },

    async settle(item, result) {
      const written = await rows(
        db,
        sql`UPDATE profile_rollout_items
          SET status = ${result.status},
              reason_code = ${result.status === "failed" ? result.reasonCode : null},
              locked_by = NULL, locked_until = NULL, updated_at = now()
          WHERE rollout_id = ${item.rolloutId} AND agent_id = ${item.agentId}
            AND generation = ${item.generation} AND status = 'pending'
            AND locked_by = ${item.claim} AND locked_until > now()
          RETURNING 1 AS ok`,
      );
      return written.length > 0;
    },

    async abandon(items) {
      if (items.length === 0) return 0;
      const freed = await rows(
        db,
        sql`UPDATE profile_rollout_items i
          SET locked_by = NULL, locked_until = NULL,
              attempts = GREATEST(i.attempts - 1, 0), updated_at = now()
          WHERE i.status = 'pending'
            AND (i.rollout_id, i.agent_id, i.generation, i.locked_by) IN (${sql.join(
              items.map(
                (item) =>
                  sql`(${item.rolloutId}::uuid, ${item.agentId}::uuid, ${item.generation}::int, ${item.claim})`,
              ),
              sql`, `,
            )})
          RETURNING 1 AS ok`,
      );
      return freed.length;
    },

    async retry(item) {
      const reopened = await rows(
        db,
        sql`UPDATE profile_rollout_items
          SET status = 'pending', reason_code = NULL, attempts = 0,
              locked_by = NULL, locked_until = NULL, updated_at = now()
          WHERE rollout_id = ${item.rolloutId} AND agent_id = ${item.agentId}
            AND generation = ${item.generation} AND status = 'failed'
          RETURNING 1 AS ok`,
      );
      return reopened.length > 0;
    },

    async retryFailed({ workspaceId, targetProfileId, agentId }) {
      const reopened = await rows(
        db,
        sql`UPDATE profile_rollout_items i
          SET status = 'pending', reason_code = NULL, attempts = 0,
              locked_by = NULL, locked_until = NULL, updated_at = now()
          FROM profile_rollouts r, agents a
          WHERE i.rollout_id = r.id AND r.kind = 'profile_update'
            AND r.target_profile_id = ${targetProfileId}
            AND a.id = i.agent_id AND a.id = ${agentId}::uuid
            AND a.workspace_id = ${workspaceId}::uuid
            AND i.status = 'failed'
            AND i.generation = (
              SELECT max(x.generation) FROM profile_rollout_items x
              WHERE x.rollout_id = i.rollout_id AND x.agent_id = i.agent_id)
          RETURNING 1 AS ok`,
      );
      return reopened.length > 0;
    },

    async summaries(workspaceId) {
      const steps = await rows<{
        profile_id: string;
        agent_id: string;
        name: string;
        status: string;
        reason_code: string | null;
      }>(
        db,
        sql`SELECT l.profile_id, l.agent_id, a.name, l.status, l.reason_code
          FROM (
            SELECT DISTINCT ON (i.rollout_id, i.agent_id)
              r.target_profile_id AS profile_id, i.agent_id, i.status,
              i.reason_code
            FROM profile_rollout_items i
            JOIN profile_rollouts r
              ON r.id = i.rollout_id AND r.kind = 'profile_update'
            ORDER BY i.rollout_id, i.agent_id, i.generation DESC
          ) l
          JOIN agents a ON a.id = l.agent_id
          WHERE a.workspace_id = ${workspaceId}::uuid
          ORDER BY a.name, l.agent_id`,
      );
      const fixed = await rows<{ profile_id: string; n: number }>(
        db,
        sql`SELECT r.target_profile_id AS profile_id,
            count(DISTINCT a.id)::int AS n
          FROM profile_rollouts r
          JOIN installation_profiles p ON p.id = r.target_profile_id
          JOIN agents a ON a.workspace_id = ${workspaceId}::uuid
            AND a.model_source = 'fixed'
          JOIN agent_releases ar ON ar.id = a.active_release_id
          JOIN installation_profiles ap ON ap.id = ar.runtime_profile_id
          WHERE r.kind = 'profile_update'
            AND ${LINEAGE("p")} IS NOT NULL
            AND ${LINEAGE("ap")} = ${LINEAGE("p")}
            AND ar.runtime_config_snapshot ->> 'model'
              IS DISTINCT FROM p.definition ->> 'model'
          GROUP BY r.target_profile_id`,
      );
      const out = new Map<string, ProfileRollout>();
      const of = (id: string): ProfileRollout => {
        let found = out.get(id);
        if (found === undefined) {
          found = {
            total: 0,
            applied: 0,
            pending: 0,
            failed: 0,
            failed_agents: [],
            fixed_model_agents: 0,
          };
          out.set(id, found);
        }
        return found;
      };
      for (const step of steps) {
        if (step.status === "superseded") continue;
        const entry = of(step.profile_id);
        entry.total++;
        if (step.status === "applied") entry.applied++;
        else if (step.status === "pending") entry.pending++;
        else {
          entry.failed++;
          entry.failed_agents.push({
            agent_id: step.agent_id,
            name: step.name,
            reason: step.reason_code ?? "failed",
          });
        }
      }
      for (const row of fixed) of(row.profile_id).fixed_model_agents = row.n;
      return out;
    },

    async sweep() {
      return db.transaction(async (tx) => {
        // Profile writes take this lock, so no version lands mid-sweep.
        await lockWrites(tx);
        const { latest, behind: allBehind } = await behindLatest(tx);
        // Before the one-time fill, a lineage is opened only by a rollout of
        // its own: another lineage's rollout says nothing about this one.
        let behind = allBehind;
        if (
          allBehind.length > 0 &&
          (await rows(tx, sql`SELECT 1 FROM profile_fill`)).length === 0
        ) {
          const opened = await lineagesWithRollouts(tx);
          behind = allBehind.filter((agent) =>
            opened.has(agent.lineage as string),
          );
        }
        const held = allBehind.length - behind.length;
        let rollouts = 0;
        let items = 0;
        // The head is the lineage's last behavior-changing rollout. When the
        // newest version's form differs from the head target's (an image
        // without the writer made it), it gets its own rollout.
        const headOf = new Map<string, string>();
        for (const lineage of new Set(
          behind.map((agent) => agent.lineage as string),
        )) {
          const newest = latest.get(lineage) as ProfileRow;
          const [current] = await rows<{
            id: string;
            definition: ProfileRow["definition"];
            deny: ProfileRow["deny"];
          }>(
            tx,
            sql`SELECT r.id, p.definition, p.deny FROM profile_rollouts r
              JOIN installation_profiles p ON p.id = r.target_profile_id
              WHERE r.kind = 'profile_update' AND ${LINEAGE("p")} = ${lineage}
              ORDER BY p.version DESC LIMIT 1`,
          );
          if (current !== undefined && sameExecutionForm(current, newest)) {
            headOf.set(lineage, current.id);
            continue;
          }
          const made = await rows<{ id: string }>(
            tx,
            sql`INSERT INTO profile_rollouts (id, kind, target_profile_id, created_by)
              VALUES (${randomUUID()}, 'profile_update', ${newest.id}, ${newest.created_by})
              ON CONFLICT (target_profile_id, kind) DO NOTHING RETURNING id`,
          );
          rollouts += made.length;
          const [row] =
            made.length > 0
              ? made
              : await rows<{ id: string }>(
                  tx,
                  sql`SELECT id FROM profile_rollouts
                    WHERE kind = 'profile_update' AND target_profile_id = ${newest.id}`,
                );
          if (row !== undefined) headOf.set(lineage, row.id);
        }
        for (const agent of behind) {
          const lineage = agent.lineage as string;
          const head = headOf.get(lineage);
          if (head === undefined) continue;
          // Only this agent's pending item in this lineage holds it back.
          const pending = await rows(
            tx,
            sql`SELECT 1 FROM profile_rollout_items i
              JOIN profile_rollouts r ON r.id = i.rollout_id AND r.kind = 'profile_update'
              JOIN installation_profiles p ON p.id = r.target_profile_id
              WHERE i.agent_id = ${agent.agent_id} AND i.status = 'pending'
                AND ${LINEAGE("p")} = ${lineage} LIMIT 1`,
          );
          if (pending.length > 0) continue;
          const put = await rows(
            tx,
            sql`INSERT INTO profile_rollout_items (rollout_id, agent_id, generation)
              VALUES (${head}, ${agent.agent_id}, ${agent.revision})
              ON CONFLICT DO NOTHING RETURNING 1 AS ok`,
          );
          items += put.length;
        }
        return held > 0 ? { rollouts, items, held } : { rollouts, items };
      });
    },

    async inspect({ agentId, targetProfileId, activeProfileId }) {
      const [agent] = await rows<{ tracking: "follow" | "pinned" }>(
        db,
        sql`SELECT profile_tracking AS tracking FROM agents WHERE id = ${agentId}`,
      );
      const found = await rows<ProfileRow>(
        db,
        sql`SELECT p.id, p.version, p.definition, p.deny, p.created_by, ${LINEAGE("p")} AS lineage
          FROM installation_profiles p WHERE p.id IN (${targetProfileId}, ${activeProfileId})`,
      );
      const target = found.find((row) => row.id === targetProfileId);
      const active = found.find((row) => row.id === activeProfileId);
      const lineage = target?.lineage ?? null;
      const [newest] =
        lineage === null
          ? []
          : await rows<ProfileRow>(
              db,
              sql`SELECT p.id, p.version, p.definition, p.deny, p.created_by, ${LINEAGE("p")} AS lineage
                FROM installation_profiles p
                WHERE p.origin = 'console' AND ${LINEAGE("p")} = ${lineage}
                ORDER BY p.version DESC LIMIT 1`,
            );
      return {
        tracking: agent?.tracking ?? null,
        sameLineage:
          lineage !== null &&
          active !== undefined &&
          active.lineage === lineage,
        latest: newest === undefined ? null : profileOf(newest),
        active: active === undefined ? null : profileOf(active),
      };
    },

    async backfill({
      dryRun,
    }): Promise<BackfillReport | { refused: "rollouts_exist" }> {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        // Once recorded, the fill is done: agents that came after it are the
        // sweep's, so a later run reports nothing and writes nothing.
        if ((await rows(tx, sql`SELECT 1 FROM profile_fill`)).length > 0)
          return { dryRun, pinned: [], modelFollowsProfile: [] };
        const { behind: allBehind } = await behindLatest(tx);
        // A lineage that already has a rollout belongs to the sweep: pinning
        // its agents here would race the items the writer put in. They are
        // left alone, and the run is refused only when nothing else is left.
        const opened = await lineagesWithRollouts(tx);
        const behind = allBehind.filter(
          (agent) => !opened.has(agent.lineage as string),
        );
        if (!dryRun && allBehind.length > 0 && behind.length === 0)
          return { refused: "rollouts_exist" as const };
        const behindSorted = [...behind].sort((a, b) =>
          a.agent_id < b.agent_id ? -1 : a.agent_id > b.agent_id ? 1 : 0,
        );
        let pinned = behindSorted.map((agent) => agent.agent_id);
        const same = (
          await rows<{
            id: string;
            revision: number;
            behavior: number;
            lineage: string | null;
          }>(
            tx,
            sql`SELECT a.id, a.activation_revision AS revision,
              a.behavior_revision AS behavior, ${LINEAGE("p")} AS lineage
            FROM agents a
            JOIN agent_releases r ON r.id = a.active_release_id
            JOIN installation_profiles p ON p.id = r.runtime_profile_id
            WHERE a.model_source = 'fixed'
              AND r.runtime_config_snapshot ->> 'model' = p.definition ->> 'model'
            ORDER BY a.id`,
          )
        ).filter((row) => row.lineage === null || !opened.has(row.lineage));
        let modelFollowsProfile = same.map((row) => row.id);
        // Agent changes do not take the profile lock, so each update holds
        // only if the agent's release has not moved since it was read. The
        // report lists the rows written; a skipped agent shows up again in
        // the next dry run.
        if (!dryRun) {
          const pinnedNow: string[] = [];
          for (const agent of behindSorted) {
            const done = await rows(
              tx,
              sql`UPDATE agents SET profile_tracking = 'pinned'
                WHERE id = ${agent.agent_id}
                  AND activation_revision = ${agent.revision}
                RETURNING 1 AS ok`,
            );
            if (done.length > 0) pinnedNow.push(agent.agent_id);
          }
          const followedNow: string[] = [];
          for (const agent of same) {
            const done = await rows(
              tx,
              sql`UPDATE agents SET model_source = 'profile'
                WHERE id = ${agent.id} AND model_source = 'fixed'
                  AND activation_revision = ${agent.revision}
                  AND behavior_revision = ${agent.behavior}
                RETURNING 1 AS ok`,
            );
            if (done.length > 0) followedNow.push(agent.id);
          }
          pinned = pinnedNow;
          modelFollowsProfile = followedNow;
          await tx.execute(
            sql`INSERT INTO profile_fill (id) VALUES (1) ON CONFLICT DO NOTHING`,
          );
        }
        return { dryRun, pinned, modelFollowsProfile };
      });
    },
  };
}
