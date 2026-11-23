import { posix } from "node:path";
import {
  ENV,
  egressCredentialUrlOf,
  NO_PROXY_VALUE,
  noProxyValueFor,
} from "@werft-ai/contracts/execution";
import {
  type ExecutionRef,
  hashWorkerToken,
  isolationStampOf,
  type LaunchIntent,
  launchNonceFingerprint,
  sessionObjectPrefix,
  WORKER_LIMITS_PINNED,
  type WorkerLimits,
  workerLimitsOf,
} from "@werft-ai/platform";
import type { Pod } from "./client.ts";
import {
  CODEX_SECCOMP_NODE_LABEL,
  CODEX_SECCOMP_PROFILE,
} from "./codex-seccomp.ts";
import type { KubernetesBackendConfig } from "./config.ts";

/**
 * Selectable identity. The first three are the K8S CONTRACT the chart's
 * NetworkPolicy and Role are written against; a label value holds at most
 * 63 characters, so anything longer rides in `ANNOTATIONS`.
 */
export const LABELS = {
  partOf: "app.kubernetes.io/part-of",
  component: "app.kubernetes.io/component",
  installation: "werft.installation",
  executionId: "werft.session-execution-id",
  generation: "werft.generation",
  sessionId: "werft.session-id",
} as const;

export const PART_OF = "werft";

export const COMPONENTS = {
  bootstrap: "bootstrap",
  worker: "worker",
  workspace: "workspace",
} as const;

export const ANNOTATIONS = {
  /** `launchNonceFingerprint` of the nonce in the Pod's Secret, never the nonce. */
  bootstrapFingerprint: "werft.bootstrap-fingerprint",
  /** Which isolation contract the Pod was created under. */
  isolation: "werft.isolation",
  /** The intent's `launchSpec`; absent when the launch stored none. */
  launchSpec: "werft.launch-spec",
  operationId: "werft.operation-id",
  /** On the workspace PVC: the size it was created with. */
  workspaceSize: "werft.workspace-size",
} as const;

export { ENV } from "@werft-ai/contracts/execution";

/** The key in the nonce Secret the worker's env reads. */
export const NONCE_KEY = "nonce";
export const CONTAINER_NAME = "worker";

/**
 * The claim is mounted at `workspaceDir` and the checkout lives one level
 * below, in a directory the worker makes. A fresh volume's root belongs to
 * root (fsGroup changes only its group), and git refuses a repository whose
 * top directory another user owns.
 */
export const CHECKOUT_DIRECTORY = "repo";

export function checkoutDirOf(
  config: Pick<KubernetesBackendConfig, "workspaceDir">,
): string {
  return posix.join(config.workspaceDir, CHECKOUT_DIRECTORY);
}

/**
 * Bumped whenever what a worker Pod is created with changes in a way a
 * running Pod does not pick up, so the scheduler replaces it.
 *
 * 1: non-root, read-only rootfs, dropped caps, RuntimeDefault seccomp, no
 *    ServiceAccount token, per-session PVC, nonce through a Secret.
 * 2: no cluster DNS; the proxy's name reaches the Pod through hostAliases.
 *
 * Each bump records in isolation-contract.test.ts whether it needs the
 * worker image's cooperation.
 */
export const ISOLATION_CONTRACT = 2;

/**
 * The resolver a worker Pod is given: nothing listens there, so a lookup
 * the hosts file cannot answer fails at once instead of timing out against
 * a cluster DNS the NetworkPolicy blocks.
 */
export const WORKER_NAMESERVER = "127.0.0.1";

/**
 * The contract version and a fingerprint of the settings that shape a
 * Pod's boundary. CPU and memory stay out on purpose, as in the Docker
 * backend: they belong to the launch and are checked by its launch spec.
 * The proxy's address is in it because a Pod only knows the address it was
 * created with: a proxy Service recreated under a new ClusterIP leaves
 * every older Pod without a route, so they read as stale and are replaced.
 * The turn time and provider retries are pinned to the launch the same way;
 * the marker in their place keeps a Pod from before they existed, whose
 * worker reports no turn cost, from matching.
 */
