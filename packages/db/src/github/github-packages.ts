import {
  type GitHubPackagesAllowEntry,
  githubPackagesAllowlistSchema,
} from "@werft-ai/contracts";
import type {
  GitHubPackagesStore,
  SecretAudit,
  SecretKey,
  SecretSlot,
} from "@werft-ai/platform";
import { eq, sql } from "drizzle-orm";
import { receiptActorOf } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import {
  agentReleases,
  githubPackagesSettings,
  receipts,
  sessions,
  workspaces,
} from "../schema.ts";
import {
  deleteSecretInTx,
  describeSecret,
  readSecretInTx,
  secretAuditRefusal,
  writeSecretInTx,
} from "../secrets/secret-values.ts";
import { creatorOf } from "./mcp-egress.ts";

// A session's owner without a workspace (an installation's own key, as in
// the quickstart) is not a uuid, and has no settings row or token.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tokenSlot = (workspaceId: string): SecretSlot => ({
  workspaceId: workspaceId.toLowerCase(),
  owner: { kind: "workspace" },
  purpose: "github_packages_token",
});

// A row written by another version, or by hand, is read as no allowlist
// rather than trusted: an entry that does not parse allows nothing.
function allowlistOf(value: unknown): GitHubPackagesAllowEntry[] {
  const parsed = githubPackagesAllowlistSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function receiptRow(
  audit: SecretAudit,
  workspaceId: string,
  operation:
    | "set_github_packages_token"
    | "delete_github_packages_token"
    | "set_github_packages_allowlist",
  result: Record<string, unknown>,
) {
  return {
    id: audit.receiptId,
    ownerId: workspaceId,
    actor: receiptActorOf(audit.principal),
    operation,
    targetRef: {
      resource: { kind: "workspace", id: workspaceId },
      workspace_id: workspaceId,
    },
    status: "succeeded" as const,
    result,
  };
}

// Serializes the settings row's writers: the token's facts and the
// allowlist share it.
async function lockSettings(tx: Database, workspaceId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`github_packages_settings:${workspaceId}`}))`,
  );
}

export function createPostgresGitHubPackagesStore(
  db: Database,
  key: SecretKey | null,
): GitHubPackagesStore {
  async function settingsRow(executor: Database, workspaceId: string) {
    if (!UUID.test(workspaceId)) return undefined;
    const [row] = await executor
      .select()
      .from(githubPackagesSettings)
      .where(eq(githubPackagesSettings.workspaceId, workspaceId))
      .limit(1);
    return row;
  }

  async function workspaceExists(tx: Database, workspaceId: string) {
    const [workspace] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return workspace !== undefined;
  }

  return {
    async get(workspaceId) {
      const id = workspaceId.toLowerCase();
      const [row, summary] = await Promise.all([
        settingsRow(db, id),
        describeSecret(db, tokenSlot(id)),
      ]);
      return {
        token:
          summary === null
            ? null
            : {
                ...summary,
                login: row?.tokenLogin ?? null,
                expiresAt: row?.tokenExpiresAt ?? null,
              },
        allowlist: allowlistOf(row?.allowlist),
        revision: row?.revision ?? 0,
      };
    },

    putToken({ workspaceId, token, facts, audit }) {
      const id = workspaceId.toLowerCase();
      if (key === null) throw new Error("no secret key");
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, id, audit);
        if (refused) return { outcome: refused };
        if (!(await workspaceExists(tx, id))) {
          return { outcome: "workspace_not_found" as const };
        }
        await lockSettings(tx, id);
        await writeSecretInTx(
          tx,
          key,
          tokenSlot(id),
          token,
          audit.principal.actor?.userId ?? null,
        );
        await tx
          .insert(githubPackagesSettings)
          .values({
            workspaceId: id,
            allowlist: [],
            tokenLogin: facts.login,
            tokenExpiresAt: facts.expiresAt,
            revision: 0,
          })
          .onConflictDoUpdate({
            target: githubPackagesSettings.workspaceId,
            set: {
              tokenLogin: facts.login,
              tokenExpiresAt: facts.expiresAt,
            },
          });
        await tx.insert(receipts).values(
          receiptRow(audit, id, "set_github_packages_token", {
            purpose: "github_packages_token",
            last4: token.slice(-4),
            login: facts.login,
            expires_at: facts.expiresAt?.toISOString() ?? null,
          }),
        );
        return { outcome: "stored" as const };
      });
    },

    deleteToken({ workspaceId, audit }) {
      const id = workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, id, audit);
        if (refused) return { outcome: refused };
        await lockSettings(tx, id);
        const last4 = await deleteSecretInTx(tx, tokenSlot(id));
        if (last4 === null) return { outcome: "not_found" as const };
        await tx
          .update(githubPackagesSettings)
          .set({ tokenLogin: null, tokenExpiresAt: null })
          .where(eq(githubPackagesSettings.workspaceId, id));
        await tx.insert(receipts).values(
          receiptRow(audit, id, "delete_github_packages_token", {
            purpose: "github_packages_token",
            last4,
          }),
        );
        return { outcome: "deleted" as const };
      });
    },

    putAllowlist({ workspaceId, allowlist, revision, audit }) {
      const id = workspaceId.toLowerCase();
      return db.transaction(async (tx) => {
        const refused = await secretAuditRefusal(tx, id, audit);
        if (refused) return { outcome: refused };
        if (!(await workspaceExists(tx, id))) {
          return { outcome: "workspace_not_found" as const };
        }
        await lockSettings(tx, id);
        const current = await settingsRow(tx, id);
        if ((current?.revision ?? 0) !== revision) {
          return { outcome: "revision_conflict" as const };
        }
        const updatedBy = audit.principal.actor?.userId ?? null;
        await tx
          .insert(githubPackagesSettings)
          .values({ workspaceId: id, allowlist, revision: 1, updatedBy })
          .onConflictDoUpdate({
            target: githubPackagesSettings.workspaceId,
            set: {
              allowlist,
              revision: revision + 1,
              updatedBy,
              updatedAt: DB_NOW,
            },
          });
        await tx.insert(receipts).values(
          receiptRow(audit, id, "set_github_packages_allowlist", {
            entries: allowlist.length,
            revision: revision + 1,
          }),
        );
        return { outcome: "stored" as const };
      });
    },

    async allowlist(workspaceId) {
      return allowlistOf(
        (await settingsRow(db, workspaceId.toLowerCase()))?.allowlist,
      );
    },

    async sessionState(sessionId) {
      const [session] = await db
        .select({
          ownerId: sessions.ownerId,
          workspaceId: sessions.workspaceId,
          agentReleaseId: sessions.agentReleaseId,
          agentId: agentReleases.agentId,
          createdByUserId: sessions.createdByUserId,
          createdByApiKeyId: sessions.createdByApiKeyId,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!session) return null;
      const workspaceId = (
        session.workspaceId ?? session.ownerId
      ).toLowerCase();
      const row = await settingsRow(db, workspaceId);
      const value =
        key === null || !UUID.test(workspaceId)
          ? null
          : await db.transaction((tx) =>
              readSecretInTx(tx, key, tokenSlot(workspaceId)),
            );
      const agentId = session.agentId ?? null;
      return {
        ownerId: session.ownerId,
        workspaceId,
        agentId,
        releaseId: session.agentReleaseId,
        actor: creatorOf(session, agentId),
        token:
          value === null
            ? null
            : { value, expiresAt: row?.tokenExpiresAt ?? null },
        allowlist: allowlistOf(row?.allowlist),
      };
    },

    async recordFetch(record) {
      await db.insert(receipts).values({
        id: record.id,
        ownerId: record.ownerId,
        operation: "fetch_github_package",
        targetRef: {
          session_id: record.sessionId,
          turn_id: null,
          request_id: null,
        },
        status: record.status,
        result: record.result,
        ...(record.result.reason_code === null
          ? {}
          : {
              error: {
                code: "FORBIDDEN",
                message: `GitHub Packages request refused: ${record.result.reason_code}`,
              },
            }),
        actor: record.actor,
      });
    },
  };
}
