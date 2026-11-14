import { z } from "zod";

// A leaf with no imports of its own, like runtime-kind.ts: the release spec,
// the settings API, the connection options and the worker protocol all name the
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

// `openai_decisions` is the achievement judge's Luna (OpenAI Decisions API).
// An operator adds it like any connection, but no agent runs on it, so a
// release and the worker protocol never name it.
export const CONNECTION_KIND_VALUES = [
  ...PROVIDER_KIND_VALUES,
  "openai_decisions",
] as const;
export const connectionKindSchema = z.enum(CONNECTION_KIND_VALUES);
