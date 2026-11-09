import { randomUUID } from "node:crypto";
import {
  DEFAULT_SURFACE_CEILING,
  type SlackSurfaceAction,
  type SurfaceMembershipState,
} from "@werft-ai/contracts";
import type {
  Principal,
  ResolveSurfaceBindingInput,
  ResolveSurfaceBindingResult,
  SetSurfaceBindingResult,
  SurfaceBindingRecord,
  SurfaceBindingStore,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { callerHoldsRight } from "./agent-identities.ts";
import { lockedRole } from "./api-keys.ts";
import { findPgError, receiptActorOf } from "./control-shared.ts";
import { rowsOf } from "./control-unit-of-work.ts";
import { DB_NOW } from "./db-clock.ts";
import type { Database } from "./queries.ts";
import {
  agentIdentities,
  agents,
  receipts,
  slackChannelLifecycle,
  surfaceBindings,
} from "./schema.ts";

// Lock order: the actor's membership, the agent, its identity, then the
// binding rows, as the identity store takes the install before its rows.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIVE_UNIQUE_INDEXES = new Set([
  "surface_bindings_channel_live_uniq",
  "surface_bindings_dm_live_uniq",
  "surface_bindings_home_live_uniq",
]);

const columns = {
  id: surfaceBindings.id,
  workspaceId: surfaceBindings.workspaceId,
  agentId: surfaceBindings.agentId,
  installationId: surfaceBindings.installationId,
  channelId: surfaceBindings.externalSurfaceId,
  channelKind: surfaceBindings.surfaceKind,
  mode: surfaceBindings.mode,
  ceilingActions: surfaceBindings.ceilingActions,
  ceilingDisclosure: surfaceBindings.ceilingDisclosure,
  home: surfaceBindings.home,
  memoryWritePolicy: surfaceBindings.memoryWritePolicy,
  status: surfaceBindings.status,
  approvedAt: surfaceBindings.approvedAt,
  membershipState: surfaceBindings.membership,
  membershipError: surfaceBindings.membershipError,
  muted: surfaceBindings.muted,
  revision: surfaceBindings.revision,
  createdAt: surfaceBindings.createdAt,
  revokedAt: surfaceBindings.revokedAt,
};

type Row = Omit<SurfaceBindingRecord, "ceiling" | "membership"> & {
  ceilingActions: string[];
  ceilingDisclosure: SurfaceBindingRecord["ceiling"]["disclosure"];
  membershipState: SurfaceMembershipState | null;
  membershipError: string | null;
};

function recordOf(row: Row): SurfaceBindingRecord {
  const {
    ceilingActions,
    ceilingDisclosure,
    membershipState,
    membershipError,
    ...rest
  } = row;
  return {
    ...rest,
    membership:
      membershipState === null
        ? null
        : { state: membershipState, error: membershipError },
    // The ceiling check keeps the column inside the Slack actions.
    ceiling: {
      actions: ceilingActions as SlackSurfaceAction[],
      disclosure: ceilingDisclosure,
    },
  };
}

function channelOf(installationId: string, channelId: string | null) {
  return and(
    eq(surfaceBindings.installationId, installationId),
    channelId === null
      ? eq(surfaceBindings.surfaceKind, "dm")
      : eq(surfaceBindings.externalSurfaceId, channelId),
    isNull(surfaceBindings.revokedAt),
  );
}

// Two writes racing to one channel, the DM row or the home: a live index
// refuses the second.
function isLiveConflict(error: unknown): boolean {
  const constraint = findPgError(error, "23505")?.constraint;
  return typeof constraint === "string" && LIVE_UNIQUE_INDEXES.has(constraint);
}

type ReceiptOperation =
  | "set_surface_binding"
  | "request_surface_binding"
  | "resolve_surface_binding";

const installationActor = (installationId: string | null) => ({
  principal: { kind: "installation" as const, id: installationId ?? "" },
  actor_user_id: null,
  agent_id: null,
});

async function writeReceipt(
  tx: Database,
  principal: Principal | null,
  binding: SurfaceBindingRecord,
  operation: ReceiptOperation = "set_surface_binding",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await tx.insert(receipts).values({
    id,
    ownerId: binding.workspaceId,
    actor:
      principal === null
        ? installationActor(binding.installationId)
        : receiptActorOf(principal),
    requestId: principal?.requestId ?? null,
    operation,
    targetRef: {
      resource: { kind: "surface_binding", id: binding.id },
      workspace_id: binding.workspaceId,
    },
    status: "succeeded",
    result: {
      surface_binding_id: binding.id,
      agent_id: binding.agentId,
      installation_id: binding.installationId,
      channel_id: binding.channelId,
      channel_kind: binding.channelKind,
      mode: binding.mode,
      home: binding.home,
      ceiling: binding.ceiling,
      status: binding.status,
      revision: binding.revision,
      ...extra,
    },
  });
  return id;
}

