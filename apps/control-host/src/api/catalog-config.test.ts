import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseSettingsDocument } from "@werft-ai/platform";
import {
  installedRuntimes,
  installedRuntimeVersions,
  launchableKindsFromEnv,
  loadSecretKey,
  MasterKeyError,
  masterKeyConfigured,
  refuseFileCatalog,
  runtimeVersionsFromEnv,
  SECRET_KEY_FILE_SETTING,
  SECRET_KEY_SETTING,
} from "./catalog-config.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const FIXTURES = {
  "real-model": "tests/fixtures/settings/real-model.json",
  "fake-model": "tests/fixtures/settings/fake-model.json",
  "local-model": "tests/fixtures/settings/local-model.json",
  "two-engines": "tests/fixtures/settings/conformance-two-engines.json",
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

describe("the master key from a file", () => {
  const HEX = "cd".repeat(32);
  const files = (content: Record<string, string>) => (path: string) => {
    const value = content[path];
    if (value === undefined) throw new Error("ENOENT");
    return value;
  };
  const codeOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(MasterKeyError);
      const { code, message } = error as MasterKeyError;
      expect(message).not.toContain(HEX);
      expect(message).not.toContain("ab".repeat(32));
      return code;
    }
    throw new Error("loaded");
  };

  test("the file alone, with or without its trailing newline, gives the key", () => {
    for (const content of [HEX, `${HEX}\n`, `${HEX}\r\n`]) {
      const read = files({ "/run/secrets/k": content });
      const fromFile = loadSecretKey(
        { [SECRET_KEY_FILE_SETTING]: "/run/secrets/k" },
        read,
      );
      const fromEnv = loadSecretKey({ [SECRET_KEY_SETTING]: HEX });
      expect(fromFile.bytes().equals(fromEnv.bytes())).toBe(true);
    }
  });

  test("both settings agreeing is the same key; differing is master_key_mismatch", () => {
    const read = files({ "/k": HEX });
    const both = { [SECRET_KEY_SETTING]: HEX, [SECRET_KEY_FILE_SETTING]: "/k" };
    expect(loadSecretKey(both, read).bytes().toString("hex")).toBe(HEX);
    expect(
      codeOf(() =>
        loadSecretKey(
          {
            [SECRET_KEY_SETTING]: "ab".repeat(32),
            [SECRET_KEY_FILE_SETTING]: "/k",
          },
          read,
        ),
      ),
    ).toBe("master_key_mismatch");
  });

  test("an unreadable or empty file is master_key_missing, a bad value master_key_invalid", () => {
    const read = files({ "/empty": "\n", "/bad": "not-a-key\n" });
    expect(
      codeOf(() => loadSecretKey({ [SECRET_KEY_FILE_SETTING]: "/none" }, read)),
    ).toBe("master_key_missing");
    expect(
      codeOf(() =>
        loadSecretKey({ [SECRET_KEY_FILE_SETTING]: "/empty" }, read),
      ),
    ).toBe("master_key_missing");
    expect(
      codeOf(() => loadSecretKey({ [SECRET_KEY_FILE_SETTING]: "/bad" }, read)),
    ).toBe("master_key_invalid");
    expect(codeOf(() => loadSecretKey({}, read))).toBe("master_key_missing");
    // Compose passes an unset variable through as empty.
    expect(
      codeOf(() =>
        loadSecretKey(
          { [SECRET_KEY_SETTING]: "", [SECRET_KEY_FILE_SETTING]: "" },
          read,
        ),
      ),
    ).toBe("master_key_missing");
  });

  test("masterKeyConfigured sees either setting", () => {
    expect(masterKeyConfigured({})).toBe(false);
    expect(masterKeyConfigured({ [SECRET_KEY_SETTING]: "" })).toBe(false);
    expect(masterKeyConfigured({ [SECRET_KEY_SETTING]: HEX })).toBe(true);
    expect(masterKeyConfigured({ [SECRET_KEY_FILE_SETTING]: "/k" })).toBe(true);
  });
});

