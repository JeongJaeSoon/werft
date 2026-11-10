import type { GitHubAppRole } from "@werft-ai/contracts";
import { type RepoRef, repoKeyOf } from "../action/ports/forge.ts";
import type {
  ClaimPinAudit,
  GitHubPinStore,
} from "../ports/github-app-store.ts";
import type {
  GitHubConnection,
  GitHubConnectionSource,
  GitHubConnections,
  RegisteredGitHubConnection,
} from "../ports/github-gate.ts";

export type GitHubConnectionChoice =
  | {
      kind: "connection";
      connection: GitHubConnection;
      /** The console connection's id; null for a catalog App. */
      connectionId: string | null;
      /** Set when this choice left the repository's first pin. */
      pinnedBy: "first_mint" | "claim" | null;
    }
  /** No connection serves the role: none registered, or not on GitHub. */
  | { kind: "none" }
  | {
      kind: "refused";
      reason: "ambiguous_app" | "pinned_app_removed";
      candidateConnectionIds: string[];
    }
  /** Worth retrying: GitHub could not tell, or no connection reaches it. */
  | {
      kind: "unreachable";
      pinState: "none_unreachable" | "lookup_failed" | "pinned_unreachable";
      connectionId: string | null;
    };

export type GitHubConnectionResolver = ReturnType<
  typeof createGitHubConnectionResolver
>;

/**
 * Picks a repository's connection from its pin, or, with none, from the one
 * console connection of the role that reaches it. Never falls back to
 * another connection than the pinned one.
 */
