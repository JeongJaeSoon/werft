import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { PermissionMode } from "./config.ts";
import { ClaudeSdkRuntime } from "./runtime.ts";

const MODEL = "claude-sonnet-4-5";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

type Step = {
  /** Whether the engine puts the call to a person. */
  asks: boolean;
  /** What the call did, read from the disk afterwards. */
  effect?: (root: string, workspace: string) => Promise<boolean>;
  id: string;
  input: (root: string, workspace: string) => Record<string, unknown>;
  name: string;
  /** Text the tool result must hold: a call that was not asked also ran. */
  output?: string;
  /** The step only means something in this mode. */
  onlyIn?: PermissionMode;
};

const fileExists = (path: (root: string, workspace: string) => string) => {
  return async (root: string, workspace: string) =>
    existsSync(path(root, workspace));
};

const bash = (
  id: string,
  command: string,
  asks: boolean,
  output?: string,
): Step => ({
  asks,
  id,
  input: () => ({ command, description: id }),
  name: "Bash",
  ...(output === undefined ? {} : { output }),
});

const steps: Step[] = [
  {
    asks: false,
    effect: fileExists((_, w) => join(w, "notes", "sample.txt")),
    id: "write_inside",
    input: (_, w) => ({
      content: "sample\n",
      file_path: join(w, "notes", "sample.txt"),
    }),
    name: "Write",
  },
  {
    asks: true,
    effect: fileExists((r) => join(r, "outside.txt")),
    id: "write_outside",
    input: (r) => ({ content: "x\n", file_path: join(r, "outside.txt") }),
    name: "Write",
  },
  {
    asks: true,
    effect: fileExists((r) => join(r, "dotdot.txt")),
    id: "write_dotdot",
    input: (_, w) => ({
      content: "x\n",
      file_path: join(w, "..", "dotdot.txt"),
    }),
    name: "Write",
  },
  {
    asks: true,
    effect: fileExists((r) => join(r, "target", "escaped.txt")),
    id: "write_symlink_escape",
    input: (_, w) => ({
      content: "x\n",
      file_path: join(w, "link", "escaped.txt"),
    }),
    name: "Write",
  },
  {
    asks: true,
    effect: fileExists((_, w) => join(w, ".env")),
    id: "write_dotenv",
    input: (_, w) => ({ content: "KEY=1\n", file_path: join(w, ".env") }),
    name: "Write",
  },
  {
    asks: true,
    effect: fileExists((_, w) => join(w, ".git", "hooks", "pre-commit")),
    id: "write_git_hook",
    input: (_, w) => ({
      content: "#!/bin/sh\n",
      file_path: join(w, ".git", "hooks", "pre-commit"),
    }),
    name: "Write",
  },
  bash(
    "git_add_commit",
    "git add notes/sample.txt && git commit -q -m 'docs: sample' && git log --oneline -1",
    false,
  ),
  bash("git_branch_switch", "git switch -c feature/sample", false),
  bash("git_stash", "git stash list", false),
  bash("git_restore_staged", "git restore --staged notes/sample.txt", false),
  bash("dev_command_inside", "bun test --help", false),
  bash("redirect_inside", "git status > status.txt", false),
  // The e2e flows, the verify skill and the docs ask for a permission with
  // these; if the rules ever cover them, those flows hang waiting for a card.
  bash("ask_vehicle_tee", "echo alpha | tee hello.txt", true),
  bash("ask_vehicle_tee_append", "echo beta | tee -a hello.txt", true),
  // acceptEdits lets the engine touch files in the working directory itself.
  { ...bash("ask_vehicle_touch", "touch a.txt", true), onlyIn: "default" },
  // Each of these would delete work that no object or reflog keeps, or leave
  // the repository, with the flag in a place a prefix match would miss.
  bash("git_checkout_discard", "git checkout -- notes/sample.txt", true),
  bash("git_restore_worktree", "git restore notes/sample.txt --worktree", true),
  bash(
    "git_restore_both",
    "git restore --staged --worktree notes/sample.txt",
    true,
  ),
  // Abbreviated and bundled options reach the same behavior as the long ones.
  bash(
    "git_restore_abbreviated",
    "git restore --staged --worktre notes/sample.txt",
    true,
  ),
  bash("git_switch_detach_force", "git switch -df main", true),
  bash("git_add_abbreviated_force", "git add --forc notes/sample.txt", true),
  bash("git_add_bundled_force", "git add -fA notes/sample.txt", true),
  bash("git_checkout_new_branch", "git checkout -b feature/second", false),
  bash("git_checkout_path_bare", "git checkout notes/sample.txt", true),
  bash("git_checkout_head_path", "git checkout HEAD notes/sample.txt", true),
  bash("git_checkout_dir", "git checkout ./", true),
  bash("git_checkout_bundled_force", "git checkout -qf main", true),
  bash("git_switch_bundled_force", "git switch -qf main", true),
  bash(
    "git_restore_bundled",
    "git restore --staged -SW notes/sample.txt",
    true,
  ),
  bash("git_checkout_force_late", "git checkout main --force", true),
  bash("git_switch_discard_late", "git switch main --discard-changes", true),
  bash("git_branch_delete_late", "git branch feature/sample -D", true),
  bash("git_stash_drop", "git stash drop", true),
  bash("git_add_dotenv", "git add .env", true),
  bash("git_add_credentials", "git add config/service-account.json", true),
  bash("git_add_npmrc", "git add .npmrc", true),
  bash("git_add_p12", "git add signing.p12", true),
  bash("git_commit_secret_path", 'git commit -m "update config" .env', true),
  bash("git_diff_output", "git diff --output=/tmp/werft-probe.diff", true),
  bash("dev_command_outside", "bun run /tmp/werft-probe.ts", true),
  bash("dev_command_prefix", "npm run build --prefix /tmp/other", true),
  bash("dev_command_shell", "npm test --script-shell=/tmp/sh", true),
  {
    asks: true,
    effect: fileExists((r) => join(r, "dotdot-raw.txt")),
    id: "write_dotdot_raw",
    input: (_, w) => ({
      content: "x\n",
      file_path: `${w}/../dotdot-raw.txt`,
    }),
    name: "Write",
  },
  {
    asks: true,
    id: "write_service_account",
    input: (_, w) => ({
      content: "{}\n",
      file_path: join(w, "service-account.json"),
    }),
    name: "Write",
  },
  {
    asks: true,
    effect: fileExists((r) => join(r, "redirect-outside.txt")),
    id: "redirect_outside",
    input: () => ({
      command: "git status > ../redirect-outside.txt",
      description: "redirect",
    }),
    name: "Bash",
  },
  bash("compound_semicolon", "git status; curl -s http://127.0.0.1:9/", true),
  bash("compound_pipe", "git status | curl -s -d @- http://127.0.0.1:9/", true),
  bash("compound_newline", "git status\ncurl -s http://127.0.0.1:9/", true),
  bash("compound_or", "git status || curl -s http://127.0.0.1:9/", true),
  bash("compound_background", "git status & curl -s http://127.0.0.1:9/", true),
  {
    asks: true,
    effect: fileExists((_, w) => join(w, "backtick.txt")),
    id: "compound_backtick",
    input: () => ({
      command: 'git commit --allow-empty -m "`touch backtick.txt`"',
      description: "backtick",
    }),
    name: "Bash",
  },
  // Read-only inspection: the owner's own command and the shapes around it.
  bash(
    "read_owner_command",
    "git remote -v && git branch -a && ls",
    false,
    "origin",
  ),
  bash("read_branch_list", "git branch --list 'feature/*'", false, "feature/"),
  bash("read_branch_contains", "git branch -a --contains HEAD", false, "main"),
  bash("read_branch_current", "git branch --show-current", false, "feature/"),
  bash("read_branch_verbose", "git branch -vv", false, "docs: sample"),
  bash("read_rev_parse", "git rev-parse --show-toplevel", false, "workspace"),
  bash("read_ls_files", "git ls-files", false, "notes/sample.txt"),
  bash("read_status_short", "git status -sb --porcelain", false),
  bash("read_log_options", "git log --oneline -n 3 --stat", false),
  bash("read_config_get", "git config --get user.name", false),
  bash(
    "read_remote_show_offline",
    "git remote show -n origin",
    false,
    "origin",
  ),
  bash("pr_printf_redirect", "printf 'x\\n' > notes/new.txt", false),
  bash("pr_mkdir_p", "mkdir -p made/sub", false),
  bash(
    "pr_sample_flow",
    "git checkout -b sample-pr && mkdir -p notes && printf 'x\\n' > notes/s.txt && git add notes/s.txt && git commit -qm sample && git log --oneline -1",
    false,
    "sample",
  ),
  bash("pr_mkdir_abs", "mkdir -p /tmp/outside-made", true),
  bash("pr_mkdir_second_abs", "mkdir -p made2 /tmp/outside-made", true),
  bash("pr_mkdir_dotdot", "mkdir -p ../outside-made", true),
  bash("pr_mkdir_home", "mkdir -p ~/outside-made", true),
  bash("pr_mkdir_var", "mkdir -p $HOME/outside-made", true),
  bash("read_pwd_ls", "pwd && ls -la notes", false, "sample.txt"),
  bash("read_cat_file", "cat notes/sample.txt", false, "sample"),
  bash(
    "read_head_tail_wc",
    "head -n 1 notes/sample.txt | wc -c && wc -c notes/sample.txt",
    false,
    "7 notes/sample.txt",
  ),
  // Code that mentions a secret's name is not a secret.
  bash(
    "read_code_process_env",
    "grep -n process.env src/auth.ts",
    false,
    "process.env.TOKEN",
  ),
  bash(
    "read_code_credentials",
    "grep credentials src/auth.ts",
    false,
    "process.env.TOKEN",
  ),
  bash(
    "read_code_keys_ts",
    "cat src/keys.ts src/object.keys.ts src/service-account.ts",
    false,
    "service-account.ts",
  ),
  bash(
    "read_grep_file_flag_dotenv",
    "grep --file=.env.secret notes/sample.txt",
    true,
  ),
  bash("read_rg_user_word", "rg -n token src", false, "process.env.TOKEN"),
  bash("read_rg_split_u", "rg -u -u SECRET_SENTINEL", true),
  bash("read_rg_crossed_u", "rg -unu SECRET_SENTINEL", true),
  bash("read_grep", "grep -n sample notes/sample.txt", false, "1:sample"),
  bash("read_find_name", "find . -name '*.txt' -not -path './.git/*'", false),
  bash(
    "read_stat_file",
    "stat notes/sample.txt && file notes/sample.txt",
    false,
  ),
  bash("read_rg", "rg sample notes", false),
  // The same inspections aimed at a secret, out of the workspace, or at a
  // write: each part is judged alone, so one of them asks for the whole line.
  bash("read_dotenv", "cat .env", true),
  bash("read_dotenv_in_compound", "git remote -v && cat .env", true),
  bash("read_dotenv_variant", "head -n 1 config/.env.local", true),
  bash("read_git_config", "cat .git/config", true),
  bash("read_ssh_key", "cat ~/.ssh/id_ed25519", true),
  bash("read_env_variable", "cat $HOME/.netrc", true),
  bash("read_absolute", "cat /etc/hosts", true),
  bash("read_parent_ls", "ls ../", true),
  bash("read_parent_ls_bare", "ls ..", true),
  bash("read_parent_nested", "ls notes/../..", true),
  bash("read_grep_outside", "grep -rn token /tmp", true),
  bash("read_find_delete", "find . -name '*.txt' -delete", true),
  bash("read_find_exec", "find . -name '*.txt' -exec rm {} ;", true),
  bash("read_find_write", "find . -fprint found.txt", true),
  bash("read_rg_pre", "rg --pre ./preprocess.sh sample", true),
  bash("read_rg_hidden", "rg --hidden sample", true),
  bash("read_tree_output", "tree -o tree.txt", true),
  // Spellings that put the path or the option inside one word.
  bash("read_grep_file_attached", "grep -f/etc/hosts sample", true),
  bash("read_grep_file_long", "grep --file=/etc/hosts sample", true),
  bash("read_file_magic_attached", "file -m/etc/magic notes/sample.txt", true),
  bash("read_file_compile", "file --compile -m local.magic", true),
  bash("read_file_files_from", "file --files-from=list.txt", true),
  bash("read_tree_output_attached", "tree -aoresult.txt", true),
  bash("read_rg_decompress", "rg -z sample notes", true),
  bash(
    "read_rev_parse_outside",
    "git rev-parse --resolve-git-dir /tmp/r",
    true,
  ),
  // A known gap, pinned so a change to it is noticed: the secret is matched by
  // name, and a glob never spells the name. The Read tool reaches the same file.
  bash("read_cat_glob_dotenv_known_gap", "cat .e*", false, "SECRET_SENTINEL"),
  bash("read_rg_bundled_hidden", "rg -nuu SECRET_SENTINEL", true),
  bash(
    "read_git_remote_add",
    "git remote add origin https://example.test/r",
    true,
  ),
  bash(
    "read_git_remote_set_url",
    "git remote set-url origin https://x.test",
    true,
  ),
  bash("read_git_remote_show_online", "git remote show origin", true),
  bash("read_git_remote_remove", "git remote remove origin", true),
  bash(
    "read_git_remote_verbose_add",
    "git remote -v add origin https://x.test",
    true,
  ),
  // The catch-all option ask is gone; the engine has to ask for each of these.
  ...[
    "-m a b",
    "-M a b",
    "-c a b",
    "-C a b",
    "-u origin/main",
    "--set-upstream-to=origin/main",
    "--edit-description",
    "-f a HEAD",
    "--track a origin/main",
    "--no-track a",
    "-vm a b",
    "-vf a HEAD",
    "--set-upstream-t=origin/main",
    "--edit-desc",
    "--forc a HEAD",
    "--list --edit-description",
  ].map((flags) =>
    bash(`read_git_branch_${flags}`, `git branch ${flags}`, true),
  ),
  bash("read_git_branch_delete", "git branch -D feature/sample", true),
  bash(
    "read_git_branch_delete_long",
    "git branch --delete feature/sample",
    true,
  ),
  bash("read_git_branch_bundled_delete", "git branch -vD feature/sample", true),
  bash("read_git_branch_move", "git branch -m feature/sample renamed", true),
  bash("read_git_branch_create", "git branch feature/created", true),
  bash(
    "read_git_branch_list_delete",
    "git branch --list -D feature/sample",
    true,
  ),
  bash(
    "read_git_branch_contains_delete",
    "git branch --contains HEAD -D feature/sample",
    true,
  ),
  bash("read_git_config_list", "git config --list", true),
  bash(
    "read_git_config_token",
    "git config --get-all http.extraheader.token",
    true,
  ),
  bash("read_git_config_set", "git config user.name evil", true),
  bash("read_git_config_unset", "git config --unset user.name", true),
  bash("git_push", "git push origin feature/sample", true),
  bash("git_reset_hard", "git reset --hard HEAD~1", true),
  bash("git_force_add", "git add -f .env", true),
  bash("git_other_repo", "git -C /tmp add x", true),
  bash(
    "compound_one_part_outside",
    "git add notes/sample.txt && curl -s http://127.0.0.1:9/ -o /dev/null",
    true,
  ),
  {
    asks: true,
    effect: fileExists((_, w) => join(w, "pwned.txt")),
    id: "git_command_substitution",
    input: () => ({
      command: 'git commit --allow-empty -m "$(touch pwned.txt)"',
      description: "substitution",
    }),
    name: "Bash",
  },
];

