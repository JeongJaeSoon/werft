import type {
  DispatchWorkflowRequest,
  DispatchWorkflowResponse,
  GitHubCiStatusView,
  GitHubReviewOutcomeMetadata,
  GitHubWorkflowRunView,
  ReceiptActor,
  RerunWorkflowRequest,
  RerunWorkflowResponse,
  SubmitPullRequestReviewRequest,
  SubmitPullRequestReviewResponse,
} from "@werft-ai/contracts";
import { GITHUB_CI_RUNS_MAX } from "@werft-ai/contracts";
import {
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubGateStore,
  type GitHubGrant,
  GitHubUnavailableError,
  type GitHubWork,
  type GitHubWorkContext,
} from "../../github/ports/github-gate.ts";
import {
  type AuthorizationPolicy,
  requirePermitted,
  SessionServiceError,
} from "../../musterrolle/index.ts";
import { cleanBody } from "../change-request/pull-request-text.ts";
import {
  type PushActor,
  pushReceiptActor,
  requireVerified,
} from "../change-request/push-decision.ts";
import type {
  GrantWith,
  PullRequestReadable,
  Reviewable,
  WorkflowRunnable,
} from "../ports/capabilities.ts";
import { ForgeCredentialError } from "../ports/forge.ts";

/** The grant this service holds: workflow runs, and the read and review of one pull request. */
type WorkGrant = GrantWith<
  WorkflowRunnable & Reviewable & Pick<PullRequestReadable, "getPullRequest">
>;

export interface GitHubWorkStore
  extends Pick<GitHubGateStore, "recordReceipt"> {
  /**
   * The `dispatch_workflow` receipt and, when GitHub named the run, its
   * github_workflow_dispatches row, in one transaction.
   */
  recordDispatch(input: {
    context: GitHubWorkContext;
    actor: ReceiptActor;
    result: Record<string, unknown>;
    run: { id: number; workflow: string; ref: string } | null;
  }): Promise<string>;
  /**
   * The succeeded `review_pull_request` receipt and the review's
   * `github_review` outcome, in one transaction.
   */
  recordReview(input: {
    context: GitHubWorkContext;
    actor: ReceiptActor;
    result: Record<string, unknown>;
    review: { id: number; url: string };
    metadata: GitHubReviewOutcomeMetadata;
  }): Promise<string>;
  /**
   * The owner's session and agent that opened pull request `number` of the
   * catalog repository through the platform; null for one it did not.
   */
  pullRequestOpener(
    ownerId: string,
    repositoryId: string,
    number: number,
  ): Promise<{ sessionId: string; agentId: string | null } | null>;
}

/**
 * GitHub work a session asks for beyond push and pull requests: dispatching an allow-listed workflow, reading a run,
 * rerunning one the platform dispatched, reviewing a pull request. Each goes
 * through the gate, which decides and issues; this service calls GitHub and
 * writes the receipt. Neither a receipt nor a log keeps dispatch inputs, a
 * review's body or GitHub's error text.
 */
