import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ClaimGit,
  type ClaimGitAuthor,
  ENGINE_COAUTHOR_EMAILS,
} from "@werft-ai/contracts";
import {
  type ClaimCommits,
  GIT_IDENTITY_PATH,
  GIT_STRIP_PATH,
  GIT_TRAILERS_PATH,
  gitEnvironmentFor,
  gitIdentityConfig,
  gitTrailerLines,
  IMAGE_GIT_HOOKS,
  writeGitTrailers,
} from "./git-trailers.ts";

const HOOK = resolve(import.meta.dir, "../git-hooks/werft-hook");
const TRAILERS = resolve(import.meta.dir, "../git-hooks/werft-trailers.sh");
const ENGINE_LINE = "Co-Authored-By: Claude <noreply@anthropic.com>";
const CO_AUTHOR = {
  name: "octocat",
  email: "583231+octocat@users.noreply.github.com",
};
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_URL = `https://console.example.com/sessions/${SESSION_ID}`;
const LINKED: ClaimGit = { co_author: CO_AUTHOR, session_url: SESSION_URL };
const BOT: ClaimGitAuthor = {
  name: "werft-dev[bot]",
  email: "41898282+werft-dev[bot]@users.noreply.github.com",
};

// As the gateway sends it: git_strip rides with git.
const claim = (
  git: ClaimGit | undefined,
  gitAuthor?: ClaimGitAuthor | null,
): ClaimCommits => ({
  session_id: SESSION_ID,
  git,
  ...(git === undefined ? {} : { git_strip: ENGINE_COAUTHOR_EMAILS }),
  ...(gitAuthor === undefined ? {} : { git_author: gitAuthor }),
});

let root: string;
let home: string;
let repo: string;

/**
 * git as the image runs it for the engine: the hook directory from config,
 * and with `engine` also from the environment the adapter hands the engine.
 */
function git(
  args: string[],
  options: { allowFail?: boolean; engine?: boolean } = {},
) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      ...(options.engine
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "core.hooksPath",
            GIT_CONFIG_VALUE_0: join(root, "hooks"),
          }
        : {}),
    },
  });
  if (!options.allowFail && run.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  }
  return { code: run.exitCode, out: run.stdout.toString() };
}

