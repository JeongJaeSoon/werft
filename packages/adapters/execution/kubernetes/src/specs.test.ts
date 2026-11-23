import { describe, expect, test } from "bun:test";
import type { LaunchIntent } from "@werft-ai/platform";
import {
  cpuQuantity,
  ENV,
  isolationStampFor,
  legacyIsolationStampFor,
  nonceSecretFor,
  nonceSecretNameOf,
  podFor,
  podNameFor,
  workerLimitsOfPod,
  workspaceClaimFor,
  workspaceClaimNameFor,
} from "./specs.ts";
import { testConfig } from "./testing/index.ts";

const config = {
  ...testConfig("agents", "prod"),
  workerLimits: { maxTurnSeconds: 900, providerMaxRetries: 3 },
};
const NONCE = "wln_never-in-the-pod";
const intent: LaunchIntent = {
  bootstrapCredentialState: async () => ({ claimed: true }),
  executionId: "exec-1",
  generation: 3,
  image: `worker@sha256:${"c".repeat(64)}`,
  issueBootstrapNonce: async () => NONCE,
  launchSpec: "f".repeat(64),
  operationId: "op-1",
  resources: { cpus: 1.5, memoryBytes: 1024 * 1024 * 1024, pidsLimit: 512 },
  sessionId: "6c1f8d0e-0000-4000-8000-000000000001",
};

type PodShape = {
  metadata: {
    annotations: Record<string, string>;
    labels: Record<string, string>;
    name: string;
  };
  spec: {
    automountServiceAccountToken: boolean;
    containers: Array<{
      env: Array<{
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef?: { key: string; name: string } };
      }>;
      resources: unknown;
      securityContext: unknown;
      volumeMounts: unknown[];
      args?: string[];
    }>;
    restartPolicy: string;
    securityContext: unknown;
    volumes: unknown;
    enableServiceLinks: boolean;
    terminationGracePeriodSeconds: number;
    dnsConfig: unknown;
    dnsPolicy: string;
    hostAliases: unknown;
    affinity?: unknown;
  };
};

const PROXY_ADDRESS = "10.96.12.34";
const pod = podFor(
  config,
  intent,
  "secret-name",
  "fingerprint",
  PROXY_ADDRESS,
) as PodShape;
const [container] = pod.spec.containers;
if (container === undefined) throw new Error("no container");

