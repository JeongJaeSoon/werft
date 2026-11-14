import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * deploy/preview/preview.sh reap against stand-ins for kubectl, gh, docker
 * and git: which preview namespaces it hands to `down`, and which it keeps.
 */

const script = join(import.meta.dir, "..", "deploy/preview/preview.sh");

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000)
    .toISOString()
    .replace(/\.\d+Z$/, "Z");

describe("deploy/preview/preview.sh reap", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preview-reap-"));
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "kubectl"),
      `#!/bin/sh
echo "$*" >> "${dir}/kubectl-calls"
case "$*" in
  "config view "*) echo "apiVersion: v1" ;;
  "get namespaces -l werft.dev/preview=true -o json") cat "${dir}/namespaces.json" ;;
  "get namespace "*"preview-up-at}")
    if [ -n "\${STUB_CURRENT_UP_AT+set}" ]; then
      echo "$STUB_CURRENT_UP_AT"
    else
      jq -r --arg ns "$3" '.items[] | select(.metadata.name == $ns)
        | .metadata.annotations["werft.dev/preview-up-at"] // ""' "${dir}/namespaces.json"
    fi ;;
  "get namespace "*"labels.werft\\.dev/preview}"*) echo true ;;
  "get namespace "*" -o jsonpath="*) echo ;;
  "get namespace "*) ;;
  "delete namespace "*) exit "\${STUB_DELETE_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    // STUB_STATES is "<N>=<state> ...", where the state "fail" makes the
    // lookup fail.
    await writeFile(
      join(dir, "bin", "gh"),
      `#!/bin/sh
echo "$*" >> "${dir}/gh-calls"
for pair in $STUB_STATES; do
  [ "\${pair%%=*}" = "$3" ] || continue
  if [ "\${pair#*=}" = fail ]; then
    echo "error connecting to api.github.com" >&2
    exit 1
  fi
  echo "\${pair#*=}"
  exit 0