async function set(
  db: Database,
  input: Parameters<SurfaceBindingStore["set"]>[0],
): Promise<SetSurfaceBindingResult> {
  const { workspaceId } = input;
  if (!UUID.test(input.agentId)) return { outcome: "agent_not_found" };
  const agentId = input.agentId.toLowerCase();
  try {
    return await db.transaction(async (tx) => {
      const right = await callerHoldsRight(
        tx,
        input.principal,
        workspaceId,
        agentId,
        input.managerRoles,
      );
      if ("outcome" in right) return right;
      const [agent] = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
        .limit(1)
        .for("key share");
      if (!agent || agent.status === "archived") {
        return { outcome: "agent_not_found" };
      }
      // A revoke of the identity waits for this write, and this write sees
      // a revoke that committed first.
      const [identity] = await tx
        .select({ installationId: agentIdentities.installationId })
        .from(agentIdentities)
        .where(
          and(
            eq(agentIdentities.agentId, agentId),
            eq(agentIdentities.workspaceId, workspaceId),
            eq(agentIdentities.status, "active"),
          ),
        )
        // Several live installs have no selector in the request yet; the
        // newest is the one written, every time.
        .orderBy(desc(agentIdentities.createdAt), desc(agentIdentities.id))
        .limit(1)
        .for("share");
      if (!identity) return { outcome: "not_installed" };
      const { installationId } = identity;

      const [current] = await tx
        .select({
          id: surfaceBindings.id,
          agentId: surfaceBindings.agentId,
          status: surfaceBindings.status,
          surfaceKind: surfaceBindings.surfaceKind,
        })
        .from(surfaceBindings)
        .where(channelOf(installationId, input.channelId))
        .limit(1)
        .for("update");
      // Revoking an identity revokes its bindings, so a live row of another
      // agent is one written before that rule; it is never this caller's.
      if (current && current.agentId !== agentId) {
        return { outcome: "conflict" };
      }
      const waits =
        input.channelKind === "private_channel" &&
        (!current ||
          current.status === "pending_approval" ||
          current.surfaceKind !== "private_channel");
      const startsWaiting = waits && current?.status !== "pending_approval";
      if (waits && input.home) return { outcome: "pending_home" };
      if (input.home) {
        await tx
          .update(surfaceBindings)
          .set({
            home: false,
            revision: sql`${surfaceBindings.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(
            and(
              eq(surfaceBindings.agentId, agentId),
              eq(surfaceBindings.home, true),
              isNull(surfaceBindings.revokedAt),
              ...(current ? [ne(surfaceBindings.id, current.id)] : []),
            ),
          );
      }
      const values = {
        surfaceKind: input.channelKind,
        mode: input.mode,
        home: input.home,
        ceilingActions: [...input.ceiling.actions],
        ceilingDisclosure: input.ceiling.disclosure,
        ...(waits ? { status: "pending_approval" as const } : {}),
        updatedAt: DB_NOW,
      };
      const id = current?.id ?? randomUUID();
      if (current) {
        await tx
          .update(surfaceBindings)
          .set({ ...values, revision: sql`${surfaceBindings.revision} + 1` })
          .where(eq(surfaceBindings.id, id));
      } else {
        await tx.insert(surfaceBindings).values({
          ...values,
          id,
          workspaceId,
          agentId,
          surface: "slack",
          installationId,
          externalSurfaceId: input.channelId,
          createdBy: right.userId,
          createdAt: DB_NOW,
        });
      }
      const [row] = await tx
        .select(columns)
        .from(surfaceBindings)
        .where(eq(surfaceBindings.id, id));
      if (!row) throw new Error(`surface binding ${id} vanished in its tx`);
      const binding = recordOf(row);
      const receiptId = await writeReceipt(tx, input.principal, binding);
      if (startsWaiting) {
        await writeReceipt(
          tx,
          input.principal,
          binding,
          "request_surface_binding",
        );
      }
      return { outcome: "set", binding, receiptId };
    });
  } catch (error) {
    if (isLiveConflict(error)) return { outcome: "conflict" };
    throw error;
  }
}

export function createPostgresSurfaceBindingStore(
  db: Database,
): SurfaceBindingStore {
  return {
    set: (input) => set(db, input),
    async list(workspaceId, agentId, limit) {
      if (!UUID.test(agentId) || !UUID.test(workspaceId)) return [];
      const rows = await db
        .select(columns)
        .from(surfaceBindings)
        .where(
          and(
            eq(surfaceBindings.workspaceId, workspaceId),
            eq(surfaceBindings.agentId, agentId.toLowerCase()),
            isNull(surfaceBindings.revokedAt),
          ),
        )
        .orderBy(
          desc(surfaceBindings.home),
          asc(surfaceBindings.createdAt),
          asc(surfaceBindings.id),
        )
        .limit(limit);
      return rows.map(recordOf);
    },
    resolveSlackChannel: (installationId, channelId) =>
      resolveSlackChannel(db, installationId, channelId),
    async ensureDmBinding(installationId) {
      if (!UUID.test(installationId)) return null;
      const id = installationId.toLowerCase();
      const [live] = await db
        .select({ id: surfaceBindings.id })
        .from(surfaceBindings)
        .where(channelOf(id, null))
        .limit(1);
      if (!live) {
        const { actions, disclosure } = DEFAULT_SURFACE_CEILING;
        await db.execute(sql`
          INSERT INTO ${surfaceBindings} (id, workspace_id, agent_id, surface,
            installation_id, surface_kind, mode, ceiling_actions,
            ceiling_disclosure)
          SELECT ${randomUUID()}, i.workspace_id, i.agent_id, 'slack',
            i.installation_id, 'dm', 'on',
            ARRAY[${sql.join(
              actions.map((action) => sql`${action}`),
              sql`, `,
            )}]::text[], ${disclosure}
          FROM ${agentIdentities} i
          WHERE i.installation_id = ${id} AND i.status = 'active'
          ON CONFLICT DO NOTHING`);
      }
      return resolveSlackChannel(db, id, null);
    },
    async ensureInvitedChannel(installationId, channelId, channelKind) {
      if (!UUID.test(installationId)) return null;
      const id = installationId.toLowerCase();
      const { actions, disclosure } = DEFAULT_SURFACE_CEILING;
      const bindingId = randomUUID();
      return db.transaction(async (tx) => {
        const inserted = rowsOf<{ id: string }>(
          await tx.execute(sql`
            INSERT INTO ${surfaceBindings} (id, workspace_id, agent_id, surface,
              installation_id, external_surface_id, surface_kind, mode, status,
              ceiling_actions, ceiling_disclosure, membership)
            SELECT ${bindingId}, i.workspace_id, i.agent_id, 'slack',
              i.installation_id, ${channelId}, ${channelKind}, 'on',
              ${channelKind === "private_channel" ? "pending_approval" : "ready"},
              ARRAY[${sql.join(
                actions.map((action) => sql`${action}`),
                sql`, `,
              )}]::text[], ${disclosure}, 'joined'
            FROM ${agentIdentities} i
            WHERE i.installation_id = ${id} AND i.status = 'active'
            ON CONFLICT DO NOTHING
            RETURNING id`),
        );
        const binding = await liveChannel(tx, id, channelId);
        if (
          binding !== null &&
          inserted.length > 0 &&
          binding.status === "pending_approval"
        ) {
          await writeReceipt(tx, null, binding, "request_surface_binding");
        }
        return binding;
      });
    },
    findLiveSlackChannel: (installationId, channelId) =>
      liveChannel(db, installationId, channelId),
    async wasRejected(installationId, channelId) {
      const [last] = await db
        .select({
          status: surfaceBindings.status,
          surfaceKind: surfaceBindings.surfaceKind,
          approvedAt: surfaceBindings.approvedAt,
        })
        .from(surfaceBindings)
        .where(
          and(
            eq(surfaceBindings.installationId, installationId),
            eq(surfaceBindings.externalSurfaceId, channelId),
          ),
        )
        .orderBy(desc(surfaceBindings.createdAt), desc(surfaceBindings.id))
        .limit(1);
      return (
        last?.status === "revoked" &&
        last.surfaceKind === "private_channel" &&
        last.approvedAt === null
      );
    },
    async findPendingApproval(installationId, channelId) {
      const binding = await liveChannel(db, installationId, channelId);
      return binding?.status === "pending_approval"
        ? { id: binding.id, revision: binding.revision }
        : null;
    },
    requireApproval: (bindingId) => requireApproval(db, bindingId),
    observeLifecycle: (installationId, channelId, at) =>
      observeJoin(db, installationId, channelId, at),
    botLeft: (installationId, channelId, at) =>
      botLeft(db, installationId, channelId, at),
    recordJoin: (installationId, channelId, bindingId, at) =>
      recordJoin(db, installationId, channelId, bindingId, at),
    approve: (input) => resolve(db, input, "approve"),
    reject: (input) => resolve(db, input, "reject"),
    async setMembership(bindingId, membership, expected) {
      if (!UUID.test(bindingId)) return;
      await db
        .update(surfaceBindings)
        .set({
          membership: membership.state,
          membershipError: membership.error,
          updatedAt: DB_NOW,
        })
        .where(
          and(
            eq(surfaceBindings.id, bindingId.toLowerCase()),
            isNull(surfaceBindings.revokedAt),
            expected === undefined
              ? undefined
              : and(
                  sql`${surfaceBindings.membership} IS NOT DISTINCT FROM ${expected?.state ?? null}`,
                  sql`${surfaceBindings.membershipError} IS NOT DISTINCT FROM ${expected?.error ?? null}`,
                ),
          ),
        );
    },
  };
}

async function liveChannel(
  db: Database,
  installationId: string,
  channelId: string | null,
): Promise<SurfaceBindingRecord | null> {
  if (!UUID.test(installationId)) return null;
  const [row] = await db
    .select(columns)
    .from(surfaceBindings)
    .where(channelOf(installationId.toLowerCase(), channelId))
    .limit(1);
  return row ? recordOf(row) : null;
}

async function resolveSlackChannel(
  db: Database,
  installationId: string,
  channelId: string | null,
): Promise<SurfaceBindingRecord | null> {
  const binding = await liveChannel(db, installationId, channelId);
  return binding?.status === "ready" ? binding : null;
}

async function requireApproval(
  db: Database,
  bindingId: string,
): Promise<SurfaceBindingRecord | null> {
  if (!UUID.test(bindingId)) return null;
  return db.transaction(async (tx) => {
    const id = bindingId.toLowerCase();
    const [current] = await tx
      .select({
        status: surfaceBindings.status,
        surfaceKind: surfaceBindings.surfaceKind,
      })
      .from(surfaceBindings)
      .where(and(eq(surfaceBindings.id, id), isNull(surfaceBindings.revokedAt)))
      .limit(1)
      .for("update");
    if (
      !current ||
      current.status !== "ready" ||
      current.surfaceKind !== "public_channel"
    ) {
      return null;
    }
    await tx
      .update(surfaceBindings)
      .set({
        surfaceKind: "private_channel",
        status: "pending_approval",
        home: false,
        revision: sql`${surfaceBindings.revision} + 1`,
        updatedAt: DB_NOW,
      })
      .where(eq(surfaceBindings.id, id));
    const [row] = await tx
      .select(columns)
      .from(surfaceBindings)
      .where(eq(surfaceBindings.id, id));
    if (!row) throw new Error(`surface binding ${id} vanished in its tx`);
    const binding = recordOf(row);
    await writeReceipt(tx, null, binding, "request_surface_binding", {
      reason: "channel_now_private",
    });
    return binding;
  });
}

// The upsert's row lock holds until the caller's transaction ends, so a
// leave and a join of one channel note and apply in one order.
async function advanceLifecycle(
  tx: Database,
  installationId: string,
  channelId: string,
  at: number | null,
): Promise<boolean> {
  if (at === null) return true;
  if (!UUID.test(installationId)) return false;
  const rows = rowsOf<{ installation_id: string }>(
    await tx.execute(sql`
      INSERT INTO ${slackChannelLifecycle} (installation_id, channel_id,
        last_event_us)
      VALUES (${installationId.toLowerCase()}, ${channelId}, ${at}::bigint)
      ON CONFLICT (installation_id, channel_id) DO UPDATE
        SET last_event_us = EXCLUDED.last_event_us
        WHERE ${slackChannelLifecycle.lastEventUs} <= EXCLUDED.last_event_us
      RETURNING installation_id`),
  );
  return rows.length > 0;
}

type LockedBinding = SurfaceBindingRecord & {
  approvedLifecycleUs: number | null;
};

async function lockBinding(
  tx: Database,
  where: ReturnType<typeof and>,
): Promise<LockedBinding | null> {
  const [found] = await tx
    .select({
      ...columns,
      approvedLifecycleUs: surfaceBindings.approvedLifecycleUs,
    })
    .from(surfaceBindings)
    .where(where)
    .limit(1)
    .for("update");
  if (!found) return null;
  const { approvedLifecycleUs, ...row } = found;
  return { ...recordOf(row), approvedLifecycleUs };
}

// A ready private channel whose approval can no longer be trusted waits
// again: no home, no approval, a new revision (so its notice is sent again)
// and an installation receipt that says why.
async function sendBackToApproval(
  tx: Database,
  bindingId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(surfaceBindings)
    .set({
      status: "pending_approval",
      home: false,
      approvedAt: null,
      approvedLifecycleUs: null,
      revision: sql`${surfaceBindings.revision} + 1`,
      updatedAt: DB_NOW,
    })
    .where(eq(surfaceBindings.id, bindingId));
  const [after] = await tx
    .select(columns)
    .from(surfaceBindings)
    .where(eq(surfaceBindings.id, bindingId));
  if (!after)
    throw new Error(`surface binding ${bindingId} vanished in its tx`);
  await writeReceipt(tx, null, recordOf(after), "request_surface_binding", {
    reason,
  });
}

// The join's first look, before Slack is asked anything: false when a later
// event of the channel was already noted. A join of an approved private
// channel the bot is recorded as being in, and newer than anything noted,
// can only follow a leave this role has not seen (Slack sends no join to a
// member), so that approval is void at once; waiting for the late leave would
// serve mentions meanwhile. An equal time is a retry of a join already noted,
// not a new one. A join with no time cannot be told from a retry, so it
// voids too: the approval is asked for again rather than trusted.
async function observeJoin(
  db: Database,
  installationId: string,
  channelId: string,
  at: number | null,
): Promise<boolean> {
  if (!UUID.test(installationId)) return false;
  const installation = installationId.toLowerCase();
  return db.transaction(async (tx) => {
    let isNew = true;
    if (at !== null) {
      const [noted] = await tx
        .select({ us: slackChannelLifecycle.lastEventUs })
        .from(slackChannelLifecycle)
        .where(
          and(
            eq(slackChannelLifecycle.installationId, installation),
            eq(slackChannelLifecycle.channelId, channelId),
          ),
        )
        .for("update");
      if (noted && noted.us >= at) isNew = noted.us < at;
      if (!(await advanceLifecycle(tx, installation, channelId, at))) {
        return false;
      }
    }
    if (!isNew) return true;
    const current = await lockBinding(tx, channelOf(installation, channelId));
    if (
      current?.status === "ready" &&
      current.channelKind === "private_channel" &&
      current.membership?.state === "joined"
    ) {
      await sendBackToApproval(tx, current.id, "rejoined_channel");
    }
    return true;
  });
}

// The join's last write, after Slack was asked and the binding made: the
// membership is recorded only if no later leave was noted meanwhile.
async function recordJoin(
  db: Database,
  installationId: string,
  channelId: string,
  bindingId: string,
  at: number | null,
): Promise<boolean> {
  if (!UUID.test(installationId) || !UUID.test(bindingId)) return false;
  return db.transaction(async (tx) => {
    if (!(await advanceLifecycle(tx, installationId, channelId, at))) {
      return false;
    }
    await tx
      .update(surfaceBindings)
      .set({ membership: "joined", membershipError: null, updatedAt: DB_NOW })
      .where(
        and(
          eq(surfaceBindings.id, bindingId.toLowerCase()),
          isNull(surfaceBindings.revokedAt),
        ),
      );
    return true;
  });
}

async function botLeft(
  db: Database,
  installationId: string,
  channelId: string,
  at: number | null,
): Promise<boolean> {
  if (!UUID.test(installationId)) return false;
  const installation = installationId.toLowerCase();
  return db.transaction(async (tx) => {
    // An older leave is not the channel's latest word, so it leaves the
    // membership alone; whether it voids the approval is decided below.
    const latest = await advanceLifecycle(tx, installation, channelId, at);
    const current = await lockBinding(tx, channelOf(installation, channelId));
    if (
      !current ||
      current.channelKind !== "private_channel" ||
      (current.status !== "ready" && current.status !== "pending_approval")
    ) {
      return latest;
    }
    // The approval voids unless it already knew of this leave: only Slack's
    // own times are compared, never the database clock against Slack's.
    const known = at !== null && at <= (current.approvedLifecycleUs ?? 0);
    if (current.status === "ready" && !known) {
      await sendBackToApproval(tx, current.id, "bot_left_channel");
    }
    if (latest) {
      await tx
        .update(surfaceBindings)
        .set({
          membership: "awaiting_invite",
          membershipError: null,
          updatedAt: DB_NOW,
        })
        .where(eq(surfaceBindings.id, current.id));
    }
    return latest;
  });
}

// The role is read again under lock, from the membership alone: the agent's
// admins may ask for a channel but never decide on it, so the check
// `callerHoldsRight` makes (role or agent admin) is not used.
async function resolve(
  db: Database,
  input: ResolveSurfaceBindingInput,
  decision: "approve" | "reject",
): Promise<ResolveSurfaceBindingResult> {
  const { workspaceId } = input;
  if (!UUID.test(input.agentId) || !UUID.test(input.bindingId)) {
    return { outcome: "not_found" };
  }
  const agentId = input.agentId.toLowerCase();
  const bindingId = input.bindingId.toLowerCase();
  return db.transaction(async (tx) => {
    const userId = input.principal.actor?.userId;
    if (!userId) return { outcome: "actor_inactive" };
    const role = await lockedRole(tx, workspaceId, userId);
    if (role === null) return { outcome: "actor_inactive" };
    if (!input.approverRoles.includes(role)) return { outcome: "outranked" };
    const [agent] = await tx
      .select({ status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
      .limit(1)
      .for("key share");
    if (!agent || agent.status === "archived") return { outcome: "not_found" };
    const [found] = await tx
      .select({ ...columns, createdBy: surfaceBindings.createdBy })
      .from(surfaceBindings)
      .where(
        and(
          eq(surfaceBindings.id, bindingId),
          eq(surfaceBindings.workspaceId, workspaceId),
          eq(surfaceBindings.agentId, agentId),
        ),
      )
      .limit(1)
      .for("update");
    if (!found) return { outcome: "not_found" };
    const { createdBy, ...row } = found;
    const current = recordOf(row);
    if (current.status !== "pending_approval") {
      const again =
        current.revision === input.revision + 1 &&
        (decision === "approve"
          ? current.status === "ready" && current.approvedAt !== null
          : current.status === "revoked");
      return again
        ? { outcome: "replayed", binding: current }
        : { outcome: "conflict" };
    }
    if (current.revision !== input.revision) return { outcome: "conflict" };
    // What the approval covers: the join/leave events noted so far. A leave
    // noted later and stamped later voids it; a late one from before does not.
    const [noted] =
      decision === "approve" &&
      current.installationId !== null &&
      current.channelId !== null
        ? await tx
            .select({ us: slackChannelLifecycle.lastEventUs })
            .from(slackChannelLifecycle)
            .where(
              and(
                eq(
                  slackChannelLifecycle.installationId,
                  current.installationId,
                ),
                eq(slackChannelLifecycle.channelId, current.channelId),
              ),
            )
            .limit(1)
        : [];
    await tx
      .update(surfaceBindings)
      .set({
        ...(decision === "approve"
          ? {
              status: "ready" as const,
              approvedAt: DB_NOW,
              approvedLifecycleUs: noted?.us ?? 0,
            }
          : { status: "revoked" as const, revokedAt: DB_NOW }),
        revision: sql`${surfaceBindings.revision} + 1`,
        updatedAt: DB_NOW,
      })
      .where(eq(surfaceBindings.id, bindingId));
    const [after] = await tx
      .select(columns)
      .from(surfaceBindings)
      .where(eq(surfaceBindings.id, bindingId));
    if (!after)
      throw new Error(`surface binding ${bindingId} vanished in its tx`);
    const binding = recordOf(after);
    if (decision === "reject") {
      await tx.execute(sql`
        UPDATE slack_outbox
        SET status = 'failed', error_code = 'not_addressed',
          claim_token = NULL, lease_expires_at = NULL
        WHERE installation_id = ${after.installationId}
          AND channel_id = ${after.channelId}
          AND status = 'pending'
          AND kind <> 'notice'`);
    }
    const receiptId = await writeReceipt(
      tx,
      input.principal,
      binding,
      "resolve_surface_binding",
      { decision, requested_by_user_id: createdBy },
    );
    return { outcome: "resolved", binding, receiptId };
  });
}
