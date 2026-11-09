import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/local.sh against stand-ins for docker and curl: the
 * ports it checks, the /readyz it waits on and the worker label `down`
 * deletes all come from the stack compose renders, whatever
 * COMPOSE_PROJECT_NAME, COMPOSE_FILE or EXECUTION_INSTALLATION_ID made it.
 * tests/images.test.ts holds the real render to the fields read here.
 */

const script = join(import.meta.dir, "..", "scripts/local.sh");

const rendered = (
  id: string | undefined,
  ports: string[] = [],
  volumeNamespace?: string,
) =>
  JSON.stringify({
    services: {
      api: {
        ports: ports.map((published) => ({
          host_ip: "127.0.0.1",
          published,
          target: 3000,
        })),
      },
      scheduler: {
        environment: {
          ...(id === undefined ? {} : { EXECUTION_INSTALLATION_ID: id }),
          ...(volumeNamespace === undefined
            ? {}
            : { EXECUTION_VOLUME_LABEL_NAMESPACE: volumeNamespace }),
        },
      },
    },
  });

// docker inspect's NetworkSettings.Ports for an api bound as given.
const ports = (...hostIps: string[]) =>
  JSON.stringify({
    "3000/tcp": hostIps.map((HostIp, i) => ({
      HostIp,
      HostPort: String(43123 + i),
    })),
  });
const loopbackPorts = ports("127.0.0.1");

