import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_COAUTHOR_EMAILS,
  isSessionPushBranch,
  PUSH_BRANCH_PREFIX,
  type PushReasonCode,
  type PushRefusal,
} from "@werft-ai/contracts";
import type { Pushable } from "../action/ports/git-push.ts";
import type { PushBundlesResult } from "../checkpoints/checkpoint-service.ts";
import type { CommitAttributionLedger } from "../ports/commit-attributions.ts";
import {
  type GitHubGate,
  GitHubGateError,
  type GitHubGrant,
  GitHubUnavailableError,
} from "../ports/github-gate.ts";
import type {
  PushJob,
  PushOutcome,
  PushRequestStore,
} from "../ports/push-requests.ts";
import {
  repositoryBinding,
  repositoryUpstreamOf,
  type SessionCatalog,
} from "./catalog.ts";

/**
 * How long a claim holds its row. The push's git is cut off at
 * `PUSH_DEADLINE_SHARE` of it, so only a dead pusher loses its row, and the
 * rest is slack for clock skew between this host and the database.
 */
export const PUSH_LEASE_MS = 15 * 60_000;
export const PUSH_DEADLINE_SHARE = 0.8;
/** Claims of one request before it is failed instead of taken up again. */
export const PUSH_MAX_ATTEMPTS = 3;
export const PUSH_POLL_INTERVAL_MS = 3_000;

export type PushExecutorLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

export interface PushBundleSource {
  spoolPushBundles(input: {
    directory: string;
    gitCommit: string;
    revision: number;
    sessionId: string;
  }): Promise<PushBundlesResult>;
}

/**
 * The platform's half of a push request (94S-629): takes an approved request,
 * checks it may still go where it was pinned, and pushes exactly its commit to
 * `agent/<session-id>` without force. Every way it ends is a `push` receipt.
 *
 * Only `approved` rows are ever claimed (and `pushing` rows whose pusher died),
 * so a request still waiting, rejected or already finished cannot reach git.
 */
