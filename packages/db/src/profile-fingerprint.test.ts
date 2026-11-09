import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type CatalogProfile,
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  profileFingerprint,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  WorkerGatewayError,
  withSeededInstallation,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  events,
  sessions,
  turns,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import {
  insertUnreservedLaunch,
  launchSession,
  type TestLaunch,
} from "./testing/launches.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

/**
 * a session is held to the profile settings it was accepted with.
 * Two gateways share one database, as two API replicas mid-rollout would,
 * each with its own catalog: one that defines the same profile id with other
 * settings binds nothing, while one that differs only in the credential
 * value behind the same reference binds and routes with the new value.
 */

const PROFILE_ID = "claude-coding-v1";
const REPOSITORY = {
  url: "https://example.invalid/app.git",
  branch: "main",
  auth: { kind: "github_app", registered: true },
} as const;
const OWNER = testCaller("owner-a");

function profile(
  overrides: Partial<Omit<CatalogProfile, "provider">> & { key?: string } = {},
): CatalogProfile {
  const { key = "provider-key-one", ...settings } = overrides;
  return {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    ...settings,
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid",
      auth: { kind: "api_key", value: key, ref: { value_env: "PROVIDER_KEY" } },
    },
  };
}

function catalogOf(entry: CatalogProfile): SessionCatalog {
  return withSeededInstallation({
    settings_generation: 0,
    profiles: { [PROFILE_ID]: entry },
    repositories: {
      "sample-app": { ...REPOSITORY, profiles: [PROFILE_ID] },
    },
  });
}

const ORIGINAL = catalogOf(profile());
const ROTATED = catalogOf(profile({ key: "provider-key-two" }));
// A wider grant under the same id: what must not run an existing session.
const WIDENED = catalogOf(
  profile({ tools: ["Read", "Bash"], permission_mode: "acceptEdits" }),
);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

function serviceOf(catalog: SessionCatalog) {
  return createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });
}

function gatewayOf(catalog: SessionCatalog): WorkerGateway {
  return createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: {
      async verify() {
        return { status: "verified" };
      },
    },
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
}

async function createSession(catalog: SessionCatalog): Promise<string> {
  const created = await serviceOf(catalog).createSession(OWNER, {
    idempotencyKey: crypto.randomUUID(),
    body: {
      profile_id: PROFILE_ID,
      repository_id: "sample-app",
      message: "hello",
    },
  });
  return created.session_id;
}

async function storedFingerprint(sessionId: string) {
  const [row] = await db
    .select({ fingerprint: sessions.profileFingerprint })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.fingerprint;
}

/**
 * A launch as the scheduler reserves one. `pinned` makes it the session's
 * own, the way the scheduler's reservation does; otherwise it is a pool
 * launch that claims whatever its host may run.
 */
function launch(sessionId: string, pinned: boolean): Promise<TestLaunch> {
  return pinned
    ? launchSession(db, { sessionId })
    : insertUnreservedLaunch(db, { partition: "default" });
}

