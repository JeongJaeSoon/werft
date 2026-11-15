import { randomUUID } from "node:crypto";
import { canonicalJson } from "@werft-ai/contracts";
import {
  CatalogCredentialError,
  type CatalogMcpServerConfig,
  type CatalogProviderConfig,
  type CatalogRepositoryConfig,
  catalogMcpServerSchema,
  catalogProviderSchema,
  catalogRepositorySchema,
  describeConfigError,
  type EnvCredentialCarry,
  type InstallationSettingsStore,
  type ModelFamilies,
  modelFamiliesSchema,
  repositoryBinding,
  resolveCredential,
  resolveSessionCatalog,
  type SecretKey,
  type SecretOwnerRef,
  type StoredOwnerKind,
} from "@werft-ai/platform";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { lockCatalogWrites } from "./catalog-repositories.ts";
import type { Database } from "./queries.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  pushRequests,
  receipts,
  type SettingsCredentialSource,
  settingsGeneration,
  workerCredentials,
  workspaces,
} from "./schema.ts";
import { openSecretsOf, writeSecretInTx } from "./secrets/secret-values.ts";

const PURPOSE = "settings_credential";

const TARGET: Record<StoredOwnerKind, string> = {
  connection: "connection_id",
  repository: "repository_id",
  mcp: "mcp_server_id",
};

type EnvRow = {
  kind: StoredOwnerKind;
  id: string;
  auth: Record<string, unknown> & { value_env: string };
  /** A connection's whole definition, `auth` inside it. */
  definition?: Record<string, unknown>;
  /** A repository's place, which its binding hashes with `auth`. */
  place?: { url: string; branch: string };
};

type Binding = { from: string; to: string };

function namesEnv(auth: unknown): auth is EnvRow["auth"] {
  return (
    typeof auth === "object" &&
    auth !== null &&
    typeof (auth as { value_env?: unknown }).value_env === "string"
  );
}

/**
 * Enabled rows whose credential names an env variable. Given `only`, that
 * one row, locked.
 */
async function envRows(
  tx: Database,
  only?: { kind: StoredOwnerKind; id: string },
): Promise<EnvRow[]> {
  const wants = (kind: StoredOwnerKind) =>
    only === undefined || only.kind === kind;
  const rows: EnvRow[] = [];
  if (wants("connection")) {
    const query = tx
      .select({
        id: providerConnections.id,
        definition: providerConnections.definition,
      })
      .from(providerConnections)
      .where(
        and(
          isNull(providerConnections.disabledAt),
          eq(providerConnections.credentialSource, "external"),
          only === undefined ? undefined : eq(providerConnections.id, only.id),
        ),
      );
    for (const row of await (only === undefined
      ? query
      : query.for("update"))) {
      const auth = row.definition.auth;
      if (namesEnv(auth)) {
        rows.push({
          kind: "connection",
          id: row.id,
          auth,
          definition: row.definition,
        });
      }
    }
  }
  if (wants("repository")) {
    const query = tx
      .select({
        id: catalogRepositories.id,
        auth: catalogRepositories.auth,
        url: catalogRepositories.url,
        branch: catalogRepositories.branch,
      })
      .from(catalogRepositories)
      .where(
        and(
          isNull(catalogRepositories.removedAt),
          // A URL repository is no catalog entry since #1178: nothing reads
          // its token, so there is nothing to carry.
          eq(catalogRepositories.authKind, "github_app_explicit"),
          eq(catalogRepositories.credentialSource, "external"),
          only === undefined ? undefined : eq(catalogRepositories.id, only.id),
        ),
      );
    for (const row of await (only === undefined
      ? query
      : query.for("update"))) {
      if (namesEnv(row.auth)) {
        rows.push({
          kind: "repository",
          id: row.id,
          auth: row.auth,
          place: { url: row.url, branch: row.branch },
        });
      }
    }
  }
  if (wants("mcp")) {
    const query = tx
      .select({ id: mcpServers.id, auth: mcpServers.auth })
      .from(mcpServers)
      .where(
        and(
          isNull(mcpServers.disabledAt),
          eq(mcpServers.credentialSource, "external"),
          only === undefined ? undefined : eq(mcpServers.id, only.id),
        ),
      );
    for (const row of await (only === undefined
      ? query
      : query.for("update"))) {
      if (namesEnv(row.auth)) {
        rows.push({ kind: "mcp", id: row.id, auth: row.auth });
      }
    }
  }
  return rows;
}

