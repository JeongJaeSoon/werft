import { randomBytes, randomUUID } from "node:crypto";
import {
  acceptInviteRequestSchema,
  acceptInviteResponseSchema,
  clampDisplayName,
  createInviteRequestSchema,
  createInviteResponseSchema,
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
  LoginSettingsStore,
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
  type LoginReservation,
  setWebSessionCookie,
  verifyPassword,
  webSessionInput,
} from "../../auth.ts";
import type { PasswordChecks } from "../../password-checks.ts";
import { mapped, requireParams } from "../errors.ts";
import { passwordClosedTo, workspaceView } from "./auth.ts";

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
  /** Absent: passwords are taken to be open; the store still decides. */
  loginSettings?: Pick<LoginSettingsStore, "read">;
  /** The login's instance: a wrong password here is a guess at that account. */
  passwords: PasswordChecks;
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

/** The invite is untouched: it is taken through a provider instead. */
function passwordClosed(): ApiHttpError {
  return new ApiHttpError(
    403,
    "FORBIDDEN",
    "Password sign-in is closed; accept the invite through a login provider",
    false,
    undefined,
    { reason_code: "password_login_closed" },
  );
}

// The local part may be longer than a display name is allowed to be.
function defaultDisplayName(email: string): string {
  return clampDisplayName(email.split("@")[0] || email);
}

/** Mounted outside the auth middleware (public allowlist). */
export function registerPublicInviteRoutes(
  router: ApiRouter,
  deps: PublicInviteRouteDeps,
) {
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
    // Before the password is looked at, and for everyone, the emergency
    // admin included (hence nobody's id): closed is closed whoever the
    // invite is for and whatever was typed, so the answer, the lockout and
    // the time taken say neither who the emergency admin is nor whether the
    // password was right. The store decides again under its lock.
    if (await passwordClosedTo(deps.loginSettings, null)) {
      throw passwordClosed();
    }
    let account: AcceptInviteInput["account"];
    // The existing account's guess, counted until the invite is accepted.
    let reservation: LoginReservation | undefined;
    if (existing) {
      const guessed = await deps.passwords.guess(peek.email, () =>
        verifyPassword(password, existing.passwordHash),
      );
      reservation = guessed.reservation;
      if (!guessed.value) {
        deps.logger?.warn("Invite accept refused: wrong password");
        throw new ApiHttpError(401, "UNAUTHORIZED", ACCEPT_REFUSED);
      }
      account = {
        kind: "existing",
        userId: existing.id,
        verifiedPasswordHash: existing.passwordHash,
      };
    } else {
      account = {
        kind: "new",
        userId: randomUUID(),
        passwordHash: await deps.passwords.hashing(() =>
          hashPassword(password),
        ),
        displayName: body.display_name ?? defaultDisplayName(peek.email),
        loginMethodId: randomUUID(),
      };
    }
    const sessionToken = generateWebSessionToken();
    const result = await deps.invites
      .acceptInvite({
        tokenHash,
        account,
        session: webSessionInput(context, sessionToken),
        receiptId: randomUUID(),
      })
      .catch((error: unknown) => {
        // An outage is not a guess.
        reservation?.release();
        throw error;
      });
    if (result.outcome === "accepted") {
      if (existing) deps.passwords.succeeded(peek.email);
    } else if (
      result.outcome !== "account_changed" &&
      result.outcome !== "password_closed"
    ) {
      // Refused for a reason no password decides. The two above stay
      // counted, as a sign-in the store refuses does: a right password
      // clears the failures before it only by getting in.
      reservation?.release();
    }
    switch (result.outcome) {
      case "expired":
        throw inviteExpired();
      case "used":
        throw inviteUsed();
      case "account_changed":
        // A reset, a disable or a second redemption landed after the check.
        throw new ApiHttpError(401, "UNAUTHORIZED", ACCEPT_REFUSED);
      case "password_closed":
        // Closed after the check above. The invite is untouched.
        throw passwordClosed();
      case "emergency_admin":
        // Nothing is spent: with another emergency admin named, it goes
        // through.
        throw new ApiHttpError(
          409,
          "REVISION_CONFLICT",
          "The emergency admin cannot rejoin this workspace; name another emergency admin first",
          false,
          undefined,
          { reason_code: "emergency_admin" },
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
