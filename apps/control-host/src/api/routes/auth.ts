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
  LOGIN_LINK_SESSION_MAX_AGE_MINUTES,
  linkMyLoginMethodParamsSchema,
  listMyLoginMethodsResponseSchema,
  loginMethodsResponseSchema,
  loginProviderParamsSchema,
  loginRequestSchema,
  loginResponseSchema,
  memberParamsSchema,
  myLoginMethodParamsSchema,
  normalizeEmail,
  PASSWORD_RESET_TTL_MINUTES,
  passwordResetRequestSchema,
  passwordResetResponseSchema,
  providerLoginCallbackRequestSchema,
  providerLoginCallbackResponseSchema,
  scopesForRole,
  startProviderInviteRequestSchema,
  startProviderLoginResponseSchema,
  unlinkMyLoginMethodResponseSchema,
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
  type LoginMethodStore,
  MANAGEMENT_ROLES,
  passwordResetIssueDenial,
} from "@werft-ai/platform";
import type { Context } from "hono";
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

const flowCookie = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
} as const;

/** Binds the browser to the flow it just started, for as long as a flow lives. */
export function setLoginFlowCookie(context: Context, value: string): void {
  setCookie(context, LOGIN_FLOW_COOKIE_NAME, value, {
    ...flowCookie,
    maxAge: LOGIN_FLOW_TTL_MINUTES * 60,
  });
}

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
  /** Absent: no sign-up by invite through a provider, no linking. */
  loginMethods?: LoginMethodStore;
}

