/**
 * The behaviour every `ExecutionBackend` promises, as one suite an adapter
 * runs against its real provider. Nothing here knows which provider that is:
 * whatever only the provider can do — remove a resource behind the backend's
 * back, clean up after the run — comes in through the harness.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ExecutionState } from "@werft-ai/contracts";
import {
  type ExecutionBackend,
  type ExecutionRef,
  type ExecutionResources,
  type LaunchIntent,
  LaunchSpecMismatchError,
  launchSpecFingerprint,
} from "../scheduler/ports/execution-backend.ts";
import {
  hashWorkerToken,
  launchNonceFingerprint,
} from "../workers/worker-gateway.ts";

export type ExecutionBackendContractHarness = {
  /** False registers the suite skipped, for an opt-in variable left unset. */
  enabled: boolean;
  /** Launched as-is by every intent; must keep running until terminated. */
  image: string;
  /** Per test. Default 60s; a provider that schedules pods needs more. */
  timeoutMs?: number;
  /**
   * Called once before the tests, with a namespace (installation) of its
   * own so nothing another run left behind is in view. A backend with the
   * workspace pair must list workspaces however young they are.
   */
  create(): Promise<ExecutionBackendContractSubject>;
};

export type ExecutionBackendContractSubject = {
  backend: ExecutionBackend;
  /**
   * Removes the resource `providerRef` names without going through the
   * backend — what an operator or a lost node does — and returns once the
   * provider no longer has it.
   */
  removeOutOfBand(providerRef: string): Promise<void>;
  /** Removes whatever the run made. Leftovers are reported, not thrown. */
  tearDown(): Promise<void>;
};

const RESOURCES: ExecutionResources = {
  cpus: 0.5,
  memoryBytes: 128 * 1024 * 1024,
  pidsLimit: 64,
};

const LIVE: ExecutionState[] = ["pending", "running"];

function fingerprintOf(nonce: string): string {
  return launchNonceFingerprint(hashWorkerToken(nonce));
}

/**
 * An intent whose registry accepts exactly the nonce it issued last, like
 * the scheduler's, and counts how many it issued.
 */
function intentFor(image: string) {
  const suffix = crypto.randomUUID();
  const issued: string[] = [];
  const intent: LaunchIntent = {
    bootstrapCredentialState: async () => {
      const last = issued.at(-1);
      return {
        claimed: false,
        fingerprint: last === undefined ? null : fingerprintOf(last),
      };
    },
    executionId: `exec-${suffix}`,
    generation: 1,
    image,
    issueBootstrapNonce: async () => {
      const nonce = `wln-${suffix}-${issued.length + 1}`;
      issued.push(nonce);
      return nonce;
    },
    launchSpec: launchSpecFingerprint(image, RESOURCES),
    operationId: `op-${suffix}`,
    resources: RESOURCES,
    sessionId: crypto.randomUUID(),
  };
  return { intent, issued };
}

function generationOf(intent: LaunchIntent, generation: number): LaunchIntent {
  return {
    ...intent,
    generation,
    operationId: `${intent.operationId}-g${generation}`,
  };
}