export function isolationStampFor(
  config: KubernetesBackendConfig,
  proxyAddress: string,
): string {
  return stampOf(config, proxyAddress, WORKER_LIMITS_PINNED);
}

/**
 * The stamp a host from before the worker limits were pinned gave its Pods,
 * with that host's limits in it: `limits` are the ones the Pod's worker was
 * started with, from its env. A match says its boundary is this host's;
 * whether its limits still are is the scheduler's to judge.
 */
export function legacyIsolationStampFor(
  config: KubernetesBackendConfig,
  proxyAddress: string,
  limits: WorkerLimits | null,
): string {
  return stampOf(config, proxyAddress, limits);
}

function stampOf(
  config: KubernetesBackendConfig,
  proxyAddress: string,
  limits: unknown,
): string {
  return isolationStampOf(ISOLATION_CONTRACT, [
    config.egressProxyUrl,
    proxyAddress,
    config.egressCredentialPort,
    config.homeDir,
    NO_PROXY_VALUE,
    config.tmpfsSizeBytes,
    config.user,
    config.workspaceDir,
    // A Pod that checks out at the mount's root fails on a fresh volume.
    checkoutDirOf(config),
    config.objectStore.bucket,
    config.objectStore.region,
    config.workspaceSizeBytes,
    config.workerServiceAccount,
    config.stopTimeoutSeconds,
    limits,
    config.ephemeralStorageBytes,
    // Only the off switch, as in the Docker backend: turning this release on
    // replaces no running Pod, and one without the profile has its auto
    // sessions refused.
    ...(config.codexSandbox?.mode === "disabled"
      ? ["codex-sandbox:disabled"]
      : []),
  ]);
}

const NAME_PART = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function namePart(kind: string, value: string): string {
  // Also a label value, so the 63-character bound applies here too.
  if (!NAME_PART.test(value)) {
    throw new Error(
      `${kind} ${value} cannot be used in a Kubernetes name (lowercase letters, digits and '-', at most 63)`,
    );
  }
  return value;
}

/** Deterministic per launch, so a retried create collides instead of doubling. */
export function podNameFor(ref: ExecutionRef, installationId: string): string {
  return `ap-worker-${installationId}-${namePart("Execution id", ref.executionId)}-g${ref.generation}`;
}

/**
 * Per session, so every generation mounts the same tree. Unlike the Docker
 * volume, a removed PVC's name is safe to reuse: its storage is a new
 * volume with nothing of the old one's left on it.
 */
export function workspaceClaimNameFor(
  sessionId: string,
  config: Pick<KubernetesBackendConfig, "installationId" | "volumeNamePrefix">,
): string {
  return `${config.volumeNamePrefix}${config.installationId}-${namePart("Session id", sessionId)}`;
}

/** New for every create: an old Pod's Secret may still be on its way out. */
export function nonceSecretNameFor(podName: string): string {
  return `${podName}-${crypto.randomUUID().slice(0, 8)}`;
}

function baseLabels(
  component: keyof typeof COMPONENTS,
  installationId: string,
): Record<string, string> {
  return {
    [LABELS.partOf]: PART_OF,
    [LABELS.component]: COMPONENTS[component],
    [LABELS.installation]: installationId,
  };
}

export function selectorFor(
  component: keyof typeof COMPONENTS,
  installationId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...baseLabels(component, installationId), ...extra };
}

/** Kubernetes quantity from a CPU count: millicores, refusing what rounds to none. */
export function cpuQuantity(cpus: number): string {
  const millis = Math.round(cpus * 1000);
  if (!Number.isFinite(cpus) || millis < 1) {
    throw new Error(`cpus ${cpus} rounds to no CPU limit`);
  }
  return `${millis}m`;
}

