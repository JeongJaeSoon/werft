import { randomUUID } from "node:crypto";
import {
  type ConversationRollout,
  SETTABLE_CONVERSATION_ROLLOUT_VALUES,
  WORKSPACE_MANAGER_ROLES,
} from "@werft-ai/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { lockedRole } from "../access-control/index.ts";
import { dropUnlistenedBuffer } from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { agents, memberships, receipts, users } from "../schema.ts";
import { notDeleted } from "../soft-delete.ts";

// The Slack notice approval (a1/S5) is retired: nothing here reads or writes
// `slack_notice_approvals`. Its rows stay until the table is dropped.

type Place = { workspaceId: string; agentId: string };

// Lock order: the actor's membership, then the agent, as the identity and
// binding stores take theirs.
async function lockAdminAndAgent(
  tx: Database,
  place: Place,
  userId: string,
): Promise<"not_admin" | "not_found" | null> {
  // Locks the account first, as lockedRole does for every role check, so a
  // disable committed while this waited is seen.
  const role = await lockedRole(tx, place.workspaceId, userId);
  if (role === null || !WORKSPACE_MANAGER_ROLES.some((r) => r === role)) {
    return "not_admin";
  }
  return (await rolloutOf(tx, place, "update")) === null ? "not_found" : null;
}

const actorOf = (userId: string) => ({
  principal: { kind: "user", id: userId },
  actor_user_id: userId,
  agent_id: null,
});

/**
 * Whether the user is a live owner or admin of the workspace now, read
 * without a lock: for what a screen offers, not for a write.
 */
export async function managesWorkspace(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .limit(1);
  return WORKSPACE_MANAGER_ROLES.some((role) => role === row?.role);
}

export type ConversationRolloutChange =
  | {
      /** `unchanged`: the switch already held the value; nothing is written. */
      outcome: "changed" | "unchanged";
      before: ConversationRollout;
      after: ConversationRollout;
      /** Buffered messages a change to `off` removed. */
      bufferedDropped: number;
    }
  /** `on_unavailable`: `on` is not open yet. */
  | { outcome: "not_found" | "not_admin" | "on_unavailable" };

/**
 * Changes the agent's conversation switch, by a workspace owner or admin
 * (`by.userId`, checked under its lock) or the operator CLI, under the
 * agent's row lock. A change writes one `set_conversation_rollout` receipt in
 * its transaction; `off` also empties the agent's judgment buffer.
 */
export async function setConversationRollout(
  db: Database,
  input: Place & {
    rollout: ConversationRollout;
    by: "operator_cli" | { userId: string };
    requestId?: string;
  },
): Promise<ConversationRolloutChange> {
  return db.transaction(async (tx) => {
    if (typeof input.by === "string") {
      if ((await rolloutOf(tx, input, "update")) === null) {
        return { outcome: "not_found" };
      }
    } else {
      const refused = await lockAdminAndAgent(tx, input, input.by.userId);
      if (refused !== null) return { outcome: refused };
    }
    if (
      !SETTABLE_CONVERSATION_ROLLOUT_VALUES.some((v) => v === input.rollout)
    ) {
      return { outcome: "on_unavailable" };
    }
    const before = await rolloutOf(tx, input);
    if (before === null) return { outcome: "not_found" };
    if (before === input.rollout) {
      return {
        outcome: "unchanged",
        before,
        after: before,
        bufferedDropped: 0,
      };
    }
    await tx
      .update(agents)
      .set({ conversationRollout: input.rollout })
      .where(eq(agents.id, input.agentId));
    const bufferedDropped =
      input.rollout === "off"
        ? await dropUnlistenedBuffer(tx, { agentId: input.agentId })
        : 0;
    const person = typeof input.by === "string" ? null : input.by.userId;
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: input.workspaceId,
      operation: "set_conversation_rollout",
      targetRef: {
        resource: { kind: "agent", id: input.agentId },
        workspace_id: input.workspaceId,
      },
      status: "succeeded",
      result: {
        agent_id: input.agentId,
        before,
        after: input.rollout,
        by: person === null ? input.by : "web",
        // Kept for readers of older receipts, where a lowering named why.
        reason: null,
        buffered_dropped: bufferedDropped,
      },
      ...(person === null ? {} : { actor: actorOf(person) }),
      requestId: input.requestId ?? null,
    });
    return {
      outcome: "changed",
      before,
      after: input.rollout,
      bufferedDropped,
    };
  });
}

/** The live agent's switch, or null for none; `lock` locks its row so. */
export async function rolloutOf(
  db: Database,
  place: Place,
  lock?: "update" | "share",
): Promise<ConversationRollout | null> {
  const query = db
    .select({ rollout: agents.conversationRollout })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, place.workspaceId),
        eq(agents.id, place.agentId),
        notDeleted(agents),
      ),
    );
  const [agent] = await (lock === undefined ? query : query.for(lock));
  return agent?.rollout ?? null;
}

export type ConversationGate =
  | { open: true; rollout: Exclude<ConversationRollout, "off"> }
  | { open: false; reason: "agent_not_found" | "rollout_off" };

/**
 * Whether the agent may take a conversation step now: its switch is raised.
 * Asked right before a model call and right before its result is written.
 * With `lock`, called in the transaction that writes, it holds the agent's
 * row shared until commit, so a change of the switch waits for that write or
 * is seen by it.
 */
export async function conversationGate(
  db: Database,
  place: Place,
  options: { lock?: boolean } = {},
): Promise<ConversationGate> {
  const rollout = await rolloutOf(
    db,
    place,
    options.lock ? "share" : undefined,
  );
  if (rollout === null) return { open: false, reason: "agent_not_found" };
  if (rollout === "off") return { open: false, reason: "rollout_off" };
  return { open: true, rollout };
}
