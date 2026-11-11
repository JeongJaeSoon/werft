import {
  githubPolicyReceiptFields,
  LIST_REPOSITORIES_LIMIT_DEFAULT,
  LISTED_REPOSITORY_MEANING,
  type ListedRepository,
  type ListRepositoriesResponse,
  type ReceiptActor,
  type RepositoryAttachment,
  type RepositoryAttachRefusal,
} from "@werft-ai/contracts";
import type {
  GitHubGateStore,
  GitHubSessionContext,
} from "../github/ports/github-gate.ts";
import { SessionServiceError } from "../musterrolle/index.ts";
import type {
  RepositoryAttachmentRow,
  RepositoryAttachmentStore,
} from "../ports/repository-attachments.ts";
import {
  additionalContextOf,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
  ownRepositoryRevoked,
} from "./additional-repositories.ts";
import type { SessionCatalog } from "./catalog.ts";
import { pathNameOf } from "./session-repository.ts";

const ATTACH_POLL_MS = 500;

export type AttachRepositoryInput = {
  sessionId: string;
  attemptId: string;
  actor: ReceiptActor;
  repositoryId: string;
  /**
   * How long this service may still wait for the fetch to end before
   * answering `pending`. Omitted or 0: answer at once. The caller counts
   * from the start of the whole call and bounds it
   * (`GITHUB_MCP_WAIT_SECONDS_MAX`).
   */
  waitMs?: number;
};

function answer(
  row: RepositoryAttachmentRow,
  alreadyAttached: boolean,
): RepositoryAttachment {
  return {
    repository_id: row.repositoryId,
    status: row.status,
    branch: row.branch,
    commit: row.commit,
    failure: row.failure,
    already_attached: alreadyAttached,
    receipt_id: row.receiptId,
  };
}

/**
 * `attach_repository` (session-repository-attachment.md decision 3): the
 * release's list caps what may be attached, the row records it, and a worker
 * of the session fetches it. No person approves it (owner decision 3);
 * writing to it still waits for a push approval.
 */
