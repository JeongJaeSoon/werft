import { githubAppPermissionsSchema } from "@werft-ai/contracts";
import type {
  GitHubAppInstallationView,
  GitHubInstallationStore,
} from "@werft-ai/platform";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import {
  githubApps,
  githubInstallationLinks,
  githubInstallationSnapshots,
  githubInstallationStates,
  users,
} from "../schema.ts";

const isDateOrNull = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" && !Number.isNaN(Date.parse(value)));

const dateOrNull = (value: string | null) =>
  value === null ? null : new Date(value);

function installationOf(stored: unknown): GitHubAppInstallationView | null {
  if (typeof stored !== "object" || stored === null) return null;
  const row = stored as Record<string, unknown>;
  const permissions = githubAppPermissionsSchema.safeParse(row.permissions);
  if (
    !Number.isSafeInteger(row.id) ||
    typeof row.account !== "string" ||
    (row.accountType !== "organization" && row.accountType !== "user") ||
    !(row.accountId === null || Number.isSafeInteger(row.accountId)) ||
    (row.repositorySelection !== "all" &&
      row.repositorySelection !== "selected") ||
    !(row.htmlUrl === null || typeof row.htmlUrl === "string") ||
    !permissions.success ||
    !isDateOrNull(row.createdAt) ||
    !isDateOrNull(row.suspendedAt)
  ) {
    return null;
  }
  return {
    id: row.id as number,
    account: row.account,
    accountType: row.accountType,
    accountId: row.accountId as number | null,
    repositorySelection: row.repositorySelection,
    htmlUrl: row.htmlUrl,
    permissions: permissions.data,
    createdAt: dateOrNull(row.createdAt),
    suspendedAt: dateOrNull(row.suspendedAt),
  };
}

function installationsOf(stored: unknown): GitHubAppInstallationView[] | null {
  if (!Array.isArray(stored)) return null;
  const installations = stored.map(installationOf);
  return installations.every((installation) => installation !== null)
    ? installations
    : null;
}

export function createPostgresGitHubInstallationStore(
  db: Database,
): GitHubInstallationStore {
  return {
    async recordSnapshot(connectionId, appId, snapshot) {
      const installations = snapshot.installations.map((installation) => ({
        ...installation,
        createdAt: installation.createdAt?.toISOString() ?? null,
        suspendedAt: installation.suspendedAt?.toISOString() ?? null,
      }));
      await db.execute(sql`
        INSERT INTO ${githubInstallationSnapshots}
          (connection_id, app_id, installations, read_at)
        SELECT ${githubApps.id}, ${githubApps.appId},
          ${JSON.stringify(installations)}::jsonb, ${snapshot.readAt}
        FROM ${githubApps}
        WHERE ${githubApps.id} = ${connectionId} AND ${githubApps.appId} = ${appId}
        ON CONFLICT (connection_id) DO UPDATE
          SET app_id = EXCLUDED.app_id,
            installations = EXCLUDED.installations,
            read_at = EXCLUDED.read_at
          WHERE ${githubInstallationSnapshots.readAt} <= EXCLUDED.read_at
            OR ${githubInstallationSnapshots.appId} <> EXCLUDED.app_id`);
    },

    async snapshot(connectionId, appId) {
      const [row] = await db
        .select()
        .from(githubInstallationSnapshots)
        .where(
          and(
            eq(githubInstallationSnapshots.connectionId, connectionId),
            eq(githubInstallationSnapshots.appId, appId),
          ),
        );
      if (!row) return null;
      const installations = installationsOf(row.installations);
      return installations === null
        ? null
        : { installations, readAt: row.readAt };
    },

    async issueState(stateHash, state, now) {
      await db
        .delete(githubInstallationStates)
        .where(lt(githubInstallationStates.expiresAt, now));
      await db.insert(githubInstallationStates).values({
        stateHash,
        workspaceId: state.workspaceId,
        connectionId: state.connectionId,
        appId: state.appId,
        actorUserId: state.actorUserId,
        createdAt: state.createdAt,
        expiresAt: state.expiresAt,
      });
    },

    async consumeState(stateHash) {
      const [row] = await db
        .delete(githubInstallationStates)
        .where(eq(githubInstallationStates.stateHash, stateHash))
        .returning();
      if (!row) return null;
      return {
        workspaceId: row.workspaceId,
        connectionId: row.connectionId,
        appId: row.appId,
        actorUserId: row.actorUserId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
    },

    async recordLink(input) {
      const { rows } = (await db.execute(sql`
        INSERT INTO ${githubInstallationLinks}
          (connection_id, installation_id, app_id, workspace_id, connected_by)
        SELECT ${githubApps.id}, ${input.installationId}, ${githubApps.appId},
          ${githubApps.workspaceId}, ${input.connectedBy}
        FROM ${githubApps}
        WHERE ${githubApps.id} = ${input.connectionId}
          AND ${githubApps.workspaceId} = ${input.workspaceId}
          AND ${githubApps.appId} = ${input.appId}
        ON CONFLICT (connection_id, installation_id) DO NOTHING
        RETURNING installation_id`)) as unknown as { rows: unknown[] };
      return rows.length === 1;
    },

    async links(workspaceId) {
      const rows = await db
        .select({
          connectionId: githubInstallationLinks.connectionId,
          installationId: githubInstallationLinks.installationId,
          connectedBy: githubInstallationLinks.connectedBy,
          displayName: users.displayName,
          connectedAt: githubInstallationLinks.connectedAt,
        })
        .from(githubInstallationLinks)
        .innerJoin(
          githubApps,
          and(
            eq(githubApps.id, githubInstallationLinks.connectionId),
            eq(githubApps.appId, githubInstallationLinks.appId),
          ),
        )
        .leftJoin(users, eq(users.id, githubInstallationLinks.connectedBy))
        .where(eq(githubInstallationLinks.workspaceId, workspaceId));
      return rows.map((row) => ({
        connectionId: row.connectionId,
        installationId: row.installationId,
        connectedBy:
          row.displayName === null
            ? null
            : { userId: row.connectedBy, displayName: row.displayName },
        connectedAt: row.connectedAt,
      }));
    },
  };
}
