import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import {
  GITHUB_APP_ROLE_VALUES,
  type GitHubAppPermissions,
  type GitHubAppRole,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  type ForgeComment,
  ForgeCredentialError,
  type ForgePullRequest,
  type ForgePullRequestWithBody,
  GITHUB_API_BASE,
  type GitCredential,
  type GitHubApi,
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppManifestConversion,
  type GitHubAppOwner,
  type GitHubAppStore,
  GitHubCallError,
  type GitHubConnection,
  type GitHubConnections,
  type GitHubInstallationRepository,
  GitHubPermissionError,
  type GitHubPermissions,
  type GitHubRateLimit,
  type GitHubWorkflowRun,
  type GitTreeEntry,
  type RegisteredGitHubConnection,
  type RepoRef,
  repoKeyOf,
  type SessionCatalog,
} from "@werft-ai/platform";

/**
 * A cached token is re-issued once it has less than this left, so a
 * request the proxy starts with it has time to finish.
 */
export const REFRESH_BEFORE_EXPIRY_MS = 10 * 60_000;
/** GitHub's limit on a pull request or comment body, in characters. */
const GITHUB_MAX_BODY_LENGTH = 65_536;
export const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_COMMENT_PAGES = 10;
const COMMENTS_PER_PAGE = 100;

type GitHubCredentials = {
  kind: "app";
  appId: number;
  /** Absent: the installation GitHub reports for each repository. */
  installationId?: number;
  privateKey: string;
};

type Logger = Pick<StructuredLogger, "warn">;

const GitHubClient = Octokit.plugin(retry, throttling);
type Client = InstanceType<typeof GitHubClient>;

// Throttling's notification and write pacing waits between POSTs; tests that
// drive many writes turn it off with a group that schedules at once.
const unpaced = {
  key: () => ({
    schedule: (
      _options: unknown,
      task: (...args: unknown[]) => unknown,
      ...args: unknown[]
    ) => task(...args),
  }),
} as never;

function clientOf(
  apiBase: string,
  logger: Logger | undefined,
  pacing: { retryAfterBaseMs?: number; paced?: boolean },
): Client {
  const onLimit =
    (limit: string) =>
    (
      retryAfter: number,
      options: { method?: string; url?: string },
      _octokit: unknown,
      retryCount: number,
    ) => {
      const retrying =
        retryCount < RATE_LIMIT_RETRIES &&
        retryAfter <= RATE_LIMIT_MAX_WAIT_SECONDS;
      // `url` is the route template: it never carries a token.
      logger?.warn("GitHub rate limit", {
        limit,
        request: `${options.method} ${options.url}`,
        retry_after_seconds: retryAfter,
        retrying,
      });
      return retrying;
    };
  return new GitHubClient({
    baseUrl: apiBase,
    userAgent: "Werft",
    // Octokit's own log would print request errors with their headers.
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: {
      fetch: (url: string, init: RequestInit) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    },
    // 429 is left to throttling, which waits the time GitHub names; this
    // plugin's own backoff would not.
    retry: {
      retries: RATE_LIMIT_RETRIES,
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
      ...(pacing.retryAfterBaseMs === undefined
        ? {}
        : { retryAfterBaseValue: pacing.retryAfterBaseMs }),
    },
    throttle: {
      onRateLimit: onLimit("primary"),
      onSecondaryRateLimit: onLimit("secondary"),
      ...(pacing.retryAfterBaseMs === undefined
        ? {}
        : { retryAfterBaseValue: pacing.retryAfterBaseMs }),
      ...(pacing.paced === false
        ? { write: unpaced, notifications: unpaced }
        : {}),
    },
  });
}

type ConnectionOptions = {
  apiBase: string;
  credentials: GitHubCredentials;
  now?: () => Date;
  logger?: Logger;
  /** Tests only: scale of a retry or rate-limit wait (GitHub's is seconds). */
  retryAfterBaseMs?: number;
  /** Tests only: false drops the pause between writes. */
  paced?: boolean;
};

/**
 * One GitHub connection: an App on github.com or a GHES host
 * (`apiBase` its `/api/v3`), with its own token cache. An App issues an
 * installation token per repository and permission set, scoped to that one
 * repository. Only the GitHub gate asks it for a
 * credential; the REST calls take the one the gate issued.
 */
