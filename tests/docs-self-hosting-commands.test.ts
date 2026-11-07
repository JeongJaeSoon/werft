import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pages from "./fixtures/self-hosting-pages.json";

const root = join(
  import.meta.dir,
  "../apps/docs/content/docs/run-server/self-hosting",
);

function blocks(path: string, languages: string) {
  const text = readFileSync(join(root, `${path}.mdx`), "utf8");
  return [
    ...text.matchAll(
      new RegExp(
        `^\x60\x60\x60(?:${languages})\\n([\\s\\S]*?)^\x60\x60\x60$`,
        "gm",
      ),
    ),
  ].map((match) => match[1] ?? "");
}

describe("self-hosting command fixtures", () => {
  test("an existing XFS image stops before any mutation", () => {
    const scratch = join(import.meta.dir, "../.selfhost-verify");
    mkdirSync(scratch, { recursive: true });
    const dir = mkdtempSync(join(scratch, "xfs-"));
    const image = join(dir, "docker.xfs.img");
    writeFileSync(image, "original workspace data");
    try {
      const block = blocks("prepare-xfs", "bash").find((block) =>
        block.includes("set -eu"),
      );
      expect(block).toBeDefined();
      const input = [
        `docker() { printf '%s\\n' '${dir}/docker'; }`,
        'sudo() { if [ "$1" = test ]; then "$@"; else echo "mutation attempted"; return 99; fi; }',
        block?.replaceAll("/var/lib/docker", `${dir}/docker`),
      ].join("\n");
      const result = spawnSync("bash", [], {
        input,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("mutation attempted");
      expect(readFileSync(image, "utf8")).toBe("original workspace data");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("shell examples parse after replacing reader placeholders", () => {
    let checked = 0;
    for (const page of pages) {
      for (const block of blocks(page.path, "bash|sh")) {
        const input = block.replace(/<[^>\n]+>/g, "fixture");
        const result = spawnSync("bash", ["-n"], { input, encoding: "utf8" });
        expect(`${page.path}: ${result.stderr}`).toBe(`${page.path}: `);
        expect(result.status).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  test("JSON examples remain valid documents", () => {
    for (const page of pages) {
      for (const block of blocks(page.path, "json"))
        expect(() => JSON.parse(block)).not.toThrow();
    }
  });

  test("deployment builds keep the control host on the release target", () => {
    const block = blocks("build-images", "bash").find((block) =>
      block.includes("export API_IMAGE="),
    );
    expect(block).toBeDefined();
    const result = spawnSync("bash", [], {
      input: [
        'docker() { printf "%s\\n" "$*"; }',
        block?.replace(/<[^>\n]+>/g, "fixture"),
      ].join("\n"),
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "build -f apps/control-host/Dockerfile --target release",
    );
    expect(result.stdout).toContain("-t fixture/werft-control-host:rc .");
    expect(result.stdout).toContain(
      "compose -f infra/compose.yml --profile worker build worker egress-proxy",
    );
    expect(result.stdout).not.toMatch(/compose[^\n]*build[^\n]*\bapi\b/);
  });

  test("kind dependencies must be ready before Helm can start", () => {
    const block = blocks("try-kind", "bash").find((block) =>
      block.includes("apply -f deploy/kind/deps.yaml"),
    );
    expect(block).toBeDefined();
    for (const failed of ["", "deploy/postgres", "deploy/localstack"]) {
      const input = [
        "git() { :; }; cd() { :; }; kind() { :; }; mktemp() { printf fixture; }",
        `kubectl() { printf '%s\\n' "$*"; [ "$5" != '${failed}' ]; }`,
        block,
        "printf '%s\\n' 'dependencies ready; Helm may start'",
      ].join("\n");
      const result = spawnSync("bash", [], {
        input,
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.stdout).toContain(
        "rollout status deploy/postgres --timeout=300s",
      );
      expect(result.status).toBe(failed === "" ? 0 : 1);
      expect(result.stdout.includes("dependencies ready; Helm may start")).toBe(
        failed === "",
      );
      if (failed !== "deploy/postgres")
        expect(result.stdout).toContain(
          "rollout status deploy/localstack --timeout=300s",
        );
    }
  });

  test("a failed readiness check stops its own port-forward and returns failure", () => {
    const block = blocks("kubernetes", "bash").find((block) =>
      block.includes("PF=$!"),
    );
    expect(block).toBeDefined();
    // Only the fixture's recorded child PID is killed. No cluster, network or
    // Docker service is used; the document's cleanup branch runs unchanged.
    const input = [
      "kubectl() { exec /bin/sleep 30; }",
      "curl() { return 1; }",
      "seq() { printf '1\\n'; }",
      "sleep() { :; }",
      block,
      "RESULT=$?",
      'wait "$PF" 2>/dev/null || true',
      'if kill -0 "$PF" 2>/dev/null; then echo "child survived"; exit 99; fi',
      'echo "recorded child stopped; readiness result=$RESULT"',
      'exit "$RESULT"',
    ].join("\n");
    const result = spawnSync("bash", [], {
      input,
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "recorded child stopped; readiness result=1",
    );
  });
});