/**
 * The worker container's: a declared Codex image's gets the one bubblewrap
 * needs while the sandbox is on. Set on the container alone, so the Pod's
 * own default stays RuntimeDefault for anything else in it.
 */
function seccompProfileFor(sandboxed: boolean): Record<string, string> {
  return sandboxed
    ? { localhostProfile: CODEX_SECCOMP_PROFILE, type: "Localhost" }
    : { type: "RuntimeDefault" };
}

function codexSandboxed(
  config: KubernetesBackendConfig,
  image: string,
): boolean {
  const sandbox = config.codexSandbox;
  return sandbox?.mode === "enabled" && sandbox.images.includes(image);
}

/**
 * A Pod given the profile goes only to a node labelled as holding it, so on
 * a cluster with no such node it waits Pending instead of failing to start.
 */
const PROFILE_NODE_AFFINITY = {
  nodeAffinity: {
    requiredDuringSchedulingIgnoredDuringExecution: {
      nodeSelectorTerms: [
        {
          matchExpressions: [
            {
              key: CODEX_SECCOMP_NODE_LABEL.key,
              operator: "In",
              values: [CODEX_SECCOMP_NODE_LABEL.value],
            },
          ],
        },
      ],
    },
  },
};

/**
 * The worker Pod. The nonce is not in here: the env entry for it names the
 * Secret that holds it, created right after the Pod and owned by it.
 *
 * `pidsLimit` has no Pod-level field — the bound is the node kubelet's
 * `podPidsLimit`, which the node pool has to set. It stays in the launch
 * spec, so a changed limit still marks a running Pod as another spec.
 *
 * `proxyAddress` is the proxy Service's ClusterIP: the Pod resolves the
 * proxy's name from its hosts file and asks no DNS server anything.
 */
export function podFor(
  config: KubernetesBackendConfig,
  intent: LaunchIntent,
  secretName: string,
  bootstrapFingerprint: string,
  proxyAddress: string,
  pvcCapacityBytes?: number,
): Record<string, unknown> {
  const { cpus, memoryBytes, pidsLimit } = intent.resources;
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1) {
    throw new Error(`memoryBytes ${memoryBytes} is not a positive limit`);
  }
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 1) {
    throw new Error(`pidsLimit ${pidsLimit} is not a positive limit`);
  }
  const resources = {
    cpu: cpuQuantity(cpus),
    "ephemeral-storage": String(config.ephemeralStorageBytes),
    memory: String(memoryBytes),
  };
  const [uid, gid = uid] = config.user.split(":").map(Number);
  const tmpfs = { medium: "Memory", sizeLimit: String(config.tmpfsSizeBytes) };
  const sandboxed = codexSandboxed(config, intent.image);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      annotations: {
        [ANNOTATIONS.bootstrapFingerprint]: bootstrapFingerprint,
        [ANNOTATIONS.isolation]: isolationStampFor(config, proxyAddress),
        ...(intent.launchSpec === null
          ? {}
          : { [ANNOTATIONS.launchSpec]: intent.launchSpec }),
        [ANNOTATIONS.operationId]: intent.operationId,
      },
      labels: {
        ...baseLabels("worker", config.installationId),
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: String(intent.generation),
        [LABELS.sessionId]: intent.sessionId,
      },
      name: podNameFor(intent, config.installationId),
      namespace: config.namespace,
    },
    spec: {
      ...(sandboxed ? { affinity: PROFILE_NODE_AFFINITY } : {}),
      automountServiceAccountToken: false,
      containers: [
        {
          ...(config.command ? { args: config.command } : {}),
          env: workerEnvironmentFor(
            config,
            intent,
            secretName,
            pvcCapacityBytes,
          ),
          image: intent.image,
          imagePullPolicy: "IfNotPresent",
          name: CONTAINER_NAME,
          // Requests equal to limits: Guaranteed QoS, so a busy node evicts
          // other Pods' burst before a worker's turn.
          resources: { limits: resources, requests: resources },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
            privileged: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            seccompProfile: seccompProfileFor(sandboxed),
          },
          volumeMounts: [
            { mountPath: config.workspaceDir, name: "workspace" },
            { mountPath: "/tmp", name: "tmp" },
            { mountPath: config.homeDir, name: "home" },
          ],
        },
      ],
      // Name lookups are a way out too (a DNS tunnel through the cluster
      // resolver), so the Pod gets no resolver at all.
      dnsConfig: { nameservers: [WORKER_NAMESERVER] },
      dnsPolicy: "None",
      // Service env vars would hand the worker every Service in the
      // namespace; it is told the two it needs.
      enableServiceLinks: false,
      hostAliases: [{ hostnames: [proxyHostOf(config)], ip: proxyAddress }],
      ...(config.imagePullSecrets.length === 0
        ? {}
        : {
            imagePullSecrets: config.imagePullSecrets.map((name) => ({
              name,
            })),
          }),
      ...(Object.keys(config.nodeSelector).length === 0
        ? {}
        : { nodeSelector: config.nodeSelector }),
      restartPolicy: "Never",
      securityContext: {
        fsGroup: gid,
        runAsGroup: gid,
        runAsNonRoot: true,
        runAsUser: uid,
        seccompProfile: { type: "RuntimeDefault" },
      },
      ...(config.workerServiceAccount === null
        ? {}
        : { serviceAccountName: config.workerServiceAccount }),
      terminationGracePeriodSeconds: config.stopTimeoutSeconds,
      ...(config.tolerations.length === 0
        ? {}
        : { tolerations: config.tolerations }),
      volumes: [
        {
          name: "workspace",
          persistentVolumeClaim: {
            claimName: workspaceClaimNameFor(intent.sessionId, config),
          },
        },
        { emptyDir: tmpfs, name: "tmp" },
        { emptyDir: tmpfs, name: "home" },
      ],
    },
  };
}

