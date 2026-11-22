// Copies of the contract's rules: apps/web takes contracts as types only, and
// api/client.test.ts keeps each one equal to the contract.
export const PASSWORD_MIN_LENGTH = 12;
export const DISPLAY_NAME_MAX = 64;
export const INVITE_TOKEN_LENGTH = { min: 32, max: 256 } as const;
export const API_KEY_NAME_MAX = 64;
export const AGENT_DESCRIPTION_MAX_LENGTH = 2_000;
export const EMAIL_MAX = 254;
export const SETUP_LINK_TTL_HOURS = 24;
export const WORKSPACE_NAME_MAX = 120;
export const LOGIN_DOMAINS_MAX = 50;
export const LOGIN_DOMAIN_PATTERN =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** A secret pasted from a provider: printable ASCII without spaces. */
export const SECRET_VALUE_LENGTH = { min: 8, max: 4096 } as const;
export const SECRET_VALUE_PATTERN = /^[\x21-\x7e]+$/;
export const GITHUB_APP_ID_MAX = 2_147_483_647;
export const REPOSITORY_BRANCH_MAX = 255;
export const REPOSITORY_BRANCH_PATTERN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
  /^(?![-/.])(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*\/\.)(?!.*\/$)(?!.*\.lock$)[^\s\x00-\x1f\x7f~^:?*[\\]+$/;
export const MESSAGE_MAX_BYTES = 32 * 1024;
export const WORKSPACE_MCP_RESERVED_NAMES: readonly string[] = [
  "github",
  "browser",
];
export const SLACK_INSTALL_CALLBACK = {
  state: /^[A-Za-z0-9_-]{1,512}$/,
  code: /^[A-Za-z0-9._-]{1,2048}$/,
  error: /^[a-z_]{1,64}$/,
} as const;