function claim(gateway: WorkerGateway, l: TestLaunch) {
  return gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: l.executionId,
      execution_generation: l.generation,
      credential: { kind: "launch_nonce", nonce: l.nonce },
    },
  );
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof WorkerGatewayError) {
      return { status: error.status, code: error.code };
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("profile fingerprint pinned at create", () => {
  test("create stores the fingerprint of the profile as the catalog defined it, never the credential", async () => {
    const sessionId = await createSession(ORIGINAL);
    const stored = await storedFingerprint(sessionId);
    expect(stored).toBe(profileFingerprint(profile()));
    expect(stored).not.toContain("provider-key-one");
    // The value is not part of it: a rotated key hashes the same.
    expect(stored).toBe(
      profileFingerprint(profile({ key: "provider-key-two" })),
    );
  });

  test("a gateway whose catalog defines the id with other settings binds nothing, and the one it was created under does", async () => {
    const sessionId = await createSession(ORIGINAL);
    const widened = gatewayOf(WIDENED);
    expect(
      await refusal(claim(widened, await launch(sessionId, false))),
    ).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    // Its reader says why, from the same comparison.
    const detail = await serviceOf(WIDENED).getSession(OWNER, sessionId);
    expect(detail.attention?.code).toBe("CATALOG_MISMATCH");
    expect(
      (await serviceOf(ORIGINAL).getSession(OWNER, sessionId)).attention,
    ).toBeNull();

    const original = gatewayOf(ORIGINAL);
    const claimed = await claim(original, await launch(sessionId, false));
    expect(claimed.session_id).toBe(sessionId);
    expect(claimed.profile_fingerprint).toBe(profileFingerprint(profile()));
    expect(claimed.runtime_config.tools).toEqual(["Read"]);
    expect(claimed.runtime_config.permission_mode).toBe("default");
  });

  test("a launch reserved for the session on a host with other settings fails the session with CATALOG_MISMATCH naming the settings", async () => {
    const sessionId = await createSession(ORIGINAL);
    const widened = gatewayOf(WIDENED);
    expect(
      await refusal(claim(widened, await launch(sessionId, true))),
    ).toEqual({
      status: 409,
      code: "CATALOG_MISMATCH",
    });
    const detail = await serviceOf(ORIGINAL).getSession(OWNER, sessionId);
    expect(detail.status).toBe("failed");
    const [row] = await db
      .select({ podId: sessions.podId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.podId).toBeNull();
    const [given] = await db
      .select({ error: workerLaunches.lastLaunchError })
      .from(workerLaunches)
      .where(eq(workerLaunches.sessionId, sessionId));
    expect(given?.error).toBe(
      `profile ${PROFILE_ID} has other settings in this host's catalog than the session was created with`,
    );
  });

  test("a replay through a host with other settings is refused before it rotates the token", async () => {
    const sessionId = await createSession(ORIGINAL);
    const original = gatewayOf(ORIGINAL);
    const l = await launch(sessionId, false);
    const first = await claim(original, l);
    expect(await refusal(claim(gatewayOf(WIDENED), l))).toEqual({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
    });
    // Nothing moved: the first token still authenticates.
    const principal = await original.authenticate(first.session_credential);
    expect(principal).toMatchObject({
      kind: "session",
      sessionId,
      authRevision: first.auth_revision,
    });
  });

  test("only the credential is taken at claim: a rotated value behind the same reference binds and reaches the provider route", async () => {
    const sessionId = await createSession(ORIGINAL);
    const rotated = gatewayOf(ROTATED);
    const claimed = await claim(rotated, await launch(sessionId, false));
    expect(claimed.session_id).toBe(sessionId);
    const auth = claimed.runtime_config.provider.auth;
    if (auth.kind !== "egress_token") throw new Error(auth.kind);
    const grant = await rotated.authorizeEgress({
      token: auth.token,
      purpose: "provider",
    });
    expect(grant.upstream.headers).toEqual([["x-api-key", "provider-key-two"]]);
  });

  test("a row from before the column, bound before it, replays only under the settings its first claim issued the provider token for", async () => {
    const sessionId = await createSession(ORIGINAL);
    const original = gatewayOf(ORIGINAL);
    const l = await launch(sessionId, false);
    const first = await claim(original, l);
    // As a claim made before 0119 left it: bound, nothing pinned.
    await db
      .update(sessions)
      .set({ profileFingerprint: null })
      .where(eq(sessions.id, sessionId));

    expect(await refusal(claim(gatewayOf(WIDENED), l))).toEqual({
      status: 503,
      code: "BACKEND_UNAVAILABLE",
    });
    expect(await storedFingerprint(sessionId)).toBeNull();
    expect(await original.authenticate(first.session_credential)).toMatchObject(
      { kind: "session", sessionId, authRevision: first.auth_revision },
    );

    const replayed = await claim(original, l);
    expect(replayed.auth_revision).toBe(first.auth_revision + 1);
    expect(await storedFingerprint(sessionId)).toBe(
      profileFingerprint(profile()),
    );
  });

  test("a row from before the column is pinned by its first claim", async () => {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER.ownerId,
      profileId: PROFILE_ID,
      repositoryId: "sample-app",
      repoUrl: REPOSITORY.url,
      branch: REPOSITORY.branch,
    });
    await db
      .insert(turns)
      .values({ sessionId, sequence: 1, message: "hello", status: "queued" });
    await db.insert(unassignedSessions).values({ sessionId });
    expect(await storedFingerprint(sessionId)).toBeNull();

    const widened = gatewayOf(WIDENED);
    await claim(widened, await launch(sessionId, false));
    expect(await storedFingerprint(sessionId)).toBe(
      profileFingerprint(WIDENED.profiles[PROFILE_ID] as CatalogProfile),
    );
  });
});