const lastMessage = () => git(["log", "-1", "--format=%B"]).out.trimEnd();
const lastIdentity = () =>
  git(["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).out.trimEnd();

function repoHook(name: string, body: string) {
  const path = join(repo, ".git", "hooks", name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werft-hook-"));
  home = join(root, "home");
  repo = join(root, "repo");
  const hooks = join(root, "hooks");
  mkdirSync(home);
  mkdirSync(repo);
  mkdirSync(hooks);
  for (const name of ["commit-msg", "pre-commit", "prepare-commit-msg"]) {
    symlinkSync(HOOK, join(hooks, name));
  }
  // Beside the hooks, as the image installs it.
  symlinkSync(TRAILERS, join(hooks, "werft-trailers.sh"));
  // The image's system config, in the image's order (apps/worker/Dockerfile).
  writeFileSync(
    join(root, "gitconfig"),
    `[user]\n\tname = Werft\n\temail = noreply@werft.invalid\n[include]\n\tpath = ~/${GIT_IDENTITY_PATH}\n[core]\n\thooksPath = ${hooks}\n[init]\n\tdefaultBranch = main\n`,
  );
  git(["init", "-q"]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the commit-msg hook", () => {
  test("adds Co-authored-by and Agent-Session once, however often the commit is amended", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git(["commit", "-q", "--allow-empty", "-m", "Fix the thing"]);
    git(["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
    git(["commit", "-q", "--amend", "--allow-empty", "-m", lastMessage()]);
    expect(lastMessage()).toBe(
      [
        "Fix the thing",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
      ].join("\n"),
    );
  });

  test("keeps the trailers a message already has and does not repeat one", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const message = [
      "Fix the thing",
      "",
      "Body text.",
      "",
      "Signed-off-by: Ada <ada@example.com>",
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
      "Co-authored-by: Grace <grace@example.com>",
    ].join("\n");
    git(["commit", "-q", "--allow-empty", "-m", message]);
    expect(lastMessage()).toBe(`${message}\nAgent-Session: ${SESSION_URL}`);
  });

  test("a message with a --- line gets its trailers where git log reads them", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git([
      "commit",
      "-q",
      "--allow-empty",
      "--cleanup=verbatim",
      "-m",
      "Fix the thing\n\nExplanation\n\n---\nAdditional body text",
    ]);
    const log = git(["log", "-1", "--format=%(trailers:only,unfold)"]).out;
    expect(log).toContain(
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
    );
    expect(log).toContain(`Agent-Session: ${SESSION_URL}`);
  });

  test("a repository hook that appends a paragraph after the trailers does not make them repeat (94S-1444)", async () => {
    await writeGitTrailers(home, claim(LINKED));
    repoHook("commit-msg", `printf '\\nHusky-Ran: yes\\n' >>"$1"`);
    git(["commit", "-q", "--allow-empty", "-m", "Fix the thing"]);
    expect(lastMessage()).toBe(
      [
        "Fix the thing",
        "",
        "Husky-Ran: yes",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
      ].join("\n"),
    );
    const parsed = git(["log", "-1", "--format=%(trailers:only,unfold)"]).out;
    expect(
      parsed.split("\n").filter((l) => l.startsWith("Agent-Session:")),
    ).toHaveLength(1);
    expect(
      parsed.split("\n").filter((l) => l.startsWith("Co-authored-by:")),
    ).toHaveLength(1);
  });

  test("amending a commit in another requester's turn does not add that requester next to the first (94S-1304)", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git(["commit", "-q", "--allow-empty", "-m", "Fix the thing"]);
    const grace = { name: "grace", email: "2+grace@users.noreply.github.com" };
    await writeGitTrailers(
      home,
      claim({ co_author: grace, session_url: SESSION_URL }),
    );
    git(["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
    expect(lastMessage()).toBe(
      [
        "Fix the thing",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
      ].join("\n"),
    );
  });

  test("another requester's amend in a husky repository keeps the first requester's lines in the last block (94S-1304)", async () => {
    await writeGitTrailers(home, claim(LINKED));
    repoHook("commit-msg", `printf '\\nHusky-Ran: yes\\n' >>"$1"`);
    git(["commit", "-q", "--allow-empty", "-m", "Fix the thing"]);
    const grace = { name: "grace", email: "2+grace@users.noreply.github.com" };
    await writeGitTrailers(
      home,
      claim({ co_author: grace, session_url: SESSION_URL }),
    );
    git(["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
    const parsed = git(["log", "-1", "--format=%(trailers:only,unfold)"])
      .out.split("\n")
      .filter((l) => l.startsWith("Co-authored-by:") || l.startsWith("Agent-"));
    expect(parsed).toEqual([
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
      `Agent-Session: ${SESSION_URL}`,
    ]);
    expect(lastMessage()).not.toContain("grace");
  });

  test("a CRLF message amended in another requester's turn keeps the first requester alone", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git([
      "commit",
      "-q",
      "--allow-empty",
      "--cleanup=verbatim",
      "-m",
      "Fix the thing\r\n",
    ]);
    const grace = { name: "grace", email: "2+grace@users.noreply.github.com" };
    await writeGitTrailers(
      home,
      claim({ co_author: grace, session_url: SESSION_URL }),
    );
    git(["commit", "-q", "--amend", "--allow-empty", "--no-edit"]);
    expect(lastMessage()).not.toContain("grace");
    expect(lastMessage()).toContain(`Co-authored-by: ${CO_AUTHOR.name}`);
  });

  test("a separator line holding a space still marks the issued paragraph", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git([
      "commit",
      "-q",
      "--allow-empty",
      "--cleanup=verbatim",
      "-m",
      `Fix the thing\n \nCo-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>\nAgent-Session: ${SESSION_URL}`,
    ]);
    const grace = { name: "grace", email: "2+grace@users.noreply.github.com" };
    await writeGitTrailers(
      home,
      claim({ co_author: grace, session_url: SESSION_URL }),
    );
    git([
      "commit",
      "-q",
      "--amend",
      "--allow-empty",
      "--no-edit",
      "--cleanup=verbatim",
    ]);
    expect(lastMessage()).not.toContain("grace");
  });

  test("a session line quoted in the body is not taken for an earlier issue", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git([
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      `Explain\n\n\`\`\`\nAgent-Session: ${SESSION_URL}\n\`\`\``,
    ]);
    const message = lastMessage();
    expect(message).toContain(`\`\`\`\nAgent-Session: ${SESSION_URL}\n\`\`\``);
    expect(message).toContain(
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
    );
  });

  test("with co_author null only Agent-Session is added", async () => {
    await writeGitTrailers(
      home,
      claim({ co_author: null, session_url: SESSION_URL }),
    );
    git(["commit", "-q", "--allow-empty", "-m", "Agent work"]);
    expect(lastMessage()).toBe(`Agent work\n\nAgent-Session: ${SESSION_URL}`);
  });

  test("without a console URL Agent-Session names the session id, beside the co-author", async () => {
    await writeGitTrailers(
      home,
      claim({ co_author: CO_AUTHOR, session_url: null }),
    );
    git(["commit", "-q", "--allow-empty", "-m", "No console"]);
    expect(lastMessage()).toBe(
      [
        "No console",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_ID}`,
      ].join("\n"),
    );
  });

  test("without a trailers file the message is left as written", async () => {
    await writeGitTrailers(home, claim(undefined));
    git(["commit", "-q", "--allow-empty", "-m", "Plain"]);
    expect(lastMessage()).toBe("Plain");
  });

  test("passes a line as one argv: shell text in it is never run", () => {
    const marker = join(root, "ran");
    mkdirSync(join(home, ".werft"));
    writeFileSync(
      join(home, GIT_TRAILERS_PATH),
      `Agent-Session: $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}\n`,
    );
    git(["commit", "-q", "--allow-empty", "-m", "Quoted"]);
    expect(existsSync(marker)).toBe(false);
    expect(lastMessage()).toBe(
      `Quoted\n\nAgent-Session: $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}`,
    );
  });

  test("skips lines with a CR or another key", () => {
    mkdirSync(join(home, ".werft"));
    writeFileSync(
      join(home, GIT_TRAILERS_PATH),
      `Agent-Session: one\rSigned-off-by: forged <f@example.com>\nSigned-off-by: forged <f@example.com>\nReviewed-by: nobody\nAgent-Session: two\n`,
    );
    git(["commit", "-q", "--allow-empty", "-m", "Filtered"]);
    expect(lastMessage()).toBe("Filtered\n\nAgent-Session: two");
  });

  test("runs the repository's own hooks: theirs first, a refusal stops the commit", async () => {
    await writeGitTrailers(home, claim(LINKED));
    // prepare-commit-msg already added the trailers, so the repository's
    // commit-msg sees them and appends below; commit-msg adds no second copy.
    repoHook("commit-msg", 'printf "Repo-Hook: ran\\n" >>"$1"');
    git(["commit", "-q", "--allow-empty", "-m", "Chained"]);
    expect(lastMessage()).toBe(
      [
        "Chained",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
        "Repo-Hook: ran",
      ].join("\n"),
    );

    repoHook("pre-commit", "exit 1");
    const refused = git(["commit", "-q", "--allow-empty", "-m", "Refused"], {
      allowFail: true,
    });
    expect(refused.code).not.toBe(0);
    expect(lastMessage().startsWith("Chained")).toBe(true);
  });

  test("a hook the repository does not have is a no-op", async () => {
    await writeGitTrailers(home, claim(LINKED));
    // prepare-commit-msg points at the dispatcher with no repository hook.
    git(["commit", "-q", "--allow-empty", "-m", "Quiet"]);
    expect(lastMessage().startsWith("Quiet\n\n")).toBe(true);
  });
});

describe("the engine's own co-author", () => {
  const SESSION_LINES = [
    `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
    `Agent-Session: ${SESSION_URL}`,
  ];
  const engineMessage = (subject: string) =>
    [subject, "", "Body.", "", ENGINE_LINE].join("\n");

  test("is removed and the session's trailers are added, in a plain commit", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git(["commit", "-q", "--allow-empty", "-m", engineMessage("Plain")], {
      engine: true,
    });
    expect(lastMessage()).toBe(
      ["Plain", "", "Body.", "", ...SESSION_LINES].join("\n"),
    );
  });

  test("is removed under --no-verify, where commit-msg does not run", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const ran = join(root, "commit-msg-ran");
    repoHook("commit-msg", `touch ${ran}`);
    git(
      [
        "commit",
        "-q",
        "--no-verify",
        "--allow-empty",
        "-m",
        engineMessage("Unverified"),
      ],
      { engine: true },
    );
    expect(existsSync(ran)).toBe(false);
    expect(lastMessage()).toBe(
      ["Unverified", "", "Body.", "", ...SESSION_LINES].join("\n"),
    );
  });

  test("is removed in a husky repository, whose hooks run instead of .git/hooks", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const husky = join(repo, ".husky");
    mkdirSync(husky);
    for (const name of ["pre-commit", "commit-msg"]) {
      writeFileSync(
        join(husky, name),
        `#!/bin/sh\necho ${name} >>"${join(root, "husky-ran")}"\n`,
      );
      chmodSync(join(husky, name), 0o755);
    }
    repoHook("commit-msg", `touch ${join(root, "git-hooks-ran")}`);
    git(["config", "core.hooksPath", ".husky"]);
    git(["commit", "-q", "--allow-empty", "-m", engineMessage("Husky")], {
      engine: true,
    });
    expect(readFileSync(join(root, "husky-ran"), "utf8")).toBe(
      "pre-commit\ncommit-msg\n",
    );
    expect(existsSync(join(root, "git-hooks-ran"))).toBe(false);
    expect(lastMessage()).toBe(
      ["Husky", "", "Body.", "", ...SESSION_LINES].join("\n"),
    );
  });

  test("a husky hook's refusal still stops the commit", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git(["commit", "-q", "--allow-empty", "-m", "Before"]);
    mkdirSync(join(repo, ".husky"));
    writeFileSync(join(repo, ".husky", "commit-msg"), "#!/bin/sh\nexit 3\n");
    chmodSync(join(repo, ".husky", "commit-msg"), 0o755);
    git(["config", "core.hooksPath", ".husky"]);
    const refused = git(["commit", "-q", "--allow-empty", "-m", "Refused"], {
      allowFail: true,
      engine: true,
    });
    expect(refused.code).not.toBe(0);
    expect(lastMessage().startsWith("Before")).toBe(true);
  });

  test("a hooksPath under ~ is expanded as git would", async () => {
    await writeGitTrailers(home, claim(LINKED));
    mkdirSync(join(home, "my-hooks"));
    writeFileSync(
      join(home, "my-hooks", "commit-msg"),
      `#!/bin/sh\ntouch ${join(root, "home-hook-ran")}\n`,
    );
    chmodSync(join(home, "my-hooks", "commit-msg"), 0o755);
    git(["config", "core.hooksPath", "~/my-hooks"]);
    git(["commit", "-q", "--allow-empty", "-m", "Home"], { engine: true });
    expect(existsSync(join(root, "home-hook-ran"))).toBe(true);
    expect(lastMessage()).toBe(["Home", "", ...SESSION_LINES].join("\n"));
  });

  test("a repository hooksPath naming the platform's directory does not loop", async () => {
    await writeGitTrailers(home, claim(LINKED));
    git(["config", "core.hooksPath", join(root, "hooks")]);
    git(["commit", "-q", "--allow-empty", "-m", "Once"], { engine: true });
    expect(lastMessage()).toBe(["Once", "", ...SESSION_LINES].join("\n"));
  });

  test("merge and cherry-pick commits get the trailers; commit-tree runs no hook", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const engine = { engine: true };
    git(["commit", "-q", "--allow-empty", "-m", "Base"], engine);
    git(["checkout", "-q", "-b", "side"], engine);
    git(["commit", "-q", "--allow-empty", "-m", "Side"], engine);
    git(["checkout", "-q", "main"], engine);
    git(["commit", "-q", "--allow-empty", "-m", "Main"], engine);
    git(["merge", "-q", "--no-edit", "side"], engine);
    expect(lastMessage()).toBe(
      ["Merge branch 'side'", "", ...SESSION_LINES].join("\n"),
    );
    // A commit made with no hook at all, then picked.
    const raw = git([
      "-c",
      `core.hooksPath=${join(root, "none")}`,
      "commit-tree",
      "-p",
      "HEAD",
      "-m",
      "Raw",
      "HEAD^{tree}",
    ]).out.trim();
    expect(git(["log", "-1", "--format=%B", raw]).out.trimEnd()).toBe("Raw");
    git(["cherry-pick", "--allow-empty", raw], engine);
    expect(lastMessage()).toBe(["Raw", "", ...SESSION_LINES].join("\n"));
  });

  test("keeps a person's co-author and drops engine lines in any key case", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const message = [
      "Mixed",
      "",
      "Co-authored-by: Grace <grace@example.com>",
      "co-authored-by: Claude Opus <NoReply@Anthropic.com>",
      ENGINE_LINE,
    ].join("\n");
    git(["commit", "-q", "--allow-empty", "-m", message], { engine: true });
    expect(lastMessage()).toBe(
      [
        "Mixed",
        "",
        "Co-authored-by: Grace <grace@example.com>",
        ...SESSION_LINES,
      ].join("\n"),
    );
  });

  test("drops whatever email the claim's git_strip lists", async () => {
    await writeGitTrailers(home, {
      ...claim(LINKED),
      git_strip: ["bot@engine.example"],
    });
    const message = "Extra\n\nCo-authored-by: Engine <bot@engine.example>";
    git(["commit", "-q", "--allow-empty", "-m", message], { engine: true });
    expect(lastMessage()).toBe(["Extra", "", ...SESSION_LINES].join("\n"));
  });

  test("ignores trailer settings from the repository and from git -c", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const engineCmd = `echo "Claude <noreply@anthropic.com>"`;
    git(["config", "trailer.Agent-Session.key", "Other"]);
    git(["config", "trailer.Co-authored-by.cmd", engineCmd]);
    git(["commit", "-q", "--allow-empty", "-m", "Local config"], {
      engine: true,
    });
    expect(lastMessage()).toBe(
      ["Local config", "", ...SESSION_LINES].join("\n"),
    );
    git(["config", "--unset", "trailer.Agent-Session.key"]);
    git(["config", "--unset", "trailer.Co-authored-by.cmd"]);
    git(
      [
        "-c",
        "trailer.Agent-Session.key=Other",
        "-c",
        `trailer.Co-authored-by.cmd=${engineCmd}`,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Command line config",
      ],
      { engine: true },
    );
    expect(lastMessage()).toBe(
      ["Command line config", "", ...SESSION_LINES].join("\n"),
    );
  });
});

