import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { BootstrapClaimResponse } from "@werft-ai/contracts";
import {
  type CatalogProfile,
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  profileFingerprint,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
  withSeededInstallation,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  checkpoints,
  events,
  receipts,
  sessions,
  unassignedSessions,
  workerLaunches,
} from "./schema.ts";
import { launchSession } from "./testing/launches.ts";
import {
  advanceCheckpointPointer,
  createPostgresWorkerUnitOfWork,
} from "./worker-unit-of-work.ts";

/**
 * A session moved onto another profile: the attempt bound to it keeps the
 * profile it claimed for what it holds and is handed nothing new; the next
 * claim runs the new profile and is told what the checkpoint it restores
 * was made under.
 */

const OWNER = testCaller("owner-a");
const REPOSITORY = {
  url: "https://example.invalid/app.git",
  branch: "main",
  auth: { kind: "github_app", registered: true },
} as const;

function profile(
  model: string,
  endpoint: string,
  billing?: "none",
): CatalogProfile {
  return {
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model,
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "anthropic",
      endpoint,
      auth: {
        kind: "api_key",
        value: "provider-key",
        ref: { value_env: "PROVIDER_KEY" },
      },
      ...(billing ? { billing } : {}),
    },
  };
}

const SONNET = profile("claude-sonnet-5", "https://sonnet.invalid");
const HAIKU = profile("claude-haiku-5", "https://haiku.invalid");
const OPUS = profile("claude-opus-5", "https://opus.invalid");
const LOCAL = profile("local-model", "http://10.0.0.5:4000", "none");
const CATALOG: SessionCatalog = withSeededInstallation({
  profiles: {
    sonnet: { ...SONNET, models: ["claude-sonnet-5-long"] },
    haiku: HAIKU,
    opus: OPUS,
    local: LOCAL,
  },
  repositories: {
    app: { ...REPOSITORY, profiles: ["sonnet", "haiku", "opus", "local"] },
  },
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const service = () =>
  createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog: CATALOG,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });

const gateway = (): WorkerGateway =>
  createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: CATALOG,
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

async function createSession(profileId = "sonnet", model?: string) {
  const created = await service().createSession(OWNER, {
    idempotencyKey: crypto.randomUUID(),
    body: {
      profile_id: profileId,
      repository_id: "app",
      message: "first",
      ...(model ? { model } : {}),
    },
  });
  return created.session_id;
}

async function revisionOf(sessionId: string) {
  return (await service().getSession(OWNER, sessionId)).revision;
}

function changeProfile(sessionId: string, profileId: string, revision: number) {
  return service().changeSessionProfile(OWNER, sessionId, {
    idempotencyKey: crypto.randomUUID(),
    body: { expected_revision: revision, profile_id: profileId },
  });
}

// A resuming claim also offers each candidate run as `auto`, for a checkpoint
// made under a converted mode; these tests are about which profiles are offered.
function storedModes<T extends { permission_mode?: string }>(
  configs: T[] | undefined,
): T[] | undefined {
  return configs?.filter((config) => config.permission_mode !== "auto");
}

async function claim(g: WorkerGateway, sessionId: string) {
  const { executionId, generation, nonce } = await launchSession(db, {
    sessionId,
  });
  return g.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    },
  );
}

async function commitCheckpoint(
  sessionId: string,
  claimed: BootstrapClaimResponse,
  revision: number,
) {
  await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const committed = await advanceCheckpointPointer(tx, {
      fence: {
        sessionId,
        attemptId: claimed.attempt_id,
        leaseEpoch: claimed.lease_epoch,
        executionGeneration: claimed.execution_generation,
        authRevision: claimed.auth_revision,
      },
      session,
      checkpoint: {
        revision,
        manifest_ref: `sessions/${sessionId}/checkpoints/${revision}/m.json`,
        manifest_sha256: "a".repeat(64),
      },
      turnRowId: null,
      now: new Date(),
      versionsHeld: false,
    });
    expect(committed.outcome).toBe("committed");
  });
}

async function release(sessionId: string, claimed: BootstrapClaimResponse) {
  await db
    .update(attempts)
    .set({ state: "exited" })
    .where(eq(attempts.id, claimed.attempt_id));
  const [released] = await db
    .update(sessions)
    .set({ podId: null, executionId: null })
    .where(eq(sessions.id, sessionId))
    .returning({ partition: sessions.partition });
  if (!released) throw new Error("no session");
  await db
    .update(workerLaunches)
    .set({ slotReleasedAt: new Date() })
    .where(
      and(
        eq(workerLaunches.sessionId, sessionId),
        isNull(workerLaunches.slotReleasedAt),
      ),
    );
  await db
    .insert(unassignedSessions)
    .values({ sessionId, partition: released.partition });
}

