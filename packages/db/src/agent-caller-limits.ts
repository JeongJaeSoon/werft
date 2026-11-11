import type {
  AgentCallerLimitRule,
  AgentCallerLimits,
} from "@werft-ai/contracts";
import type {
  AgentCallerLimitsStore,
  CallerLimitRuleFacts,
  CallerLimitsFacts,
  PutAgentCallerLimitsResult,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { lockEditRight } from "./agent-usage.ts";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agentCallerLimits,
  agents,
  agentUsage,
  catalogRepositories,
  receipts,
} from "./schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An edit takes rows in the order of agent-usage.ts: user → membership →
// agent → agent_usage → admin rows → teams (id order) → relation rows → the
// actor's member rows. Whoever writes this agent's rules holds its
// agent_usage row (this edit, a team's archive), so the rules need no lock of
// their own. The v1 API never sees a `user` rule, and an edit leaves those rows
// as they are.

type Reader = Pick<Database, "select">;
type Row = typeof agentCallerLimits.$inferSelect;

const sorted = (list: readonly string[] | null) =>
  list === null ? null : [...list].sort();

function ruleOf(row: Row): CallerLimitRuleFacts {
  const target: CallerLimitRuleFacts["target"] =
    row.targetKind === "team"
      ? { kind: "team", id: row.teamId as string }
      : row.targetKind === "channel"
        ? { kind: "channel", id: row.channelId as string }
        : row.targetKind === "user"
          ? { kind: "user", id: row.userId as string }
          : { kind: "workspace" };
  return {
    target,
    tools_deny: sorted(row.toolsDeny) ?? [],
    repositories: sorted(row.repositories),
    mcp_servers: sorted(row.mcpServers),
    credentials_deny: sorted(row.credentialsDeny) ?? [],
  };
}

const KIND_ORDER = { workspace: 0, team: 1, channel: 2, user: 3 } as const;

function keyOf(target: CallerLimitRuleFacts["target"]): string {
  return target.kind === "workspace"
    ? "workspace"
    : `${target.kind}:${target.id.toLowerCase()}`;
}

function inOrder(rules: CallerLimitRuleFacts[]): CallerLimitRuleFacts[] {
  return rules.sort(
    (a, b) =>
      KIND_ORDER[a.target.kind] - KIND_ORDER[b.target.kind] ||
      keyOf(a.target).localeCompare(keyOf(b.target)),
  );
}

/** The rules, `user` rows included when asked, read in one statement with the revision. */
async function readFacts(
  tx: Reader,
  agentId: string,
  withUsers: boolean,
): Promise<CallerLimitsFacts | null> {
  // One statement, so the revision belongs to the rules beside it.
  const rows = await tx
    .select({
      revision: agentUsage.limitsRevision,
      rule: agentCallerLimits,
    })
    .from(agentUsage)
    .leftJoin(
      agentCallerLimits,
      and(
        eq(agentCallerLimits.agentId, agentUsage.agentId),
        withUsers ? undefined : ne(agentCallerLimits.targetKind, "user"),
      ),
    )
    .where(eq(agentUsage.agentId, agentId))
    .orderBy(asc(agentCallerLimits.id));
  const first = rows[0];
  if (!first) return null;
  return {
    rules: inOrder(
      rows.flatMap((row) => (row.rule === null ? [] : [ruleOf(row.rule)])),
    ),
    revision: first.revision,
  };
}

/**
 * The rules the enforcement layer (94S-918) reads in its own transaction.
 * Take it after the agent row, as `usageOf` does; with `lock` the agent_usage
 * row is held FOR SHARE, so an edit or a team's archive waits for this
 * transaction or is seen by it.
 */
export async function callerLimitsOf(
  tx: Reader,
  input: { workspaceId: string; agentId: string; lock: boolean },
): Promise<CallerLimitsFacts> {
  const base = tx
    .select({ agentId: agentUsage.agentId })
    .from(agentUsage)
    .where(
      and(
        eq(agentUsage.workspaceId, input.workspaceId),
        eq(agentUsage.agentId, input.agentId),
      ),
    );
  if (input.lock) await base.for("share");
  // An agent made by hand without its row reads as no rules.
  return (
    (await readFacts(tx, input.agentId, true)) ?? { rules: [], revision: 1 }
  );
}

