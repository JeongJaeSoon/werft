import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  type ReceiptActor,
  type ReceiptOperation,
} from "@werft-ai/contracts";
import {
  type CatalogRepositoryConfig,
  credentialSourceOf,
  type ExistingSettings,
  type ExistingSettingsEntry,
  planSettingsImport,
  repositoryAuthKindOf,
  repositoryNameOf,
  type SecretKey,
  type SettingsConsoleResult,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsImportAdd,
  type SettingsKind,
  type TeamActor,
} from "@werft-ai/platform";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { rowsOf } from "./control-unit-of-work.ts";
import { lockSettingsGeneration } from "./installation-settings.ts";
import type { Database } from "./queries.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  receipts,
  secretValues,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secret-values.ts";

const PURPOSE = "settings_credential";

type RepositoryRow = typeof catalogRepositories.$inferSelect;
type McpRow = typeof mcpServers.$inferSelect;

/** The row as its settings entry: what the file would have spelled. */
function repositoryEntryOf(row: RepositoryRow): unknown {
  const auth =
    row.authKind === "github_app" ? { kind: "github_app" } : row.auth;
  return {
    url: row.url,
    branch: row.branch,
    ...(row.profiles === null ? {} : { profiles: row.profiles }),
    ...(auth === null ? {} : { auth }),
  };
}

function mcpEntryOf(row: McpRow): unknown {
  return {
    url: row.url,
    credential_ref: row.credentialRef,
    auth: row.auth,
    workspaces: row.workspaces,
  };
}

async function firstWorkspace(tx: Database): Promise<string | null> {
  const [workspace] = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return workspace?.id ?? null;
}

/** Each stored value's last four characters, by `<kind>:<id>`. */
async function storedLast4(
  tx: Database,
  workspaceId: string | null,
): Promise<Map<string, string>> {
  if (workspaceId === null) return new Map();
  const rows = await tx
    .select({ ownerRef: secretValues.ownerRef, last4: secretValues.last4 })
    .from(secretValues)
    .where(
      and(
        eq(secretValues.workspaceId, workspaceId),
        eq(secretValues.purpose, PURPOSE),
      ),
    );
  return new Map(rows.map((row) => [row.ownerRef, row.last4]));
}

async function existingIn(
  tx: Database,
  workspaceId: string | null,
): Promise<ExistingSettings> {
  const values = await storedLast4(tx, workspaceId);
  const entryOf = (
    kind: string,
    id: string,
    entry: unknown,
    active: boolean,
  ): [string, ExistingSettingsEntry] => [
    id,
    { entry, active, has_value: values.has(`${kind}:${id}`) },
  ];
  return {
    connections: new Map(
      (await tx.select().from(providerConnections)).map((row) => {
        const [id, existing] = entryOf(
          "connection",
          row.id,
          row.definition,
          row.disabledAt === null,
        );
        return [
          id,
          row.replacesAuth === null
            ? existing
            : {
                ...existing,
                replaces: { ...row.definition, auth: row.replacesAuth },
              },
        ];
      }),
    ),
    repositories: new Map(
      (await tx.select().from(catalogRepositories)).map((row) =>
        entryOf(
          "repository",
          row.id,
          repositoryEntryOf(row),
          row.removedAt === null,
        ),
      ),
    ),
    mcp_servers: new Map(
      (await tx.select().from(mcpServers)).map((row) =>
        entryOf("mcp", row.id, mcpEntryOf(row), row.disabledAt === null),
      ),
    ),
    stored_values: new Set(values.keys()),
  };
}

