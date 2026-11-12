/**
 * What the port contract does not pin and a real API server has to show:
 * the UID precondition, where the nonce lives, and that a finished session
 * leaves nothing behind. Opt in like the contract suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type LaunchIntent, launchSpecFingerprint } from "@werft-ai/platform";
import { KubernetesBackend } from "./backend.ts";
import { KubernetesApiError, type KubernetesClient } from "./client.ts";
import { LABELS, NONCE_KEY, nonceSecretNameOf, podNameFor } from "./specs.ts";
import {
  createNamespace,
  deleteNamespace,
  drainInstallation,
  removePodOutOfBand,
  TEST_ENABLED,
  TEST_IMAGE,
  testClient,
  testConfig,
  testResolver,
} from "./testing/index.ts";

const suite = TEST_ENABLED ? describe : describe.skip;
const TIMEOUT = 120_000;
const RESOURCES = { cpus: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 64 };

function intentFor(): { intent: LaunchIntent; issued: string[] } {
  const suffix = crypto.randomUUID();
  const issued: string[] = [];
  const intent: LaunchIntent = {
    bootstrapCredentialState: async () => ({ claimed: true }),
    executionId: `exec-${suffix}`,
    generation: 1,
    image: TEST_IMAGE,
    issueBootstrapNonce: async () => {
      const nonce = `wln-${crypto.randomUUID()}`;
      issued.push(nonce);
      return nonce;
    },
    launchSpec: launchSpecFingerprint(TEST_IMAGE, RESOURCES),
    operationId: `op-${suffix}`,
    resources: RESOURCES,
    sessionId: crypto.randomUUID(),
  };
  return { intent, issued };
}

suite("KubernetesBackend on a real API server", () => {
  let client: KubernetesClient;
  let backend: KubernetesBackend;
  const installationId = `it-${crypto.randomUUID().slice(0, 8)}`;
  const namespace = `ap-${installationId}`;

  beforeAll(async () => {
    client = await testClient();
    await createNamespace(client, namespace);
    backend = new KubernetesBackend(
      testConfig(namespace, installationId),
      client,
      testResolver,
    );
  }, TIMEOUT);

  afterAll(async () => {
    if (backend === undefined) return;
    await drainInstallation(backend, client, namespace, installationId);
    await deleteNamespace(client, namespace);
  }, TIMEOUT);

  async function untilRunning(intent: LaunchIntent): Promise<void> {
    const deadline = Date.now() + TIMEOUT / 2;
    while ((await backend.inspect(intent)).state !== "running") {
      if (Date.now() > deadline) throw new Error("never reached running");
      await Bun.sleep(250);
    }
  }

  test(
    "a delete conditioned on the replaced Pod's UID leaves the replacement running",
    async () => {
      const { intent } = intentFor();
      const first = await backend.ensureExecution(intent);
      await removePodOutOfBand(
        client,
        namespace,
        installationId,
        first.providerRef,
      );
      const second = await backend.ensureExecution(intent);
      expect(second.providerRef).not.toBe(first.providerRef);
      await untilRunning(intent);

      const name = podNameFor(intent, installationId);
      const refused = await client
        .delete(namespace, "pods", name, { uid: first.providerRef })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(KubernetesApiError);
      expect((refused as KubernetesApiError).status).toBe(409);
      expect(await backend.inspect(intent)).toMatchObject({
        providerRef: second.providerRef,
        state: "running",
      });
    },
    TIMEOUT,
  );

  test(
    "a failed worker reports its exit, reason and log tail",
    async () => {
      const failing = new KubernetesBackend(
        {
          ...testConfig(namespace, installationId),
          command: ["sh", "-c", "echo booting; echo fatal: boom; exit 3"],
        },
        client,
        testResolver,
      );
      const { intent } = intentFor();
      await failing.ensureExecution(intent);
      const deadline = Date.now() + TIMEOUT / 2;
      let observed = await failing.inspect(intent);
      while (observed.state !== "terminated") {
        if (Date.now() > deadline) throw new Error("never terminated");
        await Bun.sleep(250);
        observed = await failing.inspect(intent);
      }
      expect(observed).toMatchObject({
        exitCode: 3,
        logTail: "booting\nfatal: boom\n",
        terminationReason: "Error",
      });
    },
    TIMEOUT,
  );

  test(
    "terminating one generation leaves the next generation's Pod untouched",
    async () => {
      const { intent } = intentFor();
      const gen2 = {
        ...intent,
        generation: 2,
        operationId: `${intent.operationId}-2`,
      };
      await backend.ensureExecution(intent);
      const second = await backend.ensureExecution(gen2);
      expect(await backend.terminate(intent)).toMatchObject({
        outcome: "terminated",
      });
      await untilRunning(gen2);
      expect((await backend.inspect(gen2)).providerRef).toBe(
        second.providerRef,
      );
    },
    TIMEOUT,
  );

  test(
    "the nonce is in the Pod's own Secret only, never in the Pod",
    async () => {
      const { intent, issued } = intentFor();
      const { providerRef } = await backend.ensureExecution(intent);
      await untilRunning(intent);
      const [nonce] = issued;
      if (nonce === undefined) throw new Error("no nonce issued");

      const pod = await client.get(
        namespace,
        "pods",
        podNameFor(intent, installationId),
      );
      if (pod === null) throw new Error("pod is gone");
      expect(JSON.stringify(pod)).not.toContain(nonce);
      const secretName = nonceSecretNameOf(pod);
      if (secretName === null) throw new Error("pod names no nonce Secret");
      const secret = (await client.request(
        "GET",
        `/api/v1/namespaces/${namespace}/secrets/${secretName}`,
      )) as {
        data: Record<string, string>;
        metadata: { ownerReferences: Array<{ uid: string }> };
      };
      expect(
        Buffer.from(secret.data[NONCE_KEY] ?? "", "base64").toString(),
      ).toBe(nonce);
      expect(secret.metadata.ownerReferences.map((o) => o.uid)).toEqual([
        providerRef,
      ]);
    },
    TIMEOUT,
  );

  test(
    "terminate and workspace removal leave no Pod, Secret or PVC of the session",
    async () => {
      const { intent } = intentFor();
      await backend.ensureExecution(intent);
      await untilRunning(intent);
      const selector = {
        [LABELS.installation]: installationId,
        [LABELS.sessionId]: intent.sessionId,
      };
      expect(
        await client.list(namespace, "persistentvolumeclaims", selector),
      ).toHaveLength(1);

      expect(await backend.terminate(intent)).toMatchObject({
        outcome: "terminated",
      });
      const [workspace] = (await backend.listWorkspaces()).filter(
        (w) => w.sessionId === intent.sessionId,
      );
      if (workspace === undefined) throw new Error("no workspace listed");
      expect(
        await backend.removeWorkspace(workspace.id, {
          sessionId: intent.sessionId,
        }),
      ).toEqual({ outcome: "removed" });

      const execution = {
        [LABELS.installation]: installationId,
        [LABELS.executionId]: intent.executionId,
      };
      expect(await client.list(namespace, "pods", execution)).toEqual([]);
      expect(await client.list(namespace, "secrets", execution)).toEqual([]);
      const deadline = Date.now() + 30_000;
      // The claim's protection finalizer is lifted moments after the delete.
      while (
        (await client.list(namespace, "persistentvolumeclaims", selector))
          .length > 0
      ) {
        if (Date.now() > deadline) throw new Error("the claim stayed");
        await Bun.sleep(250);
      }
    },
    TIMEOUT,
  );
});
