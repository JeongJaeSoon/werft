import { randomUUID } from "node:crypto";
import {
  ENV_AGENT_VARIABLE_LIMIT,
  ENV_SESSION_VALUES_MAX_BYTES,
  ENV_WORKSPACE_VARIABLE_LIMIT,
  type EnvRefusal,
  type EnvStart,
  envNameProblem,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type {
  EnvVariableRecord,
  EnvVariableScope,
  EnvVariableStore,
  Principal,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  ne,
  type SQL,
  sql,
} from "drizzle-orm";
import { dbNow } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  agents,
  envVariableGrants,
  envVariables,
  receipts,
  sessions,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

const NEXT_VERSION = sql<number>`nextval('env_variable_versions_seq')`;

function scopeWhere(scope: EnvVariableScope): SQL {
  return sql`${eq(envVariables.workspaceId, scope.workspaceId)} AND ${
    scope.agentId === null
      ? isNull(envVariables.agentId)
      : eq(envVariables.agentId, scope.agentId)
  }`;
}

/**
 * Held until the transaction ends. The count limit is read after it, so two
 * writes that each see room cannot both take the last place; the same lock
 * serializes the writes of one scope, which is what a delete's affected counts
 * need to stay true.
 */
async function lockEnvVariableScope(
  tx: Database,
  scope: EnvVariableScope,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`env_variables:${scope.workspaceId}:${scope.agentId ?? "workspace"}`}, 0))`,
  );
}

function receiptTarget(scope: EnvVariableScope) {
  return {
    resource:
      scope.agentId === null
        ? { kind: "workspace" as const, id: scope.workspaceId }
        : { kind: "agent" as const, id: scope.agentId },
    workspace_id: scope.workspaceId,
  };
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  input: {
    operation:
      | "set_env_variable"
      | "delete_env_variable"
      | "set_env_variable_grants";
    scope: EnvVariableScope;
    result: Record<string, unknown>;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation: input.operation,
    targetRef: receiptTarget(input.scope),
    status: "succeeded",
    result: input.result,
  });
  return id;
}

type VariableRow = typeof envVariables.$inferSelect;

function recordOf(
  row: VariableRow,
  grants: { agentId: string; allowAutomation: boolean }[],
): EnvVariableRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as "plain" | "secret",
    value: row.value,
    version: row.version,
    grantAll: row.grantAll,
    grantVersion: row.grantVersion,
    grantedAgents: grants.map((g) => ({
      id: g.agentId,
      allowAutomation: g.allowAutomation,
    })),
    engineDelivery: row.engineDelivery,
    allowAutomation: row.allowAutomation,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

async function agentExists(
  tx: Database,
  workspaceId: string,
  agentId: string,
): Promise<boolean> {
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1)
    .for("key share");
  return agent !== undefined;
}

/**
 * Sessions not closed yet that took `name` from this scope when they were
 * accepted. Their copy outlives the variable, so a delete tells the caller
 * how many there are.
 */
async function openSessionsHolding(
  tx: Database,
  scope: EnvVariableScope,
  name: string,
): Promise<number> {
  const entryScope = scope.agentId === null ? "workspace" : "agent";
  const [row] = await tx
    .select({ n: count() })
    .from(sessions)
    .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .where(
      and(
        // `owner_id` is the workspace, as the accept's credential check reads it.
        eq(sessions.ownerId, scope.workspaceId),
        ne(sessions.admissionState, "closed"),
        scope.agentId === null
          ? undefined
          : eq(agentReleases.agentId, scope.agentId),
        sql`jsonb_path_exists(${sessions.envStart}, '$.entries[*] ? (@.name == $n && @.scope == $s)', ${JSON.stringify({ n: name, s: entryScope })}::jsonb)`,
      ),
    );
  return row?.n ?? 0;
}

// Every SELECT of a read sees the same committed state.
const SNAPSHOT = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

async function readScope(
  tx: Database,
  scope: EnvVariableScope,
): Promise<EnvVariableRecord[]> {
  const rows = await tx
    .select()
    .from(envVariables)
    .where(scopeWhere(scope))
    .orderBy(asc(envVariables.name));
  if (scope.agentId !== null || rows.length === 0) {
    return rows.map((row) => recordOf(row, []));
  }
  const grants = await tx
    .select({
      variableId: envVariableGrants.variableId,
      agentId: envVariableGrants.agentId,
      allowAutomation: envVariableGrants.allowAutomation,
    })
    .from(envVariableGrants)
    .where(
      inArray(
        envVariableGrants.variableId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(envVariableGrants.agentId));
  return rows.map((row) =>
    recordOf(
      row,
      grants.filter((grant) => grant.variableId === row.id),
    ),
  );
}

export function createPostgresEnvVariableStore(db: Database): EnvVariableStore {
  return {
    hasAgent: (workspaceId, agentId) => agentExists(db, workspaceId, agentId),

    list: (scope) => db.transaction((tx) => readScope(tx, scope), SNAPSHOT),

    readAgentView: (workspaceId, agentId) =>
      db.transaction(
        async (tx) => ({
          own: await readScope(tx, { workspaceId, agentId }),
          workspace: await readScope(tx, { workspaceId, agentId: null }),
        }),
        SNAPSHOT,
      ),

    put(input) {
      const { scope, name, principal } = input;
      return db.transaction(async (tx) => {
        if (
          scope.agentId !== null &&
          !(await agentExists(tx, scope.workspaceId, scope.agentId))
        ) {
          return { outcome: "agent_not_found" as const };
        }
        await lockEnvVariableScope(tx, scope);
        const [existing] = await tx
          .select()
          .from(envVariables)
          .where(and(scopeWhere(scope), eq(envVariables.name, name)))
          .limit(1)
          .for("update");
        const { precondition } = input;
        if ("create" in precondition) {
          if (existing) {
            return {
              outcome: "version_mismatch" as const,
              current: existing.version,
            };
          }
        } else if (!existing || existing.version !== precondition.ifMatch) {
          return {
            outcome: "version_mismatch" as const,
            current: existing?.version ?? null,
          };
        }
        const updatedBy = principal.actor?.userId ?? null;
        let saved: VariableRow;
        if (existing) {
          if (existing.kind !== "plain") {
            throw new Error("a secret is not written through the plain path");
          }
          const [row] = await tx
            .update(envVariables)
            .set({
              value: input.value,
              version: NEXT_VERSION,
              updatedBy,
              updatedAt: sql`now()`,
            })
            .where(eq(envVariables.id, existing.id))
            .returning();
          if (!row) throw new Error("Failed to update variable");
          saved = row;
        } else {
          const limit =
            scope.agentId === null
              ? ENV_WORKSPACE_VARIABLE_LIMIT
              : ENV_AGENT_VARIABLE_LIMIT;
          const [held] = await tx
            .select({ n: count() })
            .from(envVariables)
            .where(scopeWhere(scope));
          if ((held?.n ?? 0) >= limit) {
            return { outcome: "quota_exceeded" as const };
          }
          const [row] = await tx
            .insert(envVariables)
            .values({
              id: randomUUID(),
              workspaceId: scope.workspaceId,
              agentId: scope.agentId,
              name,
              kind: "plain",
              value: input.value,
              updatedBy,
            })
            .returning();
          if (!row) throw new Error("Failed to insert variable");
          saved = row;
        }
        const receiptId = await writeReceipt(tx, principal, {
          operation: "set_env_variable",
          scope,
          result: {
            name,
            kind: "plain",
            version: saved.version,
            created: existing === undefined,
          },
        });
        return {
          outcome: "saved" as const,
          version: saved.version,
          grantVersion: saved.grantVersion,
          created: existing === undefined,
          receiptId,
        };
      });
    },

    delete(input) {
      const { scope, name, principal } = input;
      return db.transaction(async (tx) => {
        await lockEnvVariableScope(tx, scope);
        const [existing] = await tx
          .select()
          .from(envVariables)
          .where(and(scopeWhere(scope), eq(envVariables.name, name)))
          .limit(1)
          .for("update");
        if (!existing) return { outcome: "not_found" as const };
        if (existing.version !== input.ifMatch) {
          return {
            outcome: "version_mismatch" as const,
            current: existing.version,
          };
        }
        let affectedAgents = 1;
        if (scope.agentId === null) {
          if (existing.grantAll) {
            const [all] = await tx
              .select({ n: count() })
              .from(agents)
              .where(
                and(
                  eq(agents.workspaceId, scope.workspaceId),
                  eq(agents.status, "active"),
                ),
              );
            affectedAgents = all?.n ?? 0;
          } else {
            const [granted] = await tx
              .select({ n: count() })
              .from(envVariableGrants)
              .where(eq(envVariableGrants.variableId, existing.id));
            affectedAgents = granted?.n ?? 0;
          }
        }
        const openSessions = await openSessionsHolding(tx, scope, name);
        await tx.delete(envVariables).where(eq(envVariables.id, existing.id));
        const receiptId = await writeReceipt(tx, principal, {
          operation: "delete_env_variable",
          scope,
          result: {
            name,
            kind: existing.kind,
            version: existing.version,
            affected_agents: affectedAgents,
            open_sessions: openSessions,
          },
        });
        return {
          outcome: "deleted" as const,
          affectedAgents,
          openSessions,
          receiptId,
        };
      });
    },

    setGrants(input) {
      const { workspaceId, name, principal } = input;
      const scope: EnvVariableScope = { workspaceId, agentId: null };
      return db.transaction(async (tx) => {
        await lockEnvVariableScope(tx, scope);
        const [existing] = await tx
          .select()
          .from(envVariables)
          .where(and(scopeWhere(scope), eq(envVariables.name, name)))
          .limit(1)
          .for("update");
        if (!existing) return { outcome: "not_found" as const };
        if (existing.grantVersion !== input.ifMatch) {
          return {
            outcome: "version_mismatch" as const,
            current: existing.grantVersion,
          };
        }
        if (existing.kind !== "plain" && input.grantAll) {
          throw new Error("a secret is never granted to every agent");
        }
        const ids = input.agents.map((agent) => agent.id);
        if (ids.length > 0) {
          const found = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(eq(agents.workspaceId, workspaceId), inArray(agents.id, ids)),
            )
            .for("key share");
          if (found.length !== new Set(ids).size) {
            return { outcome: "agent_not_found" as const };
          }
        }
        const before = await tx
          .select({ agentId: envVariableGrants.agentId })
          .from(envVariableGrants)
          .where(eq(envVariableGrants.variableId, existing.id))
          .orderBy(asc(envVariableGrants.agentId));
        await tx
          .delete(envVariableGrants)
          .where(eq(envVariableGrants.variableId, existing.id));
        const grantedBy = principal.actor?.userId ?? null;
        if (input.agents.length > 0) {
          await tx.insert(envVariableGrants).values(
            input.agents.map((agent) => ({
              workspaceId,
              variableId: existing.id,
              agentId: agent.id,
              // Only a secret's grant carries the switch.
              allowAutomation:
                existing.kind === "secret" && agent.allowAutomation,
              grantedBy,
            })),
          );
        }
        const [row] = await tx
          .update(envVariables)
          .set({
            grantAll: input.grantAll,
            grantVersion: NEXT_VERSION,
            updatedBy: grantedBy,
            updatedAt: sql`now()`,
          })
          .where(eq(envVariables.id, existing.id))
          .returning({ grantVersion: envVariables.grantVersion });
        if (!row) throw new Error("Failed to update grants");
        const receiptId = await writeReceipt(tx, principal, {
          operation: "set_env_variable_grants",
          scope,
          result: {
            name,
            grant_version: row.grantVersion,
            before: {
              grant_all: existing.grantAll,
              agents: before.map((b) => b.agentId),
            },
            after: { grant_all: input.grantAll, agents: [...ids].sort() },
          },
        });
        return {
          outcome: "saved" as const,
          grantVersion: row.grantVersion,
          receiptId,
        };
      });
    },
  };
}

// ---- A session's start snapshot -------------------------------------------

export type EnvStartCapture =
  | { outcome: "none" }
  | { outcome: "resolved"; envStart: EnvStart & { captured_at: string } }
  | { outcome: "refused"; reason: EnvRefusal };

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * How long a session that has not closed keeps the values it copied at accept.
 * A paused or stopped session that outlives it can still be resumed, but its
 * next claim is refused: the values are gone and the variables may have
 * changed, so it must be started again rather than run without them.
 */
export const ENV_START_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type StoredEntry = { name: string; kind: string; value: string | undefined };

// Reads the shape only, and strictly: every field the accept writes must be
// there, a secret must hold no value, and a plain entry must hold one. Fields
// a later build adds are let through. `envStartSchema` is not used because it
// refuses a reserved name while parsing, and the claim must tell that apart
// from a snapshot it cannot read.
function storedEntries(envStart: unknown): StoredEntry[] | null {
  if (typeof envStart !== "object" || envStart === null) return null;
  const { entries, skipped, captured_at } = envStart as Record<string, unknown>;
  if (
    !Array.isArray(entries) ||
    !Array.isArray(skipped) ||
    !skipped.every((name) => typeof name === "string") ||
    typeof captured_at !== "string" ||
    Number.isNaN(Date.parse(captured_at))
  ) {
    return null;
  }
  const read: StoredEntry[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    const { name, scope, kind, version, value } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof name !== "string" ||
      (scope !== "workspace" && scope !== "agent") ||
      (kind !== "plain" && kind !== "secret") ||
      !Number.isInteger(version) ||
      (version as number) < 1 ||
      (kind === "plain" ? typeof value !== "string" : value !== undefined)
    ) {
      return null;
    }
    read.push({ name, kind, value: value as string | undefined });
  }
  return read;
}

/**
 * The plain values a session's snapshot hands the engine, by name; undefined
 * when there are none. A secret entry holds no value and is not read here.
 * Call it after `envStartRefusal` said null: an unreadable snapshot gives none.
 */
export function plainEnvOf(
  envStart: unknown,
): Record<string, string> | undefined {
  const entries = storedEntries(envStart);
  if (entries === null) return undefined;
  const env: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.kind === "plain" && entry.value !== undefined) {
      env[entry.name] = entry.value;
    }
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/**
 * The refusal a snapshot's own contents earn, whoever wrote it, or null.
 * `now` is the database's clock: retention is judged where it was stamped.
 */
export function envStartRefusal(
  envStart: unknown,
  now: Date,
): EnvRefusal | null {
  if (envStart === null || envStart === undefined) return null;
  const entries = storedEntries(envStart);
  // Fail closed: a snapshot this build cannot read is not run blind.
  if (entries === null) return "unresolved";
  const capturedAt = Date.parse(
    (envStart as { captured_at: string }).captured_at,
  );
  if (now.getTime() - capturedAt > ENV_START_RETENTION_MS) return "unresolved";
  let bytes = 0;
  for (const entry of entries) {
    // Judged again at every claim, so a name added to the reserved list later
    // also stops a value registered before it.
    if (envNameProblem(entry.name) !== null) return "reserved_name";
    if (entry.kind === "plain") {
      if (entry.value === undefined) return "unresolved";
      bytes += utf8Bytes(entry.value);
    }
  }
  return bytes > ENV_SESSION_VALUES_MAX_BYTES ? "too_large" : null;
}

/**
 * Resolves the names a release's card declares into the snapshot a new session
 * keeps, inside the transaction that creates it. The rows it reads are locked
 * FOR SHARE, so a write waits for the session to exist instead of landing
 * between this read and the insert. Per name the agent's own value wins; a
 * workspace value counts only for an agent it is granted to. With no names it
 * reads nothing, so a session without variables is accepted as before.
 */
export async function captureEnvStart(
  tx: Database,
  input: { workspaceId: string; releaseId: string; names: readonly string[] },
): Promise<EnvStartCapture> {
  const names = [...new Set(input.names)].sort();
  if (names.length === 0) return { outcome: "none" };
  if (names.some((name) => envNameProblem(name) !== null)) {
    return { outcome: "refused", reason: "reserved_name" };
  }
  const [release] = await tx
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, input.releaseId))
    .limit(1);
  if (!release) throw new Error("A session names no stored release");
  const rows = await tx
    .select()
    .from(envVariables)
    .where(
      and(
        eq(envVariables.workspaceId, input.workspaceId),
        inArray(envVariables.name, names),
        sql`(${envVariables.agentId} IS NULL OR ${envVariables.agentId} = ${release.agentId})`,
      ),
    )
    .for("share");
  const workspaceRows = rows.filter((row) => row.agentId === null);
  const granted =
    workspaceRows.length === 0
      ? []
      : await tx
          .select({ variableId: envVariableGrants.variableId })
          .from(envVariableGrants)
          .where(
            and(
              eq(envVariableGrants.agentId, release.agentId),
              inArray(
                envVariableGrants.variableId,
                workspaceRows.map((row) => row.id),
              ),
            ),
          )
          .for("share");
  const grantedIds = new Set(granted.map((grant) => grant.variableId));

  const entries: EnvStart["entries"] = [];
  let bytes = 0;
  for (const name of names) {
    const own = rows.find((row) => row.agentId !== null && row.name === name);
    const shared = workspaceRows.find((row) => row.name === name);
    if (!own && !shared) return { outcome: "refused", reason: "unresolved" };
    if (!own && shared && !shared.grantAll && !grantedIds.has(shared.id)) {
      return { outcome: "refused", reason: "not_granted" };
    }
    const row = own ?? shared;
    if (!row) return { outcome: "refused", reason: "unresolved" };
    const scope = own ? ("agent" as const) : ("workspace" as const);
    if (row.kind === "secret") {
      // Marked for delivery or not at all; the value is read at claim, never copied.
      if (!row.engineDelivery)
        return { outcome: "refused", reason: "unresolved" };
      entries.push({ name, scope, kind: "secret", version: row.version });
      continue;
    }
    if (row.value === null) return { outcome: "refused", reason: "unresolved" };
    bytes += utf8Bytes(row.value);
    entries.push({
      name,
      scope,
      kind: "plain",
      version: row.version,
      value: row.value,
    });
  }
  if (bytes > ENV_SESSION_VALUES_MAX_BYTES) {
    return { outcome: "refused", reason: "too_large" };
  }
  return {
    outcome: "resolved",
    envStart: {
      entries,
      skipped: [],
      captured_at: (await dbNow(tx)).toISOString(),
    },
  };
}

/**
 * What the purge leaves of a snapshot it cannot read, for which
 * env_start_without_values gives NULL. NULL on an open session would read as
 * "took no variable" and let the next claim run without them. This holds no
 * value, `storedEntries` still cannot read it, so the claim keeps refusing,
 * and the purge does not pick it again.
 */
export const UNREADABLE_ENV_START = { entries: [], unreadable: true } as const;

/**
 * Drops the copied values of sessions that kept them past retention, so a
 * paused or stopped session does not hold a variable that was deleted long
 * ago. Names and versions stay; the next claim refuses the snapshot. Returns
 * how many sessions it changed; a dry run counts them, rows another
 * transaction holds included. The reconciler runs it every pass. The claim
 * already refuses an expired snapshot, so this only shortens how long the
 * value is stored.
 */
export async function purgeExpiredEnvStart(
  db: Database,
  options: { limit: number; dryRun: boolean; retentionMs?: number },
): Promise<number> {
  const cutoff = new Date(
    (await dbNow(db)).getTime() -
      (options.retentionMs ?? ENV_START_RETENTION_MS),
  ).toISOString();
  // The last two conditions repeat the predicate of
  // sessions_env_start_values_idx (migration 0271), so the pass reads only
  // sessions that still hold a value. Change one and the other follows.
  const expired = sql`
    SELECT id FROM sessions
    WHERE admission_state <> 'closed'
      -- CASE keeps the cast from running on text that is not a timestamp. A
      -- stamp that does not parse counts as expired: the claim refuses such
      -- a snapshot anyway, so its values have no use left.
      AND CASE
        WHEN pg_input_is_valid(env_start ->> 'captured_at', 'timestamptz')
        THEN (env_start ->> 'captured_at')::timestamptz < ${cutoff}::timestamptz
        ELSE true
      END
      AND env_start IS NOT NULL
      AND env_start IS DISTINCT FROM env_start_without_values(env_start)
    ORDER BY id
    LIMIT ${options.limit}`;
  const result = await db.execute(
    options.dryRun
      ? expired
      : sql`
    UPDATE sessions SET env_start = COALESCE(
      env_start_without_values(env_start),
      ${JSON.stringify(UNREADABLE_ENV_START)}::jsonb
    )
    WHERE id IN (${expired} FOR UPDATE SKIP LOCKED)
    RETURNING id`,
  );
  return rowsOf<{ id: string }>(result).length;
}

/**
 * The receipt of a session that took variables: names, scopes, kinds and
 * versions. A version comes from one global counter, so it names a value
 * exactly without the receipt holding it.
 */
export async function recordEnvResolution(
  tx: Database,
  input: {
    ownerId: string;
    actor: ReceiptActor | null;
    requestId: string | null;
    sessionId: string;
    envStart: EnvStart;
  },
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: input.ownerId,
    actor: input.actor,
    requestId: input.requestId,
    operation: "resolve_session_env",
    targetRef: { session_id: input.sessionId, turn_id: null, request_id: null },
    status: "succeeded",
    result: {
      entries: input.envStart.entries.map(({ name, scope, kind, version }) => ({
        name,
        scope,
        kind,
        version,
      })),
      skipped: input.envStart.skipped,
    },
  });
  return id;
}

/**
 * The failed receipt of a session that was not created, or of a launch that
 * was given up on, because its variables were refused. It names the cause, not
 * the variable: whoever reads it is told whom to ask, not what is missing.
 */
export async function recordEnvRefusal(
  tx: Database,
  input: {
    ownerId: string;
    actor: ReceiptActor | null;
    requestId: string | null;
    reason: EnvRefusal;
    /** The session that already exists, or the agent of the release a new one would belong to. */
    target:
      | { sessionId: string }
      | { releaseId: string; idempotencyKey: string };
  },
): Promise<{ receiptId: string }> {
  let targetRef: Record<string, unknown>;
  let result: Record<string, unknown>;
  if ("sessionId" in input.target) {
    targetRef = {
      session_id: input.target.sessionId,
      turn_id: null,
      request_id: null,
    };
    result = { reason: input.reason };
  } else {
    const [release] = await tx
      .select({ agentId: agentReleases.agentId })
      .from(agentReleases)
      .where(eq(agentReleases.id, input.target.releaseId))
      .limit(1);
    if (!release) throw new Error("A refused input names no stored release");
    targetRef = {
      resource: { kind: "agent", id: release.agentId },
      workspace_id: input.ownerId,
    };
    result = {
      reason: input.reason,
      agent_id: release.agentId,
      release_id: input.target.releaseId,
      idempotency_key: input.target.idempotencyKey,
    };
  }
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: input.ownerId,
    actor: input.actor,
    requestId: input.requestId,
    operation: "reject_session_env",
    targetRef,
    status: "failed",
    result,
    error: {
      code: "VARIABLE_UNRESOLVED",
      message:
        "A variable this agent's card declares did not reach the session",
    },
  });
  return { receiptId };
}
