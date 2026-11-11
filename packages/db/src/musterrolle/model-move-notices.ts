import { randomUUID } from "node:crypto";
import {
  type ModelMoveNotice,
  modelMoveDedupeKey,
  modelMoveNoticeText,
} from "@werft-ai/platform";
import { eq } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { agents, slackOutbox } from "../schema.ts";
import { slackRecipientsOf } from "./model-cut-notices.ts";

export async function enqueueModelMoveNotices(
  tx: Database,
  input: {
    workspaceId: string;
    agentId: string;
    kind: ModelMoveNotice["kind"];
    from: string;
    to: string;
    revision: number;
  },
): Promise<number> {
  const [agent] = await tx
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  if (!agent) return 0;
  const recipients = await slackRecipientsOf(tx, {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    userId: null,
  });
  let enqueued = 0;
  for (const person of recipients) {
    const [row] = await tx
      .insert(slackOutbox)
      .values({
        id: randomUUID(),
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        slackAppId: person.slackAppId,
        installationId: person.installationId,
        kind: "model_notice",
        channelId: person.slackUserId,
        threadTs: "",
        slackUserId: null,
        sessionId: null,
        body: {
          text: modelMoveNoticeText(person.locale, {
            kind: input.kind,
            agent: agent.name,
            from: input.from,
            to: input.to,
          }),
          ...(person.locale === null ? {} : { locale: person.locale }),
        },
        dedupeKey: modelMoveDedupeKey(
          input.kind,
          input.agentId,
          input.from,
          input.to,
          person.slackUserId,
          input.revision,
        ),
      })
      .onConflictDoNothing({ target: slackOutbox.dedupeKey })
      .returning({ id: slackOutbox.id });
    if (row) enqueued += 1;
  }
  return enqueued;
}