/**
 * The nonce's only home besides the worker's env. Owned by the Pod, so the
 * cluster removes it with the Pod however the Pod goes.
 */
export function nonceSecretFor(
  config: KubernetesBackendConfig,
  ref: ExecutionRef,
  pod: { name: string; uid: string },
  secretName: string,
  nonce: string,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    immutable: true,
    kind: "Secret",
    metadata: {
      labels: {
        ...baseLabels("bootstrap", config.installationId),
        [LABELS.executionId]: ref.executionId,
        [LABELS.generation]: String(ref.generation),
      },
      name: secretName,
      namespace: config.namespace,
      ownerReferences: [
        { apiVersion: "v1", kind: "Pod", name: pod.name, uid: pod.uid },
      ],
    },
    stringData: { [NONCE_KEY]: nonce },
    type: "Opaque",
  };
}

export function workspaceClaimFor(
  config: KubernetesBackendConfig,
  sessionId: string,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      annotations: {
        [ANNOTATIONS.workspaceSize]: String(config.workspaceSizeBytes),
      },
      labels: {
        ...baseLabels("workspace", config.installationId),
        [LABELS.sessionId]: sessionId,
      },
      name: workspaceClaimNameFor(sessionId, config),
      namespace: config.namespace,
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: String(config.workspaceSizeBytes) } },
      ...(config.storageClass === null
        ? {}
        : { storageClassName: config.storageClass }),
      volumeMode: "Filesystem",
    },
  };
}

export function bootstrapFingerprintOf(nonce: string): string {
  return launchNonceFingerprint(hashWorkerToken(nonce));
}

export function proxyHostOf(
  config: Pick<KubernetesBackendConfig, "egressProxyUrl">,
): string {
  return new URL(config.egressProxyUrl).hostname;
}

type EnvVar =
  | { name: string; value: string }
  | {
      name: string;
      valueFrom: { secretKeyRef: { key: string; name: string } };
    };

