import { z } from "zod";
import {
  SECRET_VALUE_MAX_LENGTH,
  SECRET_VALUE_MIN_LENGTH,
} from "./slack-secrets.ts";

/** The owner's view of the sign-in providers and the requests that change them. */

export const LOGIN_PROVIDER_TOKEN_AUTH_METHOD_VALUES = [
  "client_secret_basic",
  "client_secret_post",
] as const;
export const loginProviderTokenAuthMethodSchema = z.enum(
  LOGIN_PROVIDER_TOKEN_AUTH_METHOD_VALUES,
);

/**
 * `draft`: no client id or no client secret yet. `needs_test`: both are set
 * and the settings as they are now have not passed a test sign-in. `ready`:
 * passed, and off. `enabled_secret_pending`: on, with a new client secret
 * waiting for a test sign-in to pass with it.
 */
export const LOGIN_PROVIDER_STATE_VALUES = [
  "draft",
  "needs_test",
  "ready",
  "enabled",
  "enabled_secret_pending",
] as const;
export const loginProviderStateSchema = z.enum(LOGIN_PROVIDER_STATE_VALUES);

const issuerSchema = z.string().trim().min(1).max(2048);
const displayNameSchema = z.string().trim().min(1).max(64);
/** A bare host name, as it stands after the `@` of an address. */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

/** A stored client secret, never its value. */
export const loginProviderSecretViewSchema = z
  .object({ last4: z.string().length(4), updated_at: z.iso.datetime() })
  .strict();

export const loginProviderSchema = z
  .object({
    id: z.uuid(),
    display_name: z.string(),
    issuer: z.string(),
    /** What to register at the provider; null while CONSOLE_ORIGIN is unset. */
    redirect_uri: z.string().nullable(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    jwks_uri: z.string(),
    userinfo_endpoint: z.string().nullable(),
    /** The hosts this server sends requests to for this provider. */
    endpoint_hosts: z.array(z.string()),
    signing_algs: z.array(z.string()),
    /** False when discovery did not say which PKCE methods it takes. */
    pkce_advertised: z.boolean(),
    discovery_checked_at: z.iso.datetime(),
    client_id: z.string().nullable(),
    token_auth_method: loginProviderTokenAuthMethodSchema,
    client_secret: loginProviderSecretViewSchema.nullable(),
    /** A replacement waiting for a test sign-in; only on a provider that is on. */
    pending_client_secret: loginProviderSecretViewSchema.nullable(),
    allowed_domains: z.array(z.string()),
    jit_role: z.literal("member").nullable(),
    require_verified_email: z.boolean(),
    state: loginProviderStateSchema,
    tested_at: z.iso.datetime().nullable(),
    /** Send it back as `If-Match` with a change. */
    revision: z.number().int().positive(),
    created_at: z.iso.datetime(),
    updated_at: z.iso.datetime(),
  })
  .strict();

export const listLoginProvidersResponseSchema = z
  .object({
    providers: z.array(loginProviderSchema),
    /** False: no provider can be made until CONSOLE_ORIGIN is set. */
    console_origin_configured: z.boolean(),
  })
  .strict();

export const loginProviderResponseSchema = z
  .object({ provider: loginProviderSchema })
  .strict();

export const discoverLoginProviderRequestSchema = z
  .object({ issuer: issuerSchema })
  .strict();

/** Why a discovery document could not be used, or was not there to read. */
export const LOGIN_PROVIDER_DISCOVERY_PROBLEM_VALUES = [
  "issuer_mismatch",
  "invalid_document",
  "insecure_endpoint",
  "unsupported_flow",
  "unsupported_algorithm",
  "unsupported_client_auth",
  "pkce_s256_unsupported",
  "unreachable",
  "address_not_allowed",
] as const;
export const loginProviderDiscoveryProblemSchema = z.enum(
  LOGIN_PROVIDER_DISCOVERY_PROBLEM_VALUES,
);

export const discoverLoginProviderResponseSchema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        outcome: z.literal("ok"),
        endpoint_hosts: z.array(z.string()),
        signing_algs: z.array(z.string()),
        token_auth_methods: z.array(loginProviderTokenAuthMethodSchema),
        pkce_advertised: z.boolean(),
      })
      .strict(),
    z
      .object({
        outcome: z.literal("failed"),
        problem: loginProviderDiscoveryProblemSchema,
      })
      .strict(),
  ],
);

export const createLoginProviderRequestSchema = z
  .object({ display_name: displayNameSchema, issuer: issuerSchema })
  .strict();

export const updateLoginProviderRequestSchema = z
  .object({
    display_name: displayNameSchema.optional(),
    client_id: z.string().trim().min(1).max(512).optional(),
    token_auth_method: loginProviderTokenAuthMethodSchema.optional(),
    allowed_domains: z.array(domainSchema).max(50).optional(),
    jit_role: z.literal("member").nullable().optional(),
    require_verified_email: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: "Name at least one field to change",
  });

export const setLoginProviderSecretRequestSchema = z
  .object({
    value: z.string().min(SECRET_VALUE_MIN_LENGTH).max(SECRET_VALUE_MAX_LENGTH),
  })
  .strict();

export const disableLoginProviderResponseSchema = z
  .object({
    provider: loginProviderSchema,
    /** The sessions made through this provider that were ended. */
    sessions_revoked: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What would happen to the account that just signed in at the provider, by
 * the rules a real sign-in runs. `signs_in`: it is already connected.
 * `link_required`: its address has an account here that is not connected.
 * `joins`: a new member is made. `invite_only`: it comes in with an invite
 * alone. `domain_not_allowed`: outside the allowed domains. `refused`: its
 * address has an account here and the provider does not prove the address
 * is this account's.
 */
export const LOGIN_PROVIDER_TEST_ENTRY_VALUES = [
  "signs_in",
  "link_required",
  "joins",
  "invite_only",
  "domain_not_allowed",
  "refused",
] as const;
export const loginProviderTestEntrySchema = z.enum(
  LOGIN_PROVIDER_TEST_ENTRY_VALUES,
);

export const loginProviderTestResultSchema = z.discriminatedUnion("passed", [
  z
    .object({
      passed: z.literal(true),
      /**
       * False when the settings changed while the test ran: the provider
       * answered, and the pass was not written down. Test again.
       */
      recorded: z.boolean(),
      subject: z.string(),
      email: z.string().nullable(),
      /** Null when the provider says nothing about it. */
      email_verified: z.boolean().nullable(),
      /** Whether the provider proves the address belongs to this account. */
      address_owned: z.boolean(),
      entry: loginProviderTestEntrySchema,
    })
    .strict(),
  z
    .object({
      passed: z.literal(false),
      /** A reason code, for the owner who is setting the provider up. */
      reason: z.string(),
    })
    .strict(),
]);

export type LoginProviderView = z.infer<typeof loginProviderSchema>;
export type LoginProviderState = z.infer<typeof loginProviderStateSchema>;
export type ListLoginProvidersResponse = z.infer<
  typeof listLoginProvidersResponseSchema
>;
export type DiscoverLoginProviderResponse = z.infer<
  typeof discoverLoginProviderResponseSchema
>;
export type CreateLoginProviderRequest = z.infer<
  typeof createLoginProviderRequestSchema
>;
export type UpdateLoginProviderRequest = z.infer<
  typeof updateLoginProviderRequestSchema
>;
export type LoginProviderTestResult = z.infer<
  typeof loginProviderTestResultSchema
>;
export type LoginProviderTestEntry = z.infer<
  typeof loginProviderTestEntrySchema
>;