describe("scripts/local.sh", () => {
  let dir: string;
  let config: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-sh-"));
    config = join(dir, "config.json");
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh
echo "$*" >> "${dir}/docker-calls"
case "$*" in
  "version --format"*) echo 28.1.0 ;;
  "compose version --short") echo 2.39.1 ;;
  *" config --format json") jq --arg n "\${COMPOSE_PROJECT_NAME:-\${STUB_PROJECT:-werft}}" '. + {name: $n}' "${config}" ;;
  *" port api 3000") [ -z "$STUB_API" ] || echo "$STUB_API" ;;
  *" ps --format "*) echo "$STUB_OURS" ;;
  *" ps -aq egress-proxy")
    [ -z "$STUB_PROXY" ] || echo "$STUB_PROXY"
    exit "\${STUB_PROXY_EXIT:-0}" ;;
  *" ps -q api") echo "$STUB_API_ID" ;;
  "inspect --format {{json .NetworkSettings.Ports}} "*) echo "$STUB_PORTS" ;;
  "inspect --format "*) echo "$STUB_STARTED_ID" ;;
  *" down -v --remove-orphans") exit "\${STUB_DOWN_EXIT:-0}" ;;
  "ps -aq --filter label="*) echo "$STUB_WORKERS" ;;
  "network ls -q --filter label="*) echo "$STUB_NETWORKS" ;;
  "volume ls -q --filter label="*) echo "$STUB_VOLUMES" ;;
  "volume ls -q --filter name="*) echo "$STUB_PG_VOLUME"; exit "\${STUB_VOLUME_LS_EXIT:-0}" ;;
  "context inspect --format "*) echo "$STUB_CONTEXT" ;;
  *" exec -T -e DEMO_ACCOUNTS=local api bun run apps/control-host/src/api/demo-data.ts") exit "\${STUB_DATA_EXIT:-0}" ;;
  *" exec -T -e DEMO_ACCOUNTS=local api "*) exit "\${STUB_SEED_EXIT:-0}" ;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "bin", "curl"),
      `#!/bin/sh
for a; do url=$a; done
echo "$url" >> "${dir}/curl-calls"
echo '{"status":"ready"}'
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function run(args: string[], env: Record<string, string> = {}) {
    const handle = Bun.spawn(["bash", script, ...args], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        COMPOSE_FILE: "",
        ANTHROPIC_API_KEY: "",
        AGENT_PLATFORM_DOTENV: join(dir, "no.env"),
        AGENT_PLATFORM_STATE_DIR: join(dir, "state"),
        STUB_API: "",
        STUB_OURS: "",
        STUB_PROXY: "",
        STUB_STARTED_ID: "",
        STUB_CONTEXT: "unix:///var/run/docker.sock",
        STUB_API_ID: "api-id",
        STUB_PORTS: loopbackPorts,
        STUB_WORKERS: "",
        STUB_NETWORKS: "",
        STUB_VOLUMES: "",
        STUB_PG_VOLUME: "",
        LOCAL_DEMO_ACCOUNTS: "",
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
      new Response(handle.stdout).text(),
    ]);
    return { exitCode, stderr, stdout };
  }

  const calls = async (name: string) =>
    (await readFile(join(dir, name), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);

  // status, down and key take no mode, so they see a --fake-model stack too.
  const noMode = "compose --profile apps --profile fake-model";
  const realUp =
    "compose --profile apps -f compose.yaml -f infra/compose.real-model.yml up -d --build";
  const key = { ANTHROPIC_API_KEY: "sk-test" };

  const deletions = (id: string) => [
    `${noMode} down -v --remove-orphans`,
    `ps -aq --filter label=werft.installation=${id}`,
    `network ls -q --filter label=werft.installation=${id}`,
    `volume ls -q --filter label=werft.installation=${id}`,
  ];

  test("parses as bash", () => {
    expect(Bun.spawnSync(["bash", "-n", script]).exitCode).toBe(0);
  });

  test("down deletes the workers of the id the running stack was started with", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["down"], {
      STUB_PROXY: "proxy-id",
      STUB_STARTED_ID: "ap434local",
    });
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toEqual([
      `${noMode} ps -aq egress-proxy`,
      'inspect --format {{index .Config.Labels "werft.egress-proxy"}} proxy-id',
      `${noMode} config --format json`,
      ...deletions("ap434local"),
    ]);
  });

  test.each(["local", "ap434local"])(
    "with no container left, down deletes the workers of the id compose renders: %p",
    async (id) => {
      await writeFile(config, rendered(id));
      const result = await run(["down"]);
      expect(result.exitCode).toBe(0);
      expect(await calls("docker-calls")).toEqual([
        `${noMode} ps -aq egress-proxy`,
        `${noMode} config --format json`,
        `${noMode} config --format json`,
        ...deletions(id),
      ]);
    },
  );

  test("down finds the workspace volumes by the scheduler's rendered volume label prefix, not the shell's, and the workers by the fixed one", async () => {
    await writeFile(config, rendered("local", [], "other-ns"));
    const result = await run(["down"]);
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toEqual([
      `${noMode} ps -aq egress-proxy`,
      `${noMode} config --format json`,
      `${noMode} config --format json`,
      ...deletions("local").slice(0, 3),
      "volume ls -q --filter label=other-ns.installation=local",
    ]);
  });

  test("down --keep-volumes deletes the workers and their networks, and no volume", async () => {
    await writeFile(config, rendered("local"));
    const workers = {
      STUB_PROXY: "proxy-id",
      STUB_STARTED_ID: "ap434local",
      STUB_WORKERS: "worker-1\nworker-2",
      STUB_NETWORKS: "net-1\nnet-2",
      STUB_VOLUMES: "ws-1",
    };

    const kept = await run(["down", "--keep-volumes"], workers);
    expect(kept.exitCode).toBe(0);
    expect(kept.stderr).toContain("volumes and checkpoint objects kept");
    expect(kept.stderr).not.toContain("checkpoint objects lost");
    expect(await calls("docker-calls")).toEqual([
      `${noMode} ps -aq egress-proxy`,
      'inspect --format {{index .Config.Labels "werft.egress-proxy"}} proxy-id',
      `${noMode} down --remove-orphans`,
      "ps -aq --filter label=werft.installation=ap434local",
      "rm -f worker-1 worker-2",
      "network ls -q --filter label=werft.installation=ap434local",
      "network rm net-1 net-2",
    ]);

    // Plain down still deletes the volumes too.
    await rm(join(dir, "docker-calls"));
    expect((await run(["down"], workers)).exitCode).toBe(0);
    expect(await calls("docker-calls")).toContain("volume rm ws-1");
  });

  test("down refuses any other argument without calling docker", async () => {
    const result = await run(["down", "-v"]);
    expect(result.exitCode).toBe(2);
    expect(await calls("docker-calls")).toEqual([]);
  });

  test("down deletes nothing when it cannot tell the installation", async () => {
    for (const [text, env] of [
      [undefined, {}],
      [rendered(undefined), {}],
      [rendered("local"), { STUB_PROXY: "proxy-id" }],
      // Not "no container left": the render may name another installation.
      [rendered("local"), { STUB_PROXY_EXIT: "1" }],
    ] as const) {
      await rm(config, { force: true });
      if (text !== undefined) await writeFile(config, text);
      for (const mode of [[], ["--keep-volumes"]]) {
        const result = await run(["down", ...mode], env);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "cannot tell the stack's EXECUTION_INSTALLATION_ID; nothing was deleted",
        );
      }
    }
    expect(
      (await calls("docker-calls")).filter((call) =>
        / (down|rm|ls) /.test(call),
      ),
    ).toEqual([]);
  });

  test("reset stops when down fails", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["reset"], {
      ...key,
      STUB_API: "127.0.0.1:43123",
      STUB_DOWN_EXIT: "1",
    });
    expect(result.exitCode).not.toBe(0);
    const docker = await calls("docker-calls");
    expect(docker).toContain(`${noMode} down -v --remove-orphans`);
    expect(docker).not.toContain(realUp);
    expect(result.stderr).not.toContain("local.sh: deleted");
  });

  test("forget-lost-checkpoints runs its CLI in a one-off api container and deletes nothing", async () => {
    const result = await run(["forget-lost-checkpoints"]);
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toEqual([
      `${noMode} run --rm -T --build api bun run apps/control-host/src/api/forget-lost-checkpoints.ts`,
    ]);
  });

  test("up and status read /readyz where compose publishes the api", async () => {
    await writeFile(config, rendered("local"));
    const up = await run(["up"], { ...key, STUB_API: "127.0.0.1:43123" });
    expect(up).toMatchObject({ exitCode: 0, stdout: '{"status":"ready"}\n' });
    const status = await run(["status"], { STUB_API: "0.0.0.0:43124" });
    expect(status.stdout).toContain('readyz: {"status":"ready"}');
    expect(await calls("curl-calls")).toEqual([
      "http://127.0.0.1:43123/readyz",
      "http://127.0.0.1:43124/readyz",
    ]);

    const stopped = await run(["status"]);
    expect(stopped.stdout).toContain("readyz: \n");
    expect(await calls("curl-calls")).toHaveLength(2);
  });

  test.each([
    [[], key, "infra/compose.real-model.yml"],
    [["--fake-model"], {}, "infra/compose.fake-model.yml"],
  ] as const)(
    "up %p puts its overlay on top of COMPOSE_FILE's files",
    async (mode, env, overlay) => {
      await writeFile(config, rendered("local"));
      const result = await run(["up", ...mode], {
        ...env,
        COMPOSE_FILE: "compose.yaml:ports.yml",
        STUB_API: "127.0.0.1:43123",
      });
      expect(result.exitCode).toBe(0);
      expect(await calls("docker-calls")).toContain(
        `compose --profile apps -f compose.yaml -f ports.yml -f ${overlay} up -d --build`,
      );
    },
  );

  const seed = (prefix: string) =>
    `${prefix} exec -T -e DEMO_ACCOUNTS=local api bun run apps/control-host/src/api/demo-accounts.ts`;
  const data = (prefix: string) =>
    `${prefix} exec -T -e DEMO_ACCOUNTS=local api bun run apps/control-host/src/api/demo-data.ts`;
  const fakeUp =
    "compose --profile apps -f compose.yaml -f infra/compose.fake-model.yml";

  test("up adds the demo accounts and then their data once the api is ready, and stdout stays /readyz", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '{"status":"ready"}\n',
    });
    const docker = await calls("docker-calls");
    expect(docker.slice(-2)).toEqual([seed(fakeUp), data(fakeUp)]);
    expect(docker).toContain(`${fakeUp} up -d --build`);
  });

  test("LOCAL_DEMO_DATA=0 adds the accounts alone", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
      LOCAL_DEMO_DATA: "0",
    });
    expect(result.exitCode).toBe(0);
    const docker = await calls("docker-calls");
    expect(docker.at(-1)).toBe(seed(fakeUp));
    expect(docker).not.toContain(data(fakeUp));
  });

  test("a refused data seed, as on a real-model stack, still ends up", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
      STUB_DATA_EXIT: "2",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '{"status":"ready"}\n',
    });
    expect(result.stderr).toContain("local.sh: demo data not added");
  });

  test("a failed data seed fails up and says the accounts are up", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
      STUB_DATA_EXIT: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "adding the demo data failed; the stack and the demo accounts are up",
    );
    expect(result.stdout).toBe("");
  });

  test("demo-accounts adds them to a running stack of either mode", async () => {
    const result = await run(["demo-accounts"], { STUB_PORTS: ports("::1") });
    expect(result.exitCode).toBe(0);
    const docker = await calls("docker-calls");
    expect(docker).toContain(`${noMode} ps -q api`);
    expect(docker).toContain(seed(noMode));
    expect(docker).toContain(data(noMode));
  });

  test.each([
    [{ LOCAL_DEMO_ACCOUNTS: "0" }, ""],
    [
      { STUB_PORTS: ports("0.0.0.0") },
      "demo accounts not added: the api listens on 0.0.0.0, not loopback alone",
    ],
    [
      { STUB_PORTS: ports("") },
      "demo accounts not added: the api listens on 0.0.0.0, not loopback alone",
    ],
    [
      { STUB_PORTS: ports("127.0.0.1", "192.168.1.5") },
      "demo accounts not added: the api listens on 192.168.1.5, not loopback alone",
    ],
    [
      { STUB_PORTS: '{"3000/tcp":null}' },
      "demo accounts not added: the api publishes no port",
    ],
    [{ STUB_API_ID: "" }, "demo accounts not added: the api is not running"],
    [
      { STUB_CONTEXT: "tcp://10.0.0.5:2376" },
      "demo accounts not added: Docker is not this machine's (tcp://10.0.0.5:2376)",
    ],
    [
      { STUB_CONTEXT: "ssh://dev@build-host" },
      "demo accounts not added: Docker is not this machine's (ssh://dev@build-host)",
    ],
  ])("up leaves the demo accounts out for %p", async (vars, message) => {
    await writeFile(config, rendered("local"));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
      ...vars,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(message);
    const docker = await calls("docker-calls");
    expect(docker).not.toContain(seed(fakeUp));
    expect(docker).not.toContain(data(fakeUp));
  });

  test("a failed seed fails up and says the stack is up", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["up", "--fake-model"], {
      STUB_API: "127.0.0.1:43123",
      STUB_SEED_EXIT: "2",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "adding the demo accounts failed; the stack itself is up",
    );
    expect(result.stdout).toBe("");
  });

  test.each([
    [
      "",
      "compose.yaml -f infra/compose.fake-model.yml -f infra/compose.dev.yml",
    ],
    // A verify run's COMPOSE_FILE already names it: a second copy would change
    // nothing, and is left out.
    [
      "/repo/compose.yaml:/run/ports.yml:/repo/infra/compose.dev.yml",
      "/repo/compose.yaml -f /run/ports.yml -f /repo/infra/compose.dev.yml -f infra/compose.fake-model.yml",
    ],
  ])(
    "dev --fake-model over COMPOSE_FILE %p starts the stack with the dev overlay once",
    async (composeFile, files) => {
      await writeFile(config, rendered("local"));
      const result = await run(["dev", "--fake-model"], {
        COMPOSE_FILE: composeFile,
        STUB_API: "127.0.0.1:43123",
        LOCAL_DEMO_ACCOUNTS: "0",
      });
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: '{"status":"ready"}\n',
      });
      expect(await calls("docker-calls")).toContain(
        `compose --profile apps -f ${files} up -d --build`,
      );
    },
  );

  test("web runs the Vite dev server against the published api, and nothing without one", async () => {
    await writeFile(
      join(dir, "bin", "bun"),
      `#!/bin/sh
