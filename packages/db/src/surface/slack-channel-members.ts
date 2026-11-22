import { SLACK_MEMBER_CACHE_TTL_MS } from "@werft-ai/contracts";
import type { ChannelMemberStore } from "@werft-ai/platform";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import {
  agentIdentities,
  linkedAccounts,
  slackChannelMemberCache,
  slackInstallations,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

const TTL = sql`make_interval(secs => ${SLACK_MEMBER_CACHE_TTL_MS / 1000})`;
const cache = slackChannelMemberCache;

export function createPostgresChannelMemberStore(
  db: Database,
): ChannelMemberStore {
  return {
    async subject(input) {
      const workspaceId = input.workspaceId.toLowerCase();
      const [install] = await db
        .select({
          installationId: agentIdentities.installationId,
          teamId: slackInstallations.teamId,
        })
        .from(agentIdentities)
        .innerJoin(
          slackInstallations,
          eq(slackInstallations.id, agentIdentities.installationId),
        )
        .where(
          and(
            eq(agentIdentities.workspaceId, workspaceId),
            eq(agentIdentities.agentId, input.agentId.toLowerCase()),
            eq(agentIdentities.status, "active"),
            eq(slackInstallations.status, "verified"),
          ),
        )
        .orderBy(desc(agentIdentities.createdAt), desc(agentIdentities.id))
        .limit(1);
      if (!install) return null;
      const [link] = await db
        .select({ slackUserId: linkedAccounts.externalUserId })
        .from(linkedAccounts)
        .where(
          and(
            eq(linkedAccounts.workspaceId, workspaceId),
            eq(linkedAccounts.userId, input.userId.toLowerCase()),
            eq(linkedAccounts.provider, "slack"),
            eq(linkedAccounts.externalTenant, install.teamId),
            eq(linkedAccounts.status, "active"),
          ),
        )
        .limit(1);
      return link
        ? {
            installationId: install.installationId,
            slackUserId: link.slackUserId,
          }
        : null;
    },

    async cached(installationId, channelId) {
      const [row] = rowsOf<{
        checked_at: Date | string;
        member_ids: string[] | null;
      }>(
        // A Date holds milliseconds. Cutting the read time down to them keeps
        // it on the safe side: a read in the same millisecond as a void or a
        // verify is refused by remember(), never kept stale.
        await db.execute(sql`
          SELECT date_trunc('milliseconds', statement_timestamp()) AS checked_at, (
            SELECT member_ids FROM ${cache}
            WHERE installation_id = ${installationId}
              AND channel_id = ${channelId}
              AND fetched_at > statement_timestamp() - ${TTL}
              AND (invalidated_at IS NULL OR invalidated_at < fetched_at)
          ) AS member_ids`),
      );
      if (!row) throw new Error("statement_timestamp() returned no row");
      return {
        memberIds: row.member_ids,
        checkedAt: new Date(row.checked_at),
      };
    },

    async remember(installationId, channelId, memberIds, checkedAt) {
      // A void at or after the read's start wins, and so does a newer read;
      // a read older than the TTL is stale on arrival, which also covers a
      // void the purge has already removed. FOR SHARE queues behind a revoke
      // (FOR NO KEY UPDATE, then its delete of the lists) and re-reads the
      // install after it; a read that began before the install's latest
      // verification belongs to the install that was revoked.
      const at = checkedAt.toISOString();
      const kept = await db.execute(sql`
        WITH install AS (
          SELECT id FROM ${slackInstallations}
          WHERE id = ${installationId}
            AND status = 'verified'
            AND verified_at < ${at}::timestamptz
          FOR SHARE
        )
        INSERT INTO ${cache} (installation_id, channel_id, member_ids, fetched_at)
        SELECT install.id, ${channelId},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(memberIds)}::jsonb)),
          ${at}::timestamptz
        FROM install
        WHERE ${at}::timestamptz > statement_timestamp() - ${TTL}
        ON CONFLICT (installation_id, channel_id) DO UPDATE
          SET member_ids = EXCLUDED.member_ids, fetched_at = EXCLUDED.fetched_at
          WHERE (${cache.invalidatedAt} IS NULL OR ${cache.invalidatedAt} < EXCLUDED.fetched_at)
            -- Strict: of two reads in one millisecond, the later reply is
            -- refused rather than allowed to overwrite a newer list.
            AND (${cache.fetchedAt} IS NULL OR ${cache.fetchedAt} < EXCLUDED.fetched_at)
        RETURNING installation_id`);
      return rowsOf(kept).length === 1;
    },

    async forget(installationId, channelId) {
      await db.execute(sql`
        INSERT INTO ${cache} (installation_id, channel_id, invalidated_at)
        VALUES (${installationId}, ${channelId}, statement_timestamp())
        ON CONFLICT (installation_id, channel_id) DO UPDATE
          SET member_ids = '{}', invalidated_at = statement_timestamp()`);
    },
  };
}

/** Drops an install's member lists, inside the transaction that revokes it. */
export async function forgetInstallationMembers(
  tx: Database,
  installationId: string,
): Promise<void> {
  await tx.delete(cache).where(eq(cache.installationId, installationId));
}

/** Member lists and voids past the TTL: no read uses them any more. */
export async function purgeExpiredSlackChannelMembers(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  const expired = sql`
    SELECT installation_id, channel_id FROM ${cache}
    WHERE greatest(fetched_at, invalidated_at) < statement_timestamp() - ${TTL}
    ORDER BY greatest(fetched_at, invalidated_at)
    LIMIT ${input.limit}`;
  const result = await db.execute(
    input.dryRun
      ? expired
      : sql`DELETE FROM ${cache} WHERE (installation_id, channel_id) IN (${expired} FOR UPDATE SKIP LOCKED) RETURNING installation_id`,
  );
  return rowsOf<{ installation_id: string }>(result).length;
}