describe("the engine's git settings", () => {
  test("name the hook directory the image installs", () => {
    const dockerfile = readFileSync(
      resolve(import.meta.dir, "../Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      `git config --system core.hooksPath ${IMAGE_GIT_HOOKS}\n`,
    );
  });

  test("name the image's hooks and the claim's bot", () => {
    expect(gitEnvironmentFor(claim(LINKED, BOT), IMAGE_GIT_HOOKS)).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: IMAGE_GIT_HOOKS,
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: BOT.name,
      GIT_CONFIG_KEY_2: "user.email",
      GIT_CONFIG_VALUE_2: BOT.email,
    });
  });

  test("state the image default when the claim names no usable bot, so a repository's user.* cannot win", () => {
    for (const author of [
      null,
      { name: "Grace", email: "grace@example.com" },
    ]) {
      expect(gitEnvironmentFor(claim(LINKED, author), undefined)).toEqual({
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Werft",
        GIT_CONFIG_KEY_1: "user.email",
        GIT_CONFIG_VALUE_1: "noreply@werft.invalid",
      });
    }
  });

  test("leave the author alone for an API without git_author, and are absent with nothing to say", () => {
    expect(gitEnvironmentFor(claim(LINKED), IMAGE_GIT_HOOKS)).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: IMAGE_GIT_HOOKS,
    });
    expect(gitEnvironmentFor(claim(LINKED), undefined)).toBeUndefined();
  });

  test("outrank a repository's local user.name in a real commit", async () => {
    await writeGitTrailers(home, claim(LINKED, BOT));
    git(["config", "user.name", "Local"]);
    git(["config", "user.email", "local@example.com"]);
    const environment = gitEnvironmentFor(claim(LINKED, BOT), undefined) ?? {};
    const run = Bun.spawnSync(
      ["git", "commit", "-q", "--allow-empty", "-m", "Bot"],
      {
        cwd: repo,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
          ...environment,
        },
      },
    );
    expect(run.exitCode).toBe(0);
    expect(lastIdentity()).toBe(
      `${BOT.name} <${BOT.email}>|${BOT.name} <${BOT.email}>`,
    );
  });
});

