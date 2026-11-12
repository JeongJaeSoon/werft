import { randomUUID } from "node:crypto";
import type { SecretKey } from "@werft-ai/platform";
import { DB_NOW } from "../db-clock.ts";
import { secretOwnerWorkspace } from "../installation-settings.ts";
import {
  LOGIN_CLIENT_SECRET_PURPOSE,
  loginProviderSecretOwner,
} from "../musterrolle/login-providers.ts";
import type { Database } from "../queries.ts";
import { loginProviders } from "../schema.ts";
import { writeSecretInTx } from "../secrets/secret-values.ts";

/**
 * A login provider row as the admin API will leave one that is set up and
 * turned on. Until that API exists this is how a test gets a provider.
 * With `secret`, the client secret is stored too; that needs a workspace.
 */
export async function seedLoginProvider(
  db: Database,
  values: Partial<typeof loginProviders.$inferInsert> & { issuer: string },
  secret?: { key: SecretKey; value: string },
): Promise<typeof loginProviders.$inferSelect> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(loginProviders)
      .values({
        id: randomUUID(),
        displayName: "Test provider",
        authorizationEndpoint: `${values.issuer}/authorize`,
        tokenEndpoint: `${values.issuer}/token`,
        jwksUri: `${values.issuer}/jwks`,
        signingAlgs: ["RS256"],
        issParameterRequired: false,
        pkceAdvertised: true,
        discoveryCheckedAt: DB_NOW,
        clientId: "test-client",
        tokenAuthMethod: "client_secret_basic",
        enabled: true,
        ...values,
      })
      .returning();
    if (!row) throw new Error("login provider insert returned no row");
    if (secret) {
      const workspaceId = await secretOwnerWorkspace(tx);
      if (workspaceId === null) {
        throw new Error("a stored client secret needs a workspace");
      }
      await writeSecretInTx(
        tx,
        secret.key,
        {
          workspaceId,
          owner: loginProviderSecretOwner(row.id),
          purpose: LOGIN_CLIENT_SECRET_PURPOSE,
        },
        secret.value,
        null,
      );
    }
    return row;
  });
}
