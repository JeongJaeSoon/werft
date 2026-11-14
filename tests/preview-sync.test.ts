import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * deploy/preview/preview.sh sync against stand-ins for gh, kubectl and curl.
 * The script runs from a copy whose sibling preview.sh is a stand-in too, so
 * the `up` and `down` it hands out are recorded instead of run.
 */

const script = join(import.meta.dir, "..", "deploy/preview/preview.sh");
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const LABELED_1 = "2026-11-15T01:00:00Z";
const LABELED_2 = "2026-11-15T02:00:00Z";

type Namespace = {
  name: string;
  head?: string;
  source?: string;
  upAt?: string;
};

describe("deploy/preview/preview.sh sync", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preview-sync-"));
    await mkdir(join(dir, "bin"));
    await mkdir(join(dir, "gh"));
    await mkdir(join(dir, "deploy", "preview"), { recursive: true });
    await copyFile(script, join(dir, "deploy", "preview", "under-test.sh"));
    // Answers from gh/<path>.json through the call's own --jq; writes
    // (-X PATCH, -f) are recorded in gh-writes.
    await writeFile(
      join(dir, "bin", "gh"),
      `#!/bin/bash
echo "$*" >> "${dir}/gh-calls"
f="" jqx="." method=GET path="" body=""
if [ "$1" = pr ]; then
  case "$2" in
    list) f="${dir}/gh/pulls.json" ;;
    view) f="${dir}/gh/pr-$3.json" ;;
  esac
  shift 2
fi
[ "$1" = api ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --paginate) ;;
    -X) method="$2"; shift ;;
    --jq) jqx="$2"; shift ;;
    -f) body="\${2#body=}"; [ "$method" = GET ] && method=POST; shift ;;
    -*) shift ;;
    *) path="$1" ;;
  esac
  shift
done
if [ "$method" != GET ]; then
  printf '%s %s\\n%s\\n' "$method" "$path" "$body" >> "${dir}/gh-writes"
  echo 1
  exit 0
fi
[ -n "$f" ] || f="${dir}/gh/$(printf '%s' "$path" | tr '/{}' '___').json"
[ -f "$f" ] || { echo "stub: no $f" >&2; exit 1; }
jq -r "$jqx" "$f"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "bin", "kubectl"),
      `#!/bin/bash
echo "$*" >> "${dir}/kubectl-calls"
ns="${dir}/namespaces.json"
case "$1 $2" in
  "config view") echo "apiVersion: v1" ;;
  "get namespaces") cat "$ns" ;;
  "get namespace")
    jq -e --arg n "$3" '.items[] | select(.metadata.name == $n)' "$ns" >/dev/null || exit 1
    if [ "$4" = -o ]; then
      key="\${5#jsonpath=\\{.metadata.}"
      key="\${key%\\}}"
      kind="\${key%%.*}"
      k="\${key#*.}"
      k="\${k//\\\\./.}"
      jq -r --arg n "$3" --arg kind "$kind" --arg k "$k" \\
        '.items[] | select(.metadata.name == $n) | .metadata[$kind][$k] // ""' "$ns"
    fi ;;
  "annotate namespace")
    name="$3"
    shift 4
    for kv in "$@"; do
      jq --arg n "$name" --arg k "\${kv%%=*}" --arg v "\${kv#*=}" \\
        '(.items[] | select(.metadata.name == $n) | .metadata.annotations[$k]) = $v' "$ns" >"$ns.tmp"
      mv "$ns.tmp" "$ns"
    done ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(dir, "bin", "curl"),
      `#!/bin/sh\nprintf '%s' "\${STUB_READYZ:-200}"\n`,
      { mode: 0o755 },
    );
    // up adds the namespace as the real one would; down deletes it.
    await writeFile(
      join(dir, "deploy", "preview", "preview.sh"),
      `#!/bin/bash
echo "$1 $2 \${3:-} source=\${PREVIEW_SOURCE:-} reap_up_at=\${PREVIEW_REAP_UP_AT-unset}" >> "${dir}/preview-calls"
ns="${dir}/namespaces.json"
case "$1" in
  up)
    code="\${STUB_UP_EXIT:-0}"
    [ "$code" = 75 ] && echo "pr-$2: head is ${HEAD_B} now, not the $3 asked for" >&2
    if [ "$code" = 0 ]; then
      jq --arg n "pr-$2" --arg h "$3" --arg s "\${PREVIEW_SOURCE:-}" \\
        '.items |= (map(select(.metadata.name != $n)) + [{metadata: {name: $n,
          labels: {"werft.dev/preview": "true"},
          annotations: {"werft.dev/preview-head": $h, "werft.dev/preview-source": $s,
            "werft.dev/preview-up-at": "2099-01-01T00:00:00Z"}}}])' "$ns" >"$ns.tmp"
      mv "$ns.tmp" "$ns"
    fi
    exit "$code" ;;
  down)
    jq --arg n "pr-$2" '.items |= map(select(.metadata.name != $n))' "$ns" >"$ns.tmp"
    mv "$ns.tmp" "$ns" ;;
esac
`,
      { mode: 0o755 },
    );
    await gh("api/user", { login: "owner" });
    await gh("repos/{owner}/{repo}/collaborators", [
      { login: "owner", permissions: { push: true } },
      { login: "reader", permissions: { push: false } },
    ]);
    await gh("repos/{owner}/{repo}/issues/5/comments", []);
    await namespaces([]);
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const gh = (path: string, body: unknown) =>
    writeFile(
      join(
        dir,
        "gh",
        path === "api/user"
          ? "user.json"
          : `${path.replace(/[/{}]/g, "_")}.json`,
      ),
      JSON.stringify(body),
    );

  const pulls = (rows: { number: number; head: string; fork?: boolean }[]) =>
    writeFile(
      join(dir, "gh", "pulls.json"),
      JSON.stringify(
        rows.map(({ number, head, fork }) => ({
          number,
          headRefOid: head,
          isCrossRepository: fork ?? false,
        })),
      ),
    );

  const labeled = (n: number, events: { at: string; by: string }[]) =>
    gh(`repos/{owner}/{repo}/issues/${n}/events`, [
      { event: "labeled", label: { name: "other" }, actor: { login: "x" } },
      ...events.map(({ at, by }) => ({
        event: "labeled",
        label: { name: "preview" },
        created_at: at,
        actor: { login: by },
      })),
    ]);

  const namespaces = (items: Namespace[]) =>
    writeFile(
      join(dir, "namespaces.json"),
      JSON.stringify({
        items: items.map(({ name, head, source, upAt }) => ({
          metadata: {
            name,
            labels: { "werft.dev/preview": "true" },
            annotations: {
              ...(head ? { "werft.dev/preview-head": head } : {}),
              ...(source ? { "werft.dev/preview-source": source } : {}),
              "werft.dev/preview-up-at": upAt ?? new Date().toISOString(),
            },
          },
        })),
      }),
    );

  const state = (n: number, line: string) =>
    mkdir(join(dir, "home", "sync"), { recursive: true }).then(() =>
      writeFile(join(dir, "home", "sync", `pr-${n}`), `${line}\n`),
    );

  const readState = (n: number) =>
    readFile(join(dir, "home", "sync", `pr-${n}`), "utf8").then(
      (text) => text.trim(),
      () => null,
    );

  const lines = async (name: string) =>
    (await readFile(join(dir, name), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);

  const writes = async () =>
    (await readFile(join(dir, "gh-writes"), "utf8").catch(() => ""))
      .split(/^(?=POST |PATCH )/m)
      .filter(Boolean);

  async function sync(env: Record<string, string> = {}) {
    const handle = Bun.spawn(
      ["bash", join(dir, "deploy", "preview", "under-test.sh"), "sync"],
      {
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
          PREVIEW_HOME: join(dir, "home"),
          PREVIEW_DOMAIN: "preview.example.dev",
          PREVIEW_LABEL: "",
          PREVIEW_TTL_HOURS: "",
          ...env,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [exitCode, stderr, stdout] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
      new Response(handle.stdout).text(),
    ]);
    return { exitCode, stderr, stdout };
  }

  test("brings a labeled PR up at the head it read, marked as the label's", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    const result = await sync();
    expect(result.exitCode).toBe(0);
    expect(await lines("preview-calls")).toEqual([
      `up 5 ${HEAD_A} source=label reap_up_at=unset`,
    ]);
    expect(await readState(5)).toBe(`${HEAD_A} up ${LABELED_1}`);
    const posted = await writes();
    expect(posted).toHaveLength(2);
    expect(posted[0]).toContain("PR 미리보기: 올리는 중");
    expect(posted[1]).toContain("PR 미리보기: 떠 있다");
    expect(posted[1]).toContain("https://pr-5.preview.example.dev/");
    expect(posted[1]).toStartWith(
      "POST repos/{owner}/{repo}/issues/5/comments\n<!-- werft-preview-local -->",
    );
  });

  test("edits its own marked comment, not one someone else wrote", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await gh("repos/{owner}/{repo}/issues/5/comments", [
      {
        id: 11,
        user: { login: "mallory" },
        body: "<!-- werft-preview-local -->",
      },
      {
        id: 12,
        user: { login: "owner" },
        body: "<!-- werft-preview-local -->\nold",
      },
    ]);
    await sync();
    const posted = await writes();
    expect(posted.map((write) => write.split("\n")[0])).toEqual([
      "PATCH repos/{owner}/{repo}/issues/comments/12",
      "PATCH repos/{owner}/{repo}/issues/comments/12",
    ]);
  });

  test("does nothing more for a preview up at the PR's head", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await namespaces([{ name: "pr-5", head: HEAD_A, source: "label" }]);
    await state(5, `${HEAD_A} up ${LABELED_1}`);
    await sync();
    expect(await lines("preview-calls")).toEqual([]);
    expect(await writes()).toEqual([]);
  });

  test("brings a push up again", async () => {
    await pulls([{ number: 5, head: HEAD_B }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await namespaces([{ name: "pr-5", head: HEAD_A, source: "label" }]);
    await state(5, `${HEAD_A} up ${LABELED_1}`);
    await sync();
    expect(await lines("preview-calls")).toEqual([
      `up 5 ${HEAD_B} source=label reap_up_at=unset`,
    ]);
  });

  for (const [name, setup, reason] of [
    [
      "a fork's PR",
      () => pulls([{ number: 5, head: HEAD_A, fork: true }]),
      "fork의 브랜치다",
    ],
    [
      "a label someone else put on",
      () => labeled(5, [{ at: LABELED_1, by: "someone" }]),
      "마지막으로 붙인 someone가",
    ],
    [
      "a repository someone else may push to",
      () =>
        gh("repos/{owner}/{repo}/collaborators", [
          { login: "owner", permissions: { push: true } },
          { login: "helper", permissions: { push: true } },
        ]),
      "(helper)",
    ],
  ] as const) {
    test(`refuses ${name}, once, and says why`, async () => {
      await pulls([{ number: 5, head: HEAD_A }]);
      await labeled(5, [{ at: LABELED_1, by: "owner" }]);
      await setup();
      const first = await sync();
      expect(await lines("preview-calls")).toEqual([]);
      expect(first.stdout).toContain(`pr-5: refused at ${HEAD_A.slice(0, 12)}`);
      expect(await readState(5)).toBe(`${HEAD_A} refused ${LABELED_1}`);
      const posted = await writes();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("PR 미리보기: 거절했다");
      expect(posted[0]).toContain(reason);
      await sync();
      expect(await writes()).toHaveLength(1);
    });
  }

  test("tries a failing head once per label", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    const first = await sync({ STUB_UP_EXIT: "1" });
    expect(first.stdout).toContain("pr-5: up failed (exit 1)");
    expect(await readState(5)).toBe(`${HEAD_A} failed ${LABELED_1}`);
    expect((await writes())[1]).toContain("PR 미리보기: 실패했다");
    await sync({ STUB_UP_EXIT: "1" });
    expect(await lines("preview-calls")).toHaveLength(1);
    await labeled(5, [
      { at: LABELED_1, by: "owner" },
      { at: LABELED_2, by: "owner" },
    ]);
    await sync();
    expect(await lines("preview-calls")).toHaveLength(2);
    expect(await readState(5)).toBe(`${HEAD_A} up ${LABELED_2}`);
  });

  test("records nothing when up is busy or the head moved", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    const result = await sync({ STUB_UP_EXIT: "75" });
    expect(result.stdout).toContain(
      "pr-5: busy or the head moved; the next run tries again",
    );
    expect(await readState(5)).toBe(null);
  });

  test("says a preview gone at its head is down and keeps the label", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await state(5, `${HEAD_A} up ${LABELED_1}`);
    const result = await sync();
    expect(result.stdout).toContain("pr-5: gone at");
    expect(await lines("preview-calls")).toEqual([]);
    expect(await readState(5)).toBe(`${HEAD_A} gone ${LABELED_1}`);
    const posted = await writes();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("PR 미리보기: 내려갔다");
    expect(await lines("gh-calls")).not.toContain(
      expect.stringContaining("pr edit"),
    );
  });

  test("downs the label's previews no longer wanted, and only those", async () => {
    await pulls([]);
    await namespaces([
      {
        name: "pr-5",
        head: HEAD_A,
        source: "label",
        upAt: "2099-01-01T00:00:00Z",
      },
      { name: "pr-6", head: HEAD_A, upAt: "2099-01-01T00:00:00Z" },
    ]);
    await state(5, `${HEAD_A} up ${LABELED_1}`);
    await state(7, `${HEAD_A} refused ${LABELED_1}`);
    const result = await sync();
    expect(result.exitCode).toBe(0);
    expect(await lines("preview-calls")).toEqual([
      "down 5  source= reap_up_at=2099-01-01T00:00:00Z",
    ]);
    expect(await readState(5)).toBe(null);
    expect(await readState(7)).toBe(null);
    const posted = await writes();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("PR 미리보기: 내려갔다");
  });

  test("adopts a preview brought up by hand at the PR's head", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await namespaces([{ name: "pr-5", head: HEAD_A }]);
    await sync();
    expect(await lines("preview-calls")).toEqual([]);
    expect(await lines("kubectl-calls")).toContain(
      "annotate namespace pr-5 --overwrite werft.dev/preview-source=label",
    );
    expect(await readState(5)).toBe(`${HEAD_A} up ${LABELED_1}`);
  });

  for (const missing of ["pulls.json", "user.json"]) {
    test(`changes nothing when GitHub does not answer (${missing})`, async () => {
      await pulls([]);
      await namespaces([{ name: "pr-5", head: HEAD_A, source: "label" }]);
      await rm(join(dir, "gh", missing));
      const result = await sync();
      expect(result.stdout).toContain(
        "sync: GitHub could not be read; no preview changed",
      );
      expect(await lines("preview-calls")).toEqual([]);
    });
  }

  test("refuses a PREVIEW_DOMAIN that is not a DNS name", async () => {
    const result = await sync({ PREVIEW_DOMAIN: "x/../y" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "PREVIEW_DOMAIN must be a lowercase DNS name",
    );
  });
});
