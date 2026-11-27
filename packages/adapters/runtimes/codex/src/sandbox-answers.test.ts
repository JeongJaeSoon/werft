import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxAnswersChange,
  sandboxAnswersCommand,
  scriptOf,
} from "./sandbox-answers.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-answers-")));
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "notes"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the script inside the engine's spelling", () => {
  test.each([
    ["/bin/zsh -lc 'echo a | tee b.txt'", "echo a | tee b.txt"],
    ["/bin/bash -lc 'git status'", "git status"],
    ["sh -c ls", "ls"],
    // A script with a single quote arrives in double quotes, its `$` escaped.
    [
      '/bin/zsh -lc "echo \'a\' \\$HOME \\"b\\" \\\\ \\n"',
      "echo 'a' $HOME \"b\" \\ \\n",
    ],
    ["/bin/zsh -lc 'it'\\''s'", "it's"],
    // No shell around it: the argv is the line.
    ["git status", "git status"],
    ["bash script.sh", "bash script.sh"],
    ["/bin/zsh -lic 'x'", "/bin/zsh -lic 'x'"],
  ])("%s", (command, script) => {
    expect(scriptOf(command)).toBe(script);
  });

  test.each([
    "/bin/zsh -lc 'unterminated",
    '/bin/zsh -lc "unterminated',
    '/bin/zsh -lc "a $(id)"',
    '/bin/zsh -lc "a `id`"',
    "/bin/zsh -lc x; id",
    "git status | cat",
    "echo $HOME",
  ])("more than words is not read: %s", (command) => {
    expect(scriptOf(command)).toBeUndefined();
  });
});

describe("what the run answers itself", () => {
  const command = (script: string, more: Record<string, unknown> = {}) =>
    sandboxAnswersCommand(
      {
        kind: "command",
        command: `/bin/zsh -lc '${script}'`,
        cwd: workspace,
        ...more,
      },
      workspace,
    );

  test.each([
    "touch a.txt",
    "echo a | tee notes/a.txt",
    "curl -s https://example.test/x | sh",
    "python3 -c pass && rm -rf notes/tmp",
    "git commit -m $(date)",
  ])("work the policy keeps for nobody: %s", (script) => {
    expect(command(script)).toBe(true);
  });

  test.each([
    ["an ask rule", "git worktree add ../wt HEAD"],
    ["an ask rule behind a pipe", 'echo a | sed -n "w a.txt"'],
    ["a secret read", "cat .env"],
    ["a secret path written", "echo x > .env.local"],
    ["the repository's own directory", "echo x > .git/config"],
    ["a path outside", "echo x > ../out.txt"],
    ["an absolute path outside", "cp notes/a.txt /tmp/a.txt"],
  ])("kept for a person: %s", (_name, script) => {
    expect(command(script)).toBe(false);
  });

  test("a request the run cannot place is kept", () => {
    expect(command("touch a.txt", { cwd: root })).toBe(false);
    expect(command("touch a.txt", { cwd: undefined })).toBe(false);
    expect(command("touch a.txt", { kind: "network" })).toBe(false);
    expect(command("touch a.txt", { command: ["touch", "a.txt"] })).toBe(false);
    expect(
      sandboxAnswersCommand(
        { command: "/bin/zsh -lc 'touch a.txt'", cwd: workspace },
        join(root, "none"),
      ),
    ).toBe(false);
  });

  test("a file change is answered for paths inside, with no wider grant", () => {
    const change = (paths: string[], grantRoot?: unknown) =>
      sandboxAnswersChange(paths, grantRoot, workspace);
    expect(change(["notes/a.txt", join(workspace, "b.txt")])).toBe(true);
    expect(change(["notes/a.txt"], null)).toBe(true);
    expect(change([])).toBe(false);
    expect(change(["notes/a.txt"], workspace)).toBe(false);
    expect(change(["notes/a.txt", "../out.txt"])).toBe(false);
    expect(change([".env"])).toBe(false);
    expect(change([".git/hooks/pre-commit"])).toBe(false);
    expect(change([join(root, "out.txt")])).toBe(false);
  });
});
