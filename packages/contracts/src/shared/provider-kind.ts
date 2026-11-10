import { z } from "zod";

// A leaf with no imports of its own, like runtime-kind.ts: the release spec,
// the settings API, the profile options and the worker protocol all name the
// connection kinds, and none of them may import another to do it.
//
// `openai_responses` is an OpenAI-compatible endpoint spoken to over the
// Responses API (`/v1/responses`). Its key lives only in the connection's
// stored credential; the egress proxy injects it, so a worker never holds it.
export const PROVIDER_KIND_VALUES = [
  "anthropic",
  "litellm",
  "openai_responses",
] as const;
export const providerKindSchema = z.enum(PROVIDER_KIND_VALUES);
export type ProviderKind = z.infer<typeof providerKindSchema>;
