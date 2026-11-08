import { describe, expect, test } from "bun:test";
import {
  hashWorkerToken,
  type LaunchIntent,
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  launchNonceFingerprint,
  launchSpecFingerprint,
} from "@werft-ai/platform";
import {
  ExecutionConflictError,
  type HostResolver,
  ImageReferenceError,
  KubernetesBackend,
  WorkspaceClaimError,
} from "./backend.ts";
import { KubernetesApiError } from "./client.ts";
import { FakeKubernetes } from "./fake-client.ts";
import { podNameFor, workspaceClaimNameFor } from "./specs.ts";
import { TEST_PROXY_ADDRESS, testConfig, testResolver } from "./testing.ts";

const NS = "agents";
const INSTALLATION = "test";
const CLAIM_NAMING = {
  installationId: INSTALLATION,
  volumeNamePrefix: "werft-ws-",
};
const IMAGE = `registry.local:5000/worker@sha256:${"a".repeat(64)}`;
const RESOURCES = { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 };

function setup() {
  const api = new FakeKubernetes();
  const backend = new KubernetesBackend(
    testConfig(NS, INSTALLATION),
    api.asClient(),
    testResolver,
  );
  return { api, backend };
}

/** A registry that accepts exactly the nonce it issued last. */
function intentFor(overrides: Partial<LaunchIntent> = {}) {
  const issued: string[] = [];
  const intent: LaunchIntent = {
    bootstrapCredentialState: async () => {
      const last = issued.at(-1);
      return {
        claimed: false,
        fingerprint:
          last === undefined
            ? null
            : launchNonceFingerprint(hashWorkerToken(last)),
      };
    },
    executionId: "exec-1",
    generation: 1,
    image: IMAGE,
    issueBootstrapNonce: async () => {
      const nonce = `wln_secret-${issued.length + 1}`;
      issued.push(nonce);
      return nonce;
    },
    launchSpec: launchSpecFingerprint(IMAGE, RESOURCES),
    operationId: "op-1",
    resources: RESOURCES,
    sessionId: "6c1f8d0e-0000-4000-8000-000000000001",
    ...overrides,
  };
  return { intent, issued };
}

const podName = podNameFor(
  { executionId: "exec-1", generation: 1 },
  INSTALLATION,
);

describe("resolveImage", () => {
  test("returns a digest reference as it is", async () => {
    const { backend } = setup();
    expect(await backend.resolveImage(IMAGE)).toBe(IMAGE);
    const local = `localhost:5001/worker@sha256:${"b".repeat(64)}`;
    expect(await backend.resolveImage(local)).toBe(local);
  });

  test.each([
    "worker:1.0",
    "registry.local:5000/worker",
    `worker:1.0@sha256:${"a".repeat(64)}`,
    "worker@sha256:short",
  ])("refuses %s, naming the digest form", async (reference) => {
    const { backend } = setup();
    const refused = backend.resolveImage(reference);
    await expect(refused).rejects.toBeInstanceOf(ImageReferenceError);
    await expect(refused).rejects.toThrow("repository@sha256:<digest>");
  });
});

