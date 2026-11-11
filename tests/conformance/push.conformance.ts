import { describe, expect, test } from "bun:test";
import { Api, e2eEnv, poll } from "../e2e/client.ts";
import { docker, serviceContainer } from "./docker.ts";
import { scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";

/**
 * A commit the session made goes to the agent branch on the forge only after
 * a person approves it: approve pushes exactly the commit the request named,
 * reject pushes nothing. The request is made over REST, so the path under test
 * is the platform's, the same for every engine; what an engine contributes is
 * the commit its turn leaves in the workspace and the checkpoint that holds it.
 */
const engine = engineFromEnv();
const api = new Api(e2eEnv({ needsMessages: false }));
const TIMEOUT = 600_000;
const SESSION_ID = /^[0-9a-f-]{36}$/;
const WATCH_LOOKS = 10;
const WATCH_INTERVAL_MS = 500;

type PushRequest = {
  git_commit: string;
  id: string;
  state: string;
  target_branch: string;
};

type Committed = { content: string; file: string; sessionId: string };

/** A session whose turn committed a file only this scenario writes. */
async function sessionWithCommit(name: string): Promise<Committed> {
  const id = scriptId(name);
  const file = `${id}.txt`;
  const commit = [
    "cd /workspace",
    `echo ${id} > ${file}`,
    `git add ${file}`,
    "git -c user.name=conformance -c user.email=conformance@example.test commit -q -m conformance",
  ].join(" && ");
  const created = await api.createSession(
    engine.prompt({ id, commands: [commit], final: "committed" }),
    undefined,
    engine.profileId,
    engine.repositoryId,
  );
  expect(created.status).toBe(201);
  const sessionId = created.body.session_id;
  expect((await api.settleAllowing(sessionId, "1")).status).toBe("completed");
  await api.sessionUntil(
    sessionId,
    "has checkpointed turn 1",
    (s) => s.durability.last_checkpointed_turn_id === "1",
  );
  return { content: id, file, sessionId };
}

async function requestPush(sessionId: string): Promise<PushRequest> {
  const made = await api.request<PushRequest>(
    "POST",
    `/v1/sessions/${sessionId}/push-requests`,
    {},
  );
  expect(made.status).toBe(201);
  expect(made.body.state).toBe("requested");
  expect(made.body.target_branch).toBe(`agent/${sessionId}`);
  return made.body;
}

/**
 * Runs git in the fake forge's repository. The glob must name exactly one
 * repository, so a leftover from an earlier crash fails loudly instead of
 * splitting git's arguments.
 */
async function forgeGit(args: string[]): Promise<string> {
  const repo = `/tmp/testkit-fake-github-*/agent/${engine.repositoryId}.git`;
  return docker([
    "exec",
    await serviceContainer("fake-git"),
    "sh",
    "-c",
    `n=0; for d in ${repo}; do n=$((n+1)); dir=$d; done; [ "$n" = 1 ] || exit 3; exec git --git-dir="$dir" "$@"`,
    "sh",
    ...args,
  ]);
}

/** The commit the forge holds on the session's agent branch, or null. */
async function forgeBranch(sessionId: string): Promise<string | null> {
  expect(sessionId).toMatch(SESSION_ID);
  const sha = (
    await forgeGit([
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/agent/${sessionId}`,
    ])
  ).trim();
  return sha === "" ? null : sha;
}

/** A file's content at a commit the forge holds. */
async function forgeFile(commit: string, file: string): Promise<string> {
  return (await forgeGit(["show", `${commit}:${file}`])).trim();
}

async function stateOf(sessionId: string, id: string): Promise<string> {
  const list = await api.request<{ items: PushRequest[] }>(
    "GET",
    `/v1/sessions/${sessionId}/push-requests`,
  );
  const item = list.body.items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`push request ${id} is not listed`);
  return item.state;
}

describe(`push approval on ${engine.runtimeKind}`, () => {
  test(
    "approving pushes the requested commit to the agent branch on the forge",
    async () => {
      const { content, file, sessionId } =
        await sessionWithCommit("push-approve");
      expect(await forgeBranch(sessionId)).toBeNull();
      const request = await requestPush(sessionId);

      // Asking pushes nothing: the branch waits for a decision.
      expect(await forgeBranch(sessionId)).toBeNull();

      const approved = await api.request<PushRequest>(
        "POST",
        `/v1/sessions/${sessionId}/push-requests/${request.id}/approve`,
        { git_commit: request.git_commit },
      );
      expect(approved.status).toBe(200);

      const state = await poll(
        `push ${request.id} to finish`,
        120_000,
        async () => {
          const current = await stateOf(sessionId, request.id);
          return current === "pushed" || current === "failed" ? current : null;
        },
      );
      expect(state).toBe("pushed");
      expect(await forgeBranch(sessionId)).toBe(request.git_commit);

      // A turn whose command failed would still leave a checkpoint to push.
      expect(await forgeFile(request.git_commit, file)).toBe(content);
    },
    TIMEOUT,
  );

  test(
    "rejecting pushes nothing and the request stays rejected",
    async () => {
      const { sessionId } = await sessionWithCommit("push-reject");
      const request = await requestPush(sessionId);

      const rejected = await api.request<PushRequest>(
        "POST",
        `/v1/sessions/${sessionId}/push-requests/${request.id}/reject`,
        { git_commit: request.git_commit, reason: "conformance" },
      );
      expect(rejected.status).toBe(200);
      expect(rejected.body.state).toBe("rejected");

      // The platform's push is asynchronous: an approved request is on the
      // forge within a second, so a push wrongly queued by the rejection
      // would show inside this window.
      for (let look = 0; look < WATCH_LOOKS; look += 1) {
        expect(await stateOf(sessionId, request.id)).toBe("rejected");
        expect(await forgeBranch(sessionId)).toBeNull();
        await Bun.sleep(WATCH_INTERVAL_MS);
      }
    },
    TIMEOUT,
  );
});