export function createRepositoryAttachmentService(deps: {
  store: RepositoryAttachmentStore;
  context: Pick<GitHubGateStore, "context">;
  catalog: SessionCatalog;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds. */
  now?: () => number;
}) {
  const { store, catalog } = deps;
  const pollMs = deps.pollMs ?? ATTACH_POLL_MS;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());

  async function settled(
    sessionId: string,
    row: RepositoryAttachmentRow,
    deadline: number,
  ): Promise<RepositoryAttachmentRow> {
    let current = row;
    while (current.status === "pending" && now() < deadline) {
      await sleep(Math.min(pollMs, deadline - now()));
      // A slow read is cut at the deadline and the last state answered.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        store.find(sessionId, row.repositoryId),
        new Promise<"late">((resolve) => {
          timer = setTimeout(
            () => resolve("late"),
            Math.max(0, deadline - now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (read === "late") break;
      current = read ?? current;
    }
    return current;
  }

  /**
   * What the agent's active release allows besides the session's own, when
   * it is not the release the session runs: a new session of that release
   * could attach these. Never widens what this session
   * may attach.
   */
  async function newerReleaseAllowed(
    sessionId: string,
    context: GitHubSessionContext,
  ) {
    // An `agent` session has no newer release to wait for: its settings are
    // the agent's now.
    if (
      context.release === null ||
      context.policy.source !== "release" ||
      !context.agent?.githubEnabled
    ) {
      return [];
    }
    const active = await store.activeRelease(sessionId);
    if (active === null || active.id === context.release.id) return [];
    return additionalRepositoriesOf(catalog, {
      ...additionalContextOf(context),
      attached: null,
      github: active.github,
      githubEnabled: true,
    });
  }

  return {
    async list(
      rawSessionId: string,
      page: {
        limit?: number | undefined;
        cursor?: string | undefined;
        query?: string | undefined;
      } = {},
    ): Promise<ListRepositoriesResponse> {
      const sessionId = rawSessionId.toLowerCase();
      const context = await deps.context.context(sessionId);
      if (context === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      const nameOf = (id: string, url: string | undefined) =>
        (url === undefined ? null : pathNameOf(url)) ?? id;
      // The row before its status is put in plain words.
      type Listed = Omit<ListedRepository, "meaning">;
      // One row per id, the first one wins: the session's own, then what the
      // session's release allows, then what was attached but is no longer
      // allowed, then what only a newer release allows. The allowed lists may
      // name an id twice, and a cursor would swallow the second row.
      const byId = new Map<string, Listed>();
      const add = (repository: Listed) => {
        if (!byId.has(repository.id)) byId.set(repository.id, repository);
      };
      if (context.repositoryId !== null) {
        const revoked = ownRepositoryRevoked(catalog, context);
        add({
          id: context.repositoryId,
          name: nameOf(context.repositoryId, context.repository?.url),
          branch: context.repository?.branch ?? null,
          status: revoked ? "revoked" : "attached",
          // The working copy stays, but a revoked repository has no remote to
          // name any more.
          ...(revoked ? {} : { remote: "origin" }),
        });
      }
      // Without `attached: null` the cap drops what is not attached yet.
      const allowed = additionalRepositoriesOf(catalog, {
        ...additionalContextOf(context),
        attached: null,
      });
      // Read even when nothing is allowed any more: that is when a row left
      // behind has to show as revoked.
      const rows = new Map(
        (await store.list(sessionId)).map((row) => [row.repositoryId, row]),
      );
      const attached = context.attachedRepositoryIds;
      for (const { id, repository } of allowed) {
        const status =
          rows.get(id)?.status ??
          (attached === null || attached.includes(id)
            ? "attached"
            : "not_attached");
        add({
          id,
          name: nameOf(id, repository.url),
          branch: repository.branch,
          status,
          // The remote is named after the repository id; only an attached
          // one has been given it.
          ...(status === "attached" ? { remote: id } : {}),
        });
      }
      // Attached once, not allowed now: a fetch still pending or failed keeps
      // its own status, anything else is revoked. The catalog may no longer
      // know the repository, so the name falls back to the id.
      for (const id of new Set([...rows.keys(), ...(attached ?? [])])) {
        if (byId.has(id)) continue;
        const row = rows.get(id);
        add({
          id,
          name: nameOf(
            id,
            Object.hasOwn(catalog.repositories, id)
              ? catalog.repositories[id]?.url
              : undefined,
          ),
          branch: row?.branch ?? null,
          status:
            row?.status === "pending" || row?.status === "failed"
              ? row.status
              : "revoked",
        });
      }
      for (const { id, repository } of await newerReleaseAllowed(
        sessionId,
        context,
      )) {
        add({
          id,
          name: nameOf(id, repository.url),
          branch: repository.branch,
          status: "allowed_in_newer_release",
        });
      }
      // Pages walk the ids, never the status: a fetch settling between two
      // calls moves a row's status but not its place.
      const needle = page.query?.toLowerCase();
      const matches = ({ id, name }: Listed) =>
        needle === undefined ||
        id.toLowerCase().includes(needle) ||
        name.toLowerCase().includes(needle);
      const after = page.cursor;
      const rest = [...byId.values()]
        .filter(
          (repository) =>
            matches(repository) &&
            (after === undefined || repository.id > after),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const limit = page.limit ?? LIST_REPOSITORIES_LIMIT_DEFAULT;
      const shown = rest.slice(0, limit);
      return {
        repositories: shown.map((repository) => ({
          ...repository,
          meaning: LISTED_REPOSITORY_MEANING[repository.status],
        })),
        next_cursor:
          rest.length > limit ? (shown[shown.length - 1]?.id ?? null) : null,
      };
    },

    async attach(input: AttachRepositoryInput): Promise<RepositoryAttachment> {
      const deadline = now() + (input.waitMs ?? 0);
      const sessionId = input.sessionId.toLowerCase();
      const { repositoryId } = input;
      const context = await deps.context.context(sessionId);
      if (context === null) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      if (repositoryId === context.repositoryId) {
        return {
          repository_id: repositoryId,
          status: "attached",
          branch: context.repository?.branch ?? null,
          commit: null,
          failure: null,
          already_attached: true,
          receipt_id: null,
        };
      }
      const fields = {
        session_id: sessionId,
        attempt_id: input.attemptId,
        agent_id: context.agent?.id ?? null,
        agent_release_id: context.release?.id ?? null,
        ...githubPolicyReceiptFields(context.policy, context.ceilingRevision),
        repository_id: repositoryId,
      };
      const refuse = async (
        reason: RepositoryAttachRefusal | "attempt_ended",
      ): Promise<never> => {
        const code =
          reason === "attempt_ended" ? "STALE_EPOCH" : "GITHUB_REFUSED";
        const message =
          reason === "attempt_ended"
            ? "The attempt that asked has ended"
            : reason === "allowed_in_newer_release"
              ? `GitHub work refused: ${reason}. The agent's active release allows this repository, but this session keeps the release it started with. A new session (in Slack, a new thread) can attach it; it does not need to be allowed again.`
              : `GitHub work refused: ${reason}`;
        const receiptId = await store.recordRefusal({
          ownerId: context.ownerId,
          sessionId,
          actor: input.actor,
          result: {
            ...fields,
            branch: null,
            commit: null,
            failure: null,
            reason_code: reason,
          },
          error: { code, message },
        });
        throw new SessionServiceError(code, message, undefined, {
          reason_code: reason,
          receipt_id: receiptId,
        });
      };
      // The cap alone, the attached list left out: attaching is what adds
      // to that list.
      const allowed = additionalRepositoryAllowed(
        catalog,
        { ...additionalContextOf(context), attached: null },
        repositoryId,
      );
      if (allowed === null) {
        const newer = await newerReleaseAllowed(sessionId, context);
        return await refuse(
          newer.some(({ id }) => id === repositoryId)
            ? "allowed_in_newer_release"
            : "repository_not_allowed",
        );
      }
      const outcome = await store.request({
        ownerId: context.ownerId,
        sessionId,
        attemptId: input.attemptId,
        repositoryId,
        branch: allowed.branch,
        actor: input.actor,
        result: {
          ...fields,
          branch: allowed.branch,
          commit: null,
          failure: null,
          reason_code: null,
        },
      });
      if (outcome.outcome === "attempt_ended") {
        return await refuse("attempt_ended");
      }
      if (outcome.outcome === "preattached") {
        return {
          repository_id: repositoryId,
          status: "attached",
          branch: allowed.branch,
          commit: null,
          failure: null,
          already_attached: true,
          receipt_id: null,
        };
      }
      const row = await settled(sessionId, outcome.row, deadline);
      return answer(
        row,
        outcome.outcome === "unchanged" && outcome.row.status === "attached",
      );
    },
  };
}

export type RepositoryAttachmentService = ReturnType<
  typeof createRepositoryAttachmentService
>;