export function createGitHubConnectionResolver(deps: {
  connections: GitHubConnections;
  /** Null when the API runs without a database for pins (tests). */
  pins: Pick<GitHubPinStore, "get" | "pinFirst"> | null;
}) {
  const { connections, pins } = deps;

  async function reaching(
    candidates: readonly RegisteredGitHubConnection[],
    repo: RepoRef,
  ): Promise<RegisteredGitHubConnection[] | "lookup_failed"> {
    const answers = await Promise.allSettled(
      candidates.map((candidate) => candidate.connection.installed(repo)),
    );
    // One connection GitHub did not answer for might be the one reaching it:
    // choosing among the others could pick a second App.
    if (
      answers.some(
        (answer) => answer.status === "rejected" || answer.value === null,
      )
    ) {
      return "lookup_failed";
    }
    return candidates.filter(
      (_, index) =>
        (answers[index] as PromiseFulfilledResult<boolean>).value === true,
    );
  }

  const held = (
    candidates: readonly RegisteredGitHubConnection[],
    pin: { connectionId: string | null; appId: number },
  ): GitHubConnectionChoice => {
    const { connectionId } = pin;
    if (connectionId === null) {
      return {
        kind: "refused",
        reason: "pinned_app_removed",
        candidateConnectionIds: [],
      };
    }
    const found = candidates.find((candidate) => candidate.id === connectionId);
    // Registered, or given another App, on another replica and not read here
    // yet: this replica's App is not the one the pin names.
    if (found === undefined || found.appId !== pin.appId) {
      return {
        kind: "unreachable",
        pinState: "pinned_unreachable",
        connectionId,
      };
    }
    return {
      kind: "connection",
      connection: found.connection,
      connectionId,
      pinnedBy: null,
    };
  };

  return {
    /**
     * `pin`: leave the first pin when one connection reaches an unpinned
     * repository (a token issue does; a read for a badge does not).
     * `claim`: the pin is a claim's, for its commit author, and is audited
     * with the session rather than counted as a first mint.
     */
    async resolve(
      repositoryId: string,
      role: GitHubAppRole,
      repo: RepoRef,
      options: {
        pin: boolean;
        /** The role's source the caller already read, so it is read once. */
        source?: GitHubConnectionSource | null;
        claim?: ClaimPinAudit;
      },
    ): Promise<GitHubConnectionChoice> {
      const source =
        options.source === undefined
          ? connections(repositoryId, role)
          : options.source;
      if (source === null) return { kind: "none" };
      if (source.kind === "fixed") {
        return {
          kind: "connection",
          connection: source.connection,
          connectionId: null,
          pinnedBy: null,
        };
      }
      const { candidates } = source;
      const pin = pins === null ? null : await pins.get(repositoryId, role);
      if (pin !== null) return held(candidates, pin);
      if (candidates.length === 0) return { kind: "none" };
      const reached = await reaching(candidates, repo);
      if (reached === "lookup_failed") {
        return {
          kind: "unreachable",
          pinState: "lookup_failed",
          connectionId: null,
        };
      }
      const [only, ...others] = reached;
      if (only === undefined) {
        return {
          kind: "unreachable",
          pinState: "none_unreachable",
          connectionId: null,
        };
      }
      if (others.length > 0) {
        return {
          kind: "refused",
          reason: "ambiguous_app",
          candidateConnectionIds: reached.map(({ id }) => id),
        };
      }
      if (!options.pin || pins === null) {
        return {
          kind: "connection",
          connection: only.connection,
          connectionId: only.id,
          pinnedBy: null,
        };
      }
      const target = {
        repositoryId,
        role,
        connectionId: only.id,
        appId: only.appId,
      };
      const { pin: kept, created } = await pins.pinFirst(
        options.claim === undefined
          ? { ...target, pinnedBy: "first_mint" }
          : { ...target, pinnedBy: "claim", audit: options.claim },
      );
      if (kept === null) {
        return {
          kind: "unreachable",
          pinState: "pinned_unreachable",
          connectionId: only.id,
        };
      }
      if (!created) return held(candidates, kept);
      return {
        kind: "connection",
        connection: only.connection,
        connectionId: only.id,
        pinnedBy: options.claim === undefined ? "first_mint" : "claim",
      };
    },

    /**
     * Whether the role's App reaches the repository: the pinned connection's
     * answer, or with no pin true when exactly one connection reaches it and
     * false when none does. Null when GitHub did not answer, several reach
     * it, or no connection serves the role.
     */
    async installed(
      repositoryId: string,
      role: GitHubAppRole,
      repo: RepoRef,
    ): Promise<boolean | null> {
      const source = connections(repositoryId, role);
      if (source === null) return null;
      if (source.kind === "fixed") {
        return source.connection.installed(repo).catch(() => null);
      }
      const pin = pins === null ? null : await pins.get(repositoryId, role);
      if (pin !== null) {
        if (pin.connectionId === null) return false;
        const found = source.candidates.find(
          ({ id }) => id === pin.connectionId,
        );
        return found === undefined || found.appId !== pin.appId
          ? null
          : found.connection.installed(repo).catch(() => null);
      }
      if (source.candidates.length === 0) return null;
      const reached = await reaching(source.candidates, repo);
      if (reached === "lookup_failed") return null;
      return reached.length === 0 ? false : reached.length === 1 ? true : null;
    },

    /**
     * `installed` for several repositories of one role, asking each
     * connection once about all the repositories that can reach it. The same
     * answers as `installed`; a connection GitHub did not answer for leaves
     * its repositories null, and no repository falls back to a lookup of its
     * own.
     */
    async installedMany(
      role: GitHubAppRole,
      items: readonly { repositoryId: string; repo: RepoRef }[],
    ): Promise<Map<string, boolean | null>> {
      type Plan =
        | { kind: "answer"; answer: boolean | null }
        | { kind: "one"; connection: GitHubConnection }
        | {
            kind: "candidates";
            candidates: readonly RegisteredGitHubConnection[];
          };
      const plans = new Map<string, Plan>();
      const asked = new Map<GitHubConnection, RepoRef[]>();
      const ask = (connection: GitHubConnection, repo: RepoRef) =>
        asked.set(connection, [...(asked.get(connection) ?? []), repo]);
      for (const { repositoryId, repo } of items) {
        const source = connections(repositoryId, role);
        if (source === null) {
          plans.set(repositoryId, { kind: "answer", answer: null });
        } else if (source.kind === "fixed") {
          ask(source.connection, repo);
          plans.set(repositoryId, {
            kind: "one",
            connection: source.connection,
          });
        } else {
          const pin = pins === null ? null : await pins.get(repositoryId, role);
          if (pin !== null) {
            const found =
              pin.connectionId === null
                ? undefined
                : source.candidates.find(({ id }) => id === pin.connectionId);
            if (pin.connectionId === null) {
              plans.set(repositoryId, { kind: "answer", answer: false });
            } else if (found === undefined || found.appId !== pin.appId) {
              plans.set(repositoryId, { kind: "answer", answer: null });
            } else {
              ask(found.connection, repo);
              plans.set(repositoryId, {
                kind: "one",
                connection: found.connection,
              });
            }
          } else if (source.candidates.length === 0) {
            plans.set(repositoryId, { kind: "answer", answer: null });
          } else {
            for (const candidate of source.candidates) {
              ask(candidate.connection, repo);
            }
            plans.set(repositoryId, {
              kind: "candidates",
              candidates: source.candidates,
            });
          }
        }
      }
      const replies = new Map<
        GitHubConnection,
        ReadonlyMap<string, boolean | null> | null
      >();
      await Promise.all(
        [...asked].map(async ([connection, repos]) =>
          replies.set(
            connection,
            await connection.installedOn(repos).catch(() => null),
          ),
        ),
      );
      const replyFor = (connection: GitHubConnection, repo: RepoRef) =>
        replies.get(connection)?.get(repoKeyOf(repo)) ?? null;
      const result = new Map<string, boolean | null>();
      for (const { repositoryId, repo } of items) {
        const plan = plans.get(repositoryId);
        if (plan === undefined || plan.kind === "answer") {
          result.set(repositoryId, plan?.answer ?? null);
        } else if (plan.kind === "one") {
          result.set(repositoryId, replyFor(plan.connection, repo));
        } else {
          const answers = plan.candidates.map((candidate) =>
            replyFor(candidate.connection, repo),
          );
          // One connection GitHub did not answer for might be the one
          // reaching it, as in `reaching`.
          const reached = answers.filter((answer) => answer === true).length;
          result.set(
            repositoryId,
            answers.includes(null)
              ? null
              : reached === 0
                ? false
                : reached === 1
                  ? true
                  : null,
          );
        }
      }
      return result;
    },
  };
}