const LINK_SESSION_MAX_AGE_MS = LOGIN_LINK_SESSION_MAX_AGE_MINUTES * 60 * 1000;

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

  const providerMapped = <T>(providerId: string, work: () => Promise<T>) =>
    providerStep(deps.logger, providerId, work);

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
      setLoginFlowCookie(context, flow.cookieValue);
      context.header("Cache-Control", "no-store");
      return jsonWithSchema(context, startProviderLoginResponseSchema, {
        authorization_url: flow.authorizationUrl,
      });
    },
  );

  apiRoute(
    router,
    "startProviderInvite",
    ingestThenStopClock,
    async (context) => {
      const violation = browserRequestViolation(context);
      if (violation) {
        throw new ApiHttpError(403, "FORBIDDEN", `Refused: ${violation}`);
      }
      const { id } = requireParams(context, loginProviderParamsSchema);
      const body = await parseJsonBody(
        context,
        startProviderInviteRequestSchema,
      );
      const providers = deps.providers;
      const methods = deps.loginMethods;
      if (!providers || !methods) throw providerOff();
      // An unknown token is a 256-bit guess; it answers like a revoked one,
      // as when a password redeems it.
      const invite = await storageMapped(() =>
        methods.inviteForSignUp(hashWebSessionToken(body.invite_token)),
      );
      if (invite.outcome !== "pending") {
        throw invite.outcome === "used"
          ? new ApiHttpError(409, "INVITE_USED", "This invite was already used")
          : new ApiHttpError(
              410,
              "INVITE_EXPIRED",
              "This invite was revoked, replaced or has expired",
            );
      }
      const flow = await providerMapped(id, () =>
        providers.startInvite({ providerId: id, inviteId: invite.inviteId }),
      );
      setLoginFlowCookie(context, flow.cookieValue);
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
      const callback = {
        cookieValue,
        providerId: body.provider_id,
        code: body.code,
        state: body.state,
        responseIssuer: body.iss,
      };
      const purpose = providers.purposeOf(cookieValue);
      // A test and a link end only in the session they were started from.
      // Read ahead of the work slot: a storage outage here holds none.
      const sessionCookie =
        purpose === "test" || purpose === "link"
          ? webSessionCookie(context)
          : undefined;
      const session = sessionCookie
        ? await storageMapped(() =>
            deps.identity.resolveWebSession(hashWebSessionToken(sessionCookie)),
          )
        : null;
      // The requests to the provider are made for anyone who asks.
      const slot = providerWork.tryAcquire();
      if (!slot) {
        throw rateLimited(1000, "Too many sign-ins in progress");
      }
      const releaseSlot = await slot;
      // What the flow ends in, once the provider has answered and the work
      // slot is given back.
      let end: () => Promise<Response>;
      try {
        if (purpose === "test") {
          // An owner's test of a provider: the session of this request has
          // to be the one the test was started from, and still an owner's.
          const tested = await providerMapped(body.provider_id, () =>
            providers.finishTest({
              ...callback,
              owner:
                session?.role === "owner"
                  ? {
                      userId: session.userId,
                      sessionId: session.sessionId,
                      workspaceId: session.workspaceId,
                    }
                  : null,
              receiptId: randomUUID(),
            }),
          );
          deps.logger?.info("Provider test sign-in", {
            provider_id: tested.providerId,
            passed: tested.test.passed,
            ...(tested.test.passed
              ? { recorded: tested.test.recorded }
              : { reason: tested.test.reason }),
          });
          context.header("Cache-Control", "no-store");
          return jsonWithSchema(context, providerLoginCallbackResponseSchema, {
            outcome: "tested",
            provider_id: tested.providerId,
            test: tested.test,
          });
        }
        if (purpose === "invite") {
          const answer = await providerMapped(body.provider_id, () =>
            providers.finishInvite(callback),
          );
          end = () => signUpByInvite(context, answer);
        } else if (purpose === "link") {
          const answer = await providerMapped(body.provider_id, () =>
            providers.finishLink({
              ...callback,
              session: session && {
                userId: session.userId,
                sessionId: session.sessionId,
              },
            }),
          );
          // finishLink refused a request with no session.
          if (!session) throw new Error("a link ended without its session");
          end = () => link(context, answer, session);
        } else {
          const answer = await providerMapped(body.provider_id, () =>
            providers.finish(callback),
          );
          end = () => signIn(context, answer);
        }
      } finally {
        releaseSlot();
      }
      return end();
    },
  );

  type Answer = Awaited<ReturnType<ProviderLogin["finish"]>>;
  const sessionInput = (context: Context, token: string) => ({
    id: randomUUID(),
    tokenHash: hashWebSessionToken(token),
    ttlMs: WEB_SESSION_TTL_MS,
    userAgent: context.req.header("User-Agent")?.slice(0, 512) ?? null,
    maxLive: WEB_SESSIONS_PER_USER,
  });
  const refusedAfterAnswer = (providerId: string, reason: string) =>
    deps.logger?.warn("Provider sign-in refused", {
      provider_id: providerId,
      kind: reason === "provider_off_at_sign_in" ? "not_found" : "rejected",
      reason,
    });
  const linkRequired = () =>
    new ApiHttpError(
      409,
      "LOGIN_LINK_REQUIRED",
      "Sign in with your existing account, then connect this provider in settings",
    );
  const alreadyLinked = (reason: "login_method_linked" | "issuer_linked") =>
    new ApiHttpError(
      409,
      "ALREADY_EXISTS",
      reason === "issuer_linked"
        ? "Another account of this provider is connected to you already"
        : "This provider account is connected to a user already",
      false,
      undefined,
      { reason_code: reason },
    );

  /** The end of an `invite` flow: the invite admits, the provider says who. */
  const signUpByInvite = async (
    context: Context,
    answer: Answer & { inviteId: string },
  ) => {
    const { provider, identity, admission } = answer;
    const methods = deps.loginMethods;
    if (!methods) throw providerOff();
    const token = generateWebSessionToken();
    const result = await storageMapped(() =>
      methods.signUpWithInvite({
        provider: { id: provider.id, configRevision: provider.configRevision },
        inviteId: answer.inviteId,
        issuer: identity.issuer,
        subject: identity.subject,
        vouchedEmail: admission.ownsEmail ? identity.email : null,
        name: identity.name?.trim().slice(0, 64) || null,
        newUserId: randomUUID(),
        newLoginMethodId: randomUUID(),
        receiptId: randomUUID(),
        session: sessionInput(context, token),
      }),
    );
    switch (result.outcome) {
      case "provider_off":
        refusedAfterAnswer(provider.id, "provider_off_at_sign_in");
        throw providerOff();
      case "invite_gone":
        refusedAfterAnswer(provider.id, "invite_gone");
        throw new ApiHttpError(401, "UNAUTHORIZED", PROVIDER_REJECTED);
      case "already_linked":
        refusedAfterAnswer(provider.id, "invite_account_linked");
        throw alreadyLinked("login_method_linked");
      case "link_required":
        deps.logger?.info("Provider sign-in needs linking to an account", {
          provider_id: provider.id,
        });
        throw linkRequired();
    }
    deps.logger?.info("Provider sign-in", {
      provider_id: provider.id,
      user_id: result.userId,
      workspace_id: result.workspaceId,
      via: "invite_token",
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
  };

  /** The end of a `link` flow: one more way in for the session's user. */
  const link = async (
    context: Context,
    answer: Answer,
    session: { userId: string; sessionId: string; workspaceId: string },
  ) => {
    const { provider, identity, admission } = answer;
    const methods = deps.loginMethods;
    if (!methods) throw providerOff();
    const result = await storageMapped(() =>
      methods.link({
        provider: { id: provider.id, configRevision: provider.configRevision },
        issuer: identity.issuer,
        subject: identity.subject,
        vouchedEmail: admission.ownsEmail ? identity.email : null,
        userId: session.userId,
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        newLoginMethodId: randomUUID(),
        receiptId: randomUUID(),
      }),
    );
    switch (result.outcome) {
      case "provider_off":
        refusedAfterAnswer(provider.id, "provider_off_at_sign_in");
        throw providerOff();
      case "session_gone":
        refusedAfterAnswer(provider.id, "link_session_gone");
        throw new ApiHttpError(401, "UNAUTHORIZED", PROVIDER_REJECTED);
      case "already_linked":
        throw alreadyLinked("login_method_linked");
      case "issuer_linked":
        throw alreadyLinked("issuer_linked");
    }
    deps.logger?.info("Login method linked", {
      provider_id: provider.id,
      user_id: session.userId,
      login_method_id: result.loginMethodId,
    });
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(context, providerLoginCallbackResponseSchema, {
      outcome: "linked",
      provider_id: provider.id,
    });
  };

  /** The end of a `login` flow: the first-entry rules decide (design 6.1). */
  const signIn = async (context: Context, answer: Answer) => {
    const { provider, identity, admission } = answer;
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
        session: sessionInput(context, token),
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
      throw linkRequired();
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
  };
}

const PROVIDER_REJECTED = "Sign-in was not accepted";

const providerOff = () =>
  new ApiHttpError(404, "NOT_FOUND", "No such sign-in provider");

/**
 * Runs a step of a provider flow. Why it was refused goes to the log only:
 * every 401 reads the same, so a caller cannot tell which check failed.
 */
async function providerStep<T>(
  logger: StructuredLogger | undefined,
  providerId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await storageMapped(work);
  } catch (error) {
    if (!(error instanceof ProviderLoginError)) throw error;
    logger?.warn("Provider sign-in refused", {
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
}

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

  /** A person's ways to sign in are theirs to see and change, signed in. */
  const ownSession = (context: Context) => {
    const principal = context.get("principal");
    const session = context.get("webSession");
    if (principal.kind !== "user" || !session) {
      throw new ApiHttpError(
        403,
        "FORBIDDEN",
        "A user's ways to sign in change from their own session only",
      );
    }
    return session;
  };
  const sessionIsFresh = (
    methods: LoginMethodStore,
    session: { sessionId: string; userId: string },
  ) =>
    storageMapped(() =>
      methods.sessionIsFresh({
        sessionId: session.sessionId,
        userId: session.userId,
        maxAgeMs: LINK_SESSION_MAX_AGE_MS,
      }),
    );
  const sessionTooOld = () =>
    new ApiHttpError(
      403,
      "FORBIDDEN",
      `Sign in again: ways to sign in change within ${LOGIN_LINK_SESSION_MAX_AGE_MINUTES} minutes of signing in`,
      false,
      undefined,
      { reason_code: "session_too_old" },
    );
  // Whoever holds a session left open can neither add their own way in to
  // the account nor take one away: the person signs in again first.
  const requireFreshSession = async (
    methods: LoginMethodStore,
    session: { sessionId: string; userId: string },
  ) => {
    if (!(await sessionIsFresh(methods, session))) throw sessionTooOld();
  };

  apiRoute(router, "listMyLoginMethods", async (context) => {
    const session = ownSession(context);
    const methods = deps.loginMethods;
    if (!methods) throw providerOff();
    const [mine, fresh] = await Promise.all([
      storageMapped(() => methods.list(session.userId)),
      sessionIsFresh(methods, session),
    ]);
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(context, listMyLoginMethodsResponseSchema, {
      methods: mine.methods.map((method) => ({
        id: method.id,
        kind: method.kind,
        provider: method.provider && {
          id: method.provider.id,
          display_name: method.provider.displayName,
          enabled: method.provider.enabled,
        },
        issuer: method.issuer,
        email_at_link: method.emailAtLink,
        created_at: method.createdAt.toISOString(),
        last_login_at: method.lastLoginAt?.toISOString() ?? null,
        usable: method.usable,
      })),
      linkable: mine.linkable.map((provider) => ({
        id: provider.id,
        display_name: provider.displayName,
      })),
      can_change: fresh,
    });
  });

  apiRoute(router, "startMyLoginMethodLink", async (context) => {
    const session = ownSession(context);
    const { provider_id: id } = requireParams(
      context,
      linkMyLoginMethodParamsSchema,
    );
    const providers = deps.providers;
    const methods = deps.loginMethods;
    if (!providers || !methods) throw providerOff();
    await requireFreshSession(methods, session);
    const flow = await providerStep(deps.logger, id, () =>
      providers.startLink({
        providerId: id,
        userId: session.userId,
        sessionId: session.sessionId,
      }),
    );
    setLoginFlowCookie(context, flow.cookieValue);
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(context, startProviderLoginResponseSchema, {
      authorization_url: flow.authorizationUrl,
    });
  });

  apiRoute(router, "unlinkMyLoginMethod", async (context) => {
    const session = ownSession(context);
    const { id } = requireParams(context, myLoginMethodParamsSchema);
    const methods = deps.loginMethods;
    if (!methods) throw providerOff();
    await requireFreshSession(methods, session);
    const receiptId = randomUUID();
    const result = await storageMapped(() =>
      methods.unlink({
        userId: session.userId,
        sessionId: session.sessionId,
        maxAgeMs: LINK_SESSION_MAX_AGE_MS,
        loginMethodId: id,
        workspaceId: session.workspaceId,
        receiptId,
      }),
    );
    if (result.outcome === "session_gone") {
      // Ended between this request's authentication and its turn.
      throw new ApiHttpError(401, "UNAUTHORIZED", "Sign in again");
    }
    // Fresh when asked, and past the age by the time its turn came.
    if (result.outcome === "session_too_old") throw sessionTooOld();
    if (result.outcome === "not_found") {
      throw new ApiHttpError(404, "NOT_FOUND", "No such way to sign in");
    }
    if (result.outcome === "last_method") {
      throw new ApiHttpError(
        409,
        "REVISION_CONFLICT",
        "This is the only way you can sign in; connect another first",
        false,
        undefined,
        { reason_code: "last_login_method" },
      );
    }
    deps.logger?.info("Login method unlinked", {
      user_id: session.userId,
      login_method_id: id,
      sessions_revoked: result.sessionsRevoked,
    });
    return jsonWithSchema(context, unlinkMyLoginMethodResponseSchema, {
      sessions_revoked: result.sessionsRevoked,
      receipt_id: receiptId,
    });
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
