import { randomUUID } from "node:crypto";
import type {
  CreateLoginProviderRequest,
  DiscoverLoginProviderResponse,
  ListLoginProvidersResponse,
  LoginProviderState,
  LoginProviderView,
  UpdateLoginProviderRequest,
} from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  type Caller,
  ifMatchOf,
  type LoginProviderAdminStore,
  type LoginProviderAudit,
  type LoginProviderChanges,
  type LoginProviderEndpoints,
  type LoginProviderRecord,
  type LoginProviderSecretSummary,
  requirePermitted,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  discover,
  OidcDiscoveryError,
  OidcUnavailableError,
  type ProviderRequest,
  policyProblem,
} from "./oidc/index.ts";
import {
  networkPolicyFor,
  type ProviderLogin,
  ProviderLoginError,
  providerRedirectUri,
} from "./provider-login.ts";

const NOT_FOUND = () =>
  new SessionServiceError("NOT_FOUND", "No such sign-in provider");

/** A change the provider's state does not take; `reason` tells which. */
const conflict = (
  reason: "provider_enabled" | "not_tested" | "last_provider",
  message: string,
) =>
  new SessionServiceError("REVISION_CONFLICT", message, undefined, {
    reason_code: reason,
  });

const ENABLED = () =>
  conflict(
    "provider_enabled",
    "Turn the provider off before changing how it connects",
  );

const NO_CONSOLE_ORIGIN = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "CONSOLE_ORIGIN is not set, so no redirect URI can be built",
  );

function stateOf(record: LoginProviderRecord): LoginProviderState {
  if (record.enabled) {
    return record.pendingClientSecret ? "enabled_secret_pending" : "enabled";
  }
  if (record.clientId === null || record.clientSecret === null) return "draft";
  return record.testedConfigRevision === record.configRevision
    ? "ready"
    : "needs_test";
}

/** The hosts the server's own requests for this provider go to. */
function endpointHosts(urls: readonly (string | null)[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    if (url !== null) hosts.add(new URL(url).host);
  }
  return [...hosts];
}

const secretView = (secret: LoginProviderSecretSummary | null) =>
  secret && {
    last4: secret.last4,
    updated_at: secret.updatedAt.toISOString(),
  };

/**
 * The owner's side of the sign-in providers (design 7): make one from its
 * discovery document, fill in the client, test it, turn it on and off.
 * Every method re-checks the caller; a secret's value goes in and never
 * comes back.
 */
