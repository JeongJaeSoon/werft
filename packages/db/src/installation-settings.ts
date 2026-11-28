import {
  type CatalogProviderConfig,
  type CatalogRepositoryConfig,
  catalogProviderSchema,
  catalogRepositorySchema,
  type InstallationSettingsStore,
  type ModelFamilies,
  modelFamiliesSchema,
  type SecretKey,
  type SecretOwnerRef,
  type StoredOwnerKind,
} from "@werft-ai/platform";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  pushRequests,
  type SettingsCredentialSource,
  settingsGeneration,
  workspaces,
} from "./schema.ts";
import { openSecretsOf, writeSecretInTx } from "./secrets/secret-values.ts";

const PURPOSE = "settings_credential";

type RepositoryRow = typeof catalogRepositories.$inferSelect;

function repositoryConfigOf(row: RepositoryRow): unknown {
  return {
    url: row.url,
    branch: row.branch,
    ...(row.auth === null ? {} : { auth: row.auth }),
  };
}

function ownStoredRef(
  kind: StoredOwnerKind,
  id: string,
  source: SettingsCredentialSource | null,
  auth: { stored?: string | undefined } | undefined,
): string | null | false {
  const stored = auth?.stored;
  if (stored === undefined) return source === "stored" ? false : null;
  return source === "stored" && stored === `${kind}:${id}` ? stored : false;
}

async function generationIn(tx: Database): Promise<number> {
  const [row] = await tx
    .select({ generation: settingsGeneration.generation })
    .from(settingsGeneration)
    .where(eq(settingsGeneration.id, 1));
  return row?.generation ?? 0;
}

/**
 * `settings_generation` as stored now: one row read without a lock, so it
 * waits on no settings writer and no claim.
 */
export function readSettingsGeneration(db: Database): Promise<number> {
  return generationIn(db);
}

/**
 * For a write the row triggers do not see, a stored value's: every replica
 * reads the settings again before its next provider grant. Under
 * `lockSettingsGeneration`, taken by the caller.
 */
export async function raiseSettingsGeneration(tx: Database): Promise<void> {
  await tx
    .update(settingsGeneration)
    .set({ generation: sql`${settingsGeneration.generation} + 1` })
    .where(eq(settingsGeneration.id, 1));
}

/**
 * Taken by every settings writer before it locks a settings row: each row
 * write raises the generation through its trigger, so two writers that
 * lock rows first would take the generation in opposite orders.
 */
export async function lockSettingsGeneration(tx: Database): Promise<void> {
  await tx
    .select({ id: settingsGeneration.id })
    .from(settingsGeneration)
    .for("update");
}

async function ownsStoredValue(
  tx: Database,
  owner: { kind: StoredOwnerKind; id: string },
): Promise<boolean> {
  const ref = `${owner.kind}:${owner.id}`;
  const rows =
    owner.kind === "connection"
      ? await tx
          .select({ id: providerConnections.id })
          .from(providerConnections)
          .where(
            and(
              eq(providerConnections.id, owner.id),
              eq(providerConnections.credentialSource, "stored"),
              sql`${providerConnections.definition}->'auth'->>'stored' = ${ref}`,
            ),
          )
          .for("update")
      : owner.kind === "repository"
        ? await tx
            .select({ id: catalogRepositories.id })
            .from(catalogRepositories)
            .where(
              and(
                eq(catalogRepositories.id, owner.id),
                eq(catalogRepositories.credentialSource, "stored"),
                sql`${catalogRepositories.auth}->>'stored' = ${ref}`,
              ),
            )
            .for("update")
        : await tx
            .select({ id: mcpServers.id })
            .from(mcpServers)
            .where(
              and(
                eq(mcpServers.id, owner.id),
                eq(mcpServers.credentialSource, "stored"),
                sql`${mcpServers.auth}->>'stored' = ${ref}`,
              ),
            )
            .for("update");
  return rows.length > 0;
}

/**
 * Migration 0288 moved an explicit App's key to the repository's own stored
 * value, which changed its binding (carried_binding), and left the push
 * requests made before it on the old one: push_requests grows, so it is not
 * rewritten inside a migration. Setting the key moves them, since only then
 * can a pull request be opened from them again. EXCLUSIVE waits out inserts
 * still to commit; a busy table makes the write fail and the person retry.
 */
export async function rebindCarriedPushes(
  tx: Database,
  repositoryId: string,
): Promise<void> {
  const [row] = await tx
    .select({ carried: catalogRepositories.carriedBinding })
    .from(catalogRepositories)
    .where(eq(catalogRepositories.id, repositoryId));
  const carried = row?.carried;
  if (carried === null || carried === undefined) return;
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(sql`LOCK TABLE ${pushRequests} IN EXCLUSIVE MODE`);
  await tx
    .update(pushRequests)
    .set({ repositoryBinding: carried.to })
    .where(eq(pushRequests.repositoryBinding, carried.from));
}