describe("ensureExecution", () => {
  test.each([false, true])(
    "changing storage declaration from %s preserves the Pod and PVC",
    async (initial) => {
      const api = new FakeKubernetes();
      const backendFor = (workspaceEnforcedByStorage: boolean) =>
        new KubernetesBackend(
          { ...testConfig(NS, INSTALLATION), workspaceEnforcedByStorage },
          api.asClient(),
          testResolver,
        );
      const { intent, issued } = intentFor();
      const first = await backendFor(initial).ensureExecution(intent);
      const claims = await api.list(NS, "persistentvolumeclaims");
      const originalPod = await api.get(NS, "pods", podName);
      api.setPhase(NS, podName, "Running");
      const changed = backendFor(!initial);
      expect(await changed.ensureExecution(intent)).toEqual({
        created: false,
        providerRef: first.providerRef,
        state: "running",
      });
      expect((await api.get(NS, "pods", podName))?.spec).toEqual(
        originalPod?.spec,
      );
      expect(issued).toHaveLength(1);
      await changed.terminate(intent);
      const next = { ...intent, generation: 2 };
      expect((await changed.ensureExecution(next)).created).toBe(true);
      expect(await api.list(NS, "persistentvolumeclaims")).toEqual(claims);
      const nextPod = await api.get(NS, "pods", podNameFor(next, INSTALLATION));
      const container = (
        nextPod?.spec as {
          containers: Array<{ env: Array<{ name: string; value?: string }> }>;
        }
      ).containers[0];
      expect(
        container?.env.find(
          (entry) => entry.name === "WORKER_WORKSPACE_ENFORCED_BY_STORAGE",
        )?.value,
      ).toBe(initial ? undefined : "true");
      expect(
        api.calls.filter(
          (call) =>
            call.verb === "create" && call.kind === "persistentvolumeclaims",
        ),
      ).toHaveLength(1);
    },
  );

  test("creates the PVC, then the Pod, then the Secret it owns", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const result = await backend.ensureExecution(intent);

    expect(
      api.calls.filter((c) => c.verb === "create").map((c) => c.kind),
    ).toEqual(["persistentvolumeclaims", "pods", "secrets"]);
    const pod = await api.get(NS, "pods", podName);
    expect(result).toEqual({
      created: true,
      providerRef: pod?.metadata.uid as string,
      state: "pending",
    });
    const [secret] = await api.list(NS, "secrets");
    expect(secret?.metadata.ownerReferences).toEqual([
      { apiVersion: "v1", kind: "Pod", name: podName, uid: result.providerRef },
    ]);
    expect(issued).toHaveLength(1);
  });

  test("adopts its own Pod without a new nonce", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Running");
    expect(await backend.ensureExecution(intent)).toEqual({
      created: false,
      providerRef: first.providerRef,
      state: "running",
    });
    expect(issued).toHaveLength(1);
  });

  test("replaces a Pending Pod whose Secret never landed, with a new nonce", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    const [secret] = await api.list(NS, "secrets");
    api.removeRaw(NS, "secrets", secret?.metadata.name as string);
    api.age(NS, "pods", podName, 120_000);

    const again = await backend.ensureExecution(intent);
    expect(again.created).toBe(true);
    expect(again.providerRef).not.toBe(first.providerRef);
    expect(issued).toHaveLength(2);
    expect(await api.list(NS, "secrets")).toHaveLength(1);
  });

  test("leaves a young Pending Pod without its Secret to the launch that may still be writing it", async () => {
    const { api, backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    const [secret] = await api.list(NS, "secrets");
    api.removeRaw(NS, "secrets", secret?.metadata.name as string);

    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      LaunchOutcomeUnknownError,
    );
    expect((await api.get(NS, "pods", podName))?.metadata.uid).toBe(
      first.providerRef,
    );
    expect(issued).toHaveLength(1);
  });

  test("replaces a Pod holding a credential the registry no longer accepts", async () => {
    const { backend } = setup();
    const { intent, issued } = intentFor();
    const first = await backend.ensureExecution(intent);
    issued.push("rotated-elsewhere");
    const again = await backend.ensureExecution(intent);
    expect(again.created).toBe(true);
    expect(again.providerRef).not.toBe(first.providerRef);
  });

  test("refuses a Pod of another launch spec and leaves it in place", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    const { providerRef } = await backend.ensureExecution(intent);
    const resources = { ...RESOURCES, pidsLimit: 1 };
    await expect(
      backend.ensureExecution({
        ...intent,
        launchSpec: launchSpecFingerprint(IMAGE, resources),
        resources,
      }),
    ).rejects.toBeInstanceOf(LaunchSpecMismatchError);
    expect((await api.get(NS, "pods", podName))?.metadata.uid).toBe(
      providerRef,
    );
  });

  test("refuses another operation's Pod under the name, without deleting it", async () => {
    const { api, backend } = setup();
    await backend.ensureExecution(intentFor().intent);
    await expect(
      backend.ensureExecution(intentFor({ operationId: "op-other" }).intent),
    ).rejects.toBeInstanceOf(ExecutionConflictError);
    expect(api.calls.filter((c) => c.verb === "delete")).toEqual([]);
  });

  test("a Secret create that is refused takes the Pod back and keeps the nonce out of the error", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    api.failures.push({
      error: new KubernetesApiError(
        422,
        "POST",
        "secrets",
        "invalid: wln_secret-1",
      ),
      kind: "secrets",
      verb: "create",
    });
    const refused = await backend
      .ensureExecution(intent)
      .catch((e: Error) => e);
    expect(refused).toBeInstanceOf(KubernetesApiError);
    expect((refused as Error).message).not.toContain("wln_secret-1");
    expect((refused as KubernetesApiError).body).not.toContain("wln_secret-1");
    expect(await api.list(NS, "pods")).toEqual([]);
  });

  test("a Secret create with no answer is an unknown outcome, and the Pod stays for the next pass", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    api.timeoutNext("create", "secrets");
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      LaunchOutcomeUnknownError,
    );
    expect(await api.list(NS, "pods")).toHaveLength(1);
  });

  test("a Pod create with no answer is an unknown outcome", async () => {
    const { api, backend } = setup();
    api.timeoutNext("create", "pods");
    await expect(
      backend.ensureExecution(intentFor().intent),
    ).rejects.toBeInstanceOf(LaunchOutcomeUnknownError);
  });

  test("refuses a tag before spending a nonce", async () => {
    const { backend } = setup();
    const { intent, issued } = intentFor({ image: "worker:latest" });
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ImageReferenceError,
    );
    expect(issued).toEqual([]);
  });

  test("refuses a workspace claim created with another size", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    const other = new KubernetesBackend(
      { ...testConfig(NS, INSTALLATION), workspaceSizeBytes: 1 },
      api.asClient(),
      testResolver,
    );
    await expect(
      other.ensureExecution({ ...intent, generation: 2 }),
    ).rejects.toBeInstanceOf(WorkspaceClaimError);
  });

  test("a replacement whose workspace vanished after the check is refused, not started empty", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    await backend.assertReplaceable(intent);
    api.removeRaw(
      NS,
      "persistentvolumeclaims",
      workspaceClaimNameFor(intent.sessionId, CLAIM_NAMING),
    );
    await expect(
      backend.ensureExecution({ ...intent, generation: 2 }),
    ).rejects.toBeInstanceOf(WorkspaceClaimError);
  });

  test("a replacement whose workspace was recreated under the same name after the check is refused", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    await backend.assertReplaceable(intent);
    api.replace(
      NS,
      "persistentvolumeclaims",
      workspaceClaimNameFor(intent.sessionId, CLAIM_NAMING),
    );
    await expect(
      backend.ensureExecution({ ...intent, generation: 2 }),
    ).rejects.toThrow("recreated since");
  });
});

