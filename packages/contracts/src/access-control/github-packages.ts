import { z } from "zod";

import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { displayNameSchema } from "./workspaces.ts";

/**
 * GitHub Packages registries the egress proxy reaches with the workspace's
 * bot token. GitHub accepts only a classic token there (an App installation
 * token is refused), so the token is a bot account's, scoped to reading
 * packages and nothing else.
 */
export const GITHUB_PACKAGES_REGISTRY_VALUES = ["npm", "rubygems"] as const;
export const githubPackagesRegistrySchema = z.enum(
  GITHUB_PACKAGES_REGISTRY_VALUES,
);

// GitHub's rule for a user or organization login.
export const githubOwnerSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);
// npm names are lowercase; a gem name keeps its case. `*` is every package of
// the owner.
export const githubPackageNameSchema = z
  .string()
  .regex(/^(?:\*|[A-Za-z0-9][A-Za-z0-9._-]{0,213})$/);

/**
 * One package, or every package of one owner, that sessions may fetch. A
 * repository or agent narrows the entry to sessions of that repository or
 * agent; null applies it to every session in the workspace.
 */
export const githubPackagesAllowEntrySchema = z
  .object({
    registry: githubPackagesRegistrySchema,
    owner: githubOwnerSchema,
    name: githubPackageNameSchema,
    repository_id: z.string().min(1).max(255).nullable(),
    agent_id: agentIdSchema.nullable(),
  })
  .strict();

export const GITHUB_PACKAGES_ALLOWLIST_MAX = 200;
export const githubPackagesAllowlistSchema = z
  .array(githubPackagesAllowEntrySchema)
  .max(GITHUB_PACKAGES_ALLOWLIST_MAX);

/** What is known of the registered token; never its value. */
export const githubPackagesTokenSummarySchema = z
  .object({
    configured: z.boolean(),
    last4: z.string().length(4).nullable(),
    /** The bot account the token belongs to, as GitHub named it at registration. */
    login: z.string().nullable(),
    /** Null when the token never expires, or none is registered. */
    expires_at: timestampSchema.nullable(),
    updated_at: timestampSchema.nullable(),
    updated_by: z
      .object({ user_id: userIdSchema, display_name: displayNameSchema })
      .strict()
      .nullable(),
  })
  .strict();

export const githubPackagesSettingsResponseSchema = z
  .object({
    token: githubPackagesTokenSummarySchema,
    allowlist: githubPackagesAllowlistSchema,
    /** 0 until the allowlist is first saved. */
    revision: z.number().int().nonnegative(),
  })
  .strict();

// Printable ASCII without spaces, as GitHub hands a token out.
export const putGitHubPackagesTokenRequestSchema = z
  .object({
    token: z
      .string()
      .min(8)
      .max(255)
      .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces"),
  })
  .strict();

/** CAS on `revision`: a stale one answers 409 REVISION_CONFLICT. */
export const putGitHubPackagesAllowlistRequestSchema = z
  .object({
    allowlist: githubPackagesAllowlistSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const githubPackagesWriteResponseSchema =
  githubPackagesSettingsResponseSchema
    .extend({ receipt_id: receiptIdSchema })
    .strict();

/**
 * Why a GitHub Packages request was refused, on its `fetch_github_package`
 * receipt and in the refusal the session sees.
 */
export const GITHUB_PACKAGES_REFUSAL_VALUES = [
  "token_not_configured",
  "token_expired",
  "path_not_recognized",
  "package_not_allowed",
] as const;
export const githubPackagesRefusalSchema = z.enum(
  GITHUB_PACKAGES_REFUSAL_VALUES,
);

export type GitHubPackagesRegistry = z.infer<
  typeof githubPackagesRegistrySchema
>;
export type GitHubPackagesAllowEntry = z.infer<
  typeof githubPackagesAllowEntrySchema
>;
export type GitHubPackagesSettingsResponse = z.infer<
  typeof githubPackagesSettingsResponseSchema
>;
export type PutGitHubPackagesTokenRequest = z.infer<
  typeof putGitHubPackagesTokenRequestSchema
>;
export type PutGitHubPackagesAllowlistRequest = z.infer<
  typeof putGitHubPackagesAllowlistRequestSchema
>;
export type GitHubPackagesWriteResponse = z.infer<
  typeof githubPackagesWriteResponseSchema
>;
export type GitHubPackagesRefusal = z.infer<typeof githubPackagesRefusalSchema>;