describe("the strip file", () => {
  test("holds the claim's engine emails, one per line, and goes with them", async () => {
    await writeGitTrailers(home, {
      ...claim(LINKED),
      git_strip: ["noreply@anthropic.com", "bad email@x", "a@b\n"],
    });
    expect(readFileSync(join(home, GIT_STRIP_PATH), "utf8")).toBe(
      "noreply@anthropic.com\n",
    );
    await writeGitTrailers(home, claim(undefined));
    expect(existsSync(join(home, GIT_STRIP_PATH))).toBe(false);
  });

  test("absent, an engine line stays: an older API names no email to remove", async () => {
    await writeGitTrailers(home, { session_id: SESSION_ID, git: LINKED });
    git(["commit", "-q", "--allow-empty", "-m", `Old\n\n${ENGINE_LINE}`]);
    expect(lastMessage()).toContain(ENGINE_LINE);
  });
});

describe("werft-trailers.sh sourced on its own", () => {
  // What the attribution repair tool and werft-commit do: no hook involved.
  const fix = (file: string) =>
    Bun.spawnSync(
      ["sh", "-c", '. "$1" && werft_fix_message "$2"', "sh", TRAILERS, file],
      {
        cwd: repo,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      },
    );

  test("defines functions and does nothing else when sourced", () => {
    const run = Bun.spawnSync(
      ["sh", "-c", '. "$1" && command -v werft_fix_message', "sh", TRAILERS],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } },
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("werft_fix_message");
  });

  test("werft_fix_message takes no text of the author with an engine line: a line after a whitespace-only line stays", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const file = join(root, "message");
    const body =
      "Subject\n\nCo-authored-by: Claude\n \n    Keep this explanation <noreply@anthropic.com>\n\nMore body.\n";
    writeFileSync(file, body);
    expect(fix(file).exitCode).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("    Keep this explanation <noreply@anthropic.com>");
    expect(text).toContain("More body.");
  });

  test("werft_fix_message leaves a folded engine line as written, for the push check to refuse", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const file = join(root, "message");
    const body =
      "Subject\n\nCo-authored-by: Claude\n <noreply@anthropic.com>\n";
    writeFileSync(file, body);
    expect(fix(file).exitCode).toBe(0);
    expect(readFileSync(file, "utf8").startsWith(body)).toBe(true);
  });

  test("werft_fix_message strips the engine line and adds the trailers once", async () => {
    await writeGitTrailers(home, claim(LINKED));
    const file = join(root, "message");
    writeFileSync(file, `Subject\n\n${ENGINE_LINE}\n`);
    expect(fix(file).exitCode).toBe(0);
    expect(fix(file).exitCode).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(
      [
        "Subject",
        "",
        `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>`,
        `Agent-Session: ${SESSION_URL}`,
        "",
      ].join("\n"),
    );
  });
});

