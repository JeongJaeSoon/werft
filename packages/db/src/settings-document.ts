import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  ENDED_SESSION_STATUSES,
  type ReceiptActor,
  type ReceiptOperation,
  workspaceSettingsSchema,
} from "@werft-ai/contracts";
import {
  type CatalogRepositoryConfig,
  credentialSourceOf,
  type ExistingSettings,
  type ExistingSettingsEntry,
  MANAGEMENT_ROLES,
  modelFamiliesSchema,
  planSettingsImport,
  receiptActorOf,
  repositoryAuthKindOf,
  repositoryNameOf,
  type SecretKey,
  type SettingsConsoleResult,
  type SettingsDocumentStore,
  type SettingsEntries,
  type SettingsImportAdd,
  type SettingsImportPlan,
  type SettingsImportResult,
  type SettingsKind,
  type SettingsSeedDecision,
  type SettingsSeedResult,
  type TeamActor,
} from "@werft-ai/platform";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { lockPeople } from "./control-shared.ts";
import { lockCatalogWrites } from "./github/catalog-repositories.ts";
import { rebindCarriedPushes } from "./installation-settings.ts";
import type { Database } from "./queries.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  receipts,
  secretValues,
  settingsGeneration,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secrets/secret-values.ts";
import { sqlLiterals } from "./sql-literals.ts";
import { rowsOf } from "./statement-rows.ts";
import { writeSucceededReceipt } from "./succeeded-receipt.ts";

const PURPOSE = "settings_credential";

type RepositoryRow = typeof catalogRepositories.$inferSelect;

/** The row as its settings entry: what the file would have spelled. */
function repositoryEntryOf(row: RepositoryRow): unknown {
  const auth =
    row.authKind === "github_app" ? { kind: "github_app" } : row.auth;
  return {
    url: row.url,
    branch: row.branch,
    ...(auth === null ? {} : { auth }),
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
        return [id, existing];
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
        credentialSource: "stored",
        origin,
        createdBy,
        ...(add.models === undefined
          ? {}
          : {
              models: [...add.models.models],
              modelFamilies: add.models.model_families ?? null,
            }),
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
  }
}