describe("worker Pod", () => {
  test("adds the declaration only when true and preserves resource identity", () => {
    const makePod = (workspaceEnforcedByStorage?: boolean) =>
      podFor(
        {
          ...config,
          ...(workspaceEnforcedByStorage === undefined
            ? {}
            : { workspaceEnforcedByStorage }),
        },
        intent,
        "secret-name",
        "fingerprint",
        PROXY_ADDRESS,
      ) as PodShape;
    expect(JSON.stringify(makePod(false))).toBe(JSON.stringify(pod));
    expect(JSON.stringify(makePod())).toBe(JSON.stringify(pod));
    for (const workspaceEnforcedByStorage of [false, true]) {
      const declared = { ...config, workspaceEnforcedByStorage };
      expect(workspaceClaimFor(declared, intent.sessionId)).toEqual(
        workspaceClaimFor(config, intent.sessionId),
      );
      expect(isolationStampFor(declared, PROXY_ADDRESS)).toBe(
        isolationStampFor(config, PROXY_ADDRESS),
      );
    }
    const enabled = makePod(true);
    expect(enabled.spec.containers[0]?.env).toContainEqual({
      name: "WORKER_WORKSPACE_ENFORCED_BY_STORAGE",
      value: "true",
    });
    for (const c of enabled.spec.containers) {
      c.env = c.env.filter(
        (entry) => entry.name !== ENV.workspaceEnforcedByStorage,
      );
    }
    expect(enabled).toEqual(pod);
  });

  test("runs non-root on a read-only rootfs with nothing to escalate to", () => {
    expect(container.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.securityContext).toEqual({
      fsGroup: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(pod.spec.restartPolicy).toBe("Never");
    expect(pod.spec.automountServiceAccountToken).toBe(false);
    expect(pod.spec.enableServiceLinks).toBe(false);
    expect(pod.spec.terminationGracePeriodSeconds).toBe(
      config.stopTimeoutSeconds,
    );
  });

  test("a declared Codex image's container alone gets the sandbox's Localhost profile", () => {
    const podOf = (
      codexSandbox: NonNullable<(typeof config)["codexSandbox"]>,
    ) =>
      podFor(
        { ...config, codexSandbox },
        intent,
        "secret-name",
        "fingerprint",
        PROXY_ADDRESS,
      ) as PodShape;
    const sandboxed = podOf({ mode: "enabled", images: [intent.image] });
    expect(sandboxed.spec.containers[0]?.securityContext).toEqual({
      ...(container.securityContext as object),
      seccompProfile: {
        localhostProfile: "werft/codex-sandbox.json",
        type: "Localhost",
      },
    });
    expect(sandboxed.spec.securityContext).toEqual(pod.spec.securityContext);
    // On, it changes no stamp, so no running Pod is replaced for it.
    expect(sandboxed.metadata.annotations).toEqual(pod.metadata.annotations);
    expect(
      podOf({
        mode: "enabled",
        images: [`codex@sha256:${"d".repeat(64)}`],
      }),
    ).toEqual(pod);
  });

  test("a Pod given the sandbox's profile is placed only on a node labelled as holding it", () => {
    const sandboxed = podFor(
      { ...config, codexSandbox: { mode: "enabled", images: [intent.image] } },
      intent,
      "secret-name",
      "fingerprint",
      PROXY_ADDRESS,
    ) as PodShape;
    expect(sandboxed.spec.affinity).toEqual({
      nodeAffinity: {
        requiredDuringSchedulingIgnoredDuringExecution: {
          nodeSelectorTerms: [
            {
              matchExpressions: [
                {
                  key: "werft.codex-seccomp-profile",
                  operator: "In",
                  values: ["installed"],
                },
              ],
            },
          ],
        },
      },
    });
    expect(pod.spec.affinity).toBeUndefined();
    const disabled = podFor(
      { ...config, codexSandbox: { mode: "disabled" } },
      intent,
      "secret-name",
      "fingerprint",
      PROXY_ADDRESS,
    ) as PodShape;
    expect(disabled.spec.affinity).toBeUndefined();
  });

  test("the Codex sandbox turned off reaches the worker and is another isolation stamp", () => {
    const off = { ...config, codexSandbox: { mode: "disabled" } } as const;
    const disabled = podFor(
      off,
      intent,
      "secret-name",
      "fingerprint",
      PROXY_ADDRESS,
    ) as PodShape;
    expect(disabled.spec.containers[0]?.env).toContainEqual({
      name: "CODEX_SANDBOX",
      value: "disabled",
    });
    expect(disabled.spec.containers[0]?.securityContext).toEqual(
      container.securityContext,
    );
    expect(isolationStampFor(off, PROXY_ADDRESS)).not.toBe(
      isolationStampFor(config, PROXY_ADDRESS),
    );
  });

  test("asks no DNS server and finds the proxy in its hosts file", () => {
    expect(pod.spec.dnsPolicy).toBe("None");
    expect(pod.spec.dnsConfig).toEqual({ nameservers: ["127.0.0.1"] });
    expect(pod.spec.hostAliases).toEqual([
      { hostnames: ["egress-proxy"], ip: PROXY_ADDRESS },
    ]);
    // The env still names the proxy, as the Docker backend's does.
    expect(container.env.find((e) => e.name === "HTTPS_PROXY")?.value).toBe(
      "http://egress-proxy:3128",
    );
  });

  test("a proxy address change is another isolation stamp", () => {
    expect(isolationStampFor(config, "10.96.0.1")).not.toBe(
      isolationStampFor(config, PROXY_ADDRESS),
    );
    expect(isolationStampFor(config, PROXY_ADDRESS)).toStartWith("2:");
  });

  // Every running Pod carries one of these; a different value marks them all
  // stale at once.
  test("the isolation stamps of this config are pinned", () => {
    const got = { maxTurnSeconds: 900, providerMaxRetries: 2 };
    expect([
      isolationStampFor(config, PROXY_ADDRESS),
      legacyIsolationStampFor(config, PROXY_ADDRESS, got),
      legacyIsolationStampFor(config, PROXY_ADDRESS, null),
    ]).toEqual([
      "2:f8db087b6e473ab1",
      "2:bdb3697e7e8ef670",
      "2:fe99af9c5ff1c874",
    ]);
  });

  test("a Pod that checked out at the mount's root reads as another stamp", () => {
    // This config's stamp before the checkout moved below the mount.
    expect(isolationStampFor(config, PROXY_ADDRESS)).not.toBe(
      "2:cd68dc934a0853d0",
    );
  });

  test("takes its limits from the intent and its disk from the config, requests equal to limits", () => {
    const limits = {
      cpu: "1500m",
      "ephemeral-storage": String(config.ephemeralStorageBytes),
      memory: String(1024 * 1024 * 1024),
    };
    expect(container.resources).toEqual({ limits, requests: limits });
  });

  test("the isolation stamp leaves the worker limits to the launch", () => {
    const moved = {
      ...config,
      workerLimits: { maxTurnSeconds: 1800, providerMaxRetries: 3 },
    };
    expect(isolationStampFor(moved, PROXY_ADDRESS)).toBe(
      isolationStampFor(config, PROXY_ADDRESS),
    );
    // A host from before the pin stamped the limits its worker got, or none
    // before they existed; neither is this host's stamp.
    const got = { maxTurnSeconds: 900, providerMaxRetries: 2 };
    expect(legacyIsolationStampFor(config, PROXY_ADDRESS, got)).not.toBe(
      isolationStampFor(config, PROXY_ADDRESS),
    );
    expect(legacyIsolationStampFor(config, PROXY_ADDRESS, null)).not.toBe(
      isolationStampFor(config, PROXY_ADDRESS),
    );
    expect(
      legacyIsolationStampFor(config, PROXY_ADDRESS, {
        ...got,
        maxTurnSeconds: 1800,
      }),
    ).not.toBe(legacyIsolationStampFor(config, PROXY_ADDRESS, got));
    // The limits this host was configured with play no part in it.
    expect(legacyIsolationStampFor(moved, PROXY_ADDRESS, got)).toBe(
      legacyIsolationStampFor(config, PROXY_ADDRESS, got),
    );
  });

  test("starts the worker with the limits its launch was reserved with, and reads them back", () => {
    const limits = { maxTurnSeconds: 300, providerMaxRetries: 0 };
    const podOf = (
      backendConfig: Parameters<typeof podFor>[0],
      launch: LaunchIntent,
    ) =>
      podFor(
        backendConfig,
        launch,
        "secret-name",
        "fingerprint",
        PROXY_ADDRESS,
      ) as PodShape;
    const pinned = podOf(config, {
      ...intent,
      resources: { ...intent.resources, workerLimits: limits },
    });
    const env = pinned.spec.containers[0]?.env ?? [];
    expect(env.find((e) => e.name === ENV.maxTurnSeconds)?.value).toBe("300");
    expect(env.find((e) => e.name === ENV.providerMaxRetries)?.value).toBe("0");
    expect(workerLimitsOfPod(pinned as never)).toEqual(limits);
    // Reserved before the limits were pinned: the host's.
    expect(workerLimitsOfPod(pod as never)).toEqual(config.workerLimits);
    const { workerLimits: _, ...none } = config;
    expect(workerLimitsOfPod(podOf(none, intent) as never)).toBeNull();
  });

  test("a changed disk limit is another isolation stamp", () => {
    expect(
      isolationStampFor(
        { ...config, ephemeralStorageBytes: config.ephemeralStorageBytes * 2 },
        PROXY_ADDRESS,
      ),
    ).not.toBe(isolationStampFor(config, PROXY_ADDRESS));
  });

  test("carries the contract labels and the launch's identity", () => {
    expect(pod.metadata.name).toBe("ap-worker-prod-exec-1-g3");
    expect(pod.metadata.labels).toEqual({
      "werft.generation": "3",
      "werft.installation": "prod",
      "werft.session-execution-id": "exec-1",
      "werft.session-id": intent.sessionId,
      "app.kubernetes.io/component": "worker",
      "app.kubernetes.io/part-of": "werft",
    });
    expect(pod.metadata.annotations).toEqual({
      "werft.bootstrap-fingerprint": "fingerprint",
      "werft.isolation": isolationStampFor(config, PROXY_ADDRESS),
      "werft.launch-spec": "f".repeat(64),
      "werft.operation-id": "op-1",
    });
  });

  test("mounts the session's claim and memory-backed /tmp and HOME", () => {
    expect(pod.spec.volumes).toEqual([
      {
        name: "workspace",
        persistentVolumeClaim: {
          claimName: `werft-ws-prod-${intent.sessionId}`,
        },
      },
      {
        emptyDir: { medium: "Memory", sizeLimit: String(16 * 1024 * 1024) },
        name: "tmp",
      },
      {
        emptyDir: { medium: "Memory", sizeLimit: String(16 * 1024 * 1024) },
        name: "home",
      },
    ]);
  });

  test("mounts the claim at workspaceDir and has the worker check out below it", () => {
    expect(container.volumeMounts).toContainEqual({
      mountPath: "/workspace",
      name: "workspace",
    });
    expect(container.env).toContainEqual({
      name: "WORKER_WORKSPACE_DIR",
      value: "/workspace/repo",
    });
  });

  test("reads the nonce from its Secret and never holds it", () => {
    expect(JSON.stringify(pod)).not.toContain(NONCE);
    expect(container.env[0]).toEqual({
      name: "WORKER_BOOTSTRAP_NONCE",
      valueFrom: { secretKeyRef: { key: "nonce", name: "secret-name" } },
    });
    expect(nonceSecretNameOf(pod)).toBe("secret-name");
  });

  test("refuses a CPU limit that rounds to none and limits that are not positive", () => {
    expect(() => cpuQuantity(0.0004)).toThrow("rounds to no CPU limit");
    expect(() =>
      podFor(
        config,
        { ...intent, resources: { ...intent.resources, memoryBytes: 0 } },
        "s",
        "f",
        PROXY_ADDRESS,
      ),
    ).toThrow("memoryBytes");
  });

  test("refuses ids that cannot be part of a Kubernetes name", () => {
    expect(() =>
      podNameFor({ executionId: "Exec_1", generation: 1 }, "prod"),
    ).toThrow("cannot be used in a Kubernetes name");
  });
});

describe("nonce Secret and workspace claim", () => {
  test("the Secret is owned by its Pod and labelled as bootstrap", () => {
    expect(
      nonceSecretFor(
        config,
        intent,
        { name: "pod-a", uid: "uid-a" },
        "pod-a-1234",
        NONCE,
      ),
    ).toEqual({
      apiVersion: "v1",
      immutable: true,
      kind: "Secret",
      metadata: {
        labels: {
          "werft.generation": "3",
          "werft.installation": "prod",
          "werft.session-execution-id": "exec-1",
          "app.kubernetes.io/component": "bootstrap",
          "app.kubernetes.io/part-of": "werft",
        },
        name: "pod-a-1234",
        namespace: "agents",
        ownerReferences: [
          { apiVersion: "v1", kind: "Pod", name: "pod-a", uid: "uid-a" },
        ],
      },
      stringData: { nonce: NONCE },
      type: "Opaque",
    });
  });

  test("the claim asks for the quota and names its StorageClass only when set", () => {
    const claim = workspaceClaimFor(config, intent.sessionId) as {
      metadata: { labels: Record<string, string> };
      spec: Record<string, unknown>;
    };
    expect(claim.metadata.labels).toEqual({
      "werft.installation": "prod",
      "werft.session-id": intent.sessionId,
      "app.kubernetes.io/component": "workspace",
      "app.kubernetes.io/part-of": "werft",
    });
    expect(claim.spec).toEqual({
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: String(64 * 1024 * 1024) } },
      volumeMode: "Filesystem",
    });
    expect(
      (
        workspaceClaimFor(
          { ...config, storageClass: "gp3" },
          intent.sessionId,
        ) as {
          spec: { storageClassName?: string };
        }
      ).spec.storageClassName,
    ).toBe("gp3");
  });

  test("an existing claim is looked up and mounted under the configured prefix, and only that one", () => {
    const named = { ...config, volumeNamePrefix: "legacy-ws-" };
    const expected = `legacy-ws-prod-${intent.sessionId}`;
    expect(workspaceClaimNameFor(intent.sessionId, named)).toBe(expected);
    expect(
      (
        workspaceClaimFor(named, intent.sessionId) as {
          metadata: { name: string };
        }
      ).metadata.name,
    ).toBe(expected);
    const mounted = podFor(
      named,
      intent,
      "secret-name",
      "fingerprint",
      PROXY_ADDRESS,
    ) as PodShape;
    expect(mounted.spec.volumes).toMatchObject([
      { persistentVolumeClaim: { claimName: expected } },
      expect.anything(),
      expect.anything(),
    ]);
    expect(workspaceClaimNameFor(intent.sessionId, config)).toBe(
      `werft-ws-prod-${intent.sessionId}`,
    );
  });
});
