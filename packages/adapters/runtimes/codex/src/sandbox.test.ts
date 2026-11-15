import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUnsupportedFeaturesReason } from "@werft-ai/runtime-core";

import { probeSandbox, sandboxRefusal } from "./sandbox.ts";

function fakeCodex(script: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "codex-probe-")), "codex");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

const options = (command: string) => ({
  command,
  cwd: tmpdir(),
  env: { PATH: "/usr/bin:/bin" },
});

describe("probeSandbox", () => {
  test("passes when the sandboxed command exits 0, warnings or not", async () => {
    const codex = fakeCodex('echo "WARN something" >&2; exit 0');
    expect(await probeSandbox(options(codex))).toBeUndefined();
  });

  test("names bubblewrap's own line when the sandbox cannot start", async () => {
    const codex = fakeCodex(
      'echo "WARN proceeding" >&2; echo "bwrap: setting up uid map: Permission denied" >&2; echo "after" >&2; exit 1',
    );
    expect(await probeSandbox(options(codex))).toBe(
      "bwrap: setting up uid map: Permission denied",
    );
  });

  test("falls back to the exit status, a missing binary, or a hang", async () => {
    expect(await probeSandbox(options(fakeCodex("exit 3")))).toBe("exit 3");
    expect(
      await probeSandbox(options(join(tmpdir(), "no-such-codex"))),
    ).toContain("ENOENT");
    expect(
      await probeSandbox({
        ...options(fakeCodex("exec sleep 5")),
        timeoutMs: 100,
      }),
    ).toBe("no answer within 100 ms");
  });
});

test("the refusal stops the session as an unsupported setting and names the switch", () => {
  const reason = sandboxRefusal(
    "bwrap: Failed to make / slave: Permission denied",
  );
  expect(isUnsupportedFeaturesReason(reason)).toBe(true);
  expect(reason).toContain("codexSandbox.enabled=false");
  expect(reason).toContain("CODEX_SANDBOX=disabled");
  expect(reason.endsWith("Failed to make / slave: Permission denied")).toBe(
    true,
  );
});
