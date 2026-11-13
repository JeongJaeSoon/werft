import { randomBytes, randomUUID } from "node:crypto";
import {
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  createInviteRequestSchema,
  createInviteResponseSchema,
  DISPLAY_NAME_MAX,
  inviteIdParamsSchema,
  listInvitesResponseSchema,
  normalizeEmail,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AcceptInviteInput,
  IdentityStore,
  InviteService,
  InviteStore,
} from "@werft-ai/platform";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  ingestThenStopClock,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import {
  browserRequestViolation,
  generateWebSessionToken,
  hashPassword,
  hashWebSessionToken,
  LoginLockout,
  setWebSessionCookie,
  verifyPassword,
  WEB_SESSION_TTL_MS,
  WEB_SESSIONS_PER_USER,
  WorkGate,
} from "../../auth.ts";
import { workspaceView } from "../auth.ts";
import { mapped, rateLimited, requireParams } from "../errors.ts";

// 32 random bytes, base64url, like every other one-time token here.
export function generateInviteToken(): string {
  return `apv_${randomBytes(32).toString("base64url")}`;
}

export function registerInviteRoutes(
  router: ApiRouter,
  service: Pick<InviteService, "issueInvite" | "listInvites" | "revokeInvite">,
) {
  apiRoute(router, "createInvite", async (context) => {
    const body = await parseJsonBody(context, createInviteRequestSchema);
    const token = generateInviteToken();
    const invite = await mapped(() =>
      service.issueInvite(context.get("caller"), {
        email: normalizeEmail(body.email),
        role: body.role,
        tokenHash: hashWebSessionToken(token),
      }),
    );
    context.header("Cache-Control", "no-store");
    return jsonWithSchema(
      context,
      createInviteResponseSchema,
      {
        invite_id: invite.id,
        invite_token: token,
        expires_at: invite.expiresAt.toISOString(),
      },
      201,
    );
  });

  apiRoute(router, "listInvites", async (context) => {
    const items = await mapped(() =>
      service.listInvites(context.get("caller")),
    );
    return jsonWithSchema(context, listInvitesResponseSchema, { items });
  });

  apiRoute(router, "revokeInvite", async (context) => {
    const params = requireParams(context, inviteIdParamsSchema);
    await mapped(() => service.revokeInvite(context.get("caller"), params.id));
    return context.body(null, 204);
  });
}

export interface PublicInviteRouteDeps {
  invites: Pick<InviteStore, "peekInvite" | "acceptInvite">;
  identity: Pick<IdentityStore, "findWorkspace">;
  /** The login lockout: a wrong password here is a guess at that account. */
  lockout?: LoginLockout;
  passwordWork?: WorkGate;
  logger?: StructuredLogger;
}

const ACCEPT_REFUSED = "Invite token or password is invalid";

function inviteExpired(): ApiHttpError {
  return new ApiHttpError(
    410,
    "INVITE_EXPIRED",
    "This invite was revoked, replaced or has expired",
  );
}

function inviteUsed(): ApiHttpError {
  return new ApiHttpError(409, "INVITE_USED", "This invite was already used");
}

// The local part may be longer than a display name is allowed to be.
function defaultDisplayName(email: string): string {
  return (email.split("@")[0] || email).slice(0, DISPLAY_NAME_MAX);
}

/** Mounted outside the auth middleware (03 §3.2 public allowlist). */
export function registerPublicInviteRoutes(
  router: ApiRouter,
  deps: PublicInviteRouteDeps,
) {
  const lockout = deps.lockout ?? new LoginLockout();
  const passwordWork = deps.passwordWork ?? new WorkGate();

  apiRoute(router, "acceptInvite", ingestThenStopClock, async (context) => {
    // It sets the session cookie, so it needs the login CSRF checks.
    const violation = browserRequestViolation(context);
    if (violation) {
      throw new ApiHttpError(403, "FORBIDDEN", `Refused: ${violation}`);
    }
    const body = await parseJsonBody(context, acceptInviteRequestSchema);
    const tokenHash = hashWebSessionToken(body.token);
    // An unknown token is a 256-bit guess, so it is not rate limited; it
    // answers like a revoked one.
    const peek = await deps.invites.peekInvite(tokenHash);
    if (peek.outcome !== "pending") {
      throw peek.outcome === "used" ? inviteUsed() : inviteExpired();
    }
    const { password } = body;
    const existing = peek.existingUser;
    if (existing) {
      const lockedFor = lockout.retryAfterMs(peek.email);
      if (lockedFor > 0) throw rateLimited(lockedFor, "Too many failed logins");
    }
    const slot = passwordWork.tryAcquire();
    if (!slot) throw rateLimited(1000, "Too many password checks in progress");
    const releaseSlot = await slot;
    let account: AcceptInviteInput["account"];
    try {
      if (existing) {
        const reservation = lockout.reserve(peek.email);
        if (reservation.retryAfterMs > 0) {
          throw rateLimited(reservation.retryAfterMs, "Too many failed logins");
        }
        if (!(await verifyPassword(password, existing.passwordHash))) {
          deps.logger?.warn("Invite accept refused: wrong password");
          throw new ApiHttpError(401, "UNAUTHORIZED", ACCEPT_REFUSED);
        }
        reservation.release();
        lockout.clear(peek.email);
        account = {
          kind: "existing",
          userId: existing.id,
          verifiedPasswordHash: existing.passwordHash,
        };
      } else {
        account = {
          kind: "new",
          userId: randomUUID(),
          passwordHash: await hashPassword(password),
          displayName: body.display_name ?? defaultDisplayName(peek.email),
          loginMethodId: randomUUID(),
        };
      }
    } finally {
      releaseSlot();
    }
    const sessionToken = generateWebSessionToken();
    const result = await deps.invites.acceptInvite({
      tokenHash,
      account,
      session: {
        id: randomUUID(),
        tokenHash: hashWebSessionToken(sessionToken),
        ttlMs: WEB_SESSION_TTL_MS,
        userAgent: context.req.header("User-Agent")?.slice(0, 512) ?? null,
        maxLive: WEB_SESSIONS_PER_USER,
      },
      receiptId: randomUUID(),
    });
    switch (result.outcome) {
      case "expired":
        throw inviteExpired();
      case "used":
        throw inviteUsed();
      case "account_changed":
        // A reset, a disable or a second redemption landed after the check.
        throw new ApiHttpError(401, "UNAUTHORIZED", ACCEPT_REFUSED);
      case "password_closed":
        // The invite is untouched: it is taken through a provider instead.
        throw new ApiHttpError(
          403,
          "FORBIDDEN",
          "Password sign-in is closed; accept the invite through a login provider",
          false,
          undefined,
          { reason_code: "password_login_closed" },
        );
    }
    const workspace = await deps.identity.findWorkspace(result.workspaceId);
    if (!workspace) throw new Error("accepted invite has no workspace");
    deps.logger?.info("Invite accepted", {
      user_id: result.userId,
      workspace_id: result.workspaceId,
      new_account: account.kind === "new",
    });
    setWebSessionCookie(context, sessionToken, result.sessionExpiresAt);
    return jsonWithSchema(context, acceptInviteResponseSchema, {
      user_id: result.userId,
      workspace: workspaceView(workspace),
      role: result.role,
    });
  });
}
