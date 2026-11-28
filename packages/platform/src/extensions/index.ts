// The entrance other platform domains import (A2 in tests/architecture.test.ts):
// only the names other domains use, not a barrel over the directory.

// The built-in werft server belongs to this domain (extensions/builtin).
export { WERFT_MCP_METHODS } from "./builtin/index.ts";
export { BundleIntegrityError } from "./bundles/bundle-service.ts";
export type { ExtensionRefusal } from "./bundles/resolve.ts";
export {
  checkAgentExtensions,
  resolveSessionExtensions,
  type SessionExtensionsDeps,
} from "./bundles/session-extensions.ts";
