// The entrance other platform domains import (A2 in package-structure.md):
// only the names other domains use, not a barrel over the directory.
export type { ExtensionRefusal } from "./resolve.ts";
export {
  checkAgentExtensions,
  resolveSessionExtensions,
  type SessionExtensionsDeps,
} from "./session-extensions.ts";
