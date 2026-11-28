import type {
  SlackGuestSetting,
  SlackGuestSettingStore,
  WebFetchPreflightSettingStore,
} from "@werft-ai/platform";
import { MANAGEMENT_ROLES } from "@werft-ai/platform";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockActorAccount } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import { memberships, users, workspaces } from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";

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
        inArray(memberships.role, MANAGEMENT_ROLES["workspace.manage"] ?? []),
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

export function createPostgresWebFetchPreflightSetting(
  db: Database,
): WebFetchPreflightSettingStore {
  return {
    async setWebFetchPreflight({
      workspaceId,
      actorUserId,
      principal,
      enabled,
    }) {
      return db.transaction(async (tx) => {
        if (!(await lockManager(tx, workspaceId, actorUserId))) return null;
        const rows = await tx
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{web_fetch_preflight}', to_jsonb(${enabled}::boolean))`,
          })
          .where(eq(workspaces.id, workspaceId))
          .returning({ id: workspaces.id });
        if (rows.length === 0) return null;
        return writeSucceededReceipt(tx, principal, {
          operation: "set_web_fetch_preflight",
          resource: { kind: "workspace", id: workspaceId },
          workspaceId,
          result: { web_fetch_preflight: enabled },
        });
      });
    },
  };
}