export function createGitHubConnection(
  options: ConnectionOptions,
): GitHubConnection {
  const apiBase = options.apiBase.replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  const { logger, credentials } = options;
  const client = clientOf(apiBase, logger, options);
  // One request each, for the outcome refresher: its budget counts every
  // send, and a rate limit stops the unit rather than waiting here.
  const once = new Octokit({
    baseUrl: apiBase,
    userAgent: "Werft",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: {
      fetch: (url: string, init: RequestInit) =>
        fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    },
  });
  const { issue, installationOf } = issuer(client, credentials, logger);
  const cached = new Map<string, GitCredential>();
  const inFlight = new Map<string, Promise<GitCredential>>();

  async function credential(
    repo: RepoRef,
    permissions: GitHubPermissions,
  ): Promise<{ credential: GitCredential; fresh: boolean }> {
    const key = `${repo.owner}/${repo.name}|${Object.entries(permissions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, level]) => `${name}:${level}`)
      .join(",")}`;
    const held = cached.get(key);
    if (
      held !== undefined &&
      (held.expiresAt === undefined ||
        held.expiresAt.getTime() - now().getTime() > REFRESH_BEFORE_EXPIRY_MS)
    ) {
      return { credential: held, fresh: false };
    }
    const pending = inFlight.get(key);
    if (pending !== undefined) {
      return { credential: await pending, fresh: false };
    }
    const issuing = issue(repo, permissions).finally(() =>
      inFlight.delete(key),
    );
    inFlight.set(key, issuing);
    const issued = await issuing;
    cached.set(key, issued);
    return { credential: issued, fresh: credentials.kind === "app" };
  }

  const queues = new Map<string, Promise<unknown>>();
  function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
    const turn = (queues.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(run);
    queues.set(key, turn);
    void turn
      .finally(() => {
        if (queues.get(key) === turn) queues.delete(key);
      })
      .catch(() => undefined);
    return turn;
  }

  // Anyone can paste a marker into a comment, so only one this credential
  // wrote is the platform's: the App's own.
  async function writtenByUs(comment: {
    user?: { id: number | bigint } | null | undefined;
    performed_via_github_app?: { id: number | bigint } | null | undefined;
  }): Promise<boolean> {
    const app = comment.performed_via_github_app;
    return app != null && Number(app.id) === credentials.appId;
  }

  function api(repo: RepoRef, issued: GitCredential): GitHubApi {
    const headers = { authorization: `token ${issued.password}` };
    const target = { owner: repo.owner, repo: repo.name };
    async function call<T>(what: string, send: () => Promise<T>): Promise<T> {
      try {
        return await send();
      } catch (error) {
        throw failure(logger, what, error);
      }
    }
    // The work added with the gate: its errors keep GitHub's status and
    // request id only, never the body, which may echo what was sent.
    async function quiet<T>(what: string, send: () => Promise<T>): Promise<T> {
      try {
        return await send();
      } catch (error) {
        const status = statusOf(error) ?? null;
        const requestId = requestIdOf(error);
        logger?.warn("GitHub request failed", {
          request: what,
          ...(status === null ? {} : { status }),
          error: error instanceof Error ? error.name : "response",
          ...(requestId === null ? {} : { github_request_id: requestId }),
        });
        throw new GitHubCallError(what, status, requestId);
      }
    }
    async function findPullRequestForBranch(
      branch: string,
    ): Promise<ForgePullRequest | null> {
      const { data } = await call("pull request lookup", () =>
        client.request("GET /repos/{owner}/{repo}/pulls", {
          ...target,
          head: `${repo.owner}:${branch}`,
          state: "open",
          sort: "created",
          direction: "desc",
          per_page: 1,
          headers,
        }),
      );
      const [found] = data;
      return found === undefined ? null : pullRequestOf(found);
    }
    async function findPullRequestsForBranch(
      branch: string,
      options?: { limit?: number },
    ): Promise<ForgePullRequestWithBody[]> {
      const { data } = await call("pull request lookup", () =>
        client.request("GET /repos/{owner}/{repo}/pulls", {
          ...target,
          head: `${repo.owner}:${branch}`,
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: Math.min(Math.max(options?.limit ?? 10, 1), 100),
          headers,
        }),
      );
      return data.map((found) => ({
        ...pullRequestOf(found),
        body: found.body ?? "",
        headRepository: found.head.repo?.full_name.toLowerCase() ?? null,
      }));
    }
    // Routes octokit's types do not know yet (return_run_details).
    const request = client.request as unknown as (
      route: string,
      parameters: Record<string, unknown>,
    ) => Promise<{ status: number; data: unknown }>;

    return {
      maxBodyLength: GITHUB_MAX_BODY_LENGTH,
      async getRepository() {
        const { data } = await quiet("repository lookup", () =>
          client.request("GET /repos/{owner}/{repo}", { ...target, headers }),
        );
        return {
          id: Number(data.id),
          defaultBranch: data.default_branch,
          private: data.private,
        };
      },
      async getBranchHead(branch) {
        const { data } = await quiet("branch read", () =>
          client.request("GET /repos/{owner}/{repo}/branches/{branch}", {
            ...target,
            branch,
            headers,
          }),
        );
        const treeSha = data.commit.commit.tree.sha;
        if (
          typeof data.commit.sha !== "string" ||
          typeof treeSha !== "string"
        ) {
          throw new GitHubCallError("branch read", null, null);
        }
        return { commitSha: data.commit.sha, treeSha };
      },
      async readTree(treeSha) {
        const { data } = await quiet("tree read", () =>
          client.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
            ...target,
            tree_sha: treeSha,
            headers,
          }),
        );
        const entries: GitTreeEntry[] = [];
        for (const item of data.tree) {
          if (
            item.path === undefined ||
            item.mode === undefined ||
            item.sha === undefined ||
            (item.type !== "blob" &&
              item.type !== "tree" &&
              item.type !== "commit")
          ) {
            continue;
          }
          entries.push({
            name: item.path,
            mode: item.mode,
            type: item.type,
            sha: item.sha,
            size: typeof item.size === "number" ? item.size : null,
          });
        }
        return { entries, truncated: data.truncated === true };
      },
      async readBlob(blobSha) {
        const { data } = await quiet("blob read", () =>
          client.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
            ...target,
            file_sha: blobSha,
            headers,
          }),
        );
        if (data.encoding !== "base64") {
          throw new GitHubCallError("blob read", null, null);
        }
        return Uint8Array.from(Buffer.from(data.content, "base64"));
      },
      findPullRequestForBranch,
      findPullRequestsForBranch,
      async isAncestor(ancestor, descendant) {
        const { data } = await call("commit comparison", () =>
          client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
            ...target,
            basehead: `${ancestor}...${descendant}`,
            per_page: 1,
            headers,
          }),
        );
        return data.status === "ahead" || data.status === "identical";
      },
      async createPullRequest(input) {
        try {
          const { data } = await client.request(
            "POST /repos/{owner}/{repo}/pulls",
            {
              ...target,
              head: input.head,
              base: input.base,
              title: input.title,
              body: input.body,
              headers,
            },
          );
          return { ...pullRequestOf(data), created: true };
        } catch (error) {
          // 422: an open pull request for this head already exists, as when
          // two callers race; answer that one.
          if (statusOf(error) === 422) {
            const open = await findPullRequestForBranch(input.head);
            if (open?.state === "open") return { ...open, created: false };
          }
          throw failure(logger, "pull request create", error);
        }
      },
      async getPullRequest(number) {
        try {
          const { data, headers: answered } = await once.request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}",
            { ...target, pull_number: number, headers },
          );
          return {
            pullRequest: {
              ...pullRequestOf(data),
              title: data.title,
              mergeCommitSha: data.merged_at ? data.merge_commit_sha : null,
              mergeableState: data.mergeable_state ?? null,
              additions: countOf(data.additions),
              deletions: countOf(data.deletions),
              changedFiles: countOf(data.changed_files),
              commits: countOf(data.commits),
            },
            rateLimit: rateLimitOf(answered),
          };
        } catch (error) {
          const status = statusOf(error) ?? null;
          const requestId = requestIdOf(error);
          logger?.warn("GitHub request failed", {
            request: "pull request read",
            ...(status === null ? {} : { status }),
            error: error instanceof Error ? error.name : "response",
            ...(requestId === null ? {} : { github_request_id: requestId }),
          });
          throw new GitHubCallError(
            "pull request read",
            status,
            requestId,
            rateLimitOf(
              (error as { response?: { headers?: Record<string, unknown> } })
                ?.response?.headers,
            ),
          );
        }
      },
      async updatePullRequestBody(number, edit, title) {
        await call("pull request update", async () => {
          const { data } = await client.request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}",
            { ...target, pull_number: number, headers },
          );
          const body = edit(data.body ?? "");
          const rebodied = body !== (data.body ?? "");
          const retitled = title !== undefined && title !== data.title;
          if (!rebodied && !retitled) return;
          await client.request(
            "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
            {
              ...target,
              pull_number: number,
              ...(rebodied ? { body } : {}),
              ...(retitled ? { title } : {}),
              headers,
            },
          );
        });
      },
      async mergePullRequest({ number, sha }) {
        // Not PUT .../merge: that one lets an actor on a ruleset's bypass list
        // through, and has no way to refuse it. This one bypasses only when
        // asked, so the answer to bypass_rules is ours, not the App's setup.
        const sent = await quiet("pull request merge", () =>
          request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge-async", {
            ...target,
            pull_number: number,
            merge_method: "squash",
            merge_action: "direct_merge",
            bypass_rules: false,
            sha,
            headers,
            // A 409 is an answer here, not a failure to retry.
            request: { retries: 0 },
          }).catch((error: unknown) => {
            // 409 is the request already pending, answered with its options.
            if (statusOf(error) !== 409) throw error;
            const { response } = error as { response?: { data?: unknown } };
            return { status: 409, data: response?.data };
          }),
        );
        const first = mergeAsyncOf(sent.data);
        if (first === null)
          throw new GitHubCallError("pull request merge", null, null);
        if (first.status !== "pending") return mergedOf(first);
        // Someone else's pending request may carry other options.
        if (!first.ours(sha)) return { merged: false, sha: null };
        const pause = options.retryAfterBaseMs ?? MERGE_POLL_MS;
        for (let poll = 0; poll < MERGE_POLLS; poll += 1) {
          await new Promise((resolve) => setTimeout(resolve, pause));
          const result = await quiet("pull request merge result", () =>
            request(
              "GET /repos/{owner}/{repo}/pulls/{pull_number}/merge-async/{uuid}",
              { ...target, pull_number: number, uuid: first.uuid, headers },
            ),
          );
          const polled = mergeAsyncOf(result.data);
          if (polled === null) {
            throw new GitHubCallError("pull request merge result", null, null);
          }
          if (polled.status !== "pending") return mergedOf(polled);
        }
        // Still queued: it may yet merge, and the next call finds it merged.
        throw new GitHubCallError("pull request merge", 202, null);
      },
      async setPullRequestState(number, state) {
        const { data } = await call("pull request state", () =>
          client.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
            ...target,
            pull_number: number,
            state,
            headers,
          }),
        );
        return pullRequestOf(data);
      },
      async upsertComment(number, marker, body): Promise<ForgeComment> {
        const text = `${body}\n\n${marker}`;
        // Two first comments for one marker would both find none and both
        // post; one at a time per marker in this process.
        return await oneAtATime(
          `${repo.owner}/${repo.name}#${number}|${marker}`,
          () =>
            call("pull request comment", async () => {
              let searched = false;
              for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
                const { data } = await client.request(
                  "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
                  {
                    ...target,
                    issue_number: number,
                    per_page: COMMENTS_PER_PAGE,
                    page,
                    headers,
                  },
                );
                let marked: (typeof data)[number] | undefined;
                for (const comment of data) {
                  if (
                    comment.body?.includes(marker) &&
                    (await writtenByUs(comment))
                  ) {
                    marked = comment;
                    break;
                  }
                }
                if (marked !== undefined) {
                  const { data: edited } = await client.request(
                    "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
                    {
                      ...target,
                      comment_id: Number(marked.id),
                      body: text,
                      headers,
                    },
                  );
                  return {
                    id: Number(edited.id),
                    url: edited.html_url,
                    created: false,
                  };
                }
                if (data.length < COMMENTS_PER_PAGE) {
                  searched = true;
                  break;
                }
              }
              // Past the pages read the marked comment may still exist; a new
              // one would duplicate it.
              if (!searched) {
                throw new ForgeCredentialError(
                  `GitHub pull request comment failed (more than ${MAX_COMMENT_PAGES * COMMENTS_PER_PAGE} comments)`,
                );
              }
              const { data: posted } = await client.request(
                "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
                {
                  ...target,
                  issue_number: number,
                  body: text,
                  headers,
                  // GitHub may have stored a comment that answered 5xx; a
                  // blind retry would post it twice.
                  request: { retries: 0 },
                },
              );
              return {
                id: Number(posted.id),
                url: posted.html_url,
                created: true,
              };
            }),
        );
      },
      async dispatchWorkflow(input) {
        const { status, data } = await quiet("workflow dispatch", () =>
          request(
            "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
            {
              ...target,
              workflow_id: input.workflow,
              // A branch, never a tag of the same name.
              ref: `refs/heads/${input.ref}`,
              inputs: input.inputs,
              return_run_details: true,
              headers,
              // A dispatch GitHub took and answered 5xx would run twice.
              request: { retries: 0 },
            },
          ),
        );
        const run = data as { workflow_run_id?: unknown; html_url?: unknown };
        return status === 200 &&
          typeof run?.workflow_run_id === "number" &&
          typeof run.html_url === "string"
          ? { id: run.workflow_run_id, html_url: run.html_url }
          : null;
      },
      async getWorkflowRun(runId): Promise<GitHubWorkflowRun> {
        const { data } = await quiet("workflow run lookup", () =>
          client.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
            ...target,
            run_id: runId,
            headers,
          }),
        );
        return {
          id: Number(data.id),
          path: data.path,
          head_branch: data.head_branch ?? null,
          status: data.status ?? null,
          conclusion: data.conclusion ?? null,
          html_url: data.html_url,
        };
      },
      async rerunWorkflow(runId, failedOnly) {
        await quiet("workflow rerun", () =>
          request(
            failedOnly
              ? "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
              : "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
            { ...target, run_id: runId, headers, request: { retries: 0 } },
          ),
        );
      },
      async submitReview(input) {
        const { data } = await quiet("pull request review", () =>
          client.request(
            "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            {
              ...target,
              pull_number: input.number,
              commit_id: input.commitId,
              event: input.event,
              ...(input.body === undefined ? {} : { body: input.body }),
              headers,
              // A review GitHub stored and answered 5xx would post twice.
              request: { retries: 0 },
            },
          ),
        );
        return { id: Number(data.id), html_url: data.html_url };
      },
    };
  }

  async function quotaKey(repo: RepoRef): Promise<string> {
    return `app:${apiBase}:${await installationOf(repo)}`;
  }

  return {
    kind: "app",
    githubCom: apiBase === GITHUB_API_BASE,
    appId: credentials.appId,
    credential,
    quotaKey,
    installed: installedCheck(client, credentials),
    installedOn: installedOnCheck(client, credentials),
    api,
  };
}

