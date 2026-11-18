import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * tests/e2e/run.sh's retry around its pull and build steps, against a stand-in
 * command that prints what the steps print, one line per try.
 */
const LIB = join(import.meta.dir, "fetch-retry.sh");
const SPAWN_TIMEOUT_MS = 15_000;

// Lines as compose and buildkit printed them on CI runners.
const CACHE_EXPIRED =
  "target migrate: failed to solve: failed to compute cache key: failed to copy: GET https://example.invalid/actions-cache/1\nRESPONSE 403: 403 Server failed to authenticate the request.\nERROR CODE: AuthenticationFailed";
const PULL_RESET =
  "failed to copy: read tcp 10.0.0.1:46308->192.0.2.1:443: read: connection reset by peer";
const BUILD_ERROR =
  'target api: failed to solve: process "/bin/sh -c bun run build" did not complete successfully: exit code: 1';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fetch-retry-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// `outputs` holds what each try prints, the last one repeating; `exits` the
// matching statuses.
function run(outputs: string[], exits: number[]) {
  const script = `
    . "$LIB"
    step() {
      n=$(( $(cat tries 2>/dev/null || echo 0) + 1 ))
      echo "$n" >tries
      i=$(( n < \${#OUTS[@]} ? n - 1 : \${#OUTS[@]} - 1 ))
      printf '%s\\n' "\${OUTS[$i]}"
      return "\${EXITS[$i]}"
    }
    OUTS=(${outputs.map((_, i) => `"$OUT${i}"`).join(" ")})
    EXITS=(${exits.join(" ")})
    fetch_retried "$PWD/step.log" step
  `;
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", LIB };
  outputs.forEach((out, i) => {
    env[`OUT${i}`] = out;
  });
  const result = Bun.spawnSync(["bash", "-c", script], {
    cwd: dir,
    env,
    timeout: SPAWN_TIMEOUT_MS,
  });
  return {
    status: result.exitCode,
    tries: Number(readFileSync(join(dir, "tries"), "utf8")),
    log: readFileSync(join(dir, "step.log"), "utf8"),
    stderr: result.stderr.toString(),
  };
}

describe("fetch_retried", () => {
  test(
    "tries a step again after a cache URL expired or a pull was reset, and keeps every try's output",
    () => {
      const result = run(
        [CACHE_EXPIRED, PULL_RESET, "Container up"],
        [1, 1, 0],
      );
      expect(result).toMatchObject({ status: 0, tries: 3 });
      expect(result.log).toContain("AuthenticationFailed");
      expect(result.log).toContain("connection reset by peer");
      expect(result.log).toContain("Container up");
      expect(result.stderr).toContain("trying again (2/3)");
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "fails a build error on its first try",
    () => {
      expect(run([BUILD_ERROR], [17])).toMatchObject({ status: 17, tries: 1 });
    },
    SPAWN_TIMEOUT_MS,
  );

  test(
    "stops after three transfer failures with the step's own status",
    () => {
      expect(run([PULL_RESET], [18])).toMatchObject({ status: 18, tries: 3 });
    },
    SPAWN_TIMEOUT_MS,
  );
});
