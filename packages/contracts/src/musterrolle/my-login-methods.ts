import { z } from "zod";

/** A signed-in person's own ways to sign in, and linking one more. */

/**
 * A person's ways to sign in change only from a session made this recently:
 * whoever holds an old, unattended session can neither add their own way in
 * to the account nor take the password away, which does not come back.
 */
export const LOGIN_LINK_SESSION_MAX_AGE_MINUTES = 10;

export const myLoginMethodSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["password", "oidc"]),
    /** Null for a password, and for an external method whose provider was deleted. */
    provider: z
      .object({
        id: z.uuid(),
        display_name: z.string(),
        enabled: z.boolean(),
      })
      .strict()
      .nullable(),
    issuer: z.string().nullable(),
    /** The address the provider vouched for when it was linked, if it did. */
    email_at_link: z.string().nullable(),
    created_at: z.iso.datetime(),
    last_login_at: z.iso.datetime().nullable(),
    /** Whether the person can sign in with it now. */
    usable: z.boolean(),
  })
  .strict();

export const listMyLoginMethodsResponseSchema = z
  .object({
    methods: z.array(myLoginMethodSchema),
    /** Providers that are on and that the person has no account of. */
    linkable: z.array(
      z.object({ id: z.uuid(), display_name: z.string() }).strict(),
    ),
    /** False: this session is too old to link or remove one; sign in again. */
    can_change: z.boolean(),
  })
  .strict();

export const myLoginMethodParamsSchema = z.object({ id: z.uuid() }).strict();
export const linkMyLoginMethodParamsSchema = z
  .object({ provider_id: z.uuid() })
  .strict();

export const unlinkMyLoginMethodResponseSchema = z
  .object({
    /** Sessions made with the method, ended with it. */
    sessions_revoked: z.number().int().nonnegative(),
    receipt_id: z.uuid(),
  })
  .strict();

export type MyLoginMethod = z.infer<typeof myLoginMethodSchema>;
export type ListMyLoginMethodsResponse = z.infer<
  typeof listMyLoginMethodsResponseSchema
>;
export type UnlinkMyLoginMethodResponse = z.infer<
  typeof unlinkMyLoginMethodResponseSchema
>;
