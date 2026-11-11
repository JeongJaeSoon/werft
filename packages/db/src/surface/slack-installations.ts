import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { slackInstallations } from "../schema.ts";

export type SlackInstallationStatus = "pending" | "verified" | "revoked";

export type SlackInstallation = {
  id: string;
  workspaceId: string;
  appId: string;
  teamId: string;
  botUserId: string | null;
  status: SlackInstallationStatus;
  createdAt: Date;
  verifiedAt: Date | null;
  revokedAt: Date | null;
};

export type SlackInstallationKey = { appId: string; teamId: string };

export type RegisterSlackInstallationResult =
  | { outcome: "registered"; installation: SlackInstallation }
  | { outcome: "existing"; installation: SlackInstallation }
  // The app is already installed in this team for another workspace.
  | { outcome: "workspace_conflict"; installation: SlackInstallation };

export type VerifySlackInstallationResult =
  | { outcome: "verified"; installation: SlackInstallation }
  | { outcome: "revoked"; installation: SlackInstallation }
  | { outcome: "not_found" };

export type RevokeSlackInstallationResult =
  | { outcome: "revoked"; installation: SlackInstallation }
  | { outcome: "not_found" };

const columns = {
  id: slackInstallations.id,
  workspaceId: slackInstallations.workspaceId,
  appId: slackInstallations.appId,
  teamId: slackInstallations.teamId,
  botUserId: slackInstallations.botUserId,
  status: slackInstallations.status,
  createdAt: slackInstallations.createdAt,
  verifiedAt: slackInstallations.verifiedAt,
  revokedAt: slackInstallations.revokedAt,
};

const byKey = (key: SlackInstallationKey) =>
  and(
    eq(slackInstallations.appId, key.appId),
    eq(slackInstallations.teamId, key.teamId),
  );

export async function findSlackInstallation(
  db: Database,
  key: SlackInstallationKey,
): Promise<SlackInstallation | null> {
  const [row] = await db
    .select(columns)
    .from(slackInstallations)
    .where(byKey(key))
    .limit(1);
  return row ?? null;
}

/**
 * Records the shared app's install in a Slack team as `pending`. One row per
 * (app_id, team_id): registering it again returns the row as it stands, and
 * registering a revoked one for the same workspace reopens that row, so what
 * points at its id survives a reinstall.
 */
export async function registerSlackInstallation(
  db: Database,
  input: SlackInstallationKey & { workspaceId: string },
): Promise<RegisterSlackInstallationResult> {
  const [registered] = await db
    .insert(slackInstallations)
    .values({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      appId: input.appId,
      teamId: input.teamId,
      status: "pending",
      createdAt: DB_NOW,
    })
    .onConflictDoUpdate({
      target: [slackInstallations.appId, slackInstallations.teamId],
      set: {
        status: "pending",
        botUserId: null,
        verifiedAt: null,
        revokedAt: null,
      },
      setWhere: sql`${slackInstallations.status} = 'revoked' AND ${slackInstallations.workspaceId} = excluded.workspace_id`,
    })
    .returning(columns);
  if (registered) {
    return { outcome: "registered", installation: registered };
  }
  // A conflict the update skipped: the row exists and is live, or belongs to
  // another workspace. It cannot vanish in between, since rows are never
  // deleted.
  const existing = await findSlackInstallation(db, input);
  if (!existing) {
    throw new Error(
      `Slack installation ${input.appId}/${input.teamId} conflicted but is missing`,
    );
  }
  return existing.workspaceId === input.workspaceId
    ? { outcome: "existing", installation: existing }
    : { outcome: "workspace_conflict", installation: existing };
}

/**
 * Marks the install `verified` with the bot user `auth.test` reported. A
 * verified row may be verified again (each start re-checks it); a revoked one
 * stays revoked until it is registered again.
 */
export async function verifySlackInstallation(
  db: Database,
  input: SlackInstallationKey & { botUserId: string },
): Promise<VerifySlackInstallationResult> {
  // Locked so that a revoke or a re-register cannot land between reading the
  // state and acting on it.
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select(columns)
      .from(slackInstallations)
      .where(byKey(input))
      .for("update");
    if (!current) return { outcome: "not_found" };
    if (current.status === "revoked") {
      return { outcome: "revoked", installation: current };
    }
    const [verified] = await tx
      .update(slackInstallations)
      .set({
        status: "verified",
        botUserId: input.botUserId,
        verifiedAt: DB_NOW,
      })
      .where(eq(slackInstallations.id, current.id))
      .returning(columns);
    if (!verified) throw new Error(`Slack installation ${current.id} vanished`);
    return { outcome: "verified", installation: verified };
  });
}

/** Revokes the install; revoking it again keeps the first revoked_at. */
export async function revokeSlackInstallation(
  db: Database,
  key: SlackInstallationKey,
): Promise<RevokeSlackInstallationResult> {
  const [revoked] = await db
    .update(slackInstallations)
    .set({
      status: "revoked",
      revokedAt: sql`coalesce(${slackInstallations.revokedAt}, ${DB_NOW})`,
    })
    .where(byKey(key))
    .returning(columns);
  return revoked
    ? { outcome: "revoked", installation: revoked }
    : { outcome: "not_found" };
}
