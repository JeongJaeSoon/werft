import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { BootstrapClaimResponse } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
  type GitHubGrant,
  priceProviderUsage,
  type WorkerGateway,
} from "@werft-ai/platform";
import { ClaudeSdkRuntime, runtimeEnvironment } from "@werft-ai/runtime-claude";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  type FakeResponsesServer,
  startFakeResponsesServer,
} from "@werft-ai/testkit/fake-responses";
import {
  createServedRepository,
  type GitHttpServer,
  startGitHttpServer,
} from "@werft-ai/testkit/git-http";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
} from "../apps/control-host/src/api/egress-authorizer.ts";
import {
  releaseOnConnection,
  TEST_OWNER,
} from "../apps/control-host/src/testing/releases.ts";
import {
  type CredentialProxyServer,
  startCredentialProxy,
} from "../apps/egress-proxy/src/credential.ts";
import { createProxyLogger } from "../apps/egress-proxy/src/logger.ts";
import { engineProfile } from "../apps/worker/src/composition.ts";
import {
  claimSecrets,
  SecretScrubber,
} from "../apps/worker/src/secret-scrubber.ts";
import { GitWorkspace } from "../apps/worker/src/workspace.ts";

/**
 * Credential routes end to end in one process: the real gateway issues a claim,
 * real authorizer answers the real credential proxy, and the real engine
 * child and the real `git` go through it. What is checked is where the
 * catalog's credentials are and are not: on the upstream's requests, and
 * nowhere in the claim, the engine's environment or the checkout.
 */

const AUTHORIZER_BEARER = `authorizer-${crypto.randomUUID()}`;
const CLAUDE_CONNECTION = "claude";
const RESPONSES_CONNECTION = "openai";
const REPOSITORY_HOST = "git.test";
const silentProxy = createProxyLogger("error", () => {});

let client: PGlite | undefined;
let messages: FakeAnthropicServer | undefined;
let responses: FakeResponsesServer | undefined;
let repository: GitHttpServer | undefined;
let authorizer: ReturnType<typeof Bun.serve> | undefined;
let proxy: CredentialProxyServer | undefined;
let isolated: IsolatedWorkspace | undefined;
let scratch: string | undefined;

beforeEach(async () => {
  client = await migratedPGlite();
});

afterEach(async () => {
  proxy?.stop();
  authorizer?.stop(true);
  messages?.stop();
  responses?.stop();
  await repository?.stop();
  await isolated?.dispose();
  if (scratch !== undefined) {
    await rm(scratch, { force: true, recursive: true });
  }
  await client?.close();
  proxy = undefined;
  authorizer = undefined;
  messages = undefined;
  responses = undefined;
  repository = undefined;
  isolated = undefined;
  scratch = undefined;
});

type Topology = {
  claim: BootstrapClaimResponse;
  gateway: WorkerGateway;
  bootstrapNonce: string;
  credentialUrl: string;
  providerValue: string;
  repositoryPassword: string;
  repositoryUrl: string;
};

const RESPONSES_UPSTREAM_VALUE = `catalog-openai-${crypto.randomUUID()}`;