/** Installation-owned secrets are kept under the oldest workspace. */
export async function secretOwnerWorkspace(
  tx: Database,
): Promise<string | null> {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return workspace?.id ?? null;
}

export function createPostgresInstallationSettingsStore(
  db: Database,
  /** Null when the secret store is off: no stored value is read or set. */
  key: SecretKey | null,
): InstallationSettingsStore {
  return {
    read(options) {
      return db.transaction(
        async (tx) => {
          // First: a row read below is never older than this generation.
          const generation = await generationIn(tx);
          const invalid: string[] = [];
          const refs: string[] = [];
          const connections: Array<{
            id: string;
            provider: CatalogProviderConfig;
            models: string[];
            model_families?: ModelFamilies;
            network?: "public" | "private";
          }> = [];
          for (const row of await tx
            .select()
            .from(providerConnections)
            .where(isNull(providerConnections.disabledAt))
            .orderBy(asc(providerConnections.id))) {
            const parsed = catalogProviderSchema.safeParse(row.definition);
            const ref = parsed.success
              ? ownStoredRef(
                  "connection",
                  row.id,
                  row.credentialSource,
                  parsed.data.auth,
                )
              : false;
            if (!parsed.success || ref === false) {
              invalid.push(`connection:${row.id}`);
              continue;
            }
            if (ref !== null) refs.push(ref);
            // A list a later image wrote in another shape offers nothing.
            const models = Array.isArray(row.models)
              ? row.models.filter(
                  (model): model is string =>
                    typeof model === "string" && model !== "",
                )
              : [];
            const families =
              row.modelFamilies === null
                ? undefined
                : modelFamiliesSchema.safeParse(row.modelFamilies);
            connections.push({
              id: row.id,
              provider: parsed.data,
              models,
              ...(families?.success ? { model_families: families.data } : {}),
              // A value a later image wrote in another spelling says nothing.
              ...(row.network === "public" || row.network === "private"
                ? { network: row.network }
                : {}),
            });
          }
          const repositories: Array<{
            id: string;
            repository: CatalogRepositoryConfig;
          }> = [];
          for (const row of await tx
            .select()
            .from(catalogRepositories)
            .where(
              and(
                isNull(catalogRepositories.removedAt),
                ne(catalogRepositories.authKind, "github_app"),
              ),
            )
            .orderBy(asc(catalogRepositories.id))) {
            const parsed = catalogRepositorySchema.safeParse(
              repositoryConfigOf(row),
            );
            const ref = parsed.success
              ? ownStoredRef(
                  "repository",
                  row.id,
                  row.credentialSource,
                  parsed.data.auth,
                )
              : false;
            if (!parsed.success || ref === false) {
              invalid.push(`repository:${row.id}`);
              continue;
            }
            if (ref !== null) refs.push(ref);
            repositories.push({ id: row.id, repository: parsed.data });
          }
          // `mcp_servers` is not read: the installation catalog MCP is
          // retired (0304), and its values are never opened.
          let stored = new Map<string, string>();
          if (options?.openStored && key !== null && refs.length > 0) {
            const workspaceId = await secretOwnerWorkspace(tx);
            if (workspaceId !== null) {
              stored = await openSecretsOf(
                tx,
                key,
                workspaceId,
                PURPOSE,
                refs as SecretOwnerRef[],
              );
            }
          }
          return {
            generation,
            connections,
            repositories,
            stored,
            invalid,
          };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    putStoredValue(owner, value, updatedBy) {
      if (key === null) {
        return Promise.reject(
          new Error("the secret store is off: no value can be stored"),
        );
      }
      return db.transaction(async (tx) => {
        await lockSettingsGeneration(tx);
        // A value is bound to the destination of the row it names; with no
        // such row, a row made later on that id would take it.
        if (!(await ownsStoredValue(tx, owner))) {
          throw new Error(
            `${owner.kind}:${owner.id} is no settings row that stores its own value`,
          );
        }
        const workspaceId = await secretOwnerWorkspace(tx);
        if (workspaceId === null) {
          throw new Error("no workspace yet to keep a stored value under");
        }
        const changed = await writeSecretInTx(
          tx,
          key,
          { workspaceId, owner, purpose: PURPOSE },
          value,
          updatedBy,
        );
        if (owner.kind === "repository") {
          await rebindCarriedPushes(tx, owner.id);
        }
        if (changed) await raiseSettingsGeneration(tx);
      });
    },
  };
}
