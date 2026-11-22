import { randomUUID } from "node:crypto";
import {
  GITHUB_CEILING_NONE,
  type GitHubAppPermissions,
  type GitHubAppRole,
  type GitHubAppUsage,
  githubAppPermissionsSchema,
  githubAppWarnings,
} from "@werft-ai/contracts";
import {
  type GitHubAppCredential,
  type GitHubAppRecord,
  type GitHubAppStore,
  type SecretAudit,
  SecretDecryptError,
  type SecretKey,
  type SecretSlot,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  agents,
  catalogRepositoryGitHubApps,
  githubApps,
  githubInstallationLinks,
  githubInstallationSnapshots,
  githubInstallationStates,
  githubWorkspaceSettings,
  receipts,
  sessions,
  workspaces,
} from "../schema.ts";
import {
  createPostgresSecretStore,
  deleteSecretInTx,
  describeSecret,
  secretAuditRefusal,
  writeSecretInTx,
} from "../secrets/index.ts";
import { deletedBy, notDeleted } from "../soft-delete.ts";
import { workspaceReceiptRow } from "../succeeded-receipt.ts";
import { ensureRepositoryCeilingWhenUnset } from "./github-settings.ts";

type Row = typeof githubApps.$inferSelect;

const keySlot = (row: Pick<Row, "id" | "workspaceId">): SecretSlot => ({
  workspaceId: row.workspaceId,
  owner: { kind: "github_app", id: row.id },
  purpose: "github_app_private_key",
});

export const oauthSecretSlot = (
  row: Pick<Row, "id" | "workspaceId">,
): SecretSlot => ({
  workspaceId: row.workspaceId,
  owner: { kind: "github_app", id: row.id },
  purpose: "github_oauth_client_secret",
});

const webhookSlot = (row: Pick<Row, "id" | "workspaceId">): SecretSlot => ({
  workspaceId: row.workspaceId,
  owner: { kind: "github_app", id: row.id },
  purpose: "github_app_webhook_secret",
});

/**
 * With none chosen, the only author connection: an earlier image registers
 * the first without choosing it.
 */
export async function userLinkConnection(
  db: Database,
  workspaceId: string,
): Promise<Row | null> {
  const [settings] = await db
    .select({ chosen: githubWorkspaceSettings.userLinkConnectionId })
    .from(githubWorkspaceSettings)
    .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const authors = await db
    .select()
    .from(githubApps)
    .where(ofRole(workspaceId, "author"));
  const chosen = settings?.chosen ?? null;
  if (chosen !== null) {
    return authors.find((row) => row.id === chosen) ?? null;
  }
  return authors.length === 1 ? (authors[0] ?? null) : null;
}

async function dropOAuthSecret(
  tx: Database,
  row: Pick<Row, "id" | "workspaceId">,
) {
  await deleteSecretInTx(tx, oauthSecretSlot(row));
  await tx
    .update(githubWorkspaceSettings)
    .set({ oauthClientSecretSet: false, updatedAt: DB_NOW })
    .where(eq(githubWorkspaceSettings.workspaceId, row.workspaceId));
}

async function chooseUserLink(
  tx: Database,
  workspaceId: string,
  connectionId: string | null,
  updatedBy: string | null,
) {
  await tx
    .insert(githubWorkspaceSettings)
    .values({
      workspaceId,
      ceiling: GITHUB_CEILING_NONE,
      revision: 0,
      userLinkConnectionId: connectionId,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: githubWorkspaceSettings.workspaceId,
      set: { userLinkConnectionId: connectionId, updatedAt: DB_NOW },
    });
}

export async function writeOAuthSecret(
  tx: Database,
  key: SecretKey,
  row: Pick<Row, "id" | "workspaceId">,
  clientSecret: string,
  audit: SecretAudit,
) {
  const updatedBy = audit.principal.actor?.userId ?? null;
  await writeSecretInTx(tx, key, oauthSecretSlot(row), clientSecret, updatedBy);
  // `revision` is the ceiling's compare-and-set, which this leaves be: a row
  // made here reads as the never-saved ceiling, revision 0.
  await tx
    .insert(githubWorkspaceSettings)
    .values({
      workspaceId: row.workspaceId,
      ceiling: GITHUB_CEILING_NONE,
      oauthClientSecretSet: true,
      revision: 0,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: githubWorkspaceSettings.workspaceId,
      set: { oauthClientSecretSet: true, updatedAt: DB_NOW },
    });
}

