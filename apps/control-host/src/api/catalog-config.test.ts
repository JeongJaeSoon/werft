import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  catalogRows,
  installationProfileSnapshot,
  parseSeedDocument,
  profileFingerprint,
  profilePinned,
  repositoryModeOf,
  resolveSessionCatalog,
  type SessionCatalogConfig,
} from "@werft-ai/platform";
import { settingsDocument } from "../test-support/settings.ts";
import {
  ALLOW_UNATTENDED_SETTING,
  installedRuntimes,
  loadSecretKey,
  optInProfiles,
  profileSources,
  profileViewSources,
  refuseFileCatalog,
  runtimeVersionsFromEnv,
  SECRET_KEY_SETTING,
  unattendedAllowed,
  unattendedProfiles,
} from "./catalog-config.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const FIXTURES = {
  "real-model": "tests/fixtures/settings/real-model.json",
  "fake-model": "tests/fixtures/settings/fake-model.json",
  "local-model": "tests/fixtures/settings/local-model.json",
  "fake-model-unattended": "tests/fixtures/settings/fake-model-unattended.json",
  "d2-gate": "scripts/d2-gate/settings.json",
} as const;
type Fixture = keyof typeof FIXTURES;
const EXAMPLES = Object.keys(FIXTURES).filter(
  (name) => name !== "d2-gate",
) as Fixture[];

async function fixture(name: Fixture) {
  const { entries, profiles } = parseSeedDocument(
    await Bun.file(join(REPO_ROOT, FIXTURES[name])).json(),
  );
  if (profiles === null) throw new Error(`${name} seeds no ceiling`);
  return { entries, profiles, repositories: entries.repositories };
}

const OLD_VERSION = <P extends { runtime_version: string }>(profile: P): P => ({
  ...profile,
  runtime_version: "0.3.270",
});

const resolved = (config: Pick<SessionCatalogConfig, "profiles">) =>
  resolveSessionCatalog(
    { profiles: config.profiles, repositories: {} },
    () => "placeholder-credential-value",
  );

const PROVIDER = `    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
`;
const profile = (
  id: string,
  mode: string,
  kind = "claude_agent_sdk",
) => `  ${id}:
    runtime_kind: ${kind}
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: ${mode}
    repository: none
${PROVIDER}`;
const seedWith = (other: string) =>
  parseSeedDocument(
    settingsDocument(
      `profiles:\n${profile("steady", "default")}${other}`,
      `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    auth:
      kind: api_key
      value_env: PROVIDER_KEY
`,
    ),
  );

function apiSnapshot(
  seed: ReturnType<typeof seedWith>,
  env: Record<string, string>,
) {
  const sources = profileSources(env);
  return installationProfileSnapshot(
    {
      ...sources,
      connections: seed.entries.connections,
      materialize: (id, definition) =>
        sources.materialize(id, definition, () => "placeholder"),
    },
    catalogRows(seed.profiles ?? {}, seed.entries.repositories),
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

describe("unattended permission modes", () => {
  test("a profile that skips approval is left out until the installation allows it", () => {
    const seed = seedWith(profile("skipping", "bypassPermissions"));
    const off = apiSnapshot(seed, {});
    expect(Object.keys(off.profiles)).toEqual(["steady"]);
    expect(off.installation.get("skipping")?.state).toBe("unattended_off");
    const on = apiSnapshot(seed, { [ALLOW_UNATTENDED_SETTING]: "true" });
    expect(on.profiles.skipping?.permission_mode).toBe("bypassPermissions");
    expect(unattendedProfiles(on)).toEqual(["skipping"]);
  });

  test("anything but the literal true keeps it out", () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      expect(unattendedAllowed({ [ALLOW_UNATTENDED_SETTING]: value })).toBe(
        false,
      );
    }
    expect(unattendedAllowed({ [ALLOW_UNATTENDED_SETTING]: "true" })).toBe(
      true,
    );
  });

  test("an auto profile loads without the switch: its classifier still judges each call", () => {
    const snapshot = apiSnapshot(seedWith(profile("judged", "auto")), {});
    expect(snapshot.profiles.judged?.permission_mode).toBe("auto");
    expect(unattendedProfiles(snapshot)).toEqual(["judged"]);
    expect(optInProfiles(snapshot)).toEqual([]);
  });
});