async function insertRow(
  tx: Database,
  add: SettingsImportAdd,
  createdBy: string | null,
  origin: "import" | "console" = "import",
): Promise<void> {
  const source = credentialSourceOf(add.entry);
  switch (add.kind) {
    case "connection":
      await tx.insert(providerConnections).values({
        id: add.id,
        definition: add.entry,
        // A provider always names a credential.
        credentialSource: source ?? "external",
        origin,
        createdBy,
      });
      return;
    case "repository": {
      const authKind = repositoryAuthKindOf(add.entry);
      const { owner, name } = repositoryNameOf(add.entry);
      const own = authKind !== "github_app";
      await tx.insert(catalogRepositories).values({
        id: add.id,
        owner,
        name,
        url: add.entry.url,
        branch: add.entry.branch,
        profiles: add.entry.profiles ? [...add.entry.profiles] : null,
        authKind,
        auth: own
          ? (add.entry.auth as Record<string, unknown> | undefined)
          : null,
        credentialSource: own ? source : null,
        // The console App's rows hold no GitHub id until a pick fills it,
        // which the table takes from a seeded row only.
        source: authKind === "github_app" ? "seed" : origin,
        createdBy,
        updatedBy: createdBy,
      });
      return;
    }
    case "mcp":
      await tx.insert(mcpServers).values({
        id: add.id,
        url: add.entry.url,
        credentialRef: add.entry.credential_ref,
        auth: add.entry.auth,
        credentialSource: source ?? "external",
        workspaces: [...add.entry.workspaces],
        origin,
        createdBy,
      });
      return;
  }
}

const OPERATIONS = {
  connection: "import_connection",
  repository: "import_repository",
  mcp: "import_mcp_server",
} as const;

function auditOf(add: SettingsImportAdd): Record<string, unknown> {
  const credential_source = credentialSourceOf(add.entry);
  switch (add.kind) {
    case "connection":
      return {
        connection_id: add.id,
        kind: add.entry.kind,
        endpoint: add.entry.endpoint,
        credential_source,
      };
    case "repository": {
      const entry: CatalogRepositoryConfig = add.entry;
      const { owner, name } = repositoryNameOf(entry);
      return {
        repository_id: add.id,
        repository: `${owner}/${name}`,
        // A row of this document has no GitHub id until a pick fills it.
        github_repository_id: null,
        url: entry.url,
        branch: entry.branch,
        auth_kind: repositoryAuthKindOf(entry),
        credential_source,
        source: "settings_document",
      };
    }
    case "mcp":
      return {
        mcp_server_id: add.id,
        url: add.entry.url,
        credential_ref: add.entry.credential_ref,
        credential_source,
      };
  }
}