async function topology(
  connectionId: string = CLAUDE_CONNECTION,
): Promise<Topology> {
  if (client === undefined) throw new Error("no database");
  const db = drizzle(client, { schema });
  const providerValue = `catalog-provider-${crypto.randomUUID()}`;
  const repositoryPassword = `catalog-repository-${crypto.randomUUID()}`;
  const basic = `Basic ${Buffer.from(`x-access-token:${repositoryPassword}`).toString("base64")}`;

  messages = startFakeAnthropicServer(
    textReply("through the credential route"),
  );
  responses = startFakeResponsesServer({
    text: "through the Responses route",
    usage: { input_tokens: 1000, output_tokens: 2000, cached_tokens: 400 },
  });
  repository = await startGitHttpServer({ authorization: basic });
  await createServedRepository(repository, "app", {
    "README.md": "hello\n",
  });
  const repositoryUrl = `http://${REPOSITORY_HOST}:${repository.port}/app.git`;

  const gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: {
      connections: {
        [CLAUDE_CONNECTION]: {
          provider: {
            kind: "anthropic",
            endpoint: messages.url,
            auth: {
              kind: "api_key",
              value: providerValue,
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
          models: ["claude-sonnet-4-5"],
          auto_mode: "unknown",
        },
        [RESPONSES_CONNECTION]: {
          provider: {
            kind: "openai_responses",
            endpoint: responses.url,
            auth: {
              kind: "api_key",
              value: RESPONSES_UPSTREAM_VALUE,
              ref: { value_env: "OPENAI_KEY" },
            },
          },
          models: ["gpt-5.5"],
          auto_mode: "unknown",
        },
      },
      repositories: {
        app: {
          url: repositoryUrl,
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    },
    github: {
      grant: async () =>
        ({
          gitCredential: {
            username: "x-access-token",
            password: repositoryPassword,
          },
        }) as GitHubGrant,
    },
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
  authorizer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createEgressAuthorizer({
      gateway,
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_BEARER,
    }),
  });
  const upstreams = [
    { host: "127.0.0.1", port: Number(new URL(messages.url).port) },
    { host: "127.0.0.1", port: Number(new URL(responses.url).port) },
    { host: REPOSITORY_HOST, port: repository.port },
  ];
  proxy = startCredentialProxy({
    authorizer: {
      url: `http://127.0.0.1:${authorizer.port}`,
      token: AUTHORIZER_BEARER,
    },
    hostname: "127.0.0.1",
    logger: silentProxy,
    policy: { allow: [], allowPrivate: upstreams },
    port: 0,
    resolve: async (host) =>
      isIP(host) !== 0 ? [host] : host === REPOSITORY_HOST ? ["127.0.0.1"] : [],
  });

  // A release on the connection, its spec naming that connection's endpoint.
  const responsesSession = connectionId === RESPONSES_CONNECTION;
  const model = responsesSession ? "gpt-5.5" : "claude-sonnet-4-5";
  const releaseId = await releaseOnConnection(db, {
    model,
    connection: responsesSession
      ? {
          id: RESPONSES_CONNECTION,
          kind: "openai_responses",
          endpoint: responses.url,
          billing: "per_token",
        }
      : {
          id: CLAUDE_CONNECTION,
          kind: "anthropic",
          endpoint: messages.url,
          billing: "per_token",
        },
    spec: { tools: [] },
  });
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: TEST_OWNER },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    agentReleaseId: releaseId,
    model,
    repository: { id: "app", url: repositoryUrl, branch: "main" },
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await launchSession(db, {
    sessionId: accepted.response.session_id,
  });
  const claim = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
  return {
    claim,
    gateway,
    bootstrapNonce: launch.nonce,
    credentialUrl: `http://127.0.0.1:${proxy.port}`,
    providerValue,
    repositoryPassword,
    repositoryUrl,
  };
}

/** One engine turn through the credential route, as a worker runs it. */
async function engineTurn(
  claim: BootstrapClaimResponse,
  credentialUrl: string,
) {
  isolated = await createIsolatedWorkspace({ prefix: "94s-252-" });
  const profile = engineProfile(
    claim.runtime_config.provider,
    claim.principal.owner_scope,
    credentialUrl,
  );
  const config = {
    claudeConfigDir: isolated.home,
    correlationId: "94s-252",
    cwd: isolated.workspace,
    home: isolated.home,
    maxTurns: 1,
    mode: "new" as const,
    model: claim.runtime_config.model,
    profile,
    settingSources: [] as [],
    tools: [],
  };
  const environment = runtimeEnvironment(config, { PATH: process.env.PATH });
  const run = new ClaudeSdkRuntime({
    endpoints: [claim.runtime_config.provider.endpoint],
    models: [claim.runtime_config.model],
  }).start(config, {
    onPermission: async () => ({ behavior: "deny", message: "no tools" }),
  });
  run.send({ message: "hello through the route", uuid: crypto.randomUUID() });
  run.finishInput();
  const results: Array<Record<string, unknown>> = [];
  for await (const frame of run) {
    const message = frame.envelope.message as Record<string, unknown>;
    if (message.type === "result") results.push(message);
  }
  return { environment, results };
}

/** The session's cost once `rows` metered calls have been recorded. */
async function meteredCost(sessionId: string, rows: number) {
  if (client === undefined) throw new Error("no database");
  const db = drizzle(client, { schema });
  const by = performance.now() + 10_000;
  for (;;) {
    const recorded = await db
      .select({ costUsd: schema.providerUsage.costUsd })
      .from(schema.providerUsage)
      .where(eq(schema.providerUsage.sessionId, sessionId));
    if (recorded.length >= rows) {
      const [session] = await db
        .select({ costUsd: schema.sessions.costUsd })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId));
      return {
        session: session?.costUsd,
        metered: recorded.reduce((sum, row) => sum + row.costUsd, 0),
      };
    }
    if (performance.now() > by) throw new Error("usage never recorded");
    await Bun.sleep(20);
  }
}

