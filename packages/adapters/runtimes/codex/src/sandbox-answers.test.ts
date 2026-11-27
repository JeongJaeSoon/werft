import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changeTargets,
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
    ["make -C notes build", "make -C notes build"],
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
    "git sta\\\ntus",
    '/bin/zsh -lc "git sta\\\ntus"',
    // A shell started in a form whose script is not certain.
    "bash script.sh",
    "/bin/zsh -lic 'x'",
    "bash --login -c 'x'",
    "bash -c 'git status' name",
    "/usr/bin/env bash -c 'git status'",
    "sudo touch a.txt",
  ])("what does not read back as one script is not read: %s", (command) => {
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
    ["an ask rule inside a wrapper", "command git add -f notes/a.txt"],
    ["a move of the shell to a kept place", "cd .git && echo x > config"],
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
    const add = (path: string) => ({ path, kind: "add", diff: "+x" });
    const change = (changes: unknown, grantRoot?: unknown) =>
      sandboxAnswersChange(changes, grantRoot, workspace);
    expect(change([add("notes/a.txt"), add(join(workspace, "b.txt"))])).toBe(
      true,
    );
    expect(change([add("notes/a.txt")], null)).toBe(true);
    expect(change([{ path: "notes/a.txt", kind: { type: "delete" } }])).toBe(
      true,
    );
    expect(change([])).toBe(false);
    expect(change(undefined)).toBe(false);
    expect(change([add("notes/a.txt")], workspace)).toBe(false);
    expect(change([add("notes/a.txt"), add("../out.txt")])).toBe(false);
    for (const kept of [
      ".env",
      ".git/hooks/pre-commit",
      join(root, "out.txt"),
    ]) {
      expect(change([add(kept)])).toBe(false);
    }
  });

  test("a move is judged by where it goes as well", () => {
    const move = (to: unknown, key = "move_path") => [
      { path: "notes/a.txt", kind: { type: "update", [key]: to }, diff: "" },
    ];
    expect(changeTargets(move("notes/b.txt"))).toEqual([
      "notes/a.txt",
      "notes/b.txt",
    ]);
    expect(changeTargets(move(null))).toEqual(["notes/a.txt"]);
    // A destination beside the kind is read as well.
    const beside = [{ path: "notes/a.txt", kind: "update", movePath: ".env" }];
    expect(changeTargets(beside)).toEqual(["notes/a.txt", ".env"]);
    expect(sandboxAnswersChange(beside, null, workspace)).toBe(false);
    expect(sandboxAnswersChange(move("notes/b.txt"), null, workspace)).toBe(
      true,
    );
    for (const to of [".env", "../out.txt", join(root, "out.txt")]) {
      expect(sandboxAnswersChange(move(to), null, workspace)).toBe(false);
      expect(sandboxAnswersChange(move(to, "movePath"), null, workspace)).toBe(
        false,
      );
    }
  });

  test("a change record in a shape this does not know is not answered", () => {
    for (const changes of [
      [{ kind: "add", diff: "+x" }],
      [{ path: "notes/a.txt" }],
      [{ path: "notes/a.txt", kind: "rename" }],
      [{ path: "notes/a.txt", kind: { type: "update", to: "notes/b.txt" } }],
      [{ path: "notes/a.txt", kind: { type: "update", move_path: 7 } }],
      [{ path: "notes/a.txt", kind: "add" }, "junk"],
      [{ path: "notes/a.txt", kind: {} }],
      [{ path: "notes/a.txt", kind: "update", type: "rename" }],
      [{ path: "notes/a.txt", kind: { type: "update", diff: "x" } }],
      [{ path: "notes/a.txt", kind: [] }],
      [{ path: "notes/a.txt", kind: "update", target: "notes/b.txt" }],
      "notes/a.txt",
    ]) {
      expect(changeTargets(changes)).toBeUndefined();
      expect(sandboxAnswersChange(changes, null, workspace)).toBe(false);
    }
  });
});