export function createProviderAdmin(deps: {
  authorization: AuthorizationPolicy;
  store: LoginProviderAdminStore;
  login: Pick<ProviderLogin, "startTest">;
  /** The console's origin; every redirect URI is built on it. */
  consoleOrigin: string | null;
  request?: ProviderRequest;
}) {
  const { store } = deps;

  async function owner(caller: Caller): Promise<LoginProviderAudit> {
    await requirePermitted(
      deps.authorization,
      caller,
      "installation.settings.manage",
      { kind: "workspace", id: caller.ownerId },
    );
    const userId = caller.actor?.userId;
    const workspaceId = caller.actor?.workspaceId;
    if (caller.subject.principal?.kind !== "user" || !userId || !workspaceId) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Only a signed-in person manages the sign-in providers",
        undefined,
        { reason_code: "role" },
      );
    }
    return { userId, workspaceId, receiptId: randomUUID() };
  }

  const viewOf = (record: LoginProviderRecord): LoginProviderView => ({
    id: record.id,
    display_name: record.displayName,
    issuer: record.issuer,
    redirect_uri:
      deps.consoleOrigin === null
        ? null
        : providerRedirectUri(deps.consoleOrigin, record.id),
    authorization_endpoint: record.authorizationEndpoint,
    token_endpoint: record.tokenEndpoint,
    jwks_uri: record.jwksUri,
    userinfo_endpoint: record.userinfoEndpoint,
    endpoint_hosts: endpointHosts([
      record.issuer,
      record.tokenEndpoint,
      record.jwksUri,
      record.userinfoEndpoint,
    ]),
    signing_algs: record.signingAlgs,
    pkce_advertised: record.pkceAdvertised,
    discovery_checked_at: record.discoveryCheckedAt.toISOString(),
    client_id: record.clientId,
    token_auth_method: record.tokenAuthMethod,
    client_secret: secretView(record.clientSecret),
    pending_client_secret: secretView(record.pendingClientSecret),
    allowed_domains: record.allowedDomains,
    jit_role: record.jitRole,
    require_verified_email: record.requireVerifiedEmail,
    state: stateOf(record),
    tested_at: record.testedAt?.toISOString() ?? null,
    revision: record.revision,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  });

  /**
   * Reads the issuer's discovery document now. A document this client
   * cannot work with, or none to read, comes back as its problem.
   */
  async function discovered(issuer: string): Promise<
    | { endpoints: LoginProviderEndpoints }
    | {
        problem: Extract<
          DiscoverLoginProviderResponse,
          { outcome: "failed" }
        >["problem"];
      }
  > {
    if (deps.consoleOrigin === null) throw NO_CONSOLE_ORIGIN();
    try {
      const endpoints = await discover(
        issuer,
        networkPolicyFor(deps.consoleOrigin),
        ...(deps.request ? [deps.request] : []),
      );
      return { endpoints };
    } catch (error) {
      if (error instanceof OidcDiscoveryError)
        return { problem: error.problem };
      if (error instanceof OidcUnavailableError) {
        return {
          problem:
            error.kind === "address_not_allowed"
              ? "address_not_allowed"
              : "unreachable",
        };
      }
      throw error;
    }
  }

  const undiscovered = (problem: string) =>
    new SessionServiceError(
      "BAD_REQUEST",
      "The issuer's discovery document cannot be used",
      undefined,
      { problem },
    );

  return {
    async list(caller: Caller): Promise<ListLoginProvidersResponse> {
      await owner(caller);
      return {
        providers: (await store.list()).map(viewOf),
        console_origin_configured: deps.consoleOrigin !== null,
      };
    },

    /** Checks an issuer without keeping anything. */
    async discover(
      caller: Caller,
      issuer: string,
    ): Promise<DiscoverLoginProviderResponse> {
      await owner(caller);
      const read = await discovered(issuer);
      if ("problem" in read)
        return { outcome: "failed", problem: read.problem };
      const { endpoints } = read;
      return {
        outcome: "ok",
        endpoint_hosts: endpointHosts([
          endpoints.issuer,
          endpoints.tokenEndpoint,
          endpoints.jwksUri,
          endpoints.userinfoEndpoint,
        ]),
        signing_algs: endpoints.signingAlgs,
        token_auth_methods: endpoints.tokenAuthMethods,
        pkce_advertised: endpoints.pkceAdvertised,
      };
    },

    async create(
      caller: Caller,
      body: CreateLoginProviderRequest,
    ): Promise<LoginProviderView> {
      const audit = await owner(caller);
      const read = await discovered(body.issuer);
      if ("problem" in read) throw undiscovered(read.problem);
      const made = await store.create({
        id: randomUUID(),
        displayName: body.display_name,
        endpoints: read.endpoints,
        audit,
      });
      if (made.outcome === "issuer_taken") {
        throw new SessionServiceError(
          "ALREADY_EXISTS",
          "A sign-in provider with this issuer already exists",
        );
      }
      return viewOf(made.provider);
    },

    async update(
      caller: Caller,
      id: string,
      ifMatch: string | undefined,
      body: UpdateLoginProviderRequest,
    ): Promise<LoginProviderView> {
      const audit = await owner(caller);
      const changes: LoginProviderChanges = {
        ...(body.display_name === undefined
          ? {}
          : { displayName: body.display_name }),
        ...(body.client_id === undefined ? {} : { clientId: body.client_id }),
        ...(body.token_auth_method === undefined
          ? {}
          : { tokenAuthMethod: body.token_auth_method }),
        ...(body.allowed_domains === undefined
          ? {}
          : { allowedDomains: [...new Set(body.allowed_domains)] }),
        ...(body.jit_role === undefined ? {} : { jitRole: body.jit_role }),
        ...(body.require_verified_email === undefined
          ? {}
          : { requireVerifiedEmail: body.require_verified_email }),
      };
      const updated = await store.update({
        id,
        ifMatch: ifMatchOf(ifMatch),
        changes,
        refuse: (next) => policyProblem(next.issuer, next),
        audit,
      });
      if (updated.outcome === "not_found") throw NOT_FOUND();
      if (updated.outcome === "locked") throw ENABLED();
      if (updated.outcome === "refused") {
        throw new SessionServiceError(
          "BAD_REQUEST",
          "This provider cannot be used with these rules for who may come in",
          undefined,
          { problem: updated.problem },
        );
      }
      if (updated.outcome === "stale") {
        throw new SessionServiceError(
          "VERSION_MISMATCH",
          "The provider changed since it was read; read it again",
          undefined,
          { current_version: updated.revision },
        );
      }
      return viewOf(updated.provider);
    },

    async refreshDiscovery(
      caller: Caller,
      id: string,
    ): Promise<LoginProviderView> {
      const audit = await owner(caller);
      const provider = (await store.list()).find((row) => row.id === id);
      if (!provider) throw NOT_FOUND();
      if (provider.enabled) throw ENABLED();
      const read = await discovered(provider.issuer);
      if ("problem" in read) throw undiscovered(read.problem);
      const updated = await store.refreshDiscovery({
        id,
        endpoints: read.endpoints,
        audit,
      });
      if (updated.outcome === "not_found") throw NOT_FOUND();
      if (updated.outcome === "locked") throw ENABLED();
      // discover() already refuses a document that names another issuer.
      if (updated.outcome === "issuer_changed") {
        throw undiscovered("issuer_mismatch");
      }
      return viewOf(updated.provider);
    },

    async setClientSecret(
      caller: Caller,
      id: string,
      value: string,
    ): Promise<LoginProviderView> {
      const audit = await owner(caller);
      const stored = await store.setClientSecret({ id, value, audit });
      if (stored.outcome === "not_found") throw NOT_FOUND();
      if (stored.outcome === "no_workspace") {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "No workspace exists to keep the secret under",
        );
      }
      return viewOf(stored.provider);
    },

    /** The authorization URL of a test sign-in and its flow cookie. */
    async startTest(
      caller: Caller,
      id: string,
      sessionId: string | undefined,
    ): Promise<{ authorizationUrl: string; cookieValue: string }> {
      const audit = await owner(caller);
      if (sessionId === undefined) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "A test sign-in is started from the console",
          undefined,
          { reason_code: "role" },
        );
      }
      try {
        return await deps.login.startTest({
          providerId: id,
          userId: audit.userId,
          sessionId,
        });
      } catch (error) {
        if (!(error instanceof ProviderLoginError)) throw error;
        if (error.kind === "not_found") throw NOT_FOUND();
        if (error.reason === "console_origin_unset") throw NO_CONSOLE_ORIGIN();
        if (error.reason === "client_not_configured") {
          throw conflict(
            "not_tested",
            "Set the client ID and the client secret before a test sign-in",
          );
        }
        throw new SessionServiceError(
          "BAD_REQUEST",
          "The provider's authorization endpoint cannot be used",
          undefined,
          { problem: error.reason },
        );
      }
    },

    async enable(caller: Caller, id: string): Promise<LoginProviderView> {
      const audit = await owner(caller);
      const enabled = await store.enable({ id, audit });
      if (enabled.outcome === "not_found") throw NOT_FOUND();
      if (enabled.outcome === "not_ready") {
        throw conflict(
          "not_tested",
          "A test sign-in has to pass with the settings as they are now",
        );
      }
      return viewOf(enabled.provider);
    },

    async disable(
      caller: Caller,
      id: string,
    ): Promise<{ provider: LoginProviderView; sessions_revoked: number }> {
      const audit = await owner(caller);
      const disabled = await store.disable({ id, audit });
      if (disabled.outcome === "not_found") throw NOT_FOUND();
      if (disabled.outcome === "last_provider") {
        throw conflict(
          "last_provider",
          "Turn password sign-in on before turning the last provider off",
        );
      }
      return {
        provider: viewOf(disabled.provider),
        sessions_revoked: disabled.sessionsRevoked,
      };
    },

    async remove(caller: Caller, id: string): Promise<void> {
      const audit = await owner(caller);
      const removed = await store.delete({ id, audit });
      if (removed.outcome === "not_found") throw NOT_FOUND();
      if (removed.outcome === "enabled") {
        throw conflict(
          "provider_enabled",
          "Turn the provider off before deleting it",
        );
      }
    },
  };
}

export type ProviderAdmin = ReturnType<typeof createProviderAdmin>;
