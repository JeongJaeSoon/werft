import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../.github/scripts/image-cache-to.sh");
const write =
  "to=type=gha,scope=images-worker-amd64,mode=min,ignore-error=true\n";

// A fake gh on PATH: answers GH_ANSWER, exits GH_EXIT, records its arguments.
function run(answer: string, exit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "image-cache-to-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${dir}/args"\nprintf '%s' "$GH_ANSWER"\nexit "$GH_EXIT"\n`,
    );
    chmodSync(gh, 0o755);
    const result = Bun.spawnSync(["bash", script], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        APP: "worker",
        ARCH: "amd64",
        TODAY: "2026-11-28",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_REF: "refs/heads/main",
        GH_ANSWER: answer,
        GH_EXIT: String(exit),
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      args: readFileSync(join(dir, "args"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a scope already written today on this ref is only read", () => {
  const result = run("2026-11-28T00:19:30Z");
  expect(result).toMatchObject({ exitCode: 0, stdout: "to=\n" });
  expect(result.args).toContain("key=index-images-worker-amd64-");
  expect(result.args).toContain("ref=refs/heads/main");
  expect(result.args).toContain("sort=created_at");
});

test("the first build of the day, or of a scope never written, writes it", () => {
  for (const answer of ["2026-11-27T23:59:59Z", ""])
    expect(run(answer)).toMatchObject({ exitCode: 0, stdout: write });
});

// The cache is a speed-up: a listing that fails writes as before and never
// fails the build, and the write itself ignores upload errors.
test("a failed cache listing writes as before and exits 0", () => {
  expect(run("HTTP 403", 1)).toMatchObject({ exitCode: 0, stdout: write });
});