describe("egress proxy hand-off", () => {
  function withResolver(resolveHost: HostResolver) {
    const api = new FakeKubernetes();
    const backend = new KubernetesBackend(
      testConfig(NS, INSTALLATION),
      api.asClient(),
      resolveHost,
    );
    return { api, backend };
  }

  async function hostAliasesOf(api: FakeKubernetes): Promise<unknown> {
    const pod = await api.get(NS, "pods", podName);
    return (pod?.spec as { hostAliases?: unknown } | undefined)?.hostAliases;
  }

  test("each launch resolves the proxy's name and hands the Pod its address, not a resolver", async () => {
    const asked: string[] = [];
    const { api, backend } = withResolver(async (host) => {
      asked.push(host);
      return [TEST_PROXY_ADDRESS];
    });
    await backend.ensureExecution(intentFor().intent);
    expect(asked).toEqual(["egress-proxy"]);
    expect(await hostAliasesOf(api)).toEqual([
      { hostnames: ["egress-proxy"], ip: TEST_PROXY_ADDRESS },
    ]);
    const pod = (await api.get(NS, "pods", podName)) as unknown as {
      spec: { dnsPolicy: string };
    };
    expect(pod.spec.dnsPolicy).toBe("None");
  });

  test("a proxy Service that moved leaves running Pods stale, and the next launch replaces them", async () => {
    let address = "10.96.0.10";
    const { api, backend } = withResolver(async () => [address]);
    const { intent } = intentFor();
    const first = await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Running");
    expect((await backend.inspect(intent)).stale).toBeUndefined();

    // The same scheduler sees the move on its next inspect, no launch needed.
    address = "10.96.0.20";
    expect((await backend.inspect(intent)).stale).toBe(true);

    const again = await backend.ensureExecution(intent);
    expect(again.created).toBe(true);
    expect(again.providerRef).not.toBe(first.providerRef);
    expect(await hostAliasesOf(api)).toEqual([
      { hostnames: ["egress-proxy"], ip: "10.96.0.20" },
    ]);
  });

  test("an inspect whose lookup fails judges by the last address instead of failing", async () => {
    let fail = false;
    const { api, backend } = withResolver(async () => {
      if (fail) throw new Error("EAI_AGAIN");
      return [TEST_PROXY_ADDRESS];
    });
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Running");
    fail = true;
    const observed = await backend.inspect(intent);
    expect(observed.state).toBe("running");
    expect(observed.stale).toBeUndefined();
  });

  test("an inspect with no address resolved yet fails rather than guess", async () => {
    const { api, backend } = withResolver(async () => [TEST_PROXY_ADDRESS]);
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    const fresh = new KubernetesBackend(
      testConfig(NS, INSTALLATION),
      api.asClient(),
      async () => {
        throw new Error("EAI_AGAIN");
      },
    );
    await expect(fresh.inspect(intent)).rejects.toThrow("does not resolve");
  });

  test("a replacement is refused up front when the proxy does not resolve", async () => {
    let addresses = [TEST_PROXY_ADDRESS];
    const { backend } = withResolver(async () => addresses);
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    addresses = [];
    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      "it must name a Service with one ClusterIP",
    );
  });

  test.each([
    [[], "no address"],
    [["10.244.0.7", "10.244.1.9"], "10.244.0.7, 10.244.1.9"],
  ])(
    "refuses a name that is not one ClusterIP (%p) before spending a nonce",
    async (addresses, named) => {
      const { backend } = withResolver(async () => addresses);
      const { intent, issued } = intentFor();
      await expect(backend.ensureExecution(intent)).rejects.toThrow(
        `resolves to ${named}; it must name a Service with one ClusterIP`,
      );
      expect(issued).toEqual([]);
    },
  );

  test("a name that does not resolve fails the launch before a nonce", async () => {
    const { backend } = withResolver(async () => {
      throw new Error("ENOTFOUND");
    });
    const { intent, issued } = intentFor();
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "Egress proxy egress-proxy does not resolve",
    );
    expect(issued).toEqual([]);
  });
});

