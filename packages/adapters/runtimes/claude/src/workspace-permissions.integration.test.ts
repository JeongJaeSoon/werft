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
  /** The step only means something in this mode. */
  onlyIn?: PermissionMode;
};

const fileExists = (path: (root: string, workspace: string) => string) => {
  return async (root: string, workspace: string) =>
    existsSync(path(root, workspace));
};

const bash = (id: string, command: string, asks: boolean): Step => ({
  asks,
  id,
  input: () => ({ command, description: id }),
  name: "Bash",
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
  ]) {
    const proc = Bun.spawn(["git", ...command], {
      cwd: workspace,
      stdout: "ignore",
    });
    await proc.exited;
  }
  await mkdir(dirname(join(workspace, "notes", "x")), { recursive: true });

  server = startFakeAnthropicServer((request) => {
    const messages = (request.body.messages ?? []) as Array<{
      content?: unknown;
      role?: string;
    }>;
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
  return { asked, root, workspace };
}

describe("a session's own workspace", () => {
  for (const mode of ["default", "acceptEdits"] as const) {
    test(`${mode}: in-workspace writes and local git pass, the rest is asked`, async () => {
      const { asked, root, workspace } = await run(mode);
      const active = stepsFor(mode);
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