export function createGitHubWorkService(deps: {
  authorization: AuthorizationPolicy;
  gate: GitHubGate;
  store: GitHubWorkStore;
  /** Redacts one line of a review body, as for a pull request body. */
  redact: (line: string) => string;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in milliseconds. */
  now?: () => number;
}) {
  const { authorization, gate, store, redact } = deps;
  const pollMs = deps.pollMs ?? 1_000;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => performance.now());

  /**
   * `read` after `setup`, again until `done` or until `waitMs`, counted from
   * the start of the call, has passed; the last value read is answered. A
   * read still running at the deadline is dropped.
   */
  async function readUntil<S, T>(
    waitMs: number | undefined,
    setup: () => Promise<S>,
    read: (held: S) => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    const deadline = now() + (waitMs ?? 0);
    // A waiting call must answer by its deadline even when the setup or the
    // first read is slow, and a spent budget (0) is a deadline that has
    // passed; one that asked for no wait (undefined) is left as it was.
    const bounded = async <V>(work: Promise<V>): Promise<V> => {
      if (waitMs === undefined) return await work;
      work.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(unavailable(null)),
              Math.max(0, deadline - now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const held = await bounded(setup());
    let value = await bounded(read(held));
    while (!done(value) && now() < deadline) {
      await sleep(Math.min(pollMs, deadline - now()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = read(held);
      // A read dropped at the deadline must not surface as unhandled.
      pending.catch(() => {});
      const next = await Promise.race([
        pending,
        new Promise<"late">((resolve) => {
          timer = setTimeout(
            () => resolve("late"),
            Math.max(0, deadline - now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (next === "late") break;
      value = next;
    }
    return value;
  }

  async function granted(
    actor: PushActor,
    rawSessionId: string,
    action: "session.read" | "session.submit",
    work: Omit<GitHubWork, "sessionId" | "actor">,
  ): Promise<WorkGrant> {
    requireVerified(actor);
    const sessionId = rawSessionId.toLowerCase();
    await requirePermitted(authorization, actor.caller, action, {
      kind: "session",
      id: sessionId,
    });
    let grant: GitHubGrant | null;
    try {
      grant = await gate.grant({
        ...work,
        sessionId,
        actor: pushReceiptActor(actor),
      });
    } catch (error) {
      if (error instanceof GitHubGateError) {
        throw new SessionServiceError(
          "GITHUB_REFUSED",
          error.message,
          undefined,
          { reason_code: error.reasonCode, receipt_id: error.receiptId },
        );
      }
      if (error instanceof GitHubUnavailableError) {
        throw unavailable(error.receiptId);
      }
      if (error instanceof ForgeCredentialError) {
        throw unavailable(error.receiptId);
      }
      throw error;
    }
    if (grant === null) {
      throw unavailable(null);
    }
    return grant;
  }

  /** What every receipt of this work names, beyond the gate's own fields. */
  const fieldsOf = (grant: WorkGrant) => ({
    session_id: grant.context.sessionId,
    agent_id: grant.context.agentId,
    agent_release_id: grant.context.agentReleaseId,
    ...grant.context.policy,
    repository_id: grant.context.repositoryId,
    allowed_by: grant.allowedBy,
  });

  async function failed(
    grant: WorkGrant,
    actor: PushActor,
    operation: "dispatch_workflow" | "rerun_workflow" | "review_pull_request",
    result: Record<string, unknown>,
    error: GitHubCallError,
  ): Promise<never> {
    const receiptId = await store.recordReceipt({
      ownerId: grant.context.ownerId,
      sessionId: grant.context.sessionId,
      actor: pushReceiptActor(actor),
      operation,
      status: "failed",
      result: {
        ...fieldsOf(grant),
        ...result,
        status: error.status,
        github_request_id: error.requestId,
      },
      error: null,
    });
    throw unavailable(receiptId);
  }

  return {
    async dispatch(
      actor: PushActor,
      sessionId: string,
      body: DispatchWorkflowRequest,
    ): Promise<DispatchWorkflowResponse> {
      const grant = await granted(actor, sessionId, "session.submit", {
        purpose: "dispatch",
        workflow: { file: body.workflow, ref: body.ref },
      });
      const inputs = body.inputs ?? {};
      const result = {
        workflow: body.workflow,
        ref: body.ref,
        // The names only: a value may be anything the caller chose.
        input_keys: Object.keys(inputs).sort(),
      };
      let run: { id: number; html_url: string } | null;
      try {
        run = await grant.api.dispatchWorkflow({
          workflow: body.workflow,
          ref: body.ref,
          inputs,
        });
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await failed(grant, actor, "dispatch_workflow", result, error);
        }
        throw error;
      }
      const receiptId = await store.recordDispatch({
        context: grant.context,
        actor: pushReceiptActor(actor),
        result: {
          ...fieldsOf(grant),
          ...result,
          run_id: run?.id ?? null,
        },
        run:
          run === null
            ? null
            : { id: run.id, workflow: body.workflow, ref: body.ref },
      });
      return { receipt_id: receiptId, run };
    },

    /**
     * With `waitSeconds`, reads again until the run is `completed` or the
     * seconds, counted from the start of the call, have passed; the last run
     * read is answered. A read still running at the deadline is dropped.
     */
    async getRun(
      actor: PushActor,
      sessionId: string,
      runId: number,
      options: { waitMs?: number; repository?: string } = {},
    ): Promise<GitHubWorkflowRunView> {
      return await readUntil(
        options.waitMs,
        () =>
          granted(actor, sessionId, "session.read", {
            purpose: "actions_read",
            ...named(options.repository),
          }),
        (grant) => readGitHub(() => grant.api.getWorkflowRun(runId)),
        (run) => run.status === "completed",
      );
    },

    /**
     * The check runs and workflow runs of a commit, named by its sha or as
     * the head of pull request `number`, of the session's repository or the
     * one `repository` (`owner/name`) names. Waits as `getRun` does, until
     * `ciStatusFinal`. Each grant is a read of that one repository.
     */
    async ciStatus(
      actor: PushActor,
      sessionId: string,
      target: { pullRequestNumber: number } | { commitSha: string },
      options: { waitMs?: number; repository?: string } = {},
    ): Promise<GitHubCiStatusView> {
      const pullRequestNumber =
        "pullRequestNumber" in target ? target.pullRequestNumber : null;
      return await readUntil(
        options.waitMs,
        async () => {
          // CI's own switch is judged before the pull request is read.
          const grant = await granted(actor, sessionId, "session.read", {
            purpose: "actions_read",
            ...named(options.repository),
          });
          if ("commitSha" in target) return { grant, sha: target.commitSha };
          // The repository the CI grant resolved, so both reads are of one.
          const pullRequests = await granted(actor, sessionId, "session.read", {
            purpose: "pull_request_read",
            ...(grant.context.repositoryId === null
              ? {}
              : { repositoryId: grant.context.repositoryId }),
          });
          const { pullRequest } = await readGitHub(() =>
            pullRequests.api.getPullRequest(target.pullRequestNumber),
          );
          return { grant, sha: pullRequest.headSha };
        },
        async ({ grant, sha }) => {
          const ci = await readGitHub(
            () => grant.api.getCommitCi(sha, GITHUB_CI_RUNS_MAX),
            // GitHub answers the check runs of a sha it holds no commit for so.
            { unknownCommit: { status: 422, what: "check run lookup" } },
          );
          return {
            head_sha: sha,
            pull_request_number: pullRequestNumber,
            check_runs: ci.checkRuns,
            workflow_runs: ci.workflowRuns,
            truncated: ci.truncated,
          };
        },
        ciStatusFinal,
      );
    },

    async rerun(
      actor: PushActor,
      sessionId: string,
      runId: number,
      body: RerunWorkflowRequest,
    ): Promise<RerunWorkflowResponse> {
      const grant = await granted(actor, sessionId, "session.submit", {
        purpose: "rerun",
        runId,
      });
      const failedOnly = body.failed_only ?? false;
      const result = {
        run_id: runId,
        failed_only: failedOnly,
        workflow: grant.allowedBy?.workflow ?? null,
      };
      try {
        await grant.api.rerunWorkflow(runId, failedOnly);
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await failed(grant, actor, "rerun_workflow", result, error);
        }
        throw error;
      }
      const receiptId = await store.recordReceipt({
        ownerId: grant.context.ownerId,
        sessionId: grant.context.sessionId,
        actor: pushReceiptActor(actor),
        operation: "rerun_workflow",
        status: "succeeded",
        result: { ...fieldsOf(grant), ...result },
        error: null,
      });
      return { receipt_id: receiptId };
    },

    /**
     * A review with the reviewer App.
     * The platform does not refuse a review of a pull request the same
     * agent opened; the receipt names both sides so it can be found later.
     */
    async review(
      actor: PushActor,
      sessionId: string,
      number: number,
      body: SubmitPullRequestReviewRequest,
    ): Promise<SubmitPullRequestReviewResponse> {
      const grant = await granted(actor, sessionId, "session.submit", {
        purpose: "review",
        review: { number, commitId: body.commit_id, event: body.event },
      });
      const opener = await store.pullRequestOpener(
        grant.context.ownerId,
        grant.context.repositoryId,
        number,
      );
      const { allowed_by: _none, ...fields } = fieldsOf(grant);
      // Never the review's body: it is whatever the caller wrote.
      const result = {
        ...fields,
        number,
        commit_id: body.commit_id,
        event: body.event,
        opened_by_session_id: opener?.sessionId ?? null,
        opened_by_agent_id: opener?.agentId ?? null,
      };
      let review: { id: number; html_url: string };
      try {
        const { pullRequest } = await grant.api.getPullRequest(number);
        // GitHub also pins the review to `commit_id`, so a head that moves
        // after this read cannot land the review on another commit; this
        // check refuses the review of a commit that is no longer the head.
        if (pullRequest.headSha !== body.commit_id) {
          const receiptId = await store.recordReceipt({
            ownerId: grant.context.ownerId,
            sessionId: grant.context.sessionId,
            actor: pushReceiptActor(actor),
            operation: "review_pull_request",
            status: "failed",
            result: { ...result, reason_code: "stale_commit" },
            error: null,
          });
          throw new SessionServiceError(
            "GITHUB_REFUSED",
            "The pull request head is not the commit to review",
            undefined,
            {
              reason_code: "stale_commit",
              receipt_id: receiptId,
              head_sha: pullRequest.headSha,
            },
          );
        }
        review = await grant.api.submitReview({
          number,
          commitId: body.commit_id,
          event: body.event,
          ...(body.body === undefined
            ? {}
            : { body: cleanBody(body.body, grant.api.maxBodyLength, redact) }),
        });
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await failed(
            grant,
            actor,
            "review_pull_request",
            result,
            error,
          );
        }
        throw error;
      }
      const receiptId = await store.recordReview({
        context: grant.context,
        actor: pushReceiptActor(actor),
        result: { ...result, review_id: review.id },
        review: { id: review.id, url: review.html_url },
        metadata: {
          number,
          event: body.event,
          commit_id: body.commit_id,
          opened_by_session_id: opener?.sessionId ?? null,
        },
      });
      return { receipt_id: receiptId, review };
    },
  };
}

const named = (repository: string | undefined) =>
  repository === undefined ? {} : { repositoryName: repository };

/**
 * A read of GitHub: what GitHub does not know (404, or the status a read
 * answers a commit it does not hold with) is not found.
 */
async function readGitHub<T>(
  read: () => Promise<T>,
  options: { unknownCommit?: { status: number; what: string } } = {},
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof GitHubCallError) {
      const { unknownCommit } = options;
      if (
        error.status === 404 ||
        (unknownCommit !== undefined &&
          error.status === unknownCommit.status &&
          error.what === unknownCommit.what)
      ) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      throw unavailable(null);
    }
    throw error;
  }
}

/**
 * Some run is reported, every one is completed, and none is left out: a
 * truncated list may hide one still running.
 */
export function ciStatusFinal(view: GitHubCiStatusView): boolean {
  const runs = [...view.check_runs, ...view.workflow_runs];
  return (
    !view.truncated &&
    runs.length > 0 &&
    runs.every((run) => run.status === "completed")
  );
}

function unavailable(receiptId: string | null): SessionServiceError {
  return new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "GitHub did not take the call",
    undefined,
    receiptId === null ? null : { receipt_id: receiptId },
  );
}

export type GitHubWorkService = ReturnType<typeof createGitHubWorkService>;
