import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerUpstreamOf } from "@werft-ai/platform";
import { egressProxyConfigFromEnv } from "../../apps/egress-proxy/src/config.ts";
import {
  COMPOSE_RENDER_TIMEOUT_MS,
  LOCAL_LAYERS,
  layeredServices,
} from "../compose-layers.ts";
import { fixtureCatalog } from "./settings-fixture.ts";

/**
 * The plumbing of `tests/e2e/run.sh --local-model`, without Docker or
 * Ollama: the settings migrate imports, the overlay that lets the egress
 * proxy reach both routes to the model, and the runner's stop when there is
 * no Ollama.
 */
const ROOT = join(import.meta.dir, "../..");
const OVERLAY = "infra/compose.local-model.yml";
const RUN = join(ROOT, "tests/e2e/run.sh");
const KEYS = ["LOCAL_OLLAMA_API_KEY", "LITELLM_MASTER_KEY"] as const;

type Service = { environment?: Record<string, string | null> };

const overlay = async () =>
  (
    Bun.YAML.parse(await Bun.file(join(ROOT, OVERLAY)).text()) as {
      services: Record<string, Service>;
    }
  ).services;

/** A service's environment as compose resolves it with nothing set. */
function defaults(...layers: Array<Service | undefined>) {
  const env: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer?.environment ?? {})) {
      if (typeof value === "string") {
        env[key] = value.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, "$1");
      }
    }
  }
  return env;
}

const catalog = () =>
  fixtureCatalog("local-model", {
    LOCAL_OLLAMA_API_KEY: "ollama-probe",
    LITELLM_MASTER_KEY: "sk-probe",
  });

describe("local-model catalog", () => {
  test("one connection calls Ollama with a key, the other LiteLLM with a bearer", async () => {
    const { connections, repositories } = await catalog();
    expect(Object.keys(connections)).toEqual(["ollama", "litellm"]);
    expect(Object.keys(repositories)).toEqual(["sample-app"]);
    const [ollama, litellm] = [
      connections.ollama?.provider,
      connections.litellm?.provider,
    ];
    if (ollama === undefined || litellm === undefined) {
      throw new Error("missing connection");
    }
    expect(providerUpstreamOf(ollama)).toEqual({
      url: "http://ollama.internal:11434",
      headers: [["x-api-key", "ollama-probe"]],
    });
    expect(providerUpstreamOf(litellm)).toEqual({
      url: "http://litellm:4000",
      headers: [["authorization", "Bearer sk-probe"]],
    });
  });
});

