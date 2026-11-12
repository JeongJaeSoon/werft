import type { ReceiptOperation } from "@werft-ai/contracts";
import {
  type LoginProvider,
  type LoginProviderAdminStore,
  type LoginProviderAudit,
  type LoginProviderEndpoints,
  type LoginProviderRecord,
  type LoginProviderSecretSlot,
  type LoginProviderSecretSummary,
  type LoginProviderStore,
  type SecretKey,
  type SecretSlot,
  secretOwnerRef,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import { secretOwnerWorkspace } from "../installation-settings.ts";
import type { Database } from "../queries.ts";
import {
  loginMethods,
  loginProviders,
  receipts,
  secretValues,
  users,
  webSessions,
} from "../schema.ts";
import {
  deleteSecretInTx,
  describeSecret,
  openSecretStamped,
  openSecretsOf,
  readSecretInTx,
  writeSecretInTx,
} from "../secrets/secret-values.ts";
import { findLiveMembership } from "./identity.ts";

export const LOGIN_CLIENT_SECRET_PURPOSE = "login_client_secret";
/** A replacement for a provider that is on, until a test sign-in passes. */
export const LOGIN_CLIENT_SECRET_NEXT_PURPOSE = "login_client_secret_next";

const PURPOSE_OF = {
  current: LOGIN_CLIENT_SECRET_PURPOSE,
  next: LOGIN_CLIENT_SECRET_NEXT_PURPOSE,
} as const satisfies Record<LoginProviderSecretSlot, string>;

export const loginProviderSecretOwner = (id: string) =>
  ({ kind: "login_provider", id }) as const;

type Row = typeof loginProviders.$inferSelect;

function providerOf(row: Row): LoginProvider {
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

const slotOf = (
  workspaceId: string,
  providerId: string,
  slot: LoginProviderSecretSlot,
): SecretSlot => ({
  workspaceId,
  owner: loginProviderSecretOwner(providerId),
  purpose: PURPOSE_OF[slot],
});

/** The stored secrets of these providers, keyed `<provider id>/<slot>`. */
async function secretSummaries(
  db: Database,
  providerIds: readonly string[],
): Promise<Map<string, LoginProviderSecretSummary>> {
  const workspaceId = await secretOwnerWorkspace(db);
  if (workspaceId === null || providerIds.length === 0) return new Map();
  const idByRef = new Map(
    providerIds.map((id) => [
      secretOwnerRef(loginProviderSecretOwner(id)) as string,
      id,
    ]),
  );
  const rows = await db
    .select({
      ownerRef: secretValues.ownerRef,
      purpose: secretValues.purpose,
      last4: secretValues.last4,
      secretVersion: secretValues.secretVersion,
      updatedAt: secretValues.updatedAt,
    })
    .from(secretValues)
    .where(
      and(
        eq(secretValues.workspaceId, workspaceId),
        inArray(
          secretValues.ownerRef,
          providerIds.map((id) => secretOwnerRef(loginProviderSecretOwner(id))),
        ),
        inArray(secretValues.purpose, Object.values(PURPOSE_OF)),
      ),
    );
  return new Map(
    rows.map((row) => [
      `${idByRef.get(row.ownerRef)}/${
        row.purpose === LOGIN_CLIENT_SECRET_PURPOSE ? "current" : "next"
      }`,
      {
        last4: row.last4,
        secretVersion: row.secretVersion,
        updatedAt: row.updatedAt,
      },
    ]),
  );
}

async function recordOf(db: Database, row: Row): Promise<LoginProviderRecord> {
  const secrets = await secretSummaries(db, [row.id]);
  return recordFrom(row, secrets);
}

function recordFrom(
  row: Row,
  secrets: Map<string, LoginProviderSecretSummary>,
): LoginProviderRecord {
  return {
    ...providerOf(row),
    pkceAdvertised: row.pkceAdvertised,
    discoveryCheckedAt: row.discoveryCheckedAt,
    testedConfigRevision: row.testedConfigRevision,
    testedAt: row.testedAt,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    clientSecret: secrets.get(`${row.id}/current`) ?? null,
    pendingClientSecret: secrets.get(`${row.id}/next`) ?? null,
  };
}

/** The provider row under the lock every change to it takes (design 5.6). */
async function lockedProvider(tx: Database, id: string): Promise<Row | null> {
  const [row] = await tx
    .select()
    .from(loginProviders)
    .where(eq(loginProviders.id, id))
    .for("update");
  return row ?? null;
}

async function writeReceipt(
  tx: Database,
  audit: LoginProviderAudit,
  operation: ReceiptOperation,
  providerId: string,
  result: Record<string, unknown>,
): Promise<void> {
  await tx.insert(receipts).values({
    id: audit.receiptId,
    ownerId: audit.workspaceId,
    operation,
    targetRef: {
      resource: { kind: "workspace", id: audit.workspaceId },
      workspace_id: audit.workspaceId,
    },
    status: "succeeded",
    result: { provider_id: providerId, ...result },
    actor: {
      principal: { kind: "user", id: audit.userId },
      actor_user_id: audit.userId,
      agent_id: null,
    },
  });
}

const endpointColumns = (endpoints: LoginProviderEndpoints) => ({
  authorizationEndpoint: endpoints.authorizationEndpoint,
  tokenEndpoint: endpoints.tokenEndpoint,
  jwksUri: endpoints.jwksUri,
  userinfoEndpoint: endpoints.userinfoEndpoint,
  signingAlgs: endpoints.signingAlgs,
  issParameterRequired: endpoints.issParameterRequired,
  pkceAdvertised: endpoints.pkceAdvertised,
  discoveryCheckedAt: DB_NOW,
});

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Turns the provider off and ends every live session one of its login
 * methods made, inside the caller's transaction. Null when there is no such
 * provider.
 *
 * A sign-in holds the provider row FOR SHARE until its session is written
 * (signInWithExternalIdentity), so this UPDATE waits for it and the
 * statement after it, with a snapshot of its own, sees that session. A
 * sign-in that comes after reads the row turned off and makes none. No order
 * of the two leaves a session of a provider that is off.
 */
async function turnOff(
  tx: Database,
  id: string,
): Promise<{ row: Row; sessionsRevoked: number } | null> {
  const [row] = await tx
    .update(loginProviders)
    .set({
      enabled: false,
      revision: sql`${loginProviders.revision} + 1`,
      updatedAt: DB_NOW,
    })
    .where(eq(loginProviders.id, id))
    .returning();
  if (!row) return null;
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
                eq(loginMethods.issuer, row.issuer),
              ),
            ),
        ),
      ),
    )
    .returning({ id: webSessions.id });
  // A replacement that never passed a test is not kept for a later turn-on.
  const workspaceId = await secretOwnerWorkspace(tx);
  if (workspaceId !== null) {
    await deleteSecretInTx(tx, slotOf(workspaceId, id, "next"));
  }
  return { row, sessionsRevoked: revoked.length };
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

