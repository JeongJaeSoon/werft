import { randomUUID } from "node:crypto";
import {
  type AuthorizationAction,
  authMeResponseSchema,
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  issuePasswordResetRequestSchema,
  issuePasswordResetResponseSchema,
  LOGIN_FLOW_COOKIE_NAME,
  LOGIN_FLOW_TTL_MINUTES,
  loginMethodsResponseSchema,
  loginProviderParamsSchema,
  loginRequestSchema,
  loginResponseSchema,
  memberParamsSchema,
  normalizeEmail,
  PASSWORD_RESET_TTL_MINUTES,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  providerLoginCallbackRequestSchema,
  providerLoginCallbackResponseSchema,
  scopesForRole,
  startProviderLoginResponseSchema,
  updateAuthMeRequestSchema,
  type Workspace,
  type WorkspaceRole,
  workspaceSettingsSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  BootstrapDoneError,
  BootstrapTokenSpentError,
  type IdentityStore,
  type IdentityWorkspace,
  MANAGEMENT_ROLES,
  passwordResetIssueDenial,
} from "@werft-ai/platform";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  ingestThenStopClock,
  isStorageUnavailable,
  jsonWithSchema,
  parseJsonBody,
  storageUnavailableError,
} from "../app.ts";
import {
  type BootstrapGate,
  browserRequestViolation,
  clearWebSessionCookie,
  generatePasswordResetToken,
  generateWebSessionToken,
  hashPassword,
  hashWebSessionToken,
  LoginLockout,
  setWebSessionCookie,
  verifyPassword,
  WEB_SESSION_TTL_MS,
  WEB_SESSIONS_PER_USER,
  WorkGate,
  webSessionCookie,
} from "../auth.ts";
import { type ProviderLogin, ProviderLoginError } from "../provider-login.ts";
import { rateLimited, requireParams } from "./errors.ts";

export interface AuthRouteDeps {
  identity: IdentityStore;
  bootstrap: BootstrapGate;
  /** Shared with reset issuance, which re-checks the issuer's password. */
  lockout?: LoginLockout;
  passwordWork?: WorkGate;
  logger?: StructuredLogger;
  /** Absent: no provider sign-in; the list is empty and its routes 404. */
  providers?: ProviderLogin;
  /** How many callbacks may be calling a provider at once. */
  providerWork?: WorkGate;
}

const INVALID_CREDENTIALS = "Invalid email or password";
const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
// The recovery routes keep no failure window. Their tokens are 256 bits
// (BOOTSTRAP_TOKEN at least 32 characters), so a window adds nothing against
// guessing, and with no address to key it on it would be one window for
// every caller: anyone could keep recovery answering 429.

// The token is read on its own and checked before the rest of the body is
// validated, so a caller without it learns nothing about the schema and gets
// 401 rather than 400. A body that is not a JSON object cannot carry a
// token at all and stays a 400.
const bootstrapTokenOnlySchema = z.looseObject({
  bootstrap_token: z.unknown().optional(),
});

function invalidBootstrapToken(): ApiHttpError {
  return new ApiHttpError(401, "UNAUTHORIZED", "Bootstrap token is invalid");
}

async function storageMapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isStorageUnavailable(error)) {
      throw storageUnavailableError();
    }
    throw error;
  }
}

/** The workspace management actions a role holds, from the policy's own table. */
export function permissionsOf(role: WorkspaceRole): AuthorizationAction[] {
  return (
    Object.entries(MANAGEMENT_ROLES) as [
      AuthorizationAction,
      readonly WorkspaceRole[],
    ][]
  )
    .filter(([, roles]) => roles.includes(role))
    .map(([action]) => action);
}

export function workspaceView(row: IdentityWorkspace): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    settings: workspaceSettingsSchema.parse(row.settings),
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The signed-in user's current password, checked like a login: the same
 * per-email failure window and the same hashing gate. Returns the hash it
 * matched, for the store to confirm it has not changed since.
 */