echo "$VITE_API_TARGET $*" >> "${dir}/bun-calls"
`,
      { mode: 0o755 },
    );
    const none = await run(["web"]);
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain("start the stack first");
    expect(await calls("bun-calls")).toEqual([]);

    const result = await run(["web"], { STUB_API: "0.0.0.0:43125" });
    expect(result.exitCode).toBe(0);
    expect(await calls("bun-calls")).toEqual([
      "http://127.0.0.1:43125 run --cwd apps/web dev",
    ]);
  });

  test("up without a key starts the real-model stack with no connection and names the console path", async () => {
    await writeFile(config, rendered("local"));
    const result = await run(["up"], { STUB_API: "127.0.0.1:43123" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "the stack starts with no model connection (not the fake). Add the key in the console: 설정 > 에이전트 연결 > 모델 연결 > 연결 추가",
    );
    const started = await calls("docker-calls");
    expect(started).toContain(realUp);
    expect(started.join("\n")).not.toContain("compose.fake-model.yml");
  });

  test("an unreadable .env key line still stops up before Docker", async () => {
    await writeFile(config, rendered("local"));
    const dotenv = join(dir, "bad.env");
    await writeFile(dotenv, "ANTHROPIC_API_KEY='unterminated\n");
    for (const command of ["up", "reset", "dev"]) {
      const result = await run([command], { AGENT_PLATFORM_DOTENV: dotenv });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("invalid ANTHROPIC_API_KEY quoting");
    }
    expect(await calls("docker-calls")).toEqual([]);
  });

  test("the key comes from .env when the shell has none", async () => {
    await writeFile(config, rendered("local"));
    const dotenv = join(dir, "key.env");
    await writeFile(dotenv, "ANTHROPIC_API_KEY='sk-from-dotenv'\n");
    const result = await run(["up"], {
      AGENT_PLATFORM_DOTENV: dotenv,
      STUB_API: "127.0.0.1:43123",
    });
    expect(result.exitCode).toBe(0);
    expect(await calls("docker-calls")).toContain(realUp);
  });

  test("up makes one master key per project, unless the shell or .env has one", async () => {
    await writeFile(config, rendered("local"));
    const state = join(dir, "key-state");
    const file = join(state, "ap-key.secret-key");
    const env = {
      AGENT_PLATFORM_STATE_DIR: state,
      COMPOSE_PROJECT_NAME: "ap-key",
      PLATFORM_SECRET_KEY: "",
      STUB_API: "127.0.0.1:43123",
    };
    expect((await run(["up", "--fake-model"], env)).exitCode).toBe(0);
    const made = await readFile(file, "utf8");
    expect(made).toMatch(/^[0-9a-f]{64}\n$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await run(["up", "--fake-model"], env)).exitCode).toBe(0);
    expect(await readFile(file, "utf8")).toBe(made);

    const other = { ...env, COMPOSE_PROJECT_NAME: "ap-given" };
    const given = join(state, "ap-given.secret-key");
    await run(["up", "--fake-model"], {
      ...other,
      PLATFORM_SECRET_KEY: "1".repeat(64),
    });
    const dotenv = join(dir, "master.env");
    await writeFile(dotenv, `PLATFORM_SECRET_KEY=${"2".repeat(64)}\n`);
    await run(["up", "--fake-model"], {
      ...other,
      AGENT_PLATFORM_DOTENV: dotenv,
    });
    expect(await stat(given).catch(() => null)).toBeNull();
  });

  describe("a project whose database volume exists but whose key file does not", () => {
    const keyEnv = () => {
      const state = join(dir, "lost-key-state");
      return {
        state,
        env: {
          AGENT_PLATFORM_STATE_DIR: state,
          COMPOSE_PROJECT_NAME: "ap-lost",
          PLATFORM_SECRET_KEY: "",
          STUB_API: "127.0.0.1:43123",
        },
      };
    };

    test.each(["up", "dev", "reset"])(
      "%s makes no key and starts nothing",
      async (command) => {
        await writeFile(config, rendered("local"));
        const { state, env } = keyEnv();
        const result = await run([command, "--fake-model"], {
          ...env,
          STUB_PG_VOLUME: "ap-lost_postgres-data",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "the volume ap-lost_postgres-data exists",
        );
        expect(result.stderr).toContain("nothing was started");
        expect(await stat(state).catch(() => null)).toBeNull();
        // reset must stop before its down deletes the volume.
        const docker = await calls("docker-calls");
        expect(docker.at(-1)).toBe(
          "volume ls -q --filter name=^ap-lost_postgres-data$",
        );
        expect(docker.filter((call) => / (up|down)\b/.test(call))).toEqual([]);
      },
    );

    test("an existing key file or a given key goes on, and the default project is werft", async () => {
      await writeFile(config, rendered("local"));
      const { state, env } = keyEnv();
      await mkdir(state, { recursive: true });
      await writeFile(join(state, "ap-lost.secret-key"), `${"3".repeat(64)}\n`);
      const withFile = await run(["up", "--fake-model"], {
        ...env,
        STUB_PG_VOLUME: "ap-lost_postgres-data",
      });
      expect(withFile.exitCode).toBe(0);

      const given = await run(["up", "--fake-model"], {
        ...env,
        COMPOSE_PROJECT_NAME: "ap-other",
        PLATFORM_SECRET_KEY: "4".repeat(64),
        STUB_PG_VOLUME: "ap-other_postgres-data",
      });
      expect(given.exitCode).toBe(0);

      const fresh = await run(["up", "--fake-model"], {
        ...env,
        COMPOSE_PROJECT_NAME: "",
      });
      expect(fresh.exitCode).toBe(0);
      expect(await readFile(join(state, "werft.secret-key"), "utf8")).toMatch(
        /^[0-9a-f]{64}\n$/,
      );
      expect(await calls("docker-calls")).toContain(
        "volume ls -q --filter name=^werft_postgres-data$",
      );
    });

    test("the project is the one compose renders, not the shell's variable", async () => {
      await writeFile(config, rendered("local"));
      const { state, env } = keyEnv();
      const result = await run(["up", "--fake-model"], {
        ...env,
        COMPOSE_PROJECT_NAME: "",
        STUB_PROJECT: "from-dotenv",
        STUB_PG_VOLUME: "from-dotenv_postgres-data",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(join(state, "from-dotenv.secret-key"));
      expect(await stat(state).catch(() => null)).toBeNull();
    });

    test("a volume listing that fails makes no key", async () => {
      await writeFile(config, rendered("local"));
      const { state, env } = keyEnv();
      const result = await run(["up", "--fake-model"], {
        ...env,
        STUB_VOLUME_LS_EXIT: "1",
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("cannot check for the volume");
      expect(await stat(state).catch(() => null)).toBeNull();
    });
  });

  test("up refuses a rendered port another listener holds, not one its stack does", async () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const port = String(listener.port);
      await writeFile(config, rendered("local", [port]));
      const busy = await run(["up"], { ...key, STUB_API: `127.0.0.1:${port}` });
      expect(busy.exitCode).toBe(1);
      expect(busy.stderr).toContain(`port(s) 127.0.0.1:${port} already in use`);
      expect(await calls("docker-calls")).not.toContainEqual(realUp);

      const elsewhere = await run(["up"], {
        ...key,
        STUB_API: `127.0.0.1:${port}`,
        STUB_OURS: `0.0.0.0:${port}->3000/tcp`,
      });
      expect(elsewhere.exitCode).toBe(1);

      const ours = await run(["up"], {
        ...key,
        STUB_API: `127.0.0.1:${port}`,
        STUB_OURS: `127.0.0.1:${port}->3000/tcp`,
      });
      expect(ours.exitCode).toBe(0);
    } finally {
      listener.stop(true);
    }
  });
});

/**
 * scripts/k8s-api.sh against a kubectl stand-in: the Deployment it execs into
 * follows the chart's fullname rule, and only the three operator CLIs run.
 * It shares this file with local.sh, the other operator wrapper, because the
 * CI integration matrix assigns test files by name.
 */

const k8sApiScript = join(import.meta.dir, "..", "scripts/k8s-api.sh");

describe("scripts/k8s-api.sh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "k8s-api-sh-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "kubectl"),
      `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/kubectl-args"
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawnSync([k8sApiScript, ...args], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...env },
      stderr: "pipe",
    });
  const kubectlArgs = async () =>
    (await readFile(join(dir, "kubectl-args"), "utf8")).trimEnd().split("\n");

  test("execs the CLI in the default release's api Deployment", async () => {
    const result = run([
      "keys",
      "create",
      "team a",
      "--scopes",
      "sessions:read",
    ]);
    expect(result.exitCode).toBe(0);
    expect(await kubectlArgs()).toEqual([
      "-n",
      "werft",
      "exec",
      "deploy/werft-api",
      "-i",
      "-c",
      "api",
      "--",
      "bun",
      "run",
      "apps/control-host/src/api/keys.ts",
      "create",
      "team a",
      "--scopes",
      "sessions:read",
    ]);
  });

  test("follows the chart's fullname for another release and namespace", async () => {
    expect(
      run(["settings", "export"], { NAMESPACE: "ap", RELEASE: "prod" })
        .exitCode,
    ).toBe(0);
    const args = await kubectlArgs();
    expect(args.slice(0, 5)).toEqual([
      "-n",
      "ap",
      "exec",
      "deploy/prod-werft-api",
      "-i",
    ]);
    expect(args).toContain("apps/control-host/src/api/settings.ts");

    run(["grants", "revoke", "x"], { RELEASE: "werft-blue" });
    expect((await kubectlArgs())[3]).toBe("deploy/werft-blue-api");
  });

  test("truncates the fullname to 50 characters like the chart", async () => {
    // 45 + "-werft" = 51, one over.
    run(["keys", "revoke", "x"], { RELEASE: "r".repeat(45) });
    expect((await kubectlArgs())[3]).toBe(`deploy/${"r".repeat(45)}-werf-api`);

    run(["keys", "revoke", "x"], { RELEASE: "r".repeat(44) });
    expect((await kubectlArgs())[3]).toBe(`deploy/${"r".repeat(44)}-werft-api`);

    run(["keys", "revoke", "x"], { RELEASE: `${"r".repeat(49)}-x` });
    expect((await kubectlArgs())[3]).toBe(`deploy/${"r".repeat(49)}-api`);
  });

  test("refuses any other CLI without calling kubectl", async () => {
    for (const args of [[], ["checkpoint-gc"], ["../keys"]]) {
      const result = run(args);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("usage:");
    }
    expect(await Bun.file(join(dir, "kubectl-args")).exists()).toBe(false);
  });
});