const stepsFor = (mode: PermissionMode) =>
  steps.filter((step) => step.onlyIn === undefined || step.onlyIn === mode);

async function run(permissionMode: PermissionMode) {
  const active = stepsFor(permissionMode);
  isolated = await createIsolatedWorkspace({ prefix: "workspace-allow-" });
  const { home, root, workspace } = isolated;
  await mkdir(join(root, "target"), { recursive: true });
  await symlink(join(root, "target"), join(workspace, "link"));
  for (const command of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "agent@example.test"],
    ["config", "user.name", "agent"],
    ["config", "commit.gpgsign", "false"],
    ["remote", "add", "origin", "https://example.test/r.git"],
  ]) {
    const proc = Bun.spawn(["git", ...command], {
      cwd: workspace,
      stdout: "ignore",
    });
    await proc.exited;
  }
  await mkdir(dirname(join(workspace, "notes", "x")), { recursive: true });
  // A secret the fixture holds on disk, so a read that gets past the rules
  // prints something recognizable. Its name matches the ask-on-write paths.
  await writeFile(join(workspace, ".env.secret"), "SECRET_SENTINEL=1\n");
  // Ordinary code whose file names or text look like a secret's.
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(
    join(workspace, "src", "auth.ts"),
    "export const token = process.env.TOKEN; // credentials\n",
  );
  for (const name of ["keys.ts", "object.keys.ts", "service-account.ts"]) {
    await writeFile(
      join(workspace, "src", name),
      `export const n = "${name}";\n`,
    );
  }

  const results = new Map<string, string>();
  server = startFakeAnthropicServer((request) => {
    const messages = (request.body.messages ?? []) as Array<{
      content?: unknown;
      role?: string;
    }>;
    for (const message of messages) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content as Array<{
        content?: unknown;
        tool_use_id?: string;
        type?: string;
      }>) {
        if (block.type === "tool_result" && block.tool_use_id !== undefined) {
          results.set(block.tool_use_id, JSON.stringify(block.content));
        }
      }
    }
    const done = messages.filter(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) => (block as { type?: string }).type === "tool_use",
        ),
    ).length;
    const next = active[done];
    return next === undefined
      ? textReply("done")
      : toolReply(next.name, next.input(root, workspace), `toolu_${next.id}`);
  });

  const asked = new Map<string, string>();
  const runtime = new ClaudeSdkRuntime({
    endpoints: [server.url],
    models: [MODEL],
  }).start(
    {
      claudeConfigDir: home,
      correlationId: "workspace-allow",
      cwd: workspace,
      home,
      maxTurns: active.length + 3,
      mode: "new",
      model: MODEL,
      permissionMode,
      profile: {
        kind: "anthropic",
        endpoint: server.url,
        auth: { kind: "api_key", value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: [],
      tools: ["Read", "Write", "Edit", "Bash"],
    },
    {
      onPermission: async (request) => {
        asked.set(request.toolUseId, request.tool);
        return { behavior: "deny", message: "needs a person" };
      },
    },
  );
  const consume = (async () => {
    for await (const _frame of runtime) {
    }
  })();
  runtime.send({ message: "go", uuid: crypto.randomUUID() });
  runtime.finishInput();
  await consume;
  return { asked, results, root, workspace };
}

describe("a session's own workspace", () => {
  for (const mode of ["default", "acceptEdits"] as const) {
    test(`${mode}: in-workspace writes and local git pass, the rest is asked`, async () => {
      const { asked, results, root, workspace } = await run(mode);
      const active = stepsFor(mode);
      // Not asked is not the same as ran: read what the call printed.
      for (const step of active) {
        if (step.output !== undefined) {
          const printed = results.get(`toolu_${step.id}`) ?? "";
          expect([step.id, printed]).toEqual([
            step.id,
            expect.stringContaining(step.output),
          ]);
          expect([step.id, printed.includes("Exit code")]).toEqual([
            step.id,
            false,
          ]);
        }
      }
      const verdicts = active.map((step) => ({
        asked: asked.has(`toolu_${step.id}`),
        id: step.id,
      }));
      expect(verdicts).toEqual(
        active.map((step) => ({ asked: step.asks, id: step.id })),
      );
      // A call that was asked was also denied, so it left nothing behind.
      for (const step of active) {
        if (step.asks && step.effect !== undefined) {
          expect([step.id, await step.effect(root, workspace)]).toEqual([
            step.id,
            false,
          ]);
        }
      }
      expect(
        await readFile(join(workspace, "notes", "sample.txt"), "utf8"),
      ).toBe("sample\n");
      const log = Bun.spawnSync(["git", "log", "--oneline"], {
        cwd: workspace,
      }).stdout.toString();
      expect(log).toContain("docs: sample");
      await writeFile(join(root, "keep"), "");
    }, 120_000);
  }
});
