import { done, refused, type ToolHandlers } from "./handler.ts";

/**
 * The built-in `github` server's tools: one line per tool, each a call to the
 * session API's own service function. A new tool adds a line here.
 */
export const GITHUB_TOOL_HANDLERS: ToolHandlers = {
  list_repositories: async ({ services, sessionId }, args) =>
    done(await services.attachments.list(sessionId, args)),

  attach_repository: async (
    { services, sessionId, attemptId, receiptActor, waitLeft },
    { repository_id, wait_seconds },
  ) => {
    const attachment = await services.attachments.attach({
      sessionId,
      attemptId,
      actor: receiptActor,
      repositoryId: repository_id,
      ...waitLeft(wait_seconds),
    });
    return done({ ...attachment, final: attachment.status !== "pending" });
  },

  request_push: async (
    { services, actor, sessionId, attemptId, runningTurn },
    { source_ref, ...body },
  ) => {
    // A push is of what the turn ends with, so a call outside a running
    // turn has nothing to carry: the last saved checkpoint may be behind
    // the workspace. Read before the request, so a refusal handled late
    // cannot mark the turn that started after this one ended.
    const turnId = await runningTurn();
    if (turnId === null) {
      return refused({
        code: "no_running_turn",
        by: "platform",
        retryable: false,
      });
    }
    const asked = await services.pushRequests.requestIntent(actor, sessionId, {
      attemptId,
      turnId,
      body,
      ...(source_ref === undefined ? {} : { sourceRef: source_ref }),
    });
    if (asked.status === "github_disabled") {
      return refused({
        code: "github_disabled",
        by: "policy",
        retryable: false,
      });
    }
    if (asked.status === "source_ref_required") {
      return refused({
        code: "source_ref_required",
        by: "platform",
        retryable: true,
        details: { target_branch: asked.target_branch },
      });
    }
    if (asked.status === "turn_not_running") {
      return refused({
        code: "no_running_turn",
        by: "platform",
        retryable: false,
      });
    }
    return done({
      status: "deferred",
      push_intent_id: asked.intent.id,
      waits_for: "reply_end",
      repository_id: asked.intent.repository_id,
      target_branch: asked.intent.target_branch,
      pull_request: "none",
    });
  },

  // An intent, with no push request yet, can only be scheduled. A push
  // request opens when it is pushed and is scheduled when it is not.
  open_pull_request: async (
    { services, actor, sessionId },
    { push_request_id, push_intent_id, ...body },
  ) => {
    if (push_intent_id !== undefined) {
      return done(
        await services.pullRequests.schedule(
          actor,
          sessionId,
          { pushIntentId: push_intent_id },
          { readBody: async () => body },
        ),
      );
    }
    if (push_request_id === undefined) {
      throw new Error("open_pull_request without an id passed the schema");
    }
    return done(
      await services.pullRequests.schedule(
        actor,
        sessionId,
        { pushRequestId: push_request_id },
        { readBody: async () => body },
      ),
    );
  },

  get_push_request: async (
    { services, actor, sessionId },
    { push_request_id, push_intent_id },
  ) =>
    done(
      await services.pushRequests.snapshot(
        actor,
        sessionId,
        push_intent_id !== undefined
          ? { pushIntentId: push_intent_id }
          : { pushRequestId: push_request_id as string },
      ),
    ),

  get_pull_request: async (
    { services, actor, sessionId },
    { push_request_id },
  ) =>
    done(await services.pullRequests.read(actor, sessionId, push_request_id)),

  update_pull_request: async (
    { services, actor, sessionId },
    { push_request_id, expected_body_sha256, ...body },
  ) =>
    done(
      await services.pullRequests.update(actor, sessionId, push_request_id, {
        readBody: async () => body,
        expectedBodySha256: expected_body_sha256,
      }),
    ),

  comment_pull_request: async (
    { services, actor, sessionId },
    { push_request_id, ...body },
  ) =>
    done(
      await services.pullRequests.comment(actor, sessionId, push_request_id, {
        readBody: async () => body,
      }),
    ),

  close_pull_request: async (
    { services, actor, sessionId },
    { push_request_id },
  ) =>
    done(
      await services.pullRequests.setState(
        actor,
        sessionId,
        push_request_id,
        "closed",
      ),
    ),

  reopen_pull_request: async (
    { services, actor, sessionId },
    { push_request_id },
  ) =>
    done(
      await services.pullRequests.setState(
        actor,
        sessionId,
        push_request_id,
        "open",
      ),
    ),

  merge_pull_request: async (
    { services, actor, sessionId },
    { push_request_id },
  ) =>
    done(await services.pullRequests.merge(actor, sessionId, push_request_id)),

  dispatch_workflow: async ({ services, actor, sessionId }, args) =>
    done(await services.githubWork.dispatch(actor, sessionId, args)),

  get_workflow_run: async (
    { services, actor, sessionId, waitLeft },
    { run_id, wait_seconds },
  ) => {
    const view = await services.githubWork.getRun(
      actor,
      sessionId,
      run_id,
      waitLeft(wait_seconds),
    );
    return done({ ...view, final: view.status === "completed" });
  },

  rerun_workflow: async ({ services, actor, sessionId }, { run_id, ...body }) =>
    done(await services.githubWork.rerun(actor, sessionId, run_id, body)),

  submit_review: async ({ services, actor, sessionId }, { number, ...body }) =>
    done(await services.githubWork.review(actor, sessionId, number, body)),
};
