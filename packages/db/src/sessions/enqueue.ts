import {
  postSessionAnswerRequestSchema,
  sessionMessageSchema,
} from "@werft-ai/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { queueMessages, sessions, unassignedSessions } from "../schema.ts";

export type EnqueueInput = {
  sessionId: string;
  turnId?: number;
  payload: unknown;
};

function validatePayload(payload: unknown) {
  const answer = postSessionAnswerRequestSchema.safeParse(payload);
  if (answer.success) {
    return { kind: "answer", payload: answer.data } as const;
  }
  return {
    kind: "message",
    payload: sessionMessageSchema.parse(payload),
  } as const;
}

// Runs inside the caller's transaction so input, receipt and queue rows commit
// together (module-design: queue SQL shares the db transaction handle).
export async function enqueueWithin(
  tx: Database,
  input: EnqueueInput,
): Promise<number> {
  const validated = validatePayload(input.payload);
  const [inserted] = await tx
    .insert(queueMessages)
    .values({
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: validated.kind,
      payload: validated.payload,
    })
    .returning({ id: queueMessages.id });
  if (!inserted) {
    throw new Error("Failed to enqueue message");
  }
  const [session] = await tx
    .select({ partition: sessions.partition, podId: sessions.podId })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1)
    .for("update");
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.podId === null) {
    await tx
      .insert(unassignedSessions)
      .values({ sessionId: input.sessionId, partition: session.partition })
      .onConflictDoNothing({ target: unassignedSessions.sessionId });
  }
  return inserted.id;
}