describe("billing none pinned at create", () => {
  const UNMETERED = catalogOf({
    ...profile(),
    provider: {
      kind: "litellm",
      endpoint: "http://litellm:4000",
      auth: {
        kind: "bearer",
        value: "local-master-key",
        ref: { value_env: "LITELLM_MASTER_KEY" },
      },
      billing: "none",
    },
  });
  const usage = {
    model: "gemma4-local",
    inputTokens: 1_000_000,
    outputTokens: 1_000,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    speed: "standard",
    inferenceGeo: "global",
    webSearchRequests: 0,
    webFetchRequests: 0,
    codeExecutionRequests: 0,
    estimated: false,
  };

  async function stored(sessionId: string) {
    const [row] = await db
      .select({ unmetered: sessions.unmetered, costUsd: sessions.costUsd })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row;
  }

  test("a replica whose catalog does not have the profile still records the session's calls at no cost", async () => {
    const sessionId = await createSession(UNMETERED);
    expect(await stored(sessionId)).toEqual({ unmetered: true, costUsd: 0 });

    const local = gatewayOf(UNMETERED);
    const claimed = await claim(local, await launch(sessionId, true));
    expect(claimed.remaining_budget_usd).toBeNull();

    // Mid-rollout, the report lands on a replica with the old catalog.
    const old = gatewayOf(ORIGINAL);
    expect(
      await old.recordProviderUsage({
        exchangeId: crypto.randomUUID(),
        sessionId,
        attemptId: claimed.attempt_id,
        usage,
      }),
    ).toEqual({ costUsd: 0, pricedBy: "unmetered" });
    expect(await stored(sessionId)).toEqual({ unmetered: true, costUsd: 0 });
  });

  test("a session on a billed profile is not unmetered and its calls are priced", async () => {
    const sessionId = await createSession(ORIGINAL);
    expect((await stored(sessionId))?.unmetered).toBe(false);
    const gateway = gatewayOf(ORIGINAL);
    const claimed = await claim(gateway, await launch(sessionId, true));
    expect(claimed.remaining_budget_usd).toBe(1_000);
    const priced = await gateway.recordProviderUsage({
      exchangeId: crypto.randomUUID(),
      sessionId,
      attemptId: claimed.attempt_id,
      usage,
    });
    expect(priced.pricedBy).toBe("fallback");
    expect((await stored(sessionId))?.costUsd).toBe(priced.costUsd);
  });
});

