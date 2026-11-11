import { Api, type E2eEnv, firstOwnerCookie } from "../e2e/client.ts";
import type { EngineFixture } from "./engine.ts";

/**
 * An agent release whose GitHub settings let its sessions ask to push, and two
 * people to run it: whoever starts a session cannot approve its requests, so
 * the approval needs a second principal.
 */
export type PushAgent = { approver: Api; releaseId: string; starter: Api };

type Reply<T> = { body: T; status: number };

export async function pushAgent(
  engine: EngineFixture,
  env: E2eEnv,
  name: string,
): Promise<PushAgent> {
  const token = process.env.E2E_BOOTSTRAP_TOKEN;
  if (!token) throw new Error("E2E_BOOTSTRAP_TOKEN is unset");
  const cookie = await firstOwnerCookie(env.apiUrl, token);
  const web = async <T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply<T>> => {
    const headers: Record<string, string> = {
      "x-requested-with": "werft-web",
      cookie,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
    const response = await fetch(`${env.apiUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed = text === "" ? null : JSON.parse(text);
    if (response.status >= 400) {
      throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
    }
    return { status: response.status, body: parsed as T };
  };

  const team = await web<{ team: { id: string } }>("POST", "/v1/teams", {
    name,
  });
  const agent = await web<{
    agent: { id: string };
    versions: { id: string }[];
  }>("POST", "/v1/agents", {
    slug: name,
    name,
    managing_team_id: team.body.team.id,
    card: {
      role: "conformance push agent",
      instructions: "Answer as scripted.",
      language: "en",
      model: engine.cardModel,
      capabilities: { tools: ["Read", "Bash"], mcp: null, forbidden: [] },
      rules: [],
    },
  });
  const release = await web<{ release: { id: string } }>(
    "POST",
    `/v1/agents/${agent.body.agent.id}/releases`,
    {
      version_id: agent.body.versions[0]?.id,
      runtime_profile_id: engine.profileId,
      repository_id: engine.repositoryId,
      github: {
        repositories: [engine.repositoryId],
        push_approval: true,
        actions_allow: [],
        features: {
          workflows: false,
          actions: false,
          checks: false,
          issues: false,
          review: false,
        },
      },
    },
  );
  await web("POST", `/v1/agents/${agent.body.agent.id}/activate`, {
    release_id: release.body.release.id,
    expected_revision: -1,
  });

  const person = async (scopes: string[]) => {
    const key = await web<{ secret: string }>("POST", "/v1/api-keys", {
      kind: "personal",
      scopes,
    });
    return new Api({ ...env, apiKey: key.body.secret });
  };
  return {
    releaseId: release.body.release.id,
    starter: await person([
      "sessions:read",
      "sessions:write",
      "sessions:control",
    ]),
    approver: await person(["sessions:read", "sessions:approve"]),
  };
}