function installedCheck(
  client: Client,
  credentials: GitHubCredentials,
): GitHubConnection["installed"] {
  const fixed = credentials.installationId;
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    request: client.request,
  });
  return async (repo) => {
    const found = await installationFor(client, auth, repo);
    // A catalog App names its installation; another one of the App's own
    // does not let that installation's tokens reach the repository.
    return found !== null && (fixed === undefined || found.id === fixed);
  };
}

/**
 * Which of `repos` the App reaches, from its installations: one list of
 * them, then the repository pages of each installation of an account some
 * repo belongs to. A page limit that cuts a list short leaves the
 * repositories it did not show as unknown, not as missing.
 */
function installedOnCheck(
  client: Client,
  credentials: GitHubCredentials,
): GitHubConnection["installedOn"] {
  const fixed = credentials.installationId;
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    request: client.request,
  });
  return async (repos) => {
    const answers = new Map<string, boolean | null>();
    if (repos.length === 0) return answers;
    const owners = new Set(repos.map((repo) => repo.owner.toLowerCase()));
    const reached = new Set<string>();
    let truncated = false;
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const { data } = await client.request("GET /app/installations", {
        per_page: INSTALLATIONS_PER_PAGE,
        page,
        headers: await appHeaders(auth),
      });
      for (const installation of data) {
        const view = installationOf(installation);
        if (fixed !== undefined && view.id !== fixed) continue;
        const account = view.account.toLowerCase();
        if (!owners.has(account)) continue;
        // An "all" installation is listed as well: a repository deleted or
        // moved out of the account is not on it, as the per-repository
        // lookup also says.
        const { token } = await auth({
          type: "installation",
          installationId: view.id,
        });
        for (
          let repoPage = 1;
          repoPage <= MAX_INSTALLATION_REPOSITORY_PAGES;
          repoPage += 1
        ) {
          const { data: listed } = await client.request(
            "GET /installation/repositories",
            {
              per_page: INSTALLATION_REPOSITORIES_PER_PAGE,
              page: repoPage,
              headers: { authorization: `token ${token}` },
            },
          );
          for (const repository of listed.repositories) {
            reached.add(
              `${repository.owner.login}/${repository.name}`.toLowerCase(),
            );
          }
          if (listed.repositories.length < INSTALLATION_REPOSITORIES_PER_PAGE) {
            break;
          }
          if (repoPage === MAX_INSTALLATION_REPOSITORY_PAGES) truncated = true;
        }
      }
      if (data.length < INSTALLATIONS_PER_PAGE) break;
      if (page === MAX_INSTALLATION_PAGES) truncated = true;
    }
    for (const repo of repos) {
      const key = repoKeyOf(repo);
      answers.set(key, reached.has(key) ? true : truncated ? null : false);
    }
    return answers;
  };
}

