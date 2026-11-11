import {
  SLACK_APP_SECRET_PURPOSE_VALUES,
  type SlackAppSecretPurpose,
  type SlackAppSettings,
} from "@werft-ai/contracts";
import {
  type SecretKey,
  type SecretOwner,
  type SecretSlot,
  type SecretSummary,
  type SlackAppActor,
  type SlackAppAgent,
  type SlackAppRecord,
  type SlackAppStore,
  secretOwnerRef,
} from "@werft-ai/platform";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import { holdsRight, lockedRole } from "../musterrolle/api-keys.ts";
import type { Database } from "../queries.ts";
import {
  agentIdentities,
  agentReleases,
  agents,
  agentVersions,
  slackApps,
  workspaces,
} from "../schema.ts";
import {
  deleteSecretInTx,
  describeSecrets,
  readSecretInTx,
  secretSummaryKey,
  writeSecretInTx,
} from "../secrets/secret-values.ts";

type Row = typeof slackApps.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_STATES = ["creating", "created", "deleting"] as const;

const secretSlot = (
  row: Pick<Row, "workspaceId" | "id">,
  purpose: SlackAppSecretPurpose,
): SecretSlot => ({
  workspaceId: row.workspaceId,
  owner: { kind: "slack_app", id: row.id },
  purpose,
});

/** The name a secret goes by outside the store, e.g. an identity's `credential_ref`. */
function slackAppSecretRef(
  slackAppId: string,
  purpose: SlackAppSecretPurpose,
): string {
  return `${secretOwnerRef({ kind: "slack_app", id: slackAppId })}/${purpose}`;
}

async function recordOf(db: Database, row: Row): Promise<SlackAppRecord> {
  return recordFrom(
    row,
    await describeSecrets(db, row.workspaceId, [appOwner(row)]),
  );
}

const appOwner = (row: Pick<Row, "id">): SecretOwner => ({
  kind: "slack_app",
  id: row.id,
});

function recordFrom(
  row: Row,
  summaries: ReadonlyMap<string, SecretSummary>,
): SlackAppRecord {
  const ownerRef = secretOwnerRef(appOwner(row));
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind,
    agentId: row.agentId,
    state: row.state,
    appId: row.appId,
    clientId: row.clientId,
    redirectUrl: row.redirectUrl,
    createdByTokenUser: row.createdByTokenUser,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    events: {
      state: row.eventsState,
      checked_at: row.eventsCheckedAt?.toISOString() ?? null,
      url: row.eventsUrl,
      ...(row.eventsError === null ? {} : { error: row.eventsError }),
    },
    secrets: Object.fromEntries(
      SLACK_APP_SECRET_PURPOSE_VALUES.map((purpose) => [
        purpose,
        summaries.get(secretSummaryKey(ownerRef, purpose)) ?? null,
      ]),
    ) as SlackAppRecord["secrets"],
  };
}

// The actor's role and agent admin row as they stand under share locks, so
// a demotion committed after the policy's decision is seen here.
async function actorRefusal(
  tx: Database,
  workspaceId: string,
  agentId: string | null,
  actor: SlackAppActor,
): Promise<"actor_inactive" | "outranked" | null> {
  if (actor === null) return null;
  const userId = actor.principal.actor?.userId;
  if (!userId) return "actor_inactive";
  const role = await lockedRole(tx, workspaceId, userId);
  if (role === null) return "actor_inactive";
  return (await holdsRight(tx, workspaceId, userId, {
    role,
    roles: actor.managerRoles,
    agentId,
  }))
    ? null
    : "outranked";
}

async function agentForApp(
  tx: Database,
  workspaceId: string,
  agentId: string,
): Promise<(SlackAppAgent & { active: boolean }) | null> {
  const [agent] = await tx
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      status: agents.status,
      activeReleaseId: agents.activeReleaseId,
      description: agents.description,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    // Requests for this agent's app queue here, so two never both find no
    // app and both begin one.
    .for("no key update");
  if (!agent || agent.status === "archived") return null;
  if (agent.activeReleaseId === null) {
    return {
      id: agent.id,
      name: agent.name,
      slug: agent.slug,
      role: "",
      active: false,
    };
  }
  const [version] = await tx
    .select({ card: agentVersions.card })
    .from(agentReleases)
    .innerJoin(agentVersions, eq(agentVersions.id, agentReleases.versionId))
    .where(
      and(
        eq(agentReleases.agentId, agentId),
        eq(agentReleases.id, agent.activeReleaseId),
      ),
    );
  const role = (version?.card as { role?: unknown } | undefined)?.role;
  return {
    id: agent.id,
    name: agent.name,
    slug: agent.slug,
    // An agent made without a role has an empty one, and Slack rejects an
    // empty app description, so its own description stands in.
    role:
      typeof role === "string" && role.trim() !== ""
        ? role
        : (agent.description ?? ""),
    active: true,
  };
}