export function describeExecutionBackendContract(
  name: string,
  harness: ExecutionBackendContractHarness,
): void {
  const suite = harness.enabled ? describe : describe.skip;
  const timeout = harness.timeoutMs ?? 60_000;

  suite(`ExecutionBackend contract: ${name}`, () => {
    let subject: ExecutionBackendContractSubject;
    const backend = () => subject.backend;

    beforeAll(async () => {
      subject = await harness.create();
    }, 300_000);

    afterAll(async () => {
      await subject?.tearDown();
    }, 300_000);

    async function untilRunning(ref: ExecutionRef) {
      const deadline = Date.now() + timeout / 2;
      for (;;) {
        const observed = await backend().inspect(ref);
        if (observed.state === "running") return observed;
        if (!observed.found || !LIVE.includes(observed.state)) {
          throw new Error(
            `${ref.executionId} g${ref.generation} left the launch as ${JSON.stringify(observed)}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`${ref.executionId} never reached running`);
        }
        await Bun.sleep(250);
      }
    }

    test(
      "ensureExecution twice → one resource, adopted without a new nonce",
      async () => {
        const { intent, issued } = intentFor(harness.image);
        const first = await backend().ensureExecution(intent);
        const second = await backend().ensureExecution(intent);

        expect(first.created).toBe(true);
        expect(LIVE).toContain(first.state);
        expect(second.created).toBe(false);
        expect(second.providerRef).toBe(first.providerRef);
        expect(LIVE).toContain(second.state);
        expect(issued).toHaveLength(1);
        const mine = (await backend().listManaged()).filter(
          (m) => m.executionId === intent.executionId,
        );
        expect(mine.map((m) => m.providerRef)).toEqual([first.providerRef]);
      },
      timeout,
    );

    test(
      "inspect: found:false for nothing launched, running for a launch",
      async () => {
        const { intent } = intentFor(harness.image);
        expect(await backend().inspect(intent)).toMatchObject({
          found: false,
          providerRef: null,
          state: "unknown",
        });

        const { providerRef } = await backend().ensureExecution(intent);
        expect(await untilRunning(intent)).toMatchObject({
          found: true,
          providerRef,
          state: "running",
        });
      },
      timeout,
    );

    test(
      "listManaged returns what was launched and drops what was terminated",
      async () => {
        const { intent } = intentFor(harness.image);
        const { providerRef } = await backend().ensureExecution(intent);
        await untilRunning(intent);

        expect(await backend().listManaged()).toContainEqual({
          executionId: intent.executionId,
          generation: 1,
          providerRef,
          sessionId: intent.sessionId,
          state: "running",
        });
        await backend().terminate(intent);
        expect(
          (await backend().listManaged()).filter(
            (m) => m.executionId === intent.executionId,
          ),
        ).toEqual([]);
      },
      timeout,
    );

    test(
      "terminate: generation_mismatch, terminated, absent — only the matching generation",
      async () => {
        const { intent } = intentFor(harness.image);
        const gen1 = generationOf(intent, 1);
        const gen2 = generationOf(intent, 2);
        await backend().ensureExecution(gen1);
        const second = await backend().ensureExecution(gen2);

        expect(
          await backend().terminate(generationOf(intent, 3)),
        ).toMatchObject({ outcome: "generation_mismatch" });
        expect(await backend().terminate(gen1)).toMatchObject({
          outcome: "terminated",
        });
        expect((await backend().inspect(gen1)).found).toBe(false);
        expect(await untilRunning(gen2)).toMatchObject({
          providerRef: second.providerRef,
        });
        expect(await backend().terminate(gen2)).toEqual({
          outcome: "terminated",
          providerRef: second.providerRef,
        });
        expect(await backend().terminate(gen2)).toEqual({ outcome: "absent" });
        expect(await backend().terminate(gen1)).toEqual({ outcome: "absent" });
      },
      timeout,
    );

    test(
      "a resource removed out of band is re-created; terminate conditioned on the old providerRef leaves the replacement",
      async () => {
        const { intent } = intentFor(harness.image);
        const first = await backend().ensureExecution(intent);
        await subject.removeOutOfBand(first.providerRef);
        expect(await backend().inspect(intent)).toMatchObject({
          found: false,
          state: "unknown",
        });

        const again = await backend().ensureExecution(intent);
        expect(again.created).toBe(true);
        expect(again.providerRef).not.toBe(first.providerRef);
        await untilRunning(intent);

        expect(
          await backend().terminate(intent, { providerRef: first.providerRef }),
        ).toEqual({
          foundProviderRef: again.providerRef,
          outcome: "provider_mismatch",
        });
        expect(await untilRunning(intent)).toMatchObject({
          providerRef: again.providerRef,
        });
        expect(
          await backend().terminate(intent, { providerRef: again.providerRef }),
        ).toEqual({ outcome: "terminated", providerRef: again.providerRef });
      },
      timeout,
    );

    test(
      "a resource launched with another spec is refused with LaunchSpecMismatchError and left in place",
      async () => {
        const { intent, issued } = intentFor(harness.image);
        const { providerRef } = await backend().ensureExecution(intent);
        const resources = { ...RESOURCES, pidsLimit: RESOURCES.pidsLimit + 1 };

        const refused = backend().ensureExecution({
          ...intent,
          launchSpec: launchSpecFingerprint(intent.image, resources),
          resources,
        });
        await expect(refused).rejects.toBeInstanceOf(LaunchSpecMismatchError);
        expect(issued).toHaveLength(1);
        expect(await backend().inspect(intent)).toMatchObject({
          found: true,
          providerRef,
        });
      },
      timeout,
    );

    test(
      "workspace pair, when present: lists the session's workspace and removes it only once unused",
      async () => {
        const { listWorkspaces, removeWorkspace } = backend();
        expect(listWorkspaces === undefined).toBe(
          removeWorkspace === undefined,
        );
        if (listWorkspaces === undefined || removeWorkspace === undefined) {
          return;
        }
        const list = () => listWorkspaces.call(backend());
        const remove = (id: string, owner?: { sessionId: string }) =>
          removeWorkspace.call(backend(), id, owner);
        const { intent } = intentFor(harness.image);
        await backend().ensureExecution(intent);
        const owner = { sessionId: intent.sessionId };

        const mine = (await list()).filter(
          (w) => w.sessionId === intent.sessionId,
        );
        expect(mine).toHaveLength(1);
        const [workspace] = mine;
        if (workspace === undefined) return;
        const { id } = workspace;
        expect(workspace.sessionFrom ?? "label").toBe("label");

        expect(await remove(id, { sessionId: crypto.randomUUID() })).toEqual({
          outcome: "not_ours",
        });
        expect(await remove(id, owner)).toEqual({ outcome: "in_use" });
        await backend().terminate(intent);
        expect(await remove(id, owner)).toEqual({ outcome: "removed" });
        expect(await remove(id, owner)).toEqual({ outcome: "absent" });
        expect(
          (await list()).filter((w) => w.sessionId === intent.sessionId),
        ).toEqual([]);
      },
      timeout,
    );

    test(
      "assertReplaceable, when present: resolves for a launchable intent and launches nothing",
      async () => {
        const { assertReplaceable } = backend();
        if (assertReplaceable === undefined) return;
        const { intent, issued } = intentFor(harness.image);

        await assertReplaceable.call(backend(), intent);
        expect((await backend().inspect(intent)).found).toBe(false);
        expect(issued).toEqual([]);
        expect((await backend().ensureExecution(intent)).created).toBe(true);
      },
      timeout,
    );

    test(
      "reconcileNetworks, when present: clears what an out-of-band removal left, then has nothing to do",
      async () => {
        const { reconcileNetworks } = backend();
        if (reconcileNetworks === undefined) return;
        const reconcile = () => reconcileNetworks.call(backend());
        const { intent: gone } = intentFor(harness.image);
        const { intent: live } = intentFor(harness.image);
        const removed = await backend().ensureExecution(gone);
        const kept = await backend().ensureExecution(live);
        await subject.removeOutOfBand(removed.providerRef);

        expect((await reconcile()).failed).toEqual([]);
        expect(await reconcile()).toEqual({
          failed: [],
          removed: [],
          repaired: [],
        });
        expect(await untilRunning(live)).toMatchObject({
          providerRef: kept.providerRef,
        });
      },
      timeout,
    );
  });
}
