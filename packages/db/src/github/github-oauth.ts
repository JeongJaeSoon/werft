import {
  type GitHubOAuthClient,
  type GitHubOAuthStore,
  receiptActorOf,
  type SecretKey,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { githubWorkspaceSettings, receipts, workspaces } from "../schema.ts";
import {
  createPostgresSecretStore,
  secretAuditRefusal,
} from "../secrets/secret-values.ts";
import {
  lockGitHubApps,
  oauthSecretSlot,
  userLinkConnection,
  writeOAuthSecret,
} from "./github-apps.ts";

/** `https://github.com/apps/<slug>` → `https://github.com`. */
function webBaseOf(htmlUrl: string): string | null {
  try {
    return new URL(htmlUrl).origin;
  } catch {
    return null;
  }
}

/** Null `key`: the API runs without a master key, so no secret is kept. */
export function createPostgresGitHubOAuthStore(
  db: Database,
  key: SecretKey | null,
): GitHubOAuthStore {
  const secrets = key === null ? null : createPostgresSecretStore(db, key);
  return {
    async status(named) {
      const workspaceId = named.toLowerCase();
      const [row, [settings]] = await Promise.all([
        userLinkConnection(db, workspaceId),
        db
          .select({ secretSet: githubWorkspaceSettings.oauthClientSecretSet })
          .from(githubWorkspaceSettings)
          .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
          .limit(1),
      ]);
      return {
        authorApp: row !== null,
        connectionId: row?.id ?? null,
        clientId: row?.clientId ?? null,
        clientSecretSet: row !== null && (settings?.secretSet ?? false),
      };
    },

    async client(named): Promise<GitHubOAuthClient | null> {
      if (secrets === null) return null;
      const row = await userLinkConnection(db, named.toLowerCase());
      if (row === null || row.clientId === null) return null;
      const webBase = webBaseOf(row.htmlUrl);
      if (webBase === null) return null;
      const clientSecret = await secrets.get(oauthSecretSlot(row));
      if (clientSecret === null) return null;
      return {
        connectionId: row.id,
        clientId: row.clientId,
        clientSecret,
        webBase,
        apiBase: row.apiBase,
      };
    },

    putClientSecret(named, clientSecret, audit, clientId) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        if (key === null) return { outcome: "no_author_app" as const };
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" as const };
        // Serialized with the App's replacement and deletion, which drop it.
        await lockGitHubApps(tx, workspaceId);
        const row = await userLinkConnection(tx, workspaceId);
        if (row === null) return { outcome: "no_author_app" as const };
        if (row.clientId !== clientId) {
          return { outcome: "client_changed" as const };
        }
        await writeOAuthSecret(tx, key, row, clientSecret, audit);
        await tx.insert(receipts).values({
          id: audit.receiptId,
          ownerId: workspaceId,
          actor: receiptActorOf(audit.principal),
          operation: "set_github_app",
          targetRef: {
            resource: { kind: "workspace", id: workspaceId },
            workspace_id: workspaceId,
          },
          status: "succeeded",
          result: {
            app_id: row.appId,
            connection_id: row.id,
            role: "author",
            purpose: "oauth_client_secret",
            last4: clientSecret.slice(-4),
          },
        });
        return { outcome: "stored" as const };
      });
    },
  };
}
