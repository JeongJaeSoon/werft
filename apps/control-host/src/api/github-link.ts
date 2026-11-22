import { GITHUB_LOGIN_PATTERN } from "@werft-ai/contracts";
import type { GitHubOAuthClient } from "@werft-ai/platform";
import { providerFetch } from "./provider-fetch.ts";

// Linking a person's GitHub account through the author App's user
// authorization. The user token answers
// one `GET /user` and is dropped; nothing of it is kept or logged.

/** The console page GitHub sends the person back to. */
export function githubCallbackUrl(consoleOrigin: string | null): string | null {
  return consoleOrigin === null
    ? null
    : new URL("/settings/linked-accounts/github", consoleOrigin).toString();
}

// ---------------------------------------------------------------------------
// The OAuth exchange
// ---------------------------------------------------------------------------

export function githubAuthorizeUrl(
  client: Pick<GitHubOAuthClient, "clientId" | "webBase">,
  redirectUri: string,
  state: string,
): string {
  const url = new URL("/login/oauth/authorize", client.webBase);
  url.search = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    state,
    // Linking proves an account someone has; it never makes one.
    allow_signup: "false",
  }).toString();
  return url.toString();
}

export type VerifiedGitHubAccount = { id: string; login: string };

/** GitHub refused the code, or named an account that does not check out. */
export class GitHubOAuthRejectedError extends Error {}
/** GitHub could not be reached or answered with a server error. */
export class GitHubOAuthUnavailableError extends Error {}

function githubFetch(url: string, init: RequestInit): Promise<Response> {
  return providerFetch(url, init, {
    unreachable: (error) =>
      new GitHubOAuthUnavailableError(
        error instanceof Error ? error.name : "fetch failed",
      ),
    answered: (status) =>
      new GitHubOAuthUnavailableError(`GitHub answered ${status}`),
  });
}

/**
 * The code for a user token, the token for `GET /user`'s id and login.
 * Error messages name a status or GitHub's error code, never a value sent.
 */
export async function exchangeGitHubCode(
  client: GitHubOAuthClient,
  code: string,
  redirectUri: string,
): Promise<VerifiedGitHubAccount> {
  const exchanged = await githubFetch(
    new URL("/login/oauth/access_token", client.webBase).toString(),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    },
  );
  const answer = (await exchanged.json().catch(() => null)) as {
    access_token?: unknown;
    error?: unknown;
  } | null;
  const accessToken = answer?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    const reason = answer?.error;
    throw new GitHubOAuthRejectedError(
      `GitHub refused the code: ${typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason) ? reason : exchanged.status}`,
    );
  }
  const user = await githubFetch(
    new URL("user", client.apiBase.replace(/\/*$/, "/")).toString(),
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!user.ok) {
    throw new GitHubOAuthRejectedError(`GET /user answered ${user.status}`);
  }
  const body = (await user.json().catch(() => null)) as {
    id?: unknown;
    login?: unknown;
  } | null;
  const id = body?.id;
  const login = body?.login;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof login !== "string" ||
    !GITHUB_LOGIN_PATTERN.test(login)
  ) {
    throw new GitHubOAuthRejectedError("GET /user named no usable account");
  }
  return { id: String(id), login };
}