describe("local-model compose overlay", () => {
  test("migrate imports the local-model settings and the API alone holds the Ollama key", async () => {
    const services = await overlay();
    const { api, migrate } = layeredServices<Service>([
      ...LOCAL_LAYERS,
      OVERLAY,
    ]);
    expect(migrate?.environment?.SETTINGS_DOCUMENT).toBe(
      "/settings/local-model.json",
    );
    expect(api?.environment?.ANTHROPIC_API_KEY).toBe("");
    for (const [name, service] of Object.entries(services)) {
      const env = service.environment ?? {};
      for (const key of KEYS) {
        const holds =
          name === "api" ||
          (name === "litellm" && key === "LITELLM_MASTER_KEY");
        // By name, from the caller's environment, never a value.
        if (holds) expect(env[key]).toBeNull();
        else expect(Object.hasOwn(env, key)).toBe(false);
      }
    }
  });

  test("the proxy reaches every connection's endpoint on the credential route alone", async () => {
    const base = layeredServices<Service>(LOCAL_LAYERS);
    const proxy = egressProxyConfigFromEnv(
      defaults(base["egress-proxy"], (await overlay())["egress-proxy"]),
    );
    const forward = [...proxy.allow, ...proxy.allowPrivate];
    for (const connection of Object.values((await catalog()).connections)) {
      const url = new URL(connection.provider.endpoint);
      const destination = { host: url.hostname, port: Number(url.port) };
      expect(proxy.credential?.allowPrivate).toContainEqual(destination);
      expect(forward).not.toContainEqual(destination);
    }
    // The repository and the object store stay; the fake Messages API,
    // which this catalog never calls, does not.
    for (const kept of [
      { host: "fake-git", port: 3000 },
      { host: "localstack", port: 4566 },
    ]) {
      expect(proxy.credential?.allowPrivate).toContainEqual(kept);
    }
    expect(proxy.credential?.allowPrivate).not.toContainEqual({
      host: "fake-messages",
      port: 4010,
    });
  });

  test(
    "a caller's private credential list does not change the overlay's",
    () => {
      // The default stack's value, as .env.example exports it: without the
      // two routes the stack comes up healthy and every model call gets 403.
      const variables = {
        EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST:
          "fake-git:3000,fake-messages:4010,localstack:4566",
      };
      const { PATH = "", HOME = "" } = Bun.env;
      const result = Bun.spawnSync(
        [
          "docker",
          "compose",
          "--env-file",
          "/dev/null",
          "--profile",
          "apps",
          ...[...LOCAL_LAYERS, OVERLAY].flatMap((file) => [
            "-f",
            join(ROOT, file),
          ]),
          "config",
          "--format",
          "json",
        ],
        { env: { PATH, HOME, ...variables } },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const proxy = egressProxyConfigFromEnv(
        JSON.parse(result.stdout.toString()).services["egress-proxy"]
          .environment,
      );
      for (const kept of [
        { host: "fake-git", port: 3000 },
        { host: "localstack", port: 4566 },
        { host: "ollama.internal", port: 11434 },
        { host: "litellm", port: 4000 },
      ]) {
        expect(proxy.credential?.allowPrivate).toContainEqual(kept);
      }
      expect(proxy.credential?.allowPrivate).not.toContainEqual({
        host: "fake-messages",
        port: 4010,
      });
    },
    COMPOSE_RENDER_TIMEOUT_MS,
  );

  test("the API waits for a healthy relay and LiteLLM", async () => {
    const services = await overlay();
    const api = services.api as Service & {
      depends_on?: Record<string, { condition: string }>;
    };
    for (const name of ["ollama", "litellm"]) {
      expect(api.depends_on?.[name]).toEqual({ condition: "service_healthy" });
      expect(
        (services[name] as { healthcheck?: { test?: unknown } }).healthcheck
          ?.test,
      ).toBeDefined();
    }
  });
});

describe("run.sh --local-model", () => {
  let dir: string;
  const TAGS = (...names: string[]) =>
    JSON.stringify({ models: names.map((name) => ({ name, model: name })) });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "local-model-run-"));
    const stubs = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", stubs]);
    for (const [name, text] of [
      [
        "docker",
        `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"$STUB_ARGV"\nexit 1\n`,
      ],
      // No Ollama unless STUB_TAGS is set; then /api/tags answers with it.
      // STUB_TAGS_FAIL: Ollama answers everything but /api/tags.
      [
        "curl",
        `#!/usr/bin/env bash\n[ -n "\${STUB_TAGS:-}\${STUB_TAGS_FAIL:-}" ] || exit 7\ncase "$*" in *api/tags*) [ -z "\${STUB_TAGS_FAIL:-}" ] || exit 22; printf '%s' "$STUB_TAGS" ;; *) printf '{"version":"0.40.0"}' ;; esac\n`,
      ],
      ["openssl", "#!/usr/bin/env bash\nexit 1\n"],
    ] as const) {
      await Bun.write(join(stubs, name), text);
      chmodSync(join(stubs, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) => {
    const argv = join(dir, `argv-${crypto.randomUUID()}`);
    const result = Bun.spawnSync(["bash", RUN, "--local-model"], {
      cwd: ROOT,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        TMPDIR: dir,
        E2E_OUT: join(dir, "out"),
        STUB_ARGV: argv,
        ...env,
      },
    });
    return { result, stderr: result.stderr.toString(), argv };
  };

  test("without Ollama it stops before touching Docker", async () => {
    const { result, stderr, argv } = run();
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(
      "no Ollama on 127.0.0.1:11434; nothing was started",
    );
    expect(await Bun.file(argv).exists()).toBe(false);
  });

  test("when Ollama does not answer /api/tags it says so, not that a model is missing", async () => {
    const { result, stderr, argv } = run({ STUB_TAGS_FAIL: "1" });
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(
      "Ollama on 127.0.0.1:11434 did not answer /api/tags (curl exit 22); nothing was started",
    );
    expect(stderr).not.toContain("is not pulled");
    expect(await Bun.file(argv).exists()).toBe(false);
  });

  test("without the catalog's model pulled it says what to pull and stops before Docker", async () => {
    const { result, stderr, argv } = run({
      STUB_TAGS: TAGS("qwen3.6:27b-mlx"),
    });
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(
      "gemma4:26b-mlx is not pulled in Ollama; run `ollama pull gemma4:26b-mlx`; nothing was started",
    );
    expect(await Bun.file(argv).exists()).toBe(false);
  });

  test("when openssl cannot make LiteLLM's key it stops before Docker", async () => {
    const { result, stderr, argv } = run({ STUB_TAGS: TAGS("gemma4:26b-mlx") });
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(
      "could not generate LITELLM_MASTER_KEY with openssl; nothing was started",
    );
    expect(await Bun.file(argv).exists()).toBe(false);
  });

  test("with the model pulled and a key set it goes on to Docker", async () => {
    const { result, argv } = run({
      STUB_TAGS: TAGS("gemma4:26b-mlx"),
      LITELLM_MASTER_KEY: "sk-test",
    });
    // The docker stub fails its first call, so the run ends there.
    expect(result.exitCode).not.toBe(0);
    expect(await Bun.file(argv).text()).toStartWith("version");
  });
});
