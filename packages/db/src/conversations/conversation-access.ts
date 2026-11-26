import type { ConversationId } from "@werft-ai/contracts";
import type {
  ChannelMemberCheckable,
  ChannelMemberStore,
  ConversationAccess,
  ConversationListening,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * What a conversation decision reads (design 9-3), from the rows that own
 * each part, read again for every decision. A channel's kind and listening
 * are its binding's: the newest of the agent's bindings for that channel.
 */
export function createPostgresConversationAccess(
  db: Database,
  deps: {
    members: Pick<ChannelMemberStore, "subject">;
    channelMembers: Pick<ChannelMemberCheckable, "isMember">;
  },
): ConversationAccess {
  const placeRow = async (workspaceId: string, id: ConversationId) => {
    const [row] = rowsOf<{
      agent_id: string;
      kind: "channel" | "dm";
      channel_id: string | null;
      person_user_id: string | null;
      channel_state: string;
      surface_kind: string | null;
      listen: ConversationListening | null;
    }>(
      await db.execute(sql`
        SELECT c.agent_id, c.kind, c.channel_id, c.person_user_id,
          c.channel_state, b.surface_kind, b.listen
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT sb.surface_kind, sb.listen FROM surface_bindings sb
          JOIN slack_installations i ON i.id = sb.installation_id
          WHERE sb.agent_id = c.agent_id AND sb.surface = 'slack'
            AND sb.external_surface_id = c.channel_id
            AND i.team_id = c.team_id
          ORDER BY sb.created_at DESC LIMIT 1) b ON c.kind = 'channel'
        WHERE c.id = ${id}::uuid AND c.workspace_id = ${workspaceId}::uuid`),
    );
    return row;
  };
  return {
    async placeOf(workspaceId, conversationId) {
      const row = await placeRow(workspaceId, conversationId);
      if (row === undefined) return null;
      if (row.kind === "dm") {
        return row.person_user_id === null
          ? null
          : {
              agentId: row.agent_id,
              kind: "dm",
              personUserId: row.person_user_id,
            };
      }
      if (row.channel_id === null) return null;
      return {
        agentId: row.agent_id,
        kind: "channel",
        channelId: row.channel_id,
        // No binding read is no proof it is open: its door stays shut.
        private: row.surface_kind !== "public_channel",
      };
    },
    async slackLinked(workspaceId, agentId, userId) {
      return (
        (await deps.members.subject({ workspaceId, agentId, userId })) !== null
      );
    },
    isMember: (input) => deps.channelMembers.isMember(input),
    async archived(workspaceId, conversationId) {
      const row = await placeRow(workspaceId, conversationId);
      return row === undefined || row.channel_state !== "active";
    },
    async listening(workspaceId, conversationId) {
      return (await placeRow(workspaceId, conversationId))?.listen ?? "off";
    },
  };
}
