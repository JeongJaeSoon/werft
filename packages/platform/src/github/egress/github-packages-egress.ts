import { randomUUID } from "node:crypto";
import type {
  GitHubPackagesRefusal,
  GitHubPackagesRegistry,
} from "@werft-ai/contracts";
import type {
  GitHubPackageFetchRecord,
  GitHubPackagesStore,
} from "../ports/github-packages.ts";
import {
  allowedRead,
  entriesFor,
  type GitHubPackageRead,
  githubPackageReadOf,
} from "./github-packages.ts";

export const GITHUB_PACKAGES_UPSTREAMS: Record<GitHubPackagesRegistry, string> =
  {
    npm: "https://npm.pkg.github.com",
    rubygems: "https://rubygems.pkg.github.com",
  };

export type GitHubPackagesDecision =
  | {
      kind: "granted";
      upstream: { url: string; headers: [string, string][] };
    }
  | {
      kind: "refused";
      reason: GitHubPackagesRefusal;
      /** Null when the session is gone and nothing was recorded. */
      receiptId: string | null;
    };

export type GitHubPackagesEgressRequest = {
  sessionId: string;
  attemptId: string;
  repositoryId: string | null;
  registry: GitHubPackagesRegistry;
  path: string;
  /** The proxy asking again mid-exchange: judged the same, not recorded again. */
  regrant: boolean;
};

/**
 * The gateway's part of a GitHub Packages request: the workspace's bot token,
 * attached only when the allowlist names what the path reads, and a
 * `fetch_github_package` receipt for every first ask, allowed or not. The
 * receipt is written before the token is handed out, so a fetch nobody can
 * account for does not happen.
 */
export function createGitHubPackagesEgress(deps: {
  store: GitHubPackagesStore;
  upstreams?: Partial<Record<GitHubPackagesRegistry, string>>;
  now?: () => Date;
}) {
  const upstreams = { ...GITHUB_PACKAGES_UPSTREAMS, ...deps.upstreams };
  const now = deps.now ?? (() => new Date());

  return async function decide(
    request: GitHubPackagesEgressRequest,
  ): Promise<GitHubPackagesDecision> {
    const state = await deps.store.sessionState(request.sessionId);
    if (state === null) {
      return {
        kind: "refused",
        reason: "token_not_configured",
        receiptId: null,
      };
    }
    const read = githubPackageReadOf(request.registry, request.path);
    const allowed =
      read === null
        ? null
        : allowedRead(
            read,
            entriesFor(state.allowlist, {
              repositoryId: request.repositoryId,
              agentId: state.agentId,
            }),
          );
    const reason: GitHubPackagesRefusal | null =
      state.token === null
        ? "token_not_configured"
        : state.token.expiresAt !== null &&
            state.token.expiresAt.getTime() <= now().getTime()
          ? "token_expired"
          : read === null
            ? "path_not_recognized"
            : allowed === null
              ? "package_not_allowed"
              : null;
    const receiptId = randomUUID();
    if (!request.regrant) {
      const record: GitHubPackageFetchRecord = {
        id: receiptId,
        ownerId: state.ownerId,
        sessionId: request.sessionId,
        status: reason === null ? "succeeded" : "failed",
        actor: state.actor,
        result: {
          attempt_id: request.attemptId,
          agent_id: state.agentId,
          release_id: state.releaseId,
          repository_id: request.repositoryId,
          registry: request.registry,
          owner: read?.owner ?? null,
          package: allowed?.name ?? packageOf(read),
          version: allowed?.version ?? null,
          reason_code: reason,
        },
      };
      await deps.store.recordFetch(record);
    }
    if (reason !== null || state.token === null) {
      return {
        kind: "refused",
        reason: reason ?? "token_not_configured",
        receiptId: request.regrant ? null : receiptId,
      };
    }
    return {
      kind: "granted",
      upstream: {
        url: upstreams[request.registry],
        headers: [["authorization", `Bearer ${state.token.value}`]],
      },
    };
  };
}

function packageOf(read: GitHubPackageRead | null): string | null {
  if (read === null) return null;
  switch (read.kind) {
    case "index":
      return null;
    case "package":
      return read.name;
    case "gem_file":
      return read.file;
    case "gems":
      return read.names.join(",");
  }
}
