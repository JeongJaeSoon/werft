import {
  type CommentPullRequestRequest,
  type CommentPullRequestResponse,
  DEFAULT_PULL_REQUEST_COMMENT_MARKER,
  DEFAULT_USER_LOCALE,
  hasStructuredFields,
  isSessionPushBranch,
  type MergePullRequestResponse,
  type OpenPullRequestRequest,
  type OpenPullRequestResponse,
  type OpenPullRequestResult,
  type PullRequestBodySource,
  type PullRequestReceiptResult,
  type PullRequestRefusal,
  type PullRequestState,
  type PullRequestTemplateRecord,
  type PushRequestState,
  type SetPullRequestStateResponse,
  type UpdatePullRequestRequest,
  type UpdatePullRequestResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy } from "../musterrolle/policy.ts";
import {
  ForgeCredentialError,
  type ForgePullRequest,
  type ForgePullRequestDetail,
} from "../ports/forge.ts";
import {
  type GitHubApi,
  GitHubCallError,
  type GitHubGate,
  GitHubGateError,
  type GitHubGrant,
  GitHubUnavailableError,
} from "../ports/github-gate.ts";
import {
  PULL_REQUEST_MAX_ATTEMPTS,
  type PullRequestDrainOutcome,
  type PullRequestJob,
  type PullRequestStageError,
  pullRequestBackoffMs,
} from "../ports/pull-request-drain.ts";
import type { PullRequestSettingsStore } from "../ports/pull-request-settings.ts";
import {
  PULL_REQUEST_REFUSAL_ERRORS,
  type PullRequestOperation,
  type PullRequestReceipt,
  type PullRequestSource,
  type PullRequestStore,
  type ScheduleRef,
} from "../ports/pull-requests.ts";
import type { SessionAttributionStore } from "../ports/session-attribution.ts";
import { repositoryBinding, type SessionCatalog } from "./catalog.ts";
import {
  pullRequestTail,
  pushRequestMarkerOf,
  sessionUrlOf,
  withPullRequestTail,
} from "./git-attribution.ts";
import { renderPullRequestBody } from "./pull-request-body.ts";
import {
  type ResolvedPullRequestSettings,
  resolvePullRequestSettings,
} from "./pull-request-settings.ts";
import {
  type PreparedTemplate,
  prepareTemplateText,
  readRepositoryTemplate,
  type TemplateRead,
  templateRecord,
} from "./pull-request-template.ts";
import {
  cleanBody,
  cleanTitle,
  stripEngineSignatures,
} from "./pull-request-text.ts";
import {
  mayDecidePush,
  type PushActor,
  pushReceiptActor,
  requireVerified,
} from "./push-request-service.ts";
import { requirePermitted, SessionServiceError } from "./session-service.ts";

/** `mergeable_state` values GitHub merges from; anything else is not sent. */
const MERGEABLE_STATES: ReadonlySet<string> = new Set([
  "clean",
  "unstable",
  "has_hooks",
]);

const isForgeFailure = (error: unknown): boolean =>
  error instanceof ForgeCredentialError || error instanceof GitHubCallError;

/** Pull requests read per branch lookup; a full page ends the stage `uncertain`. */
const BRANCH_LOOKUP_LIMIT = 10;

const EMPTY_RESULT: PullRequestReceiptResult = {
  push_request_id: null,
  verdict: "refuse",
  refusal: null,
  repository_id: null,
  number: null,
  url: null,
  head: null,
  base: null,
  created: null,
};

/** The hidden line that tells the platform's comment apart on the forge. */
export function commentMarker(sessionId: string, marker: string): string {
  return `<!-- werft:${sessionId}:${marker} -->`;
}

/**
 * Pull requests (94S-630): a pull request from a pushed request's
 * `agent/<session-id>` into the catalog branch, and a comment on it. Whoever
 * may decide a push may; so may whoever may submit to the session, once the
 * request is pushed. The token comes from the GitHub gate. Every attempt
 * leaves a receipt, and every entry that opens one comes through `open`.
 */