/**
 * The verify-werft skill's down.sh, which tears its run's stack
 * down through local.sh, against the same kind of docker stand-in.
 */
describe("verify-werft down.sh", () => {
  const repo = join(import.meta.dir, "..");
  const downSh = join(repo, ".claude/skills/verify-werft/scripts/down.sh");
  const project = "verify-ap-20261025-000000-1";
  let dir: string;
  let runDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "down-sh-"));
    runDir = join(dir, "runs", "20261025-000000-1");
    await mkdir(join(dir, "bin"));
    await mkdir(join(runDir, "evidence"), { recursive: true });
    await writeFile(join(runDir, "ports.yml"), "services: {}\n");
    await writeFile(
      join(runDir, "state.env"),
      [
        `VERIFY_REPO=${repo}`,
        `export COMPOSE_PROJECT_NAME=${project}`,
        `export EXECUTION_INSTALLATION_ID=${project}`,
        `export COMPOSE_FILE=${repo}/compose.yaml:${runDir}/ports.yml`,
        `export API_IMAGE=werft-control-host:${project}`,
        `export WORKER_IMAGE=werft-worker:${project}`,
        `export EGRESS_PROXY_IMAGE=werft-egress-proxy:${project}`,
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh
echo "$*" >> "${dir}/docker-calls"
case "$*" in
  *" config --format json") echo '{"services":{"scheduler":{"environment":{"EXECUTION_INSTALLATION_ID":"${project}"}}}}' ;;
  "ps -aq --filter label="*) [ -e "${dir}/worker-gone" ] || echo "worker-1" ;;
  "rm "*) touch "${dir}/worker-gone" ;;
  "network ls -q --filter label="*) echo "net-1" ;;
  "volume ls -q --filter label="*) [ -e "${dir}/ws-gone" ] || echo "ws-1" ;;
  "volume rm ws-1") touch "${dir}/ws-gone" ;;
  "network ls --filter label=werft.installation="*)
    echo "$STUB_LEFT_NETWORK"
    exit "\${STUB_LEFT_EXIT:-0}" ;;
