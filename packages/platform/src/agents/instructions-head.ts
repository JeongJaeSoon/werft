import type { GetSlackInstructionsHeadResponse } from "@werft-ai/contracts";
import type { GitHubReleaseRead } from "../github/ports/github-gate.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  NOT_FOUND,
  receiptActorOf,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";
import type { AgentStore } from "./ports/agent-store.ts";
import { RELEASE_INSTRUCTIONS_READ_MS } from "./release-instructions.ts";

/**
 * A catalog repository's branch head, read through the GitHub release-read
 * gate. Throws when GitHub (or its App) fails.
 */
export interface BranchHeadReadable {
  branchHead(
    read: GitHubReleaseRead,
  ): Promise<
    | { kind: "head"; commit: string }
    | { kind: "not_on_github" }
    | { kind: "branch_missing" }
  >;
}

/**
 * Whether the active release's instruction snapshot is behind its
 * repository's branch, for the agent's Slack tab (a1/S3). Read when asked,
 * never on a schedule; it makes no release. Who may ask is who sees the
 * tab's judgments: owners, admins and the agent's admins.
 */
export function createInstructionsHeadService(deps: {
  authorization: AuthorizationPolicy;
  agents: Pick<AgentStore, "get">;
  heads: BranchHeadReadable;
  timeoutMs?: number;
}) {
  const timeoutMs = deps.timeoutMs ?? RELEASE_INSTRUCTIONS_READ_MS;
  return {
    async getSlackInstructionsHead(
      caller: Caller,
      agentId: string,
    ): Promise<GetSlackInstructionsHeadResponse> {
      await requirePermitted(deps.authorization, caller, "judgment.read", {
        kind: "agent",
        id: agentId,
      });
      const agent = await deps.agents.get(caller.ownerId, agentId);
      if (agent === null) throw NOT_FOUND();
      const release = agent.active_release;
      if (release === null) return { state: "unread", reason: "no_release" };
      const snapshot = release.instructions_snapshot;
      if (snapshot == null || !("commit" in snapshot)) {
        return { state: "unread", reason: "no_commit" };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        deps.heads.branchHead({
          ownerId: caller.ownerId,
          agentId,
          repositoryId: snapshot.repository_id,
          actor: receiptActorOf(caller),
        }),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ])
        .catch(() => "failed" as const)
        .finally(() => clearTimeout(timer));
      if (read === "timeout" || read === "failed") {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "GitHub could not be read",
        );
      }
      if (read.kind !== "head") return { state: "unread", reason: read.kind };
      return {
        state: "read",
        commit: read.commit,
        newer: read.commit !== snapshot.commit,
      };
    },
  };
}

export type InstructionsHeadService = ReturnType<
  typeof createInstructionsHeadService
>;
