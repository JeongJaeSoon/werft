import {
  KubernetesClient,
  kubernetesConnectionFromEnv,
  type Node,
  type Toleration,
} from "@werft-ai/execution-kubernetes";
import { messageOf } from "@werft-ai/platform";
import type { PassLoopLogger } from "../pass-loop/loop.ts";
import type { SchedulerExecution } from "./config.ts";

/**
 * Set to `true` by the chart's scheduler.nodeCapacityCheck.enabled, which
 * also grants the ClusterRole that reads Nodes. Off by default: without the
 * role there is nothing to read, and a namespace-only installer cannot make it.
 */
export const NODE_CAPACITY_CHECK_ENV = "SCHEDULER_NODE_CAPACITY_CHECK";

/** Fewer than this many workers on a node is worth a warning at startup. */
export const MIN_WORKERS_PER_NODE = 2;

export function nodeCapacityCheckFromEnv(environment: {
  [key: string]: string | undefined;
}): boolean {
  const value = environment[NODE_CAPACITY_CHECK_ENV];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${NODE_CAPACITY_CHECK_ENV} must be true or false`);
}

/**
 * The loop's startup check, or undefined when it is off or the backend is
 * not Kubernetes.
 */
export function nodeCapacityCheckFor(
  environment: { [key: string]: string | undefined },
  execution: SchedulerExecution,
  resources: { memoryBytes: number },
):
  | ((logger: Pick<PassLoopLogger, "info" | "warn">) => Promise<void>)
  | undefined {
  if (!nodeCapacityCheckFromEnv(environment)) return undefined;
  if (execution.backend !== "kubernetes") return undefined;
  const { kubernetes } = execution;
  return (logger) =>
    checkNodeCapacity({
      listNodes: async (selector) =>
        new KubernetesClient(await kubernetesConnectionFromEnv(environment), {
          timeoutMs: kubernetes.requestTimeoutMs,
        }).listNodes(selector),
      logger,
      nodeSelector: kubernetes.nodeSelector,
      tolerations: kubernetes.tolerations,
      workerMemoryBytes: resources.memoryBytes,
    });
}

const BINARY: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};
const DECIMAL: Record<string, number> = {
  "": 1,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

/** A Kubernetes memory quantity in bytes; null when it is not one. */
export function quantityBytes(quantity: string): number | null {
  const match =
    /^(\d+(?:\.\d+)?)(?:[eE](\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|[mkMGTPE])?)$/.exec(
      quantity.trim(),
    );
  if (match === null) return null;
  const [, number = "", exponent, suffix = ""] = match;
  const scale =
    exponent === undefined
      ? (BINARY[suffix] ?? DECIMAL[suffix] ?? 1)
      : 10 ** Number(exponent);
  return Math.floor(Number(number) * scale);
}

type Taint = NonNullable<NonNullable<Node["spec"]>["taints"]>[number];

/** The kube-scheduler's rule, for the taints that keep a Pod off a node. */
function tolerates(tolerations: Toleration[], taint: Taint): boolean {
  return tolerations.some((toleration) => {
    const { key, operator, value, effect } = toleration as {
      key?: string;
      operator?: string;
      value?: string;
      effect?: string;
    };
    if (effect && effect !== taint.effect) return false;
    if (operator === "Exists") return !key || key === taint.key;
    return key === taint.key && (value ?? "") === (taint.value ?? "");
  });
}

function takesWorkers(node: Node, tolerations: Toleration[]): boolean {
  if (node.spec?.unschedulable) return false;
  return (node.spec?.taints ?? []).every(
    (taint) =>
      (taint.effect !== "NoSchedule" && taint.effect !== "NoExecute") ||
      tolerates(tolerations, taint),
  );
}

/**
 * Once at scheduler startup: warns for each node worker Pods may land on
 * whose allocatable memory holds fewer than two workers, since worker
 * requests equal limits and a third session there waits for room. Only
 * advice: a read that fails is logged and skipped, and nothing stops.
 */
export async function checkNodeCapacity(input: {
  listNodes: (selector: Record<string, string>) => Promise<Node[]>;
  nodeSelector: Record<string, string>;
  tolerations: Toleration[];
  workerMemoryBytes: number;
  logger: Pick<PassLoopLogger, "info" | "warn">;
}): Promise<void> {
  const { logger } = input;
  const workerMemoryMb = Math.round(input.workerMemoryBytes / 2 ** 20);
  let nodes: Node[];
  try {
    nodes = await input.listNodes(input.nodeSelector);
  } catch (error) {
    logger.warn("Node capacity check skipped: the nodes could not be read", {
      error: messageOf(error),
    });
    return;
  }
  const eligible = nodes.filter((node) =>
    takesWorkers(node, input.tolerations),
  );
  if (eligible.length === 0) {
    logger.warn(
      "Node capacity check found no schedulable node for worker Pods (worker.nodeSelector, worker.tolerations); sessions wait for room until one joins",
      { node_selector: input.nodeSelector, nodes_listed: nodes.length },
    );
    return;
  }
  const counted = eligible.map((node) => {
    const allocatable = node.status?.allocatable?.memory;
    const bytes = allocatable === undefined ? null : quantityBytes(allocatable);
    return {
      node: node.metadata.name,
      allocatable,
      bytes,
      workers:
        bytes === null ? null : Math.floor(bytes / input.workerMemoryBytes),
    };
  });
  for (const { node, allocatable } of counted.filter((c) => c.bytes === null)) {
    logger.warn(
      "Node capacity check skipped a node: its allocatable memory is not a quantity",
      { node, allocatable: allocatable ?? null },
    );
  }
  const small = counted.filter(
    (c) => c.workers !== null && c.workers < MIN_WORKERS_PER_NODE,
  );
  for (const { node, bytes, workers } of small) {
    logger.warn(
      `Node holds fewer than ${MIN_WORKERS_PER_NODE} workers: worker Pods request their whole memory limit (worker.memoryMb), so further sessions on it wait for room; lower worker.memoryMb or add a larger node`,
      {
        node,
        allocatable_mib: Math.floor((bytes ?? 0) / 2 ** 20),
        worker_memory_mb: workerMemoryMb,
        workers_fit: workers,
      },
    );
  }
  logger.info("Node capacity check done", {
    worker_memory_mb: workerMemoryMb,
    nodes: counted.map(({ node, workers }) => ({ node, workers_fit: workers })),
  });
}
