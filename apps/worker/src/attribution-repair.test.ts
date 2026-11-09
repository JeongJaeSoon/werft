import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ENGINE_COAUTHOR_EMAILS,
  IMAGE_GIT_AUTHOR,
  type WorkerScope,
} from "@werft-ai/contracts";
import { ATTRIBUTION_PROBLEMS } from "@werft-ai/runtime-core";
import {
  claimExpectation,
  claimExpectations,
  noteTurnCoAuthor,
  repairAttribution,
  workspaceMismatches,
} from "./attribution-repair.ts";
import { GIT_IDENTITY_PATH, writeGitTrailers } from "./git-trailers.ts";

const TOOL = resolve(import.meta.dir, "../git-hooks/werft-repair-attribution");
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const BOT = {
  name: "werft-dev[bot]",
  email: "41898282+werft-dev[bot]@users.noreply.github.com",
};
const SCOPE = {
  session_id: SESSION_ID,
  turn_id: null,
  attempt_id: "22222222-2222-4222-8222-222222222222",
  lease_epoch: 1,
  execution_generation: 1,
  auth_revision: 1,
} as unknown as WorkerScope;
const logger = { info() {}, warn() {}, error() {} } as never;

let root: string;
let home: string;
let repo: string;
let spool: string;

function git(args: string[]) {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return run.stdout.toString().trim();
}

