import { randomUUID } from "node:crypto";
import { DB_NOW } from "../db-clock.ts";
import { secretOwnerWorkspace } from "../installation-settings.ts";
import type { Database } from "../queries.ts";
import { githubWebhookSettings, receipts } from "../schema.ts";

/** The owner saving the address, and the receipt it leaves. */
export type GitHubWebhookSettingsAudit = {
  userId: string;
  workspaceId: string;
  receiptId: string;
};

/**
 * The installation's GitHub webhook entrance: one row, absent until an owner
 * saves one or a start carries the old GITHUB_WEBHOOK_BASE_URL in.
 */
export interface GitHubWebhookSettingsStore {
  /** Null while there is no row: nothing was ever saved or carried in. */
  read(): Promise<{ publicUrl: string | null } | null>;
  /**
   * Saving null leaves the row, so a later start carries nothing in. The
   * receipt is written only when the saved address changes.
   */
  setPublicUrl(input: {
    value: string | null;
    audit: GitHubWebhookSettingsAudit;
  }): Promise<{ changed: boolean }>;
  /**
   * Keeps the value only while there is no row; true when it did. Its
   * receipt has no actor: nobody in the console made the change.
   */
  importPublicUrl(value: string): Promise<boolean>;
}

const OPERATION = "update_github_webhook_settings";

export function createPostgresGitHubWebhookSettingsStore(
  db: Database,
): GitHubWebhookSettingsStore {
  return {
    async read() {
      const [row] = await db
        .select({ publicUrl: githubWebhookSettings.publicUrl })
        .from(githubWebhookSettings);
      return row ?? null;
    },

    setPublicUrl({ value, audit }) {
      return db.transaction(async (tx) => {
        // The row first, so two saves queue on its lock and each receipt
        // names the address it replaced.
        await tx.insert(githubWebhookSettings).values({}).onConflictDoNothing();
        const [row] = await tx
          .select({ publicUrl: githubWebhookSettings.publicUrl })
          .from(githubWebhookSettings)
          .for("update");
        const previous = row?.publicUrl ?? null;
        if (previous === value) return { changed: false };
        await tx
          .update(githubWebhookSettings)
          .set({ publicUrl: value, updatedAt: DB_NOW });
        await tx.insert(receipts).values({
          id: audit.receiptId,
          ownerId: audit.workspaceId,
          operation: OPERATION,
          targetRef: {
            resource: { kind: "workspace", id: audit.workspaceId },
            workspace_id: audit.workspaceId,
          },
          status: "succeeded",
          result: { webhook_public_url: value, previous },
          actor: {
            principal: { kind: "user", id: audit.userId },
            actor_user_id: audit.userId,
            agent_id: null,
          },
        });
        return { changed: true };
      });
    },

    importPublicUrl(value) {
      return db.transaction(async (tx) => {
        // Every replica tries at start; only the first one's insert lands.
        const inserted = await tx
          .insert(githubWebhookSettings)
          .values({ publicUrl: value })
          .onConflictDoNothing()
          .returning({ id: githubWebhookSettings.id });
        if (inserted.length === 0) return false;
        // Before the first workspace there is nothing to keep a receipt under.
        const workspaceId = await secretOwnerWorkspace(tx);
        if (workspaceId !== null) {
          await tx.insert(receipts).values({
            id: randomUUID(),
            ownerId: workspaceId,
            operation: OPERATION,
            targetRef: {
              resource: { kind: "workspace", id: workspaceId },
              workspace_id: workspaceId,
            },
            status: "succeeded",
            result: {
              webhook_public_url: value,
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
