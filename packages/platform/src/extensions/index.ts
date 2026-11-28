// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.

// The built-in werft server belongs to this domain (extensions/builtin).
export { WERFT_MCP_METHODS } from "../werft-mcp/index.ts";
export { BundleIntegrityError } from "./bundle-service.ts";
export type { ExtensionRefusal } from "./resolve.ts";
export {
  checkAgentExtensions,
  resolveSessionExtensions,
  type SessionExtensionsDeps,
} from "./session-extensions.ts";