const appResult = (
  row: Pick<Row, "id" | "appId">,
  role: GitHubAppRole,
  permissions?: GitHubAppPermissions,
) => ({
  app_id: row.appId,
  connection_id: row.id,
  role,
  ...(permissions === undefined
    ? {}
    : { permissions, warnings: githubAppWarnings(role, permissions) }),
});

const ofWorkspace = (workspaceId: string) =>
  and(eq(githubApps.workspaceId, workspaceId), notDeleted(githubApps));

const byId = (workspaceId: string, connectionId: string) =>
  and(ofWorkspace(workspaceId), eq(githubApps.id, connectionId.toLowerCase()));

const ofRole = (workspaceId: string, role: GitHubAppRole) =>
  and(ofWorkspace(workspaceId), eq(githubApps.role, role));

export async function lockGitHubApps(tx: Database, workspaceId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`github_apps:${workspaceId}`}))`,
  );
}

function permissionsOf(stored: unknown): GitHubAppPermissions | null {
  const parsed = githubAppPermissionsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

// A row is written with its key in one transaction, so a row without one is
// a delete that committed between the two reads.
async function recordOf(
  db: Database,
  row: Row,
): Promise<(GitHubAppRecord & { role: GitHubAppRole }) | null> {
  const key = await describeSecret(db, keySlot(row));
  if (key === null) return null;
  const webhook = await describeSecret(db, webhookSlot(row));
  return {
    id: row.id,
    role: row.role,
    workspaceId: row.workspaceId,
    appId: row.appId,
    slug: row.slug,
    name: row.name,
    htmlUrl: row.htmlUrl,
    permissions: permissionsOf(row.permissions),
    permissionsCheckedAt: row.permissionsCheckedAt,
    clientId: row.clientId,
    apiBase: row.apiBase,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    privateKey: { updatedAt: key.updatedAt, updatedBy: key.updatedBy },
    webhookSecretSet: webhook !== null,
  };
}

const ENDED_SESSION_STATUSES = ["failed", "stopped"] as const;

async function usageOf(
  db: Database,
  row: Pick<Row, "id" | "workspaceId" | "role">,
  userLink: boolean,
): Promise<GitHubAppUsage> {
  const pinned = (
    await db
      .select({ id: catalogRepositoryGitHubApps.repositoryId })
      .from(catalogRepositoryGitHubApps)
      .where(
        and(
          eq(catalogRepositoryGitHubApps.connectionId, row.id),
          eq(catalogRepositoryGitHubApps.role, row.role),
        ),
      )
  ).map(({ id }) => id);
  if (pinned.length === 0) {
    return {
      pinned_repository_count: 0,
      agent_count: 0,
      active_session_count: 0,
      user_link: userLink,
    };
  }
  const names = sql`(${agentReleases.policyPins} -> 'github' -> 'repositories') ?| ARRAY[${sql.join(
    pinned.map((id) => sql`${id}`),
    sql`, `,
  )}]::text[]`;
  const [agentRow] = await db
    .select({ count: sql<number>`count(DISTINCT ${agents.id})::int` })
    .from(agents)
    .innerJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
    .where(
      and(
        eq(agents.workspaceId, row.workspaceId),
        notDeleted(agents),
        eq(agents.githubEnabled, true),
        names,
        row.role === "reviewer"
          ? sql`${agentReleases.policyPins} #>> '{github,features,review}' = 'true'`
          : undefined,
      ),
    );
  const [sessionRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(
        eq(sessions.ownerId, row.workspaceId),
        inArray(sessions.repositoryId, pinned),
        notInArray(sessions.status, [...ENDED_SESSION_STATUSES]),
      ),
    );
  return {
    pinned_repository_count: pinned.length,
    agent_count: agentRow?.count ?? 0,
    active_session_count: sessionRow?.count ?? 0,
    user_link: userLink,
  };
}

