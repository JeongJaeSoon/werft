import type { ConversationInputId } from "@werft-ai/contracts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revokeInstallationIdentities } from "../access-control/index.ts";
import { dropUnlistenedBuffer } from "../conversations/index.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { slackInstallations, slackOutbox, surfaceBindings } from "../schema.ts";
import { forgetInstallationMembers } from "./slack-channel-members.ts";
import { closeHeldOfFailedMirror } from "./slack-input-holds.ts";
import { released } from "./slack-shared.ts";

/** The outbox reason of a row its app's delete closed unsent. */
export const SLACK_OUTBOX_APP_DELETED = "app_deleted";

/** How many of each `closeSlackApp` closed. */
export type SlackAppClosed = {
  installations: number;
  identities: number;
  bindings: number;
  outbox: number;
  buffered: number;
};

/**
 * Closes everything a Slack app holds in Werft, in the caller's transaction:
 * its installs, the agent identities pinned to them with their channel
 * bindings, its outbox rows not yet sending (`app_deleted`), and its agent's
 * judgment buffer for the channels it no longer listens to. The caller holds
 * the app row's lock; sessions and their turns stay. A repeat closes nothing.
 */
export async function closeSlackApp(
  tx: Database,
  app: {
    workspaceId: string;
    slackAppId: string;
    /** Slack's id for the app; null when it was never created there. */
    appId: string | null;
    agentId: string | null;
    /** The user who deleted it; null when no person acted. */
    closedBy: string | null;
  },
): Promise<SlackAppClosed> {
  const closed: SlackAppClosed = {
    installations: 0,
    identities: 0,
    bindings: 0,
    outbox: 0,
    buffered: 0,
  };
  // Locked as revokeInstallation locks it, and in id order, so a reinstall
  // or an uninstall event of the same app waits rather than deadlocks.
  const installs =
    app.appId === null
      ? []
      : await tx
          .select({ id: slackInstallations.id })
          .from(slackInstallations)
          .where(
            and(
              eq(slackInstallations.workspaceId, app.workspaceId),
              eq(slackInstallations.appId, app.appId),
            ),
          )
          .orderBy(asc(slackInstallations.id))
          .for("no key update");
  const ids = installs.map((install) => install.id);
  if (ids.length > 0) {
    const revoked = await tx
      .update(slackInstallations)
      .set({ status: "revoked", revokedAt: DB_NOW })
      .where(
        and(
          inArray(slackInstallations.id, ids),
          sql`${slackInstallations.status} <> 'revoked'`,
        ),
      )
      .returning({ id: slackInstallations.id });
    closed.installations = revoked.length;
    for (const id of ids) {
      const identities = await revokeInstallationIdentities(
        tx,
        id,
        app.closedBy,
      );
      closed.identities += identities.identities;
      closed.bindings += identities.bindings;
      await forgetInstallationMembers(tx, id);
    }
    // A binding whose identity was revoked before bindings went with it.
    const left = await tx
      .update(surfaceBindings)
      .set({
        status: "revoked",
        home: false,
        revokedAt: DB_NOW,
        updatedAt: DB_NOW,
        revision: sql`${surfaceBindings.revision} + 1`,
      })
      .where(
        and(
          inArray(surfaceBindings.installationId, ids),
          isNull(surfaceBindings.revokedAt),
        ),
      )
      .returning({ id: surfaceBindings.id });
    closed.bindings += left.length;
  }
  // A row already sending is left: Slack may hold it. A claimed row is
  // still pending, and its beginSend finds it closed.
  const cancelled = await tx
    .update(slackOutbox)
    .set({
      status: "failed",
      errorCode: SLACK_OUTBOX_APP_DELETED,
      ...released,
    })
    .where(
      and(
        eq(slackOutbox.slackAppId, app.slackAppId),
        eq(slackOutbox.status, "pending"),
      ),
    )
    .returning({ inputId: slackOutbox.inputId });
  closed.outbox = cancelled.length;
  // A mirror closed here never reached Slack: what it held closes too. In id
  // order, as every path that takes several inputs does.
  for (const inputId of [
    ...new Set(
      cancelled.flatMap((row) => (row.inputId === null ? [] : [row.inputId])),
    ),
  ].sort()) {
    await closeHeldOfFailedMirror(tx, inputId as ConversationInputId);
  }
  if (app.agentId !== null) {
    closed.buffered = await dropUnlistenedBuffer(tx, { agentId: app.agentId });
  }
  return closed;
}
