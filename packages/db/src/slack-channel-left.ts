import { type SQL, sql } from "drizzle-orm";

/**
 * True when the live binding of the channel is `left`: the bot was removed
 * from the private channel, so nothing may be sent there, whatever the kind
 * of row (a notice included). `installationId` and `channelId` are column
 * references of the row being judged. A channel that was bound again by a
 * `ready` row has no `left` one, since live bindings of a channel are unique.
 */
export const channelLeft = (installationId: SQL, channelId: SQL) => sql`EXISTS (
  SELECT 1 FROM surface_bindings lb
  WHERE lb.installation_id = ${installationId}
    AND lb.external_surface_id = ${channelId}
    AND lb.status = 'left'
    AND lb.revoked_at IS NULL
)`;