let counter = 0;
function commit(message: string, name = "someone") {
  counter += 1;
  writeFileSync(join(repo, `f${counter}`), message);
  git(["add", "."]);
  git([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    `user.name=${name}`,
    "-c",
    "user.email=a@b.c",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return git(["rev-parse", "HEAD"]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "werft-repair-ts-"));
  home = join(root, "home");
  repo = join(root, "repo");
  spool = join(root, "spool");
  for (const dir of [home, repo, spool]) mkdirSync(dir);
  git(["init", "-q", "-b", "main"]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("claimExpectation", () => {
  test("is what the claim asks for", () => {
    expect(
      claimExpectation({
        session_id: SESSION_ID,
        git: { co_author: null, session_url: "https://c/s/1" },
        git_author: BOT,
      }),
    ).toEqual({ author: BOT, coAuthor: null, agentSession: "https://c/s/1" });
  });

  test("a null author is the image's, and no URL names the session id", () => {
    expect(
      claimExpectation({
        session_id: SESSION_ID,
        git: { co_author: null, session_url: null },
        git_author: null,
      }),
    ).toEqual({
      author: IMAGE_GIT_AUTHOR,
      coAuthor: null,
      agentSession: SESSION_ID,
    });
  });

  test("a claim from a server without git or git_author asks for nothing", () => {
    expect(claimExpectation({ session_id: SESSION_ID })).toBeNull();
    expect(
      claimExpectation({
        session_id: SESSION_ID,
        git: { co_author: null, session_url: null },
      }),
    ).toBeNull();
  });
});

describe("repairAttribution", () => {
  const base = { logger, scope: SCOPE };

  test("is skipped outside the image", async () => {
    const outcome = await repairAttribution({
      ...base,
      root: repo,
      home,
      spool,
      tool: undefined,
      gateway: { protectedCommits: async () => ({ commits: [] }) },
    });
    expect(outcome).toEqual({ status: "skipped", reason: "no_tool" });
  });

  test("is skipped, nothing run, when the server has no route or fails", async () => {
    const marker = join(root, "ran");
    const tool = join(root, "tool");
    writeFileSync(tool, `#!/bin/sh\ntouch ${marker}\necho clean\n`);
    chmodSync(tool, 0o755);
    expect(
      await repairAttribution({
        ...base,
        root: repo,
        home,
        spool,
        tool,
        gateway: {},
      }),
    ).toEqual({ status: "skipped", reason: "no_gateway_route" });
    const failing = await repairAttribution({
      ...base,
      root: repo,
      home,
      spool,
      tool,
      gateway: {
        protectedCommits: async () => {
          throw new Error("503");
        },
      },
    });
    expect(failing).toMatchObject({ status: "skipped" });
    expect(Bun.file(marker).size).toBe(0);
  });

  test("hands the tool the server's protected commits and reports its verdict", async () => {
    const argv = join(root, "argv");
    const tool = join(root, "tool");
    writeFileSync(
      tool,
      `#!/bin/sh\necho "$1" >${argv}\ncat "$2" >>${argv}\necho "repaired a b"\n`,
    );
    chmodSync(tool, 0o755);
    const sha = "a".repeat(40);
    const outcome = await repairAttribution({
      ...base,
      root: repo,
      home,
      spool,
      tool,
      gateway: { protectedCommits: async () => ({ commits: [sha] }) },
    });
    expect(outcome).toEqual({ status: "repaired", protectedCommits: [sha] });
    expect(readFileSync(argv, "utf8")).toBe(`${repo}\n${sha}\n`);
  });

  test("exit 2 is nested_merge and any other failure is failed", async () => {
    const tool = join(root, "tool");
    const gateway = { protectedCommits: async () => ({ commits: [] }) };
    writeFileSync(tool, "#!/bin/sh\necho 'nested_merge x'\nexit 2\n");
    chmodSync(tool, 0o755);
    expect(
      await repairAttribution({
        ...base,
        root: repo,
        home,
        spool,
        tool,
        gateway,
      }),
    ).toEqual({ status: "nested_merge", protectedCommits: [] });
    writeFileSync(tool, "#!/bin/sh\necho 'failed: nope'\nexit 1\n");
    expect(
      await repairAttribution({
        ...base,
        root: repo,
        home,
        spool,
        tool,
        gateway,
      }),
    ).toEqual({
      status: "failed",
      detail: "failed: nope",
      protectedCommits: [],
    });
  });

  test("with the real tool, a wrong commit is remade and a protected one is not", async () => {
    writeFileSync(
      join(root, "gitconfig"),
      `[user]\n\tname = Werft\n\temail = noreply@werft.invalid\n[include]\n\tpath = ~/${GIT_IDENTITY_PATH}\n`,
    );
    await writeGitTrailers(home, {
      session_id: SESSION_ID,
      git: { co_author: null, session_url: "https://c/s/1" },
      git_author: BOT,
      git_strip: ENGINE_COAUTHOR_EMAILS,
    });
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    const pushed = commit("pushed earlier");
    const wrong = commit("wrong");
    // The tool reads the "system" config through GIT_CONFIG_SYSTEM; the image
    // has it at /etc/gitconfig.
    process.env.GIT_CONFIG_SYSTEM = join(root, "gitconfig");
    try {
      const outcome = await repairAttribution({
        ...base,
        root: repo,
        home,
        spool,
        tool: TOOL,
        gateway: { protectedCommits: async () => ({ commits: [pushed] }) },
      });
      expect(outcome.status).toBe("repaired");
    } finally {
      delete process.env.GIT_CONFIG_SYSTEM;
    }
    expect(git(["rev-parse", "HEAD^"])).toBe(pushed);
    expect(git(["rev-parse", "HEAD"])).not.toBe(wrong);
    expect(git(["log", "-1", "--format=%an"])).toBe(BOT.name);
  });

  test("a later turn's repair does not give its co-author to commits an earlier turn's repair judged (94S-1304)", async () => {
    writeFileSync(
      join(root, "gitconfig"),
      `[user]\n\tname = Werft\n\temail = noreply@werft.invalid\n[include]\n\tpath = ~/${GIT_IDENTITY_PATH}\n`,
    );
    const octocat = {
      name: "octocat",
      email: "583231+octocat@users.noreply.github.com",
    };
    const turn = (co_author: typeof octocat | null) =>
      writeGitTrailers(home, {
        session_id: SESSION_ID,
        git: { co_author, session_url: "https://c/s/1" },
        git_author: BOT,
        git_strip: ENGINE_COAUTHOR_EMAILS,
      });
    const repair = async (judged: readonly string[]) => {
      process.env.GIT_CONFIG_SYSTEM = join(root, "gitconfig");
      try {
        return await repairAttribution({
          ...base,
          root: repo,
          home,
          spool,
          tool: TOOL,
          gateway: { protectedCommits: async () => ({ commits: [] }) },
          judged,
        });
      } finally {
        delete process.env.GIT_CONFIG_SYSTEM;
      }
    };
    const coAuthors = (revision: string) =>
      git(["show", "-s", "--format=%B", revision])
        .split("\n")
        .filter((line) => line.startsWith("Co-authored-by:"));

    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    await turn(null);
    commit("turn 1 work");
    const first = await repair([]);
    expect(first.status).toBe("repaired");
    const judgedTip = "head" in first ? first.head : undefined;
    expect(judgedTip).toBe(git(["rev-parse", "HEAD"]));
    await turn(octocat);
    commit("turn 2 work");
    const second = await repair(judgedTip === undefined ? [] : [judgedTip]);
    expect(second.status).toBe("repaired");
    expect(coAuthors("HEAD~1")).toEqual([]);
    expect(coAuthors("HEAD")).toEqual([
      `Co-authored-by: ${octocat.name} <${octocat.email}>`,
    ]);
    expect(git(["show", "-s", "--format=%B", "HEAD"])).toContain(
      "Agent-Session: https://c/s/1",
    );
  });

  test("a commit remade after its turn keeps its own co-author when another requester's repair runs", async () => {
    writeFileSync(
      join(root, "gitconfig"),
      `[user]\n\tname = Werft\n\temail = noreply@werft.invalid\n[include]\n\tpath = ~/${GIT_IDENTITY_PATH}\n`,
    );
    const octocat = {
      name: "octocat",
      email: "583231+octocat@users.noreply.github.com",
    };
    const hubot = {
      name: "hubot",
      email: "1+hubot@users.noreply.github.com",
    };
    const turn = (co_author: typeof octocat) =>
      writeGitTrailers(home, {
        session_id: SESSION_ID,
        git: { co_author, session_url: "https://c/s/1" },
        git_author: BOT,
        git_strip: ENGINE_COAUTHOR_EMAILS,
      });
    const repair = async (judged: readonly string[]) => {
      process.env.GIT_CONFIG_SYSTEM = join(root, "gitconfig");
      try {
        return await repairAttribution({
          ...base,
          root: repo,
          home,
          spool,
          tool: TOOL,
          gateway: { protectedCommits: async () => ({ commits: [] }) },
          judged,
        });
      } finally {
        delete process.env.GIT_CONFIG_SYSTEM;
      }
    };
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    await turn(octocat);
    commit("octocat's work");
    const first = await repair([]);
    const judgedTip = "head" in first ? first.head : undefined;
    // The next turn rewrites that commit (a rebase onto new work does the
    // same): its hash is no longer under the judged tip.
    await turn(hubot);
    git([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=someone",
      "-c",
      "user.email=a@b.c",
      "commit",
      "-q",
      "--amend",
      "--no-edit",
      "--reset-author",
    ]);
    expect(git(["rev-parse", "HEAD"])).not.toBe(judgedTip);
    await repair(judgedTip === undefined ? [] : [judgedTip]);
    const trailers = git(["show", "-s", "--format=%B", "HEAD"])
      .split("\n")
      .filter((line) => line.startsWith("Co-authored-by:"));
    expect(trailers).toEqual([
      `Co-authored-by: ${octocat.name} <${octocat.email}>`,
    ]);
  });
});

describe("claimExpectations", () => {
  const claim = {
    session_id: SESSION_ID,
    git: { co_author: null, session_url: "https://c/s/1" },
    git_author: BOT,
  };
  const octocat = {
    name: "octocat",
    email: "583231+octocat@users.noreply.github.com",
  };

  test("is the claim's bundle alone until a turn names a co-author", () => {
    expect(claimExpectations(claim)).toEqual([
      { author: BOT, coAuthor: null, agentSession: "https://c/s/1" },
    ]);
  });

  test("a restarted claim carries the bundles the server issued, as issued", () => {
    const earlier = {
      name: "grace",
      email: "2+grace@users.noreply.github.com",
    };
    const old = { name: "Werft", email: "noreply@werft.invalid" };
    expect(
      claimExpectations({
        ...claim,
        git_issued: [
          { author: old, co_author: earlier, agent_session: "https://c/s/1" },
          { author: BOT, co_author: null, agent_session: "https://c/s/1" },
        ],
      }),
    ).toEqual([
      { author: BOT, coAuthor: null, agentSession: "https://c/s/1" },
      { author: old, coAuthor: earlier, agentSession: "https://c/s/1" },
      { author: BOT, coAuthor: null, agentSession: "https://c/s/1" },
    ]);
  });

  test("adds one bundle for each co-author the turns named, once", () => {
    noteTurnCoAuthor(claim, octocat);
    noteTurnCoAuthor(claim, octocat);
    noteTurnCoAuthor(claim, null);
    expect(claimExpectations(claim).map((e) => e.coAuthor)).toEqual([
      null,
      octocat,
      null,
    ]);
  });

  test("a claim that asks for nothing checkable stays unchecked", () => {
    const bare = { session_id: SESSION_ID };
    noteTurnCoAuthor(bare, octocat);
    expect(claimExpectations(bare)).toEqual([]);
  });
});

describe("workspaceMismatches", () => {
  const expectation = {
    author: BOT,
    coAuthor: null,
    agentSession: null,
  };

  test("lists the commits no remote-tracking ref holds that are not attributed", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    const wrong = commit("wrong");
    expect(
      await workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [expectation],
        stripEmails: [],
        protectedCommits: [],
      }),
    ).toEqual([{ commit: wrong, problems: ["author", "committer"] }]);
  });

  test("a protected commit from an earlier claim is not judged against this claim's values", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    const earlier = commit("made under an earlier claim");
    const wrong = commit("wrong");
    expect(
      await workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [expectation],
        stripEmails: [],
        protectedCommits: [earlier, "f".repeat(40)],
      }),
    ).toEqual([{ commit: wrong, problems: ["author", "committer"] }]);
  });

  test("a wrong commit from an earlier turn is found again once the server stops protecting it", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    const pushed = commit("pushed earlier", "good");
    // Left wrong by a turn the repair could not fix (nested_merge).
    const left = commit("left wrong", "bad");
    commit("this turn's commit", "good");
    const judge = (protectedCommits: string[]) =>
      workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [
          {
            author: { name: "good", email: "a@b.c" },
            coAuthor: null,
            agentSession: null,
          },
        ],
        stripEmails: [],
        protectedCommits,
      });
    // The server no longer lists a checkpoint that recorded a mismatch.
    expect(await judge([pushed])).toEqual([
      { commit: left, problems: ["author", "committer"] },
    ]);
    // Listed, as it was before the fix, it would drop out of the check.
    expect(await judge([pushed, left])).toEqual([]);
  });

  test("a protected commit this repository lacks does not start a fetch from a configured program", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    commit("wrong");
    const marker = join(root, "fetch-ran");
    const program = join(root, "planted-upload-pack");
    writeFileSync(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(program, 0o755);
    git(["config", "core.repositoryformatversion", "1"]);
    git(["config", "extensions.partialClone", "evil"]);
    git(["config", "remote.evil.promisor", "true"]);
    git(["config", "remote.evil.url", root]);
    git(["config", "remote.evil.uploadpack", program]);
    await workspaceMismatches({
      root: repo,
      tip: "HEAD",
      expectations: [expectation],
      stripEmails: [],
      protectedCommits: ["e".repeat(40)],
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("without the server's protected list there is no advice, the push judges alone", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    commit("wrong");
    expect(
      await workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [expectation],
        stripEmails: [],
        protectedCommits: null,
      }),
    ).toEqual([]);
  });

  test("commits a remote already holds are not looked at", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base")]);
    expect(
      await workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [expectation],
        stripEmails: [],
        protectedCommits: [],
      }),
    ).toEqual([]);
  });

  test("a folded engine co-author is found though the workspace's trailer.* setting renames the key", async () => {
    git(["update-ref", "refs/remotes/origin/main", commit("base", "good")]);
    git(["config", "trailer.Co-authored-by.key", "Other"]);
    const sneaky = commit(
      "Subject\n\nAgent-Session: s1\nCo-authored-by: Claude\n <noreply@anthropic.com>",
      "good",
    );
    expect(
      await workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [
          {
            author: { name: "good", email: "a@b.c" },
            coAuthor: null,
            agentSession: "s1",
          },
        ],
        stripEmails: ["noreply@anthropic.com"],
        protectedCommits: [],
      }),
    ).toEqual([{ commit: sneaky, problems: ["engine_co_author"] }]);
  });

  test("with no expectation there is nothing to judge", async () => {
    commit("wrong");
    expect(
      await workspaceMismatches({
        root: repo,
        tip: "HEAD",
        expectations: [],
        stripEmails: [],
        protectedCommits: [],
      }),
    ).toEqual([]);
  });

  test("a repository git cannot read is unverified, never clean", async () => {
    const tip = "d".repeat(40);
    expect(
      await workspaceMismatches({
        root: join(root, "missing"),
        tip,
        expectations: [expectation],
        stripEmails: [],
        protectedCommits: [],
      }),
    ).toEqual([{ commit: tip, problems: [...ATTRIBUTION_PROBLEMS] }]);
  });
});
