import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import {
  authorizationActionSchema,
  principalSchema,
  scopesExceeding,
  scopesForRole,
  sessionScopeSchema,
  workspaceRoleSchema,
} from "./authorization.ts";
import {
  displayNameSchema,
  emailSchema,
  inviteTokenSchema,
  workspaceSchema,
  workspaceSlugSchema,
} from "./workspaces.ts";

/**
 * Cookie the web surface authenticates with: HttpOnly, Secure, SameSite=Lax.
 * The `__Host-` prefix makes browsers refuse it with a Domain attribute or a
 * Path other than `/`, so a sibling subdomain cannot plant a same-named
 * cookie that shadows the real one (fixation or a lasting 401).
 */
export const WEB_SESSION_COOKIE_NAME = "__Host-werft_session";
/** Cookie-path mutations must also carry this header (CSRF). */
export const CSRF_HEADER_NAME = "x-requested-with";
export const CSRF_HEADER_VALUE = "werft-web";

export const LOGIN_LOCKOUT_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_WINDOW_MINUTES = 15;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_BYTES = 1024;
const utf8 = new TextEncoder();

/**
 * A password crosses this boundary exactly twice — login and the two places
 * that set one. It is argon2id-hashed on arrival and appears in no stored,
 * response or projection schema.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .refine(
    (value) => utf8.encode(value).length <= PASSWORD_MAX_BYTES,
    `Password exceeds ${PASSWORD_MAX_BYTES} UTF-8 bytes`,
  );

/** Generated at install, printed once, consumed once. */
export const bootstrapTokenSchema = z.string().min(32).max(256);

export const bootstrapRequestSchema = z
  .object({
    bootstrap_token: bootstrapTokenSchema,
    email: emailSchema,
    password: passwordSchema,
    display_name: displayNameSchema,
    workspace_name: z.string().min(1).max(120),
    workspace_slug: workspaceSlugSchema,
  })
  .strict();
export const bootstrapResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace: workspaceSchema,
    /** Bootstrap makes the first owner; a workspace nobody can manage or
     * recover is not a workspace this operation is allowed to leave behind. */
    role: z.literal("owner"),
  })
  .strict();

export const loginRequestSchema = z
  .object({ email: emailSchema, password: passwordSchema })
  .strict();
// A response is where a client builds its own idea of what it may do, so the
// role ceiling has to hold here too — not only on the principal the server
// keeps. Otherwise a cached login body describes a member with recovery.
export const loginResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace_id: workspaceSchema.shape.id,
    role: workspaceRoleSchema,
    scopes: z.array(sessionScopeSchema),
    expires_at: timestampSchema,
  })
  .strict()
  .superRefine((response, ctx) => {
    for (const scope of scopesExceeding(
      response.scopes,
      scopesForRole(response.role),
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: `${response.role} cannot hold ${scope}`,
      });
    }
  });

/**
 * Holds one provider sign-in flow, sealed: its state, nonce and PKCE
 * verifier, and which provider and settings it was started for. `__Host-`
 * for the reason given at WEB_SESSION_COOKIE_NAME.
 */
export const LOGIN_FLOW_COOKIE_NAME = "__Host-werft_login_flow";
export const LOGIN_FLOW_TTL_MINUTES = 10;
export const loginProviderParamsSchema = z.object({ id: z.uuid() }).strict();
export const startProviderLoginResponseSchema = z
  .object({ authorization_url: z.url() })
  .strict();
export const providerLoginCallbackRequestSchema = z
  .object({
    /** From the path the provider sent the browser back to. */
    provider_id: z.uuid(),
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(256),
    /** The authorization response's `iss`, when the provider sent one. */
    iss: z.string().min(1).max(2048).optional(),
  })
  .strict();
/** What a flow ended in; a sign-in flow ends signed in. */
export const providerLoginCallbackResponseSchema = z
  .object({ outcome: z.literal("signed_in"), ...loginResponseSchema.shape })
  .strict();

/** The kinds of `login_methods` row a person signs in with. */
export const LOGIN_METHOD_VALUES = ["password", "oidc"] as const;
export const loginMethodSchema = z.enum(LOGIN_METHOD_VALUES);
/** A provider's sign-in button: nothing here is secret. */
export const loginProviderButtonSchema = z
  .object({ id: z.uuid(), display_name: z.string().min(1).max(64) })
  .strict();
/** How a person can sign in on this installation; the login page offers these. */
export const loginMethodsResponseSchema = z
  .object({
    password: z.literal("on"),
    /** Only the providers that are turned on. */
    providers: z.array(loginProviderButtonSchema),
  })
  .strict();

