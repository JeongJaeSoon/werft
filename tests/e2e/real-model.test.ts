import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installationLimitsFromEnv,
  providerUpstreamOf,
  runtimeProviderOf,
} from "@werft-ai/platform";
import { egressProxyConfigFromEnv } from "../../apps/egress-proxy/src/config.ts";
import {
  FAKE_MODEL,
  LOCAL_LAYERS,
  layeredServices,
  REAL_MODEL as OVERLAY,
} from "../compose-layers.ts";
import { fixtureCatalog } from "./settings-fixture.ts";

/**
 * The plumbing of `tests/e2e/run.sh --real-model` and `scripts/local.sh up`,
 * without Docker or a key: the real-model settings migrate imports, the local
 * layer that hands the key to the API alone, the overlay's cost limits, and
 * both scripts run against stand-ins for docker, bun and curl. The paid run
 * is the user's (docs/real-claude.md).
 */
const ROOT = join(import.meta.dir, "../..");
const RUN = join(ROOT, "tests/e2e/run.sh");
const LOCAL = join(ROOT, "scripts/local.sh");
const KEY_VARIABLE = "ANTHROPIC_API_KEY";
const PROBE = `leak-probe-${crypto.randomUUID()}`;

type Service = { environment?: Record<string, string | null> };
type Compose = { services: Record<string, Service> };

const compose = async (path: string) =>
  Bun.YAML.parse(await Bun.file(join(ROOT, path)).text()) as Compose;

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

describe("real-model settings", () => {
  test("its profiles call api.anthropic.com with the key from the API's environment", async () => {
    const catalog = await fixtureCatalog("real-model", {
      [KEY_VARIABLE]: PROBE,
    });
    expect(Object.keys(catalog.profiles)).toEqual(["claude-coding-real"]);
    expect(catalog.repositories["sample-app"]?.profiles).toEqual([
      "claude-coding-real",
    ]);
    expect(catalog.profiles["claude-coding-real"]?.permission_mode).toBe(
      "auto",
    );
    const profile = catalog.profiles["claude-coding-real"];
    if (profile === undefined) throw new Error("no profile");
    expect(providerUpstreamOf(profile)).toEqual({
      url: "https://api.anthropic.com",
      headers: [["x-api-key", PROBE]],
    });
    // What a worker is handed: the route and its egress token, no key.
    const worker = runtimeProviderOf(profile, "egress-token");
    expect(worker.auth).toEqual({
      kind: "egress_token",
      token: "egress-token",
    });
    expect(JSON.stringify(worker)).not.toContain(PROBE);
  });

  test("without the key the profile does not resolve", async () => {
    for (const env of [{}, { [KEY_VARIABLE]: "" }]) {
      await expect(fixtureCatalog("real-model", env)).rejects.toThrow(
        `value_env: ${KEY_VARIABLE} is not set`,
      );
    }
  });
});

describe("real-model compose layers", () => {
  test("only the API is given the key, by name and never by value", async () => {
    const files = [...LOCAL_LAYERS, "tests/e2e/compose.yml", OVERLAY];
    for (const file of files) {
      for (const [name, service] of Object.entries(
        (await compose(file)).services,
      )) {
        const env = service.environment ?? {};
        if (file === LOCAL_LAYERS[1] && name === "api") {
          expect(env[KEY_VARIABLE]).toBeNull();
        } else {
          expect(Object.hasOwn(env, KEY_VARIABLE)).toBe(false);
        }
      }
    }
  });

  test("migrate imports the real-model settings the overlay names", () => {
    const { migrate } = layeredServices<Service>([...LOCAL_LAYERS, OVERLAY]);
    expect(migrate?.environment?.SETTINGS_DOCUMENT).toBe(
      "${SETTINGS_DOCUMENT-/settings/real-model.json}",
    );
  });

  test("the proxy allows the profile's endpoint and the limits cap one run", async () => {
    const base = layeredServices<Service>(LOCAL_LAYERS);
    const overlay = (await compose(OVERLAY)).services;
    const endpoint = new URL("https://api.anthropic.com");
    const proxy = egressProxyConfigFromEnv(defaults(base["egress-proxy"]));
    // The provider route's upstream, never the forward proxy's.
    const destination = { host: endpoint.hostname, port: 443 };
    expect(proxy.credential?.allow).toContainEqual(destination);
    expect(proxy.allow).not.toContainEqual(destination);
    expect(overlay["egress-proxy"]).toBeUndefined();
    for (const name of ["api", "scheduler"]) {
      const limits = installationLimitsFromEnv(
        defaults(base[name], overlay[name]),
      );
      expect(limits.sessionCostLimitUsd).toBe(1);
      expect(limits.maxTurnSeconds).toBe(600);
    }
  });
});

