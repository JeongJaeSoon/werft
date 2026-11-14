import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * .github/scripts/preview-request.sh against a stand-in gh: which requests
 * for an internet-facing Actions preview it lets through, and what it hands
 * the workflow.
 */

const script = join(
  import.meta.dir,
  "..",
  ".github/scripts/preview-request.sh",
);
const REPO = "owner/werft";
const HEAD = "a".repeat(40);
const LABELED_HEAD = "b".repeat(40);
const SSH_KEY = "ssh-ed25519 AAAAC3placeholderkey";
const AGE_KEY = `age1${"q".repeat(58)}`;

describe(".github/scripts/preview-request.sh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "preview-request-"));
    await writeFile(
      join(dir, "gh"),
      `#!/bin/sh
case "$2" in
  repos/${REPO}/pulls/*) cat "${dir}/pull.json" ;;
  repos/${REPO}/collaborators/*/permission) [ -n "$STUB_PERMISSION" ] || exit 1; echo "$STUB_PERMISSION" ;;
  users/*/keys) printf '%s' "$STUB_KEYS" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  async function request(
    pull: Record<string, unknown>,
    env: Record<string, string> = {},
  ) {
    await writeFile(
      join(dir, "pull.json"),
      JSON.stringify({
        state: "open",
        head: { sha: HEAD, repo: { full_name: REPO } },
        labels: [{ name: "preview" }],
        ...pull,
      }),
    );
    await writeFile(join(dir, "output"), "");
    const handle = Bun.spawn(["bash", script], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GITHUB_REPOSITORY: REPO,
        GITHUB_OUTPUT: join(dir, "output"),
        RECIPIENTS: join(dir, "recipients"),
        PR: "12",
        MINUTES: "60",
        STARTER: "maintainer",
        STUB_PERMISSION: "write",
        STUB_KEYS: `${SSH_KEY}\necdsa-sha2-nistp256 AAAAplaceholder\n`,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      handle.exited,
      new Response(handle.stdout).text(),
    ]);
    return {
      exitCode,
      stdout,
      output: await readFile(join(dir, "output"), "utf8"),
      recipients: await readFile(join(dir, "recipients"), "utf8").catch(
        () => "",
      ),
    };
  }

  test("an open PR from a branch here, started with write access, gets its head and the starter's ed25519/rsa keys", async () => {
    const result = await request({});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`head=${HEAD}\n`);
    expect(result.recipients).toBe(`${SSH_KEY}\n`);
  });

  test("a label run serves the head the label went on, while the label is still there", async () => {
    const result = await request({}, { LABEL_HEAD: LABELED_HEAD });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(`head=${LABELED_HEAD}\n`);

    const late = await request({ labels: [] }, { LABEL_HEAD: LABELED_HEAD });
    expect(late.exitCode).toBe(1);
    expect(late.stdout).toContain("no longer has the preview label");
    expect(late.output).toBe("");
  });

  test("a recipient is added after the GitHub keys", async () => {
    const result = await request({}, { RECIPIENT: AGE_KEY });
    expect(result.exitCode).toBe(0);
    expect(result.recipients).toBe(`${SSH_KEY}\n${AGE_KEY}\n`);
  });

  test.each([
    [
      "a fork",
      { head: { sha: HEAD, repo: { full_name: "someone/werft" } } },
      {},
      "#12 comes from someone/werft, not a branch of owner/werft",
    ],
    [
      "a deleted fork",
      { head: { sha: HEAD, repo: null } },
      {},
      "#12 comes from a deleted fork",
    ],
    ["a closed PR", { state: "closed" }, {}, "#12 is closed, not open"],
    [
      "triage access",
      {},
      { STUB_PERMISSION: "triage" },
      "maintainer has triage access to owner/werft; a preview takes write or above",
    ],
    [
      "an unreadable permission",
      {},
      { STUB_PERMISSION: "" },
      "cannot read maintainer's permission",
    ],
    [
      "no usable key and no recipient",
      {},
      { STUB_KEYS: "ecdsa-sha2-nistp256 AAAAplaceholder\n" },
      "maintainer has no ssh-ed25519 or ssh-rsa key on GitHub and the run names no recipient",
    ],
    ["4 minutes", {}, { MINUTES: "4" }, "minutes must be a whole number"],
    ["181 minutes", {}, { MINUTES: "181" }, "minutes must be a whole number"],
    [
      "a PR that is no number",
      {},
      { PR: "12;id" },
      "PR must be a pull request number",
    ],
    [
      "a recipient with a shell suffix",
      {},
      { RECIPIENT: `${AGE_KEY}$(id)` },
      "recipient must be one age1",
    ],
  ])("refuses %s", async (_, pull, env, reason) => {
    const result = await request(pull, env);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`::error::preview refused: ${reason}`);
    expect(result.output).toBe("");
  });
});
