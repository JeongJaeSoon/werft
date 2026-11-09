import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { receiptOperationSchema } from "../api/receipt.ts";
import { sessionAttentionSchema } from "../api/session.ts";
import { apiErrorCodeSchema, canonicalJson } from "../shared/index.ts";
import {
  runtimeConfigSchema,
  workerCapabilitiesSchema,
} from "../worker-protocol/index.ts";
import { type AgentCard, agentCardSchema } from "./agents.ts";
import {
  agentEnvVariablesSchema,
  ENV_RESERVED_NAMES,
  ENV_RESERVED_PREFIXES,
  ENV_VARIABLE_VALUE_MAX_BYTES,
  type EnvNameProblem,
  envNameProblem,
  envStartSchema,
  envValueProblem,
  envVariableListSchema,
  putEnvVariableGrantsRequestSchema,
  putEnvVariableRequestSchema,
  runtimeEnvSchema,
} from "./env-variables.ts";

const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const AGENT_2 = "019a0000-0000-7000-8000-0000000000a2";
const AT = "2026-11-08T01:00:00Z";

const card = {
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
} satisfies Record<string, unknown>;

function cardHash(value: AgentCard): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

describe("variable names", () => {
  test.each<[string, EnvNameProblem | null]>([
    ["A", null],
    ["API_BASE_URL", null],
    ["X1_2", null],
    ["A".repeat(64), null],
    // Close to a reserved name without being one.
    ["PATHS", null],
    ["MY_GIT_TOKEN", null],
    ["GITHUB", null],
    ["a", "invalid"],
    ["api_base_url", "invalid"],
    ["http_proxy", "invalid"],
    ["1A", "invalid"],
    ["_A", "invalid"],
    ["A-B", "invalid"],
    ["A B", "invalid"],
    ["", "invalid"],
    ["A".repeat(65), "invalid"],
    ["É", "invalid"],
  ])("%p is %p", (name, problem) => {
    expect(envNameProblem(name)).toBe(problem);
  });

  test("every reserved name and prefix is refused, and nothing else under the prefix is spared", () => {
    for (const name of ENV_RESERVED_NAMES) {
      expect(envNameProblem(name)).toBe("reserved");
    }
    for (const prefix of ENV_RESERVED_PREFIXES) {
      expect(envNameProblem(`${prefix}X`)).toBe("reserved");
      expect(envNameProblem(prefix)).toBe("reserved");
    }
  });

  test("the names the Claude adapter sets itself are reserved", () => {
    // profile.ts: runtimeEnvironment.
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_CODE_MAX_RETRIES",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
      "GIT_CONFIG_COUNT",
      "NODE_EXTRA_CA_CERTS",
      "HOME",
      "LANG",
      "PATH",
      "TMPDIR",
      "HTTPS_PROXY",
    ]) {
      expect(envNameProblem(name)).toBe("reserved");
    }
  });
});

describe("variable values", () => {
  test("a plain value may be empty and may hold line breaks", () => {
    expect(envValueProblem("", "plain")).toBeNull();
    expect(
      envValueProblem("-----BEGIN KEY-----\nabc\n-----END KEY-----\n", "plain"),
    ).toBeNull();
  });

  test("a leading byte order mark is text and is kept", () => {
    expect(envValueProblem("﻿abc", "plain")).toBeNull();
  });

  test("NUL and a lone surrogate are refused", () => {
    expect(envValueProblem("a\0b", "plain")).toBe("invalid_text");
    expect(envValueProblem("a\ud800b", "plain")).toBe("invalid_text");
  });

  test("the limit counts UTF-8 bytes, not characters", () => {
    const limit = ENV_VARIABLE_VALUE_MAX_BYTES;
    expect(envValueProblem("a".repeat(limit), "plain")).toBeNull();
    expect(envValueProblem("a".repeat(limit + 1), "plain")).toBe("too_large");
    // Three bytes each: fewer characters than the limit, more bytes.
    expect(envValueProblem("가".repeat(limit / 3), "plain")).toBeNull();
    expect(envValueProblem("가".repeat(limit / 3 + 1), "plain")).toBe(
      "too_large",
    );
  });

  test("a secret under eight bytes is refused, eight is not", () => {
    expect(envValueProblem("1234567", "secret")).toBe("too_short_secret");
    expect(envValueProblem("12345678", "secret")).toBeNull();
    // Two characters, six bytes.
    expect(envValueProblem("가나", "secret")).toBe("too_short_secret");
    expect(envValueProblem("1234567", "plain")).toBeNull();
  });
});