describe("inspect", () => {
  const logReads = (api: FakeKubernetes) =>
    api.calls.filter((c) => c.verb === "log");

  test("an OOM-killed worker reports its reason, exit code and log tail", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed", {
      containerStatuses: [
        { state: { terminated: { exitCode: 137, reason: "OOMKilled" } } },
      ],
    });
    api.logs.set(podName, "booting\nallocating\n");
    expect(await backend.inspect(intent)).toMatchObject({
      exitCode: 137,
      logTail: "booting\nallocating\n",
      state: "terminated",
      terminationReason: "OOMKilled",
    });
    expect(logReads(api)).toEqual([
      {
        body: { container: "worker", limitBytes: 65_536, tailLines: 200 },
        kind: "pods",
        name: podName,
        verb: "log",
      },
    ]);
  });

  test("the Pod's own reason wins over its container's, and passes through", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed", {
      containerStatuses: [
        { state: { terminated: { exitCode: 137, reason: "Error" } } },
      ],
      reason: "Evicted",
    });
    expect(await backend.inspect(intent)).toMatchObject({
      exitCode: 137,
      terminationReason: "Evicted",
    });
    api.setPhase(NS, podName, "Failed", { reason: "DeadlineExceeded" });
    const observed = await backend.inspect(intent);
    expect(observed.terminationReason).toBe("DeadlineExceeded");
    expect(observed.exitCode).toBeUndefined();
  });

  test("a worker that succeeded reports its reason and has no log read", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.logs.set(podName, "done\n");
    api.setPhase(NS, podName, "Succeeded", {
      containerStatuses: [
        { state: { terminated: { exitCode: 0, reason: "Completed" } } },
      ],
    });
    const observed = await backend.inspect(intent);
    expect(observed).toMatchObject({
      exitCode: 0,
      terminationReason: "Completed",
    });
    expect(observed.logTail).toBeUndefined();
    api.setPhase(NS, podName, "Running");
    expect(await backend.inspect(intent)).not.toHaveProperty(
      "terminationReason",
    );
    expect(logReads(api)).toEqual([]);
  });

  test("keeps the last lines, then the last 8 KiB of them", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed");
    const lines = Array.from(
      { length: 300 },
      (_, i) => `line ${i} ${"x".repeat(60)}\n`,
    );
    api.logs.set(podName, lines.join(""));
    const tail = (await backend.inspect(intent)).logTail ?? "";
    expect(new TextEncoder().encode(tail).length).toBe(8 * 1024);
    expect(tail.endsWith(lines[299] as string)).toBe(true);
    expect(tail).not.toContain("line 99 ");
  });

  test("long lines that fill the read are read again fewer at a time, so the end survives", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed");
    const noise = Array.from({ length: 250 }, () => `${"n".repeat(1_000)}\n`);
    api.logs.set(podName, `${noise.join("")}fatal: out of disk\n`);
    const tail = (await backend.inspect(intent)).logTail ?? "";
    expect(tail.endsWith("fatal: out of disk\n")).toBe(true);
    expect(new TextEncoder().encode(tail).length).toBe(8 * 1024);
    expect(
      logReads(api).map((c) => (c.body as { tailLines: number }).tailLines),
    ).toEqual([200, 20]);
  });

  test("a last line longer than a read keeps its start and says its end is lost", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed");
    api.logs.set(podName, `start ${"x".repeat(100_000)} the end\n`);
    const tail = (await backend.inspect(intent)).logTail ?? "";
    expect(tail).toStartWith("start xxx");
    expect(tail).not.toContain("the end");
    expect(tail).toEndWith(
      "[log tail cut: the last line is longer than 65536 bytes; its end was not read]\n",
    );
    expect(new TextEncoder().encode(tail).length).toBeLessThan(8 * 1024 + 100);
    expect(
      logReads(api).map((c) => (c.body as { tailLines: number }).tailLines),
    ).toEqual([200, 20, 1]);
  });

  test("a log that cannot be read costs the tail, not the inspect", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed");
    api.failures.push({
      error: new KubernetesApiError(403, "GET", "log", "forbidden"),
      kind: "pods",
      verb: "log",
    });
    const observed = await backend.inspect(intent);
    expect(observed.state).toBe("terminated");
    expect(observed.logTail).toBeUndefined();
  });

  test("reads the log of nothing but a worker of this installation", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    api.setPhase(NS, podName, "Failed");
    api.logs.set(podName, "token=abc\n");
    const stored = api.objects.get(`${NS}/pods/${podName}`);
    (stored?.metadata.labels as Record<string, string>)[
      "app.kubernetes.io/component"
    ] = "api";
    expect((await backend.inspect(intent)).logTail).toBeUndefined();
    expect(logReads(api)).toEqual([]);
  });
});