const MERGE_POLLS = 20;
const MERGE_POLL_MS = 500;

type MergeAsync =
  | { status: "merged"; sha: string | null }
  | { status: "enqueued" | "failed" }
  | {
      status: "pending";
      uuid: string;
      /** Whether the pending request is the one this call would have made. */
      ours: (sha: string) => boolean;
    };

/** A merge-async answer, or null when it is not one of the four shapes. */
function mergeAsyncOf(data: unknown): MergeAsync | null {
  const body = data as {
    status?: unknown;
    details?: Record<string, unknown> | null;
  } | null;
  const details = body?.details ?? {};
  switch (body?.status) {
    case "merged":
      return {
        status: "merged",
        sha: typeof details.sha === "string" ? details.sha : null,
      };
    case "enqueued":
    case "failed":
      return { status: body.status };
    case "pending":
      return typeof details.uuid === "string"
        ? {
            status: "pending",
            uuid: details.uuid,
            ours: (sha) =>
              details.merge_method === "squash" &&
              details.merge_action === "direct_merge" &&
              details.expected_head_sha === sha &&
              details.bypass_rules !== true,
          }
        : null;
    default:
      return null;
  }
}

/** A direct merge that did not merge (failed, or queued) is not a merge. */
function mergedOf(result: Exclude<MergeAsync, { status: "pending" }>) {
  return result.status === "merged"
    ? { merged: true, sha: result.sha }
    : { merged: false, sha: null };
}

