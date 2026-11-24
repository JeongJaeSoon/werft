import { describe, expect, test } from "bun:test";
import {
  conversationRuntimeConfigFromEnv,
  DEFAULT_CONVERSATION_STATUS_FILE,
} from "./config.ts";

const BEARER = ["runtime", "bearer", "0123456789abcdef0123456789"].join("-");
const env = {
  CONVERSATION_RUNTIME_TOKEN: BEARER,
  CONVERSATION_TOPICS_DIR: "/topics",
  WORKER_EGRESS_CREDENTIAL_URL: "http://egress-proxy:3129",
  WORKER_GATEWAY_URL: "http://api:3000",
};

describe("conversationRuntimeConfigFromEnv", () => {
  test("reads the gateway, the proxy's credential listener, the bearer and the topics root", () => {
    expect(conversationRuntimeConfigFromEnv(env)).toEqual({
      gatewayToken: BEARER,
      gatewayUrl: "http://api:3000",
      egressCredentialUrl: "http://egress-proxy:3129",
      topicsDir: "/topics",
      statusFile: DEFAULT_CONVERSATION_STATUS_FILE,
      requestTimeoutMs: 30_000,
    });
    expect(
      conversationRuntimeConfigFromEnv({
        ...env,
        CONVERSATION_STATUS_FILE: "/run/status.json",
        WORKER_REQUEST_TIMEOUT_SEC: "5",
      }),
    ).toMatchObject({
      statusFile: "/run/status.json",
      requestTimeoutMs: 5_000,
    });
  });

  test("names the variable that is missing or malformed, never a value", () => {
    for (const name of Object.keys(env) as Array<keyof typeof env>) {
      expect(() =>
        conversationRuntimeConfigFromEnv({ ...env, [name]: "" }),
      ).toThrow(name);
    }
    for (const name of [
      "WORKER_GATEWAY_URL",
      "WORKER_EGRESS_CREDENTIAL_URL",
    ] as const) {
      let message = "";
      try {
        conversationRuntimeConfigFromEnv({
          ...env,
          [name]: "ftp://somewhere-odd",
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain("somewhere-odd");
    }
  });

  test("takes no provider credential: none of what it reads is one", () => {
    // The whole environment contract of the conversation runtime, by name.
    const read = Object.keys({
      CONVERSATION_RUNTIME_TOKEN: 0,
      CONVERSATION_STATUS_FILE: 0,
      CONVERSATION_TOPICS_DIR: 0,
      LOG_LEVEL: 0,
      WORKER_EGRESS_CREDENTIAL_URL: 0,
      WORKER_GATEWAY_URL: 0,
      WORKER_REQUEST_TIMEOUT_SEC: 0,
    } satisfies Record<
      keyof Parameters<typeof conversationRuntimeConfigFromEnv>[0],
      0
    >);
    expect(
      read.filter((name) => /ANTHROPIC|API_KEY|OPENAI|AWS_|GITHUB/.test(name)),
    ).toEqual([]);
  });
});