esac
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function down(args: string[], env: Record<string, string> = {}) {
    const handle = Bun.spawn(["bash", downSh, runDir, ...args], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        STUB_LEFT_NETWORK: "",
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    const calls = (
      await readFile(join(dir, "docker-calls"), "utf8").catch(() => "")
    )
      .split("\n")
      .filter(Boolean);
    return { exitCode, stderr, calls };
  }

  const composeDowns = (calls: string[]) =>
    calls.filter((call) => / down( |$)/.test(call));

  test("--keep-volumes deletes the workers and their networks, keeps every volume and the run", async () => {
    const { exitCode, calls } = await down(["--keep-volumes"]);

    expect(exitCode).toBe(0);
    expect(composeDowns(calls)).toEqual([
      "compose --profile apps --profile fake-model down --remove-orphans",
      `compose --profile apps --profile fake-model -f compose.yaml -f ${runDir}/ports.yml -f infra/compose.fake-model.yml down --remove-orphans --rmi local`,
    ]);
    expect(calls).toContain("rm -f worker-1");
    expect(calls).toContain("network rm net-1");
    // Listing volumes is how down.sh records the anonymous ones for the next
    // pass; only removing them is forbidden here.
    expect(calls.filter((call) => call.startsWith("volume rm"))).toEqual([]);
    expect(calls.filter((call) => /^rm -v/.test(call))).toEqual([]);
    expect(await Bun.file(join(runDir, "ports.yml")).exists()).toBe(true);
  });

  test("without it the volumes go too, and so does the run's ports.yml", async () => {
    const { exitCode, calls } = await down([]);

    expect(exitCode).toBe(0);
    expect(composeDowns(calls)).toEqual([
      "compose --profile apps --profile fake-model down -v --remove-orphans",
      `compose --profile apps --profile fake-model -f compose.yaml -f ${runDir}/ports.yml -f infra/compose.fake-model.yml down --remove-orphans --rmi local -v`,
    ]);
    expect(calls).toContain("volume rm ws-1");
    expect(await Bun.file(join(runDir, "ports.yml")).exists()).toBe(false);
  });

  test("a network left behind fails the teardown and keeps the run", async () => {
    const left = `ap-net-${project}-exec-1-g1`;
    const { exitCode, stderr } = await down(["--keep-volumes"], {
      STUB_LEFT_NETWORK: left,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `containers, networks or volumes left (above); ports.yml kept, rerun down.sh ${runDir} --keep-volumes`,
    );
    expect(
      await readFile(join(runDir, "evidence/leftovers.txt"), "utf8"),
    ).toContain(left);
    expect(await Bun.file(join(runDir, "ports.yml")).exists()).toBe(true);
  });

  test("a failed leftover check keeps the run and asks for the same mode again", async () => {
    const { exitCode, stderr } = await down(["--keep-volumes"], {
      STUB_LEFT_EXIT: "1",
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(`rerun down.sh ${runDir} --keep-volumes\n`);
    expect(await Bun.file(join(runDir, "ports.yml")).exists()).toBe(true);
  });

  test("refuses any other or extra argument without calling docker", async () => {
    for (const args of [["-v"], ["--keep-volumes", "-v"]]) {
      const { exitCode, calls } = await down(args);

      expect(exitCode).toBe(2);
      expect(calls).toEqual([]);
    }
  });
});
