import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { DB_NOW } from "./db-clock.ts";
import { secretOwnerWorkspace } from "./installation-settings.ts";
import type { Database } from "./queries.ts";
import { installationConfig, receipts } from "./schema.ts";

/** The owner saving the settings, and the receipt it leaves. */
export type InstallationConfigAudit = {
  userId: string;
  workspaceId: string;
  receiptId: string;
};

/**
 * Saved installation settings by key. Values are what the caller checked
 * against the key's rule; a key with no row has none saved.
 */
export interface InstallationConfigStore {
  readAll(): Promise<Record<string, unknown>>;
  /**
   * One transaction for every key. The receipt names only the keys whose
   * value changed, with what each replaced.
   */
  setValues(input: {
    values: Record<string, unknown>;
    audit: InstallationConfigAudit;
  }): Promise<{ changed: boolean }>;
  /**
   * Keeps the value only while the key has no row; true when it did. Its
   * receipt has no actor: nobody in the console made the change.
   */
  importValue(key: string, value: unknown): Promise<boolean>;
}

const OPERATION = "update_installation_config";

export function createPostgresInstallationConfigStore(
  db: Database,
): InstallationConfigStore {
  return {
    async readAll() {
      const rows = await db
        .select({
          key: installationConfig.key,
          value: installationConfig.value,
        })
        .from(installationConfig);
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },

    setValues({ values, audit }) {
      const keys = Object.keys(values).sort();
      if (keys.length === 0) return Promise.resolve({ changed: false });
      return db.transaction(async (tx) => {
        // Saves queue here, so each receipt names the values it replaced;
        // an absent row has nothing to lock.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('installation_config'))`,
        );
        const rows = await tx
          .select({
            key: installationConfig.key,
            value: installationConfig.value,
          })
          .from(installationConfig)
          .where(inArray(installationConfig.key, keys));
        const before = new Map(rows.map((row) => [row.key, row.value]));
        const changedKeys = keys.filter(
          (key) =>
            !before.has(key) ||
            JSON.stringify(before.get(key)) !== JSON.stringify(values[key]),
        );
        if (changedKeys.length === 0) return { changed: false };
        for (const key of changedKeys) {
          await tx
            .insert(installationConfig)
            .values({ key, value: values[key] })
            .onConflictDoUpdate({
              target: installationConfig.key,
              set: { value: values[key], updatedAt: DB_NOW },
            });
        }
        await tx.insert(receipts).values({
          id: audit.receiptId,
          ownerId: audit.workspaceId,
          operation: OPERATION,
          targetRef: {
            resource: { kind: "workspace", id: audit.workspaceId },
            workspace_id: audit.workspaceId,
          },
          status: "succeeded",
          result: {
            values: Object.fromEntries(changedKeys.map((k) => [k, values[k]])),
            previous: Object.fromEntries(
              changedKeys.map((k) => [k, before.get(k) ?? null]),
            ),
          },
          actor: {
            principal: { kind: "user", id: audit.userId },
            actor_user_id: audit.userId,
            agent_id: null,
          },
        });
        return { changed: true };
      });
    },

    importValue(key, value) {
      return db.transaction(async (tx) => {
        // Queued with saves, so a save never records `previous` as nothing
        // while this insert lands under it.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('installation_config'))`,
        );
        // Every reading process tries at start; only the first insert lands.
        const inserted = await tx
          .insert(installationConfig)
          .values({ key, value })
          .onConflictDoNothing()
          .returning({ key: installationConfig.key });
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
              values: { [key]: value },
              previous: { [key]: null },
              by: "env_import",
            },
          });
        }
        return true;
      });
    },
  };
}
