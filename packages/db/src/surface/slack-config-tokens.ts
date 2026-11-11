import { randomUUID } from "node:crypto";
import {
  type ConfigTokenSummary,
  lastFour,
  type SecretKey,
  type SecretSlot,
  type SlackConfigTokenStore,
} from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { receipts, slackConfigTokens, workspaces } from "../schema.ts";
import {
  deleteSecretInTx,
  describeSecret,
  readSecretInTx,
  secretAuditRefusal,
  secretReceiptRow,
  writeSecretInTx,
} from "../secrets/secret-values.ts";

type Row = typeof slackConfigTokens.$inferSelect;

const slotOf = (workspaceId: string): SecretSlot => ({
  workspaceId,
  owner: { kind: "workspace" },
  purpose: "slack_config_token",
});

// One sealed value holds both tokens; neither contains whitespace, and the
// refresh token goes last so the summary's last four are its own.
const encodePair = (access: string, refresh: string) => `${access}\n${refresh}`;
function decodePair(value: string) {
  const [access, refresh, ...rest] = value.split("\n");
  if (!access || !refresh || rest.length > 0) return null;
  return { access, refresh };
}

async function lockedMeta(
  tx: Database,
  workspaceId: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(slackConfigTokens)
    .where(eq(slackConfigTokens.workspaceId, workspaceId))
    .for("update");
  return row;
}

async function summaryOf(
  db: Database,
  workspaceId: string,
): Promise<ConfigTokenSummary> {
  const [row] = await db
    .select()
    .from(slackConfigTokens)
    .where(eq(slackConfigTokens.workspaceId, workspaceId));
  const secret = await describeSecret(db, slotOf(workspaceId));
  if (!row || (row.issuerUserId === null && secret === null)) {
    return { state: "unset", secret: null, expiresAt: null, issuer: null };
  }
  const active = row.state === "active" && secret !== null;
  return {
    state: active ? "active" : "needs_reentry",
    secret: active ? secret : null,
    expiresAt: active ? row.accessExpiresAt : null,
    issuer:
      active && row.issuerUserId !== null && row.issuerTeamId !== null
        ? { userId: row.issuerUserId, teamId: row.issuerTeamId }
        : null,
  };
}

async function markNeedsReentry(tx: Database, workspaceId: string) {
  await tx
    .update(slackConfigTokens)
    .set({
      state: "needs_reentry",
      leaseId: null,
      leaseUntil: null,
      updatedAt: DB_NOW,
    })
    .where(eq(slackConfigTokens.workspaceId, workspaceId));
  await deleteSecretInTx(tx, slotOf(workspaceId));
}

/**
 * The App Configuration Token of each workspace (see SlackConfigTokenStore):
 * every method is one short transaction and none waits on Slack.
 */
