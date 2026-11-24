import { positiveNumberSetting } from "@werft-ai/contracts/settings";

/**
 * Everything the conversation runtime reads from its environment. No
 * provider key and no repository credential is among them: the runtime holds
 * its gateway bearer, and each turn brings the one-call token its provider
 * call is made with.
 */
export type ConversationRuntimeEnvironment = {
  CONVERSATION_RUNTIME_TOKEN?: string | undefined;
  CONVERSATION_STATUS_FILE?: string | undefined;
  CONVERSATION_TOPICS_DIR?: string | undefined;
  LOG_LEVEL?: string | undefined;
  WORKER_EGRESS_CREDENTIAL_URL?: string | undefined;
  WORKER_GATEWAY_URL?: string | undefined;
  WORKER_REQUEST_TIMEOUT_SEC?: string | undefined;
};

export type ConversationRuntimeConfig = {
  /** Opens the control host's two conversation runtime routes, and nothing else. */
  gatewayToken: string;
  gatewayUrl: string;
  egressCredentialUrl: string;
  /** The tmpfs each topic's directory is made under. */
  topicsDir: string;
  /** Where the loop writes when it last reached the control host. */
  statusFile: string;
  requestTimeoutMs: number;
};

export const DEFAULT_CONVERSATION_STATUS_FILE =
  "/tmp/conversation-runtime-status.json";

export function conversationRuntimeConfigFromEnv(
  environment: ConversationRuntimeEnvironment,
): ConversationRuntimeConfig {
  return {
    gatewayToken: required(environment, "CONVERSATION_RUNTIME_TOKEN"),
    gatewayUrl: url(environment, "WORKER_GATEWAY_URL"),
    egressCredentialUrl: url(environment, "WORKER_EGRESS_CREDENTIAL_URL"),
    topicsDir: required(environment, "CONVERSATION_TOPICS_DIR"),
    statusFile:
      environment.CONVERSATION_STATUS_FILE || DEFAULT_CONVERSATION_STATUS_FILE,
    requestTimeoutMs:
      positiveNumberSetting(environment, "WORKER_REQUEST_TIMEOUT_SEC", {
        default: 30,
      }) * 1000,
  };
}

function required(
  environment: ConversationRuntimeEnvironment,
  name: keyof ConversationRuntimeEnvironment,
): string {
  const value = environment[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function url(
  environment: ConversationRuntimeEnvironment,
  name: keyof ConversationRuntimeEnvironment,
): string {
  const value = required(environment, name);
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
  ) {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return value;
}
