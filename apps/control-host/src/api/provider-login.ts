import type {
  LoginProviderTestEntry,
  LoginProviderTestResult,
} from "@werft-ai/contracts";
import {
  LOGIN_FLOW_COOKIE_NAME,
  LOGIN_FLOW_TTL_MINUTES,
} from "@werft-ai/contracts";
import type {
  LoginProvider,
  LoginProviderAdminStore,
  LoginProviderEntryPreview,
  LoginProviderStore,
} from "@werft-ai/platform";
import { type Admission, admit, ownsAddress } from "./oidc/admission.ts";
import {
  createFlowSealer,
  type FlowPurpose,
  type LoginFlow,
} from "./oidc/flow-cookie.ts";
import {
  authorizationParams,
  endpointProblem,
  finishFlow,
  type NetworkPolicy,
  type OidcClient,
  type OidcEndpoints,
  type OidcIdentity,
  OidcRejectedError,
  OidcUnavailableError,
  type ProviderRequest,
  startFlow,
  tokenIssuers,
} from "./oidc/index.ts";
import { sameString } from "./same-string.ts";

const FLOW_TTL_MS = LOGIN_FLOW_TTL_MINUTES * 60 * 1000;
// A flow cookie sealed by a replica whose clock runs ahead of this one.
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Why a provider sign-in did not go through. `reason` is for the server
 * log; a response says no more than the kind.
 */
export class ProviderLoginError extends Error {
  constructor(
    /**
     * `not_found`: no such provider, or it is off. `rejected`: the flow or
     * the provider's answer does not prove who is signing in. `forbidden`:
     * proven, and outside the allowed domains. `unavailable`: the provider
     * or this installation's settings cannot serve a sign-in now.
     */
    readonly kind: "not_found" | "rejected" | "forbidden" | "unavailable",
    readonly reason: string,
  ) {
    super(`provider sign-in ${kind}: ${reason}`);
    this.name = "ProviderLoginError";
  }
}

/**
 * What a real sign-in by the account that passed a test would end in
 * (design 6.1), read without making anything.
 */
function entryOf(
  admission: Admission | null,
  known: LoginProviderEntryPreview,
  email: string | null,
): LoginProviderTestEntry {
  if (admission === null) return "domain_not_allowed";
  if (known === "refused") return "refused";
  if (known === "linked") return "signs_in";
  if (known === "account_exists") {
    return admission.ownsEmail ? "link_required" : "refused";
  }
  return email !== null && admission.jitRole !== null ? "joins" : "invite_only";
}

export type ProviderLoginDeps = {
  providers: LoginProviderStore;
  /** The owner's side of the providers; without it no test sign-in runs. */
  admin?: Pick<
    LoginProviderAdminStore,
    "findForTest" | "recordTest" | "previewEntry"
  >;
  /** The console's origin; every redirect URI is built on it. */
  consoleOrigin: string | null;
  /** 32 bytes kept for sealing flow cookies. */
  flowKey: Buffer;
  now?: () => number;
  request?: ProviderRequest;
};

export type ProviderLogin = ReturnType<typeof createProviderLogin>;

/** The redirect URI a provider is registered with: one per provider. */
export function providerRedirectUri(
  consoleOrigin: string,
  providerId: string,
): string {
  return `${new URL(consoleOrigin).origin}/auth/callback/${providerId}`;
}

/**
 * Plain http reaches a provider only on loopback, and only when the
 * console itself is on loopback: a local stack with a stand-in provider.
 */
export function networkPolicyFor(consoleOrigin: string): NetworkPolicy {
  const host = new URL(consoleOrigin).hostname;
  return {
    plainHttp: ["localhost", "127.0.0.1", "[::1]"].includes(host)
      ? "loopback"
      : "refuse",
  };
}

async function asLoginError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OidcRejectedError) {
      throw new ProviderLoginError("rejected", error.reason);
    }
    if (error instanceof OidcUnavailableError) {
      throw new ProviderLoginError("unavailable", error.kind);
    }
    throw error;
  }
}

/**
 * Sign-in with the providers stored as settings. Every request reads its
 * provider row again: nothing about a provider is kept in this process.
 */
