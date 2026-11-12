import {
  type AgentCard,
  acceptInviteRequestSchema,
  agentCardSchema,
  agentDescriptionSchema,
  createAgentRequestSchema,
  createInviteRequestSchema,
} from "@werft-ai/contracts";
// biome-ignore lint/style/noRestrictedImports: the forms entry, like the schemas entry, may name zod; the root entry still may not.
import { z } from "zod";

/*
 * Step schemas for the console's forms. Each field is the contract's own
 * schema behind a trim, so a step accepts exactly what the server would and
 * whitespace alone counts as empty. A step's input is what the form holds;
 * its output is what goes into the request.
 */

const trimmed = <T extends z.ZodType<unknown, string>>(field: T) =>
  z.string().trim().pipe(field);

/** Empty for none: the description is optional. */
export const agentIdentityStep = z.object({
  slug: trimmed(createAgentRequestSchema.shape.slug),
  name: trimmed(createAgentRequestSchema.shape.name),
  description: trimmed(agentDescriptionSchema),
});

export {
  credentialRefSchema,
  githubAppWarnings,
  isMcpToolName,
  mcpToolOfServer,
} from "@werft-ai/contracts";

export const inviteStep = z.object({
  email: trimmed(createInviteRequestSchema.shape.email),
  role: createInviteRequestSchema.shape.role,
});

/**
 * Redeeming an invite. The password is taken as typed, spaces included; a
 * name left empty is left out, as an existing account needs none.
 */
export const acceptInviteStep = z.object({
  password: acceptInviteRequestSchema.shape.password,
  display_name: z
    .string()
    .trim()
    .transform((name) => name || undefined)
    .pipe(acceptInviteRequestSchema.shape.display_name),
});

/** The card as its form holds it. */
const agentCardDraftSchema = z.object({
  language: agentCardSchema.shape.language.unwrap(),
  model: z.string(),
});
export type AgentCardDraft = z.input<typeof agentCardDraftSchema>;

export function draftCapabilities(
  base?: AgentCard["capabilities"],
): AgentCard["capabilities"] {
  return { mcp: null, forbidden: [], ...base };
}

/**
 * The card step. An edit passes the card it started from: the result keeps
 * every field the form has no input for (rules, tool_policy,
 * credential_refs, the MCP server, a card's earlier role and instructions,
 * anything added later) instead of the contract's defaults.
 */
export function agentCardStep(base?: AgentCard) {
  return agentCardDraftSchema
    .transform(
      (draft): z.input<typeof agentCardSchema> => ({
        ...base,
        language: draft.language,
        model: draft.model.trim(),
        capabilities: draftCapabilities(base?.capabilities),
      }),
    )
    .pipe(agentCardSchema);
}