function storedAuth(row: EnvRow): Record<string, unknown> {
  const { value_env: _name, ...kept } = row.auth;
  return { ...kept, stored: `${row.kind}:${row.id}` };
}

const MIN_SEALED_CHARACTERS = 8;

/**
 * The value as the catalog takes it and, for a repository, its binding
 * before and after the move. Throws as the catalog would, naming where the
 * reference sits and never the value.
 */
function carriedValue(
  row: EnvRow,
  value: string,
): { value: string; binding?: Binding } {
  const lookup = () => value;
  const ref = { value_env: row.auth.value_env };
  if (row.kind !== "repository") {
    const path = `${row.kind === "connection" ? "connections" : "mcp_servers"}.${row.id}.auth`;
    const checked = resolveCredential(path, ref, lookup);
    // A sealed value shows its last four characters. The catalog counts
    // bytes, which a non-ASCII value meets with fewer characters.
    if ([...checked].length < MIN_SEALED_CHARACTERS) {
      throw new CatalogCredentialError(
        path,
        ref,
        `is shorter than ${MIN_SEALED_CHARACTERS} characters`,
      );
    }
    return { value: checked };
  }
  const listed = (auth: Record<string, unknown>) => {
    const config = catalogRepositorySchema.parse({ ...row.place, auth });
    const repository = resolveSessionCatalog(
      { repositories: { [row.id]: config } },
      lookup,
    ).repositories[row.id];
    if (repository?.auth === undefined || !("value" in repository.auth)) {
      throw new Error(`repositories.${row.id}.auth names no App key`);
    }
    return { repository, value: repository.auth.value };
  };
  const before = listed(row.auth);
  return {
    value: before.value,
    binding: {
      from: repositoryBinding(row.id, before.repository),
      to: repositoryBinding(row.id, listed(storedAuth(row)).repository),
    },
  };
}

/**
 * Moves the rows that held exactly the repository's old binding to its new
 * one: the push requests a pull request is opened, updated and merged from,
 * and the worker credentials a running session's token is reissued under.
 * A replica that has not read the move yet still inserts the old one; the
 * tables' insert triggers move those once this commits, and the lock waits
 * out inserts already made in transactions that commit later. EXCLUSIVE
 * also waits out row locks (`FOR UPDATE`), so the rewrite never queues
 * behind a writer that then queues behind the lock; a busy table makes the
 * carry fail and try again on the next read.
 */
async function rebind(
  tx: Database,
  { from, to }: Binding,
): Promise<{ push_requests: number; worker_credentials: number }> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(
    sql`LOCK TABLE ${pushRequests}, ${workerCredentials} IN EXCLUSIVE MODE`,
  );
  const pushes = await tx
    .update(pushRequests)
    .set({ repositoryBinding: to })
    .where(eq(pushRequests.repositoryBinding, from))
    .returning({ id: pushRequests.id });
  const credentials = await tx
    .update(workerCredentials)
    .set({ binding: to })
    .where(
      and(
        eq(workerCredentials.purpose, "repository"),
        eq(workerCredentials.binding, from),
      ),
    )
    .returning({ attemptId: workerCredentials.attemptId });
  return {
    push_requests: pushes.length,
    worker_credentials: credentials.length,
  };
}

/** The row names its own stored value from now on; its old `auth` is kept. */
async function pointAtStored(
  tx: Database,
  row: EnvRow,
  binding: Binding | undefined,
): Promise<void> {
  const auth = storedAuth(row);
  switch (row.kind) {
    case "connection":
      await tx
        .update(providerConnections)
        .set({
          definition: { ...row.definition, auth },
          credentialSource: "stored",
          carriedAuth: row.auth,
        })
        .where(eq(providerConnections.id, row.id));
      return;
    case "repository":
      await tx
        .update(catalogRepositories)
        .set({
          auth,
          credentialSource: "stored",
          carriedAuth: row.auth,
          carriedBinding: binding ?? null,
          version: sql`${catalogRepositories.version} + 1`,
          updatedBy: null,
          updatedAt: sql`now()`,
        })
        .where(eq(catalogRepositories.id, row.id));
      return;
    case "mcp":
      await tx
        .update(mcpServers)
        .set({ auth, credentialSource: "stored", carriedAuth: row.auth })
        .where(eq(mcpServers.id, row.id));
      return;
  }
}

type RepositoryRow = typeof catalogRepositories.$inferSelect;
type McpRow = typeof mcpServers.$inferSelect;