describe("credential routes end to end", () => {
  test("AC1: the engine's Messages call gets the provider key only at the proxy", async () => {
    const { claim, credentialUrl, providerValue } = await topology();
    if (messages === undefined) throw new Error("no Messages server");
    // Nothing the worker is handed carries the key.
    expect(JSON.stringify(claim)).not.toContain(providerValue);
    expect(claim.runtime_config.provider.auth.kind).toBe("egress_token");

    const { environment, results } = await engineTurn(claim, credentialUrl);
    expect(JSON.stringify(environment)).not.toContain(providerValue);
    expect(environment.ANTHROPIC_BASE_URL).toBe(`${credentialUrl}/provider`);
    expect(results).toHaveLength(1);

    // The upstream saw the catalog's key and never the attempt's token.
    expect(messages.requests.length).toBeGreaterThan(0);
    for (const request of messages.requests) {
      expect(request.headers["x-api-key"]).toBe(providerValue);
      expect(JSON.stringify(request.headers)).not.toContain(
        claim.runtime_config.provider.auth.token,
      );
    }
  }, 60_000);

  test("AC2: the repository is cloned through the route and stored without userinfo", async () => {
    const { claim, credentialUrl, repositoryPassword, repositoryUrl } =
      await topology();
    if (repository === undefined) throw new Error("no repository server");
    expect(JSON.stringify(claim)).not.toContain(repositoryPassword);
    const access = claim.workspace.repository.access;
    if (access === undefined) throw new Error("no repository token");

    scratch = await mkdtemp(join(tmpdir(), "94s-252-clone-"));
    const root = join(scratch, "workspace");
    const action = await new GitWorkspace(
      root,
      "CLAUDE.md",
      credentialUrl,
    ).prepare({
      descriptor: claim.workspace,
      restore: null,
      signal: AbortSignal.timeout(60_000),
    });
    expect(action).toBe("clone");
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hello\n");

    const config = await readFile(join(root, ".git", "config"), "utf8");
    // The repository's own URL, no userinfo, and neither credential.
    expect(config).toContain(`url = ${repositoryUrl}`);
    expect(config).not.toContain("@");
    expect(config).not.toContain(access.token);
    expect(config).not.toContain(repositoryPassword);
    expect(config).not.toContain(credentialUrl);

    // Every request the repository answered carried the login the gate issued,
    // and only upload-pack was asked for.
    const served = repository.requests;
    expect(served.length).toBeGreaterThan(0);
    for (const request of served) {
      expect(request.authorization).toStartWith("Basic ");
      expect(request.path).toMatch(
        /^\/app\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/,
      );
    }
  }, 60_000);

  test("AC3: a real shell dumping the engine's environment and the remote shows no catalog value, and the scrubber takes the rest", async () => {
    const {
      claim,
      bootstrapNonce,
      credentialUrl,
      providerValue,
      repositoryPassword,
    } = await topology();
    scratch = await mkdtemp(join(tmpdir(), "94s-252-dump-"));
    const root = join(scratch, "workspace");
    await new GitWorkspace(root, "CLAUDE.md", credentialUrl).prepare({
      descriptor: claim.workspace,
      restore: null,
      signal: AbortSignal.timeout(60_000),
    });
    // What a Bash tool call in the engine sees: the engine's own
    // environment, in the checkout the worker prepared.
    const environment = runtimeEnvironment(
      {
        claudeConfigDir: join(scratch, "home"),
        correlationId: "94s-252",
        cwd: root,
        home: join(scratch, "home"),
        maxTurns: 1,
        mode: "new",
        model: claim.runtime_config.model,
        profile: engineProfile(
          claim.runtime_config.provider,
          claim.principal.owner_scope,
          credentialUrl,
        ),
        settingSources: [],
        tools: [],
      },
      { PATH: process.env.PATH },
    );
    const dump = spawnSync(
      "sh",
      ["-c", "env; git remote -v; git config --list --show-origin"],
      { cwd: root, env: environment, encoding: "utf8" },
    );
    expect(dump.status).toBe(0);
    const printed = `${dump.stdout}${dump.stderr}`;
    expect(printed).toContain("origin");

    // The catalog's credentials are not there to print at all.
    expect(printed).not.toContain(providerValue);
    expect(printed).not.toContain(repositoryPassword);
    // Nor is the engine's own token: it goes down a descriptor the engine
    // closes. Whatever else of the attempt's a tool finds, the
    // scrubber the worker puts in front of its events removes.
    const held = claimSecrets(claim, bootstrapNonce);
    expect(printed).not.toContain(claim.runtime_config.provider.auth.token);
    const scrubbed = new SecretScrubber(held).scrub(printed);
    for (const value of held) {
      if (value !== undefined) expect(scrubbed).not.toContain(value);
    }
  }, 60_000);

  test("a direct call on the engine's token stops once the session has spent its limit", async () => {
    const { claim, credentialUrl } = await topology();
    if (client === undefined || messages === undefined) {
      throw new Error("no topology");
    }
    const direct = () =>
      fetch(`${credentialUrl}/provider/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": claim.runtime_config.provider.auth.token,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: claim.runtime_config.model,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    const within = await direct();
    expect(within.status).toBe(200);
    await within.text();
    const served = messages.requests.length;
    await drizzle(client, { schema })
      .update(schema.sessions)
      .set({ costUsd: 1_000 })
      .where(eq(schema.sessions.id, claim.session_id));
    const over = await direct();
    expect(over.status).toBe(403);
    await over.text();
    expect(messages.requests).toHaveLength(served);
  }, 60_000);

  test("a tool's direct call on the engine's token is metered into the session's cost", async () => {
    const { claim, credentialUrl } = await topology();
    const direct = await fetch(`${credentialUrl}/provider/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": claim.runtime_config.provider.auth.token,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: claim.runtime_config.model,
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(direct.status).toBe(200);
    await direct.text();

    // The fake answers with one input and four output tokens.
    const { costUsd } = priceProviderUsage({
      model: claim.runtime_config.model,
      inputTokens: 1,
      outputTokens: 4,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
      speed: "standard",
      inferenceGeo: "global",
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      estimated: false,
    });
    expect(costUsd).toBeGreaterThan(0);
    expect(await meteredCost(claim.session_id, 1)).toEqual({
      session: costUsd,
      metered: costUsd,
    });
  }, 60_000);

  test("an engine turn is counted once: the session's cost is what the proxy metered, and finalize adds nothing", async () => {
    const { claim, gateway, credentialUrl } = await topology();
    if (messages === undefined) throw new Error("no Messages server");
    const principal = {
      kind: "session" as const,
      sessionId: claim.session_id,
      attemptId: claim.attempt_id,
      leaseEpoch: claim.lease_epoch,
      executionGeneration: claim.execution_generation,
      authRevision: claim.auth_revision,
    };
    const scope = (turnId: string | null) => ({
      session_id: claim.session_id,
      turn_id: turnId,
      attempt_id: claim.attempt_id,
      lease_epoch: claim.lease_epoch,
      execution_generation: claim.execution_generation,
      auth_revision: claim.auth_revision,
    });
    const next = await gateway.nextInput(principal, scope(null));
    const turnId = next.input?.turn_id ?? null;
    expect(turnId).not.toBeNull();

    const { results } = await engineTurn(claim, credentialUrl);
    const sdkCost = results[0]?.total_cost_usd;
    if (typeof sdkCost !== "number") throw new Error("no engine cost");
    const calls = messages.requests.filter((request) =>
      request.path.startsWith("/v1/messages?"),
    ).length;
    expect(calls).toBeGreaterThan(0);
    const metered = await meteredCost(claim.session_id, calls);

    await gateway.finalize(principal, {
      ...scope(turnId),
      turn_id: turnId ?? "",
      finalize_key: "fin-1",
      final_source_sequence: 0,
      terminal: {
        status: "completed",
        reason: null,
        result: null,
        usage: null,
        cost_usd: sdkCost,
      },
      checkpoint: null,
    });

    const settled = await meteredCost(claim.session_id, calls);
    expect(settled.session).toBe(metered.metered);
    expect(settled.metered).toBe(metered.metered);
    // The engine priced the same calls the same way.
    expect(settled.session).toBeCloseTo(sdkCost, 6);
  }, 60_000);

  describe("the Responses route", () => {
    const direct = (
      credentialUrl: string,
      claim: BootstrapClaimResponse,
      path = "/provider/v1/responses",
      stream = false,
    ) =>
      fetch(`${credentialUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${claim.runtime_config.provider.auth.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: claim.runtime_config.model,
          max_output_tokens: 16,
          stream,
          input: "hi",
        }),
      });

    test("an openai_responses session reaches the upstream with the catalog key only at the proxy, and the call is metered", async () => {
      const { claim, credentialUrl } = await topology(RESPONSES_CONNECTION);
      if (responses === undefined) throw new Error("no Responses server");
      expect(claim.runtime_config.provider.kind).toBe("openai_responses");
      expect(JSON.stringify(claim)).not.toContain(RESPONSES_UPSTREAM_VALUE);

      const answer = await direct(credentialUrl, claim, undefined, true);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain("response.completed");

      expect(responses.requests).toHaveLength(1);
      const [seen] = responses.requests;
      expect(seen?.path).toBe("/v1/responses");
      expect(seen?.headers.authorization).toBe(
        `Bearer ${RESPONSES_UPSTREAM_VALUE}`,
      );
      expect(JSON.stringify(seen?.headers)).not.toContain(
        claim.runtime_config.provider.auth.token,
      );

      // 1000 prompt tokens of which 400 came from cache, 2000 out.
      const { costUsd } = priceProviderUsage({
        model: claim.runtime_config.model,
        inputTokens: 600,
        outputTokens: 2000,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 400,
        speed: "standard",
        inferenceGeo: "global",
        webSearchRequests: 0,
        webFetchRequests: 0,
        codeExecutionRequests: 0,
        estimated: false,
      });
      expect(costUsd).toBeGreaterThan(0);
      expect(await meteredCost(claim.session_id, 1)).toEqual({
        session: costUsd,
        metered: costUsd,
      });
    }, 60_000);

    test("a direct call on the engine's token stops once the session has spent its limit", async () => {
      const { claim, credentialUrl } = await topology(RESPONSES_CONNECTION);
      if (client === undefined || responses === undefined) {
        throw new Error("no topology");
      }
      const within = await direct(credentialUrl, claim);
      expect(within.status).toBe(200);
      await within.text();
      const served = responses.requests.length;
      await drizzle(client, { schema })
        .update(schema.sessions)
        .set({ costUsd: 1_000 })
        .where(eq(schema.sessions.id, claim.session_id));
      const over = await direct(credentialUrl, claim);
      expect(over.status).toBe(403);
      expect(await over.text()).toContain("BUDGET_EXCEEDED");
      expect(responses.requests).toHaveLength(served);
    }, 60_000);

    test("a Claude session is refused /v1/responses before any upstream is contacted", async () => {
      const { claim, credentialUrl } = await topology();
      const refused = await direct(credentialUrl, claim);
      expect(refused.status).toBe(403);
      await refused.text();
      expect(responses?.requests).toEqual([]);
      expect(messages?.requests).toEqual([]);
    }, 60_000);

    test("an openai_responses session is refused the Messages route", async () => {
      const { claim, credentialUrl } = await topology(RESPONSES_CONNECTION);
      const refused = await direct(
        credentialUrl,
        claim,
        "/provider/v1/messages",
      );
      expect(refused.status).toBe(403);
      await refused.text();
      expect(responses?.requests).toEqual([]);
      expect(messages?.requests).toEqual([]);
    }, 60_000);

    test("a token the gateway never issued is refused", async () => {
      const { credentialUrl } = await topology(RESPONSES_CONNECTION);
      const unknown = await fetch(`${credentialUrl}/provider/v1/responses`, {
        method: "POST",
        headers: { authorization: "Bearer not-issued" },
        body: "{}",
      });
      expect(unknown.status).toBe(401);
      expect(responses?.requests).toEqual([]);
    }, 60_000);
  });

  test("the route refuses a token for the other purpose and one it never issued", async () => {
    const { claim, credentialUrl } = await topology();
    const providerHeld = claim.runtime_config.provider.auth.token;
    const refs = await fetch(
      `${credentialUrl}/repository/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${providerHeld}` } },
    );
    expect(refs.status).toBe(401);
    const unknown = await fetch(`${credentialUrl}/provider/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "wep_never-issued" },
      body: "{}",
    });
    expect(unknown.status).toBe(401);
    expect(messages?.requests).toEqual([]);
    expect(repository?.requests).toEqual([]);
    // The authorizer answers only its own bearer, on its own listener.
    const direct = await fetch(
      `http://127.0.0.1:${authorizer?.port}${EGRESS_AUTHORIZER_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: providerHeld, purpose: "provider" }),
      },
    );
    expect(direct.status).toBe(401);
  }, 60_000);

  // The public registries are on no list here, as on a proxy whose operator
  // has not opened them: the claim's packages token is good, the route is
  // judged, and the registry is still refused before anything is dialled.
  test("a packages request reaches a registry only through the credential allowlist", async () => {
    const { claim, credentialUrl } = await topology();
    const token = claim.packages?.access.token ?? "";
    expect(token.startsWith("wek_")).toBe(true);
    const metadata = await fetch(`${credentialUrl}/packages/npm/left-pad`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metadata.status).toBe(403);
    expect(await metadata.text()).toContain("egress denied");
    const publish = await fetch(`${credentialUrl}/packages/npm/left-pad`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(publish.status).toBe(404);
    const other = await fetch(`${credentialUrl}/packages/npm/left-pad`, {
      headers: { authorization: `Bearer ${claim.object_store.access.token}` },
    });
    expect(other.status).toBe(401);
  }, 60_000);
});
