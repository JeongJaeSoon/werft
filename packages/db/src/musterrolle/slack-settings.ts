import { randomUUID } from "node:crypto";
import { DB_NOW } from "../db-clock.ts";
import { secretOwnerWorkspace } from "../installation-settings.ts";
import type { Database } from "../queries.ts";
import { receipts, slackSettings } from "../schema.ts";

/** The owner saving the setting, and the receipt it leaves. */
export type SlackSettingsAudit = {
  userId: string;
  workspaceId: string;
  receiptId: string;
};

/**
 * The installation's Slack settings: one row, absent until an owner saves
 * one or an upgrade carries the old SLACK_EVENTS_PUBLIC_URL in.
 */
export interface SlackSettingsStore {
  /** Null while there is no row: nothing was ever saved or carried in. */
  read(): Promise<{ eventsPublicUrl: string | null } | null>;
  /**
   * Saving null leaves the row, so a later start carries nothing in. The
   * receipt is written only when the saved address changes.
   */
  setEventsPublicUrl(input: {
    value: string | null;
    audit: SlackSettingsAudit;
  }): Promise<{ changed: boolean }>;
  /**
   * Keeps the value only while there is no row; true when it did. Its
   * receipt has no actor: nobody in the console made the change.
   */
  importEventsPublicUrl(value: string): Promise<boolean>;
}

export function createPostgresSlackSettingsStore(
  db: Database,
): SlackSettingsStore {
  return {
    async read() {
      const [row] = await db
        .select({ eventsPublicUrl: slackSettings.eventsPublicUrl })
        .from(slackSettings);
      return row ?? null;
    },

    setEventsPublicUrl({ value, audit }) {
      return db.transaction(async (tx) => {
        // The row first, so two saves queue on its lock and each receipt
        // names the address it replaced.
        await tx.insert(slackSettings).values({}).onConflictDoNothing();
        const [row] = await tx
          .select({ eventsPublicUrl: slackSettings.eventsPublicUrl })
          .from(slackSettings)
          .for("update");
        const previous = row?.eventsPublicUrl ?? null;
        if (previous === value) return { changed: false };
        await tx
          .update(slackSettings)
          .set({ eventsPublicUrl: value, updatedAt: DB_NOW });
        await tx.insert(receipts).values({
          id: audit.receiptId,
          ownerId: audit.workspaceId,
          operation: "update_slack_settings",
          targetRef: {
            resource: { kind: "workspace", id: audit.workspaceId },
            workspace_id: audit.workspaceId,
          },
          status: "succeeded",
          result: { events_public_url: value, previous },
          actor: {
            principal: { kind: "user", id: audit.userId },
            actor_user_id: audit.userId,
            agent_id: null,
          },
        });
        return { changed: true };
      });
    },

    importEventsPublicUrl(value) {
      return db.transaction(async (tx) => {
        // Every replica tries at start; only the first one's insert lands.
        const inserted = await tx
          .insert(slackSettings)
          .values({ eventsPublicUrl: value })
          .onConflictDoNothing()
          .returning({ id: slackSettings.id });
        if (inserted.length === 0) return false;
        // Before the first workspace there is nothing to keep a receipt under.
        const workspaceId = await secretOwnerWorkspace(tx);
        if (workspaceId !== null) {
          await tx.insert(receipts).values({
            id: randomUUID(),
            ownerId: workspaceId,
            operation: "update_slack_settings",
            targetRef: {
              resource: { kind: "workspace", id: workspaceId },
              workspace_id: workspaceId,
            },
            status: "succeeded",
            result: {
              events_public_url: value,
              previous: null,
              by: "env_import",
            },
          });
        }
        return true;
      });
    },
  };
}