describe("installed runtimes", () => {
  test("a release on an Anthropic or LiteLLM connection has its runtime", () => {
    expect(installedRuntimeVersions.claude_agent_sdk).toBeString();
    expect(installedRuntimes.offers("claude_agent_sdk", "skills")).toBe(true);
  });

  test("a list of images gives the versions the two single-image settings give", () => {
    const current = {
      engine: "claude",
      sdkVersion: "0.3.280",
      cliVersion: "2.1.280",
    };
    const previous = {
      ...current,
      sdkVersion: "0.3.270",
      cliVersion: "2.1.270",
    };
    const listed = runtimeVersionsFromEnv({
      WORKER_IMAGES: JSON.stringify([
        {
          image: `reg/worker@sha256:${"a".repeat(64)}`,
          runtime: current,
          released_at: "2026-11-10T00:00:00Z",
        },
        {
          image: `reg/worker@sha256:${"b".repeat(64)}`,
          runtime: previous,
          released_at: "2026-10-01T00:00:00Z",
        },
      ]),
    });
    expect(listed?.accepted).toContainEqual({
      kind: "claude_agent_sdk",
      engine: "claude",
      version: "0.3.280",
    });
    expect(listed?.accepted).toContainEqual({
      kind: "claude_agent_sdk",
      engine: "claude",
      version: "0.3.270",
    });
    // A claude image ships no Codex runtime, whatever its version strings.
    expect(
      listed?.accepted.some(({ kind }) => kind === "codex_app_server"),
    ).toBe(false);
    expect(listed).toEqual(
      runtimeVersionsFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(current),
        WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(previous),
      }),
    );
    const retracted = (flags: [boolean, boolean]) =>
      runtimeVersionsFromEnv({
        WORKER_IMAGES: JSON.stringify([
          {
            image: `reg/worker@sha256:${"a".repeat(64)}`,
            runtime: current,
            released_at: "2026-11-10T00:00:00Z",
            retracted: flags[0],
          },
          {
            image: `reg/worker@sha256:${"b".repeat(64)}`,
            runtime: previous,
            released_at: "2026-10-01T00:00:00Z",
            retracted: flags[1],
          },
        ]),
      });
    // A retracted image's versions stay accepted: a fixed build of the same
    // combination takes what was sealed on it.
    const pairs = (versions: typeof listed) =>
      (versions?.accepted ?? [])
        .map(({ kind, version }) => `${kind} ${version}`)
        .sort();
    expect(pairs(retracted([true, false]))).toEqual(pairs(listed));
    expect(pairs(retracted([true, true]))).toEqual(pairs(listed));
  });

  test("an older build with the image's own tool catalog runs, under the image's kind only", () => {
    // The installed claude catalog of 0.3.319 is also 0.3.270's.
    const claude = runtimeVersionsFromEnv({
      WORKER_IMAGE_RUNTIME: JSON.stringify({
        engine: "claude",
        sdkVersion: "0.3.319",
        cliVersion: "2.1.319",
      }),
    })?.accepted;
    expect(claude).toContainEqual({
      kind: "claude_agent_sdk",
      engine: "claude",
      version: "0.3.270",
    });
    expect(claude).not.toContainEqual({
      kind: "codex_app_server",
      engine: "codex",
      version: "0.3.270",
    });
    const codex = runtimeVersionsFromEnv({
      WORKER_IMAGE_RUNTIME: JSON.stringify({
        engine: "codex",
        sdkVersion: "0.3.319",
        cliVersion: "0.3.319",
      }),
    })?.accepted;
    expect(codex).toEqual([
      { kind: "codex_app_server", engine: "codex", version: "0.3.319" },
    ]);
  });

  test("switching engines keeps the previous engine's sessions running, under its own kind", () => {
    const codex = { engine: "codex", sdkVersion: "0.9.0", cliVersion: "0.9.0" };
    const claude = {
      engine: "claude",
      sdkVersion: "0.3.270",
      cliVersion: "2.1.270",
    };
    const accepted = runtimeVersionsFromEnv({
      WORKER_IMAGE_RUNTIME: JSON.stringify(codex),
      WORKER_IMAGE_PREVIOUS_RUNTIME: JSON.stringify(claude),
    })?.accepted;
    expect(accepted).toContainEqual({
      kind: "codex_app_server",
      engine: "codex",
      version: "0.9.0",
    });
    expect(accepted).toContainEqual({
      kind: "claude_agent_sdk",
      engine: "claude",
      version: "0.3.270",
    });
    expect(accepted).not.toContainEqual({
      kind: "claude_agent_sdk",
      engine: "claude",
      version: "0.9.0",
    });
    expect(accepted).not.toContainEqual({
      kind: "codex_app_server",
      engine: "codex",
      version: "0.3.270",
    });
  });

  test("a session waits without an image only when every listed image of its own engine is retracted", () => {
    const claude = (retracted: boolean, digit: string, at: string) => ({
      image: `reg/claude@sha256:${digit.repeat(64)}`,
      runtime: {
        engine: "claude",
        sdkVersion: "0.3.270",
        cliVersion: "2.1.270",
      },
      released_at: at,
      retracted,
    });
    const codex = {
      image: `reg/codex@sha256:${"c".repeat(64)}`,
      runtime: { engine: "codex", sdkVersion: "0.9.0", cliVersion: "0.9.0" },
      released_at: "2026-11-10T00:00:00Z",
    };
    const env = (list: unknown[]) => ({ WORKER_IMAGES: JSON.stringify(list) });
    const kinds = (list: unknown[]) =>
      [
        ...new Set(
          runtimeVersionsFromEnv(env(list))?.accepted.map(({ kind }) => kind),
        ),
      ].sort();

    // Only claude's images retracted: claude sessions wait, codex ones launch,
    // and claude stays in the catalog, so they read NO_WORKER_IMAGE.
    const claudeRetracted = [
      claude(true, "a", "2026-11-10T00:00:00Z"),
      claude(true, "b", "2026-10-01T00:00:00Z"),
      codex,
    ];
    const launchable = launchableKindsFromEnv(env(claudeRetracted));
    expect(launchable("claude_agent_sdk")).toBe(false);
    expect(launchable("codex_app_server")).toBe(true);
    expect(kinds(claudeRetracted)).toEqual([
      "claude_agent_sdk",
      "codex_app_server",
    ]);
    // One claude image left: it launches.
    expect(
      launchableKindsFromEnv(
        env([
          claude(true, "a", "2026-11-10T00:00:00Z"),
          claude(false, "b", "2026-10-01T00:00:00Z"),
          codex,
        ]),
      )("claude_agent_sdk"),
    ).toBe(true);
    // No claude image listed at all: claude leaves the catalog, so its
    // sessions read CATALOG_MISMATCH before this is asked.
    expect(launchableKindsFromEnv(env([codex]))("claude_agent_sdk")).toBe(
      false,
    );
    expect(kinds([codex])).toEqual(["codex_app_server"]);
    // A kind this host does not run has no image, and the single-image
    // settings retract nothing.
    expect(launchable("unknown_kind")).toBe(false);
    expect(
      launchableKindsFromEnv({
        WORKER_IMAGE_RUNTIME: JSON.stringify(codex.runtime),
      })("claude_agent_sdk"),
    ).toBe(true);
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

describe("where the settings documents' keys come from", () => {
  const read = (path: string) => Bun.file(join(REPO_ROOT, path)).text();
  const DOCUMENTS = [
    ...Object.values(FIXTURES),
    "tests/fixtures/settings/fake-model-codex.json",
    "tests/fixtures/settings/conformance-codex.json",
    ".claude/skills/verify-werft/github-sandbox/settings.json",
  ];

  // Every key is set through the console after the first owner exists
  // (scripts/lib/seed-credentials.sh); no document points at the
  // environment or a secret store.
  test("every settings document leaves its keys to `stored`", async () => {
    for (const path of DOCUMENTS) {
      const text = await read(path);
      expect([path, /"(value_env|secret_id)"/.test(text)]).toEqual([
        path,
        false,
      ]);
      expect([path, text.includes('"stored": true')]).toEqual([path, true]);
    }
  });

  test("the fake GitHub App keeps its key in a file of its own", async () => {
    const main = await read("packages/testkit/src/local-github-main.ts");
    expect(main).toContain("FAKE_GITHUB_APP_KEY_FILE");
    expect(main).not.toMatch(/secrets-manager|secretId/i);
  });

  test("no example or fixture names a secret under the old prefix", async () => {
    const files = [
      "infra/compose.local.yml",
      ...Object.values(FIXTURES),
      ".claude/skills/verify-werft/github-sandbox/settings.json",
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
