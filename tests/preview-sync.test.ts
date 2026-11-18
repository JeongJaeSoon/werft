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
    // (-X PATCH, -f) are recorded in gh-writes, unless their body holds
    // STUB_GH_WRITE_FAILS, which fails them.
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
  if [ -n "\${STUB_GH_WRITE_FAILS:-}" ] && [[ "$body" == *"$STUB_GH_WRITE_FAILS"* ]]; then
    echo "stub: HTTP 502" >&2
    exit 1
  fi
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
    jq -e --arg n "$3" '.items[] | select(.metadata.name == $n)' "$ns" >/dev/null ||
      { [[ "$*" == *--ignore-not-found* ]] && exit 0; exit 1; }
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
  "apply -f")
    y="$(cat)"
    printf '%s\\n' "$y" > "${dir}/ingress/$(sed -n 's/^  namespace: //p' <<<"$y").$(sed -n 's/^  name: //p' <<<"$y").yaml" ;;
  "get ingress")
    for f in "${dir}"/ingress/*.yaml; do
      [ -f "$f" ] || continue
      jq -n --arg ns "$(sed -n 's/^  namespace: //p' "$f")" --arg name "$(sed -n 's/^  name: //p' "$f")" \\
        --arg hosts "$(sed -n 's/^    - host: //p' "$f")" \\
        '{metadata: {namespace: $ns, name: $name}, spec: {rules: ($hosts | split("\\n") | map({host: .}))}}'
    done | jq -s '{items: .}' ;;
  "delete ingress")
    if [ "$3" = -A ]; then rm -f "${dir}"/ingress/*.yaml; else rm -f "${dir}/ingress/$4.$5.yaml"; fi ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    await mkdir(join(dir, "ingress"));
    // The front login's check asks for %{redirect_url}; STUB_GATE answers it.
    await writeFile(
      join(dir, "bin", "curl"),
      `#!/bin/sh
case "$*" in
  *redirect_url*)
    echo "$*" >> "${dir}/curl-calls"
    printf '%s' "\${STUB_GATE-302 https://team.cloudflareaccess.com/cdn-cgi/access/login/x}" ;;
  *) printf '%s' "\${STUB_READYZ:-200}" ;;
esac
`,
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
    rm -f "${dir}/ingress/pr-$2."*
    mkdir -p "$PREVIEW_HOME/pr-$2/state"
    echo werft > "$PREVIEW_HOME/pr-$2/state/fullname"
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
    [ "\${STUB_DOWN_EXIT:-0}" = 0 ] || { echo "pr-$2: up again" >&2; exit "$STUB_DOWN_EXIT"; }
    rm -f "${dir}/ingress/pr-$2."*
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

  const pulls = (
    rows: { number: number; head: string; fork?: boolean; labels?: string[] }[],
  ) =>
    writeFile(
      join(dir, "gh", "pulls.json"),
      JSON.stringify(
        rows.map(({ number, head, fork, labels }) => ({
          number,
          headRefOid: head,
          isCrossRepository: fork ?? false,
          ...(labels ? { labels: labels.map((name) => ({ name })) } : {}),
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
          PREVIEW_PUBLIC_DOMAIN: "",
          PREVIEW_PUBLIC_LABEL: "",
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

  test("writes a comment GitHub did not take again, without another up", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    const failed = await sync({ STUB_GH_WRITE_FAILS: "떠 있다" });
    expect(failed.exitCode).toBe(0);
    expect(failed.stderr).toContain("pr-5: writing the PR comment failed");
    expect(await readState(5)).toBe(`${HEAD_A} up ${LABELED_1}`);
    expect((await writes()).map((write) => write.split("\n")[2])).toEqual([
      "### PR 미리보기: 올리는 중",
    ]);

    await sync();
    expect(await lines("preview-calls")).toEqual([
      `up 5 ${HEAD_A} source=label reap_up_at=unset`,
    ]);
    const posted = await writes();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("PR 미리보기: 떠 있다");
    expect(posted[1]).toContain("https://pr-5.preview.example.dev/");

    await sync();
    expect(await lines("preview-calls")).toHaveLength(1);
    expect(await writes()).toHaveLength(2);
  });

  test("writes the comment of a PR no longer labeled again after its down", async () => {
    await pulls([]);
    await namespaces([{ name: "pr-5", head: HEAD_A, source: "label" }]);
    await state(5, `${HEAD_A} up ${LABELED_1}`);
    await sync({ STUB_GH_WRITE_FAILS: "내려갔다" });
    expect(await writes()).toEqual([]);
    expect(await readState(5)).toBeNull();

    await sync();
    expect(
      (await lines("preview-calls")).map((call) => call.split(" ")[0]),
    ).toEqual(["down"]);
    const posted = await writes();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("PR 미리보기: 내려갔다");

    await sync();
    expect(await writes()).toHaveLength(1);
  });

  test("says down, not up, for a held comment whose preview went while GitHub was away", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await sync({ STUB_GH_WRITE_FAILS: "떠 있다" });
    // The PR closes, and reap takes the preview in a run that could not
    // read GitHub.
    await pulls([]);
    await namespaces([]);

    await sync();
    const posted = await writes();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("PR 미리보기: 내려갔다");
    expect(posted[1]).not.toContain("떠 있다");
    expect(await lines("preview-calls")).toHaveLength(1);

    await sync();
    expect(await writes()).toHaveLength(2);
  });

  test("says down for a held up comment of a labeled PR whose preview is gone", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await sync({ STUB_GH_WRITE_FAILS: "떠 있다" });
    // reap's TTL takes the preview, and the label's events cannot be read.
    await namespaces([]);
    await rm(join(dir, "gh", "repos__owner___repo__issues_5_events.json"));

    await sync();
    const posted = await writes();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("PR 미리보기: 내려갔다");
    expect(posted[1]).not.toContain("떠 있다");
    expect(await lines("preview-calls")).toHaveLength(1);
  });

  test("sends a held up comment as it is while its preview is there", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await sync({ STUB_GH_WRITE_FAILS: "떠 있다" });
    await rm(join(dir, "gh", "repos__owner___repo__issues_5_events.json"));

    await sync();
    const posted = await writes();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("PR 미리보기: 떠 있다");
  });

  test("does not hold a bringing-up comment for an up that built nothing", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await sync({ STUB_GH_WRITE_FAILS: "올리는 중", STUB_UP_EXIT: "75" });
    await rm(join(dir, "gh", "repos__owner___repo__issues_5_events.json"));

    await sync();
    expect(await writes()).toEqual([]);
    expect(await lines("preview-calls")).toHaveLength(1);
  });

  test("does not add a second comment when its own cannot be looked up", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "owner" }]);
    await rm(join(dir, "gh", "repos__owner___repo__issues_5_comments.json"));
    await sync({ STUB_UP_EXIT: "1" });
    expect(await writes()).toEqual([]);

    await gh("repos/{owner}/{repo}/issues/5/comments", [
      {
        id: 12,
        user: { login: "owner" },
        body: "<!-- werft-preview-local -->",
      },
    ]);
    await sync();
    const posted = await writes();
    expect(posted.map((write) => write.split("\n")[0])).toEqual([
      "PATCH repos/{owner}/{repo}/issues/comments/12",
    ]);
    expect(posted[0]).toContain("PR 미리보기: 실패했다");
    expect(await lines("preview-calls")).toHaveLength(1);
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

  test("keeps the record of a preview whose down did not go through", async () => {
    await pulls([]);
    await namespaces([{ name: "pr-5", head: HEAD_A, source: "label" }]);
    await state(5, `${HEAD_A} up ${LABELED_1}`);
    const result = await sync({ STUB_DOWN_EXIT: "75" });
    expect(result.stdout).toContain("pr-5: kept, see above");
    expect(await readState(5)).toBe(`${HEAD_A} up ${LABELED_1}`);
    expect(await writes()).toEqual([]);
  });

  test("installs over a preview brought up by hand, refusals first", async () => {
    await pulls([{ number: 5, head: HEAD_A }]);
    await labeled(5, [{ at: LABELED_1, by: "someone" }]);
    await namespaces([{ name: "pr-5", head: HEAD_A }]);
    await sync();
    expect(await lines("preview-calls")).toEqual([]);
    expect(await readState(5)).toBe(`${HEAD_A} refused ${LABELED_1}`);
    await labeled(5, [{ at: LABELED_2, by: "owner" }]);
    await sync();
    expect(await lines("preview-calls")).toEqual([
      `up 5 ${HEAD_A} source=label reap_up_at=unset`,
    ]);
  });

  for (const record of ["", HEAD_A]) {
    test(`reads a cut-short record (${JSON.stringify(record)}) as no attempt`, async () => {
      await pulls([{ number: 5, head: HEAD_A }]);
      await labeled(5, [{ at: LABELED_1, by: "owner" }]);
      await mkdir(join(dir, "home", "sync"), { recursive: true });
      await writeFile(join(dir, "home", "sync", "pr-5"), record);
      const result = await sync();
      expect(result.exitCode).toBe(0);
      expect(await lines("preview-calls")).toEqual([
        `up 5 ${HEAD_A} source=label reap_up_at=unset`,
      ]);
      expect(result.stdout).toContain("reap deleted:");
    });
  }

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

  describe("outside route", () => {
    const ON = { PREVIEW_PUBLIC_DOMAIN: "public.example.dev" };
    const BOTH = ["preview", "preview-public"];
    const ROUTE = "pr-5.preview-public-pr-5.yaml";
    const ROUTE_LINE = "바깥 경로: 열려 있다";

    const events = (
      n: number,
      list: { label?: string; event?: string; at: string; by: string }[],
    ) =>
      gh(
        `repos/{owner}/{repo}/issues/${n}/events`,
        list.map(({ label = "preview", event = "labeled", at, by }) => ({
          event,
          label: { name: label },
          created_at: at,
          actor: { login: by },
        })),
      );

    // Both labels on PR 5, by owner, and its preview up at HEAD_A.
    async function upAtA(publicBy = "owner") {
      await pulls([{ number: 5, head: HEAD_A, labels: BOTH }]);
      await events(5, [
        { at: LABELED_1, by: "owner" },
        { label: "preview-public", at: LABELED_1, by: publicBy },
      ]);
      await namespaces([{ name: "pr-5", head: HEAD_A, source: "label" }]);
      await state(5, `${HEAD_A} up ${LABELED_1}`);
      await mkdir(join(dir, "home", "pr-5", "state"), { recursive: true });
      await writeFile(join(dir, "home", "pr-5", "state", "fullname"), "werft");
    }

    const route = (file: string, namespace: string, host: string) =>
      writeFile(
        join(dir, "ingress", file),
        `metadata:\n  name: ${file.split(".")[1]}\n  namespace: ${namespace}\nspec:\n  rules:\n    - host: ${host}\n`,
      );
    const openRoute = () => route(ROUTE, "pr-5", "pr-5.public.example.dev");

    const routes = () =>
      Array.fromAsync(new Bun.Glob("*.yaml").scan(join(dir, "ingress")));

    const eventReads = async () =>
      (await lines("gh-calls")).filter((call) =>
        call.includes("issues/5/events"),
      ).length;

    test("off: two labels change nothing but one route delete", async () => {
      await pulls([{ number: 5, head: HEAD_A, labels: BOTH }]);
      await labeled(5, [{ at: LABELED_1, by: "owner" }]);
      await openRoute();
      await sync();
      expect(await lines("preview-calls")).toEqual([
        `up 5 ${HEAD_A} source=label reap_up_at=unset`,
      ]);
      expect(await routes()).toEqual([]);
      expect(
        (await lines("kubectl-calls")).filter((call) =>
          call.includes("ingress"),
        ),
      ).toEqual([
        "delete ingress -A -l werft.dev/preview-public=true --ignore-not-found",
      ]);
      expect(await eventReads()).toBe(1);
      expect(await lines("curl-calls")).toEqual([]);
      const posted = await writes();
      expect(posted).toHaveLength(2);
      expect(posted[1]).toContain(
        "라벨을 다시 붙인다.\n\nfake 모델이라 실제 모델·GitHub·Slack에는 닿지 않는다.",
      );
      expect(posted.join("")).not.toContain("바깥 경로");
    });

    test("opens a labeled PR's route after its up, without the domain in any comment or log", async () => {
      await pulls([{ number: 5, head: HEAD_A, labels: BOTH }]);
      await events(5, [
        { at: LABELED_1, by: "owner" },
        { label: "preview-public", at: LABELED_1, by: "owner" },
      ]);
      const result = await sync(ON);
      expect(result.exitCode).toBe(0);
      expect(await lines("preview-calls")).toHaveLength(1);
      const yaml = await readFile(join(dir, "ingress", ROUTE), "utf8");
      expect(yaml.match(/- host: .*/g)).toEqual([
        "- host: pr-5.public.example.dev",
      ]);
      expect(yaml).toContain("name: werft-api");
      expect(yaml).toContain('werft.dev/preview-public: "true"');
      const posted = await writes();
      expect(posted).toHaveLength(3);
      expect(posted[2]).toContain(ROUTE_LINE);
      expect(posted[2]).toContain("https://pr-5.preview.example.dev/");
      for (const text of [posted.join(""), result.stdout, result.stderr]) {
        expect(text).not.toContain("public.example.dev");
      }
    });

    test("leaves a PR with only the preview label as it was", async () => {
      await pulls([{ number: 5, head: HEAD_A, labels: ["preview"] }]);
      await labeled(5, [{ at: LABELED_1, by: "owner" }]);
      await sync(ON);
      expect(await lines("preview-calls")).toHaveLength(1);
      expect(await routes()).toEqual([]);
      expect(await eventReads()).toBe(1);
      expect(await lines("curl-calls")).toEqual([]);
      expect((await writes()).join("")).not.toContain("바깥 경로");
    });

    test("brings nothing up for the outside label alone", async () => {
      // gh pr list --label preview leaves the PR out.
      await pulls([]);
      await sync(ON);
      expect(await lines("preview-calls")).toEqual([]);
      expect(await routes()).toEqual([]);
    });

    test("does nothing more for an open route", async () => {
      await upAtA();
      await openRoute();
      await sync(ON);
      expect(await routes()).toEqual([ROUTE]);
      expect(await eventReads()).toBe(0);
      expect(
        (await lines("kubectl-calls")).filter((call) =>
          call.startsWith("apply"),
        ),
      ).toEqual([]);
      expect(await lines("curl-calls")).toHaveLength(1);
      expect(await writes()).toEqual([]);
    });

    test("closes the route when the outside label comes off, and keeps the preview", async () => {
      await upAtA();
      await openRoute();
      await pulls([{ number: 5, head: HEAD_A, labels: ["preview"] }]);
      await sync(ON);
      expect(await routes()).toEqual([]);
      expect(await lines("preview-calls")).toEqual([]);
      const posted = await writes();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("PR 미리보기: 떠 있다");
      expect(posted[0]).toContain("바깥 경로: 닫혀 있다.");
    });

    for (const [name, list] of [
      [
        "the label's last event is unlabeled",
        [
          { label: "preview-public", at: LABELED_1, by: "owner" },
          {
            label: "preview-public",
            event: "unlabeled",
            at: LABELED_2,
            by: "owner",
          },
        ],
      ],
      [
        "someone else put the label on last",
        [
          { label: "preview-public", at: LABELED_1, by: "owner" },
          { label: "preview-public", at: LABELED_2, by: "someone" },
        ],
      ],
      ["the label's events are not there", []],
    ] as const) {
      test(`does not open when ${name}`, async () => {
        await upAtA();
        await events(5, [...list]);
        await sync(ON);
        expect(await routes()).toEqual([]);
      });
    }

    test("opens when this machine's login put the label on last", async () => {
      await upAtA();
      await events(5, [
        { label: "preview-public", at: LABELED_1, by: "someone" },
        { label: "preview-public", at: LABELED_2, by: "owner" },
      ]);
      await sync(ON);
      expect(await routes()).toEqual([ROUTE]);
    });

    test("does not open when the label's events cannot be read", async () => {
      await upAtA();
      await rm(join(dir, "gh", "repos__owner___repo__issues_5_events.json"));
      const result = await sync(ON);
      expect(result.stdout).toContain(
        "pr-5: the outside label's events could not be read",
      );
      expect(await routes()).toEqual([]);
    });

    test("says once why someone else's label opens nothing", async () => {
      await upAtA("someone");
      await sync(ON);
      await sync(ON);
      expect(await routes()).toEqual([]);
      const posted = await writes();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("바깥 경로: 열지 않았다");
      expect(posted[0]).toContain("someone");
    });

    test("opens nothing for a fork's PR", async () => {
      await pulls([{ number: 5, head: HEAD_A, fork: true, labels: BOTH }]);
      await events(5, [
        { at: LABELED_1, by: "owner" },
        { label: "preview-public", at: LABELED_1, by: "owner" },
      ]);
      await sync(ON);
      expect(await lines("preview-calls")).toEqual([]);
      expect(await routes()).toEqual([]);
    });

    for (const [name, setup] of [
      [
        "a failed record at the namespace's head",
        () => state(5, `${HEAD_A} failed ${LABELED_1}`),
      ],
      [
        "a preview brought up by hand",
        () => namespaces([{ name: "pr-5", head: HEAD_A }]),
      ],
    ] as const) {
      test(`does not open ${name}`, async () => {
        await upAtA();
        await setup();
        await sync({ ...ON, STUB_UP_EXIT: "75" });
        expect(await routes()).toEqual([]);
      });
    }

    for (const [name, setup] of [
      [
        "someone else may push now",
        () =>
          gh("repos/{owner}/{repo}/collaborators", [
            { login: "owner", permissions: { push: true } },
            { login: "helper", permissions: { push: true } },
          ]),
      ],
      [
        "the head moved and was refused",
        async () => {
          await pulls([{ number: 5, head: HEAD_B, labels: BOTH }]);
          await gh("repos/{owner}/{repo}/collaborators", [
            { login: "owner", permissions: { push: true } },
            { login: "helper", permissions: { push: true } },
          ]);
        },
      ],
      [
        "the PR is closed",
        async () => {
          await pulls([]);
        },
      ],
    ] as const) {
      test(`closes an open route when ${name}`, async () => {
        await upAtA();
        await openRoute();
        await setup();
        await sync(ON);
        expect(await routes()).toEqual([]);
      });
    }

    for (const [name, setup] of [
      ["the list cannot be read", () => rm(join(dir, "gh", "pulls.json"))],
      ["the login cannot be read", () => rm(join(dir, "gh", "user.json"))],
      [
        "the pushers cannot be read",
        () => rm(join(dir, "gh", "repos__owner___repo__collaborators.json")),
      ],
      [
        "the list may be cut",
        () =>
          pulls(
            Array.from({ length: 500 }, (_, i) => ({
              number: i + 1,
              head: HEAD_A,
              labels: BOTH,
            })),
          ),
      ],
    ] as const) {
      test(`closes every route, writes nothing and keeps the preview when ${name}`, async () => {
        await upAtA();
        await openRoute();
        await setup();
        await sync(ON);
        expect(await routes()).toEqual([]);
        expect(await lines("preview-calls")).toEqual([]);
        expect(await writes()).toEqual([]);
        expect(
          await readFile(
            join(dir, "home", "sync", "pr-5.comment"),
            "utf8",
          ).catch(() => null),
        ).toBeNull();
      });
    }

    test("deletes routes of another domain, name or namespace", async () => {
      await upAtA();
      await route(ROUTE, "pr-5", "pr-5.old.example.dev");
      await route("x.preview-public-x.yaml", "x", "x.public.example.dev");
      await route("pr-6.other.yaml", "pr-6", "pr-6.public.example.dev");
      await sync(ON);
      // pr-5's is opened again under the current domain.
      expect(await routes()).toEqual([ROUTE]);
      expect(
        (await readFile(join(dir, "ingress", ROUTE), "utf8")).match(
          /- host: .*/g,
        ),
      ).toEqual(["- host: pr-5.public.example.dev"]);
    });

    test("does not open, and closes once, while the front login does not answer", async () => {
      await upAtA();
      await sync({ ...ON, STUB_GATE: "200 " });
      expect(await routes()).toEqual([]);
      expect(await writes()).toEqual([]);

      await sync(ON);
      expect(await routes()).toEqual([ROUTE]);
      for (const gate of ["404 ", "302 https://example.dev/login", ""]) {
        await sync({ ...ON, STUB_GATE: gate });
        expect(await routes()).toEqual([]);
      }
      const posted = await writes();
      expect(posted).toHaveLength(2);
      expect(posted[1]).toContain(
        "바깥 경로: 닫았다. 앞단의 로그인 확인에 실패했다.",
      );
    });

    test("forgets a refusal once the PR is no longer wanted", async () => {
      await upAtA("someone");
      await sync(ON);
      expect(
        await readFile(join(dir, "home", "sync", "pr-5.public"), "utf8"),
      ).toBe(`${LABELED_1}\n`);
      await pulls([{ number: 5, head: HEAD_A, labels: ["preview"] }]);
      await sync(ON);
      expect(
        await readFile(join(dir, "home", "sync", "pr-5.public"), "utf8").catch(
          () => null,
        ),
      ).toBeNull();
    });

    test("says down without the route line when the preview is gone", async () => {
      await upAtA();
      await openRoute();
      await sync(ON);
      // reap's TTL takes the namespace and its route.
      await namespaces([]);
      await rm(join(dir, "ingress", ROUTE));
      await sync(ON);
      const posted = await writes();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain("PR 미리보기: 내려갔다");
      expect(posted[0]).not.toContain("바깥 경로");
    });

    for (const [env, message] of [
      [
        { PREVIEW_PUBLIC_DOMAIN: "preview.example.dev" },
        "PREVIEW_PUBLIC_DOMAIN",
      ],
      [{ PREVIEW_PUBLIC_DOMAIN: "localhost" }, "PREVIEW_PUBLIC_DOMAIN"],
      [{ PREVIEW_PUBLIC_DOMAIN: "pr.localhost" }, "PREVIEW_PUBLIC_DOMAIN"],
      [
        { PREVIEW_PUBLIC_DOMAIN: "Public.Example.dev" },
        "PREVIEW_PUBLIC_DOMAIN",
      ],
      [{ PREVIEW_PUBLIC_LABEL: "preview" }, "PREVIEW_PUBLIC_LABEL must not be"],
      [{ PREVIEW_PUBLIC_LABEL: "a b" }, "PREVIEW_PUBLIC_LABEL must be a label"],
    ] as const) {
      test(`refuses ${JSON.stringify(env)}`, async () => {
        const result = await sync(env);
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(message);
        expect(await lines("preview-calls")).toEqual([]);
      });
    }
  });
});