async function reauthenticate(
  deps: {
    lockout: LoginLockout;
    passwordWork: WorkGate;
    identity: IdentityStore;
    logger: StructuredLogger | undefined;
  },
  who: { userId: string; email: string },
  password: string,
): Promise<string> {
  const lockedFor = deps.lockout.retryAfterMs(who.email);
  if (lockedFor > 0) {
    throw rateLimited(lockedFor, "Too many failed password checks");
  }
  const slot = deps.passwordWork.tryAcquire();
  if (!slot) {
    throw rateLimited(1000, "Too many password checks in progress");
  }
  const releaseSlot = await slot;
  let hash: string;
  try {
    const reservation = deps.lockout.reserve(who.email);
    if (reservation.retryAfterMs > 0) {
      throw rateLimited(
        reservation.retryAfterMs,
        "Too many failed password checks",
      );
    }
    let found: Awaited<ReturnType<IdentityStore["findUserForLogin"]>>;
    let verified: boolean;
    try {
      found = await storageMapped(() =>
        deps.identity.findUserForLogin(who.email),
      );
      verified = await verifyPassword(password, found?.passwordHash ?? null);
    } catch (error) {
      reservation.release();
      throw error;
    }
    if (
      !found ||
      found.id !== who.userId ||
      found.passwordHash === null ||
      !verified
    ) {
      deps.logger?.warn("Password check failed", { user_id: who.userId });
      throw new ApiHttpError(403, "FORBIDDEN", "Current password is incorrect");
    }
    hash = found.passwordHash;
  } finally {
    releaseSlot();
  }
  deps.lockout.clear(who.email);
  return hash;
}

