import type {
  GitHubPackagesSettingsResponse,
  GitHubPackagesWriteResponse,
  PutGitHubPackagesAllowlistRequest,
  PutGitHubPackagesTokenRequest,
} from "@werft-ai/contracts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  SECRET_STORE_OFF,
  SessionServiceError,
} from "../../musterrolle/index.ts";
import type {
  GitHubPackagesStore,
  GitHubPackagesTokenVerifier,
  GitHubPackagesWriteRefusal,
} from "../ports/github-packages.ts";

const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

function refused(outcome: GitHubPackagesWriteRefusal | "not_found"): never {
  switch (outcome) {
    case "actor_inactive":
      throw ACTOR_INACTIVE();
    case "outranked":
      throw OUTRANKED();
    default:
      throw NOT_FOUND();
  }
}

/**
 * The workspace's GitHub Packages bot token and package allowlist. Members
 * read the summary; an owner or admin signed in to the console changes it.
 * A token is stored only after GitHub says it is a classic token whose one
 * scope is `read:packages`, and is never answered back.
 */
export function createGitHubPackagesService(deps: {
  authorization: AuthorizationPolicy;
  store: GitHubPackagesStore;
  verifier: GitHubPackagesTokenVerifier;
  /** False when the API runs without a master key: no secret can be kept. */
  secretsOn: boolean;
  newId?: () => string;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function read(
    workspaceId: string,
  ): Promise<GitHubPackagesSettingsResponse> {
    const settings = await store.get(workspaceId);
    const token = settings.token;
    return {
      token: {
        configured: token !== null,
        last4: token?.last4 ?? null,
        login: token?.login ?? null,
        expires_at: token?.expiresAt?.toISOString() ?? null,
        updated_at: token?.updatedAt.toISOString() ?? null,
        updated_by:
          token?.updatedBy == null
            ? null
            : {
                user_id: token.updatedBy.userId,
                display_name: token.updatedBy.displayName,
              },
      },
      allowlist: settings.allowlist,
      revision: settings.revision,
    };
  }

  async function requireConsoleManager(caller: Caller, workspaceId: string) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    const principal = caller.subject.principal;
    if (caller.subject.surface.kind !== "web" || principal?.kind !== "user") {
      throw new SessionServiceError(
        "FORBIDDEN",
        "The GitHub Packages settings are set from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
  }

  function requireSecrets() {
    if (!deps.secretsOn) {
      throw SECRET_STORE_OFF();
    }
  }

  return {
    async get(
      caller: Caller,
      workspaceId: string,
    ): Promise<GitHubPackagesSettingsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      if (caller.subject.principal?.kind !== "user") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "The GitHub Packages settings are read by a workspace member",
        );
      }
      return await read(workspaceId);
    },

    async putToken(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubPackagesTokenRequest>,
    ): Promise<GitHubPackagesWriteResponse> {
      await requireConsoleManager(caller, workspaceId);
      requireSecrets();
      const body = await readBody();
      const verified = await deps.verifier.verify(body.token);
      if (verified.outcome === "unavailable") {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "GitHub could not be asked about the token; try again",
        );
      }
      if (verified.outcome === "rejected") {
        throw new SessionServiceError(
          "BAD_REQUEST",
          verified.reason === "invalid"
            ? "GitHub did not accept the token"
            : `The token must be a classic personal access token with only the read:packages scope; it has: ${verified.scopes.join(", ") || "no classic scopes"}`,
          undefined,
          {
            reason_code:
              verified.reason === "invalid" ? "token_invalid" : "token_scopes",
          },
        );
      }
      const receiptId = newId();
      const result = await store.putToken({
        workspaceId,
        token: body.token,
        facts: verified.facts,
        audit: { principal: caller, receiptId, roles: MANAGERS },
      });
      if (result.outcome !== "stored") refused(result.outcome);
      return { ...(await read(workspaceId)), receipt_id: receiptId };
    },

    async deleteToken(
      caller: Caller,
      workspaceId: string,
    ): Promise<GitHubPackagesWriteResponse> {
      await requireConsoleManager(caller, workspaceId);
      requireSecrets();
      const receiptId = newId();
      const result = await store.deleteToken({
        workspaceId,
        audit: { principal: caller, receiptId, roles: MANAGERS },
      });
      if (result.outcome !== "deleted") refused(result.outcome);
      return { ...(await read(workspaceId)), receipt_id: receiptId };
    },

    async putAllowlist(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubPackagesAllowlistRequest>,
    ): Promise<GitHubPackagesWriteResponse> {
      await requireConsoleManager(caller, workspaceId);
      const body = await readBody();
      const receiptId = newId();
      const result = await store.putAllowlist({
        workspaceId,
        allowlist: body.allowlist,
        revision: body.revision,
        audit: { principal: caller, receiptId, roles: MANAGERS },
      });
      if (result.outcome === "revision_conflict") {
        throw new SessionServiceError(
          "REVISION_CONFLICT",
          "The GitHub Packages allowlist changed since it was read",
        );
      }
      if (result.outcome !== "stored") refused(result.outcome);
      return { ...(await read(workspaceId)), receipt_id: receiptId };
    },
  };
}

/** The scopes header GitHub answers a classic token's request with. */
export function scopesOf(header: string | null): string[] | null {
  if (header === null) return null;
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

/**
 * Asks `GET /user` with the token: a classic token's response names its
 * scopes in `X-OAuth-Scopes` and its expiry in
 * `GitHub-Authentication-Token-Expiration`. A fine-grained token or an App
 * token answers without the scopes header, and GitHub Packages refuses
 * both, so they are rejected here.
 */
export function createGitHubPackagesTokenVerifier(deps: {
  apiBase: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): GitHubPackagesTokenVerifier {
  const fetchImpl = deps.fetch ?? fetch;
  return {
    async verify(token) {
      let response: Response;
      try {
        response = await fetchImpl(`${deps.apiBase.replace(/\/$/, "")}/user`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "werft",
          },
          redirect: "error",
          signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
        });
      } catch {
        return { outcome: "unavailable" };
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return { outcome: "rejected", reason: "invalid", scopes: [] };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return { outcome: "unavailable" };
      }
      const scopes = scopesOf(response.headers.get("x-oauth-scopes"));
      const body = (await response.json().catch(() => null)) as {
        login?: unknown;
      } | null;
      if (
        scopes === null ||
        scopes.length !== 1 ||
        scopes[0] !== "read:packages"
      ) {
        return { outcome: "rejected", reason: "scopes", scopes: scopes ?? [] };
      }
      if (typeof body?.login !== "string") return { outcome: "unavailable" };
      return {
        outcome: "ok",
        facts: {
          login: body.login,
          expiresAt: expiryOf(
            response.headers.get("github-authentication-token-expiration"),
          ),
        },
      };
    },
  };
}

// GitHub writes it as `2026-12-31 00:00:00 UTC` or with an offset, `+0900`.
export function expiryOf(header: string | null): Date | null {
  const parts =
    header === null
      ? null
      : /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) (UTC|[+-]\d\d:?\d\d)$/.exec(
          header.trim(),
        );
  if (parts === null) return null;
  const zone =
    parts[3] === "UTC"
      ? "Z"
      : (parts[3] ?? "").replace(/^([+-]\d\d)(\d\d)$/, "$1:$2");
  const parsed = new Date(`${parts[1]}T${parts[2]}${zone}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
