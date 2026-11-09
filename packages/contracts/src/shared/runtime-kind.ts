import { z } from "zod";

// A leaf with no imports of its own, so both the session contract and the
// release spec can name the kinds without importing each other.
export const RUNTIME_KIND_VALUES = [
  "claude_agent_sdk",
  "codex_app_server",
  "pi_coding_agent",
] as const;
export const runtimeKindSchema = z.enum(RUNTIME_KIND_VALUES);