describe("run.sh --real-model", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "real-model-run-"));
    const stubs = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", stubs]);
    // Answers what run.sh asks of docker, writing every argument list down.
    const docker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_ARGV"
case "$*" in
  "version --format"*) echo 28.1.0 ;;
  *" exec -T api "*) echo e2e-platform-key ;;
  *" logs --no-color worker") echo "worker-1  | 2.1.319 (Claude Code)" ;;
  *" logs --no-color --timestamps")
    echo "api-1  | listening"
    if [ -n "\${STUB_LEAK:-}" ]; then echo "api-1  | \${${KEY_VARIABLE}}"; fi ;;
  *" port api 3000") echo 127.0.0.1:40000 ;;
  *" port fake-messages 4011") echo 127.0.0.1:40001 ;;
  "image inspect"*) echo sha256:0000 ;;
esac
`;
    const bun = `#!/usr/bin/env bash
printf 'bun %s limit=%s key=%s\\n' "$*" "\${SESSION_COST_LIMIT_USD:-}" "\${${KEY_VARIABLE}:+present}" >>"$STUB_ARGV"
echo " 1 pass"
echo " 0 fail"
`;
    for (const [name, text] of [
      ["docker", docker],
      ["bun", bun],
    ] as const) {
      await Bun.write(join(stubs, name), text);
      chmodSync(join(stubs, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(
    name: string,
    env: Record<string, string>,
    args = ["--real-model"],
    bashArgs: string[] = [],
  ) {
    const out = join(dir, name);
    const argv = join(dir, `${name}.argv`);
    const result = Bun.spawnSync(["bash", ...bashArgs, RUN, ...args], {
      cwd: ROOT,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        TMPDIR: dir,
        E2E_OUT: out,
        STUB_ARGV: argv,
        AGENT_PLATFORM_DOTENV: join(dir, "no-dotenv"),
        ...env,
      },
    });
    const read = (path: string) => {
      const file = Bun.file(path);
      return file.size > 0 ? file.text() : Promise.resolve("");
    };
    return {
      status: result.exitCode,
      stderr: result.stderr.toString(),
      argv: read(argv),
      out,
    };
  }

  async function recordText(out: string): Promise<string> {
    const texts: string[] = [];
    const walk = (path: string) => {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        if (item.isDirectory()) walk(join(path, item.name));
        else if (item.isFile()) texts.push(join(path, item.name));
      }
    };
    walk(out);
    return (await Promise.all(texts.map((path) => Bun.file(path).text()))).join(
      "\n",
    );
  }

  test("stops before Docker when the key is unset or empty", async () => {
    for (const [name, env] of [
      ["unset", {}],
      ["empty", { [KEY_VARIABLE]: "" }],
    ] as const) {
      const result = run(`no-key-${name}`, env);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`${KEY_VARIABLE} is unset or empty`);
      expect(await result.argv).toBe("");
    }
    const unknown = run("bad-arg", { [KEY_VARIABLE]: PROBE }, ["--real"]);
    expect(unknown.status).toBe(2);
    expect(await unknown.argv).toBe("");
  });

  test("runs the real-model suite on the overlay without the key in any argument or record", async () => {
    const result = run("clean", { [KEY_VARIABLE]: PROBE });
    expect(result.status).toBe(0);
    const argv = await result.argv;
    expect(argv).toContain(`-f ${OVERLAY}`);
    expect(argv).toContain(
      "bun test ./tests/e2e/real-model.e2e.ts --timeout 900000",
    );
    // The suite gets no key: it drives the public API only.
    expect(argv).toMatch(/^bun test .* key=$/m);
    expect(argv).not.toContain(PROBE);
    const record = await Bun.file(join(result.out, "record.txt")).text();
    expect(record).toContain("command: tests/e2e/run.sh --real-model");
    expect(record).toContain("model: claude-sonnet-5");
    expect(record).toContain("provider_endpoint: https://api.anthropic.com");
    expect(record).toContain("session_cost_limit_usd: 1");
    // The suite compares the session's limit with the one the stack got.
    expect(argv).toMatch(/^bun test .* limit=1 key=$/m);
    expect(record).toMatch(/^tested_sha: [0-9a-f]{40} /m);
    expect(await recordText(result.out)).not.toContain(PROBE);
    expect(result.stderr).not.toContain(PROBE);
  });

  test("a limit from the shell reaches the stack, the record and the suite alike", async () => {
    const result = run("shell-limit", {
      [KEY_VARIABLE]: PROBE,
      SESSION_COST_LIMIT_USD: "3",
    });
    expect(result.status).toBe(0);
    expect(await result.argv).toMatch(/^bun test .* limit=3 key=$/m);
    const record = await Bun.file(join(result.out, "record.txt")).text();
    expect(record).toContain("session_cost_limit_usd: 3");
  });

  test("an up-only stack hands the suite its limit through vars.sh", async () => {
    const result = run("up-only", { [KEY_VARIABLE]: PROBE, E2E_UP_ONLY: "1" });
    expect(result.status).toBe(0);
    expect(await result.argv).not.toContain("bun test");
    const vars = await Bun.file(join(result.out, "vars.sh")).text();
    expect(vars).toMatch(/ SESSION_COST_LIMIT_USD="1"$/m);
    expect(vars).toMatch(/ E2E_MODEL_MODE="real"$/m);
  });

  test("takes the key from .env when the shell has none, and the shell's over it", async () => {
    const dotenv = join(dir, "dotenv-run");
    await Bun.write(dotenv, `POSTGRES_DB=other\n${KEY_VARIABLE}="${PROBE}"\n`);
    const result = run("dotenv", { AGENT_PLATFORM_DOTENV: dotenv });
    expect(result.status).toBe(0);
    expect(await result.argv).not.toContain(PROBE);
    expect(await recordText(result.out)).not.toContain(PROBE);
    expect(result.stderr).not.toContain(PROBE);
    // The leak check reads the key the run used, wherever it came from.
    const leak = run("dotenv-leak", {
      AGENT_PLATFORM_DOTENV: dotenv,
      STUB_LEAK: "1",
    });
    expect(leak.status).not.toBe(0);
    expect(leak.stderr).toContain("value is in the record");
    const empty = join(dir, "dotenv-empty");
    await Bun.write(empty, `${KEY_VARIABLE}=\n`);
    const none = run("dotenv-empty", { AGENT_PLATFORM_DOTENV: empty });
    expect(none.status).toBe(2);
    expect(await none.argv).toBe("");
  });

  test.each([
    ["crlf", `${KEY_VARIABLE}=${PROBE}\r\n`],
    ["single-quoted", `${KEY_VARIABLE}='${PROBE}'\n`],
    ["exported", `export ${KEY_VARIABLE}=${PROBE}\n`],
  ])("accepts %s dotenv syntax", async (name, contents) => {
    const dotenv = join(dir, `dotenv-run-${name}`);
    await Bun.write(dotenv, contents);
    const result = run(`dotenv-${name}`, { AGENT_PLATFORM_DOTENV: dotenv });
    expect(result.status).toBe(0);
    expect(await result.argv).not.toContain(PROBE);
    expect(result.stderr).not.toContain(PROBE);
  });

  test.each([
    ["opening", `${KEY_VARIABLE}='${PROBE}\n`],
    ["closing", `${KEY_VARIABLE}=${PROBE}'\n`],
  ])("rejects a dotenv value with only a %s quote", async (name, contents) => {
    const dotenv = join(dir, `dotenv-run-unmatched-${name}`);
    await Bun.write(dotenv, contents);
    const result = run(`dotenv-unmatched-${name}`, {
      AGENT_PLATFORM_DOTENV: dotenv,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid ANTHROPIC_API_KEY quoting");
    expect(result.stderr).not.toContain(PROBE);
    expect(await result.argv).toBe("");
  });

  test("does not expose shell or dotenv keys under xtrace", async () => {
    const dotenv = join(dir, "dotenv-run-xtrace");
    await Bun.write(dotenv, `${KEY_VARIABLE}='${PROBE}'\n`);
    for (const [name, env] of [
      ["shell", { [KEY_VARIABLE]: PROBE }],
      ["dotenv", { AGENT_PLATFORM_DOTENV: dotenv }],
    ] as const) {
      const result = run(`xtrace-${name}`, env, ["--real-model"], ["-x"]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain(PROBE);
    }
  });

  test("fails, naming the file but not the value, when the key reaches the record", async () => {
    const result = run("leak", { [KEY_VARIABLE]: PROBE, STUB_LEAK: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("value is in the record");
    expect(result.stderr).toContain(join(result.out, "compose.log"));
    expect(result.stderr).not.toContain(PROBE);
  });

  test("the scripted run keeps its suites on the fake overlay", async () => {
    const result = run("fake", { [KEY_VARIABLE]: PROBE }, []);
    expect(result.status).toBe(0);
    const argv = await result.argv;
    expect(argv).not.toContain(OVERLAY);
    expect(argv).toContain(`-f ${FAKE_MODEL}`);
    expect(argv).toContain(
      "bun test ./tests/e2e/remote-mcp.e2e.ts ./tests/e2e/operator-profiles.e2e.ts ./tests/e2e/alpha-path.e2e.ts ./tests/e2e/pause-coverage.e2e.ts ./tests/e2e/workspace-loss.e2e.ts --timeout 900000",
    );
    const record = await Bun.file(join(result.out, "record.txt")).text();
    expect(record).toContain("command: tests/e2e/run.sh\n");
    expect(record).not.toContain("model:");
  });
});

describe("local.sh up", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "real-model-local-"));
    const stubs = join(dir, "bin");
    Bun.spawnSync(["mkdir", "-p", stubs]);
    // Answers what local.sh asks of docker, writing every argument list
    // down. The stack "already publishes" every port, so the port check
    // passes whatever this machine listens on.
    const docker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_ARGV"
case "$*" in
  "version --format"*) echo 28.1.0 ;;
  "compose version --short") echo "\${STUB_COMPOSE:-2.39.1}" ;;
  *" config --format json") echo '{"name":"werft","services":{"scheduler":{"environment":{"EXECUTION_INSTALLATION_ID":"local"}}}}' ;;
  *" port api 3000") echo 127.0.0.1:3000 ;;
  "volume ls -q --filter name="*) ;;
  *" ps --format "*)
    for p in 3000 5432 4566 4567 3001; do printf '127.0.0.1:%s->%s/tcp, ' "$p" "$p"; done; echo ;;
