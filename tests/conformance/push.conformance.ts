import { describe, expect, test } from "bun:test";
import { Api, e2eStack, poll } from "../e2e/client.ts";
import { scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";
import { forgeBranch, forgeFile } from "./forge.ts";

/**
 * A commit the session made goes to the agent branch on the forge only after
 * a person approves it: approve pushes exactly the commit the request named,
 * reject pushes nothing. The request is made over REST, so the path under test
 * is the platform's, the same for every engine; what an engine contributes is
 * the commit its turn leaves in the workspace and the checkpoint that holds it.
 */
const engine = engineFromEnv();
const api = new Api(
  await e2eStack({ needsMessages: false, connectionId: engine.connectionId }),
);
const TIMEOUT = 600_000;
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
      expect(await forgeBranch(engine, sessionId)).toBeNull();
      const request = await requestPush(sessionId);

      // Asking pushes nothing: the branch waits for a decision.
      expect(await forgeBranch(engine, sessionId)).toBeNull();

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
      expect(await forgeBranch(engine, sessionId)).toBe(request.git_commit);

      // A turn whose command failed would still leave a checkpoint to push.
      expect(await forgeFile(engine, request.git_commit, file)).toBe(content);
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
        expect(await forgeBranch(engine, sessionId)).toBeNull();
        await Bun.sleep(WATCH_INTERVAL_MS);
      }
    },
    TIMEOUT,
  );
});