function scopeOf(claimed: BootstrapClaimResponse) {
  return {
    session_id: claimed.session_id,
    turn_id: null,
    attempt_id: claimed.attempt_id,
    lease_epoch: claimed.lease_epoch,
    execution_generation: claimed.execution_generation,
    auth_revision: claimed.auth_revision,
  };
}

function providerTokenOf(claimed: BootstrapClaimResponse) {
  const auth = claimed.runtime_config.provider.auth;
  if (auth.kind !== "egress_token") throw new Error(auth.kind);
  return auth.token;
}

async function refusalCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("changing a session's profile", () => {
  test("the bound attempt keeps its profile for egress and gets no new input; the session row and receipt move", async () => {
    const sessionId = await createSession();
    const g = gateway();
    const claimed = await claim(g, sessionId);
    expect(claimed.runtime_config.model).toBe("claude-sonnet-5");
    const principal = await g.authenticate(claimed.session_credential);
    // The first turn is this attempt's; it runs it.
    const first = await g.nextInput(principal, scopeOf(claimed));
    expect(first.input?.turn_id).toBe("1");

    const revision = await revisionOf(sessionId);
    const changed = await changeProfile(sessionId, "haiku", revision);
    expect(changed.receipt_status).toBe("succeeded");
    await service().appendMessage(OWNER, sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body: { message: "second", mode: "enqueue" },
    });

    // Still the profile it claimed: its provider route is not pulled from
    // under the turn it is running.
    const grant = await g.authorizeEgress({
      token: providerTokenOf(claimed),
      purpose: "provider",
    });
    expect(grant.upstream.url).toBe("https://sonnet.invalid");
    // Turn 1 is still its own to hold; turn 2 is the next attempt's.
    const again = await g.nextInput(principal, scopeOf(claimed));
    expect(again.input?.turn_id).toBe("1");
    // As finalize leaves it: the turn ended and its queue entry gone, so
    // turn 2 heads the queue.
    await db.execute(
      `UPDATE turns SET status = 'completed' WHERE session_id = '${sessionId}' AND sequence = 1`,
    );
    await db.execute(
      `DELETE FROM queue_messages WHERE turn_id = (SELECT id FROM turns WHERE session_id = '${sessionId}' AND sequence = 1)`,
    );
    const next = await g.nextInput(principal, scopeOf(claimed));
    expect(next).toMatchObject({ input: null, draining: true });
    expect(next.reason).toBeUndefined();

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.profileId).toBe("haiku");
    expect(row?.profileFingerprint).toBe(profileFingerprint(HAIKU));
    expect(row?.revision).toBe(revision + 1);
    const [attempt] = await db
      .select()
      .from(attempts)
      .where(eq(attempts.id, claimed.attempt_id));
    expect(attempt?.profileId).toBe("sonnet");
    expect(attempt?.profileFingerprint).toBe(profileFingerprint(SONNET));

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, changed.receipt_id));
    expect(receipt?.operation).toBe("change_profile");
    expect(receipt?.result).toEqual({
      previous_profile_id: "sonnet",
      profile_id: "haiku",
    });
    const statuses = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "status")));
    expect(statuses.map((e) => e.payload)).toContainEqual(
      expect.objectContaining({
        previous_profile_id: "sonnet",
        profile_id: "haiku",
      }),
    );
  });

  test("a checkpoint keeps the profile of the attempt that committed it, and the next claim restores against it", async () => {
    const sessionId = await createSession();
    const g = gateway();
    const claimed = await claim(g, sessionId);
    await changeProfile(sessionId, "haiku", await revisionOf(sessionId));

    // The old attempt commits after the change, as its last turn would.
    await commitCheckpoint(sessionId, claimed, 0);
    const [checkpoint] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId));
    expect(checkpoint?.profileId).toBe("sonnet");
    expect(checkpoint?.profileFingerprint).toBe(profileFingerprint(SONNET));

    // The old attempt is gone; the next claim binds the new profile.
    await release(sessionId, claimed);
    const next = await claim(g, sessionId);
    expect(next.runtime.profile_id).toBe("haiku");
    expect(next.runtime_config.model).toBe("claude-haiku-5");
    expect(next.restore?.revision).toBe(0);
    const offered = storedModes(next.restore_runtime_configs);
    expect(offered).toHaveLength(1);
    expect(offered?.[0]?.model).toBe("claude-sonnet-5");
    expect(offered?.[0]?.provider.endpoint).toBe("https://sonnet.invalid");
    const grant = await g.authorizeEgress({
      token: providerTokenOf(next),
      purpose: "provider",
    });
    expect(grant.upstream.url).toBe("https://haiku.invalid");
  });

  test("a session created on another of its profile's models changes profile and restores under the model it ran", async () => {
    const sessionId = await createSession("sonnet", "claude-sonnet-5-long");
    const g = gateway();
    const claimed = await claim(g, sessionId);
    expect(claimed.runtime_config.model).toBe("claude-sonnet-5-long");
    await commitCheckpoint(sessionId, claimed, 0);
    await changeProfile(sessionId, "haiku", await revisionOf(sessionId));
    await release(sessionId, claimed);

    const next = await claim(g, sessionId);
    expect(next.runtime_config.model).toBe("claude-haiku-5");
    expect(
      storedModes(next.restore_runtime_configs)?.map((config) => [
        config.model,
        config.provider.endpoint,
      ]),
    ).toEqual([["claude-sonnet-5-long", "https://sonnet.invalid"]]);
  });

  test("a checkpoint 0147 backfilled without a fingerprint takes the one the session ran before the change", async () => {
    const sessionId = await createSession();
    const g = gateway();
    const claimed = await claim(g, sessionId);
    await commitCheckpoint(sessionId, claimed, 0);
    // A session from before 0119 had no fingerprint when 0147 copied it; the
    // claim pinned one on the session only.
    await db
      .update(checkpoints)
      .set({ profileFingerprint: null })
      .where(eq(checkpoints.sessionId, sessionId));
    await changeProfile(sessionId, "haiku", await revisionOf(sessionId));
    await release(sessionId, claimed);

    const [checkpoint] = await db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.sessionId, sessionId));
    expect(checkpoint?.profileFingerprint).toBe(profileFingerprint(SONNET));
    const next = await claim(g, sessionId);
    expect(
      storedModes(next.restore_runtime_configs)?.map((config) => config.model),
    ).toEqual(["claude-sonnet-5"]);
  });

  test("offers every earlier profile the restorable checkpoints were made under, newest first", async () => {
    const sessionId = await createSession();
    const g = gateway();
    const first = await claim(g, sessionId);
    await commitCheckpoint(sessionId, first, 0);
    await changeProfile(sessionId, "haiku", await revisionOf(sessionId));
    await release(sessionId, first);
    const second = await claim(g, sessionId);
    await commitCheckpoint(sessionId, second, 1);
    await changeProfile(sessionId, "opus", await revisionOf(sessionId));
    await release(sessionId, second);

    const third = await claim(g, sessionId);
    expect(third.runtime_config.model).toBe("claude-opus-5");
    expect(third.restore?.revision).toBe(1);
    expect(
      storedModes(third.restore_runtime_configs)?.map((config) => config.model),
    ).toEqual(["claude-haiku-5", "claude-sonnet-5"]);
  });

  test("a claim whose checkpoint was made under the profile it runs is told nothing more", async () => {
    const sessionId = await createSession();
    const g = gateway();
    const claimed = await claim(g, sessionId);
    expect(claimed.restore).toBeNull();
    expect(claimed.restore_runtime_configs).toBeUndefined();
  });

  test("refuses another billing kind, a stale revision and a closed session", async () => {
    const sessionId = await createSession();
    const revision = await revisionOf(sessionId);
    expect(await refusalCode(changeProfile(sessionId, "local", revision))).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(
      await refusalCode(changeProfile(sessionId, "haiku", revision + 1)),
    ).toBe("REVISION_CONFLICT");

    await db
      .update(sessions)
      .set({ agentReleaseId: null, admissionState: "closed" })
      .where(eq(sessions.id, sessionId));
    expect(await refusalCode(changeProfile(sessionId, "haiku", revision))).toBe(
      "SESSION_CLOSED",
    );
    // Nothing moved.
    const [row] = await db
      .select({ profileId: sessions.profileId })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.profileId).toBe("sonnet");
  });

  test("the profile it already runs settles as a no-op without moving the revision, and a replay answers the same receipt", async () => {
    const sessionId = await createSession();
    const revision = await revisionOf(sessionId);
    const key = crypto.randomUUID();
    const body = { expected_revision: revision, profile_id: "sonnet" };
    const first = await service().changeSessionProfile(OWNER, sessionId, {
      idempotencyKey: key,
      body,
    });
    expect(first.receipt_status).toBe("succeeded");
    expect(await revisionOf(sessionId)).toBe(revision);
    const replay = await service().changeSessionProfile(OWNER, sessionId, {
      idempotencyKey: key,
      body,
    });
    expect(replay.receipt_id).toBe(first.receipt_id);
  });

  test("a paused session changes too, and its next turn's attempt records the new profile", async () => {
    const sessionId = await createSession();
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, sessionId));
    await changeProfile(sessionId, "haiku", await revisionOf(sessionId));
    await db
      .update(sessions)
      .set({ admissionState: "active" })
      .where(eq(sessions.id, sessionId));
    const claimed = await claim(gateway(), sessionId);
    expect(claimed.runtime_config.model).toBe("claude-haiku-5");
    const principal = await gateway().authenticate(claimed.session_credential);
    await gateway().nextInput(principal, scopeOf(claimed));
    const turn = await service().getTurn(OWNER, sessionId, "1");
    expect(turn.attempts.map((a) => a.profile_id)).toEqual(["haiku"]);
  });
});