describe("installed runtimes", () => {
  test("pass every profile the fixtures seed", async () => {
    for (const name of Object.keys(FIXTURES) as Fixture[]) {
      const { profiles } = await fixture(name);
      expect(Object.keys(profiles).length).toBeGreaterThan(0);
      installedRuntimes.assertProfiles(profiles);
    }
  });

  test("the default fixtures carry an auto base and start without the installation's opt-in", async () => {
    const expected: Partial<Record<Fixture, string[]>> = {
      "real-model": ["claude-coding-real"],
      "fake-model": ["claude-coding-auto"],
      "local-model": [],
    };
    for (const [name, auto] of Object.entries(expected)) {
      const config = await fixture(name as Fixture);
      expect(unattendedProfiles(config)).toEqual(auto);
      expect(optInProfiles(config)).toEqual([]);
      for (const id of auto) {
        expect(config.repositories["sample-app"]?.profiles).toContain(id);
      }
    }
  });

  test("a seeded profile keeps the fingerprint main gave it, and an auto base is the same profile in every example", async () => {
    // Computed on main at 304c2713: sessions and releases pin these. The
    // fake-messages profiles moved once more when the default secret id became
    // werft/local/fake-messages (94S-1411): the reference is part of the hash.
    // claude-coding-real moved when it gained AskUserQuestion and again when
    // it became auto (94S-1243): a seed only fills an empty
    // installation_profiles table, whose rows keep the digest their sessions
    // pinned.
    const onMain: Partial<Record<Fixture, Record<string, string>>> = {
      "real-model": {
        "claude-coding-real":
          "sha256:1fc3c2a8042b16a150b6c2f7ab2d93c801daf2faacc7c86eefdf087f94d10fc1",
      },
      "fake-model": {
        "claude-coding-local":
          "sha256:72712d90972545ff5b7e0124e9647fab5d30e750b1422b626c217b116b160dd0",
        general:
          "sha256:6d29ef4da170790c0a7abefac65abf2d33079fab14162b461a811378b170d6a6",
      },
      "local-model": {
        "local-ollama":
          "sha256:719a7af6b2f1ec7710965e57e021d8d1d558cc3043866d518de09aca8894ec4b",
        "local-litellm":
          "sha256:d342569f22e036620a11708b4f0247d2784577bc62c0caf556a0ecb2073f682a",
      },
      "fake-model-unattended": {
        "claude-coding-auto":
          "sha256:a1e65a5716ac13d4ef2bad746f8aa8f611c0e8994d4195a14ce57f897bb28170",
        "claude-coding-bypass":
          "sha256:0c0a448dfd97b6236eea2fb5af8c8b781eb716e0549559649ff81cee5cbf6d8c",
      },
    };
    const shared = new Map<string, string>();
    for (const [name, pinned] of Object.entries(onMain)) {
      const config = resolved(await fixture(name as Fixture));
      for (const [id, digest] of Object.entries(pinned)) {
        const entry = config.profiles[id];
        // The pins were taken under 0.3.270, the version the seeds named then.
        // A bump moves the seeds, not these digests: a row pinned to one keeps
        // matching while the old version is accepted (profilePinned).
        expect(entry && profileFingerprint(OLD_VERSION(entry))).toBe(digest);
        expect(entry && profilePinned(entry, digest, ["0.3.270"])).toBe(true);
      }
      for (const [id, entry] of Object.entries(config.profiles)) {
        const digest = profileFingerprint(entry);
        expect(shared.get(id) ?? digest).toBe(digest);
        shared.set(id, digest);
      }
    }
  });

  test("only the bypass example needs the installation's opt-in", async () => {
    const config = await fixture("fake-model-unattended");
    expect(unattendedProfiles(config)).toEqual([
      "claude-coding-auto",
      "claude-coding-bypass",
    ]);
    expect(optInProfiles(config)).toEqual(["claude-coding-bypass"]);
    expect(config.repositories["sample-app"]?.profiles).toEqual([
      "claude-coding-local",
      "claude-coding-auto",
      "claude-coding-bypass",
    ]);
    const states = (env: Record<string, string>) =>
      new Map(
        [
          ...installationProfileSnapshot(
            {
              ...profileViewSources(env),
              connections: config.entries.connections,
            },
            catalogRows(config.profiles, config.repositories),
          ).installation.values(),
        ].map((entry) => [entry.id, entry.state]),
      );
    expect([...states({})].filter(([, state]) => state !== "usable")).toEqual([
      ["claude-coding-bypass", "unattended_off"],
    ]);
    expect(
      states({ [ALLOW_UNATTENDED_SETTING]: "true" }).get(
        "claude-coding-bypass",
      ),
    ).toBe("usable");
  });

  test("configured worker images take no ceiling away: open sessions keep their profile", async () => {
    const config = await fixture("fake-model");
    const image = (sdkVersion: string, cliVersion: string) =>
      JSON.stringify({ cliVersion, engine: "claude", sdkVersion });
    const states = (env: Record<string, string>) =>
      new Set(
        [
          ...installationProfileSnapshot(
            {
              ...profileViewSources(env),
              connections: config.entries.connections,
            },
            catalogRows(config.profiles, config.repositories),
          ).installation.values(),
        ].map((entry) => entry.state),
      );
    expect(states({})).toEqual(new Set(["usable"]));
    expect(
      states({ WORKER_IMAGE_RUNTIME: image("0.3.270", "2.1.270") }),
    ).toEqual(new Set(["usable"]));
    expect(
      states({
        WORKER_IMAGE_RUNTIME: image("0.3.280", "2.1.280"),
        WORKER_IMAGE_PREVIOUS_RUNTIME: image("0.3.270", "2.1.270"),
      }),
    ).toEqual(new Set(["usable"]));
    expect(
      states({ WORKER_IMAGE_RUNTIME: image("0.3.280", "2.1.280") }),
    ).toEqual(new Set(["usable"]));
    expect(runtimeVersionsFromEnv({})).toBeUndefined();
    // A profile row left at the build before the image's has the same tool
    // catalog, so the image still runs it; a row at a build with none is not.
    const runtimes = runtimeVersionsFromEnv({
      WORKER_IMAGE_RUNTIME: image("0.3.319", "2.1.319"),
    });
    expect(runtimes?.current).toEqual(
      expect.arrayContaining(["0.3.319", "2.1.319", "0.3.270", "2.1.270"]),
    );
    expect(runtimes?.current).not.toContain("0.3.1");
    // A session pinned under the older row still names its profile once the
    // row moves to the image's own version.
    expect(runtimes?.accepted).toEqual(
      expect.arrayContaining(["0.3.319", "0.3.270"]),
    );
    expect(() =>
      runtimeVersionsFromEnv({ WORKER_IMAGE_RUNTIME: "0.3.280" }),
    ).toThrow("WORKER_IMAGE_RUNTIME");
  });

  test("a profile of a kind the image does not ship is refused by name", () => {
    const seed = seedWith(profile("other", "default", "codex_app_server"));
    expect(() => installedRuntimes.assertProfiles(seed.profiles ?? {})).toThrow(
      "Catalog profile(s) refused: other: Runtime codex_app_server is not installed (installed: claude_agent_sdk)",
    );
  });
});