/** disableLoginProvider with no receipt: for a caller that is not a person. */
export async function disableLoginProvider(
  db: Database,
  id: string,
): Promise<{ sessionsRevoked: number } | null> {
  return db.transaction(async (tx) => {
    const off = await turnOff(tx, id);
    return off && { sessionsRevoked: off.sessionsRevoked };
  });
}

export function createPostgresLoginProviderAdminStore(
  db: Database,
  key: SecretKey,
): LoginProviderAdminStore {
  return {
    async list() {
      const rows = await db
        .select()
        .from(loginProviders)
        .orderBy(asc(loginProviders.createdAt), asc(loginProviders.id));
      const secrets = await secretSummaries(
        db,
        rows.map((row) => row.id),
      );
      return rows.map((row) => recordFrom(row, secrets));
    },

    create(input) {
      return db.transaction(async (tx) => {
        const { endpoints } = input;
        const [row] = await tx
          .insert(loginProviders)
          .values({
            id: input.id,
            displayName: input.displayName,
            issuer: endpoints.issuer,
            ...endpointColumns(endpoints),
            // Never empty: discovery refuses a provider with neither method.
            tokenAuthMethod:
              endpoints.tokenAuthMethods[0] ?? "client_secret_basic",
            createdBy: input.audit.userId,
          })
          .onConflictDoNothing({ target: loginProviders.issuer })
          .returning();
        if (!row) return { outcome: "issuer_taken" as const };
        await writeReceipt(tx, input.audit, "create_login_provider", row.id, {
          issuer: row.issuer,
          display_name: row.displayName,
        });
        return {
          outcome: "created" as const,
          provider: recordFrom(row, new Map()),
        };
      });
    },

    update(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        if (row.revision !== input.ifMatch) {
          return { outcome: "stale" as const, revision: row.revision };
        }
        const { changes } = input;
        const set: Partial<typeof loginProviders.$inferInsert> = {};
        if (
          changes.displayName !== undefined &&
          changes.displayName !== row.displayName
        ) {
          set.displayName = changes.displayName;
        }
        // The settings a test sign-in vouches for, or that decide who comes
        // in: changing one makes the provider's settings a new revision.
        const config: Partial<typeof loginProviders.$inferInsert> = {};
        if (
          changes.clientId !== undefined &&
          changes.clientId !== row.clientId
        ) {
          config.clientId = changes.clientId;
        }
        if (
          changes.tokenAuthMethod !== undefined &&
          changes.tokenAuthMethod !== row.tokenAuthMethod
        ) {
          config.tokenAuthMethod = changes.tokenAuthMethod;
        }
        if (row.enabled && Object.keys(config).length > 0) {
          return { outcome: "locked" as const };
        }
        if (
          changes.allowedDomains !== undefined &&
          !sameList(changes.allowedDomains, row.allowedDomains)
        ) {
          config.allowedDomains = [...changes.allowedDomains];
        }
        if (changes.jitRole !== undefined && changes.jitRole !== row.jitRole) {
          config.jitRole = changes.jitRole;
        }
        if (
          changes.requireVerifiedEmail !== undefined &&
          changes.requireVerifiedEmail !== row.requireVerifiedEmail
        ) {
          config.requireVerifiedEmail = changes.requireVerifiedEmail;
        }
        // Asked under the row lock, about the rules as they would stand:
        // two changes that are each allowed must not add up to one that
        // is not.
        const problem = input.refuse?.({
          issuer: row.issuer,
          allowedDomains: config.allowedDomains ?? row.allowedDomains,
          jitRole: (config.jitRole !== undefined
            ? config.jitRole
            : row.jitRole) as LoginProvider["jitRole"],
          requireVerifiedEmail:
            config.requireVerifiedEmail ?? row.requireVerifiedEmail,
        });
        if (problem) return { outcome: "refused" as const, problem };
        const fields = [...Object.keys(set), ...Object.keys(config)];
        if (fields.length === 0) {
          return {
            outcome: "updated" as const,
            provider: await recordOf(tx, row),
          };
        }
        const configChanged = Object.keys(config).length > 0;
        const [updated] = await tx
          .update(loginProviders)
          .set({
            ...set,
            ...config,
            ...(configChanged
              ? { configRevision: sql`${loginProviders.configRevision} + 1` }
              : {}),
            revision: sql`${loginProviders.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(eq(loginProviders.id, row.id))
          .returning();
        if (!updated) throw new Error("login provider update returned no row");
        await writeReceipt(tx, input.audit, "update_login_provider", row.id, {
          // Named as the API names them.
          fields: fields
            .map((field) =>
              field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
            )
            .sort(),
          config_revision: updated.configRevision,
        });
        return {
          outcome: "updated" as const,
          provider: await recordOf(tx, updated),
        };
      });
    },

    refreshDiscovery(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        if (row.enabled) return { outcome: "locked" as const };
        const { endpoints } = input;
        if (endpoints.issuer !== row.issuer) {
          return { outcome: "issuer_changed" as const };
        }
        const [updated] = await tx
          .update(loginProviders)
          .set({
            ...endpointColumns(endpoints),
            // Kept while the provider still takes it; else its default.
            tokenAuthMethod: endpoints.tokenAuthMethods.includes(
              row.tokenAuthMethod,
            )
              ? row.tokenAuthMethod
              : (endpoints.tokenAuthMethods[0] ?? row.tokenAuthMethod),
            configRevision: sql`${loginProviders.configRevision} + 1`,
            revision: sql`${loginProviders.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(eq(loginProviders.id, row.id))
          .returning();
        if (!updated) throw new Error("login provider update returned no row");
        await writeReceipt(
          tx,
          input.audit,
          "refresh_login_provider_discovery",
          row.id,
          { config_revision: updated.configRevision },
        );
        return {
          outcome: "updated" as const,
          provider: await recordOf(tx, updated),
        };
      });
    },

    setClientSecret(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        const workspaceId = await secretOwnerWorkspace(tx);
        if (workspaceId === null) return { outcome: "no_workspace" as const };
        const slot: LoginProviderSecretSlot = row.enabled ? "next" : "current";
        const inUse = await readSecretInTx(
          tx,
          key,
          slotOf(workspaceId, row.id, "current"),
        );
        const waiting = row.enabled
          ? await readSecretInTx(tx, key, slotOf(workspaceId, row.id, "next"))
          : null;
        // The value this provider already has, or already waits to try, is
        // no change: a pass that vouches for it stands.
        if (input.value === (waiting ?? inUse)) {
          return {
            outcome: "stored" as const,
            provider: await recordOf(tx, row),
          };
        }
        // The secret in use passed its test already, so naming it again
        // while another waits withdraws the one that waits.
        const withdrawn = row.enabled && input.value === inUse;
        if (withdrawn) {
          await deleteSecretInTx(tx, slotOf(workspaceId, row.id, "next"));
        } else {
          await writeSecretInTx(
            tx,
            key,
            slotOf(workspaceId, row.id, slot),
            input.value,
            input.audit.userId,
          );
        }
        const [updated] = await tx
          .update(loginProviders)
          .set({
            // Sign-ins of a provider that is on keep the secret they have,
            // so its settings are not a new revision until the test passes.
            ...(row.enabled
              ? {}
              : { configRevision: sql`${loginProviders.configRevision} + 1` }),
            revision: sql`${loginProviders.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(eq(loginProviders.id, row.id))
          .returning();
        if (!updated) throw new Error("login provider update returned no row");
        await writeReceipt(
          tx,
          input.audit,
          "set_login_provider_secret",
          row.id,
          withdrawn
            ? { slot, withdrawn: true }
            : { slot, last4: input.value.slice(-4) },
        );
        return {
          outcome: "stored" as const,
          provider: await recordOf(tx, updated),
        };
      });
    },

    async findForTest(id) {
      const [row] = await db
        .select()
        .from(loginProviders)
        .where(eq(loginProviders.id, id));
      if (!row) return null;
      const provider = providerOf(row);
      const workspaceId = await secretOwnerWorkspace(db);
      if (workspaceId === null) {
        return {
          provider,
          slot: "current",
          clientSecret: null,
          secretId: null,
          secretVersion: null,
        };
      }
      const pending = row.enabled
        ? await openSecretStamped(db, key, slotOf(workspaceId, row.id, "next"))
        : null;
      const stored =
        pending ??
        (await openSecretStamped(
          db,
          key,
          slotOf(workspaceId, row.id, "current"),
        ));
      return {
        provider,
        slot: pending ? "next" : "current",
        clientSecret: stored?.value ?? null,
        secretId: stored?.id ?? null,
        secretVersion: stored?.secretVersion ?? null,
      };
    },

    recordTest(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        const workspaceId = await secretOwnerWorkspace(tx);
        if (
          workspaceId === null ||
          row.configRevision !== input.configRevision ||
          // A replacement is only ever tested on a provider that is on.
          (input.slot === "next" && !row.enabled)
        ) {
          return { outcome: "stale" as const };
        }
        // The value that passed, not just a version of it: the pass vouches
        // for exactly what the provider accepted.
        const stored = await readSecretInTx(
          tx,
          key,
          slotOf(workspaceId, row.id, input.slot),
        );
        if (stored === null || stored !== input.clientSecret) {
          return { outcome: "stale" as const };
        }
        if (input.slot === "next") {
          await writeSecretInTx(
            tx,
            key,
            slotOf(workspaceId, row.id, "current"),
            stored,
            input.audit.userId,
          );
          await deleteSecretInTx(tx, slotOf(workspaceId, row.id, "next"));
        }
        await tx
          .update(loginProviders)
          .set({
            testedConfigRevision: row.configRevision,
            testedAt: DB_NOW,
            revision: sql`${loginProviders.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(eq(loginProviders.id, row.id));
        await writeReceipt(tx, input.audit, "test_login_provider", row.id, {
          config_revision: row.configRevision,
          slot: input.slot,
          secret_replaced: input.slot === "next",
        });
        return { outcome: "recorded" as const };
      });
    },

    enable(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        if (row.enabled) {
          return {
            outcome: "enabled" as const,
            provider: await recordOf(tx, row),
          };
        }
        const workspaceId = await secretOwnerWorkspace(tx);
        const secret =
          workspaceId === null
            ? null
            : await describeSecret(tx, slotOf(workspaceId, row.id, "current"));
        if (
          row.clientId === null ||
          secret === null ||
          row.testedConfigRevision !== row.configRevision
        ) {
          return { outcome: "not_ready" as const };
        }
        const [updated] = await tx
          .update(loginProviders)
          .set({
            enabled: true,
            revision: sql`${loginProviders.revision} + 1`,
            updatedAt: DB_NOW,
          })
          .where(eq(loginProviders.id, row.id))
          .returning();
        if (!updated) throw new Error("login provider update returned no row");
        await writeReceipt(tx, input.audit, "enable_login_provider", row.id, {
          config_revision: updated.configRevision,
        });
        return {
          outcome: "enabled" as const,
          provider: await recordOf(tx, updated),
        };
      });
    },

    disable(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        if (!row.enabled) {
          return {
            outcome: "disabled" as const,
            provider: await recordOf(tx, row),
            sessionsRevoked: 0,
          };
        }
        const off = await turnOff(tx, row.id);
        if (!off) return { outcome: "not_found" as const };
        await writeReceipt(tx, input.audit, "disable_login_provider", row.id, {
          sessions_revoked: off.sessionsRevoked,
        });
        return {
          outcome: "disabled" as const,
          provider: await recordOf(tx, off.row),
          sessionsRevoked: off.sessionsRevoked,
        };
      });
    },

    delete(input) {
      return db.transaction(async (tx) => {
        const row = await lockedProvider(tx, input.id);
        if (!row) return { outcome: "not_found" as const };
        if (row.enabled) return { outcome: "enabled" as const };
        const workspaceId = await secretOwnerWorkspace(tx);
        if (workspaceId !== null) {
          await deleteSecretInTx(tx, slotOf(workspaceId, row.id, "current"));
          await deleteSecretInTx(tx, slotOf(workspaceId, row.id, "next"));
        }
        await tx.delete(loginProviders).where(eq(loginProviders.id, row.id));
        await writeReceipt(tx, input.audit, "delete_login_provider", row.id, {
          issuer: row.issuer,
        });
        return { outcome: "deleted" as const };
      });
    },

    async previewEntry(input) {
      // The same questions, in the same order, as the sign-in itself
      // (signInWithExternalIdentity).
      const [linked] = await db
        .select({ userId: loginMethods.userId })
        .from(loginMethods)
        .where(
          and(
            eq(loginMethods.kind, "oidc"),
            eq(loginMethods.issuer, input.issuer),
            eq(loginMethods.subject, input.subject),
          ),
        );
      if (linked) {
        const [user] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, linked.userId), isNull(users.disabledAt)));
        return user && (await findLiveMembership(db, user.id))
          ? "linked"
          : "refused";
      }
      if (input.email === null) return "none";
      const [account] = await db
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.email, input.email));
      if (!account) return "none";
      return account.disabledAt === null ? "account_exists" : "refused";
    },
  };
}
