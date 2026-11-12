import {
  type LoginProvider,
  type LoginProviderStore,
  type SecretKey,
  secretOwnerRef,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import { secretOwnerWorkspace } from "../installation-settings.ts";
import type { Database } from "../queries.ts";
import { loginMethods, loginProviders, webSessions } from "../schema.ts";
import { openSecretsOf } from "../secrets/secret-values.ts";

export const LOGIN_CLIENT_SECRET_PURPOSE = "login_client_secret";

export const loginProviderSecretOwner = (id: string) =>
  ({ kind: "login_provider", id }) as const;

function providerOf(row: typeof loginProviders.$inferSelect): LoginProvider {
  return {
    id: row.id,
    displayName: row.displayName,
    issuer: row.issuer,
    authorizationEndpoint: row.authorizationEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    jwksUri: row.jwksUri,
    userinfoEndpoint: row.userinfoEndpoint,
    signingAlgs: row.signingAlgs as LoginProvider["signingAlgs"],
    issParameterRequired: row.issParameterRequired,
    clientId: row.clientId,
    tokenAuthMethod: row.tokenAuthMethod,
    allowedDomains: row.allowedDomains,
    jitRole: row.jitRole,
    requireVerifiedEmail: row.requireVerifiedEmail,
    enabled: row.enabled,
    configRevision: row.configRevision,
  };
}

/**
 * Providers are read from the database on every request and never cached,
 * so turning one off or changing it shows on every replica at once.
 */
export function createPostgresLoginProviderStore(
  db: Database,
  key: SecretKey,
): LoginProviderStore {
  return {
    listEnabled() {
      return db
        .select({
          id: loginProviders.id,
          displayName: loginProviders.displayName,
        })
        .from(loginProviders)
        .where(eq(loginProviders.enabled, true))
        .orderBy(asc(loginProviders.createdAt), asc(loginProviders.id));
    },

    async findForSignIn(id) {
      const [row] = await db
        .select()
        .from(loginProviders)
        .where(eq(loginProviders.id, id));
      if (!row) return null;
      const workspaceId = await secretOwnerWorkspace(db);
      const ownerRef = secretOwnerRef(loginProviderSecretOwner(row.id));
      const opened =
        workspaceId === null
          ? null
          : await openSecretsOf(
              db,
              key,
              workspaceId,
              LOGIN_CLIENT_SECRET_PURPOSE,
              [ownerRef],
            );
      return {
        provider: providerOf(row),
        clientSecret: opened?.get(ownerRef) ?? null,
      };
    },
  };
}

/**
 * Turns a provider off and ends every live session one of its login methods
 * made, in one transaction. Null when there is no such provider.
 *
 * A sign-in holds the provider row FOR SHARE until its session is written
 * (signInWithExternalIdentity), so this UPDATE waits for it and the
 * statement after it, with a snapshot of its own, sees that session. A
 * sign-in that comes after reads the row turned off and makes none. No order
 * of the two leaves a session of a provider that is off.
 */
export async function disableLoginProvider(
  db: Database,
  id: string,
): Promise<{ sessionsRevoked: number } | null> {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .update(loginProviders)
      .set({
        enabled: false,
        revision: sql`${loginProviders.revision} + 1`,
        updatedAt: DB_NOW,
      })
      .where(eq(loginProviders.id, id))
      .returning({ issuer: loginProviders.issuer });
    if (!provider) return null;
    const revoked = await tx
      .update(webSessions)
      .set({ revokedAt: DB_NOW })
      .where(
        and(
          isNull(webSessions.revokedAt),
          inArray(
            webSessions.loginMethodId,
            tx
              .select({ id: loginMethods.id })
              .from(loginMethods)
              .where(
                and(
                  eq(loginMethods.kind, "oidc"),
                  eq(loginMethods.issuer, provider.issuer),
                ),
              ),
          ),
        ),
      )
      .returning({ id: webSessions.id });
    return { sessionsRevoked: revoked.length };
  });
}
