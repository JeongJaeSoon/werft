import type {
  CloseLostCheckpointNoticesRequest,
  LostCheckpointNotices,
} from "@werft-ai/contracts";
import type { OpenLostCheckpointNotice } from "@werft-ai/db";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "@werft-ai/platform";

export interface LostCheckpointNoticeStore {
  open(): Promise<OpenLostCheckpointNotice[]>;
  close(input: {
    readonly ids: readonly string[];
    readonly closedBy: string;
  }): Promise<void>;
}

/**
 * The console's banner for checkpoints given up at start: owners and admins
 * read it, signed in, and one of them closes it for the whole installation.
 */
export function createLostCheckpointNoticesAdmin(deps: {
  authorization: AuthorizationPolicy;
  store: LostCheckpointNoticeStore;
}) {
  /** Who closes a notice is recorded on it, so a person, not a key. */
  async function requireManager(caller: Caller): Promise<string> {
    await requirePermitted(deps.authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
    const userId = caller.actor?.userId;
    if (caller.subject.principal?.kind !== "user" || !userId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in owner or admin reads and closes the installation's notices",
        undefined,
        { reason_code: "role" },
      );
    }
    return userId;
  }

  async function open(): Promise<LostCheckpointNotices> {
    return {
      notices: (await deps.store.open()).map((notice) => ({
        id: notice.id,
        forgotten_at: notice.forgottenAt.toISOString(),
        sessions: notice.sessions,
      })),
    };
  }

  return {
    async read(caller: Caller): Promise<LostCheckpointNotices> {
      await requireManager(caller);
      return open();
    },

    /** Answers what is still open: a start after the read stays. */
    async close(
      caller: Caller,
      body: CloseLostCheckpointNoticesRequest,
    ): Promise<LostCheckpointNotices> {
      const closedBy = await requireManager(caller);
      await deps.store.close({ ids: body.ids, closedBy });
      return open();
    },
  };
}

export type LostCheckpointNoticesAdmin = ReturnType<
  typeof createLostCheckpointNoticesAdmin
>;