function pullRequestOf(data: {
  number: number;
  html_url: string;
  state: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged_at?: string | null;
  closed_at?: string | null;
}): ForgePullRequest {
  return {
    number: data.number,
    url: data.html_url,
    state: data.state === "open" ? "open" : "closed",
    head: data.head.ref,
    headSha: data.head.sha,
    base: data.base.ref,
    mergedAt: data.merged_at ?? null,
    closedAt: data.closed_at ?? null,
  };
}

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

function headerNumber(
  headers: Record<string, unknown> | undefined,
  name: string,
): number | null {
  const value = Number(headers?.[name]);
  return headers?.[name] === undefined || !Number.isFinite(value)
    ? null
    : value;
}

/** What a response's headers say of the rate limit it counted against. */
function rateLimitOf(
  headers: Record<string, unknown> | undefined,
): GitHubRateLimit {
  const reset = headerNumber(headers, "x-ratelimit-reset");
  return {
    limit: headerNumber(headers, "x-ratelimit-limit"),
    remaining: headerNumber(headers, "x-ratelimit-remaining"),
    reset: reset === null ? null : new Date(reset * 1000),
    retryAfterSeconds: headerNumber(headers, "retry-after"),
  };
}

function issuer(
  client: Client,
  credentials: GitHubCredentials,
  logger: Logger | undefined,
): {
  issue: (
    repo: RepoRef,
    permissions: GitHubPermissions,
  ) => Promise<GitCredential>;
  /** The App installation covering `repo`. */
  installationOf: (repo: RepoRef) => Promise<number | null>;
} {
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    request: client.request,
  });
  const fixed = credentials.installationId;
  const found = new Map<string, number>();
  async function installationOf(repo: RepoRef): Promise<number> {
    if (fixed !== undefined) return fixed;
    const key = `${repo.owner}/${repo.name}`;
    const held = found.get(key);
    if (held !== undefined) return held;
    const id = (await installationFor(client, auth, repo))?.id ?? null;
    if (id === null) {
      throw new ForgeCredentialError(
        `GitHub App is not installed on ${repo.owner}/${repo.name}`,
      );
    }
    found.set(key, id);
    return id;
  }
  const issue = async (
    repo: RepoRef,
    permissions: GitHubPermissions,
  ): Promise<GitCredential> => {
    try {
      const installationId = await installationOf(repo);
      // The library's own cache knows nothing of the refresh margin, so
      // every issue is a fresh request and the connection keeps the cache.
      const { token, expiresAt } = await auth({
        type: "installation",
        installationId,
        repositoryNames: [repo.name],
        permissions,
        refresh: true,
      }).catch((error: unknown) => {
        // Uninstalled and installed again: the next issue looks it up anew.
        found.delete(`${repo.owner}/${repo.name}`);
        throw error;
      });
      return {
        username: "x-access-token",
        password: token,
        expiresAt: new Date(expiresAt),
      };
    } catch (error) {
      // GitHub refuses a permission the installation was not granted with
      // 422; that is the App's settings, not GitHub failing.
      if (statusOf(error) === 422) {
        failure(logger, "installation token request", error);
        throw new GitHubPermissionError(
          "The installation does not grant the permissions asked",
        );
      }
      throw failure(logger, "installation token request", error);
    }
  };
  return { issue, installationOf };
}

type AppAuth = ReturnType<typeof createAppAuth>;

async function appHeaders(auth: AppAuth) {
  const { token } = await auth({ type: "app" });
  return { authorization: `bearer ${token}` };
}

const statusOf = (error: unknown): number | undefined =>
  typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : undefined;

const requestIdOf = (error: unknown): string | null => {
  const id = (error as { response?: { headers?: Record<string, unknown> } })
    ?.response?.headers?.["x-github-request-id"];
  return typeof id === "string" ? id.slice(0, 64) : null;
};

