import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockSettingsGeneration } from "./installation-settings.ts";
import { holdsRight, lockedRole } from "./musterrolle/api-keys.ts";
import type { Database } from "./queries.ts";
import {
  agentReleases,
  agents,
  catalogRepositories,
  receipts,
} from "./schema.ts";

type Row = typeof catalogRepositories.$inferSelect;

function rowOf(row: Row): CatalogRepositoryRow {
  return {
    id: row.id,
    github_repository_id: row.githubRepositoryId,
    owner: row.owner,
    name: row.name,
    url: row.url,
    branch: row.branch,
    profiles: row.profiles ?? null,
    source:
      row.source === "seed" || row.source === "selection"
        ? row.source
        : "console",
    version: row.version,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const githubAppRows = eq(catalogRepositories.authKind, "github_app");

// The import and every console write take it, so an id is decided by one
// writer at a time. A transaction that also locks an agent, an App or the
// workspace's settings takes this first: profile backfills hold it before
// they update agents.
export const lockCatalogWrites = async (tx: Database) => lockWrites(tx);
const lockWrites = async (tx: Database) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'))`,
  );
  await lockSettingsGeneration(tx);
};

const managerOf = async (tx: Database, workspaceId: string, userId: string) => {
  // A demotion or disable committed after the policy's check wins.
  const role = await lockedRole(tx, workspaceId, userId);
  return role === "owner" || role === "admin";
};

async function receipt(
  tx: Database,
  input: {
    workspaceId: string;
    actor: ReceiptActor;
    requestId: string | null;
    receiptId?: string;
    operation:
      | "resolve_repository"
      | "set_repository_branch"
      | "import_repository";
    result: Record<string, unknown>;
  },
) {
  await tx.insert(receipts).values({
    id: input.receiptId ?? randomUUID(),
    ownerId: input.workspaceId,
    actor: input.actor,
    operation: input.operation,
    targetRef: {
      resource: { kind: "workspace", id: input.workspaceId },
      workspace_id: input.workspaceId,
    },
    result: input.result,
    status: "succeeded",
    requestId: input.requestId,
  });
}

const auditOf = (row: CatalogRepositoryRow) => ({
  repository_id: row.id,
  repository: `${row.owner}/${row.name}`,
  github_repository_id: row.github_repository_id,
  full_name: `${row.owner}/${row.name}`,
  url: row.url,
  branch: row.branch,
});

type ResolveInput = Parameters<CatalogRepositoryStore["resolve"]>[0];
type ResolveResult = ReturnType<CatalogRepositoryStore["resolve"]>;

export type PostgresCatalogRepositoryStore = CatalogRepositoryStore & {
  resolve(input: ResolveInput, joined?: Database): ResolveResult;
};