describe("a card's env declaration", () => {
  const withEnv = (env: unknown) =>
    agentCardSchema.safeParse({
      ...card,
      capabilities: { ...card.capabilities, env },
    });

  test("a card without it keeps the hash it had before it existed", () => {
    const parsed = agentCardSchema.parse(card);
    expect("env" in parsed.capabilities).toBe(false);
    // This card's hash on origin/main 7868c9e78, before `env` existed.
    expect(cardHash(parsed)).toBe(
      "ba95aea2832381eb7f18abe16cf770fde71619377cd28bbbc0051f2c38da190a",
    );
  });

  test("naming variables is a new version", () => {
    const named = agentCardSchema.parse({
      ...card,
      capabilities: { ...card.capabilities, env: [{ name: "API_URL" }] },
    });
    expect(named.capabilities.env).toEqual([{ name: "API_URL" }]);
    expect(cardHash(named)).not.toBe(cardHash(agentCardSchema.parse(card)));
  });

  test("a reserved name parses: the save and the activation judge it, with their own error code", () => {
    expect(withEnv([{ name: "PATH" }]).success).toBe(true);
    expect(withEnv([{ name: "GITHUB_TOKEN" }]).success).toBe(true);
  });

  test("an empty list is allowed; more than 32, a repeat or a malformed name is not", () => {
    expect(withEnv([]).success).toBe(true);
    expect(
      withEnv(Array.from({ length: 32 }, (_, i) => ({ name: `V${i}` })))
        .success,
    ).toBe(true);
    for (const env of [
      Array.from({ length: 33 }, (_, i) => ({ name: `V${i}` })),
      [{ name: "A_B" }, { name: "A_B" }],
      [{ name: "lower" }],
      [{ name: "A_B", value: "x" }],
    ]) {
      expect(withEnv(env).success).toBe(false);
    }
  });
});

describe("runtime_config.env", () => {
  const config = {
    model: "claude-sonnet-5",
    tools: [],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "http://litellm:4000",
      auth: { kind: "egress_token", token: "t" },
    },
  };

  test("a config without it parses to the same object, with no env key", () => {
    const parsed = runtimeConfigSchema.parse(config);
    expect("env" in parsed).toBe(false);
    // Pinned, so a default or a reordered key added next to `env` shows up.
    expect(JSON.stringify(parsed)).toBe(
      '{"model":"claude-sonnet-5","tools":[],"permission_mode":"default","provider":{"kind":"litellm","endpoint":"http://litellm:4000","auth":{"kind":"egress_token","token":"t"}}}',
    );
  });

  test("it carries names and values, and an empty record is refused", () => {
    expect(
      runtimeConfigSchema.parse({ ...config, env: { A: "1", B: "" } }).env,
    ).toEqual({ A: "1", B: "" });
    expect(runtimeConfigSchema.safeParse({ ...config, env: {} }).success).toBe(
      false,
    );
  });

  test("a reserved or lowercase name, or a bad value, is refused", () => {
    for (const env of [
      { PATH: "/x" },
      { lower: "1" },
      { A: "a\0b" },
      { A: "a".repeat(ENV_VARIABLE_VALUE_MAX_BYTES + 1) },
    ]) {
      expect(runtimeConfigSchema.safeParse({ ...config, env }).success).toBe(
        false,
      );
    }
    expect(runtimeEnvSchema.safeParse({ A: 1 }).success).toBe(false);
  });

  test("a worker announces user_env as a literal true", () => {
    expect(workerCapabilitiesSchema.parse({ user_env: true })).toEqual({
      user_env: true,
    });
    expect(
      workerCapabilitiesSchema.safeParse({ user_env: false }).success,
    ).toBe(false);
  });
});