function sameRule(a: CallerLimitRuleFacts, b: CallerLimitRuleFacts): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function put(
  db: Database,
  input: Parameters<AgentCallerLimitsStore["put"]>[0],
): Promise<PutAgentCallerLimitsResult> {
  const { actor } = input;
  if (!UUID.test(input.agentId)) return { outcome: "not_found" };
  const agentId = input.agentId.toLowerCase();
  const workspaceId = actor.workspaceId;
  const wanted = inOrder(
    input.rules.map((rule) => ({
      target:
        rule.target.kind === "team"
          ? { kind: "team" as const, id: rule.target.id.toLowerCase() }
          : rule.target,
      tools_deny: sorted(rule.tools_deny) ?? [],
      repositories: sorted(rule.repositories),
      mcp_servers: sorted(rule.mcp_servers),
      credentials_deny: sorted(rule.credentials_deny) ?? [],
    })),
  );
  return db.transaction(async (tx) => {
    const people = await lockPeople(tx, workspaceId, [actor.userId]);
    const me = people.find((p) => p.userId === actor.userId);
    if (!me?.live) return { outcome: "actor_inactive" };
    const manager = (input.managerRoles as readonly string[]).includes(me.role);

    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, agentId)))
      .for("no key update");
    if (!agent) return { outcome: manager ? "not_found" : "actor_inactive" };

    await tx
      .insert(agentUsage)
      .values({ agentId, workspaceId })
      .onConflictDoNothing();
    const [usage] = await tx
      .select()
      .from(agentUsage)
      .where(eq(agentUsage.agentId, agentId))
      .for("update");
    if (!usage) throw new Error(`agent_usage ${agentId} vanished under a lock`);

    const stored = await readFacts(tx, agentId, false);
    if (!stored) throw new Error(`agent_usage ${agentId} vanished in its tx`);
    const before = new Map(stored.rules.map((r) => [keyOf(r.target), r]));
    const added = wanted.flatMap((rule) =>
      rule.target.kind === "team" && !before.has(keyOf(rule.target))
        ? [rule.target.id]
        : [],
    );

    const right = await lockEditRight(tx, {
      workspaceId,
      agentId,
      actorUserId: actor.userId,
      manager,
      added,
    });
    if (!right) return { outcome: "actor_inactive" };
    if (usage.limitsRevision !== input.ifMatch) {
      return { outcome: "version_mismatch", current: usage.limitsRevision };
    }
    if (added.some((id) => !right.liveTeams.has(id))) {
      return { outcome: "team_not_found" };
    }
    if (!manager && added.some((id) => !right.roleIn.has(id))) {
      return { outcome: "team_not_allowed" };
    }

    // Only an id this edit adds to its target is looked up: one the target
    // already holds passes after the catalog dropped it, so the rule's other
    // fields stay editable.
    const newRepositories = [
      ...new Set(
        wanted.flatMap((rule) => {
          const held = before.get(keyOf(rule.target))?.repositories ?? [];
          return (rule.repositories ?? []).filter((id) => !held.includes(id));
        }),
      ),
    ];
    if (newRepositories.length > 0) {
      const live = new Set(
        (
          await tx
            .select({ id: catalogRepositories.id })
            .from(catalogRepositories)
            .where(
              and(
                inArray(catalogRepositories.id, newRepositories),
                isNull(catalogRepositories.removedAt),
              ),
            )
        ).map((row) => row.id),
      );
      const missing = newRepositories.filter((id) => !live.has(id)).sort();
      if (missing.length > 0) {
        return { outcome: "repository_not_in_catalog", repositoryIds: missing };
      }
    }

    const unchanged =
      wanted.length === stored.rules.length &&
      wanted.every((rule) => {
        const held = before.get(keyOf(rule.target));
        return held !== undefined && sameRule(held, rule);
      });
    if (unchanged) {
      return { outcome: "unchanged", limits: toLimits(stored) };
    }

    await tx
      .delete(agentCallerLimits)
      .where(
        and(
          eq(agentCallerLimits.agentId, agentId),
          ne(agentCallerLimits.targetKind, "user"),
        ),
      );
    if (wanted.length > 0) {
      await tx.insert(agentCallerLimits).values(
        wanted.map((rule) => ({
          agentId,
          workspaceId,
          targetKind: rule.target.kind as "workspace" | "team" | "channel",
          teamId: rule.target.kind === "team" ? rule.target.id : null,
          channelId: rule.target.kind === "channel" ? rule.target.id : null,
          toolsDeny: rule.tools_deny,
          repositories: rule.repositories,
          mcpServers: rule.mcp_servers,
          credentialsDeny: rule.credentials_deny,
          createdBy: actor.userId,
        })),
      );
    }
    await tx
      .update(agentUsage)
      .set({
        limitsRevision: sql`${agentUsage.limitsRevision} + 1`,
        updatedBy: actor.userId,
        updatedAt: DB_NOW,
      })
      .where(eq(agentUsage.agentId, agentId));
    const next = await readFacts(tx, agentId, false);
    if (!next) throw new Error(`agent_usage ${agentId} vanished in its tx`);
    await tx.insert(receipts).values({
      id: input.receiptId,
      ownerId: actor.principal.ownerId,
      actor: receiptActorOf(actor.principal),
      operation: "set_agent_caller_limits",
      targetRef: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
      result: {
        from: { rules: stored.rules },
        to: { rules: next.rules },
        revision: next.revision,
      },
      status: "succeeded",
      requestId: actor.principal.requestId ?? null,
    });
    return { outcome: "set", limits: toLimits(next) };
  });
}

// The API's rules never name a person.
function toLimits(facts: CallerLimitsFacts): AgentCallerLimits {
  return {
    rules: facts.rules.filter(
      (rule): rule is AgentCallerLimitRule => rule.target.kind !== "user",
    ),
    revision: facts.revision,
  };
}

export function createPostgresAgentCallerLimitsStore(
  db: Database,
): AgentCallerLimitsStore {
  return {
    async get(workspaceId, agentId) {
      if (!UUID.test(workspaceId) || !UUID.test(agentId)) return null;
      const id = agentId.toLowerCase();
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.workspaceId, workspaceId), eq(agents.id, id)));
      if (!agent) return null;
      // An agent without a row reads as the default it would be given.
      const facts = (await readFacts(db, id, false)) ?? {
        rules: [],
        revision: 1,
      };
      return toLimits(facts);
    },
    put: (input) => put(db, input),
  };
}
