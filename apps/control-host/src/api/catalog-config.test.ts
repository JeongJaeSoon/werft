import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSettingsDocument } from "@werft-ai/platform";
import {
  installedRuntimes,
  installedRuntimeVersions,
  loadSecretKey,
  refuseFileCatalog,
  SECRET_KEY_SETTING,
} from "./catalog-config.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const FIXTURES = {
  "real-model": "tests/fixtures/settings/real-model.json",
  "fake-model": "tests/fixtures/settings/fake-model.json",
  "local-model": "tests/fixtures/settings/local-model.json",
  "d2-gate": "scripts/d2-gate/settings.json",
} as const;
type Fixture = keyof typeof FIXTURES;

async function fixture(name: Fixture) {
  return parseSettingsDocument(
    await Bun.file(join(REPO_ROOT, FIXTURES[name])).json(),
  );
}

describe("what no longer starts", () => {
  test("a leftover file catalog is refused with the way out, until it is unset", () => {
    for (const name of ["PLATFORM_CONFIG_DIR", "SESSION_CATALOG_JSON"]) {
      expect(() => refuseFileCatalog({ [name]: "x" })).toThrow(
        `${name} no longer read: finish the import with \`bun run settings import --from-dir <dir>\``,
      );
    }
    expect(() =>
      refuseFileCatalog({
        PLATFORM_CONFIG_DIR: "/c",
        SESSION_CATALOG_JSON: "{}",
      }),
    ).toThrow("then unset them");
    // Compose passes an unset variable through as empty.
    expect(() =>
      refuseFileCatalog({ PLATFORM_CONFIG_DIR: "", SESSION_CATALOG_JSON: "" }),
    ).not.toThrow();
    expect(() => refuseFileCatalog({})).not.toThrow();
  });

  test("a missing or empty master key is refused, a bad one without its value", () => {
    for (const env of [{}, { [SECRET_KEY_SETTING]: "" }]) {
      expect(() => loadSecretKey(env)).toThrow(
        `${SECRET_KEY_SETTING} is required`,
      );
    }
    let message = "";
    try {
      loadSecretKey({ [SECRET_KEY_SETTING]: "not-hex-value" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(SECRET_KEY_SETTING);
    expect(message).not.toContain("not-hex-value");
    expect(
      loadSecretKey({ [SECRET_KEY_SETTING]: "ab".repeat(32) }),
    ).toBeDefined();
  });
});

describe("installed runtimes", () => {
  test("a release on an Anthropic or LiteLLM connection has its runtime", () => {
    expect(installedRuntimeVersions.claude_agent_sdk).toBeString();
    expect(installedRuntimes.offers("claude_agent_sdk", "skills")).toBe(true);
  });
});

describe("the settings fixtures", () => {
  test("every fixture parses and each connection offers a model", async () => {
    for (const name of Object.keys(FIXTURES) as Fixture[]) {
      const entries = await fixture(name);
      const ids = Object.keys(entries.connections);
      expect([name, ids.length > 0]).toEqual([name, true]);
      for (const id of ids) {
        expect([
          name,
          id,
          (entries.connection_models?.[id]?.models.length ?? 0) > 0,
        ]).toEqual([name, id, true]);
      }
    }
  });

  test("the fake-model fixture offers the model the demo agents run", async () => {
    const entries = await fixture("fake-model");
    expect(entries.connection_models?.["fake-messages"]?.models).toContain(
      "claude-sonnet-5",
    );
  });
});

describe("the default secret ids", () => {
  const read = (path: string) => Bun.file(join(REPO_ROOT, path)).text();
  const idsIn = (text: string, pattern: RegExp) =>
    [...text.matchAll(pattern)].map((match) => match[1] as string);

  // Everything that names a secret in the local stack, and the one writer
  // that is not the LocalStack init script: the fake GitHub App signs with
  // a key it stores itself.
  const SEED = "infra/localstack/secrets-init/10-seed-secrets.sh";
  const HEALTHCHECKS = [
    SEED,
    "infra/compose.local.yml",
    "deploy/kind/deps-secrets.yaml",
  ];
  const DOCUMENTS = [
    ...Object.values(FIXTURES),
    ".claude/skills/verify-werft/github-sandbox/settings.json",
  ];

  test("the seed script, the health checks and every settings document use werft/*", async () => {
    const seeded = idsIn(await read(SEED), /--name (\S+)/g);
    const appKey = idsIn(
      await read("packages/testkit/src/local-github-main.ts"),
      /const secretId = "([^"]+)"/g,
    );
    expect(seeded.sort()).toEqual([
      "werft/local/fake-mcp",
      "werft/local/fake-messages",
    ]);
    expect(appKey).toEqual(["werft/local/fake-github-app"]);

    for (const path of HEALTHCHECKS) {
      const probed = idsIn(await read(path), /--secret-id (\S+)/g);
      expect(probed.length).toBeGreaterThan(0);
      for (const id of probed) expect(seeded).toContain(id);
    }
    for (const path of DOCUMENTS) {
      const used = idsIn(await read(path), /"secret_id":\s*"([^"]+)"/g);
      expect(used.length).toBeGreaterThan(0);
      for (const id of used) expect([...seeded, ...appKey]).toContain(id);
    }
  });

  test("no seed, example or fixture names a secret under the old prefix", async () => {
    const files = [
      ...HEALTHCHECKS,
      ...DOCUMENTS,
      "deploy/helm/werft/values-aws.example.yaml",
      "packages/testkit/src/local-github-main.ts",
      "tests/e2e/run.sh",
      "tests/e2e/settings-fixture.ts",
      "apps/control-host/src/api/settings.test.ts",
    ];
    for (const path of files) {
      expect([
        path,
        /agent-platform\/(local|prod)\//.test(await read(path)),
      ]).toEqual([path, false]);
    }
    expect(await read("deploy/helm/werft/values-aws.example.yaml")).toContain(
      "remoteKey: werft/prod/control-plane",
    );
  });
});