describe("the commit author", () => {
  const WERFT = "Werft <noreply@werft.invalid>";
  const BOT_IDENT = `${BOT.name} <${BOT.email}>`;

  test("is the App's bot, as author and committer, when the claim names it", async () => {
    await writeGitTrailers(home, claim(LINKED, BOT));
    git(["commit", "-q", "--allow-empty", "-m", "By the bot"]);
    expect(lastIdentity()).toBe(`${BOT_IDENT}|${BOT_IDENT}`);
  });

  test("falls back to the image default when a later claim names none", async () => {
    await writeGitTrailers(home, claim(LINKED, BOT));
    await writeGitTrailers(home, claim(LINKED, null));
    expect(existsSync(join(home, GIT_IDENTITY_PATH))).toBe(false);
    git(["commit", "-q", "--allow-empty", "-m", "Default"]);
    expect(lastIdentity()).toBe(`${WERFT}|${WERFT}`);
  });

  test("a repository's own user config still wins", async () => {
    await writeGitTrailers(home, claim(LINKED, BOT));
    git(["config", "user.name", "Ada"]);
    git(["config", "user.email", "ada@example.com"]);
    git(["commit", "-q", "--allow-empty", "-m", "Mine"]);
    expect(lastIdentity()).toBe("Ada <ada@example.com>|Ada <ada@example.com>");
  });

  test("anything but a bot noreply identity is not written", () => {
    expect(gitIdentityConfig(BOT)).toBe(
      `[user]\n\tname = "${BOT.name}"\n\temail = ${BOT.email}\n`,
    );
    for (const author of [
      { name: 'x[bot]"\n[core]', email: BOT.email },
      { name: BOT.name, email: "someone@example.com" },
      { name: "Ada", email: BOT.email },
    ]) {
      expect(gitIdentityConfig(author)).toBeNull();
    }
    expect(gitIdentityConfig(null)).toBeNull();
    expect(gitIdentityConfig(undefined)).toBeNull();
  });
});

describe("the trailers file", () => {
  test("holds one line per trailer the claim names", async () => {
    await writeGitTrailers(home, claim(LINKED));
    expect(readFileSync(join(home, GIT_TRAILERS_PATH), "utf8")).toBe(
      `Co-authored-by: ${CO_AUTHOR.name} <${CO_AUTHOR.email}>\nAgent-Session: ${SESSION_URL}\n`,
    );
  });

  test("is removed when an older API sends no git, so it adds nothing", async () => {
    await writeGitTrailers(home, claim(LINKED));
    await writeGitTrailers(home, claim(undefined));
    expect(existsSync(join(home, GIT_TRAILERS_PATH))).toBe(false);
  });

  test("drops a value that could break a line", () => {
    expect(
      gitTrailerLines({
        session_id: `${SESSION_ID}\n`,
        git: {
          co_author: { name: "octo\ncat", email: CO_AUTHOR.email },
          session_url: `${SESSION_URL}\rX`,
        },
      }),
    ).toEqual([]);
  });
});