export function createPushExecutor(deps: {
  store: PushRequestStore;
  catalog: SessionCatalog;
  gate: GitHubGate;
  bundles: PushBundleSource;
  pusher: Pushable;
  /**
   * What each claim of a session issued; absent, a push is not checked for
   * attribution (a host that never recorded any).
   */
  attributions?: CommitAttributionLedger;
  logger: PushExecutorLogger;
  leaseMs?: number;
  maxAttempts?: number;
  tempRoot?: string;
}) {
  const { store, catalog, logger } = deps;
  const leaseMs = deps.leaseMs ?? PUSH_LEASE_MS;
  const maxAttempts = deps.maxAttempts ?? PUSH_MAX_ATTEMPTS;

  async function execute(job: PushJob, deadline: number): Promise<PushOutcome> {
    const refuse = (
      refusal: PushRefusal,
      remote?: { remoteUrl: string; remoteRef: string },
      reasonCode?: PushReasonCode,
    ): PushOutcome => ({
      state: "failed",
      refusal,
      ...remote,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
    if (job.attempt > maxAttempts) return refuse("lease_expired");
    const repository = Object.hasOwn(catalog.repositories, job.repositoryId)
      ? catalog.repositories[job.repositoryId]
      : undefined;
    if (
      repository === undefined ||
      job.repositoryBinding === null ||
      repositoryBinding(job.repositoryId, repository) !== job.repositoryBinding
    ) {
      return refuse("catalog_changed");
    }
    const branch = job.targetBranch;
    const remote = {
      remoteUrl: repository.url,
      remoteRef: `refs/heads/${branch}`,
    };
    if (
      !isSessionPushBranch(job.sessionId, branch) ||
      !branch.startsWith(PUSH_BRANCH_PREFIX)
    ) {
      return refuse("target_refused", remote);
    }
    if (branch === repository.branch) return refuse("default_branch", remote);
    let grant: GitHubGrant | null;
    try {
      grant = await deps.gate.grant({
        sessionId: job.sessionId,
        purpose: "push",
        repositoryId: job.repositoryId,
        actor: null,
      });
    } catch (error) {
      if (error instanceof GitHubGateError) {
        return refuse("github_refused", remote, error.reasonCode);
      }
      if (error instanceof GitHubUnavailableError) {
        return refuse("no_push_credential", remote);
      }
      throw error;
    }
    let headers: ReadonlyArray<readonly [string, string]>;
    if (grant !== null) {
      const { defaultBranch } = await grant.api.getRepository();
      if (branch === defaultBranch) return refuse("default_branch", remote);
      headers = repositoryUpstreamOf(repository, grant.gitCredential).headers;
    } else if (repository.auth?.kind === "github_app") {
      return refuse("no_push_credential", remote);
    } else {
      headers = repositoryUpstreamOf(repository).headers;
    }
    if (headers.length === 0) return refuse("no_push_credential", remote);

    const directory = await mkdtemp(
      join(deps.tempRoot ?? tmpdir(), "platform-push-"),
    );
    try {
      const spool = join(directory, "bundles");
      await mkdir(spool);
      const source = await deps.bundles.spoolPushBundles({
        directory: spool,
        gitCommit: job.gitCommit,
        revision: job.checkpointRevision,
        sessionId: job.sessionId,
      });
      if (source.status !== "ready") {
        logger.warn("Push source is unavailable", {
          push_request_id: job.id,
          reason: source.reason,
        });
        return refuse("checkpoint_unavailable", remote);
      }
      const work = join(directory, "git");
      await mkdir(work);
      // Read here, after approval, from what the server issued: also for a
      // push the policy approved with no person looking.
      const expectations =
        deps.attributions === undefined
          ? []
          : await deps.attributions.list(job.sessionId);
      const pushed = await deps.pusher.push({
        ...(expectations.length === 0
          ? {}
          : {
              attribution: {
                expectations,
                stripEmails: [...ENGINE_COAUTHOR_EMAILS],
                baseRef: `refs/heads/${repository.branch}`,
              },
            }),
        directory: work,
        bundles: source.files,
        commit: job.gitCommit,
        remoteUrl: repository.url,
        ref: remote.remoteRef,
        headers,
        deadline,
      });
      if (pushed.status === "refused") {
        logger.warn("Push refused", {
          push_request_id: job.id,
          refusal: pushed.refusal,
          detail: pushed.detail,
        });
        const refusal = refuse(pushed.refusal, remote, pushed.reasonCode);
        return pushed.mismatches === undefined || refusal.state !== "failed"
          ? refusal
          : { ...refusal, mismatches: pushed.mismatches };
      }
      return {
        state: "pushed",
        ...remote,
        previousCommit: pushed.previousCommit,
      };
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }

  /** Runs one claimed request to its end. False when none was waiting. */
  async function runOnce(): Promise<boolean> {
    // Read before the claim, so the deadline cannot trail the lease the
    // database starts at the claim.
    const claimedAt = Date.now();
    const job = await store.claimNextApproved(leaseMs);
    if (job === null) return false;
    let outcome: PushOutcome;
    try {
      outcome = await execute(job, claimedAt + leaseMs * PUSH_DEADLINE_SHARE);
    } catch (error) {
      // A forge or git failure carries no secret in its message
      // (ForgeCredentialError, the pusher's own wording).
      logger.warn("Push failed", {
        push_request_id: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      outcome = { state: "failed", refusal: "push_failed" };
    }
    const finished = await store.finish(job, outcome);
    logger.info(
      finished ? "Push request finished" : "Push request was taken over",
      {
        push_request_id: job.id,
        attempt: job.attempt,
        state: outcome.state,
        ...(outcome.state === "failed" ? { refusal: outcome.refusal } : {}),
      },
    );
    return true;
  }

  /**
   * Polls until stopped. Each replica of the API runs one; the claim's
   * SKIP LOCKED keeps them off each other's rows.
   */
  function start(intervalMs = PUSH_POLL_INTERVAL_MS) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const tick = () => {
      running = (async () => {
        try {
          while (!stopped && (await runOnce())) {}
        } catch (error) {
          logger.warn("Push executor could not claim", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
      })();
    };
    timer = setTimeout(tick, intervalMs);
    return {
      async stop() {
        stopped = true;
        clearTimeout(timer);
        await running;
      },
    };
  }

  return { runOnce, start };
}

export type PushExecutor = ReturnType<typeof createPushExecutor>;