export function createPullRequestService(deps: {
  authorization: AuthorizationPolicy;
  store: PullRequestStore;
  catalog: SessionCatalog;
  gate: GitHubGate;
  /** Applied to each line of caller text before the forge sees it. */
  redact: (line: string) => string;
  /** Who the session's work is attributed to, for the body's tail. */
  attribution: SessionAttributionStore;
  settings: Pick<PullRequestSettingsStore, "get" | "agentOfSession">;
  consoleOrigin: string | null;
  logger: {
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
}) {
  const { authorization, store, catalog, gate, redact, logger } = deps;

  async function settingsFor(ownerId: string, sessionId: string) {
    const [{ settings }, agent] = await Promise.all([
      deps.settings.get(ownerId),
      deps.settings.agentOfSession(ownerId, sessionId),
    ]);
    return resolvePullRequestSettings(settings, agent);
  }

  async function tailFor(
    source: {
      sessionId: string;
      id: string;
      gitCommit: string;
    },
    sessionLink: "url" | "id",
  ): Promise<string> {
    return pullRequestTail({
      sessionId: source.sessionId,
      sessionUrl: sessionUrlOf(deps.consoleOrigin, source.sessionId),
      sessionLink,
      commit: source.gitCommit,
      pushRequestId: source.id,
      record: await deps.attribution.attribution(source.sessionId),
    });
  }

  /**
   * The body to send, tail included, from what the agent gave. Structured
   * fields are laid out on the platform's default template; a legacy `body`
   * is kept as written (cleaned, engine signature lines removed) and none
   * leaves the tail alone. Both entries that write a body come through here.
   */
  async function bodyFor(
    forge: GitHubApi,
    content: {
      body?: string | undefined;
      summary?: string | undefined;
      changes?: string[] | undefined;
      rationale?: string | undefined;
      testing?: string | undefined;
      notes?: string | undefined;
      related?: Parameters<
        typeof renderPullRequestBody
      >[0]["fields"]["related"];
    },
    where: {
      repositoryId: string;
      maxLength: number;
      tail: string;
      settings: ResolvedPullRequestSettings;
    },
  ): Promise<{
    body: string;
    source: PullRequestBodySource;
    template: PullRequestTemplateRecord | null;
  }> {
    if (hasStructuredFields(content)) {
      const { settings } = where;
      const read: TemplateRead | null = settings.readRepository
        ? await readRepositoryTemplate(forge, {
            templateName: settings.templateName,
          })
        : null;
      if (read?.kind === "skipped" && read.error !== undefined) {
        logger.warn("Pull request template not read", { error: read.error });
      }
      let supplied: {
        layer: "agent" | "workspace";
        template: PreparedTemplate;
      } | null = null;
      let suppliedSkip: PullRequestTemplateRecord["skipped"];
      if (read?.kind !== "found" && settings.text !== null) {
        const prepared = prepareTemplateText(settings.text.template);
        if (prepared.ok) {
          supplied = {
            layer: settings.text.layer,
            template: prepared.template,
          };
        } else {
          suppliedSkip =
            prepared.reason === "unsupported"
              ? "unbalanced_comment"
              : prepared.reason;
        }
      }
      const rendered = renderPullRequestBody({
        fields: content,
        locale: DEFAULT_USER_LOCALE,
        tail: where.tail,
        maxLength: where.maxLength,
        redact,
        repository: {
          id: where.repositoryId,
          repositories: catalog.repositories,
        },
        template:
          read?.kind === "found" ? read.template : (supplied?.template ?? null),
      });
      const commit = read === null ? null : (read.commit ?? null);
      const record: PullRequestTemplateRecord =
        read?.kind === "found"
          ? rendered.templateUsed
            ? templateRecord(read)
            : { commit: read.commit, path: read.path, skipped: "too_large" }
          : supplied !== null && !rendered.templateUsed
            ? { commit, skipped: "too_large" }
            : suppliedSkip !== undefined
              ? { commit, skipped: suppliedSkip }
              : read === null
                ? { commit }
                : templateRecord(read);
      const kind = !rendered.templateUsed
        ? "platform"
        : read?.kind === "found"
          ? "repository"
          : (supplied?.layer ?? "workspace");
      return {
        body: rendered.body,
        source: {
          kind,
          ...(record.path === undefined ? {} : { path: record.path }),
          ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
          ...(rendered.relatedDropped === 0
            ? {}
            : { related_dropped: rendered.relatedDropped }),
        },
        template: record,
      };
    }
    return {
      template: null,
      body: withPullRequestTail(
        cleanBody(
          stripEngineSignatures(content.body ?? ""),
          where.maxLength - 2_000,
          redact,
        ),
        where.tail,
      ),
      source: { kind: content.body === undefined ? "platform" : "agent" },
    };
  }

  async function begin<Id extends string | null>(
    actor: PushActor,
    rawSessionId: string,
    // Null for a push intent that has no push request yet.
    rawPushRequestId: Id,
    operation: PullRequestOperation,
  ) {
    requireVerified(actor);
    const sessionId = rawSessionId.toLowerCase();
    const pushRequestId = (
      rawPushRequestId === null ? null : rawPushRequestId.toLowerCase()
    ) as Id;
    const receipt = {
      ownerId: actor.ownerId,
      sessionId,
      pushRequestId,
      actor: pushReceiptActor(actor),
      operation,
    };
    const refuse = async (
      refusal: PullRequestRefusal,
      fields: Partial<PullRequestReceiptResult> = {},
      pushRequestState?: PushRequestState,
      details?: Readonly<Record<string, unknown>>,
    ): Promise<never> => {
      const receiptId = await store.recordReceipt({
        ...receipt,
        result: {
          ...EMPTY_RESULT,
          push_request_id: pushRequestId,
          ...fields,
          verdict: "refuse",
          refusal,
        },
      });
      const { code, message } = PULL_REQUEST_REFUSAL_ERRORS[refusal];
      throw new SessionServiceError(code, message, undefined, {
        ...details,
        refusal,
        receipt_id: receiptId,
        ...(pushRequestState === undefined
          ? {}
          : { push_request_state: pushRequestState }),
        ...(code === "GITHUB_REFUSED"
          ? { reason_code: fields.reason_code ?? refusal }
          : {}),
      });
    };
    const session = { kind: "session", id: sessionId } as const;
    const scopeRefusal = mayDecidePush(actor.principal);
    // As for a push decision, the session's share decides who may act on it;
    // a session the caller cannot see is NOT_FOUND.
    const forbidden = (error: unknown) =>
      error instanceof SessionServiceError && error.code === "FORBIDDEN";
    if (scopeRefusal === null) {
      try {
        await requirePermitted(
          authorization,
          actor.caller,
          "session.approve",
          session,
        );
        return { sessionId, pushRequestId, receipt, refuse, submitter: false };
      } catch (error) {
        if (!forbidden(error)) throw error;
        // The share may let this caller submit without approving.
        try {
          await requirePermitted(
            authorization,
            actor.caller,
            "session.submit",
            session,
          );
        } catch (submitError) {
          throw forbidden(submitError) ? error : submitError;
        }
        return { sessionId, pushRequestId, receipt, refuse, submitter: true };
      }
    }
    // What was pushed is what a person or the release's policy approved; a
    // pull request opens from exactly that branch and commit, so whoever may
    // submit to the session (an agent key included) may open it.
    try {
      await requirePermitted(
        authorization,
        actor.caller,
        "session.submit",
        session,
      );
    } catch (error) {
      if (forbidden(error)) await refuse(scopeRefusal);
      throw error;
    }
    return { sessionId, pushRequestId, receipt, refuse, submitter: true };
  }

  async function forgeFor(
    actor: PushActor,
    source: PullRequestSource,
    refuse: (
      refusal: PullRequestRefusal,
      fields?: Partial<PullRequestReceiptResult>,
    ) => Promise<never>,
    purpose: "pull_request" | "merge" = "pull_request",
  ) {
    const fields = { repository_id: source.repositoryId };
    const entry = Object.hasOwn(catalog.repositories, source.repositoryId)
      ? catalog.repositories[source.repositoryId]
      : undefined;
    if (
      entry === undefined ||
      source.repositoryBinding === null ||
      repositoryBinding(source.repositoryId, entry) !== source.repositoryBinding
    ) {
      return await refuse("catalog_changed", fields);
    }
    let grant: GitHubGrant | null;
    try {
      grant = await gate.grant({
        sessionId: source.sessionId,
        purpose,
        repositoryId: source.repositoryId,
        actor: pushReceiptActor(actor),
      });
    } catch (error) {
      if (error instanceof GitHubGateError) {
        return await refuse("github_refused", {
          ...fields,
          reason_code: error.reasonCode,
        });
      }
      if (error instanceof GitHubUnavailableError) {
        return await refuse("no_forge", fields);
      }
      if (error instanceof ForgeCredentialError) {
        return await refuse("forge_failed", fields);
      }
      throw error;
    }
    if (grant === null) return await refuse("no_forge", fields);
    return { forge: grant.api, base: entry.branch };
  }

  async function pullRequestOf(ownerId: string, source: PullRequestSource) {
    const pullRequest =
      (await store.findPullRequest(ownerId, source.id)) ??
      (source.state === "pushed"
        ? await store.findBranchPullRequest(
            ownerId,
            source.sessionId,
            source.repositoryId,
            source.targetBranch,
          )
        : null);
    const fields = {
      repository_id: source.repositoryId,
      ...(pullRequest === null
        ? {}
        : {
            number: pullRequest.number,
            url: pullRequest.url,
            head: pullRequest.head,
            base: pullRequest.base,
          }),
    };
    return { pullRequest, fields };
  }

  const service = {
    /**
     * `?schedule=true` and the MCP call with a push intent id: holds the
     * content until the push is done (the drain opens the pull request), or
     * answers through `open` when the request is past scheduling. The content
     * is stored as validated; cleaning and rendering happen when it opens.
     */
    async schedule(
      actor: PushActor,
      rawSessionId: string,
      ref: ScheduleRef,
      input: { readBody: () => Promise<OpenPullRequestRequest> },
    ): Promise<OpenPullRequestResult> {
      const requestId = ref.pushRequestId ?? null;
      const { sessionId, receipt, refuse } = await begin(
        actor,
        rawSessionId,
        requestId,
        "open_pull_request",
      );
      const body = await input.readBody();
      const outcome = await store.schedule({
        ownerId: actor.ownerId,
        sessionId,
        ref,
        content: body,
        actor: receipt.actor,
      });
      switch (outcome.kind) {
        case "scheduled":
          return {
            status: "scheduled",
            push_request_id: outcome.pushRequestId,
            push_intent_id:
              outcome.pushIntentId ?? ref.pushIntentId?.toLowerCase() ?? null,
            receipt_id: outcome.receiptId,
          };
        case "open_now":
          return await service.open(actor, sessionId, outcome.pushRequestId, {
            readBody: async () => body,
          });
        case "refused":
          return await refuse(
            outcome.refusal,
            requestId === null ? {} : { push_request_id: requestId },
            outcome.pushRequestState,
            outcome.details,
          );
      }
    },

    async open(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: { readBody: () => Promise<OpenPullRequestRequest> },
    ): Promise<OpenPullRequestResponse> {
      const { sessionId, pushRequestId, receipt, refuse } = await begin(
        actor,
        rawSessionId,
        rawPushRequestId,
        "open_pull_request",
      );
      const body = await input.readBody();
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found");
      const recorded = await store.findPullRequest(actor.ownerId, source.id);
      if (recorded !== null) {
        const receiptId = await store.recordReceipt({
          ...receipt,
          result: {
            push_request_id: source.id,
            verdict: "allow",
            refusal: null,
            repository_id: recorded.repository_id,
            number: recorded.number,
            url: recorded.url,
            head: recorded.head,
            base: recorded.base,
            created: false,
          },
        });
        return {
          pull_request: recorded,
          created: false,
          body_source: null,
          receipt_id: receiptId,
        };
      }
      const fields = { repository_id: source.repositoryId };
      if (source.state !== "pushed") {
        return await refuse("not_pushed", fields, source.state);
      }
      const head = source.targetBranch;
      if (!isSessionPushBranch(source.sessionId, head)) {
        return await refuse("not_pushed", fields, source.state);
      }
      // A stage that ended on a moved head is final; the forge is not asked.
      if (source.prState === "failed" && source.prError === "head_moved") {
        return await refuse(
          "head_moved",
          fields,
          undefined,
          source.prErrorDetails ?? {},
        );
      }
      const { forge, base } = await forgeFor(actor, source, refuse);
      const settings = await settingsFor(actor.ownerId, source.sessionId);
      const tail = await tailFor(source, settings.sessionLink);
      let opened: {
        number: number;
        url: string;
        base: string;
        headSha: string;
        created: boolean;
      };
      const title = cleanTitle(
        body.title ?? `Agent session ${source.sessionId}`,
        redact,
      );
      const written = await bodyFor(forge, body, {
        repositoryId: source.repositoryId,
        maxLength: forge.maxBodyLength,
        tail,
        settings,
      });
      try {
        const found = await forge.findPullRequestForBranch(head);
        // An open one found, or GitHub answering a racing one with 422, is
        // a pull request the platform did not make: the outcome is adopted.
        opened =
          found?.state === "open"
            ? { ...found, created: false }
            : await forge.createPullRequest({
                head,
                base,
                title,
                body: written.body,
              });
      } catch (error) {
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", { ...fields, head, base });
        }
        throw error;
      }
      const { created } = opened;
      // A pull request is recorded only when it holds the pushed commit, as
      // the drain requires, whether it was found, answered to a 422 or just
      // created (the branch may have moved since the push). One that does not
      // is not this push's result, whatever the stage says. A head that is an
      // ancestor of the pushed commit is GitHub's lag, so the caller may ask
      // again; any other head, and a compare that fails, end it.
      if (opened.headSha !== source.gitCommit) {
        const moved = {
          number: opened.number,
          url: opened.url,
          expected_sha: source.gitCommit,
          actual_sha: opened.headSha,
        };
        if (created) {
          // The pull request exists and is not this push's. The stage ends
          // for good, so a person closing it cannot make a retry create
          // another.
          await store.failHeadMoved({
            ownerId: actor.ownerId,
            pushRequestId: source.id,
            details: moved,
          });
        } else {
          let lag = false;
          try {
            lag = await forge.isAncestor(opened.headSha, source.gitCommit);
          } catch (error) {
            if (!isForgeFailure(error)) throw error;
          }
          if (lag) return await refuse("forge_failed", { ...fields, head });
        }
        return await refuse(
          "head_moved",
          { ...fields, head, number: opened.number, url: opened.url },
          undefined,
          moved,
        );
      }
      // A later push request reuses the branch's open pull request; its tail
      // names this push's commit from now on. The pull request is open
      // whether or not this lands, so a failure is only logged.
      if (!created) {
        try {
          await forge.updatePullRequestBody(opened.number, (current) =>
            withPullRequestTail(current, tail),
          );
        } catch (error) {
          logger.warn("Pull request tail not updated", {
            session_id: source.sessionId,
            push_request_id: source.id,
            number: opened.number,
            error: error instanceof Error ? error.name : "error",
          });
        }
      }
      const saved = await store.savePullRequest({
        ...receipt,
        pushRequestId: source.id,
        repositoryId: source.repositoryId,
        number: opened.number,
        url: opened.url,
        title: created ? title : null,
        head,
        base: opened.base,
        created,
        template: created ? written.template : null,
      });
      return {
        pull_request: saved.pullRequest,
        created: saved.created,
        // An adopted pull request keeps the body it has; only its tail moves.
        body_source: created ? written.source : null,
        receipt_id: saved.receiptId,
      };
    },

    /**
     * The drain's way to open the pull request of a pushed request: no
     * caller, no receipt here (the drain's settle writes it with the state
     * change). It looks the branch up in every state before it creates, so
     * a retry after a lost answer finds its own pull request, and compares
     * the forge's head commit with the pushed one before anything is stored.
     * The public `open` stays as it was.
     */
    async openForPushRequest(
      job: PullRequestJob,
      options: { deadline: number },
    ): Promise<PullRequestDrainOutcome> {
      const stop = (
        stage: "failed" | "closed_unrecorded" | "uncertain",
        error: PullRequestStageError,
        details?: Record<string, unknown>,
      ): PullRequestDrainOutcome => ({
        kind: "stop",
        stage,
        error,
        ...(details === undefined ? {} : { details }),
      });
      // A call that may or may not have taken effect is asked again; past
      // the last attempt the platform does not guess.
      const unclear = (
        error: PullRequestStageError,
      ): PullRequestDrainOutcome =>
        job.attempt >= PULL_REQUEST_MAX_ATTEMPTS
          ? stop("uncertain", error)
          : {
              kind: "retry",
              error,
              delayMs: pullRequestBackoffMs(job.attempt),
            };
      // GitHub can report the pull request's old head for a moment after a
      // push. A head that is an ancestor of the pushed commit is that lag, so
      // the stage waits out its backoff; any other commit, a failed compare
      // and the last attempt all end the stage.
      const lagsBehind = async (
        forge: GitHubApi,
        headSha: string,
      ): Promise<boolean> => {
        try {
          return await forge.isAncestor(headSha, job.gitCommit);
        } catch (error) {
          if (!isForgeFailure(error)) throw error;
          return false;
        }
      };
      const headMoved = async (
        forge: GitHubApi,
        seen: { number: number; url: string; headSha: string },
      ): Promise<PullRequestDrainOutcome> => {
        if (
          job.attempt < PULL_REQUEST_MAX_ATTEMPTS &&
          (await lagsBehind(forge, seen.headSha))
        ) {
          return {
            kind: "retry",
            error: "head_moved",
            delayMs: pullRequestBackoffMs(job.attempt),
          };
        }
        return stop("failed", "head_moved", {
          number: seen.number,
          url: seen.url,
          expected_sha: job.gitCommit,
          actual_sha: seen.headSha,
        });
      };
      if (job.attempt > PULL_REQUEST_MAX_ATTEMPTS) {
        return stop("uncertain", "lease_expired");
      }
      const entry = Object.hasOwn(catalog.repositories, job.repositoryId)
        ? catalog.repositories[job.repositoryId]
        : undefined;
      if (
        entry === undefined ||
        job.repositoryBinding === null ||
        repositoryBinding(job.repositoryId, entry) !== job.repositoryBinding
      ) {
        return stop("failed", "catalog_changed");
      }
      const head = job.targetBranch;
      if (!isSessionPushBranch(job.sessionId, head)) {
        return stop("failed", "target_refused");
      }
      let grant: GitHubGrant | null;
      try {
        grant = await gate.grant({
          sessionId: job.sessionId,
          purpose: "pull_request",
          repositoryId: job.repositoryId,
          actor: null,
        });
      } catch (error) {
        if (error instanceof GitHubGateError) {
          return stop("failed", "github_refused", {
            reason_code: error.reasonCode,
          });
        }
        if (error instanceof GitHubUnavailableError) {
          return stop("failed", "no_forge");
        }
        if (error instanceof ForgeCredentialError)
          return unclear("forge_failed");
        throw error;
      }
      if (grant === null) return stop("failed", "no_forge");
      const forge = grant.api;
      const repository = `${grant.repo.owner}/${grant.repo.name}`.toLowerCase();

      let listed: Awaited<ReturnType<typeof forge.findPullRequestsForBranch>>;
      try {
        listed = await forge.findPullRequestsForBranch(head, {
          limit: BRANCH_LOOKUP_LIMIT,
        });
      } catch (error) {
        if (!isForgeFailure(error)) throw error;
        return unclear("lookup_failed");
      }
      // A full page may hide a marked pull request on the next one, and the
      // platform does not guess.
      if (listed.length >= BRANCH_LOOKUP_LIMIT) {
        return stop("uncertain", "lookup_failed", {
          limit: BRANCH_LOOKUP_LIMIT,
        });
      }
      // The marker and the branch name can be written by anyone, so a
      // candidate must also be in this repository, on this head and base.
      const candidates = listed.filter(
        (found) =>
          found.head === head &&
          found.base === entry.branch &&
          found.headRepository === repository,
      );
      const open = candidates.filter((found) => found.state === "open");
      const settings = await settingsFor(job.ownerId, job.sessionId);
      const tail = await tailFor(
        {
          sessionId: job.sessionId,
          id: job.id,
          gitCommit: job.gitCommit,
        },
        settings.sessionLink,
      );
      if (open.length > 1) {
        return stop("uncertain", "duplicate_pull_request", {
          numbers: open.map((found) => found.number),
        });
      }
      const [adopted] = open;
      if (adopted !== undefined) {
        if (adopted.headSha !== job.gitCommit) return headMoved(forge, adopted);
        // A later push request of the session reuses the branch's open
        // pull request; its tail names this push's commit from now on.
        try {
          await forge.updatePullRequestBody(adopted.number, (current) =>
            withPullRequestTail(current, tail),
          );
        } catch (error) {
          logger.warn("Pull request tail not updated", {
            session_id: job.sessionId,
            push_request_id: job.id,
            number: adopted.number,
            error: error instanceof Error ? error.name : "error",
          });
        }
        return {
          kind: "opened",
          pullRequest: {
            number: adopted.number,
            url: adopted.url,
            head,
            base: adopted.base,
            headSha: adopted.headSha,
            title: null,
            created: false,
          },
        };
      }
      // A pull request created while GitHub still showed the old head is
      // this request's too, so a person closing it must not make the next
      // claim create another.
      const marked: typeof candidates = [];
      for (const found of candidates) {
        if (pushRequestMarkerOf(found.body) !== job.id) continue;
        if (
          found.headSha === job.gitCommit ||
          (await lagsBehind(forge, found.headSha))
        ) {
          marked.push(found);
        }
      }
      if (marked.length > 0) {
        return stop("closed_unrecorded", "closed_unrecorded", {
          numbers: marked.map((found) => found.number),
          urls: marked.map((found) => found.url),
          merged: marked.some((found) => found.mergedAt !== null),
        });
      }
      // The body can take several forge reads (the repository template), so
      // it is built first and the lease checked right before the create.
      const title = cleanTitle(
        job.intent?.title ?? `Agent session ${job.sessionId}`,
        redact,
      );
      const written = await bodyFor(forge, job.intent ?? {}, {
        repositoryId: job.repositoryId,
        maxLength: forge.maxBodyLength,
        tail,
        settings,
      });
      // Too little lease left to create and still record it. This attempt
      // created nothing, but the row does not say whether an earlier one
      // reached the create, so even on the last attempt this is a retry: the
      // next claim ends `uncertain` rather than `failed` (a failed stage
      // invites a second request, and a second pull request).
      if (Date.now() >= options.deadline) {
        return { kind: "retry", error: "lease_expired", delayMs: 0 };
      }
      let made: Awaited<ReturnType<typeof forge.createPullRequest>>;
      try {
        made = await forge.createPullRequest({
          head,
          base: entry.branch,
          title,
          body: written.body,
        });
      } catch (error) {
        if (!isForgeFailure(error)) throw error;
        // Unknown whether GitHub took it; the next claim looks first.
        return unclear("forge_failed");
      }
      // A create the forge answered with an existing pull request (422) was
      // found by head alone; it is held to the same repository, head and
      // base as a listed candidate.
      if (made.head !== head || made.base !== entry.branch) {
        return stop("uncertain", "duplicate_pull_request", {
          numbers: [made.number],
          urls: [made.url],
        });
      }
      if (made.headSha !== job.gitCommit) return headMoved(forge, made);
      return {
        kind: "opened",
        pullRequest: {
          number: made.number,
          url: made.url,
          head,
          base: made.base,
          headSha: made.headSha,
          title: made.created ? title : null,
          created: made.created,
          template: made.created ? written.template : null,
        },
      };
    },

    async update(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: { readBody: () => Promise<UpdatePullRequestRequest> },
    ): Promise<UpdatePullRequestResponse> {
      const { sessionId, pushRequestId, receipt, refuse, submitter } =
        await begin(
          actor,
          rawSessionId,
          rawPushRequestId,
          "update_pull_request",
        );
      const body = await input.readBody();
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found");
      const { pullRequest, fields } = await pullRequestOf(
        actor.ownerId,
        source,
      );
      if (pullRequest === null) return await refuse("no_pull_request", fields);
      if (submitter && source.state !== "pushed") {
        return await refuse("not_pushed", fields, source.state);
      }
      const { forge } = await forgeFor(actor, source, (refusal, extra) =>
        refuse(refusal, { ...fields, ...extra }),
      );
      let open: Awaited<ReturnType<typeof forge.findPullRequestForBranch>>;
      try {
        open = await forge.findPullRequestForBranch(pullRequest.head);
      } catch (error) {
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", fields);
        }
        throw error;
      }
      if (open?.state !== "open" || open.number !== pullRequest.number) {
        return await refuse("no_pull_request", fields);
      }
      // A title alone leaves the body; anything else writes it again whole.
      const rewrites = body.body !== undefined || hasStructuredFields(body);
      const settings = await settingsFor(actor.ownerId, source.sessionId);
      const written = rewrites
        ? await bodyFor(forge, body, {
            repositoryId: source.repositoryId,
            maxLength: forge.maxBodyLength,
            tail: await tailFor(source, settings.sessionLink),
            settings,
          })
        : null;
      try {
        await forge.updatePullRequestBody(
          pullRequest.number,
          (current) => written?.body ?? current,
          body.title === undefined ? undefined : cleanTitle(body.title, redact),
        );
      } catch (error) {
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", fields);
        }
        throw error;
      }
      const receiptId = await store.recordReceipt({
        ...receipt,
        pushRequestId: source.id,
        result: {
          ...EMPTY_RESULT,
          ...fields,
          push_request_id: source.id,
          verdict: "allow",
          created: false,
          ...(written?.template == null ? {} : { template: written.template }),
        },
      });
      return {
        pull_request: pullRequest,
        body_source: written?.source ?? null,
        receipt_id: receiptId,
      };
    },

    /**
     * Closes or reopens the pull request recorded for this session's push
     * request, under the same rules as `update`. Already in that state is
     * an answer, not a refusal.
     */
    async setState(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      state: PullRequestState,
    ): Promise<SetPullRequestStateResponse> {
      const { sessionId, pushRequestId, receipt, refuse, submitter } =
        await begin(
          actor,
          rawSessionId,
          rawPushRequestId,
          state === "closed" ? "close_pull_request" : "reopen_pull_request",
        );
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found");
      const { pullRequest, fields } = await pullRequestOf(
        actor.ownerId,
        source,
      );
      if (pullRequest === null) return await refuse("no_pull_request", fields);
      if (submitter && source.state !== "pushed") {
        return await refuse("not_pushed", fields, source.state);
      }
      const { forge } = await forgeFor(actor, source, (refusal, extra) =>
        refuse(refusal, { ...fields, ...extra }),
      );
      let before: ForgePullRequest;
      try {
        before = (await forge.getPullRequest(pullRequest.number)).pullRequest;
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await refuse(
            error.status === 404 ? "no_pull_request" : "forge_failed",
            fields,
          );
        }
        throw error;
      }
      if (before.head !== pullRequest.head) {
        return await refuse("no_pull_request", fields);
      }
      if (before.mergedAt !== null) {
        return await refuse("pull_request_merged", {
          ...fields,
          state: before.state,
        });
      }
      let after = before.state;
      if (before.state !== state) {
        try {
          after = (await forge.setPullRequestState(pullRequest.number, state))
            .state;
        } catch (error) {
          // A reopen GitHub refuses (its branch is gone, or the branch has
          // another open pull request) lands here too.
          if (error instanceof ForgeCredentialError) {
            return await refuse("forge_failed", {
              ...fields,
              state: before.state,
            });
          }
          throw error;
        }
      }
      const changed = after !== before.state;
      const record = changed
        ? (input: PullRequestReceipt) =>
            store.recordStateChange({ ...input, url: pullRequest.url })
        : (input: PullRequestReceipt) => store.recordReceipt(input);
      const receiptId = await record({
        ...receipt,
        pushRequestId: source.id,
        result: {
          ...EMPTY_RESULT,
          ...fields,
          push_request_id: source.id,
          verdict: "allow",
          created: false,
          state: after,
          changed,
        },
      });
      return {
        pull_request: pullRequest,
        state: after,
        changed,
        receipt_id: receiptId,
      };
    },

    /**
     * Squash-merges the pull request of this session's push request, on the
     * commit that push request pushed. The gate refuses before GitHub is
     * called when the workspace has not allowed merging.
     */
    async merge(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
    ): Promise<MergePullRequestResponse> {
      const { sessionId, pushRequestId, receipt, refuse } = await begin(
        actor,
        rawSessionId,
        rawPushRequestId,
        "merge_pull_request",
      );
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found");
      const { pullRequest, fields } = await pullRequestOf(
        actor.ownerId,
        source,
      );
      if (pullRequest === null) return await refuse("no_pull_request", fields);
      if (source.state !== "pushed") {
        return await refuse("not_pushed", fields, source.state);
      }
      const { forge } = await forgeFor(
        actor,
        source,
        (refusal, extra) => refuse(refusal, { ...fields, ...extra }),
        "merge",
      );
      let before: ForgePullRequestDetail;
      try {
        before = (await forge.getPullRequest(pullRequest.number)).pullRequest;
      } catch (error) {
        if (error instanceof GitHubCallError) {
          return await refuse(
            error.status === 404 ? "no_pull_request" : "forge_failed",
            fields,
          );
        }
        throw error;
      }
      if (before.head !== pullRequest.head) {
        return await refuse("no_pull_request", fields);
      }
      const answer = async (
        merged: { sha: string | null; method: "squash" | null },
        changed: boolean,
      ): Promise<MergePullRequestResponse> => {
        const input: PullRequestReceipt = {
          ...receipt,
          pushRequestId: source.id,
          result: {
            ...EMPTY_RESULT,
            ...fields,
            push_request_id: source.id,
            verdict: "allow",
            created: false,
            state: "closed",
            changed,
            merged: true,
            head_sha: source.gitCommit,
            merge_commit_sha: merged.sha,
            method: merged.method,
          },
        };
        const receiptId = changed
          ? await store.recordStateChange({ ...input, url: pullRequest.url })
          : await store.recordReceipt(input);
        return {
          pull_request: pullRequest,
          merged: true,
          changed,
          head_sha: source.gitCommit,
          merge_commit_sha: merged.sha,
          method: merged.method,
          receipt_id: receiptId,
        };
      };
      if (before.mergedAt !== null) {
        if (before.headSha !== source.gitCommit) {
          return await refuse("head_moved", fields);
        }
        return await answer(
          { sha: before.mergeCommitSha, method: null },
          false,
        );
      }
      if (before.state === "closed") {
        return await refuse("pull_request_closed", fields);
      }
      if (before.headSha !== source.gitCommit) {
        return await refuse("head_moved", fields);
      }
      // GitHub's async merge also merges every open pull request this one is
      // stacked on. The base recorded at open is not proof of no stack (an
      // adopted pull request records the base it had then), so the stack
      // itself is looked for: a base that is another open pull request's head.
      if (before.base !== pullRequest.base) {
        return await refuse("merge_blocked", fields);
      }
      // Refused before a request that GitHub would queue and then fail. The
      // rules themselves are enforced at merge time, with bypass off.
      if (!MERGEABLE_STATES.has(before.mergeableState ?? "")) {
        return await refuse("merge_blocked", fields);
      }
      try {
        if ((await forge.findPullRequestForBranch(before.base)) !== null) {
          return await refuse("merge_blocked", fields);
        }
        const merged = await forge.mergePullRequest({
          number: pullRequest.number,
          sha: source.gitCommit,
        });
        if (!merged.merged) {
          // GitHub reports a cancelled merge and a refused one alike.
          const after = (await forge.getPullRequest(pullRequest.number))
            .pullRequest;
          return await refuse(
            after.headSha === source.gitCommit ? "merge_blocked" : "head_moved",
            fields,
          );
        }
        if (merged.already === true) {
          // Merged by someone between the read and the request, by whatever
          // method: not this call's merge, and only ours if it was our head.
          const after = (await forge.getPullRequest(pullRequest.number))
            .pullRequest;
          if (after.headSha !== source.gitCommit) {
            return await refuse("head_moved", fields);
          }
          return await answer(
            { sha: merged.sha ?? after.mergeCommitSha, method: null },
            false,
          );
        }
        return await answer({ sha: merged.sha, method: "squash" }, true);
      } catch (error) {
        if (error instanceof GitHubCallError) {
          if (error.status === 400 || error.status === 405)
            return await refuse("merge_blocked", fields);
          if (error.status === 409) return await refuse("head_moved", fields);
          if (error.status === 202) {
            // Accepted and still queued when the wait ended: it may have
            // merged since, and may yet. A retry finds it merged.
            const after = await forge
              .getPullRequest(pullRequest.number)
              .then((read) => read.pullRequest)
              .catch(() => null);
            if (
              after !== null &&
              after.mergedAt !== null &&
              after.headSha === source.gitCommit
            ) {
              return await answer(
                { sha: after.mergeCommitSha, method: "squash" },
                true,
              );
            }
          }
          return await refuse(
            error.status === 404 ? "no_pull_request" : "forge_failed",
            fields,
          );
        }
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", fields);
        }
        throw error;
      }
    },

    async comment(
      actor: PushActor,
      rawSessionId: string,
      rawPushRequestId: string,
      input: { readBody: () => Promise<CommentPullRequestRequest> },
    ): Promise<CommentPullRequestResponse> {
      const { sessionId, pushRequestId, receipt, refuse, submitter } =
        await begin(
          actor,
          rawSessionId,
          rawPushRequestId,
          "comment_pull_request",
        );
      const body = await input.readBody();
      const marker = body.marker ?? DEFAULT_PULL_REQUEST_COMMENT_MARKER;
      const source = await store.findSource(
        actor.ownerId,
        sessionId,
        pushRequestId,
      );
      if (source === null) return await refuse("not_found", { marker });
      const found = await pullRequestOf(actor.ownerId, source);
      const { pullRequest } = found;
      const fields = { ...found.fields, marker };
      if (pullRequest === null) return await refuse("no_pull_request", fields);
      if (submitter && source.state !== "pushed") {
        return await refuse("not_pushed", fields, source.state);
      }
      const { forge } = await forgeFor(actor, source, (refusal, extra) =>
        refuse(refusal, { ...fields, ...extra }),
      );
      const hidden = commentMarker(source.sessionId, marker);
      let comment: { id: number; url: string; created: boolean };
      try {
        comment = await forge.upsertComment(
          pullRequest.number,
          hidden,
          cleanBody(
            stripEngineSignatures(body.body),
            forge.maxBodyLength - hidden.length - 2,
            redact,
          ),
        );
      } catch (error) {
        if (error instanceof ForgeCredentialError) {
          return await refuse("forge_failed", fields);
        }
        throw error;
      }
      const receiptId = await store.recordReceipt({
        ...receipt,
        pushRequestId: source.id,
        result: {
          ...EMPTY_RESULT,
          ...fields,
          push_request_id: source.id,
          verdict: "allow",
          created: comment.created,
          comment_id: comment.id,
          comment_url: comment.url,
        },
      });
      return {
        pull_request: pullRequest,
        comment: { ...comment, marker },
        receipt_id: receiptId,
      };
    },
  };
  return service;
}

export type PullRequestService = ReturnType<typeof createPullRequestService>;