export function createPostgresSettingsDocumentStore(
  db: Database,
  /** Null when the secret store is off: no console write seals a value. */
  key: SecretKey | null = null,
): SettingsDocumentStore {
  return {
    ...listRowsIn(db),
    ...consoleWrites(db, key),
    exportEntries() {
      return db.transaction(
        async (tx) => {
          const last4 = await storedLast4(tx, await firstWorkspace(tx));
          const entries: SettingsEntries = {
            connections: {},
            repositories: {},
            mcp_servers: {},
          };
          for (const row of await tx.select().from(providerConnections)) {
            if (row.disabledAt !== null) continue;
            entries.connections[row.id] =
              row.definition as SettingsEntries["connections"][string];
          }
          for (const row of await tx.select().from(catalogRepositories)) {
            if (row.removedAt !== null) continue;
            entries.repositories[row.id] = repositoryEntryOf(
              row,
            ) as CatalogRepositoryConfig;
          }
          for (const row of await tx.select().from(mcpServers)) {
            if (row.disabledAt !== null) continue;
            entries.mcp_servers[row.id] = mcpEntryOf(
              row,
            ) as SettingsEntries["mcp_servers"][string];
          }
          return { entries, last4 };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async sessionsOnRepositories(ids) {
      if (ids.length === 0) return [];
      // The pre-deploy check of docs/operator/api-server.md, keyed by id
      // alone: a repository only the old file knew has no catalog row.
      const result = await db.execute<{
        session_id: string;
        repository_id: string;
        via: "primary" | "attached" | "policy";
      }>(sql`
        SELECT s.id AS session_id, x.repository_id, x.via
        FROM sessions s
        LEFT JOIN agent_releases r ON r.id = s.agent_release_id
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
        WHERE s.status NOT IN ('failed', 'stopped')
          -- A row, even an invalid one, is the claim gate's to judge.
          AND NOT EXISTS (
            SELECT 1 FROM catalog_repositories c
            WHERE c.id = x.repository_id AND c.removed_at IS NULL
          )
          AND x.repository_id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
        ORDER BY s.id, x.repository_id, x.via`);
      return rowsOf<{
        session_id: string;
        repository_id: string;
        via: "primary" | "attached" | "policy";
      }>(result);
    },

    async connectionUse({ profileIds, connectionId }) {
      // No profile to look for makes both counts zero without a query.
      const among = (column: ReturnType<typeof sql.raw>) =>
        profileIds.length === 0
          ? sql`false`
          : sql`${column} IN (${sql.join(
              profileIds.map((id) => sql`${id}`),
              sql`, `,
            )})`;
      const result = await db.execute<{
        agents: string;
        sessions: string;
        judge_named: boolean;
      }>(sql`
        SELECT
          (SELECT count(*) FROM agents a
             JOIN agent_releases r
               ON r.agent_id = a.id AND r.id = a.active_release_id
            WHERE a.status = 'active' AND ${among(sql.raw("r.runtime_profile_id"))}
          ) AS agents,
          -- A bound attempt runs the profile it claimed, so a session moved
          -- onto another profile since is still counted under the old one.
          (SELECT count(*) FROM sessions s
            WHERE s.status NOT IN ('failed', 'stopped')
              AND (${among(sql.raw("s.profile_id"))}
                OR EXISTS (
                  SELECT 1 FROM attempts t
                   WHERE t.session_id = s.id AND t.ended_at IS NULL
                     AND ${among(sql.raw("t.profile_id"))}))
          ) AS sessions,
          EXISTS (
            SELECT 1 FROM workspaces w
             WHERE w.settings -> 'achievement_judge' ->> 'connection_id' = ${connectionId}
          ) AS judge_named`);
      const [row] = rowsOf<{
        agents: string;
        sessions: string;
        judge_named: boolean;
      }>(result);
      return {
        agents: Number(row?.agents ?? 0),
        sessions: Number(row?.sessions ?? 0),
        judgeNamed: row?.judge_named === true,
      };
    },

    importEntries(entries, options) {
      return db.transaction(async (tx) => {
        // The repository writers' order: their advisory lock, then the
        // generation, then rows.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'))`,
        );
        await lockSettingsGeneration(tx);
        const { actor } = options;
        if (actor !== null && !(await liveOwner(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const workspaceId = await firstWorkspace(tx);
        const plan = planSettingsImport(
          entries,
          await existingIn(tx, workspaceId),
          {
            allowExternal: options.allowExternal,
            databaseOwnsRepositories: options.databaseOwnsRepositories === true,
          },
        );
        if (plan.conflicts.length > 0 || plan.refused_external.length > 0) {
          return { ...plan, outcome: "refused" as const, receipt_ids: [] };
        }
        if (options.dryRun) {
          return { ...plan, outcome: "dry_run" as const, receipt_ids: [] };
        }
        const receiptActor: ReceiptActor | null =
          actor === null ? null : receiptActorOf(actor.principal);
        const receipt_ids: string[] = [];
        for (const add of plan.add) {
          await insertRow(tx, add, actor?.userId ?? null);
          const target = actor?.workspaceId ?? workspaceId;
          // Before bootstrap there is no workspace to keep a receipt for.
          if (target === null) continue;
          const id = randomUUID();
          await tx.insert(receipts).values({
            id,
            ownerId: actor?.principal.ownerId ?? target,
            actor: receiptActor,
            operation: OPERATIONS[add.kind],
            targetRef: {
              resource: { kind: "workspace", id: target },
              workspace_id: target,
            },
            result: auditOf(add),
            status: "succeeded",
            requestId: actor?.principal.requestId ?? null,
          });
          receipt_ids.push(id);
        }
        return { ...plan, outcome: "applied" as const, receipt_ids };
      });
    },
  };
}

async function liveOwner(tx: Database, actor: TeamActor): Promise<boolean> {
  return liveIn(tx, actor, ["owner"]);
}

async function liveIn(
  tx: Database,
  actor: TeamActor,
  roles: readonly string[],
): Promise<boolean> {
  const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
  return me?.live === true && roles.includes(me.role);
}

/** Who may write each kind (settings-replace-file-catalog.md §3). */
const WRITERS: Record<SettingsKind, readonly string[]> = {
  connection: ["owner"],
  mcp: ["owner"],
  repository: ["owner", "admin"],
};

async function lockWriters(tx: Database): Promise<void> {
  // The import's order: the repository writers' lock, the generation, rows.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'))`,
  );
  await lockSettingsGeneration(tx);
}

type HeldRow = {
  entry: unknown;
  credentialSource: string | null;
  disabled: boolean;
  /** A connection's earlier `auth`, kept after a move to a stored value. */
  replacesAuth?: Record<string, unknown> | null;
};

/** The row under its lock, as an entry, or null. */
async function heldRow(
  tx: Database,
  kind: SettingsKind,
  id: string,
): Promise<HeldRow | null> {
  switch (kind) {
    case "connection": {
      const [row] = await tx
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, id))
        .for("update");
      return row
        ? {
            entry: row.definition,
            credentialSource: row.credentialSource,
            disabled: row.disabledAt !== null,
            replacesAuth: row.replacesAuth,
          }
        : null;
    }
    case "mcp": {
      const [row] = await tx
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, id))
        .for("update");
      return row
        ? {
            entry: mcpEntryOf(row),
            credentialSource: row.credentialSource,
            disabled: row.disabledAt !== null,
          }
        : null;
    }
    case "repository": {
      const [row] = await tx
        .select()
        .from(catalogRepositories)
        .where(
          and(
            eq(catalogRepositories.id, id),
            ne(catalogRepositories.authKind, "github_app"),
          ),
        )
        .for("update");
      return row
        ? {
            entry: repositoryEntryOf(row),
            credentialSource: row.credentialSource,
            disabled: row.removedAt !== null,
          }
        : null;
    }
  }
}