describe("variable API schemas", () => {
  const variable = {
    name: "API_URL",
    kind: "plain",
    value: "https://example.test",
    version: 7,
    grant_all: false,
    grant_version: 8,
    granted_agents: [AGENT],
    engine_delivery: false,
    updated_by: "019a0000-0000-7000-8000-0000000000b1",
    updated_at: AT,
  };

  test("a list item round-trips, and a secret shows last4 instead of a value", () => {
    const secret = {
      ...variable,
      name: "TOKEN_X",
      kind: "secret",
      value: undefined,
      last4: "abcd",
      engine_delivery: true,
    };
    const parsed = envVariableListSchema.parse({ items: [variable, secret] });
    expect(parsed.items[1]).toMatchObject({ kind: "secret", last4: "abcd" });
    expect(
      envVariableListSchema.safeParse({
        items: [{ ...variable, extra: true }],
      }).success,
    ).toBe(false);
  });

  test("a PUT body names a kind and a value, and nothing more", () => {
    expect(
      putEnvVariableRequestSchema.parse({
        kind: "secret",
        value: "12345678",
        engine_delivery: true,
        acknowledge_engine_exposure: true,
      }),
    ).toMatchObject({ kind: "secret" });
    for (const body of [
      { value: "x" },
      { kind: "other", value: "x" },
      { kind: "plain" },
      { kind: "plain", value: "x", name: "A" },
    ]) {
      expect(putEnvVariableRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  test("a PUT body is judged by its kind: bytes, NUL, and a secret's length", () => {
    const put = (kind: string, value: string) =>
      putEnvVariableRequestSchema.safeParse({ kind, value }).success;
    expect(put("plain", "ok")).toBe(true);
    expect(put("plain", "a\0b")).toBe(false);
    expect(put("plain", "a\ud800b")).toBe(false);
    expect(put("plain", "a".repeat(ENV_VARIABLE_VALUE_MAX_BYTES + 1))).toBe(
      false,
    );
    expect(put("secret", "1")).toBe(false);
    expect(put("secret", "12345678")).toBe(true);
  });

  test("no shape that is read back may hold a secret's value", () => {
    const secret = { ...variable, kind: "secret", value: "example-value" };
    expect(envVariableListSchema.safeParse({ items: [secret] }).success).toBe(
      false,
    );
    expect(
      agentEnvVariablesSchema.safeParse({
        effective: [],
        items: [],
        granted_workspace_values: [
          { name: "TOKEN_X", kind: "secret", value: "example-value" },
        ],
      }).success,
    ).toBe(false);
    expect(
      envStartSchema.safeParse({
        entries: [
          {
            name: "TOKEN_X",
            scope: "agent",
            kind: "secret",
            version: 1,
            value: "example-value",
          },
        ],
        skipped: [],
      }).success,
    ).toBe(false);
  });

  test("grants replace the whole set, once per agent", () => {
    expect(
      putEnvVariableGrantsRequestSchema.parse({
        grant_all: false,
        agents: [{ id: AGENT, allow_automation: true }, { id: AGENT_2 }],
      }).agents,
    ).toHaveLength(2);
    expect(
      putEnvVariableGrantsRequestSchema.safeParse({
        grant_all: false,
        agents: [{ id: AGENT }, { id: AGENT }],
      }).success,
    ).toBe(false);
    expect(
      putEnvVariableGrantsRequestSchema.safeParse({
        grant_all: false,
        agents: [{ id: "not-a-uuid" }],
      }).success,
    ).toBe(false);
  });

  test("an agent's variables say where each name came from, and never hold a secret value", () => {
    const parsed = agentEnvVariablesSchema.parse({
      effective: [
        {
          name: "API_URL",
          kind: "plain",
          source: "agent",
          shadows_workspace: true,
          workspace_value_ungranted: false,
        },
      ],
      items: [variable],
      granted_workspace_values: [{ name: "REGION", kind: "plain", value: "x" }],
    });
    expect(parsed.effective[0]?.source).toBe("agent");
    expect(
      agentEnvVariablesSchema.safeParse({
        effective: [],
        items: [],
        granted_workspace_values: [{ name: "REGION", kind: "plain", extra: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("env_start", () => {
  test("a plain entry holds its value, a secret entry does not need one", () => {
    const parsed = envStartSchema.parse({
      entries: [
        {
          name: "A",
          scope: "workspace",
          kind: "plain",
          version: 1,
          value: "x",
        },
        { name: "B", scope: "agent", kind: "secret", version: 2 },
      ],
      skipped: ["C"],
    });
    expect(parsed.entries[1]).not.toHaveProperty("value");
  });

  test("a later field does not make an older image refuse the snapshot", () => {
    expect(
      envStartSchema.safeParse({ entries: [], skipped: [], later: 1 }).success,
    ).toBe(true);
  });
});

describe("codes", () => {
  test("every error code the variable routes answer with exists", () => {
    for (const code of [
      "VARIABLE_NAME_INVALID",
      "VARIABLE_NAME_RESERVED",
      "VARIABLE_VALUE_INVALID",
      "VARIABLE_VALUE_TOO_LARGE",
      "VARIABLE_QUOTA_EXCEEDED",
      "VARIABLE_UNRESOLVED",
      "SECRET_ACK_REQUIRED",
      "SECRET_GRANT_ALL_FORBIDDEN",
      "SECRET_ENV_UNSUPPORTED",
      "VERSION_MISMATCH",
      "PRECONDITION_REQUIRED",
    ]) {
      expect(apiErrorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  test("VARIABLE_REFUSED names a cause, never a variable", () => {
    expect(
      sessionAttentionSchema.parse({
        code: "VARIABLE_REFUSED",
        reason: "not_granted",
      }),
    ).toEqual({ code: "VARIABLE_REFUSED", reason: "not_granted" });
    expect(
      sessionAttentionSchema.safeParse({
        code: "VARIABLE_REFUSED",
        reason: "API_URL",
      }).success,
    ).toBe(false);
  });

  test("the five receipt operations exist", () => {
    for (const operation of [
      "set_env_variable",
      "delete_env_variable",
      "set_env_variable_grants",
      "resolve_session_env",
      "reject_session_env",
    ]) {
      expect(receiptOperationSchema.safeParse(operation).success).toBe(true);
    }
  });
});
