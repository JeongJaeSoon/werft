import { describe, expect, test } from "bun:test";
import {
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testCatalog,
  testConnection,
  testToolCatalogs,
} from "../testing/catalog-fakes.ts";
import { releaseRunOf } from "./release-run.ts";

const responses = testConnection({
  provider: {
    kind: "openai_responses",
    endpoint: "https://api.openai.invalid",
    auth: { kind: "api_key", value: "k", ref: { value_env: "K" } },
  },
  models: ["gpt-5"],
});

describe("releaseRunOf", () => {
  test("runs the connection kind's runtime at the image's version, with its whole tool catalog and its subagent tool", () => {
    const found = releaseRunOf(
      testCatalog(),
      TEST_RUNTIMES,
      TEST_CONNECTION_ID,
    );
    if (!found.ok) throw new Error(found.message);
    expect(found.run).toMatchObject({
      connection_id: TEST_CONNECTION_ID,
      runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
      tools: ["Read", "Edit", "Bash", "Agent"],
      permission_mode: "default",
      project_settings: { claude_md: true },
    });
  });

  test("runs auto only where an operator judged the classifier works over the connection", () => {
    for (const [autoMode, mode] of [
      ["supported", "auto"],
      ["unsupported", "default"],
      ["unknown", "default"],
    ] as const) {
      const catalog = testCatalog({
        connections: {
          [TEST_CONNECTION_ID]: testConnection({ auto_mode: autoMode }),
        },
      });
      const found = releaseRunOf(catalog, TEST_RUNTIMES, TEST_CONNECTION_ID);
      expect(found.ok && found.run.permission_mode).toBe(mode);
    }
  });

  test("a Responses connection runs codex, and never auto", () => {
    const catalog = testCatalog({
      connections: { codex: { ...responses, auto_mode: "supported" } },
    });
    const found = releaseRunOf(
      catalog,
      { ...TEST_RUNTIMES, codex_app_server: "0.40.0" },
      "codex",
    );
    expect(found.ok && found.run.runtime).toEqual({
      kind: "codex_app_server",
      version: "0.40.0",
    });
    expect(found.ok && found.run.permission_mode).toBe("default");
  });

  test("refuses a connection the installation does not enable", () => {
    expect(releaseRunOf(testCatalog(), TEST_RUNTIMES, "gone")).toMatchObject({
      ok: false,
      reason_code: "connection_unknown",
    });
  });

  test("refuses a connection whose runtime this image does not ship", () => {
    const catalog = testCatalog({ connections: { codex: responses } });
    expect(releaseRunOf(catalog, TEST_RUNTIMES, "codex")).toMatchObject({
      ok: false,
      reason_code: "runtime_unsupported",
    });
  });

  test("refuses when no tool catalog is installed for the runtime", () => {
    const { tool_catalogs: _none, ...bare } = testCatalog();
    expect(releaseRunOf(bare, TEST_RUNTIMES, TEST_CONNECTION_ID)).toMatchObject(
      { ok: false, reason_code: "tools_unknown" },
    );
    const unknown = testCatalog({
      tool_catalogs: { ...testToolCatalogs(), for: () => undefined },
    });
    expect(
      releaseRunOf(unknown, TEST_RUNTIMES, TEST_CONNECTION_ID),
    ).toMatchObject({ ok: false, reason_code: "tools_unknown" });
  });
});