function ownStoredOf(kind: SettingsKind, id: string, held: HeldRow): boolean {
  const auth = isRecord(held.entry) ? held.entry.auth : undefined;
  return (
    held.credentialSource === "stored" &&
    isRecord(auth) &&
    auth.stored === `${kind}:${id}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function consoleReceipt(
  tx: Database,
  actor: TeamActor,
  operation: ReceiptOperation,
  result: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: actor.principal.ownerId,
    actor: receiptActorOf(actor.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: actor.workspaceId },
      workspace_id: actor.workspaceId,
    },
    result,
    status: "succeeded",
    requestId: actor.principal.requestId ?? null,
  });
  return id;
}

const CREATED: Record<SettingsKind, ReceiptOperation> = {
  connection: "create_connection",
  mcp: "create_mcp_server",
  repository: "add_repository",
};
const DISABLED: Record<SettingsKind, ReceiptOperation> = {
  connection: "disable_connection",
  mcp: "disable_mcp_server",
  repository: "remove_repository",
};
const TARGET: Record<SettingsKind, string> = {
  connection: "connection_id",
  mcp: "mcp_server_id",
  repository: "repository_id",
};

function consoleWrites(
  db: Database,
  key: SecretKey | null,
): Pick<
  SettingsDocumentStore,
  | "create"
  | "setValue"
  | "convertConnection"
  | "setConnectionAutoMode"
  | "disable"
  | "enableConnection"
  | "setMcpWorkspaces"
> {
  const sealIn = async (
    tx: Database,
    owner: { kind: SettingsKind; id: string },
    value: string,
    actor: TeamActor,
  ): Promise<void> => {
    if (key === null) {
      throw new Error("the secret store is off: no value can be stored");
    }
    const workspaceId = await firstWorkspace(tx);
    if (workspaceId === null) {
      throw new Error("no workspace yet to keep a stored value under");
    }
    await writeSecretInTx(
      tx,
      key,
      {
        workspaceId,
        owner: { kind: owner.kind, id: owner.id },
        purpose: PURPOSE,
      },
      value,
      actor.userId,
    );
  };

  /** The locks, then the actor's role for `kind`, then `write`. */
  const asWriter = (
    kind: SettingsKind,
    actor: TeamActor,
    write: (tx: Database) => Promise<SettingsConsoleResult>,
  ): Promise<SettingsConsoleResult> =>
    db.transaction(async (tx) => {
      await lockWriters(tx);
      if (!(await liveIn(tx, actor, WRITERS[kind]))) {
        return { outcome: "actor_inactive" as const };
      }
      return write(tx);
    });

  return {
    create(add, value, actor) {
      return asWriter(add.kind, actor, async (tx) => {
        const plan = planSettingsImport(
          {
            connections:
              add.kind === "connection" ? { [add.id]: add.entry } : {},
            repositories:
              add.kind === "repository" ? { [add.id]: add.entry } : {},
            mcp_servers: add.kind === "mcp" ? { [add.id]: add.entry } : {},
          },
          await existingIn(tx, await firstWorkspace(tx)),
          { allowExternal: false },
        );
        // Anything but one add: the id was ever taken, or a value is
        // already sealed under it; the console never brings a reference.
        if (plan.add.length !== 1 || plan.refused_external.length > 0) {
          return { outcome: "conflict" as const, reason: "already_exists" };
        }
        const stored = credentialSourceOf(add.entry) === "stored";
        if (stored !== (value !== null)) {
          throw new Error(
            "a console entry is stored exactly when it has a value",
          );
        }
        await insertRow(tx, add, actor.userId, "console");
        if (value !== null) await sealIn(tx, add, value, actor);
        const receiptId = await consoleReceipt(tx, actor, CREATED[add.kind], {
          ...auditOf(add),
          source: "console",
        });
        return { outcome: "done" as const, receiptId };
      });
    },

    setValue(owner, value, actor) {
      return asWriter(owner.kind, actor, async (tx) => {
        const held = await heldRow(tx, owner.kind, owner.id);
        if (held === null) return { outcome: "not_found" as const };
        if (held.disabled) {
          return { outcome: "conflict" as const, reason: "disabled" };
        }
        if (!ownStoredOf(owner.kind, owner.id, held)) {
          return { outcome: "conflict" as const, reason: "not_stored" };
        }
        await sealIn(tx, owner, value, actor);
        const receiptId = await consoleReceipt(
          tx,
          actor,
          "set_settings_credential",
          {
            [TARGET[owner.kind]]: owner.id,
            last4: value.slice(-4),
          },
        );
        return { outcome: "done" as const, receiptId };
      });
    },

    convertConnection(id, value, actor) {
      return asWriter("connection", actor, async (tx) => {
        const held = await heldRow(tx, "connection", id);
        if (held === null) return { outcome: "not_found" as const };
        if (held.disabled) {
          return { outcome: "conflict" as const, reason: "disabled" };
        }
        const entry = isRecord(held.entry) ? held.entry : {};
        const auth = isRecord(entry.auth) ? entry.auth : {};
        if (
          held.credentialSource !== "external" ||
          (auth.value_env === undefined && auth.secret_id === undefined)
        ) {
          return { outcome: "conflict" as const, reason: "not_external" };
        }
        // The old definition must stay this row's alone: every other row,
        // by what it is now and by what it was.
        const was = canonicalJson(entry);
        for (const other of await tx
          .select()
          .from(providerConnections)
          .where(ne(providerConnections.id, id))) {
          const names = [
            other.definition,
            ...(other.replacesAuth === null
              ? []
              : [{ ...other.definition, auth: other.replacesAuth }]),
          ];
          if (names.some((name) => canonicalJson(name) === was)) {
            return { outcome: "conflict" as const, reason: "alias_taken" };
          }
        }
        const { value_env: _env, secret_id: _secret, ...kept } = auth;
        await tx
          .update(providerConnections)
          .set({
            definition: {
              ...entry,
              auth: { ...kept, stored: `connection:${id}` },
            },
            credentialSource: "stored",
            replacesAuth: auth,
          })
          .where(eq(providerConnections.id, id));
        await sealIn(tx, { kind: "connection", id }, value, actor);
        const receiptId = await consoleReceipt(
          tx,
          actor,
          "set_settings_credential",
          {
            connection_id: id,
            last4: value.slice(-4),
            replaced: auth.value_env === undefined ? "secret_id" : "value_env",
          },
        );
        return { outcome: "done" as const, receiptId };
      });
    },

    setConnectionAutoMode(id, autoMode, actor) {
      return asWriter("connection", actor, async (tx) => {
        const held = await heldRow(tx, "connection", id);
        if (held === null) return { outcome: "not_found" as const };
        if (held.disabled) {
          return { outcome: "conflict" as const, reason: "disabled" };
        }
        // This column only: the definition is hashed into every profile
        // fingerprint and release pin made over the connection.
        await tx
          .update(providerConnections)
          .set({ autoMode })
          .where(eq(providerConnections.id, id));
        const receiptId = await consoleReceipt(
          tx,
          actor,
          "set_connection_auto_mode",
          { connection_id: id, auto_mode: autoMode },
        );
        return { outcome: "done" as const, receiptId };
      });
    },

    disable(owner, actor) {
      return asWriter(owner.kind, actor, async (tx) => {
        const held = await heldRow(tx, owner.kind, owner.id);
        if (held === null) return { outcome: "not_found" as const };
        if (held.disabled) {
          return { outcome: "conflict" as const, reason: "disabled" };
        }
        const at = sql`now()`;
        switch (owner.kind) {
          case "connection":
            await tx
              .update(providerConnections)
              .set({ disabledAt: at, disabledBy: actor.userId })
              .where(eq(providerConnections.id, owner.id));
            break;
          case "mcp":
            await tx
              .update(mcpServers)
              .set({ disabledAt: at, disabledBy: actor.userId })
              .where(eq(mcpServers.id, owner.id));
            break;
          case "repository":
            await tx
              .update(catalogRepositories)
              .set({
                removedAt: at,
                removedBy: actor.userId,
                updatedBy: actor.userId,
                updatedAt: at,
              })
              .where(eq(catalogRepositories.id, owner.id));
            break;
        }
        const receiptId = await consoleReceipt(
          tx,
          actor,
          DISABLED[owner.kind],
          {
            [TARGET[owner.kind]]: owner.id,
            source: "console",
          },
        );
        return { outcome: "done" as const, receiptId };
      });
    },

    enableConnection(id, actor) {
      return asWriter("connection", actor, async (tx) => {
        const held = await heldRow(tx, "connection", id);
        if (held === null) return { outcome: "not_found" as const };
        if (!held.disabled) {
          return { outcome: "conflict" as const, reason: "not_disabled" };
        }
        // A profile finds its connection by what it is, so two live rows
        // holding one definition (or one's old reference) would make the
        // match depend on which of them is usable at the moment.
        const namesOf = (
          definition: unknown,
          replacesAuth: Record<string, unknown> | null | undefined,
        ): string[] => [
          canonicalJson(definition),
          ...(replacesAuth == null || !isRecord(definition)
            ? []
            : [canonicalJson({ ...definition, auth: replacesAuth })]),
        ];
        const mine = new Set(namesOf(held.entry, held.replacesAuth));
        for (const other of await tx
          .select()
          .from(providerConnections)
          .where(
            and(
              ne(providerConnections.id, id),
              isNull(providerConnections.disabledAt),
            ),
          )) {
          if (
            namesOf(other.definition, other.replacesAuth).some((name) =>
              mine.has(name),
            )
          ) {
            return {
              outcome: "conflict" as const,
              reason: "definition_active",
            };
          }
        }
        // A deployment's reference cannot be checked here; it shows as
        // `unresolved` if it does not resolve. A stored value must exist.
        if (held.credentialSource === "stored") {
          const values = await storedLast4(tx, await firstWorkspace(tx));
          if (!values.has(`connection:${id}`)) {
            return { outcome: "conflict" as const, reason: "needs_value" };
          }
        }
        await tx
          .update(providerConnections)
          .set({ disabledAt: null, disabledBy: null })
          .where(eq(providerConnections.id, id));
        const receiptId = await consoleReceipt(tx, actor, "enable_connection", {
          connection_id: id,
          source: "console",
        });
        return { outcome: "done" as const, receiptId };
      });
    },

    setMcpWorkspaces(id, workspaces, actor) {
      return asWriter("mcp", actor, async (tx) => {
        const held = await heldRow(tx, "mcp", id);
        if (held === null) return { outcome: "not_found" as const };
        if (held.disabled) {
          return { outcome: "conflict" as const, reason: "disabled" };
        }
        // §2: an operator's reference is shown and disabled, nothing more.
        if (!ownStoredOf("mcp", id, held)) {
          return { outcome: "conflict" as const, reason: "not_stored" };
        }
        const before = isRecord(held.entry) ? held.entry.workspaces : null;
        await tx
          .update(mcpServers)
          .set({ workspaces: [...workspaces] })
          .where(eq(mcpServers.id, id));
        const receiptId = await consoleReceipt(
          tx,
          actor,
          "set_mcp_server_workspaces",
          { mcp_server_id: id, before, workspaces: [...workspaces] },
        );
        return { outcome: "done" as const, receiptId };
      });
    },
  };
}

function listRowsIn(db: Database): Pick<SettingsDocumentStore, "listRows"> {
  return {
    listRows(kind) {
      return db.transaction(
        async (tx) => {
          const last4 = await storedLast4(tx, await firstWorkspace(tx));
          const value = (id: string) => last4.get(`${kind}:${id}`) ?? null;
          switch (kind) {
            case "connection":
              return (
                await tx
                  .select()
                  .from(providerConnections)
                  .orderBy(asc(providerConnections.id))
              ).map((row) => ({
                id: row.id,
                entry: row.definition,
                origin: row.origin,
                last4: value(row.id),
                createdAt: row.createdAt,
                disabledAt: row.disabledAt,
                autoMode: row.autoMode,
              }));
            case "mcp":
              return (
                await tx.select().from(mcpServers).orderBy(asc(mcpServers.id))
              ).map((row) => ({
                id: row.id,
                entry: mcpEntryOf(row),
                origin: row.origin,
                last4: value(row.id),
                createdAt: row.createdAt,
                disabledAt: row.disabledAt,
              }));
            case "repository":
              return (
                await tx
                  .select()
                  .from(catalogRepositories)
                  .where(ne(catalogRepositories.authKind, "github_app"))
                  .orderBy(asc(catalogRepositories.id))
              ).map((row) => ({
                id: row.id,
                entry: repositoryEntryOf(row),
                origin:
                  row.source === "console"
                    ? ("console" as const)
                    : ("import" as const),
                last4: value(row.id),
                createdAt: row.createdAt,
                disabledAt: row.removedAt,
              }));
          }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },
  };
}
