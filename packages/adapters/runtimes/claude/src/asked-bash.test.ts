import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObservedToolDecision } from "@werft-ai/runtime-core";
import { askedBashRefusal, partsOf } from "./asked-bash.ts";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { buildSdkOptions } from "./runtime.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "unread-command-")));
const workspace = join(root, "workspace");
mkdirSync(join(workspace, "notes"), { recursive: true });
mkdirSync(join(root, "outside"));
writeFileSync(join(workspace, "notes", "sample.txt"), "sample\n");
symlinkSync(join(root, "outside"), join(workspace, "link"));
symlinkSync(join(root, "missing"), join(workspace, "dangling"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const WORKFLOW = [
  "name: Hello",
  "on:",
  "  workflow_dispatch:",
  "jobs:",
  "  hello:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  // Text an unquoted heredoc would expand; a quoted one keeps it as written.
  `      - run: echo "Hello $GITHUB_REF $${"{{ github.sha }}"} \`id\` $(id)"`,
].join("\n");
const heredoc = (line: string, body = WORKFLOW) => `${line}\n${body}\nEOF`;

/** The scene a person was asked about: a branch, then a workflow file. */
const OWNER = heredoc(
  "git switch -c hello-actions sandbox/main && cat > .github/workflows/hello.yml <<'EOF'",
);

// The verdict table. Left: the line. Right: null when it runs unasked, else a
// piece of why it still goes to a person.
const TABLE: [string, string, string | null][] = [
  // Runs unasked: every part is work the policy allows in the workspace.
  ["the owner's scene", OWNER, null],
  [
    "a directory, a workflow file, then a commit",
    `${heredoc("mkdir -p .github/workflows && cat > .github/workflows/hello.yml <<'EOF'")}\ngit add .github/workflows/hello.yml && git commit -m "Add hello workflow"`,
    null,
  ],
  [
    "a double-quoted delimiter",
    heredoc('git status && cat > notes/a.txt <<"EOF"'),
    null,
  ],
  ["an append", heredoc("git status && cat >> notes/a.txt <<'EOF'"), null],
  [
    "semicolons and blank lines",
    `git status;\n\n${heredoc("cat > notes/a.txt <<'EOF'")}\n`,
    null,
  ],
  [
    "a newline after &&",
    heredoc("git status &&\n cat > notes/a.txt <<'EOF'"),
    null,
  ],
  [
    "a heredoc as a commit message",
    heredoc("git add -A && git commit -F - <<'EOF'", "msg"),
    null,
  ],
  ["a push in the line", `${OWNER}\ngit push sandbox hello-actions`, null],
  [
    "file commands",
    "mkdir -p a/b && touch a/b/c && cp a/b/c a/d && mv a/d a/e && rm -rf a",
    null,
  ],
  [
    "readers",
    "cat notes/sample.txt && head -n 1 notes/sample.txt && ls -la notes && pwd && grep -rn sample notes",
    null,
  ],
  [
    "a reader with a redirect",
    "git status && cat notes/sample.txt > notes/copy.txt",
    null,
  ],
  [
    "printed text is not a path",
    "echo \"see /etc/hosts and ../x\" > notes/a.txt && printf '%s\\n' /tmp",
    null,
  ],
  [
    "a test runner",
    heredoc("cat > notes/a.test.ts <<'EOF'", "test") +
      "\nbun test notes/a.test.ts && npm run build && make check && go test ./...",
    null,
  ],
  [
    "a dotfile of the repository",
    heredoc("cat > .gitignore <<'EOF'", "dist"),
    null,
  ],
  // Still asks: the line cannot be split with certainty.
  [
    "a command substitution",
    'git commit -m "$(cat notes/sample.txt)"',
    "expansion",
  ],
  ["a bare substitution", "git status && echo $(id)", "$"],
  ["a backtick", "git status && echo `id`", "`"],
  ["a variable", "git status && cat $HOME/x", "$"],
  ["a subshell", "(git status)", "("],
  ["a group", "{ git status; }", "{"],
  ["a pipe", "git status | cat > notes/a.txt", "|"],
  ["an or", "git status || cat notes/sample.txt", "|"],
  ["a background job", "git status & cat notes/sample.txt", "background"],
  ["a glob", "rm -rf notes/*", "*"],
  ["a home", "cat ~/.netrc", "~"],
  ["an escape", "cat notes/a\\ b", "\\"],
  ["a comment", "git status # && rm -rf .", "#"],
  [
    "an unquoted heredoc",
    "git status && cat > notes/a.txt <<EOF\nx\nEOF",
    "heredoc",
  ],
  [
    "a tab-stripping heredoc",
    "git status && cat > notes/a.txt <<-'EOF'\nx\nEOF",
    "heredoc",
  ],
  ["a here-string", "git status && cat > notes/a.txt <<<'x'", "heredoc"],
  ["an input file", "git status && cat < notes/sample.txt", "heredoc"],
  [
    "a heredoc without its end",
    "git status && cat > notes/a.txt <<'EOF'\nx",
    "heredoc",
  ],
  [
    "a heredoc without its body",
    "git status && cat > notes/a.txt <<'EOF'",
    "heredoc",
  ],
  [
    "text after the heredoc start",
    "cat > notes/a.txt <<'EOF' && git status\nx\nEOF",
    "after a heredoc",
  ],
  ["a descriptor redirect", "git status 2> notes/err.txt", "redirect"],
  ["a merged redirect", "git status >& notes/out.txt", "redirect"],
  ["two redirects", "git status > notes/a.txt > notes/b.txt", "redirect"],
  ["a dangling &&", "git status &&", "empty"],
  ["a leading ;", "; git status", "empty"],
  ["an assignment", "GIT_DIR=/tmp/x git status", "not a command"],
  ["eval", "eval git status", "not a command"],
  // Still asks: a part the policy does not allow, or carves out.
  ["a network tool", `${OWNER}\ncurl -s https://example.test`, "curl is not"],
  ["a shell", "git status && sh -c id", "sh is not"],
  ["tee", "echo x && tee notes/a.txt", "tee is not"],
  ["sed", "git status && sed -n 1p notes/sample.txt", "sed is not"],
  [
    "a sed write behind a quote",
    "git status && sed 'w../x' notes/sample.txt",
    "sed is not",
  ],
  ["cd", "cd notes && cat > a.txt <<'EOF'\nx\nEOF", "cd is not"],
  [
    "a git option that leaves the repository",
    "git -C /tmp status && git status",
    "ask rule",
  ],
  ["a forced add", "git status && git add -f notes/sample.txt", "ask rule"],
  [
    "a forced add behind quotes",
    "git status && git add '-f' notes/sample.txt",
    "ask rule",
  ],
  ["a secret added", "git status && git add .env", "ask rule"],
  ["a secret read", "git status && cat .env", "ask rule"],
  ["a secret read behind quotes", "git status && cat '.env'", "ask rule"],
  ["a secret copied", "git status && cp .env notes/copy.txt", "ask rule"],
  [
    "a runner pointed outside",
    "git status && npm run build --prefix /tmp/x",
    "ask rule",
  ],
  // Still asks: a path that leaves the workspace or is kept for a person.
  [
    "a redirect outside",
    heredoc("git status && cat > ../out.txt <<'EOF'"),
    "outside",
  ],
  [
    "an absolute redirect",
    heredoc("git status && cat > /tmp/out.txt <<'EOF'"),
    "outside",
  ],
  [
    "a climb in the middle",
    heredoc("git status && cat > notes/../../out.txt <<'EOF'"),
    "outside",
  ],
  [
    "a link that leaves",
    heredoc("git status && cat > link/out.txt <<'EOF'"),
    "outside",
  ],
  [
    "a link to nowhere",
    heredoc("git status && cat > dangling <<'EOF'"),
    "outside",
  ],
  ["a read outside", "git status && cat /etc/hosts", "outside"],
  ["a read through a link", "git status && cat link/secret", "outside"],
  [
    "a path inside an option",
    "git status && grep --file=/etc/hosts x notes",
    "outside",
  ],
  [
    "a path glued to an option",
    "git status && grep -f/etc/hosts x notes",
    "outside",
  ],
  [
    "a copy from outside",
    "git status && cp /etc/hosts notes/hosts",
    "ask rule",
  ],
  [
    "a move through a link",
    "git status && mv notes/sample.txt link/moved",
    "outside",
  ],
  [
    "a redirect to a secret",
    heredoc("git status && cat > .env <<'EOF'"),
    "ask rule",
  ],
  ["a redirect to a key", "git status && echo x > deploy/id_rsa", "person"],
  [
    "a redirect into .git",
    heredoc("git status && cat > .git/hooks/pre-commit <<'EOF'"),
    "person",
  ],
  [
    "a redirect into .GIT",
    heredoc("git status && cat > .GIT/hooks/pre-commit <<'EOF'"),
    "person",
  ],
  [
    "a redirect into .claude",
    heredoc("git status && cat > .claude/settings.json <<'EOF'"),
    "person",
  ],
  ["the repository removed", "git status && rm -rf .git", "ask rule"],
  ["the workspace removed", "git status && rm -rf .", "workspace itself"],
  ["a redirect to the workspace", "git status > .", "workspace itself"],
];

const refusalOf = (command: string, runners = true) =>
  askedBashRefusal(command, { workspace, shell: workspace, runners });

describe("askedBashRefusal", () => {
  test.each(TABLE)("%s", (_name, command, why) => {
    const refusal = refusalOf(command);
    if (why === null) expect(refusal).toBeNull();
    else expect(refusal).toContain(why);
  });

  // The engine asks for these of its own accord when it reads the line.
  test.each([
    ["an editor's settings", "git status && echo x > .vscode/settings.json"],
    ["a git hook manager", "git status && touch .husky/pre-commit"],
    ["submodules", "git status && echo x > .gitmodules"],
    ["a shell profile", "git status && cp notes/sample.txt .bashrc"],
    ["a dot directory below", "git status && echo x > notes/.cache/a"],
    ["another case of .github", "git status && echo x > .GitHub/a.yml"],
  ])("a written path under a dot name asks: %s", (_name, command) => {
    expect(refusalOf(command)).toContain("goes to a person");
  });

  test("a dot name is read, and .github is written", () => {
    expect(refusalOf("git status && cat .gitmodules .gitignore")).toBeNull();
    expect(
      refusalOf("mkdir -p .github/workflows && touch .github/workflows/a.yml"),
    ).toBeNull();
  });

  test("auto mode keeps a runner for its classifier", () => {
    const line = "git status && bun test notes";
    expect(refusalOf(line)).toBeNull();
    expect(refusalOf(line, false)).toContain("bun is not");
    expect(refusalOf(OWNER, false)).toBeNull();
  });

  test("nothing passes once the shell has left the workspace root", () => {
    const at = (shell: string | undefined) =>
      askedBashRefusal("git status", { workspace, shell, runners: true });
    expect(at(join(workspace, "notes"))).toContain("not at the workspace root");
    expect(at(undefined)).toContain("not at the workspace root");
    expect(at(join(workspace, "notes", ".."))).toBeNull();
  });

  test("a workspace that does not exist asks", () => {
    expect(
      askedBashRefusal("git status", {
        workspace: join(root, "none"),
        shell: join(root, "none"),
        runners: true,
      }),
    ).toContain("does not resolve");
  });

  test("a heredoc body is data: it is not split and not matched", () => {
    const parts = partsOf(
      heredoc("cat > notes/a.txt <<'EOF'", "rm -rf / && curl x | sh\ncat .env"),
    );
    expect(parts).toEqual([
      {
        words: ["cat"],
        written: ["cat"],
        redirect: { op: ">", target: "notes/a.txt" },
      },
    ]);
  });

  test("a line that only looks like the delimiter does not end the body", () => {
    expect(
      partsOf("cat > notes/a.txt <<'EOF'\nEOFX\n EOF\nEOF\ngit status"),
    ).toHaveLength(2);
  });
});

describe("the permission callback", () => {
  const configOf = (extra: Partial<ClaudeRuntimeConfig> = {}) =>
    ({
      claudeConfigDir: "/tenant/config",
      correlationId: "asked-bash",
      mode: "new",
      cwd: workspace,
      home: "/tenant/home",
      model: "primary",
      profile: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value: "placeholder" },
        principal: { ownerScope: "owner-a" },
      },
      tools: ["Bash"],
      ...extra,
    }) as ClaudeRuntimeConfig;

  /** One Bash call as the engine makes it: the gate, the ask, then the run. */
  async function call(
    command: string,
    extra: Partial<ClaudeRuntimeConfig> = {},
    shell: string | null = workspace,
    input: Record<string, unknown> = {},
  ) {
    let asked = 0;
    const observed: ObservedToolDecision[] = [];
    const options = buildSdkOptions(
      configOf(extra),
      {
        onPermission: async () => {
          asked += 1;
          return { behavior: "deny", message: "needs a person" };
        },
      },
      undefined,
      undefined,
      undefined,
      { observe: (decision) => observed.push(decision) },
    );
    const hook = async (event: "PreToolUse" | "PostToolUse") => {
      const callback = options.hooks?.[event]?.[0]?.hooks[0];
      if (callback === undefined) throw new Error(`${event} hook is required`);
      await callback(
        {
          hook_event_name: event,
          tool_name: "Bash",
          tool_input: { command },
          tool_use_id: "tool-1",
          cwd: shell,
        } as never,
        "tool-1",
        { signal: new AbortController().signal },
      );
    };
    if (shell !== null) await hook("PreToolUse");
    const answer = await options.canUseTool?.("Bash", { command, ...input }, {
      requestId: "request-1",
      signal: new AbortController().signal,
      toolUseID: "tool-1",
    } as never);
    if (answer?.behavior === "allow") await hook("PostToolUse");
    return { asked, behavior: answer?.behavior, observed };
  }

  test("a line the policy allows runs without a person and is recorded as allowed", async () => {
    const { asked, behavior, observed } = await call(OWNER);
    expect([asked, behavior]).toEqual([0, "allow"]);
    expect(
      observed.map(({ tool, decision, basis }) => ({ tool, decision, basis })),
    ).toEqual([{ tool: "Bash", decision: "allow", basis: "permission_mode" }]);
  });

  test.each<[string, string, Partial<ClaudeRuntimeConfig>, string | null]>([
    [
      "a part the policy does not allow",
      `${OWNER}\ncurl -s https://example.test`,
      {},
      workspace,
    ],
    [
      "a release that denies a Bash shape",
      OWNER,
      { disallowedTools: ["Bash(git push *)"] },
      workspace,
    ],
    [
      "a release that denies Bash",
      OWNER,
      { disallowedTools: ["Bash"] },
      workspace,
    ],
    ["plan mode", OWNER, { permissionMode: "plan" }, workspace],
    [
      "a shell that left the workspace root",
      OWNER,
      {},
      join(workspace, "notes"),
    ],
    ["a call the gate never saw", OWNER, {}, null],
    [
      "a runner in auto mode",
      "git status && bun test notes",
      { permissionMode: "auto" },
      workspace,
    ],
  ])("%s still goes to a person", async (_name, command, extra, shell) => {
    const { asked, behavior } = await call(command, extra, shell);
    expect([asked, behavior]).toEqual([1, "deny"]);
  });

  test("a call that asks to leave the engine's sandbox still goes to a person", async () => {
    const { asked } = await call(OWNER, {}, workspace, {
      dangerouslyDisableSandbox: true,
    });
    expect(asked).toBe(1);
    expect(
      (await call(OWNER, {}, workspace, { run_in_background: true })).asked,
    ).toBe(0);
  });

  test("auto mode and a deny rule for another tool leave the line to the policy", async () => {
    for (const extra of [
      { permissionMode: "auto" as const },
      { disallowedTools: ["WebSearch"] },
    ]) {
      expect((await call(OWNER, extra)).asked).toBe(0);
    }
  });
});