/** What a worker Pod is told; the same contract as the Docker backend's env. */
export function workerEnvironmentFor(
  config: KubernetesBackendConfig,
  intent: Pick<LaunchIntent, "executionId" | "generation" | "sessionId"> & {
    resources?: Pick<LaunchIntent["resources"], "workerLimits">;
  },
  secretName: string,
  pvcCapacityBytes?: number,
): EnvVar[] {
  // A launch reserved before the limits were pinned starts with the host's.
  const workerLimits = intent.resources?.workerLimits ?? config.workerLimits;
  const plain: Array<[string, string]> = [
    [ENV.executionGeneration, String(intent.generation)],
    [ENV.executionId, intent.executionId],
    [ENV.gatewayUrl, config.gatewayUrl],
    [ENV.egressCredentialUrl, egressCredentialUrlOf(config)],
    [ENV.home, config.homeDir],
    [ENV.workspaceDir, checkoutDirOf(config)],
    [ENV.workspaceMountDir, config.workspaceDir],
    [ENV.workspaceQuotaBytes, String(config.workspaceSizeBytes)],
    ...(config.workspaceEnforcedByStorage === true
      ? ([[ENV.workspaceEnforcedByStorage, "true"]] as Array<[string, string]>)
      : []),
    ...(pvcCapacityBytes === undefined
      ? []
      : ([[ENV.workspacePvcCapacityBytes, String(pvcCapacityBytes)]] as Array<
          [string, string]
        >)),
    [ENV.httpProxy, config.egressProxyUrl],
    [ENV.httpProxyLower, config.egressProxyUrl],
    [ENV.httpsProxy, config.egressProxyUrl],
    [ENV.httpsProxyLower, config.egressProxyUrl],
    [ENV.noProxy, noProxyValueFor(config)],
    [ENV.noProxyLower, noProxyValueFor(config)],
    [ENV.objectBucket, config.objectStore.bucket],
    [ENV.objectPrefix, sessionObjectPrefix(intent.sessionId)],
    [ENV.objectRegion, config.objectStore.region],
    [ENV.stopGrace, String(config.stopTimeoutSeconds)],
    ...(workerLimits === undefined
      ? []
      : ([
          [ENV.maxTurnSeconds, String(workerLimits.maxTurnSeconds)],
          [ENV.providerMaxRetries, String(workerLimits.providerMaxRetries)],
        ] as Array<[string, string]>)),
    ...(config.logLevel === undefined
      ? []
      : ([[ENV.logLevel, config.logLevel]] as Array<[string, string]>)),
    ...(config.codexSandbox?.mode === "disabled"
      ? ([[ENV.codexSandbox, "disabled"]] as Array<[string, string]>)
      : []),
  ];
  return [
    {
      name: ENV.bootstrapNonce,
      valueFrom: { secretKeyRef: { key: NONCE_KEY, name: secretName } },
    },
    ...plain.map(([name, value]) => ({ name, value })),
  ];
}

/** The limits a Pod's worker was started with, from its env. */
export function workerLimitsOfPod(pod: Pod): WorkerLimits | null {
  const env = pod.spec.containers.find((c) => c.name === CONTAINER_NAME)?.env;
  const numberIn = (name: string): number => {
    const value = env?.find((e) => e.name === name)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  return workerLimitsOf({
    maxTurnSeconds: numberIn(ENV.maxTurnSeconds),
    providerMaxRetries: numberIn(ENV.providerMaxRetries),
  });
}

/** The Secret a Pod's env reads its nonce from, by name. */
export function nonceSecretNameOf(pod: {
  spec: {
    containers: Array<{
      env?: Array<{
        name: string;
        valueFrom?: { secretKeyRef?: { name: string } };
      }>;
    }>;
  };
}): string | null {
  for (const container of pod.spec.containers) {
    for (const entry of container.env ?? []) {
      if (entry.name === ENV.bootstrapNonce) {
        return entry.valueFrom?.secretKeyRef?.name ?? null;
      }
    }
  }
  return null;
}