/**
 * The installation that covers `repo` and what it grants, or null when the
 * App has none there.
 */
async function installationFor(
  client: Client,
  auth: AppAuth,
  repo: RepoRef,
): Promise<{ id: number; permissions: GitHubAppPermissions } | null> {
  try {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/installation",
      { owner: repo.owner, repo: repo.name, headers: await appHeaders(auth) },
    );
    return {
      id: Number(data.id),
      permissions: permissionsOf(data.permissions),
    };
  } catch (error) {
    if (statusOf(error) === 404) return null;
    throw error;
  }
}

const MAX_INSTALLATION_REPOSITORY_PAGES = 10;
const INSTALLATION_REPOSITORIES_PER_PAGE = 100;
const MAX_INSTALLATION_PAGES = 10;
const INSTALLATIONS_PER_PAGE = 100;

/**
 * GitHub's answers about an App, asked with its JWT. A 401, 403 or 404 means
 * GitHub refused the App itself (a wrong id, a key it does not know, a
 * deleted App); anything else is GitHub not answering.
 */
export function createGitHubAppDirectory(
  options: { logger?: Logger; retryAfterBaseMs?: number } = {},
): GitHubAppDirectory {
  const { logger } = options;
  const clients = new Map<string, Client>();
  const clientFor = (apiBase: string) => {
    const base = apiBase.replace(/\/+$/, "");
    let client = clients.get(base);
    if (client === undefined) {
      client = clientOf(base, logger, options);
      clients.set(base, client);
    }
    return client;
  };
  async function asking<T>(
    what: string,
    app: { appId: number; apiBase: string; privateKey: string },
    ask: (client: Client, auth: AppAuth) => Promise<T>,
  ): Promise<T> {
    const client = clientFor(app.apiBase);
    try {
      return await ask(
        client,
        createAppAuth({
          appId: app.appId,
          privateKey: app.privateKey,
          request: client.request,
        }),
      );
    } catch (error) {
      const status = statusOf(error);
      failure(logger, what, error);
      // A 403 is also a rate limit or an IP allow list, which says nothing
      // about the key.
      throw new GitHubAppCheckError(
        status === 401 || status === 404
          ? "github_rejected"
          : "github_unreachable",
        status,
      );
    }
  }
  return {
    describe: (app) =>
      asking("App lookup", app, async (client, auth) => {
        const { data } = await client.request("GET /app", {
          headers: await appHeaders(auth),
        });
        if (data === null) throw new Error("GitHub answered no App");
        return {
          appId: Number(data.id),
          slug: data.slug ?? String(data.id),
          name: data.name,
          htmlUrl: data.html_url,
          permissions: permissionsOf(data.permissions),
          owner: ownerOf(data.owner),
          clientId:
            typeof data.client_id === "string" && data.client_id !== ""
              ? data.client_id
              : null,
        };
      }),
    installations: (app) =>
      asking("App installations", app, async (client, auth) => {
        const all: GitHubAppInstallationView[] = [];
        for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
          const { data } = await client.request("GET /app/installations", {
            per_page: INSTALLATIONS_PER_PAGE,
            page,
            headers: await appHeaders(auth),
          });
          for (const installation of data)
            all.push(installationOf(installation));
          if (data.length < INSTALLATIONS_PER_PAGE) break;
        }
        return all;
      }),
    installation: (app, installationId) =>
      asking("App installation", app, async (client, auth) => {
        const headers = await appHeaders(auth);
        try {
          const { data } = await client.request(
            "GET /app/installations/{installation_id}",
            { installation_id: installationId, headers },
          );
          return installationOf(data);
        } catch (error) {
          // Not this App's installation, or no longer there.
          if (statusOf(error) === 404) return null;
          throw error;
        }
      }),
    installationFor: (app, repo) =>
      asking("App installation lookup", app, (client, auth) =>
        installationFor(client, auth, repo),
      ),
    installationRepositoriesPage: (app, installationId, { page, perPage }) =>
      asking("Installation repositories", app, async (client, auth) => {
        const { token } = await auth({ type: "installation", installationId });
        const { data } = await client.request(
          "GET /installation/repositories",
          {
            per_page: perPage,
            page,
            headers: { authorization: `token ${token}` },
          },
        );
        return {
          repositories: data.repositories.map(installationRepositoryOf),
          totalCount: data.total_count,
        };
      }),
    repositoryById: (app, installationId, repositoryId) =>
      asking("Repository lookup", app, async (client, auth) => {
        const { token } = await auth({ type: "installation", installationId });
        try {
          const { data } = await client.request("GET /repositories/{id}", {
            id: repositoryId,
            headers: { authorization: `token ${token}` },
          });
          return installationRepositoryOf(data);
        } catch (error) {
          if (statusOf(error) === 404) return null;
          throw error;
        }
      }),
  };
}

function installationRepositoryOf(repository: {
  id: number | bigint;
  owner: { login: string };
  name: string;
  html_url: string;
  default_branch?: string;
  private: boolean;
}): GitHubInstallationRepository {
  return {
    id: Number(repository.id),
    owner: repository.owner.login,
    name: repository.name,
    url: repository.html_url,
    defaultBranch: repository.default_branch ?? "main",
    private: repository.private,
  };
}

/**
 * `POST /app-manifests/{code}/conversions`. The code is single-use: a retry
 * after GitHub made the App would be refused and lose the key, so none is
 * sent. Neither the code nor the answer's secrets reach the log.
 */