/** Mounted outside the auth middleware (03 §3.2 public allowlist). */
export function registerPublicAuthRoutes(
  router: ApiRouter,
  deps: AuthRouteDeps,
) {
  const lockout = deps.lockout ?? new LoginLockout();
  const passwordWork = deps.passwordWork ?? new WorkGate();

  const providerWork = deps.providerWork ?? new WorkGate();

  apiRoute(router, "listLoginMethods", ingestThenStopClock, async (context) => {
    const providers = deps.providers;
    const buttons = providers
      ? await storageMapped(() => providers.buttons())
      : [];
    return jsonWithSchema(context, loginMethodsResponseSchema, {
      password: "on",
      providers: buttons.map((button) => ({
        id: button.id,
        display_name: button.displayName,
      })),
    });
  });

  apiRoute(router, "bootstrap", ingestThenStopClock, async (context) => {
    const raw = await parseJsonBody(context, bootstrapTokenOnlySchema);
    const token =
      typeof raw.bootstrap_token === "string" ? raw.bootstrap_token : null;
    if (token === null || !deps.bootstrap.matches(token)) {
      deps.logger?.warn("Bootstrap refused: token mismatch");
      throw invalidBootstrapToken();
    }
    // Looked at only once the token matched, so a caller without it cannot
    // tell an install with a live owner from one without.
    if ((await storageMapped(() => deps.identity.countLiveOwners())) > 0) {
      // Startup spends a token configured while an owner is live, but only
      // when it reaches the database; this covers a start that did not.
      await storageMapped(() =>
        deps.identity.retireBootstrapToken(hashWebSessionToken(token)),
      );
      throw new ApiHttpError(409, "BOOTSTRAP_DONE", "Bootstrap already done");
    }
    const parsed = bootstrapRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // The token stays unspent: a typo in the form is not a used install.
      throw new ApiHttpError(400, "BAD_REQUEST", "Request body is invalid");
    }
    const body = parsed.data;
    if (!deps.bootstrap.consume(token)) {
      // A concurrent request with the same token got there first.
      throw new ApiHttpError(409, "BOOTSTRAP_DONE", "Bootstrap already done");
    }
    try {
      const passwordHash = await hashPassword(body.password);
      const { user, workspace, recovered } = await storageMapped(() =>
        deps.identity.bootstrap({
          userId: randomUUID(),
          email: normalizeEmail(body.email),
          passwordHash,
          displayName: body.display_name,
          workspaceId: randomUUID(),
          workspaceSlug: body.workspace_slug,
          workspaceName: body.workspace_name,
          bootstrapTokenHash: hashWebSessionToken(token),
          receiptId: randomUUID(),
          loginMethodId: randomUUID(),
        }),
      );
      deps.logger?.info(
        recovered ? "Bootstrap recovered an owner" : "Bootstrap completed",
        { user_id: user.id, workspace_id: workspace.id },
      );
      return jsonWithSchema(
        context,
        bootstrapResponseSchema,
        {
          user_id: user.id,
          workspace: workspaceView(workspace),
          role: "owner",
        },
        201,
      );
    } catch (error) {
      if (error instanceof BootstrapDoneError) {
        throw new ApiHttpError(409, "BOOTSTRAP_DONE", "Bootstrap already done");
      }
      if (error instanceof BootstrapTokenSpentError) {
        // Recorded in the database, so a restart does not revive it. Only
        // the operator, reading the log, needs to know why.
        deps.logger?.warn(
          "Bootstrap refused: token already used; set a new BOOTSTRAP_TOKEN",
        );
        throw invalidBootstrapToken();
      }
      // The insert failed (storage down, slug race); the token is still the
      // operator's to spend.
      deps.bootstrap.release();
      throw error;
    }
  });

  apiRoute(router, "resetPassword", ingestThenStopClock, async (context) => {
    const body = await parseJsonBody(context, passwordResetRequestSchema);
    const slot = passwordWork.tryAcquire();
    if (!slot) {
      throw rateLimited(1000, "Too many password changes in progress");
    }
    const releaseSlot = await slot;
    let reset: Awaited<ReturnType<IdentityStore["consumePasswordReset"]>>;
    const receiptId = randomUUID();
    try {
      const passwordHash = await hashPassword(body.password);
      reset = await storageMapped(() =>
        deps.identity.consumePasswordReset({
          tokenHash: hashWebSessionToken(body.token),
          passwordHash,
          receiptId,
        }),
      );
    } finally {
      releaseSlot();
    }
    if (!reset) {
      deps.logger?.warn("Password reset refused: link invalid or expired");
      throw new ApiHttpError(
        401,
        "UNAUTHORIZED",
        "Password reset link is invalid or has expired",
      );
    }
    deps.logger?.info("Password reset completed", {
      user_id: reset.userId,
      workspace_id: reset.workspaceId,
    });
    return jsonWithSchema(context, passwordResetResponseSchema, {
      user_id: reset.userId,
      receipt_id: receiptId,
    });
  });

  apiRoute(router, "login", ingestThenStopClock, async (context) => {
    const violation = browserRequestViolation(context);
    if (violation) {
      throw new ApiHttpError(403, "FORBIDDEN", `Refused: ${violation}`);
    }
    const body = await parseJsonBody(context, loginRequestSchema);
    const email = normalizeEmail(body.email);
    const lockedFor = lockout.retryAfterMs(email);
    if (lockedFor > 0) {
      throw rateLimited(lockedFor, "Too many failed logins");
    }
    // Shed before any lookup or hash: the per-email lockout alone does not
    // bound work when every attempt names a new address.
    const slot = passwordWork.tryAcquire();
    if (!slot) {
      throw rateLimited(1000, "Too many logins in progress");
    }
    const releaseSlot = await slot;
    let user: NonNullable<
      Awaited<ReturnType<IdentityStore["findUserForLogin"]>>
    >;
    let membership: NonNullable<
      Awaited<ReturnType<IdentityStore["findLiveMembership"]>>
    >;
    let verifiedPasswordHash: string;
    try {
      // Counted as a failure before the password is checked, in the same
      // synchronous step as the lockout check: a burst of concurrent
      // guesses cannot all see the window open while their hashes are
      // still running. Success clears it below.
      const reservation = lockout.reserve(email);
      if (reservation.retryAfterMs > 0) {
        throw rateLimited(reservation.retryAfterMs, "Too many failed logins");
      }
      let found: Awaited<ReturnType<IdentityStore["findUserForLogin"]>>;
      let verified: boolean;
      let live: Awaited<ReturnType<IdentityStore["findLiveMembership"]>>;
      try {
        found = await storageMapped(() =>
          deps.identity.findUserForLogin(email),
        );
        verified = await verifyPassword(
          body.password,
          found?.passwordHash ?? null,
        );
        const candidate = found;
        live =
          verified && candidate
            ? await storageMapped(() =>
                deps.identity.findLiveMembership(candidate.id),
              )
            : null;
      } catch (error) {
        // An outage is not a guess: without this, five 503s in a row would
        // lock the account out for the whole window after the DB recovers.
        reservation.release();
        throw error;
      }
      if (!found || !verified || !live || found.passwordHash === null) {
        // A user with no live workspace fails like a wrong password; the
        // reservation above already counted it, so probing is bounded.
        deps.logger?.warn("Login failed", { has_user: found !== null });
        throw new ApiHttpError(401, "UNAUTHORIZED", INVALID_CREDENTIALS);
      }
      user = found;
      membership = live;
      verifiedPasswordHash = found.passwordHash;
    } finally {
      releaseSlot();
    }
    lockout.clear(email);
    const token = generateWebSessionToken();
    const created = await storageMapped(() =>
      deps.identity.createWebSession({
        id: randomUUID(),
        userId: user.id,
        verifiedPasswordHash,
        tokenHash: hashWebSessionToken(token),
        ttlMs: WEB_SESSION_TTL_MS,
        userAgent: context.req.header("User-Agent")?.slice(0, 512) ?? null,
        maxLive: WEB_SESSIONS_PER_USER,
      }),
    );
    if (!created) {
      // A reset or a disable landed after the password was checked.
      throw new ApiHttpError(401, "UNAUTHORIZED", INVALID_CREDENTIALS);
    }
    const { expiresAt } = created;
    setWebSessionCookie(context, token, expiresAt);
    return jsonWithSchema(context, loginResponseSchema, {
      user_id: user.id,
      workspace_id: membership.workspaceId,
      role: membership.role,
      scopes: [...scopesForRole(membership.role)],
      expires_at: expiresAt.toISOString(),
    });
  });

  const providerOff = () =>
    new ApiHttpError(404, "NOT_FOUND", "No such sign-in provider");
  /**
   * The reason goes to the log only. Every 401 reads the same, so a caller
   * cannot tell which check failed.
   */
  const providerMapped = async <T>(
    providerId: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await storageMapped(work);
    } catch (error) {
      if (!(error instanceof ProviderLoginError)) throw error;
      deps.logger?.warn("Provider sign-in refused", {
        provider_id: providerId,
        kind: error.kind,
        reason: error.reason,
      });
      if (error.kind === "not_found") throw providerOff();
      if (error.kind === "forbidden") {
        throw new ApiHttpError(
          403,
          "FORBIDDEN",
          "This account's domain is not allowed here",
        );
      }
      if (error.kind === "unavailable") {
        throw new ApiHttpError(
          503,
          "BACKEND_UNAVAILABLE",
          "Sign-in with this provider is unavailable, try again later",
          true,
        );
      }
      throw new ApiHttpError(401, "UNAUTHORIZED", PROVIDER_REJECTED);
    }
  };
  const flowCookie = {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  } as const;

  apiRoute(
    router,
    "startProviderLogin",
    ingestThenStopClock,
    async (context) => {
      const violation = browserRequestViolation(context);
      if (violation) {
        throw new ApiHttpError(403, "FORBIDDEN", `Refused: ${violation}`);
      }
      const { id } = requireParams(context, loginProviderParamsSchema);
      const providers = deps.providers;
      if (!providers) throw providerOff();
      const flow = await providerMapped(id, () => providers.start(id));
      setCookie(context, LOGIN_FLOW_COOKIE_NAME, flow.cookieValue, {
        ...flowCookie,
        maxAge: LOGIN_FLOW_TTL_MINUTES * 60,
      });
      context.header("Cache-Control", "no-store");
      return jsonWithSchema(context, startProviderLoginResponseSchema, {
        authorization_url: flow.authorizationUrl,
      });
    },
  );

  apiRoute(
    router,
    "providerLoginCallback",
    // One try per flow, whatever it ends in: the provider takes a code
    // once. Ahead of the body, so a refusal of the body clears it too.
    (context, next) => {
      deleteCookie(context, LOGIN_FLOW_COOKIE_NAME, flowCookie);
      return ingestThenStopClock(context, next);
    },
    async (context) => {
      const violation = browserRequestViolation(context);
      if (violation) {
        throw new ApiHttpError(403, "FORBIDDEN", `Refused: ${violation}`);
      }
      const body = await parseJsonBody(
        context,
        providerLoginCallbackRequestSchema,
      );
      const cookieValue = getCookie(context, LOGIN_FLOW_COOKIE_NAME);
      const providers = deps.providers;
      if (!providers) throw providerOff();
      // The requests to the provider are made for anyone who asks.
      const slot = providerWork.tryAcquire();
      if (!slot) {
        throw rateLimited(1000, "Too many sign-ins in progress");
      }
      const releaseSlot = await slot;
      let finished: Awaited<ReturnType<ProviderLogin["finish"]>>;
      try {
        finished = await providerMapped(body.provider_id, () =>
          providers.finish({
            cookieValue,
            providerId: body.provider_id,
            code: body.code,
            state: body.state,
            responseIssuer: body.iss,
          }),
        );
      } finally {
        releaseSlot();
      }
      const { provider, identity, admission } = finished;
      const token = generateWebSessionToken();
      const result = await storageMapped(() =>
        deps.identity.signInWithExternalIdentity({
          kind: "oidc",
          provider: {
            id: provider.id,
            configRevision: provider.configRevision,
          },
          issuer: identity.issuer,
          subject: identity.subject,
          email: identity.email,
          displayName: displayNameFor(identity),
          jitRole: admission.jitRole,
          ownsEmail: admission.ownsEmail,
          newUserId: randomUUID(),
          newLoginMethodId: randomUUID(),
          receiptId: randomUUID(),
          session: {
            id: randomUUID(),
            tokenHash: hashWebSessionToken(token),
            ttlMs: WEB_SESSION_TTL_MS,
            userAgent: context.req.header("User-Agent")?.slice(0, 512) ?? null,
            maxLive: WEB_SESSIONS_PER_USER,
          },
        }),
      );
      if (result.outcome === "provider_off") {
        deps.logger?.warn("Provider sign-in refused", {
          provider_id: provider.id,
          kind: "not_found",
          reason: "provider_off_at_sign_in",
        });
        throw providerOff();
      }
      if (result.outcome === "link_required") {
        deps.logger?.info("Provider sign-in needs linking to an account", {
          provider_id: provider.id,
        });
        throw new ApiHttpError(
          409,
          "LOGIN_LINK_REQUIRED",
          "Sign in with your existing account, then connect this provider in settings",
        );
      }
      if (result.outcome === "rejected") {
        deps.logger?.warn("Provider sign-in refused", {
          provider_id: provider.id,
          kind: "rejected",
          reason: "no_rule_admits",
        });
        throw new ApiHttpError(401, "UNAUTHORIZED", PROVIDER_REJECTED);
      }
      deps.logger?.info("Provider sign-in", {
        provider_id: provider.id,
        user_id: result.userId,
        workspace_id: result.workspaceId,
        via: result.via,
      });
      setWebSessionCookie(context, token, result.expiresAt);
      return jsonWithSchema(context, providerLoginCallbackResponseSchema, {
        outcome: "signed_in",
        user_id: result.userId,
        workspace_id: result.workspaceId,
        role: result.role,
        scopes: [...scopesForRole(result.role)],
        expires_at: result.expiresAt.toISOString(),
      });
    },
  );
}

