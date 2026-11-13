import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs next to the verify skill's scripts
import { parseRunState } from "../.claude/skills/verify-werft/scripts/run-state.mjs";

/**
 * The verify-werft skill's up.sh and its address pool check against
 * a stand-in for docker: what the daemon reports as its pools and networks.
 */

const scripts = join(
  import.meta.dir,
  "..",
  ".claude/skills/verify-werft/scripts",
);

// OrbStack's shape: every pool a single /24.
const orbstackPools = (n: number) => [
  ...Array.from({ length: n }, (_, i) => ({
    Base: `192.168.${100 + i}.0/24`,
    Size: 24,
  })),
  { Base: "fd07:b51a:cc66:d000::/56", Size: 64 },
];

const network = (
  name: string,
  subnets: string[],
  labels: Record<string, string> = {},
) => ({
  Name: name,
  Labels: labels,
  IPAM: { Config: subnets.map((Subnet) => ({ Subnet })) },
});

describe("verify-werft up.sh and address-pool.sh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-stack-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh
echo "$*" >> "${dir}/docker-calls"
case "$*" in
  "info --format {{json .DefaultAddressPools}}") echo "$STUB_POOLS" ;;
  "network ls -q") [ -z "$STUB_IDS" ] || echo "$STUB_IDS" ;;
  "network inspect "*)
    # STUB_INSPECT_FAILS: how many inspects fail first, as when a network goes.
    n=$(cat "${dir}/inspects" 2>/dev/null || echo 0)
    echo $((n + 1)) > "${dir}/inspects"
    [ "$n" -ge "\${STUB_INSPECT_FAILS:-0}" ] || exit 1
    echo "$STUB_NETWORKS" ;;
  "version "*) echo "$EXECUTION_SLOT_LIMIT" >> "${dir}/slot-limits"; exit 1 ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function run(
    script: string,
    args: string[],
    stub: { pools: unknown; networks: ReturnType<typeof network>[] },
    env: Record<string, string> = {},
  ) {
    const handle = Bun.spawn(["bash", join(scripts, script), ...args], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        VERIFY_AP_ROOT: join(dir, "runs"),
        VERIFY_SLOT_LIMIT: "",
        VERIFY_DEMO_ACCOUNTS: "",
        VERIFY_CONSOLE_PORT: "",
        VERIFY_STATE_VARS: "",
        STUB_POOLS: JSON.stringify(stub.pools),
        STUB_IDS: stub.networks.map((_, i) => `id${i}`).join("\n"),
        STUB_NETWORKS: JSON.stringify(stub.networks),
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    return { exitCode, stderr };
  }

  const dockerCalls = async () =>
    (
      await Bun.file(join(dir, "docker-calls"))
        .text()
        .catch(() => "")
    )
      .split("\n")
      .filter(Boolean);

  const runs = async () => readdir(join(dir, "runs")).catch(() => []);

  const busy = [
    network("bridge", ["192.168.100.0/24"]),
    network("verify-ap-a_default", ["192.168.101.0/24"], {
      "com.docker.compose.project": "verify-ap-a",
    }),
    ...[102, 103, 104].map((octet) =>
      network(
        `ap-net-verify-ap-a-exec-${octet}-g1`,
        [`192.168.${octet}.0/24`],
        {
          "werft.installation": "verify-ap-a",
        },
      ),
    ),
    network("kind", ["fc00:f853:ccd:e793::/64", "192.168.105.0/24"]),
    network("outside", ["10.9.0.0/24"]),
    network("host", []),
  ];

  test("both scripts parse as bash", () => {
    for (const script of ["up.sh", "address-pool.sh"]) {
      expect(
        Bun.spawnSync(["bash", "-n", join(scripts, script)]).exitCode,
      ).toBe(0);
    }
  });

  test("a pool with room passes and says how much is left", async () => {
    const { exitCode, stderr } = await run("address-pool.sh", ["4"], {
      pools: orbstackPools(10),
      networks: busy,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain("4 free of 10, 4 needed");
  });

  test("a short pool fails with the counts and the networks by project or installation, reading only", async () => {
    const { exitCode, stderr } = await run("address-pool.sh", ["5"], {
      pools: orbstackPools(10),
      networks: busy,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "Docker's address pools are short: 4 free of 10, 5 needed",
    );
    expect(stderr).toContain("  4\tverify-ap-a\n");
    expect(stderr).toContain("  1\tbridge\n");
    expect(stderr).toContain("  1\tkind\n");
    expect(stderr).not.toContain("outside");
    expect(await dockerCalls()).toEqual([
      "info --format {{json .DefaultAddressPools}}",
      "network ls -q",
      `network inspect ${busy.map((_, i) => `id${i}`).join(" ")}`,
    ]);
  });

  test("a pool wider than its size holds 2^(size - prefix) networks", async () => {
    const pools = [
      { Base: "172.17.0.0/16", Size: 16 },
      { Base: "192.168.0.0/16", Size: 20 },
    ];
    const networks = [
      network("bridge", ["172.17.0.0/16"]),
      network("a_default", ["192.168.0.0/20"]),
      // A subnet given by hand, wider than the pool's size: two entries.
      network("wide", ["192.168.32.0/19"]),
    ];

    expect(
      (await run("address-pool.sh", ["13"], { pools, networks })).stderr,
    ).toContain("13 free of 17, 13 needed");
    expect(
      (await run("address-pool.sh", ["14"], { pools, networks })).exitCode,
    ).toBe(1);
  });

  test("a pool entry is taken once however many subnets share it, and every entry a wide subnet covers", async () => {
    const pools = [{ Base: "192.168.0.0/16", Size: 24 }];
    const halves = [
      network("a", ["192.168.0.0/25"], {
        "com.docker.compose.project": "p",
      }),
      network("b", ["192.168.0.128/25"], {
        "com.docker.compose.project": "p",
      }),
    ];
    const short = await run("address-pool.sh", ["256"], {
      pools,
      networks: halves,
    });
    expect(short.stderr).toContain("255 free of 256, 256 needed");
    expect(short.stderr).toContain("  1\tp\n");

    const covering = await run("address-pool.sh", ["1"], {
      pools,
      networks: [network("all", ["192.168.0.0/15"])],
    });
    expect(covering.exitCode).toBe(1);
    expect(covering.stderr).toContain("0 free of 256, 1 needed");
  });

  test("a daemon that reports no pool is checked against Docker's built-in ones", async () => {
    const networks = [
      network("bridge", ["172.17.0.0/16"]),
      network("a_default", ["192.168.0.0/20"]),
    ];

    for (const pools of [null, []]) {
      const { exitCode, stderr } = await run("address-pool.sh", ["29"], {
        pools,
        networks,
      });
      expect(exitCode).toBe(0);
      expect(stderr).toContain("29 free of 31, 29 needed");
    }
  });

  test("IPv6 pools alone leave no room", async () => {
    const { exitCode, stderr } = await run("address-pool.sh", ["1"], {
      pools: [{ Base: "fd07:b51a:cc66:d000::/56", Size: 64 }],
      networks: [],
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("0 free of 0, 1 needed");
  });

  test("a network gone between the listing and the inspect is read again", async () => {
    const { exitCode, stderr } = await run(
      "address-pool.sh",
      ["4"],
      { pools: orbstackPools(10), networks: busy },
      { STUB_INSPECT_FAILS: "1" },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toContain("4 free of 10, 4 needed");
  });

  test("Docker that cannot be read is not a short pool, for up.sh either", async () => {
    const stub = { pools: orbstackPools(10), networks: busy };
    const pool = await run("address-pool.sh", ["4"], stub, {
      STUB_INSPECT_FAILS: "2",
    });
    expect(pool.exitCode).toBe(2);
    expect(pool.stderr).toContain(
      "cannot read Docker's networks; the pool was not checked",
    );

    const up = await run("up.sh", [], stub, { STUB_INSPECT_FAILS: "4" });
    expect(up.exitCode).toBe(1);
    expect(up.stderr).toContain("check that Docker answers");
    expect(up.stderr).not.toContain("down a stack you started");
    expect(await runs()).toEqual([]);
  });

  test("up.sh stops on a short pool before the run directory or any compose call", async () => {
    const { exitCode, stderr } = await run(
      "up.sh",
      [],
      { pools: orbstackPools(6), networks: busy },
      { VERIFY_SLOT_LIMIT: "2" },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("0 free of 6, 3 needed");
    expect(stderr).toContain("nothing was started");
    expect(await runs()).toEqual([]);
    expect(
      (await dockerCalls()).some((call) => call.startsWith("compose")),
    ).toBe(false);
  });

  test("up.sh refuses a slot limit that is not a positive integer without asking docker", async () => {
    for (const value of ["0", "-1", "two", "08", "10000"]) {
      const { exitCode, stderr } = await run(
        "up.sh",
        [],
        { pools: orbstackPools(30), networks: [] },
        { VERIFY_SLOT_LIMIT: value },
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("VERIFY_SLOT_LIMIT must be a positive integer");
    }
    expect(await dockerCalls()).toEqual([]);
  });

  test("up.sh refuses a console port or a state variable it cannot use without asking docker", async () => {
    for (const env of [
      { VERIFY_CONSOLE_PORT: "80a" },
      { VERIFY_CONSOLE_PORT: "-1" },
      { VERIFY_CONSOLE_PORT: "0" },
      { VERIFY_CONSOLE_PORT: "080" },
      { VERIFY_CONSOLE_PORT: "65536" },
      { VERIFY_CONSOLE_PORT: "99999999999999999999" },
      { VERIFY_STATE_VARS: "lower" },
      { VERIFY_STATE_VARS: "A=B" },
      { VERIFY_STATE_VARS: "VERIFY_TEST_NEVER_SET" },
      // A value the shell and the .mjs helpers would not read alike.
      ...["two words", "it's", 'a"b', "a$b", "a\\b", "line\nline", "a;b"].map(
        (value) => ({
          VERIFY_STATE_VARS: "VERIFY_TEST_KEPT",
          VERIFY_TEST_KEPT: value,
        }),
      ),
    ]) {
      const { exitCode, stderr } = await run(
        "up.sh",
        [],
        { pools: orbstackPools(30), networks: [] },
        env,
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain(Object.keys(env)[0] ?? "");
      // The refusal names the variable, never what it holds.
      if ("VERIFY_TEST_KEPT" in env) {
        expect(stderr).not.toContain(env.VERIFY_TEST_KEPT);
      }
    }
    expect(await dockerCalls()).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  test("up.sh publishes the API on VERIFY_CONSOLE_PORT and keeps VERIFY_STATE_VARS for the run's later steps", async () => {
    // local.sh stops at the stand-in's `docker version`; what up.sh wrote for
    // the run by then stays, because the teardown that follows fails too.
    const written = async (env: Record<string, string>) => {
      await rm(join(dir, "runs"), { force: true, recursive: true });
      await run("up.sh", [], { pools: orbstackPools(30), networks: [] }, env);
      const [id] = await runs();
      expect(id).toBeDefined();
      return join(dir, "runs", id ?? "");
    };
    const loopbackOn3000 = async (runDir: string) =>
      (await Bun.file(join(runDir, "ports.yml")).text())
        .split("\n")
        .filter((line) => /"127\.0\.0\.1:\d*:3000"/.test(line))
        .map((line) => line.trim());

    expect(await loopbackOn3000(await written({}))).toEqual([
      '- "127.0.0.1::3000"',
      '- "127.0.0.1::3000"',
    ]);

    const values = {
      VERIFY_TEST_KEPT: "0f3a_.:/@%+=,-Z",
      VERIFY_TEST_ALSO2: "http://127.0.0.1:41234",
    };
    const kept = await written({
      VERIFY_CONSOLE_PORT: "41234",
      VERIFY_STATE_VARS: Object.keys(values).join(" "),
      ...values,
    });
    expect(await loopbackOn3000(kept)).toEqual([
      '- "127.0.0.1::3000"',
      '- "127.0.0.1:41234:3000"',
    ]);
    // Read back both ways the run's later steps read it, by readers that were
    // never given the values: sourced (lib.sh, down.sh) and parsed
    // (browser.mjs, web-user.mjs). Compose got what the shell reads and
    // `type-state` types what the parser reads, so the two must agree.
    const state = join(kept, "state.env");
    const sourced = Bun.spawnSync(
      [
        "bash",
        "-c",
        '. "$1" && export -p | grep -c "^declare -x VERIFY_TEST_" && printf "%s|%s" "$VERIFY_TEST_KEPT" "$VERIFY_TEST_ALSO2"',
        "bash",
        state,
      ],
      { env: { PATH: process.env.PATH ?? "" } },
    );
    expect(sourced.stdout.toString()).toBe(
      `2\n${values.VERIFY_TEST_KEPT}|${values.VERIFY_TEST_ALSO2}`,
    );
    const parsed = parseRunState(await Bun.file(state).text());
    expect(parsed).toMatchObject(values);
    expect(parsed.COMPOSE_PROJECT_NAME).toMatch(/^verify-ap-/);
  });

  test("up.sh hands local.sh 3 worker slots, 7 with the demo data, or VERIFY_SLOT_LIMIT, over the caller's own", async () => {
    for (const [slots, demo] of [
      ["", ""],
      ["", "1"],
      ["5", "1"],
      ["5", ""],
    ]) {
      // The stand-in refuses `docker version`: local.sh stops at its first
      // docker call, which records the limit it was given.
      const { exitCode } = await run(
        "up.sh",
        [],
        { pools: orbstackPools(30), networks: [] },
        {
          VERIFY_SLOT_LIMIT: String(slots),
          VERIFY_DEMO_ACCOUNTS: String(demo),
          EXECUTION_SLOT_LIMIT: "10",
        },
      );
      expect(exitCode).not.toBe(0);
    }

    expect(await Bun.file(join(dir, "slot-limits")).text()).toBe(
      "3\n7\n5\n5\n",
    );
  });

  test("up.sh checks the pool for the slots the demo data gets", async () => {
    const { exitCode, stderr } = await run(
      "up.sh",
      [],
      { pools: orbstackPools(7), networks: [] },
      { VERIFY_DEMO_ACCOUNTS: "1" },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("7 free of 7, 8 needed");
    expect(await runs()).toEqual([]);
  });
});