export function createGitHubManifestConverter(
  options: { logger?: Logger } = {},
) {
  const clients = new Map<string, Client>();
  return async (
    apiBase: string,
    code: string,
  ): Promise<GitHubAppManifestConversion> => {
    const base = apiBase.replace(/\/+$/, "");
    let client = clients.get(base);
    if (client === undefined) {
      client = clientOf(base, options.logger, { paced: false });
      clients.set(base, client);
    }
    try {
      const { data } = await client.request(
        "POST /app-manifests/{code}/conversions",
        { code, request: { retries: 0 } },
      );
      const owner = data.owner as { login?: string; slug?: string } | null;
      return {
        appId: Number(data.id),
        slug: data.slug ?? String(data.id),
        name: data.name,
        htmlUrl: data.html_url,
        permissions: permissionsOf(data.permissions),
        clientId: data.client_id,
        clientSecret: data.client_secret,
        privateKey: data.pem.replace(/\r\n?/g, "\n").trim(),
        owner: owner?.login ?? owner?.slug ?? String(data.id),
      };
    } catch (error) {
      const status = statusOf(error);
      failure(options.logger, "App manifest conversion", error);
      throw new GitHubAppCheckError(
        status === 404 || status === 422
          ? "github_rejected"
          : "github_unreachable",
      );
    }
  };
}

const BOT_USER_RETRY_MS = 5 * 60_000;
const BOT_USER_TIMEOUT_MS = 3_000;

/**
 * The numeric id of an App's bot user, `GET /users/<slug>[bot]`, which the
 * bot's noreply commit address needs. Asked without a credential: the users
 * API is public. It runs inside a claim the database already committed, so
 * one short try with no retry, and concurrent claims share it. Kept for the
 * process once known; a failure is asked again after BOT_USER_RETRY_MS, so
 * claims meanwhile cost no call. github.com only: GitHub Enterprise Server
 * spells the noreply address after its own host.
 */
