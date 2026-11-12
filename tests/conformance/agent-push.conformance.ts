import { describe, expect, test } from "bun:test";
import { type Api, e2eEnv, poll } from "../e2e/client.ts";
import { type PushAgent, pushAgent } from "./agent.ts";
import { scriptId } from "./engine.ts";
import { engineFromEnv } from "./engines.ts";
import { forgeBranch, forgeFile, forgePushRequests } from "./forge.ts";

/**
 * The agent asks to push through its own `request_push` tool, the path that
 * crosses the engine: Claude reaches the platform's MCP server directly, Codex
 * through the worker's relay. What the scenario checks is the same for both:
 * the call ends as a pending push request that a second principal decides,
 * approve puts the commit on the forge, reject leaves it empty.
 */
const engine = engineFromEnv();
const env = e2eEnv({ needsMessages: false });
const TIMEOUT = 600_000;
const WATCH_LOOKS = 10;
const WATCH_INTERVAL_MS = 500;

type PushRequest = { git_commit: string; id: string; state: string };

async function agentPushed(name: string): Promise<{
  agent: PushAgent;
  content: string;
  file: string;
  session: string;
}> {
  const agent = await pushAgent(engine, env, name);
  const id = scriptId(name);
  const file = `${id}.txt`;
  const commit = [
    "cd /workspace",
    `echo ${id} > ${file}`,
    `git add ${file}`,
    "git -c user.name=conformance -c user.email=conformance@example.test commit -q -m conformance",
  ].join(" && ");
  const created = await agent.starter.request<{ session_id: string }>(
    "POST",
    "/v1/sessions",
    {
      agent_release_id: agent.releaseId,
      message: engine.prompt({
        id,
        commands: [commit],
        final: "asked to push",
        pushTool: true,
      }),
    },
  );
  expect(created.status).toBe(201);
  const session = created.body.session_id;
  expect((await agent.approver.settleAllowing(session, "1")).status).toBe(
    "completed",
  );
  // A call to a tool the model was never shown would prove nothing.
  expect(await engine.pushToolShown(id)).toBe(true);
  return { agent, content: id, file, session };
}

/** The request the agent's turn left behind, made by the platform after the turn ends. */
async function requestOf(user: Api, session: string): Promise<PushRequest> {
  return poll("the agent's push request", 120_000, async () => {
    const list = await user.request<{ items: PushRequest[] }>(
      "GET",
      `/v1/sessions/${session}/push-requests`,
    );
    return list.body.items[0] ?? null;
  });
}

describe(`agent push tool on ${engine.runtimeKind}`, () => {
  test(
    "a push the agent asks for waits for a second principal, and approving puts the commit on the forge",
    async () => {
      const { agent, content, file, session } =
        await agentPushed("agent-push-approve");
      const request = await requestOf(agent.starter, session);
      expect(request.state).toBe("requested");
      expect(await forgeBranch(engine, session)).toBeNull();

      const approved = await agent.approver.request<PushRequest>(
        "POST",
        `/v1/sessions/${session}/push-requests/${request.id}/approve`,
        { git_commit: request.git_commit },
      );
      expect(approved.status).toBe(200);

      const state = await poll(
        `push ${request.id} to finish`,
        120_000,
        async () => {
          const list = await agent.starter.request<{ items: PushRequest[] }>(
            "GET",
            `/v1/sessions/${session}/push-requests`,
          );
          const current = list.body.items.find(
            (item) => item.id === request.id,
          )?.state;
          return current === "pushed" || current === "failed" ? current : null;
        },
      );
      expect(state).toBe("pushed");
      expect(await forgeBranch(engine, session)).toBe(request.git_commit);
      expect(await forgeFile(engine, request.git_commit, file)).toBe(content);
    },
    TIMEOUT,
  );

  test(
    "rejecting a push the agent asked for leaves the forge without the branch",
    async () => {
      const { agent, session } = await agentPushed("agent-push-reject");
      const request = await requestOf(agent.starter, session);
      const pushesBefore = await forgePushRequests(engine);

      const rejected = await agent.approver.request<PushRequest>(
        "POST",
        `/v1/sessions/${session}/push-requests/${request.id}/reject`,
        { git_commit: request.git_commit, reason: "conformance" },
      );
      expect(rejected.status).toBe(200);
      expect(rejected.body.state).toBe("rejected");

      for (let look = 0; look < WATCH_LOOKS; look += 1) {
        expect(await forgeBranch(engine, session)).toBeNull();
        await Bun.sleep(WATCH_INTERVAL_MS);
      }
      // No push request reached the forge at all, a refused one included.
      expect(await forgePushRequests(engine)).toBe(pushesBefore);
    },
    TIMEOUT,
  );
});