describe("terminate", () => {
  test("deletes with the inspected Pod's UID as a precondition, and its Secret", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    const { providerRef } = await backend.ensureExecution(intent);
    expect(await backend.terminate(intent, { providerRef })).toEqual({
      outcome: "terminated",
      providerRef,
    });
    const deletes = api.calls.filter((c) => c.verb === "delete");
    expect(deletes[0]).toMatchObject({
      body: { gracePeriodSeconds: 1, uid: providerRef },
      kind: "pods",
    });
    expect(await api.list(NS, "secrets")).toEqual([]);
  });

  test("a Pod replaced after the inspect is reported and left running", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    const { providerRef } = await backend.ensureExecution(intent);
    const replacement = api.replace(NS, "pods", podName);
    expect(await backend.terminate(intent, { providerRef })).toEqual({
      foundProviderRef: replacement,
      outcome: "provider_mismatch",
    });
    expect((await api.get(NS, "pods", podName))?.metadata.uid).toBe(
      replacement,
    );
  });

  test("a Pod replaced between the read and the delete is saved by the precondition", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    let replacement = "";
    const get = api.get.bind(api);
    let reads = 0;
    api.get = async (namespace, kind, name) => {
      const found = await get(namespace, kind, name);
      if (kind === "pods") reads += 1;
      if (kind === "pods" && reads === 1) {
        replacement = api.replace(NS, "pods", podName);
      }
      return found;
    };
    expect(await backend.terminate(intent)).toEqual({
      foundProviderRef: replacement,
      outcome: "provider_mismatch",
    });
    expect((await get(NS, "pods", podName))?.metadata.uid).toBe(replacement);
  });

  test("another generation is reported and left alone", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution({ ...intent, generation: 2 });
    expect(await backend.terminate(intent)).toEqual({
      foundGeneration: 2,
      outcome: "generation_mismatch",
    });
    expect(await api.list(NS, "pods")).toHaveLength(1);
  });
});