/** The language a person reads the console and their Slack notices in. */
export const USER_LOCALE_VALUES = ["ko", "ja", "en"] as const;
export const userLocaleSchema = z.enum(USER_LOCALE_VALUES);
/** What a reader with no language of their own is told in. */
export const DEFAULT_USER_LOCALE = "en" satisfies UserLocale;

/** What the web app boots from: who is authenticated and under which key. */
export const authMeResponseSchema = z
  .object({
    principal: principalSchema,
    user: z
      .object({
        id: userIdSchema,
        email: emailSchema,
        display_name: displayNameSchema,
        /** Null until the person picks one; the console then sets it. */
        locale: userLocaleSchema.nullable(),
      })
      .strict()
      .nullable(),
    workspace: workspaceSchema.nullable(),
    /** The effective ceiling; it can narrow the principal's, never widen it. */
    scopes: z.array(sessionScopeSchema),
    /**
     * The management actions the principal's role holds on its workspace
     * now, so a screen can hide a menu it could never use. An agent's admin
     * holds more on that agent than this says; an API key holds none.
     */
    permissions: z.array(authorizationActionSchema),
  })
  .strict()
  .superRefine((response, ctx) => {
    for (const scope of scopesExceeding(
      response.scopes,
      response.principal.scopes,
    )) {
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: `the principal does not hold ${scope}`,
      });
    }
    // The projection is assembled from joins, so say that it must describe
    // the principal that was authenticated — otherwise a mismatched join
    // hands the web client someone else's identity or tenant and it looks
    // valid. The schema cannot know whether the join was correct; it can
    // insist the three parts agree with each other.
    const { principal, user, workspace } = response;
    if (principal.kind === "user") {
      if (user === null || user.id !== principal.id) {
        ctx.addIssue({
          code: "custom",
          path: ["user"],
          message: "must be the authenticated user",
        });
      }
      if (workspace === null || workspace.id !== principal.workspace_id) {
        ctx.addIssue({
          code: "custom",
          path: ["workspace"],
          message: "must be the principal's workspace",
        });
      }
      return;
    }
    // An API key has no human behind it, and a legacy key has no workspace
    // until an explicit mapping exists.
    if (user !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["user"],
        message: "an api key principal has no user",
      });
    }
    if (response.permissions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "an api key principal holds no management action",
      });
    }
    const expected = principal.workspace_id;
    if (expected === null ? workspace !== null : workspace?.id !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["workspace"],
        message: "must be the workspace the key is mapped to",
      });
    }
  });

/** A cookie session's own settings. */
export const updateAuthMeRequestSchema = z
  .object({ locale: userLocaleSchema })
  .strict();

/**
 * Redeeming an invite. It never touches an existing account's password: a
 * known email proves it and joins the workspace, an unknown one gets an
 * account with it (A02).
 */
export const acceptInviteRequestSchema = z
  .object({
    /** In the body, never the URL, for the same reason as a reset token. */
    token: inviteTokenSchema,
    password: passwordSchema,
    display_name: displayNameSchema.optional(),
  })
  .strict();
export const acceptInviteResponseSchema = z
  .object({
    user_id: userIdSchema,
    workspace: workspaceSchema,
    role: workspaceRoleSchema,
  })
  .strict();

/**
 * Account recovery without email: an owner issues a one-time link
 * and hands it over; redeeming it sets the password and ends the user's
 * sessions. The token travels in the body, never the URL, so no access log
 * or proxy on the way records it.
 */
export const PASSWORD_RESET_TTL_MINUTES = 60;
export const passwordResetTokenSchema = z.string().min(1).max(256);
export const memberParamsSchema = z
  .object({ id: workspaceIdSchema, userId: userIdSchema })
  .strict();
/**
 * The issuer re-enters their own password: a stolen session cookie alone
 * must not turn into a link that takes over another account.
 */
export const issuePasswordResetRequestSchema = z
  .object({ current_password: passwordSchema })
  .strict();
export const issuePasswordResetResponseSchema = z
  .object({
    user_id: userIdSchema,
    /** Shown once; only its sha256 is stored. */
    token: passwordResetTokenSchema,
    expires_at: timestampSchema,
  })
  .strict();
export const passwordResetRequestSchema = z
  .object({ token: passwordResetTokenSchema, password: passwordSchema })
  .strict();
export const passwordResetResponseSchema = z
  .object({ user_id: userIdSchema, receipt_id: receiptIdSchema })
  .strict();

export type AuthMeResponse = z.infer<typeof authMeResponseSchema>;
export type UserLocale = z.infer<typeof userLocaleSchema>;
export type LoginMethod = z.infer<typeof loginMethodSchema>;
export type LoginMethodsResponse = z.infer<typeof loginMethodsResponseSchema>;