async function lockedApp(
  tx: Database,
  workspaceId: string,
  slackAppId: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(slackApps)
    .where(
      and(eq(slackApps.id, slackAppId), eq(slackApps.workspaceId, workspaceId)),
    )
    .for("update");
  return row;
}

// Needs no secret key, so the Slack event handler reads it without the store.
export async function getSlackAppSettings(
  db: Database,
  workspaceId: string,
  agentId: string,
): Promise<SlackAppSettings | null> {
  if (!UUID.test(agentId)) return null;
  const [row] = await db
    .select({ mention_only: agents.slackMentionOnly })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.id, agentId.toLowerCase()),
      ),
    );
  return row ?? null;
}

export function createPostgresSlackAppStore(
  db: Database,
  key: SecretKey,
): SlackAppStore {
  return {
    async setEvents(workspaceId, slackAppId, events) {
      await db
        .update(slackApps)
        .set({
          eventsState: events.state,
          eventsCheckedAt:
            events.checked_at === null ? null : new Date(events.checked_at),
          eventsError: events.error ?? null,
          updatedAt: DB_NOW,
        })
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId),
            eq(slackApps.id, slackAppId),
            eq(slackApps.state, "created"),
          ),
        );
    },
    async registerEventsUrl(workspaceId, slackAppId, url, checkedAt) {
      // A verified app stored before its URL was is taken to have this one.
      const kept = sql`${slackApps.eventsState} = 'verified' AND (${slackApps.eventsUrl} IS NULL OR ${slackApps.eventsUrl} = ${url})`;
      await db
        .update(slackApps)
        .set({
          eventsState: sql`CASE WHEN ${kept} THEN 'verified' ELSE 'pending' END`,
          eventsCheckedAt: sql`CASE WHEN ${kept} THEN ${slackApps.eventsCheckedAt} ELSE ${new Date(checkedAt)} END`,
          eventsError: sql`CASE WHEN ${kept} THEN ${slackApps.eventsError} ELSE NULL END`,
          eventsUrl: url,
          updatedAt: DB_NOW,
        })
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId),
            eq(slackApps.id, slackAppId),
            eq(slackApps.state, "created"),
          ),
        );
    },
    async setEventsUnlessVerified(workspaceId, slackAppId, events) {
      await db
        .update(slackApps)
        .set({
          eventsState: events.state,
          eventsCheckedAt:
            events.checked_at === null ? null : new Date(events.checked_at),
          eventsError: events.error ?? null,
          updatedAt: DB_NOW,
        })
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId),
            eq(slackApps.id, slackAppId),
            eq(slackApps.state, "created"),
            ne(slackApps.eventsState, "verified"),
          ),
        );
    },
    getSettings: (workspaceId, agentId) =>
      getSlackAppSettings(db, workspaceId, agentId),
    putSettings(input) {
      return db.transaction(async (tx) => {
        const refused = await actorRefusal(
          tx,
          input.workspaceId,
          input.agentId,
          input.actor,
        );
        if (refused) return refused;
        const [row] = await tx
          .update(agents)
          .set({ slackMentionOnly: input.settings.mention_only })
          .where(
            and(
              eq(agents.workspaceId, input.workspaceId),
              eq(agents.id, input.agentId.toLowerCase()),
            ),
          )
          .returning({ id: agents.id });
        return row ? ("saved" as const) : ("not_found" as const);
      });
    },
    beginAgentApp(input) {
      const workspaceId = input.workspaceId.toLowerCase();
      if (!UUID.test(input.agentId)) {
        return Promise.resolve({ outcome: "agent_not_found" as const });
      }
      const agentId = input.agentId.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await actorRefusal(
          tx,
          workspaceId,
          agentId,
          input.actor,
        );
        if (refused) return { outcome: refused };
        const agent = await agentForApp(tx, workspaceId, agentId);
        if (agent === null) return { outcome: "agent_not_found" as const };
        const [live] = await tx
          .select()
          .from(slackApps)
          .where(
            and(
              eq(slackApps.workspaceId, workspaceId),
              eq(slackApps.agentId, agentId),
              eq(slackApps.kind, "agent"),
              inArray(slackApps.state, [...LIVE_STATES]),
            ),
          )
          .for("update");
        if (live && live.state !== "creating") {
          return { outcome: "exists" as const, app: await recordOf(tx, live) };
        }
        if (live) {
          const uncertain = live.createdAt < input.staleBefore;
          if (!(uncertain && input.replaceUncertain)) {
            return {
              outcome: "creating" as const,
              app: await recordOf(tx, live),
              uncertain,
            };
          }
          await tx
            .update(slackApps)
            .set({ state: "abandoned", updatedAt: DB_NOW })
            .where(eq(slackApps.id, live.id));
        }
        if (!agent.active) return { outcome: "agent_not_active" as const };
        const [row] = await tx
          .insert(slackApps)
          .values({
            id: input.newId,
            workspaceId,
            kind: "agent",
            agentId,
            state: "creating",
            redirectUrl: input.redirectUrl,
            createdBy: input.actor?.principal.actor?.userId ?? null,
          })
          .returning();
        if (!row) throw new Error("slack_apps insert returned no row");
        return {
          outcome: "begun" as const,
          app: await recordOf(tx, row),
          agent: {
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            role: agent.role,
          },
        };
      });
    },

    beginLinkApp(input) {
      const workspaceId = input.workspaceId.toLowerCase();
      if (!UUID.test(workspaceId)) {
        return Promise.resolve({ outcome: "workspace_not_found" as const });
      }
      return db.transaction(async (tx) => {
        // Starts and the operator's CLI queue here, so two never both find
        // no link app and both begin one.
        const [workspace] = await tx
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .for("no key update");
        if (!workspace) return { outcome: "workspace_not_found" as const };
        const refused = await actorRefusal(tx, workspaceId, null, input.actor);
        if (refused) return { outcome: refused };
        const [live] = await tx
          .select()
          .from(slackApps)
          .where(
            and(
              eq(slackApps.workspaceId, workspaceId),
              eq(slackApps.kind, "link"),
              inArray(slackApps.state, [...LIVE_STATES]),
            ),
          )
          .for("update");
        if (live && live.state !== "creating") {
          return { outcome: "exists" as const, app: await recordOf(tx, live) };
        }
        if (live) {
          const uncertain = live.createdAt < input.staleBefore;
          if (!(uncertain && input.replaceUncertain)) {
            return {
              outcome: "creating" as const,
              app: await recordOf(tx, live),
              uncertain,
            };
          }
          await tx
            .update(slackApps)
            .set({ state: "abandoned", updatedAt: DB_NOW })
            .where(eq(slackApps.id, live.id));
        }
        const [row] = await tx
          .insert(slackApps)
          .values({
            id: input.newId,
            workspaceId,
            kind: "link",
            agentId: null,
            state: "creating",
            redirectUrl: input.redirectUrl,
            createdBy: input.actor?.principal.actor?.userId ?? null,
          })
          .returning();
        if (!row) throw new Error("slack_apps insert returned no row");
        return {
          outcome: "begun" as const,
          app: await recordOf(tx, row),
          workspaceName: workspace.name,
        };
      });
    },

    finishCreate(input) {
      const workspaceId = input.workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        const row = await lockedApp(tx, workspaceId, input.slackAppId);
        if (!row || row.state !== "creating") {
          throw new Error(
            `Slack app ${input.slackAppId} is no longer being created`,
          );
        }
        await writeSecretInTx(
          tx,
          key,
          secretSlot(row, "slack_signing_secret"),
          input.created.signingSecret,
          null,
        );
        await writeSecretInTx(
          tx,
          key,
          secretSlot(row, "slack_client_secret"),
          input.created.clientSecret,
          null,
        );
        const [updated] = await tx
          .update(slackApps)
          .set({
            state: "created",
            appId: input.created.appId,
            clientId: input.created.clientId,
            createdByTokenUser: input.tokenUserId,
            signingSecretRef: slackAppSecretRef(row.id, "slack_signing_secret"),
            clientSecretRef: slackAppSecretRef(row.id, "slack_client_secret"),
            updatedAt: DB_NOW,
          })
          .where(eq(slackApps.id, row.id))
          .returning();
        if (!updated) throw new Error("slack_apps update returned no row");
        return recordOf(tx, updated);
      });
    },

    storeBotToken(input) {
      return db.transaction(async (tx) => {
        const row = await lockedApp(
          tx,
          input.workspaceId.toLowerCase(),
          input.slackAppId.toLowerCase(),
        );
        if (!row || row.state !== "created") return null;
        await writeSecretInTx(
          tx,
          key,
          secretSlot(row, "slack_bot_token"),
          input.botToken,
          null,
        );
        const [updated] = await tx
          .update(slackApps)
          .set({
            botTokenRef: slackAppSecretRef(row.id, "slack_bot_token"),
            updatedAt: DB_NOW,
          })
          .where(eq(slackApps.id, row.id))
          .returning();
        if (!updated) throw new Error("slack_apps update returned no row");
        return recordOf(tx, updated);
      });
    },

    async failCreate(workspaceId, slackAppId) {
      await db
        .update(slackApps)
        .set({ state: "failed", updatedAt: DB_NOW })
        .where(
          and(
            eq(slackApps.id, slackAppId),
            eq(slackApps.workspaceId, workspaceId.toLowerCase()),
            eq(slackApps.state, "creating"),
          ),
        );
    },

    async find(workspaceId, slackAppId) {
      if (!UUID.test(slackAppId)) return null;
      const [row] = await db
        .select()
        .from(slackApps)
        .where(
          and(
            eq(slackApps.id, slackAppId.toLowerCase()),
            eq(slackApps.workspaceId, workspaceId.toLowerCase()),
          ),
        );
      return row ? recordOf(db, row) : null;
    },

    async findAgentApp(agentId) {
      if (!UUID.test(agentId)) return null;
      const [row] = await db
        .select()
        .from(slackApps)
        .where(
          and(
            eq(slackApps.agentId, agentId.toLowerCase()),
            eq(slackApps.kind, "agent"),
            eq(slackApps.state, "created"),
          ),
        )
        .limit(1);
      return row ? recordOf(db, row) : null;
    },

    manifestAgent(workspaceId, agentId) {
      if (!UUID.test(agentId)) return Promise.resolve(null);
      return db.transaction(async (tx) => {
        const agent = await agentForApp(
          tx,
          workspaceId.toLowerCase(),
          agentId.toLowerCase(),
        );
        return agent === null
          ? null
          : {
              id: agent.id,
              name: agent.name,
              slug: agent.slug,
              role: agent.role,
            };
      });
    },

    async findForAgent(workspaceId, agentId) {
      if (!UUID.test(agentId)) return null;
      const [row] = await db
        .select()
        .from(slackApps)
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId.toLowerCase()),
            eq(slackApps.agentId, agentId.toLowerCase()),
            eq(slackApps.kind, "agent"),
            inArray(slackApps.state, [...LIVE_STATES]),
          ),
        );
      return row ? recordOf(db, row) : null;
    },

    async listMade(workspaceId) {
      if (!UUID.test(workspaceId)) return [];
      const rows = await db
        .select({
          app: slackApps,
          name: agents.name,
          slug: agents.slug,
          installed: sql<boolean>`exists (${db
            .select({ one: sql`1` })
            .from(agentIdentities)
            .where(
              and(
                eq(agentIdentities.workspaceId, slackApps.workspaceId),
                eq(agentIdentities.agentId, slackApps.agentId),
                eq(agentIdentities.provider, "slack_bot"),
                eq(agentIdentities.status, "active"),
              ),
            )})`,
        })
        .from(slackApps)
        .leftJoin(
          agents,
          and(
            eq(agents.workspaceId, slackApps.workspaceId),
            eq(agents.id, slackApps.agentId),
          ),
        )
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId.toLowerCase()),
            inArray(slackApps.kind, ["agent", "link"]),
            inArray(slackApps.state, [...LIVE_STATES]),
          ),
        )
        .orderBy(
          sql`${slackApps.kind} = 'agent'`,
          agents.name,
          slackApps.createdAt,
        );
      const summaries = await describeSecrets(
        db,
        workspaceId,
        rows.map((row) => appOwner(row.app)),
      );
      return rows.map((row) => ({
        app: recordFrom(row.app, summaries),
        agent:
          row.app.agentId === null || row.name === null || row.slug === null
            ? null
            : {
                id: row.app.agentId,
                name: row.name,
                slug: row.slug,
                installed: row.installed,
              },
      }));
    },

    linkAppClient(workspaceId) {
      if (!UUID.test(workspaceId)) return Promise.resolve(null);
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(slackApps)
          .where(
            and(
              eq(slackApps.workspaceId, workspaceId.toLowerCase()),
              eq(slackApps.kind, "link"),
              eq(slackApps.state, "created"),
            ),
          );
        if (!row) return null;
        const clientSecret = await readSecretInTx(
          tx,
          key,
          secretSlot(row, "slack_client_secret"),
        );
        return clientSecret === null
          ? null
          : { app: await recordOf(tx, row), clientSecret };
      });
    },

    async lastTokenUser(workspaceId) {
      const [row] = await db
        .select({ user: slackApps.createdByTokenUser })
        .from(slackApps)
        .where(
          and(
            eq(slackApps.workspaceId, workspaceId.toLowerCase()),
            isNotNull(slackApps.createdByTokenUser),
          ),
        )
        .orderBy(desc(slackApps.updatedAt))
        .limit(1);
      return row?.user ?? null;
    },

    beginDelete(input) {
      const workspaceId = input.workspaceId.toLowerCase();
      if (!UUID.test(input.slackAppId)) {
        return Promise.resolve({ outcome: "not_found" as const });
      }
      const slackAppId = input.slackAppId.toLowerCase();
      return db.transaction(async (tx) => {
        const [peek] = await tx
          .select({ agentId: slackApps.agentId })
          .from(slackApps)
          .where(
            and(
              eq(slackApps.id, slackAppId),
              eq(slackApps.workspaceId, workspaceId),
            ),
          );
        if (!peek) return { outcome: "not_found" as const };
        const refused = await actorRefusal(
          tx,
          workspaceId,
          peek.agentId,
          input.actor,
        );
        if (refused) return { outcome: refused };
        const row = await lockedApp(tx, workspaceId, slackAppId);
        if (!row) return { outcome: "not_found" as const };
        if (row.state === "creating") {
          return { outcome: "creating" as const, app: await recordOf(tx, row) };
        }
        if (row.state !== "created" && row.state !== "deleting") {
          return { outcome: "settled" as const, app: await recordOf(tx, row) };
        }
        const [updated] = await tx
          .update(slackApps)
          .set({ state: "deleting", updatedAt: DB_NOW })
          .where(eq(slackApps.id, row.id))
          .returning();
        if (!updated) throw new Error("slack_apps update returned no row");
        return { outcome: "begun" as const, app: await recordOf(tx, updated) };
      });
    },

    finishDelete(workspaceId, slackAppId) {
      return db.transaction(async (tx) => {
        const row = await lockedApp(
          tx,
          workspaceId.toLowerCase(),
          slackAppId.toLowerCase(),
        );
        if (!row) throw new Error(`Slack app ${slackAppId} not found`);
        for (const purpose of SLACK_APP_SECRET_PURPOSE_VALUES) {
          await deleteSecretInTx(tx, secretSlot(row, purpose));
        }
        const [updated] = await tx
          .update(slackApps)
          .set({
            state: "deleted",
            signingSecretRef: null,
            clientSecretRef: null,
            botTokenRef: null,
            updatedAt: DB_NOW,
          })
          .where(eq(slackApps.id, row.id))
          .returning();
        if (!updated) throw new Error("slack_apps update returned no row");
        return recordOf(tx, updated);
      });
    },
  };
}

/** The kind of one of the workspace's apps, for the per-app secret route. */
export async function slackAppKind(
  db: Database,
  workspaceId: string,
  slackAppId: string,
) {
  if (!UUID.test(slackAppId)) return null;
  const [row] = await db
    .select({ kind: slackApps.kind })
    .from(slackApps)
    .where(
      and(
        eq(slackApps.id, slackAppId.toLowerCase()),
        eq(slackApps.workspaceId, workspaceId.toLowerCase()),
        inArray(slackApps.state, [...LIVE_STATES]),
      ),
    );
  return row?.kind ?? null;
}