describe("workspaces", () => {
  test("lists by label, and removes only an unused claim of the named session", async () => {
    const { api, backend } = setup();
    const { intent } = intentFor();
    await backend.ensureExecution(intent);
    const [workspace] = await backend.listWorkspaces();
    expect(workspace).toMatchObject({
      id: workspaceClaimNameFor(intent.sessionId, CLAIM_NAMING),
      sessionId: intent.sessionId,
    });
    const id = workspace?.id as string;
    expect(
      await backend.removeWorkspace(id, { sessionId: "someone-else" }),
    ).toEqual({ outcome: "not_ours" });
    expect(await backend.removeWorkspace(id)).toEqual({ outcome: "in_use" });
    await backend.terminate(intent);
    expect(await backend.removeWorkspace(id)).toEqual({ outcome: "removed" });
    expect(await backend.removeWorkspace(id)).toEqual({ outcome: "absent" });
    expect(await api.list(NS, "persistentvolumeclaims")).toEqual([]);
  });

  test("an existing claim is found by the configured prefix, and only by it", async () => {
    const api = new FakeKubernetes();
    const backendFor = (volumeNamePrefix: string) =>
      new KubernetesBackend(
        { ...testConfig(NS, INSTALLATION), volumeNamePrefix },
        api.asClient(),
        testResolver,
      );
    const { intent } = intentFor();
    const names = async () =>
      (await api.list(NS, "persistentvolumeclaims"))
        .map((claim) => claim.metadata.name)
        .sort();
    const other = `other-ws-${INSTALLATION}-${intent.sessionId}`;
    const own = `werft-ws-${INSTALLATION}-${intent.sessionId}`;

    await backendFor("other-ws-").ensureExecution(intent);
    expect(await names()).toEqual([other]);

    await backendFor("werft-ws-").ensureExecution({
      ...intent,
      executionId: "exec-2",
    });
    expect(await names()).toEqual([other, own].sort());

    await backendFor("other-ws-").ensureExecution({
      ...intent,
      executionId: "exec-3",
    });
    expect(await names()).toEqual([other, own].sort());
    const pods = await api.list(NS, "pods");
    const mounted = pods.map(
      (pod) =>
        (
          pod as unknown as {
            spec: {
              volumes: Array<{ persistentVolumeClaim?: { claimName: string } }>;
            };
          }
        ).spec.volumes[0]?.persistentVolumeClaim?.claimName,
    );
    expect(mounted.sort()).toEqual([other, own, other].sort());
  });

  test("a young claim is not listed while the age gate is on", async () => {
    const api = new FakeKubernetes();
    const backend = new KubernetesBackend(
      { ...testConfig(NS, INSTALLATION), workspaceGcMinAgeMs: 3_600_000 },
      api.asClient(),
      testResolver,
    );
    await backend.ensureExecution(intentFor().intent);
    expect(await backend.listWorkspaces()).toEqual([]);
  });
});
