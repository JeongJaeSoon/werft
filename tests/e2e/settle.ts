import { type Api, poll, type Turn } from "./client.ts";

/**
 * Settles a turn, `approver` allowing each permission request as it comes;
 * `before` runs ahead of the answer to the n-th one (0-based).
 */
export async function settle(
  api: Api,
  approver: Api,
  sessionId: string,
  turnId: string,
  before: Record<number, () => Promise<void>> = {},
): Promise<Turn> {
  const answered = new Set<string>();
  return poll(`turn ${turnId} of ${sessionId}`, 180_000, async () => {
    const turn = await api.turn(sessionId, turnId);
    if (
      ["completed", "failed", "interrupted", "cancelled"].includes(turn.status)
    ) {
      return turn;
    }
    for (const request of await api.pending(sessionId)) {
      if (answered.has(request.request_id)) continue;
      await before[answered.size]?.();
      answered.add(request.request_id);
      await approver.allow(sessionId, request.request_id);
    }
    return null;
  });
}