export function createAppBotUsers(
  options: { logger?: Logger; now?: () => Date; timeoutMs?: number } = {},
) {
  const {
    logger,
    now = () => new Date(),
    timeoutMs = BOT_USER_TIMEOUT_MS,
  } = options;
  const known = new Map<string, { id: string } | { failedAt: number }>();
  const asking = new Map<string, Promise<string | null>>();

  async function ask(login: string): Promise<string | null> {
    try {
      const response = await fetch(
        `${GITHUB_API_BASE}/users/${encodeURIComponent(login)}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "Werft",
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!response.ok) {
        throw Object.assign(new Error("GitHub refused the users lookup"), {
          status: response.status,
        });
      }
      const data = (await response.json()) as { id?: unknown; login?: unknown };
      const id = Number(data.id);
      if (!Number.isSafeInteger(id) || id <= 0 || data.login !== login) {
        throw new Error("GitHub named no bot user for the App");
      }
      known.set(login, { id: String(id) });
      return String(id);
    } catch (error) {
      known.set(login, { failedAt: now().getTime() });
      failure(logger, "App bot user lookup", error);
      return null;
    }
  }

  return async (app: {
    slug: string;
    apiBase: string;
  }): Promise<string | null> => {
    if (app.apiBase.replace(/\/+$/, "") !== GITHUB_API_BASE) return null;
    const login = `${app.slug}[bot]`;
    const seen = known.get(login);
    if (seen !== undefined && "id" in seen) return seen.id;
    if (
      seen !== undefined &&
      now().getTime() - seen.failedAt < BOT_USER_RETRY_MS
    ) {
      return null;
    }
    let pending = asking.get(login);
    if (pending === undefined) {
      pending = ask(login).finally(() => asking.delete(login));
      asking.set(login, pending);
    }
    return pending;
  };
}

/** `GET /app`'s permissions, keeping only the levels GitHub names. */
function permissionsOf(
  raw: unknown,
): Record<string, "read" | "write" | "admin"> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, "read" | "write" | "admin"] =>
        entry[1] === "read" || entry[1] === "write" || entry[1] === "admin",
    ),
  );
}

function ownerOf(raw: unknown): GitHubAppOwner | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { login, type } = raw as { login?: unknown; type?: unknown };
  if (typeof login !== "string" || login === "") return null;
  return { login, type: type === "Organization" ? "organization" : "user" };
}

// An enterprise account has no type GitHub names; it reads as an organization.
function accountOf(raw: unknown): {
  accountType: "organization" | "user";
  accountId: number | null;
} {
  const { type, id } = (raw ?? {}) as { type?: unknown; id?: unknown };
  return {
    accountType: type === "User" ? "user" : "organization",
    accountId:
      typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null,
  };
}

function installationOf(installation: {
  id: number;
  account: unknown;
  repository_selection: "all" | "selected";
  html_url?: string | null;
  permissions?: unknown;
  created_at?: string;
  suspended_at?: string | null;
}): GitHubAppInstallationView {
  // A user or an organization has a login, an enterprise a slug.
  const account = installation.account as {
    login?: string;
    slug?: string;
  } | null;
  return {
    id: Number(installation.id),
    account: account?.login ?? account?.slug ?? String(installation.id),
    ...accountOf(installation.account),
    repositorySelection: installation.repository_selection,
    htmlUrl: installation.html_url ?? null,
    permissions: permissionsOf(installation.permissions),
    createdAt: dateOf(installation.created_at),
    suspendedAt: dateOf(installation.suspended_at),
  };
}

function dateOf(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Holds no connections until the first `refresh`. */
export function createRegisteredGitHubConnections(
  options: {
    store: Pick<GitHubAppStore, "credentials"> | null;
  } & Pick<ConnectionOptions, "logger" | "now" | "retryAfterBaseMs" | "paced">,
) {
  const { store, ...connectionOptions } = options;
  type Held = RegisteredGitHubConnection & { version: string };
  let current: Record<GitHubAppRole, Held[]> = { author: [], reviewer: [] };
  // Reads run one after another, so a read that started before a change
  // cannot land after the read that saw it.
  let queue: Promise<void> = Promise.resolve();
  const read = async (): Promise<void> => {
    if (store === null) return;
    const previous = new Map(
      [...current.author, ...current.reviewer].map((held) => [held.id, held]),
    );
    const next: Record<GitHubAppRole, Held[]> = { author: [], reviewer: [] };
    // Bootstrap makes the one workspace, so every row is its connection.
    for (const role of GITHUB_APP_ROLE_VALUES) {
      for (const app of await store.credentials(role)) {
        const version = `${app.appId}|${app.updatedAt.toISOString()}`;
        const kept = previous.get(app.id);
        next[role].push(
          kept?.version === version
            ? kept
            : {
                id: app.id,
                appId: app.appId,
                version,
                connection: createGitHubConnection({
                  ...connectionOptions,
                  apiBase: app.apiBase,
                  credentials: {
                    kind: "app",
                    appId: app.appId,
                    privateKey: app.privateKey,
                  },
                }),
              },
        );
      }
    }
    current = next;
  };
  return {
    connections: (role: GitHubAppRole): readonly RegisteredGitHubConnection[] =>
      current[role],
    refresh(): Promise<void> {
      const next = queue.then(read);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

// The status, the error's class and GitHub's reason (githubReason), never the
// error itself: an octokit error carries the request, whose headers hold the
// JWT or the token.
function failure(
  logger: Logger | undefined,
  what: string,
  cause: unknown,
): ForgeCredentialError {
  if (cause instanceof ForgeCredentialError) return cause;
  const status = statusOf(cause);
  const error = cause instanceof Error ? cause.name : "response";
  logger?.warn("GitHub request failed", {
    request: what,
    ...(status === undefined ? {} : { status }),
    error,
    ...githubReason(cause),
  });
  return new ForgeCredentialError(
    `GitHub ${what} failed${status === undefined ? ` (${error})` : ` (${status})`}`,
  );
}

const REASON_MAX_LENGTH = 200;

/**
 * GitHub's own words for a refused call (a 422 says which field and why).
 * Only the response body is read, and of it only `message` and `errors`, cut
 * short; GitHub does not echo the request's credential there. The field
 * names avoid "message": the log redaction drops keys that look like one.
 * Not for work whose request carries caller values (dispatch inputs).
 */
function githubReason(cause: unknown): {
  github_reason?: string;
  github_errors?: string[];
} {
  const data = (cause as { response?: { data?: unknown } })?.response?.data;
  if (typeof data !== "object" || data === null) return {};
  const cut = (text: string) => text.slice(0, REASON_MAX_LENGTH);
  const { message, errors } = data as { message?: unknown; errors?: unknown };
  const reasons = Array.isArray(errors)
    ? errors.slice(0, 5).map((entry) =>
        cut(
          typeof entry === "string"
            ? entry
            : ["resource", "field", "code", "message"]
                .map((key) => (entry as Record<string, unknown>)?.[key])
                .filter((part) => typeof part === "string")
                .join(" "),
        ),
      )
    : [];
  const kept = reasons.filter((reason) => reason !== "");
  return {
    ...(typeof message === "string" ? { github_reason: cut(message) } : {}),
    ...(kept.length > 0 ? { github_errors: kept } : {}),
  };
}

/**
 * The connection behind each catalog repository: a GitHub App repository's
 * own App (one connection each), the console's App for `{ kind: github_app }`,
 * Only `{ kind: github_app }`
 * repositories have a reviewer: the console's reviewer App.
 */
export function connectionsOf(
  catalog: SessionCatalog,
  options: Pick<
    ConnectionOptions,
    "logger" | "now" | "retryAfterBaseMs" | "paced"
  > & {
    /** The console's Apps, for repositories written as `{ kind: github_app }`. */
    registered?: (role: GitHubAppRole) => readonly RegisteredGitHubConnection[];
  } = {},
): GitHubConnections {
  const { registered, ...connectionOptions } = options;
  const connections = new Map<string, GitHubConnection>();
  let previous: SessionCatalog["repositories"] | undefined;
  function refresh(): void {
    const repositories = catalog.repositories;
    if (repositories === previous) return;
    previous = repositories;
    connections.clear();
    for (const [id, repository] of Object.entries(repositories)) {
      const { auth } = repository;
      // Only App entries carry credentials; the migration report still feeds
      // the gate a catalog with the legacy URL entries it reports on.
      if (auth?.kind !== "github_app" || "registered" in auth) continue;
      connections.set(
        id,
        createGitHubConnection({
          ...connectionOptions,
          apiBase: auth.api_base,
          credentials: {
            kind: "app",
            appId: auth.app_id,
            installationId: auth.installation_id,
            privateKey: auth.value,
          },
        }),
      );
    }
  }
  // Installation settings and console repositories refresh while the API runs.
  return (id, role) => {
    refresh();
    const auth = Object.hasOwn(catalog.repositories, id)
      ? catalog.repositories[id]?.auth
      : undefined;
    if (auth?.kind === "github_app" && "registered" in auth) {
      return { kind: "registered", candidates: registered?.(role) ?? [] };
    }
    const fixed = role === "author" ? connections.get(id) : undefined;
    return fixed === undefined ? null : { kind: "fixed", connection: fixed };
  };
}