esac
`;
    const curl = `#!/usr/bin/env bash
echo '{"status":"ready"}'
`;
    for (const [name, text] of [
      ["docker", docker],
      ["curl", curl],
    ] as const) {
      await Bun.write(join(stubs, name), text);
      chmodSync(join(stubs, name), 0o755);
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function local(
    name: string,
    args: string[],
    env: Record<string, string> = {},
    bashArgs: string[] = [],
  ) {
    const argv = join(dir, `${name}.argv`);
    const result = Bun.spawnSync(["bash", ...bashArgs, LOCAL, ...args], {
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: dir,
        STUB_ARGV: argv,
        AGENT_PLATFORM_DOTENV: join(dir, "no-dotenv"),
        ...env,
      },
    });
    const file = Bun.file(argv);
    return {
      status: result.exitCode,
      stderr: result.stderr.toString(),
      argv: file.size > 0 ? await file.text() : "",
    };
  }

  test("starts on the real-model overlay with no model connection when the key is unset or empty", async () => {
    for (const [name, env] of [
      ["unset", {}],
      ["empty", { [KEY_VARIABLE]: "" }],
    ] as const) {
      const result = await local(`no-key-up-${name}`, ["up"], env);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        "the stack starts with no model connection",
      );
      expect(result.argv).toContain(`-f ${OVERLAY} up -d --build`);
      expect(result.argv).not.toContain("compose.fake-model.yml");
    }
  });

  test("stops before Docker on an unknown argument", async () => {
    const unknown = await local("bad-arg", ["up", "--real"], {
      [KEY_VARIABLE]: PROBE,
    });
    expect(unknown.status).toBe(2);
    expect(unknown.argv).toBe("");
  });

  test("starts the default project with the overlay, the key in no argument", async () => {
    const result = await local("clean", ["up"], {
      [KEY_VARIABLE]: PROBE,
    });
    expect(result.stderr).not.toContain(PROBE);
    expect(result.status).toBe(0);
    expect(result.argv).toContain(
      `compose --profile apps -f compose.yaml -f ${OVERLAY} up -d --build`,
    );
    expect(result.argv).not.toContain(PROBE);
    expect(result.argv).not.toContain(" -p ");
  });

  test("takes the key from .env when the shell has none", async () => {
    const dotenv = join(dir, "dotenv-local");
    await Bun.write(dotenv, `${KEY_VARIABLE}=${PROBE}\n`);
    const result = await local("dotenv", ["up"], {
      AGENT_PLATFORM_DOTENV: dotenv,
    });
    expect(result.status).toBe(0);
    expect(result.argv).toContain(`-f ${OVERLAY} up -d --build`);
    expect(result.argv).not.toContain(PROBE);
    expect(result.stderr).not.toContain(PROBE);
  });

  test.each([
    ["crlf", `${KEY_VARIABLE}=${PROBE}\r\n`],
    ["single-quoted", `${KEY_VARIABLE}='${PROBE}'\n`],
    ["exported", `export ${KEY_VARIABLE}=${PROBE}\n`],
  ])("accepts %s dotenv syntax", async (name, contents) => {
    const dotenv = join(dir, `dotenv-local-${name}`);
    await Bun.write(dotenv, contents);
    const result = await local(`dotenv-${name}`, ["up"], {
      AGENT_PLATFORM_DOTENV: dotenv,
    });
    expect(result.status).toBe(0);
    expect(result.argv).not.toContain(PROBE);
    expect(result.stderr).not.toContain(PROBE);
  });

  test.each([
    ["opening", `${KEY_VARIABLE}="${PROBE}\n`],
    ["closing", `${KEY_VARIABLE}=${PROBE}"\n`],
  ])("rejects a dotenv value with only a %s quote", async (name, contents) => {
    const dotenv = join(dir, `dotenv-local-unmatched-${name}`);
    await Bun.write(dotenv, contents);
    const result = await local(`dotenv-unmatched-${name}`, ["up"], {
      AGENT_PLATFORM_DOTENV: dotenv,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid ANTHROPIC_API_KEY quoting");
    expect(result.stderr).not.toContain(PROBE);
    expect(result.argv).toBe("");
  });

  test("does not expose shell or dotenv keys under xtrace", async () => {
    const dotenv = join(dir, "dotenv-local-xtrace");
    await Bun.write(dotenv, `${KEY_VARIABLE}="${PROBE}"\n`);
    for (const [name, env] of [
      ["shell", { [KEY_VARIABLE]: PROBE }],
      ["dotenv", { AGENT_PLATFORM_DOTENV: dotenv }],
    ] as const) {
      const result = await local(`xtrace-${name}`, ["up"], env, ["-x"]);
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain(PROBE);
    }
  });

  test("refuses a compose that cannot put an overlay on the include", async () => {
    for (const verb of ["up", "reset"]) {
      const result = await local(`old-compose-${verb}`, [verb], {
        [KEY_VARIABLE]: PROBE,
        STUB_COMPOSE: "2.24.5",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `too old; ${OVERLAY} is an overlay on compose.yaml's include`,
      );
      // A reset that cannot start deletes nothing either.
      expect(result.argv).not.toMatch(/ (up -d|down)/);
    }
  });

  test("--fake-model and down add no real-model overlay", async () => {
    for (const args of [["up", "--fake-model"], ["down"]]) {
      const result = await local(`fake-${args.join("-")}`, args);
      expect(result.status).toBe(0);
      expect(result.argv).toContain("compose --profile apps ");
      expect(result.argv).not.toContain(OVERLAY);
    }
  });
});