export function createPostgresCatalogRepositoryStore(
  db: Database,
): PostgresCatalogRepositoryStore {
  const listActive = async () => {
    const rows = await db
      .select()
      .from(catalogRepositories)
      .where(and(isNull(catalogRepositories.removedAt), githubAppRows))
      .orderBy(asc(catalogRepositories.id));
    return rows.map(rowOf);
  };
  return {
    listActive,

    async listAgentChoosable() {
      const rows = await db
        .select()
        .from(catalogRepositories)
        .where(
          and(
            isNull(catalogRepositories.removedAt),
            inArray(catalogRepositories.authKind, [
              "github_app",
              "github_app_explicit",
            ]),
          ),
        )
        .orderBy(asc(catalogRepositories.id));
      return rows.map(rowOf);
    },

    // One snapshot: an import committing between two reads would otherwise
    // read as "filled, with no rows".
    readCatalog() {
      return db.transaction(
        async (tx) => {
          const rows = await tx
            .select()
            .from(catalogRepositories)
            .where(githubAppRows)
            .orderBy(asc(catalogRepositories.id));
          if (rows.length === 0) return null;
          return rows.filter((row) => row.removedAt === null).map(rowOf);
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    resolve(input: ResolveInput, joined?: Database) {
      // Under the lock, so two first picks of one repository get one row
      // and two repositories never take the same id. `joined` is a caller's
      // transaction that this one then belongs to; its locks must already
      // follow `lockCatalogWrites` first.
      const run = async (tx: Database) => {
        await lockWrites(tx);
        // A demotion or a managing-team change committed after the policy's
        // decision on the agent wins.
        const role = await lockedRole(tx, input.workspaceId, input.userId);
        if (role === null) return { outcome: "actor_inactive" as const };
        if (
          !(await holdsRight(tx, input.workspaceId, input.userId, {
            role,
            roles: input.managerRoles,
            agentId: input.agentId.toLowerCase(),
          }))
        ) {
          return { outcome: "outranked" as const };
        }
        const active = and(
          isNull(catalogRepositories.removedAt),
          githubAppRows,
        );
        const sameName = sql`lower(${catalogRepositories.owner}) = lower(${input.owner}) AND lower(${catalogRepositories.name}) = lower(${input.name})`;
        const [byId] = await tx
          .select()
          .from(catalogRepositories)
          .where(
            and(
              active,
              eq(
                catalogRepositories.githubRepositoryId,
                input.githubRepositoryId,
              ),
            ),
          );
        const [byName] = await tx
          .select()
          .from(catalogRepositories)
          .where(and(active, sameName));
        // Another row holds the name: one of another GitHub repository (the
        // one that had it was renamed or deleted), or one never tied to an id
        // beside this repository's own row.
        if (
          byName !== undefined &&
          (byId === undefined
            ? byName.githubRepositoryId !== null
            : byName.id !== byId.id)
        ) {
          return { outcome: "name_held" as const, id: byName.id };
        }
        if (byId) {
          if (byName !== undefined) {
            return {
              outcome: "resolved" as const,
              repository: rowOf(byId),
              created: false,
              changed: false,
            };
          }
          // Renamed on GitHub: the row follows, so sessions clone the new URL.
          const [renamed] = await tx
            .update(catalogRepositories)
            .set({
              owner: input.owner,
              name: input.name,
              url: input.url,
              version: sql`${catalogRepositories.version} + 1`,
              updatedAt: sql`now()`,
              updatedBy: input.userId,
            })
            .where(eq(catalogRepositories.id, byId.id))
            .returning();
          if (!renamed)
            throw new Error("catalog repository update returned no row");
          const repository = rowOf(renamed);
          await receipt(tx, {
            workspaceId: input.workspaceId,
            actor: input.actor,
            requestId: input.requestId,
            receiptId: input.receiptId,
            operation: "resolve_repository",
            result: {
              ...auditOf(repository),
              previous_full_name: `${byId.owner}/${byId.name}`,
            },
          });
          return {
            outcome: "resolved" as const,
            repository,
            created: false,
            changed: true,
          };
        }
        if (byName) {
          const [filled] = await tx
            .update(catalogRepositories)
            .set({ githubRepositoryId: input.githubRepositoryId })
            .where(eq(catalogRepositories.id, byName.id))
            .returning();
          if (!filled)
            throw new Error("catalog repository update returned no row");
          return {
            outcome: "resolved" as const,
            repository: rowOf(filled),
            created: false,
            changed: false,
          };
        }
        // Removed rows keep their id: none is ever handed out twice.
        const taken = new Set(
          (
            await tx
              .select({ id: catalogRepositories.id })
              .from(catalogRepositories)
          ).map((row) => row.id),
        );
        let id = input.base;
        for (let n = 2; taken.has(id); n += 1) {
          id = `${input.base}-${n}`;
        }
        const [row] = await tx
          .insert(catalogRepositories)
          .values({
            id,
            githubRepositoryId: input.githubRepositoryId,
            owner: input.owner,
            name: input.name,
            url: input.url,
            branch: input.branch,
            source: "selection",
            createdBy: input.userId,
            updatedBy: input.userId,
          })
          .returning();
        if (!row) throw new Error("catalog repository insert returned no row");
        const repository = rowOf(row);
        await receipt(tx, {
          workspaceId: input.workspaceId,
          actor: input.actor,
          requestId: input.requestId,
          receiptId: input.receiptId,
          operation: "resolve_repository",
          result: auditOf(repository),
        });
        return {
          outcome: "resolved" as const,
          repository,
          created: true,
          changed: true,
        };
      };
      return joined === undefined ? db.transaction(run) : run(joined);
    },

    async agentCounts() {
      const rows = await db
        .select({
          id: sql<string>`ids.id`,
          count: sql<number>`count(DISTINCT ${agents.id})::int`,
          reviewing: sql<number>`(count(DISTINCT ${agents.id}) FILTER (WHERE ${agentReleases.policyPins} #>> '{github,features,review}' = 'true'))::int`,
        })
        .from(agents)
        .innerJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
        .innerJoin(
          sql`LATERAL (SELECT jsonb_array_elements_text(coalesce(${agentReleases.policyPins} -> 'github' -> 'repositories', '[]'::jsonb)) UNION SELECT ${agentReleases.repositoryId} WHERE ${agentReleases.repositoryId} IS NOT NULL) AS ids(id)`,
          sql`true`,
        )
        .groupBy(sql`ids.id`);
      return new Map(
        rows.map((row) => [
          row.id,
          { author: row.count, reviewer: row.reviewing },
        ]),
      );
    },

    setBranch(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        if (!(await managerOf(tx, input.workspaceId, input.userId))) {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select()
          .from(catalogRepositories)
          .where(
            and(
              eq(catalogRepositories.id, input.id),
              isNull(catalogRepositories.removedAt),
              githubAppRows,
            ),
          )
          .limit(1);
        if (!held) return { outcome: "not_found" as const };
        if (held.version !== input.version) {
          return { outcome: "revision_conflict" as const };
        }
        const [row] = await tx
          .update(catalogRepositories)
          .set({
            branch: input.branch,
            version: held.version + 1,
            updatedBy: input.userId,
            updatedAt: sql`now()`,
          })
          .where(eq(catalogRepositories.id, input.id))
          .returning();
        if (!row) throw new Error("catalog repository update returned no row");
        const repository = rowOf(row);
        await receipt(tx, {
          workspaceId: input.workspaceId,
          actor: input.actor,
          requestId: input.requestId,
          receiptId: input.receiptId,
          operation: "set_repository_branch",
          result: {
            ...auditOf(repository),
            before: held.branch,
            version: repository.version,
          },
        });
        return { outcome: "stored" as const, repository };
      });
    },
  };
}
