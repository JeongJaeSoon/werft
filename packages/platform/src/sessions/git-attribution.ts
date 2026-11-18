import {
  type ClaimGit,
  GITHUB_LOGIN_PATTERN,
  githubNoreplyEmail,
  type SessionGitHubAttribution,
} from "@werft-ai/contracts";
import type {
  SessionAttributionRecord,
  SessionAttributionStore,
} from "../action/ports/session-attribution.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  requirePermitted,
  SessionServiceError,
} from "../musterrolle/index.ts";

/** The session's page in the console; null when the console has no origin. */
export function sessionUrlOf(
  consoleOrigin: string | null,
  sessionId: string,
): string | null {
  return consoleOrigin === null
    ? null
    : new URL(`/sessions/${sessionId}`, consoleOrigin).toString();
}

/**
 * The co-author a commit names, from the starter's GitHub link. Checked again
 * here, not trusted from the row: a value outside GitHub's own rules never
 * reaches a commit message.
 */
export function coAuthorOf(
  record: SessionAttributionRecord | null,
): { name: string; email: string } | null {
  return coAuthorOfLink(record?.starter?.github);
}

export function coAuthorOfLink(
  github: { id: string; login: string } | null | undefined,
): { name: string; email: string } | null {
  if (!github) return null;
  if (!/^[1-9][0-9]{0,19}$/.test(github.id)) return null;
  if (!GITHUB_LOGIN_PATTERN.test(github.login)) return null;
  return {
    name: github.login,
    email: githubNoreplyEmail(github.id, github.login),
  };
}

/**
 * The App's bot user as a commit author: `<slug>[bot]` with the noreply
 * address GitHub ties to that account (`<bot user id>+<slug>[bot]@users.
 * noreply.github.com`, the users API's id and login; see actions/checkout's
 * README). Null when either value falls outside GitHub's own rules.
 */
export function appBotAuthor(
  slug: string,
  botUserId: string,
): { name: string; email: string } | null {
  if (!/^[1-9][0-9]{0,19}$/.test(botUserId)) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,33}$/.test(slug)) return null;
  const login = `${slug}[bot]`;
  return { name: login, email: githubNoreplyEmail(botUserId, login) };
}

export function claimGitOf(
  record: SessionAttributionRecord | null,
  consoleOrigin: string | null,
  sessionId: string,
  sessionLink: "url" | "id" = "url",
): ClaimGit {
  return {
    co_author: coAuthorOf(record),
    // Null makes the worker's trailer name the session id.
    session_url:
      sessionLink === "id" ? null : sessionUrlOf(consoleOrigin, sessionId),
  };
}

export function attributionView(
  record: SessionAttributionRecord,
  last?: {
    userId: string | null;
    github: { id: string; login: string } | null;
  } | null,
): SessionGitHubAttribution {
  const coAuthor =
    last == null ? coAuthorOf(record) : coAuthorOfLink(last.github);
  const person = last == null ? record.starter !== null : last.userId !== null;
  return {
    trigger: record.trigger,
    attribution:
      coAuthor !== null ? "co_author" : !person ? "app_only" : "unlinked",
    login: coAuthor?.name ?? null,
  };
}

/** The session detail's attribution line; whoever may read the session. */
export function createSessionAttributionService(deps: {
  authorization: AuthorizationPolicy;
  store: Pick<SessionAttributionStore, "attribution" | "lastRequesterOf">;
}) {
  return {
    async get(
      caller: Caller,
      rawSessionId: string,
    ): Promise<SessionGitHubAttribution> {
      const sessionId = rawSessionId.toLowerCase();
      await requirePermitted(deps.authorization, caller, "session.read", {
        kind: "session",
        id: sessionId,
      });
      const record = await deps.store.attribution(sessionId);
      if (record === null || record.ownerId !== caller.ownerId) {
        throw new SessionServiceError("NOT_FOUND", "Resource not found");
      }
      return attributionView(
        record,
        await deps.store.lastRequesterOf(sessionId),
      );
    },
  };
}

export type SessionAttributionService = ReturnType<
  typeof createSessionAttributionService
>;