done
echo "no pull requests found" >&2
exit 1
`,
      { mode: 0o755 },
    );
    // No containers left, no image tags to remove.
    await writeFile(
      join(dir, "bin", "docker"),
      `#!/bin/sh\necho "$*" >> "${dir}/docker-calls"\n[ "$1" = ps ]\n`,
      { mode: 0o755 },
    );
    // Fails the git call whose arguments contain STUB_GIT_FAIL.
    await writeFile(
      join(dir, "bin", "git"),
      `#!/bin/sh
[ -n "$STUB_GIT_FAIL" ] && case "$*" in *"$STUB_GIT_FAIL"*) exit 1 ;; esac
exit 0
`,
      { mode: 0o755 },
    );
    await writeFile(join(dir, "bin", "orb"), "#!/bin/sh\necho false\n", {
      mode: 0o755,
    });
    // Answers `helm status` as deployed for STUB_RELEASES; everything else
    // fails, which ends `up` at the Traefik install unless it is listed.
    await writeFile(
      join(dir, "bin", "helm"),
      `#!/bin/sh
echo "$*" >> "${dir}/helm-calls"
[ "$1" = status ] && case " $STUB_RELEASES " in
  *" $2 "*) echo '{"info":{"status":"deployed"}}'; exit 0 ;;
esac
exit 1
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function reap(
    namespaces: { name: string; upAt?: string }[],
    env: Record<string, string> = {},
  ) {
    await writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: namespaces.map(({ name, upAt }) => ({
          metadata: {
            name,
            annotations:
              upAt === undefined ? {} : { "werft.dev/preview-up-at": upAt },
          },
        })),
      }),
    );
    const handle = Bun.spawn(["bash", script, "reap"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
        PREVIEW_TTL_HOURS: "",
        STUB_STATES: "",
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

  const deleted = async () =>
    (await calls("kubectl-calls"))
      .filter((call) => call.startsWith("delete namespace "))
      .map((call) => call.split(" ")[2]);

  test("downs closed and merged PRs' previews and keeps open ones", async () => {
    const result = await reap(
      [
        { name: "pr-1", upAt: hoursAgo(1) },
        { name: "pr-2", upAt: hoursAgo(1) },
        { name: "pr-3", upAt: hoursAgo(1) },
      ],
      { STUB_STATES: "1=MERGED 2=CLOSED 3=OPEN" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-1", "pr-2"]);
    expect(result.stdout).toContain("pr-1: deleting, PR MERGED");
    expect(result.stdout).toContain("pr-3: kept, PR OPEN, last up 1h ago");
    expect(result.stdout).toContain("reap deleted: pr-1 pr-2\n");
    expect(await calls("gh-calls")).toEqual([
      "pr view 1 --json state --jq .state",
      "pr view 2 --json state --jq .state",
      "pr view 3 --json state --jq .state",
    ]);
  });

  test("asks Kubernetes only for namespaces with the preview label", async () => {
    await reap([]);
    expect(await calls("kubectl-calls")).toContain(
      "get namespaces -l werft.dev/preview=true -o json",
    );
  });

  test("keeps a labeled namespace not named pr-<N>", async () => {
    const result = await reap([
      { name: "pr-x964", upAt: hoursAgo(100) },
      { name: "pr-0", upAt: hoursAgo(100) },
      { name: "preview-ingress", upAt: hoursAgo(100) },
    ]);
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(await calls("gh-calls")).toEqual([]);
    expect(result.stdout).toContain("pr-x964: kept, not named pr-<N>");
    expect(result.stdout).toContain("reap deleted: none\n");
  });

  test("downs an open PR's preview past the TTL without asking GitHub", async () => {
    const result = await reap(
      [
        { name: "pr-4", upAt: hoursAgo(25) },
        { name: "pr-5", upAt: hoursAgo(23) },
      ],
      { STUB_STATES: "4=OPEN 5=OPEN" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-4"]);
    expect(result.stdout).toContain("pr-4: deleting, last up 25h ago");
    expect(await calls("gh-calls")).toEqual([
      "pr view 5 --json state --jq .state",
    ]);
  });

  test("PREVIEW_TTL_HOURS sets the TTL", async () => {
    const result = await reap([{ name: "pr-6", upAt: hoursAgo(3) }], {
      PREVIEW_TTL_HOURS: "2",
      STUB_STATES: "6=OPEN",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-6"]);
  });

  test("refuses a PREVIEW_TTL_HOURS that is not a whole number", async () => {
    const result = await reap([], { PREVIEW_TTL_HOURS: "1d" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("PREVIEW_TTL_HOURS must be a whole number");
    expect(await calls("gh-calls")).toEqual([]);
  });

  test("keeps the preview and says why when GitHub cannot be read", async () => {
    const result = await reap(
      [
        { name: "pr-7", upAt: hoursAgo(1) },
        { name: "pr-8", upAt: hoursAgo(1) },
      ],
      { STUB_STATES: "7=fail" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stdout).toContain(
      "pr-7: kept, GitHub lookup failed: error connecting to api.github.com",
    );
    expect(result.stdout).toContain(
      "pr-8: kept, GitHub lookup failed: no pull requests found",
    );
  });

  test("keeps an open PR's preview with no readable up time", async () => {
    const result = await reap(
      [{ name: "pr-9" }, { name: "pr-10", upAt: "yesterday" }],
      { STUB_STATES: "9=OPEN 10=OPEN" },
    );
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stdout).toContain(
      "pr-9: no readable werft.dev/preview-up-at, TTL not applied",
    );
    expect(result.stdout).toContain("pr-10: kept, PR OPEN\n");
  });

  test("goes on past a failed down and exits non-zero", async () => {
    const result = await reap(
      [
        { name: "pr-11", upAt: hoursAgo(1) },
        { name: "pr-12", upAt: hoursAgo(1) },
      ],
      { STUB_STATES: "11=MERGED 12=MERGED", STUB_DELETE_EXIT: "1" },
    );
    expect(result.exitCode).toBe(1);
    expect(await deleted()).toEqual(["pr-11", "pr-12"]);
    expect(result.stdout).toContain(
      "reap deleted: none, failed: pr-11 pr-12\n",
    );
  });

  test("keeps a preview brought up again after reap read it", async () => {
    const result = await reap([{ name: "pr-13", upAt: hoursAgo(30) }], {
      STUB_CURRENT_UP_AT: hoursAgo(0),
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain("pr-13: up again at ");
    expect(result.stdout).toContain("pr-13: kept, see above");
    expect(result.stdout).toContain("reap deleted: none\n");
  });

  test("keeps a preview another up or down holds", async () => {
    await mkdir(join(dir, "home"));
    await symlink(String(process.pid), join(dir, "home", "pr-14.lock"));
    const result = await reap([{ name: "pr-14", upAt: hoursAgo(1) }], {
      STUB_STATES: "14=MERGED",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain(
      `pr-14: busy, pid ${process.pid} is running up or down on it`,
    );
    expect(await readlink(join(dir, "home", "pr-14.lock"))).toBe(
      String(process.pid),
    );
  });

  test("takes over a lock whose holder is gone and releases it", async () => {
    await mkdir(join(dir, "home"));
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await symlink(String(gone.pid), join(dir, "home", "pr-15.lock"));
    const result = await reap([{ name: "pr-15", upAt: hoursAgo(1) }], {
      STUB_STATES: "15=CLOSED",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual(["pr-15"]);
    expect(
      await readlink(join(dir, "home", "pr-15.lock")).catch(() => null),
    ).toBe(null);
    expect(
      await readlink(join(dir, "home", "pr-15.lock.reclaim")).catch(() => null),
    ).toBe(null);
  });

  test("leaves a gone holder's lock to the process already reclaiming it", async () => {
    await mkdir(join(dir, "home"));
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    await symlink(String(gone.pid), join(dir, "home", "pr-16.lock"));
    await symlink(String(process.pid), join(dir, "home", "pr-16.lock.reclaim"));
    const result = await reap([{ name: "pr-16", upAt: hoursAgo(1) }], {
      STUB_STATES: "16=CLOSED",
    });
    expect(result.exitCode).toBe(0);
    expect(await deleted()).toEqual([]);
    expect(result.stderr).toContain("pr-16: busy, another process is taking");
    expect(await readlink(join(dir, "home", "pr-16.lock"))).toBe(
      String(gone.pid),
    );
  });

  test("down removes the werft image tags only", async () => {
    const result = await reap([{ name: "pr-17", upAt: hoursAgo(1) }], {
      STUB_STATES: "17=CLOSED",
    });
    expect(result.exitCode).toBe(0);
    const removed = (await calls("docker-calls")).filter((call) =>
      call.startsWith("image rm "),
    );
    expect(removed).toEqual(
      ["control-host", "egress-proxy", "worker"].map(
        (app) => `image rm werft-${app}:pr-17`,
      ),
    );
  });

  const up = async (releases: string, env: Record<string, string> = {}) => {
    const handle = Bun.spawn(["bash", script, "up", "18"], {
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
        PREVIEW_HOME: join(dir, "home"),
        STUB_RELEASES: releases,
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
  };

  test("up asks helm about the ingress only, never an earlier release name", async () => {
    // A stub that would answer for the old release name; the script must not ask.
    await up("agent-platform");
    const helm = await calls("helm-calls");
    expect(helm).toContain(
      "status traefik --namespace preview-ingress -o json",
    );
    expect(
      helm.filter((call) => call.startsWith("status agent-platform")),
    ).toEqual([]);
  });

  // The stub kubectl finds pr-18 with the preview label and refuses
  // `create namespace`, which ends `up` right after the reinstall decision.
  const checkout = () =>
    mkdir(join(dir, "home", "pr-18", "src", "deploy", "kind"), {
      recursive: true,
    });

  test("up deletes a running preview's namespace before installing it again", async () => {
    await checkout();
    const result = await up("traefik");
    expect(result.exitCode).not.toBe(0);
    const kubectl = await calls("kubectl-calls");
    const removal = kubectl.indexOf(
      "delete namespace pr-18 --wait --timeout 5m",
    );
    const creation = kubectl.findIndex((call) =>
      call.startsWith("create namespace pr-18 "),
    );
    expect(removal).toBeGreaterThan(-1);
    expect(creation).toBeGreaterThan(removal);
  });

  test("up installs nothing when the running preview cannot be deleted", async () => {
    await checkout();
    const result = await up("traefik", { STUB_DELETE_EXIT: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(await deleted()).toEqual(["pr-18"]);
    expect(
      (await calls("kubectl-calls")).filter((call) =>
        call.startsWith("create namespace "),
      ),
    ).toEqual([]);
  });

  for (const step of ["fetch", "checkout"]) {
    test(`up keeps a running preview when the PR head ${step} fails`, async () => {
      await checkout();
      const result = await up("traefik", { STUB_GIT_FAIL: step });
      expect(result.exitCode).not.toBe(0);
      expect(await deleted()).toEqual([]);
    });
  }
});
