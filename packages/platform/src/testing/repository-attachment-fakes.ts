import { type AgentGitHub, RUNTIME_KIND_VALUES } from "@werft-ai/contracts";
import type { GitHubSessionContext } from "../ports/github-gate.ts";
import type {
  RepositoryAttachmentRefusal,
  RepositoryAttachmentRow,
  RepositoryAttachmentStore,
} from "../ports/repository-attachments.ts";
import {
  environmentCredentials,
  resolveSessionCatalog,
  sessionCatalogConfigSchema,
} from "../sessions/catalog.ts";
import { withSeededInstallation } from "../sessions/profile-registry.ts";
import { releasePolicy } from "./github-fakes.ts";

const profile = {
  runtime_kind: RUNTIME_KIND_VALUES[0],
  runtime_version: "1",
  model: "claude-sonnet-5",
  tools: ["Read"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value_env: "ANTHROPIC_KEY_MAIN" },
  },
};
const repo = (name: string, branch = "main") => ({
  url: `https://github.com/acme/${name}.git`,
  branch,
  profiles: ["p"],
  auth: { kind: "github_app" },
});

/**
 * `app` is the session's own; `docs` and `tools` are on the release's list,
 * `secret` is not. `lab` is allowed for profile `q` alone.
 */
function catalogOf(repositories: Record<string, ReturnType<typeof repo>>) {
  return withSeededInstallation(
    resolveSessionCatalog(
      sessionCatalogConfigSchema.parse({
        profiles: { p: profile, q: profile },
        repositories,
      }),
      environmentCredentials({ ANTHROPIC_KEY_MAIN: "resolved-key" }),
    ),
  );
}

export const attachCatalog = catalogOf({
  app: repo("app"),
  docs: repo("docs", "trunk"),
  tools: repo("tools"),
  secret: repo("secret"),
  lab: { ...repo("lab"), profiles: ["q"] },
});

/** `app` and `count` more, named `r0000`, `r0001`, ... */
export function manyRepositoriesCatalog(count: number) {
  return catalogOf({
    app: repo("app"),
    ...Object.fromEntries(
      Array.from({ length: count }, (_, i) => {
        const name = `r${String(i).padStart(4, "0")}`;
        return [name, repo(name)];
      }),
    ),
  });
}

export function attachGitHub(
  repositories = ["app", "docs", "tools"],
): AgentGitHub {
  return {
    repositories,
    features: {
      workflows: false,
      actions: false,
      checks: false,
      issues: false,
      review: false,
    },
    actions_allow: [],
    push_approval: true,
  };
}

export function attachmentContext(
  overrides: Partial<GitHubSessionContext> = {},
): GitHubSessionContext {
  return {
    ownerId: "owner-a",
    sessionId: "11111111-1111-4111-8111-111111111111",
    repositoryId: "app",
    profileId: "p",
    attachedRepositoryIds: [],
    repository: { url: "https://github.com/acme/app.git", branch: "main" },
    startedBy: null,
    agent: { id: "agent-1", workspaceId: "owner-a", githubEnabled: true },
    release: { id: "release-1" },
    policy: releasePolicy(attachGitHub()),
    ceiling: {
      workflows: false,
      actions: false,
      checks: false,
      issues: false,
      review: false,
      merge: false,
    },
    repositoryCeiling: null,
    ceilingRevision: 0,
    ...overrides,
  };
}

/**
 * The Postgres store's rules in memory: one row per repository, an open
 * attempt set by `openAttempts`, the session's list `attached`, a failed row
 * asked again starting over.
 */
export function memoryAttachmentStore(
  openAttempts = new Set(["att_1"]),
  attached: string[] | null = [],
) {
  const rows = new Map<string, RepositoryAttachmentRow>();
  const receipts: Array<{
    id: string;
    status: "accepted" | "succeeded" | "failed";
    result: Record<string, unknown>;
    error: RepositoryAttachmentRefusal["error"] | null;
  }> = [];
  let next = 0;
  const list = attached === null ? null : [...attached];
  /** The agent's active release; null leaves none, as with no agent. */
  const agent: {
    active: Awaited<ReturnType<RepositoryAttachmentStore["activeRelease"]>>;
    activeReads: number;
  } = { active: null, activeReads: 0 };
  const store: RepositoryAttachmentStore = {
    async activeRelease() {
      agent.activeReads += 1;
      return agent.active;
    },
    async request(input) {
      if (!openAttempts.has(input.attemptId)) {
        return { outcome: "attempt_ended" };
      }
      const existing = rows.get(input.repositoryId);
      if (existing !== undefined && existing.status !== "failed") {
        return { outcome: "unchanged", row: { ...existing } };
      }
      if (
        existing === undefined &&
        (list === null || list.includes(input.repositoryId))
      ) {
        return { outcome: "preattached" };
      }
      if (list !== null && !list.includes(input.repositoryId)) {
        list.push(input.repositoryId);
      }
      const receiptId = `receipt-${++next}`;
      receipts.push({
        id: receiptId,
        status: "accepted",
        result: input.result,
        error: null,
      });
      const row: RepositoryAttachmentRow = {
        repositoryId: input.repositoryId,
        attemptId: input.attemptId,
        branch: input.branch,
        status: "pending",
        commit: null,
        failure: null,
        receiptId,
      };
      rows.set(input.repositoryId, row);
      return { outcome: "requested", row: { ...row } };
    },
    async find(_sessionId, repositoryId) {
      const row = rows.get(repositoryId);
      return row === undefined ? null : { ...row };
    },
    async recordRefusal(input) {
      const id = `receipt-${++next}`;
      receipts.push({
        id,
        status: "failed",
        result: input.result,
        error: input.error,
      });
      return id;
    },
    async list() {
      return [...rows.values()].map((row) => ({ ...row }));
    },
    async pending() {
      return [...rows.values()].filter((row) => row.status === "pending");
    },
    async settle(_sessionId, results) {
      for (const result of results) {
        const row = rows.get(result.repository_id);
        if (
          row === undefined ||
          row.status !== "pending" ||
          row.receiptId !== result.receipt_id
        ) {
          continue;
        }
        const receipt = receipts.find((entry) => entry.id === row.receiptId);
        if (result.status === "attached") {
          rows.set(row.repositoryId, {
            ...row,
            status: "attached",
            commit: result.commit,
          });
          if (receipt !== undefined) receipt.status = "succeeded";
        } else {
          rows.set(row.repositoryId, {
            ...row,
            status: "failed",
            failure: result.failure,
          });
          if (receipt !== undefined) receipt.status = "failed";
          if (list !== null) list.splice(list.indexOf(row.repositoryId), 1);
        }
      }
    },
  };
  return Object.assign(store, { rows, receipts, agent, attached: () => list });
}