export function createProviderLogin(deps: ProviderLoginDeps) {
  const now = deps.now ?? Date.now;
  const sealer = createFlowSealer(deps.flowKey, LOGIN_FLOW_COOKIE_NAME);

  /** Everything a request to this provider needs, or why it cannot be made. */
  const connectionOf = (found: {
    provider: LoginProvider;
    clientSecret: string | null;
  }) => {
    const { provider, clientSecret } = found;
    if (deps.consoleOrigin === null) {
      throw new ProviderLoginError("unavailable", "console_origin_unset");
    }
    if (provider.clientId === null || clientSecret === null) {
      throw new ProviderLoginError("unavailable", "client_not_configured");
    }
    const client: OidcClient = {
      clientId: provider.clientId,
      clientSecret,
      tokenAuthMethod: provider.tokenAuthMethod,
      redirectUri: providerRedirectUri(deps.consoleOrigin, provider.id),
    };
    const endpoints: OidcEndpoints = {
      issuer: provider.issuer,
      authorizationEndpoint: provider.authorizationEndpoint,
      tokenEndpoint: provider.tokenEndpoint,
      jwksUri: provider.jwksUri,
      userinfoEndpoint: provider.userinfoEndpoint,
      signingAlgs: provider.signingAlgs,
      tokenAuthMethods: [provider.tokenAuthMethod],
      issParameterRequired: provider.issParameterRequired,
      // Not read by a sign-in: PKCE is always sent.
      pkceAdvertised: true,
    };
    return { client, endpoints, policy: networkPolicyFor(deps.consoleOrigin) };
  };

  type Started = {
    authorizationUrl: string;
    /** Goes into the flow cookie; never logged. */
    cookieValue: string;
  };

  /** The authorization request of a flow, and the cookie that binds it. */
  const begin = (
    found: { provider: LoginProvider; clientSecret: string | null },
    bound: Pick<LoginFlow, "purpose" | "test">,
  ): Started => {
    const { client, endpoints, policy } = connectionOf(found);
    // The browser is sent here, so the same rule as the server's requests.
    if (endpointProblem(endpoints.authorizationEndpoint, policy) !== null) {
      throw new ProviderLoginError(
        "unavailable",
        "authorization_endpoint_not_allowed",
      );
    }
    const flow = startFlow({
      endpoints,
      client,
      extraParams: authorizationParams(
        found.provider.issuer,
        found.provider.allowedDomains,
      ),
    });
    return {
      authorizationUrl: flow.authorizationUrl,
      cookieValue: sealer.seal({
        ...bound,
        providerId: found.provider.id,
        configRevision: found.provider.configRevision,
        state: flow.state,
        nonce: flow.nonce,
        verifier: flow.verifier,
        startedAt: now(),
      }),
    };
  };

  type CallbackInput = {
    cookieValue: string | undefined;
    /** From the path the provider sent the browser back to. */
    providerId: string;
    code: string;
    state: string;
    /** `iss` of the authorization response, when there was one. */
    responseIssuer: string | undefined;
  };

  /** The flow the callback belongs to (design 4.3 step 1). */
  const flowOf = (input: CallbackInput, purpose: FlowPurpose): LoginFlow => {
    const flow = sealer.open(input.cookieValue);
    if (flow === null) {
      throw new ProviderLoginError("rejected", "flow_missing");
    }
    if (!sameString(input.state, flow.state)) {
      throw new ProviderLoginError("rejected", "state_mismatch");
    }
    const age = now() - flow.startedAt;
    if (age > FLOW_TTL_MS || age < -CLOCK_SKEW_MS) {
      throw new ProviderLoginError("rejected", "flow_expired");
    }
    if (flow.providerId !== input.providerId) {
      throw new ProviderLoginError("rejected", "provider_mismatch");
    }
    if (flow.purpose !== purpose) {
      throw new ProviderLoginError("rejected", "flow_purpose");
    }
    return flow;
  };

  return {
    /** The sign-in buttons: the providers that are on. */
    buttons: () => deps.providers.listEnabled(),

    /** Throws ProviderLoginError. */
    async start(providerId: string): Promise<Started> {
      const found = await deps.providers.findForSignIn(providerId);
      if (!found?.provider.enabled) {
        throw new ProviderLoginError("not_found", "provider_off");
      }
      return begin(found, { purpose: "login" });
    },

    /**
     * What the flow in this cookie is for, so the callback knows which end
     * to run; null when the cookie does not open. Nothing is decided here.
     */
    purposeOf(cookieValue: string | undefined): FlowPurpose | null {
      return sealer.open(cookieValue)?.purpose ?? null;
    },

    /**
     * An owner's test sign-in: the same flow as a sign-in, on a provider
     * that may be off, ending in no account and no session. Throws
     * ProviderLoginError.
     */
    async startTest(input: {
      providerId: string;
      /** The owner and the session the test is started from. */
      userId: string;
      sessionId: string;
    }): Promise<Started> {
      const found = await deps.admin?.findForTest(input.providerId);
      if (!found) {
        throw new ProviderLoginError("not_found", "provider_missing");
      }
      if (found.secretVersion === null) {
        throw new ProviderLoginError("unavailable", "client_not_configured");
      }
      return begin(found, {
        purpose: "test",
        test: {
          userId: input.userId,
          sessionId: input.sessionId,
          secretSlot: found.slot,
          secretVersion: found.secretVersion,
        },
      });
    },

    /**
     * The callback of a `test` flow. Runs every check a sign-in runs and
     * says what the provider answered; a pass is written down only if the
     * settings and the secret are still the ones the test started with.
     * Throws ProviderLoginError for a flow that is not this owner's test.
     */
    async finishTest(
      input: CallbackInput & {
        /** The session of this request, when it is a live owner's. */
        owner: {
          userId: string;
          sessionId: string;
          workspaceId: string;
        } | null;
        receiptId: string;
      },
    ): Promise<{ providerId: string; test: LoginProviderTestResult }> {
      const flow = flowOf(input, "test");
      if (
        input.owner === null ||
        flow.test === undefined ||
        input.owner.userId !== flow.test.userId ||
        input.owner.sessionId !== flow.test.sessionId
      ) {
        throw new ProviderLoginError("rejected", "test_session");
      }
      const admin = deps.admin;
      const found = await admin?.findForTest(flow.providerId);
      if (!admin || !found) {
        throw new ProviderLoginError("not_found", "provider_missing");
      }
      const failed = (reason: string) => ({
        providerId: flow.providerId,
        test: { passed: false as const, reason },
      });
      const { provider } = found;
      if (
        provider.configRevision !== flow.configRevision ||
        found.slot !== flow.test.secretSlot ||
        found.secretVersion !== flow.test.secretVersion ||
        found.clientSecret === null
      ) {
        return failed("config_changed");
      }
      let identity: OidcIdentity;
      try {
        const { client, endpoints, policy } = connectionOf(found);
        identity = await finishFlow({
          endpoints,
          client,
          issuers: tokenIssuers(provider.issuer),
          code: input.code,
          ...(input.responseIssuer === undefined
            ? {}
            : { responseIssuer: input.responseIssuer }),
          nonce: flow.nonce,
          verifier: flow.verifier,
          requireVerifiedEmail: provider.requireVerifiedEmail,
          policy,
          now,
          ...(deps.request ? { request: deps.request } : {}),
        });
      } catch (error) {
        // The owner setting the provider up is told why; a sign-in is not.
        if (error instanceof OidcRejectedError) return failed(error.reason);
        if (error instanceof OidcUnavailableError) {
          return failed(`provider_${error.kind}`);
        }
        if (error instanceof ProviderLoginError) return failed(error.reason);
        throw error;
      }
      const admission = admit(provider, identity);
      const known = await admin.previewEntry({
        issuer: identity.issuer,
        subject: identity.subject,
        email: identity.email,
      });
      const recorded = await admin.recordTest({
        id: provider.id,
        configRevision: flow.configRevision,
        slot: flow.test.secretSlot,
        clientSecret: found.clientSecret,
        audit: {
          userId: input.owner.userId,
          workspaceId: input.owner.workspaceId,
          receiptId: input.receiptId,
        },
      });
      return {
        providerId: provider.id,
        test: {
          passed: true,
          recorded: recorded.outcome === "recorded",
          subject: identity.subject,
          email: identity.email,
          email_verified: identity.emailVerified,
          address_owned: ownsAddress(provider.issuer, identity),
          entry: entryOf(admission, known, identity.email),
        },
      };
    },

    /**
     * The callback of a `login` flow, up to who signed in and how they may
     * come in. Throws ProviderLoginError. The caller still makes the
     * session, and that reads the provider row once more under a lock.
     */
    async finish(input: CallbackInput): Promise<{
      provider: LoginProvider;
      identity: OidcIdentity;
      admission: Admission;
    }> {
      const flow = flowOf(input, "login");
      const found = await deps.providers.findForSignIn(flow.providerId);
      if (!found?.provider.enabled) {
        throw new ProviderLoginError("not_found", "provider_off");
      }
      const { provider } = found;
      if (provider.configRevision !== flow.configRevision) {
        throw new ProviderLoginError("rejected", "config_changed");
      }
      const { client, endpoints, policy } = connectionOf(found);
      const identity = await asLoginError(() =>
        finishFlow({
          endpoints,
          client,
          issuers: tokenIssuers(provider.issuer),
          code: input.code,
          ...(input.responseIssuer === undefined
            ? {}
            : { responseIssuer: input.responseIssuer }),
          nonce: flow.nonce,
          verifier: flow.verifier,
          requireVerifiedEmail: provider.requireVerifiedEmail,
          policy,
          now,
          ...(deps.request ? { request: deps.request } : {}),
        }),
      );
      const admission = admit(provider, identity);
      if (admission === null) {
        throw new ProviderLoginError("forbidden", "domain_not_allowed");
      }
      return { provider, identity, admission };
    },
  };
}