function repositoryConfigOf(row: RepositoryRow): unknown {
  return {
    url: row.url,
    branch: row.branch,
    ...(row.auth === null ? {} : { auth: row.auth }),
  };
}

function mcpConfigOf(row: McpRow): unknown {
  return {
    url: row.url,
    credential_ref: row.credentialRef,
    auth: row.auth,
    workspaces: row.workspaces,
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
            replaces?: CatalogProviderConfig;
            models: string[];
            model_families?: ModelFamilies;
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
            const former =
              row.replacesAuth === null
                ? undefined
                : catalogProviderSchema.safeParse({
                    ...row.definition,
                    auth: row.replacesAuth,
                  });
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
              ...(former?.success ? { replaces: former.data } : {}),
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
          const servers: Array<{ id: string; server: CatalogMcpServerConfig }> =
            [];
          for (const row of await tx
            .select()
            .from(mcpServers)
            .where(isNull(mcpServers.disabledAt))
            .orderBy(asc(mcpServers.id))) {
            const parsed = catalogMcpServerSchema.safeParse(mcpConfigOf(row));
            const ref = parsed.success
              ? ownStoredRef(
                  "mcp",
                  row.id,
                  row.credentialSource,
                  parsed.data.auth,
                )
              : false;
            if (!parsed.success || ref === false) {
              invalid.push(`mcp:${row.id}`);
              continue;
            }
            if (ref !== null) refs.push(ref);
            servers.push({ id: row.id, server: parsed.data });
          }
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
            mcpServers: servers,
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
        await writeSecretInTx(
          tx,
          key,
          { workspaceId, owner, purpose: PURPOSE },
          value,
          updatedBy,
        );
      });
    },

    async carryEnvCredentials(env) {
      const outcomes: EnvCredentialCarry[] = [];
      for (const listed of await envRows(db)) {
        const entry = `${listed.kind}:${listed.id}`;
        const name = listed.auth.value_env;
        const value = env(name);
        if (value === undefined || value === "") {
          outcomes.push({ entry, env: name, outcome: "missing" });
          continue;
        }
        if (key === null) {
          outcomes.push({ entry, env: name, outcome: "waiting" });
          continue;
        }
        try {
          const outcome = await db.transaction(
            async (tx): Promise<EnvCredentialCarry | null> => {
              await lockCatalogWrites(tx);
              const [row] = await envRows(tx, listed);
              // Disabled, moved or rewritten since it was listed: whoever
              // did that decided, and another replica may have moved it.
              if (
                row === undefined ||
                canonicalJson(row.auth) !== canonicalJson(listed.auth)
              ) {
                return null;
              }
              let carried: ReturnType<typeof carriedValue>;
              try {
                carried = carriedValue(row, value);
              } catch (error) {
                // Sealed, a value the catalog refuses would show its last
                // four characters for no use.
                return {
                  entry,
                  env: name,
                  outcome: "invalid",
                  reason: describeConfigError(error),
                };
              }
              const workspaceId = await secretOwnerWorkspace(tx);
              if (workspaceId === null) {
                return { entry, env: name, outcome: "waiting" };
              }
              // Before pointAtStored writes the row, so the table lock is
              // waited for holding only the catalog lock and this row's,
              // which no writer of the two tables waits on.
              const rebound =
                carried.binding === undefined
                  ? undefined
                  : await rebind(tx, carried.binding);
              await pointAtStored(tx, row, carried.binding);
              await writeSecretInTx(
                tx,
                key,
                {
                  workspaceId,
                  owner: { kind: row.kind, id: row.id },
                  purpose: PURPOSE,
                },
                carried.value,
                null,
              );
              await tx.insert(receipts).values({
                id: randomUUID(),
                ownerId: workspaceId,
                operation: "set_settings_credential",
                targetRef: {
                  resource: { kind: "workspace", id: workspaceId },
                  workspace_id: workspaceId,
                },
                status: "succeeded",
                result: {
                  [TARGET[row.kind]]: row.id,
                  replaced: "value_env",
                  value_env: name,
                  by: "env_import",
                  ...(rebound === undefined ? {} : { rebound }),
                },
              });
              return {
                entry,
                env: name,
                outcome: "carried",
                ...(rebound === undefined ? {} : { rebound }),
              };
            },
          );
          if (outcome !== null) outcomes.push(outcome);
        } catch {
          outcomes.push({ entry, env: name, outcome: "failed" });
        }
      }
      return outcomes;
    },
  };
}