export function createPostgresSlackConfigTokenStore(
  db: Database,
  key: SecretKey,
): SlackConfigTokenStore {
  return {
    claim(named, clock) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const row = await lockedMeta(tx, workspaceId);
        if (!row) return { outcome: "not_set" as const };
        if (row.state === "needs_reentry") {
          return {
            outcome:
              row.issuerUserId === null
                ? ("not_set" as const)
                : ("needs_reentry" as const),
          };
        }
        const value = await readSecretInTx(tx, key, slotOf(workspaceId));
        const pair = value === null ? null : decodePair(value);
        if (pair === null) return { outcome: "not_set" as const };
        if (
          row.accessExpiresAt !== null &&
          row.issuerUserId !== null &&
          row.accessExpiresAt > clock.freshUntil
        ) {
          return {
            outcome: "fresh" as const,
            accessToken: pair.access,
            issuerUserId: row.issuerUserId,
          };
        }
        if (row.leaseId !== null && row.leaseUntil !== null) {
          if (row.leaseUntil > clock.now) {
            return { outcome: "busy" as const, until: row.leaseUntil };
          }
          await markNeedsReentry(tx, workspaceId);
          return { outcome: "needs_reentry" as const };
        }
        const leaseId = randomUUID();
        await tx
          .update(slackConfigTokens)
          .set({ leaseId, leaseUntil: clock.leaseUntil })
          .where(eq(slackConfigTokens.workspaceId, workspaceId));
        return {
          outcome: "claimed" as const,
          leaseId,
          refreshToken: pair.refresh,
        };
      });
    },

    claimForReplace(named, clock, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!workspace) return { outcome: "workspace_not_found" as const };
        const row = await lockedMeta(tx, workspaceId);
        if (
          row?.leaseUntil != null &&
          row.leaseId !== null &&
          row.leaseUntil > clock.now
        ) {
          return { outcome: "busy" as const, until: row.leaseUntil };
        }
        const leaseId = randomUUID();
        if (row) {
          await tx
            .update(slackConfigTokens)
            .set({ leaseId, leaseUntil: clock.leaseUntil })
            .where(eq(slackConfigTokens.workspaceId, workspaceId));
        } else {
          await tx.insert(slackConfigTokens).values({
            workspaceId,
            state: "needs_reentry",
            leaseId,
            leaseUntil: clock.leaseUntil,
          });
        }
        return { outcome: "claimed" as const, leaseId };
      });
    },

    complete(named, leaseId, rotated, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const row = await lockedMeta(tx, workspaceId);
        if (!row || row.leaseId !== leaseId) {
          return { outcome: "lease_lost" as const };
        }
        const value = encodePair(rotated.accessToken, rotated.refreshToken);
        await writeSecretInTx(
          tx,
          key,
          slotOf(workspaceId),
          value,
          audit ? (audit.principal.actor?.userId ?? null) : undefined,
        );
        const changed =
          row.issuerUserId !== null &&
          row.issuerUserId !== rotated.issuerUserId;
        await tx
          .update(slackConfigTokens)
          .set({
            state: "active",
            accessExpiresAt: rotated.expiresAt,
            issuerUserId: rotated.issuerUserId,
            issuerTeamId: rotated.issuerTeamId,
            ...(changed
              ? {
                  previousIssuerUserId: row.issuerUserId,
                  issuerChangedAt: DB_NOW,
                }
              : {}),
            leaseId: null,
            leaseUntil: null,
            updatedAt: DB_NOW,
          })
          .where(eq(slackConfigTokens.workspaceId, workspaceId));
        if (audit) {
          await tx
            .insert(receipts)
            .values(
              secretReceiptRow(
                audit,
                slotOf(workspaceId),
                "set_slack_secret",
                lastFour(value),
              ),
            );
        }
        return {
          outcome: "stored" as const,
          summary: await summaryOf(tx, workspaceId),
          previousIssuerUserId: changed ? row.issuerUserId : null,
        };
      });
    },

    async release(named, leaseId) {
      const workspaceId = named.toLowerCase();
      await db
        .update(slackConfigTokens)
        .set({ leaseId: null, leaseUntil: null })
        .where(
          and(
            eq(slackConfigTokens.workspaceId, workspaceId),
            eq(slackConfigTokens.leaseId, leaseId),
          ),
        );
    },

    async invalidate(named, leaseId) {
      const workspaceId = named.toLowerCase();
      await db.transaction(async (tx) => {
        const row = await lockedMeta(tx, workspaceId);
        if (!row) return;
        if (leaseId !== null && row.leaseId !== leaseId) return;
        await markNeedsReentry(tx, workspaceId);
      });
    },

    async expireAccess(named, now) {
      await db
        .update(slackConfigTokens)
        .set({ accessExpiresAt: now })
        .where(eq(slackConfigTokens.workspaceId, named.toLowerCase()));
    },

    describe: (named) => summaryOf(db, named.toLowerCase()),

    delete(named, audit) {
      const workspaceId = named.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, workspaceId, audit);
        if (refused) return { outcome: refused };
        await lockedMeta(tx, workspaceId);
        await tx
          .delete(slackConfigTokens)
          .where(eq(slackConfigTokens.workspaceId, workspaceId));
        const last4 = await deleteSecretInTx(tx, slotOf(workspaceId));
        if (last4 === null) return { outcome: "not_found" as const };
        await tx
          .insert(receipts)
          .values(
            secretReceiptRow(
              audit,
              slotOf(workspaceId),
              "delete_slack_secret",
              last4,
            ),
          );
        return { outcome: "deleted" as const, last4 };
      });
    },
  };
}
