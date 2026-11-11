import {
  AGENT_OUTSIDER_ACCESS_VALUES,
  type AgentAccessSettings,
  type AgentOutsiderAccess,
} from "@werft-ai/contracts";
import type {
  AgentAccessSettingStore,
  OutsideAgentAccessSetting,
  SlackGuestSetting,
  SlackGuestSettingStore,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import {
  and,
  eq,
  inArray,
  isNull,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { lockActorAccount } from "./control-shared.ts";
import type { Database } from "./queries.ts";
import { memberships, receipts, users, workspaces } from "./schema.ts";

// Holds the actor's membership under a share lock: the same lock offboarding
// takes, so a manager disabled mid-request cannot still write a setting.
export async function lockManager(
  tx: Database,
  workspaceId: string,
  actorUserId: string,
): Promise<boolean> {
  await lockActorAccount(tx, actorUserId);
  const manager = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, actorUserId),
        inArray(memberships.role, ["owner", "admin"]),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(1)
    .for("share", { of: memberships });
  return manager.length > 0;
}

export function createPostgresSlackGuestSetting(
  db: Database,
): SlackGuestSetting & SlackGuestSettingStore {
  return {
    // Anything but a stored `true` is the default: off.
    async enabled(workspaceId) {
      const [row] = await db
        .select({
          enabled: sql<boolean>`coalesce(${workspaces.settings} -> 'slack_guest_enabled' = 'true'::jsonb, false)`,
        })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return row?.enabled === true;
    },

    async setSlackGuestEnabled({ workspaceId, actorUserId, enabled }) {
      return db.transaction(async (tx) => {
        if (!(await lockManager(tx, workspaceId, actorUserId))) return false;
        const rows = await tx
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{slack_guest_enabled}', to_jsonb(${enabled}::boolean))`,
          })
          .where(eq(workspaces.id, workspaceId))
          .returning({ id: workspaces.id });
        return rows.length > 0;
      });
    },
  };
}

/**
 * Axis A as stored: a missing key is the default `use`; a value no write
 * could have stored hides the agent (fail-closed).
 */
export function outsiderAccessOf(settings: unknown): AgentOutsiderAccess {
  const value = (settings as Record<string, unknown> | null)
    ?.agent_outsider_access;
  if (value === undefined) return "use";
  return (AGENT_OUTSIDER_ACCESS_VALUES as readonly unknown[]).includes(value)
    ? (value as AgentOutsiderAccess)
    : "none";
}

function settingsOf(settings: unknown): AgentAccessSettings {
  const visibility = (settings as Record<string, unknown> | null)
    ?.agent_outsider_session_visibility;
  return {
    agent_outsider_access: outsiderAccessOf(settings),
    agent_outsider_session_visibility:
      visibility === "workspace" ? "workspace" : "managing_team",
  };
}

/**
 * True where the workspace lets every member see the `workspace`-scoped
 * sessions of an agent (axis B `workspace`). Anything else, the missing key
 * included, is the default `managing_team`. An agent held by the migration
 * 0243 holding team is exempt on its own (`holds_unassigned`).
 */
export function outsidersSeeAgentSessions(
  workspaceId: string | SQLWrapper,
): SQL {
  return sql`coalesce((SELECT w.settings ->> 'agent_outsider_session_visibility' FROM ${workspaces} w WHERE w.id = ${workspaceId}), 'managing_team') = 'workspace'`;
}

/**
 * Both axes under a lock the settings write waits for (FOR KEY SHARE, which
 * a write's FOR UPDATE conflicts with and other no-key locks on the row do
 * not). Taken after the session row (requester-locks.ts); defaults for a
 * workspace that is gone.
 */
export async function lockAgentAccessSettings(
  tx: Database,
  workspaceId: string,
): Promise<AgentAccessSettings> {
  const [row] = await tx
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .for("key share");
  return settingsOf(row?.settings ?? null);
}

export function createPostgresAgentAccessSetting(
  db: Database,
): OutsideAgentAccessSetting & AgentAccessSettingStore {
  return {
    async access(workspaceId) {
      const [row] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      return outsiderAccessOf(row?.settings ?? null);
    },

    async setAgentAccess(input) {
      return db.transaction(async (tx) => {
        if (!(await lockManager(tx, input.workspaceId, input.actorUserId))) {
          return { outcome: "inactive" as const };
        }
        // After the people, as every reader of these settings takes them.
        // FOR UPDATE, not the UPDATE's own no-key lock: the readers hold the
        // row FOR KEY SHARE (requester-locks.ts), which only this conflicts
        // with.
        const [row] = await tx
          .select({ settings: workspaces.settings })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId))
          .for("update");
        if (!row) return { outcome: "inactive" as const };
        const before = settingsOf(row.settings);
        const after: AgentAccessSettings = {
          agent_outsider_access:
            input.settings.agent_outsider_access ??
            before.agent_outsider_access,
          agent_outsider_session_visibility:
            input.settings.agent_outsider_session_visibility ??
            before.agent_outsider_session_visibility,
        };
        const changed = (
          Object.keys(after) as (keyof AgentAccessSettings)[]
        ).filter((key) => before[key] !== after[key]);
        if (changed.length === 0) {
          return { outcome: "unchanged" as const, settings: before };
        }
        const patch = Object.fromEntries(
          changed.map((key) => [key, after[key]]),
        );
        await tx
          .update(workspaces)
          .set({
            settings: sql`${workspaces.settings} || ${JSON.stringify(patch)}::jsonb`,
          })
          .where(eq(workspaces.id, input.workspaceId));
        await tx.insert(receipts).values({
          id: input.receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: "set_agent_access_settings",
          targetRef: {
            resource: { kind: "workspace", id: input.workspaceId },
            workspace_id: input.workspaceId,
          },
          result: {
            from: Object.fromEntries(changed.map((key) => [key, before[key]])),
            to: patch,
          },
          status: "succeeded",
          requestId: input.principal.requestId ?? null,
        });
        return { outcome: "set" as const, settings: after };
      });
    },
  };
}