export function createPostgresGitHubAppStore(
  db: Database,
  key: SecretKey,
): GitHubAppStore {
  const secrets = createPostgresSecretStore(db, key);
  return {
    async ofRole(named, role) {
      const rows = await db
        .select()
        .from(githubApps)
        .where(ofRole(named.toLowerCase(), role))
        .orderBy(asc(githubApps.createdAt), asc(githubApps.id));
      const records = await Promise.all(rows.map((row) => recordOf(db, row)));
      return records.filter((record) => record !== null);
    },

    async get(named, connectionId) {
      const [row] = await db
        .select()
        .from(githubApps)
        .where(byId(named.toLowerCase(), connectionId));
      return row ? recordOf(db, row) : null;
    },

    async list(workspaceId) {
      const rows = await db
        .select()
        .from(githubApps)
        .where(ofWorkspace(workspaceId.toLowerCase()))
        .orderBy(githubApps.role, githubApps.createdAt, githubApps.id);
      const records = await Promise.all(rows.map((row) => recordOf(db, row)));
      return records.filter((record) => record !== null);
    },

    put(named, target, app, privateKey, audit, manifest) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" };
        await lockGitHubApps(tx, workspaceId);
        const rows = await tx
          .select()
          .from(githubApps)
          .where(ofWorkspace(workspaceId))
          .orderBy(asc(githubApps.createdAt), asc(githubApps.id));
        let current: Row | undefined;
        let role: GitHubAppRole;
        if (target.kind === "connection") {
          current = rows.find((row) => row.id === target.id.toLowerCase());
          if (current === undefined) return { outcome: "not_found" };
          if (current.appId !== app.appId)
            return { outcome: "app_id_mismatch" };
          role = current.role;
        } else {
          role = target.role;
          if (target.kind === "role") {
            const held = rows.filter((row) => row.role === role);
            if (held.length > 1) return { outcome: "ambiguous_role" };
            current = held[0];
          }
        }
        const authors = rows.filter((row) => row.role === "author");
        if (role === "reviewer" && authors.length === 0) {
          return { outcome: "no_author_app" };
        }
        // Any other connection, whatever its role: an approval from the App
        // that opened the pull request is refused by GitHub, and the same
        // App twice is one row (UNIQUE (workspace_id, app_id)).
        if (rows.some((row) => row !== current && row.appId === app.appId)) {
          return { outcome: "same_app" };
        }
        const userId = audit.principal.actor?.userId ?? null;
        const link = await userLinkConnection(tx, workspaceId);
        const fields = {
          appId: app.appId,
          slug: app.slug,
          name: app.name,
          htmlUrl: app.htmlUrl,
          apiBase: app.apiBase,
          permissions: app.permissions,
          permissionsCheckedAt: DB_NOW,
          clientId: app.clientId,
        };
        let pinsCleared = 0;
        if (current && current.appId !== app.appId) {
          // The row keeps its id; a pin must not move to another App without
          // a receipt saying so.
          pinsCleared = (
            await tx
              .delete(catalogRepositoryGitHubApps)
              .where(
                and(
                  eq(catalogRepositoryGitHubApps.connectionId, current.id),
                  eq(catalogRepositoryGitHubApps.role, role),
                ),
              )
              .returning({ id: catalogRepositoryGitHubApps.repositoryId })
          ).length;
          if (link?.id === current.id) await dropOAuthSecret(tx, current);
          // Another App signs its deliveries with a secret of its own.
          await deleteSecretInTx(tx, webhookSlot(current));
        }
        const [row] = current
          ? await tx
              .update(githubApps)
              .set({ ...fields, updatedAt: DB_NOW })
              .where(eq(githubApps.id, current.id))
              .returning()
          : await tx
              .insert(githubApps)
              .values({
                id: randomUUID(),
                workspaceId,
                role,
                createdBy: userId,
                ...fields,
              })
              .returning();
        if (!row) throw new Error("GitHub App write returned no row");
        await writeSecretInTx(tx, key, keySlot(row), privateKey, userId);
        const pinsRestored =
          current?.appId === app.appId
            ? 0
            : (
                await tx
                  .update(catalogRepositoryGitHubApps)
                  .set({ connectionId: row.id, updatedAt: DB_NOW })
                  .where(
                    and(
                      isNull(catalogRepositoryGitHubApps.connectionId),
                      eq(catalogRepositoryGitHubApps.appId, app.appId),
                      eq(catalogRepositoryGitHubApps.role, role),
                    ),
                  )
                  .returning({ id: catalogRepositoryGitHubApps.repositoryId })
              ).length;
        // Writes down a first author connection an earlier image left
        // unchosen, so adding a second keeps the link on it.
        let linked = link?.id === row.id;
        if (role === "author" && current === undefined) {
          const chosen = link?.id ?? (authors.length === 0 ? row.id : null);
          if (chosen !== null) {
            await chooseUserLink(tx, workspaceId, chosen, userId);
            linked = chosen === row.id;
          }
        }
        if (manifest !== undefined && linked) {
          await writeOAuthSecret(tx, key, row, manifest.clientSecret, audit);
        }
        if (manifest?.webhookSecret) {
          await writeSecretInTx(
            tx,
            key,
            webhookSlot(row),
            manifest.webhookSecret,
            userId,
          );
        }
        // Registering the console App is a workspace's first use of GitHub:
        // write the default repository ceiling if none is there (design 3.2).
        await ensureRepositoryCeilingWhenUnset(tx, workspaceId);
        await tx.insert(receipts).values(
          workspaceReceiptRow(audit, workspaceId, "set_github_app", {
            ...appResult(row, role, app.permissions),
            ...(target.kind === "connection" ? { purpose: "private_key" } : {}),
            ...(pinsCleared > 0 ? { pins_cleared: pinsCleared } : {}),
            ...(pinsRestored > 0 ? { pins_restored: pinsRestored } : {}),
            ...(manifest === undefined
              ? {}
              : {
                  source: "manifest",
                  owner: manifest.owner,
                  public: manifest.public,
                }),
          }),
        );
        const stored = await recordOf(tx, row);
        if (stored === null) throw new Error("GitHub App key was not written");
        return { outcome: "stored", app: stored, pinsCleared, pinsRestored };
      });
    },

    delete(named, target, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        await lockGitHubApps(tx, workspaceId);
        const held = await tx
          .select()
          .from(githubApps)
          .where(
            target.kind === "role"
              ? ofRole(workspaceId, target.role)
              : byId(workspaceId, target.id),
          );
        if (held.length > 1) return { outcome: "ambiguous_role" };
        const [row] = held;
        if (!row) return { outcome: "not_found" };
        const link = await userLinkConnection(tx, workspaceId);
        const linked = link?.id === row.id;
        if (linked) {
          const [other] = await tx
            .select({ id: githubApps.id })
            .from(githubApps)
            .where(
              and(ofRole(workspaceId, "author"), ne(githubApps.id, row.id)),
            )
            .limit(1);
          if (other) return { outcome: "in_use_for_user_link" };
        }
        const usage = await usageOf(tx, row, linked);
        if (linked) {
          await dropOAuthSecret(tx, row);
          await chooseUserLink(tx, workspaceId, null, null);
        }
        // What the foreign keys' cascade and set null did for a hard delete.
        await tx
          .delete(githubInstallationSnapshots)
          .where(eq(githubInstallationSnapshots.connectionId, row.id));
        await tx
          .delete(githubInstallationStates)
          .where(eq(githubInstallationStates.connectionId, row.id));
        await tx
          .delete(githubInstallationLinks)
          .where(eq(githubInstallationLinks.connectionId, row.id));
        await tx
          .update(catalogRepositoryGitHubApps)
          .set({ connectionId: null })
          .where(eq(catalogRepositoryGitHubApps.connectionId, row.id));
        await tx
          .update(githubApps)
          .set(deletedBy(audit.principal.actor?.userId))
          .where(eq(githubApps.id, row.id));
        await deleteSecretInTx(tx, keySlot(row));
        await deleteSecretInTx(tx, oauthSecretSlot(row));
        await deleteSecretInTx(tx, webhookSlot(row));
        await tx.insert(receipts).values(
          workspaceReceiptRow(audit, workspaceId, "delete_github_app", {
            ...appResult(row, row.role),
            ...usage,
          }),
        );
        return { outcome: "deleted", appId: row.appId, usage };
      });
    },

    async usage(named, connectionId) {
      const workspaceId = named.toLowerCase();
      const [row] = await db
        .select()
        .from(githubApps)
        .where(byId(workspaceId, connectionId));
      if (!row) return null;
      const link = await userLinkConnection(db, workspaceId);
      return usageOf(db, row, link?.id === row.id);
    },

    setUserLink(named, connectionId, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" };
        await lockGitHubApps(tx, workspaceId);
        const [row] = await tx
          .select()
          .from(githubApps)
          .where(byId(workspaceId, connectionId));
        if (!row) return { outcome: "not_found" };
        if (row.role !== "author") return { outcome: "role_mismatch" };
        const link = await userLinkConnection(tx, workspaceId);
        const before = link?.id ?? null;
        const userId = audit.principal.actor?.userId ?? null;
        if (before === row.id) {
          await chooseUserLink(tx, workspaceId, row.id, userId);
          return { outcome: "stored", before, changed: false };
        }
        // A client secret is one App's; the new one's is entered again.
        if (link !== null) await dropOAuthSecret(tx, link);
        await chooseUserLink(tx, workspaceId, row.id, userId);
        await tx.insert(receipts).values(
          workspaceReceiptRow(audit, workspaceId, "set_github_app", {
            ...appResult(row, "author"),
            purpose: "user_link",
            before,
            after: row.id,
          }),
        );
        return { outcome: "stored", before, changed: true };
      });
    },

    setWebhookSecret(named, connectionId, secret, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        await lockGitHubApps(tx, workspaceId);
        const [row] = await tx
          .select()
          .from(githubApps)
          .where(byId(workspaceId, connectionId));
        if (!row) return { outcome: "not_found" };
        await writeSecretInTx(
          tx,
          key,
          webhookSlot(row),
          secret,
          audit.principal.actor?.userId ?? null,
        );
        await tx.insert(receipts).values(
          workspaceReceiptRow(audit, workspaceId, "set_github_app", {
            ...appResult(row, row.role),
            purpose: "webhook_secret",
          }),
        );
        return { outcome: "stored", receiptId: audit.receiptId };
      });
    },

    async webhookSecrets(appId) {
      const rows = await db
        .select()
        .from(githubApps)
        .where(and(eq(githubApps.appId, appId), notDeleted(githubApps)));
      const held: Array<{
        workspaceId: string;
        connectionId: string;
        secret: string;
      }> = [];
      for (const row of rows) {
        let secret: string | null;
        try {
          secret = await secrets.get(webhookSlot(row));
        } catch (error) {
          // One workspace's unreadable secret must not refuse another's push.
          if (error instanceof SecretDecryptError) continue;
          throw error;
        }
        if (secret !== null) {
          held.push({
            workspaceId: row.workspaceId,
            connectionId: row.id,
            secret,
          });
        }
      }
      return held;
    },

    async recordPermissions(id, appId, permissions, clientId) {
      await db
        .update(githubApps)
        .set({
          permissions,
          permissionsCheckedAt: DB_NOW,
          ...(clientId === undefined ? {} : { clientId }),
        })
        .where(
          and(
            eq(githubApps.id, id),
            eq(githubApps.appId, appId),
            notDeleted(githubApps),
          ),
        );
    },

    async credentials(role, workspaceId, options) {
      const rows = await db
        .select()
        .from(githubApps)
        .where(
          workspaceId === undefined
            ? and(eq(githubApps.role, role), notDeleted(githubApps))
            : ofRole(workspaceId, role),
        )
        .orderBy(asc(githubApps.createdAt), asc(githubApps.id));
      const held: GitHubAppCredential[] = [];
      for (const row of rows) {
        let privateKey: string | null;
        try {
          privateKey = await secrets.get(keySlot(row));
        } catch (error) {
          if (
            !(error instanceof SecretDecryptError) ||
            !options?.onUnreadable
          ) {
            throw error;
          }
          options.onUnreadable({ id: row.id, appId: row.appId });
          continue;
        }
        // A row is written with its key in one transaction, so a missing key
        // is a delete racing this read.
        if (privateKey === null) continue;
        held.push({
          id: row.id,
          workspaceId: row.workspaceId,
          appId: row.appId,
          apiBase: row.apiBase,
          privateKey,
          updatedAt: row.updatedAt,
        });
      }
      return held;
    },
  };
}
