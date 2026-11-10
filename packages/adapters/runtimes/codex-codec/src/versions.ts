/**
 * The Codex build this image ships, exact. `@openai/codex` is pinned to this
 * in packages/adapters/runtimes/codex/package.json, and a test holds the two
 * together. The app-server protocol is versioned with the CLI, so it is also
 * the fingerprint's "SDK" version.
 */
export const CODEX_CLI_VERSION = "0.167.0";