describe("the settings fixtures", () => {
  test("every fixture carries the connections its seeded ceilings run on", async () => {
    for (const name of Object.keys(FIXTURES) as Fixture[]) {
      const config = await fixture(name);
      const snapshot = installationProfileSnapshot(
        {
          ...profileViewSources({ [ALLOW_UNATTENDED_SETTING]: "true" }),
          connections: config.entries.connections,
        },
        catalogRows(config.profiles, config.repositories),
      );
      expect(
        [...snapshot.installation.values()].filter(
          (entry) => entry.state !== "usable",
        ),
      ).toEqual([]);
    }
  });

  test("the real-model fixture needs no key to start: without one its ceiling is connection_missing, with one usable", async () => {
    const config = await fixture("real-model");
    const states = (env: Record<string, string>) => {
      const sources = profileSources(env);
      const lookup = (ref: object) =>
        "value_env" in ref ? env[String(ref.value_env)] : undefined;
      return new Map(
        [
          ...installationProfileSnapshot(
            {
              ...sources,
              connections: config.entries.connections,
              lookup,
              materialize: (id, definition) =>
                sources.materialize(id, definition, lookup),
            },
            catalogRows(config.profiles, config.repositories),
          ).installation.values(),
        ].map((entry) => [entry.id, entry.state]),
      );
    };
    expect(states({}).get("claude-coding-real")).toBe("connection_missing");
    expect(states({ ANTHROPIC_API_KEY: "placeholder-key" })).toEqual(
      new Map([["claude-coding-real", "usable"]]),
    );
  });

  test("a repository names only ceilings the fixture seeds", async () => {
    for (const name of EXAMPLES) {
      const config = await fixture(name);
      for (const repository of Object.values(config.repositories)) {
        for (const id of repository.profiles ?? []) {
          expect(Object.hasOwn(config.profiles, id)).toBe(true);
        }
      }
    }
  });

  test("seeded profiles keep the fingerprints main computed before `repository` existed", async () => {
    // Captured on main 015a1634; a profile they no longer name fails every
    // session pinned to it with CATALOG_MISMATCH. claude-coding-real left
    // the list when it gained AskUserQuestion; the rows it seeded before keep
    // their own definition.
    const catalog = resolved(await fixture("fake-model"));
    const coding = catalog.profiles["claude-coding-local"];
    if (coding === undefined) throw new Error("no claude-coding-local");
    expect(
      profilePinned(
        coding,
        "sha256:4be8de033a7e0268fa33d785ef498f3ddc9ed2452ee0c6b9b0461dc14a8fc539",
        // Taken under 0.3.270; the seeds name 0.3.319 since the SDK bump.
        ["0.3.270"],
      ),
    ).toBe(true);
    expect(repositoryModeOf(coding)).toBe("required");
  });

  test("the fake-model fixture offers a profile that runs without a repository", async () => {
    const catalog = resolved(await fixture("fake-model"));
    const general = catalog.profiles.general;
    const coding = catalog.profiles["claude-coding-local"];
    if (general === undefined || coding === undefined) {
      throw new Error("the fake-model fixture lacks a profile");
    }
    expect(repositoryModeOf(general)).toBe("none");
    expect(general.tools).not.toContain("Bash");
    expect(general.provider).toEqual(coding.provider);
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
      "apps/control-host/src/api/settings-seed.integration.test.ts",
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