describe("a model named at create", () => {
  const OFFERS = catalogOf(profile({ models: ["claude-opus-5-5"] }));
  const opus = () =>
    profileFingerprint({ ...profile(), model: "claude-opus-5-5" });

  async function create(catalog: SessionCatalog, model?: string) {
    return serviceOf(catalog).createSession(OWNER, {
      idempotencyKey: crypto.randomUUID(),
      body: {
        profile_id: PROFILE_ID,
        repository_id: "sample-app",
        message: "hello",
        ...(model === undefined ? {} : { model }),
      },
    });
  }

  test("an offered model is pinned, read back, claimed and routed as that model", async () => {
    const { session_id: sessionId } = await create(OFFERS, "claude-opus-5-5");
    expect(await storedFingerprint(sessionId)).toBe(opus());
    expect(
      (await serviceOf(OFFERS).getSession(OWNER, sessionId)).runtime,
    ).toEqual({
      kind: "claude_agent_sdk",
      version: "0.3.270",
      profile_id: PROFILE_ID,
      model: "claude-opus-5-5",
      permission_mode: "default",
    });
    const gateway = gatewayOf(OFFERS);
    const claimed = await claim(gateway, await launch(sessionId, false));
    expect(claimed.session_id).toBe(sessionId);
    expect(claimed.runtime_config.model).toBe("claude-opus-5-5");
    expect(claimed.profile_fingerprint).toBe(opus());
    const granted = await gateway.authorizeEgress({
      token: claimed.runtime_config.provider.auth.token,
      purpose: "provider",
    });
    expect(granted.session_id).toBe(sessionId);
    expect(granted.upstream.url).toBe("https://litellm.invalid");
  });

  test("omitted, the default runs with the fingerprint a profile without models has", async () => {
    const { session_id: sessionId } = await create(OFFERS);
    expect(await storedFingerprint(sessionId)).toBe(
      profileFingerprint(profile()),
    );
    // Listing more models stops nothing created before the list.
    const before = (await create(ORIGINAL)).session_id;
    const gateway = gatewayOf(OFFERS);
    const claimed = await claim(gateway, await launch(before, true));
    expect(claimed.runtime_config.model).toBe("claude-sonnet-5");
  });

  test("a model the profile does not offer is refused and stores nothing", async () => {
    for (const [catalog, model] of [
      [OFFERS, "claude-fable-5-1"],
      [ORIGINAL, "claude-opus-5-5"],
    ] as const) {
      const error = await create(catalog, model).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SessionServiceError);
      expect((error as SessionServiceError).code).toBe(
        "UNSUPPORTED_CAPABILITY",
      );
    }
    expect(await db.select({ id: sessions.id }).from(sessions)).toEqual([]);
  });

  test("taking the session's model off the list stops it, as editing the profile would", async () => {
    const { session_id: sessionId } = await create(OFFERS, "claude-opus-5-5");
    expect(
      (await serviceOf(ORIGINAL).getSession(OWNER, sessionId)).attention?.code,
    ).toBe("CATALOG_MISMATCH");
    const narrowed = gatewayOf(ORIGINAL);
    expect(
      await refusal(claim(narrowed, await launch(sessionId, true))),
    ).toEqual({ status: 409, code: "CATALOG_MISMATCH" });
  });

  test("taking a running attempt's model off the list cuts its next provider grant, and only its", async () => {
    const gateway = gatewayOf(OFFERS);
    const providerAuth = async (model?: string) => {
      const { session_id } = await create(OFFERS, model);
      const claimed = await claim(gateway, await launch(session_id, false));
      const auth = claimed.runtime_config.provider.auth;
      if (auth.kind !== "egress_token") throw new Error(auth.kind);
      return { token: auth.token, purpose: "provider" as const };
    };
    const modelCuts = async (sessionId: string) =>
      (
        await db
          .select({ payload: events.payload })
          .from(events)
          .where(and(eq(events.sessionId, sessionId), eq(events.type, "error")))
      ).map((row) => row.payload);
    const opusRun = await providerAuth("claude-opus-5-5");
    const defaultRun = await providerAuth();
    expect((await gateway.authorizeEgress(opusRun)).upstream.url).toBe(
      "https://litellm.invalid",
    );

    const narrowed = gatewayOf(ORIGINAL);
    expect(await refusal(narrowed.authorizeEgress(opusRun))).toEqual({
      status: 409,
      code: "CATALOG_MISMATCH",
    });
    // Every refused exchange of the attempt repeats this; the stream says it once.
    expect(await refusal(narrowed.authorizeEgress(opusRun))).toEqual({
      status: 409,
      code: "CATALOG_MISMATCH",
    });
    // Created in this order, so the order names them.
    const [opusSession, defaultSession] = (
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .orderBy(sessions.createdAt)
    ).map((row) => row.id);
    if (opusSession === undefined || defaultSession === undefined) {
      throw new Error("the two sessions were not stored");
    }
    expect(await modelCuts(opusSession)).toEqual([
      expect.objectContaining({
        code: "MODEL_NOT_ALLOWED",
        model: "claude-opus-5-5",
      }),
    ]);
    expect((await narrowed.authorizeEgress(defaultRun)).upstream.url).toBe(
      "https://litellm.invalid",
    );
    expect(await modelCuts(defaultSession)).toEqual([]);
  });
});