const PROVIDER_REJECTED = "Sign-in was not accepted";

function displayNameFor(identity: {
  name: string | null;
  email: string | null;
  subject: string;
}) {
  const name = identity.name?.trim().slice(0, 64);
  if (name) return name;
  const { email } = identity;
  return (email ? email.slice(0, email.indexOf("@")) : identity.subject).slice(
    0,
    64,
  );
}

/** Mounted inside the auth middleware. */
export function registerAuthRoutes(router: ApiRouter, deps: AuthRouteDeps) {
  const lockout = deps.lockout ?? new LoginLockout();
  const passwordWork = deps.passwordWork ?? new WorkGate();
  apiRoute(router, "logout", async (context) => {
    const principal = context.get("principal");
    const cookie = webSessionCookie(context);
    if (principal.kind !== "user" || !cookie) {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "Logout applies to a session cookie only",
      );
    }
    await storageMapped(() =>
      deps.identity.revokeWebSession(hashWebSessionToken(cookie)),
    );
    clearWebSessionCookie(context);
    return context.body(null, 204);
  });

  apiRoute(router, "updateAuthMe", async (context) => {
    const principal = context.get("principal");
    const session = context.get("webSession");
    if (principal.kind !== "user" || !session) {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "A user's settings change from their own session only",
      );
    }
    const body = await parseJsonBody(context, updateAuthMeRequestSchema);
    await storageMapped(() =>
      deps.identity.setUserLocale(session.userId, body.locale),
    );
    return context.body(null, 204);
  });

  apiRoute(router, "issuePasswordReset", async (context) => {
    const principal = context.get("principal");
    const session = context.get("webSession");
    const params = requireParams(context, memberParamsSchema);
    if (principal.kind !== "user" || !session) {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "Password reset links are issued from an owner's session",
      );
    }
    if (principal.workspace_id !== params.id) {
      throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
    }
    const denial = passwordResetIssueDenial(
      { userId: principal.id, role: principal.role },
      params.userId,
    );
    if (denial === "owner_required") {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "Only an owner can issue a password reset link",
      );
    }
    if (denial === "self_protected") {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "An owner cannot issue a password reset link for themselves",
      );
    }
    const body = await parseJsonBody(context, issuePasswordResetRequestSchema);
    const issuerPasswordHash = await reauthenticate(
      { lockout, passwordWork, identity: deps.identity, logger: deps.logger },
      { userId: principal.id, email: session.email },
      body.current_password,
    );
    const token = generatePasswordResetToken();
    const issued = await storageMapped(() =>
      deps.identity.issuePasswordReset({
        id: randomUUID(),
        workspaceId: params.id,
        userId: params.userId,
        issuedBy: principal.id,
        issuerPasswordHash,
        tokenHash: hashWebSessionToken(token),
        ttlMs: PASSWORD_RESET_TTL_MS,
        receiptId: randomUUID(),
      }),
    );
    switch (issued.outcome) {
      case "issued":
        break;
      case "not_found":
        throw new ApiHttpError(404, "NOT_FOUND", "Resource not found");
      case "issuer_changed":
        // A reset or a disable landed on the issuer after the check; either
        // one also ends this session.
        throw new ApiHttpError(
          401,
          "UNAUTHORIZED",
          "Session is no longer valid",
        );
      case "owner_elsewhere":
        throw new ApiHttpError(
          403,
          "FORBIDDEN",
          "The member owns another workspace; only that workspace can reset them",
        );
    }
    deps.logger?.info("Password reset link issued", {
      user_id: params.userId,
      workspace_id: params.id,
      issued_by: principal.id,
    });
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(
      context,
      issuePasswordResetResponseSchema,
      {
        user_id: params.userId,
        token,
        expires_at: issued.expiresAt.toISOString(),
      },
      201,
    );
  });

  apiRoute(router, "getAuthMe", async (context) => {
    const principal = context.get("principal");
    const session = context.get("webSession");
    if (principal.kind === "user" && session) {
      const workspace = await storageMapped(() =>
        deps.identity.findWorkspace(session.workspaceId),
      );
      if (!workspace) {
        // The membership row references a workspace that is gone; treat the
        // session as no longer valid rather than answer half an identity.
        throw new ApiHttpError(
          401,
          "UNAUTHORIZED",
          "Session is no longer valid",
        );
      }
      return jsonWithSchema(context, authMeResponseSchema, {
        principal,
        user: {
          id: session.userId,
          email: session.email,
          display_name: session.displayName,
          locale: session.locale,
        },
        workspace: workspaceView(workspace),
        scopes: principal.scopes,
        permissions: permissionsOf(principal.role),
      });
    }
    const workspaceId =
      principal.kind === "user" ? null : principal.workspace_id;
    const workspace =
      workspaceId === null
        ? null
        : await storageMapped(() => deps.identity.findWorkspace(workspaceId));
    if (workspaceId !== null && !workspace) {
      throw new ApiHttpError(401, "UNAUTHORIZED", "Key is no longer valid");
    }
    return jsonWithSchema(context, authMeResponseSchema, {
      principal,
      user: null,
      workspace: workspace ? workspaceView(workspace) : null,
      scopes: principal.scopes,
      permissions: [],
    });
  });
}