const OPERATIONS = {
  connection: "import_connection",
  repository: "import_repository",
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
            connection_models: {},
            repositories: {},
          };
          for (const row of await tx.select().from(providerConnections)) {
            if (row.disabledAt !== null) continue;
            entries.connections[row.id] =
              row.definition as SettingsEntries["connections"][string];
            const families = modelFamiliesSchema.safeParse(row.modelFamilies);
            if (row.models.length > 0 || families.success) {
              entries.connection_models ??= {};
              entries.connection_models[row.id] = {
                models: [...row.models],
                ...(families.success ? { model_families: families.data } : {}),
              };
            }
          }
          for (const row of await tx.select().from(catalogRepositories)) {
            if (row.removedAt !== null) continue;
            entries.repositories[row.id] = repositoryEntryOf(
              row,
            ) as CatalogRepositoryConfig;
          }
          return { entries, last4 };
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      );
    },

    async connectionUse({ connectionId }) {
      const result = await db.execute<{
        agents: string;
        sessions: string;
        judge_named: boolean;
      }>(sql`
        SELECT
          (SELECT count(*) FROM agents a
             JOIN agent_releases r
               ON r.agent_id = a.id AND r.id = a.active_release_id
            WHERE a.status = 'active' AND r.connection_id = ${connectionId}
          ) AS agents,
          (SELECT count(*) FROM sessions s
            WHERE s.status NOT IN (${sqlLiterals(ENDED_SESSION_STATUSES)})
              AND s.runtime_spec -> 'connection' ->> 'id' = ${connectionId}
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
        await lockCatalogWrites(tx);
        return importIn(tx, entries, options);
      });
    },

    decideSeed() {
      return db.transaction(async (tx) => {
        await lockCatalogWrites(tx);
        return decideSeedIn(tx);
      });
    },

    async seedEntries(steps) {
      try {
        return await db.transaction(async (tx): Promise<SettingsSeedResult> => {
          await lockCatalogWrites(tx);
          const decision = await decideSeedIn(tx);
          if (decision.outcome !== "empty") return decision;
          const plans: SettingsImportPlan[] = [];
          const receipt_ids: string[] = [];
          for (const [index, step] of steps.entries()) {
            const result = await importIn(tx, step.entries, {
              dryRun: false,
              actor: null,
            });
            if (result.outcome === "actor_inactive") {
              throw new Error("the seed has no actor to lose");
            }
            const { outcome, receipt_ids: ids, ...plan } = result;
            if (outcome === "refused") {
              throw new SeedRefused({ ...plan, outcome, step: index });
            }
            plans.push(plan);
            receipt_ids.push(...ids);
          }
          await tx
            .update(settingsGeneration)
            .set({ seedDecidedAt: sql`now()` });
          return { outcome: "applied", steps: plans, receipt_ids };
        });
      } catch (error) {
        if (error instanceof SeedRefused) return error.result;
        throw error;
      }
    },
  };
}

/** Thrown to roll the seed's earlier steps back with the refused one. */
class SeedRefused extends Error {
  constructor(
    readonly result: Extract<SettingsSeedResult, { outcome: "refused" }>,
  ) {
    super("settings seed refused");
  }
}

/** Under `lockCatalogWrites`, which holds the generation row. */
async function decideSeedIn(tx: Database): Promise<SettingsSeedDecision> {
  const [generation] = await tx
    .select({ decidedAt: settingsGeneration.seedDecidedAt })
    .from(settingsGeneration);
  if (generation?.decidedAt) {
    return { outcome: "decided", decided_at: generation.decidedAt };
  }
  // A connection or MCP server row, disabled ones too. Repositories alone do
  // not count: the document's connections still seed an installation that
  // holds only repository rows.
  const [row] = rowsOf<{ held: boolean }>(
    await tx.execute(
      sql`SELECT EXISTS (SELECT 1 FROM ${providerConnections})
          OR EXISTS (SELECT 1 FROM ${mcpServers}) AS held`,
    ),
  );
  if (row?.held !== true) return { outcome: "empty" };
  await tx.update(settingsGeneration).set({ seedDecidedAt: sql`now()` });
  return { outcome: "not_empty" };
}

/** The import under `lockCatalogWrites`, taken by the caller. */
async function importIn(
  tx: Database,
  entries: SettingsEntries,
  options: {
    dryRun: boolean;
    actor: TeamActor | null;
  },
): Promise<SettingsImportResult> {
  const { actor } = options;
  if (actor !== null && !(await liveOwner(tx, actor))) {
    return { outcome: "actor_inactive" as const };
  }
  const workspaceId = await firstWorkspace(tx);
  const plan = planSettingsImport(entries, await existingIn(tx, workspaceId));
  if (plan.conflicts.length > 0) {
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

/** Who may write each kind. */
const WRITERS: Record<SettingsKind, readonly string[]> = {
  connection: ["owner"],
  repository: MANAGEMENT_ROLES["workspace.manage"] ?? [],
};

type HeldRow = {
  entry: unknown;
  credentialSource: string | null;
  disabled: boolean;
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
  return writeSucceededReceipt(tx, actor.principal, {
    operation,
    resource: { kind: "workspace", id: actor.workspaceId },
    workspaceId: actor.workspaceId,
    result,
  });
}

/**
 * The actor's workspace judge takes a new decision model while it names
 * none, so setting one up is enough to judge. One write that checks and
 * sets: a judge a person saved meanwhile is read again once that save
 * commits (the row lock), and is never overwritten. Lock order after the
 * catalog lock and the people: the workspace row, as a judge save takes it.
 */
async function judgeWithFirstDecisionModel(
  tx: Database,
  actor: TeamActor,
  connectionId: string,
): Promise<void> {
  const result = await tx.execute(sql`
    UPDATE workspaces
       SET settings = jsonb_set(settings, '{achievement_judge}',
             coalesce(nullif(settings -> 'achievement_judge', 'null'::jsonb), '{}'::jsonb)
               || jsonb_build_object('connection_id', ${connectionId}::text))
     WHERE id = ${actor.workspaceId}
       AND settings -> 'achievement_judge' ->> 'connection_id' IS NULL
    RETURNING settings -> 'achievement_judge' AS judge`);
  const [row] = rowsOf<{ judge: unknown }>(result);
  if (row === undefined) return;
  await consoleReceipt(tx, actor, "set_achievement_judge", {
    achievement_judge: workspaceSettingsSchema.shape.achievement_judge.parse(
      row.judge,
    ),
    source: "console",
  });
}

const CREATED: Record<SettingsKind, ReceiptOperation> = {
  connection: "create_connection",
  repository: "add_repository",
};
const DISABLED: Record<SettingsKind, ReceiptOperation> = {
  connection: "disable_connection",
  repository: "remove_repository",
};
const TARGET: Record<SettingsKind, string> = {
  connection: "connection_id",
  repository: "repository_id",
};

function consoleWrites(
  db: Database,
  key: SecretKey | null,
): Pick<
  SettingsDocumentStore,
  "create" | "setValue" | "setConnectionModels" | "disable" | "enableConnection"
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
    if (owner.kind === "repository") {
      await rebindCarriedPushes(tx, owner.id);
    }
  };

  /** The locks, then the actor's role for `kind`, then `write`. */
  const asWriter = (
    kind: SettingsKind,
    actor: TeamActor,
    write: (tx: Database) => Promise<SettingsConsoleResult>,
  ): Promise<SettingsConsoleResult> =>
    db.transaction(async (tx) => {
      // The import's order: the repository writers' lock, the generation, rows.
      await lockCatalogWrites(tx);
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
          },
          await existingIn(tx, await firstWorkspace(tx)),
        );
        // Anything but one add: the id was ever taken, or a value is
        // already sealed under it.
        if (plan.add.length !== 1) {
          return { outcome: "conflict" as const, reason: "already_exists" };
        }
        if (credentialSourceOf(add.entry) !== "stored") {
          throw new Error("a console entry stores its own value");
        }
        await insertRow(tx, add, actor.userId, "console");
        await sealIn(tx, add, value, actor);
        const receiptId = await consoleReceipt(tx, actor, CREATED[add.kind], {
          ...auditOf(add),
          source: "console",
        });
        if (
          add.kind === "connection" &&
          add.entry.kind === "openai_decisions"
        ) {
          await judgeWithFirstDecisionModel(tx, actor, add.id);
        }
        return { outcome: "done" as const, receiptId };
      });
    },

    setValue(owner, value, actor) {
      return asWriter(owner.kind, actor, async (tx) => {
        const held = await heldRow(tx, owner.kind, owner.id);
        if (held === null) return { outcome: "not_found" as const };
        // A disabled connection without a value (one moved off env or
        // Secrets Manager while off) takes its first, or it could never be
        // enabled again.
        if (
          held.disabled &&
          (owner.kind !== "connection" ||
            (await storedLast4(tx, await firstWorkspace(tx))).has(
              `connection:${owner.id}`,
            ))
        ) {
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

    setConnectionModels(id, models, actor) {
      return asWriter("connection", actor, async (tx) => {
        const held = await heldRow(tx, "connection", id);
        if (held === null) return { outcome: "not_found" as const };
        if (held.disabled) {
          return { outcome: "conflict" as const, reason: "disabled" };
        }
        await tx
          .update(providerConnections)
          .set({
            models: [...models.models],
            ...(models.model_families === undefined
              ? {}
              : { modelFamilies: models.model_families }),
          })
          .where(eq(providerConnections.id, id));
        const receiptId = await consoleReceipt(
          tx,
          actor,
          "set_connection_models",
          { connection_id: id, models: [...models.models] },
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
        // A re-import finds its connection by what it is, so two live rows
        // holding one definition would make the match depend on which of
        // them is usable at the moment.
        const mine = canonicalJson(held.entry);
        for (const other of await tx
          .select()
          .from(providerConnections)
          .where(
            and(
              ne(providerConnections.id, id),
              isNull(providerConnections.disabledAt),
            ),
          )) {
          if (canonicalJson(other.definition) === mine) {
            return {
              outcome: "conflict" as const,
              reason: "definition_active",
            };
          }
        }
        const values = await storedLast4(tx, await firstWorkspace(tx));
        if (!values.has(`connection:${id}`)) {
          return { outcome: "conflict" as const, reason: "needs_value" };
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
                models: row.models,
                modelFamilies: (() => {
                  const parsed = modelFamiliesSchema.safeParse(
                    row.modelFamilies,
                  );
                  return parsed.success ? parsed.data : null;
                })(),
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
