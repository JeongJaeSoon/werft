import { describe, expect, test } from "bun:test";
import type { Node } from "@werft-ai/execution-kubernetes";
import {
  checkNodeCapacity,
  nodeCapacityCheckFromEnv,
  quantityBytes,
} from "./node-capacity.ts";

const MiB = 2 ** 20;

function node(name: string, memory: string, spec: Node["spec"] = {}): Node {
  return { metadata: { name }, spec, status: { allocatable: { memory } } };
}

async function run(
  nodes: Node[] | Error,
  options: { tolerations?: Record<string, unknown>[]; memoryMb?: number } = {},
) {
  const lines: Array<{ level: string; message: string; fields: unknown }> = [];
  const selectors: unknown[] = [];
  await checkNodeCapacity({
    listNodes: async (selector) => {
      selectors.push(selector);
      if (nodes instanceof Error) throw nodes;
      return nodes;
    },
    logger: {
      info: (message, fields) => lines.push({ level: "info", message, fields }),
      warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    },
    nodeSelector: { pool: "agents" },
    tolerations: options.tolerations ?? [],
    workerMemoryBytes: (options.memoryMb ?? 4608) * MiB,
  });
  return {
    lines,
    selectors,
    warnings: lines.filter((l) => l.level === "warn"),
  };
}

describe("node capacity check", () => {
  test("is off unless the chart turns it on", () => {
    expect(nodeCapacityCheckFromEnv({})).toBe(false);
    expect(
      nodeCapacityCheckFromEnv({ SCHEDULER_NODE_CAPACITY_CHECK: "false" }),
    ).toBe(false);
    expect(
      nodeCapacityCheckFromEnv({ SCHEDULER_NODE_CAPACITY_CHECK: "true" }),
    ).toBe(true);
    expect(() =>
      nodeCapacityCheckFromEnv({ SCHEDULER_NODE_CAPACITY_CHECK: "yes" }),
    ).toThrow("SCHEDULER_NODE_CAPACITY_CHECK");
  });

  test("reads Kubernetes memory quantities", () => {
    expect(quantityBytes("16422380Ki")).toBe(16422380 * 1024);
    expect(quantityBytes("8Gi")).toBe(8 * 2 ** 30);
    expect(quantityBytes("1.5Gi")).toBe(1.5 * 2 ** 30);
    expect(quantityBytes("16G")).toBe(16e9);
    expect(quantityBytes("123456789")).toBe(123456789);
    expect(quantityBytes("1e9")).toBe(1e9);
    expect(quantityBytes("lots")).toBeNull();
  });

  test("warns for a node that holds fewer than two workers, on worker.nodeSelector", async () => {
    // The fresh-install k3s node: 16 GiB allocatable holds 3 of 4608 MiB.
    const { selectors, warnings, lines } = await run([
      node("big", "16422380Ki"),
      node("small", "8Gi"),
    ]);
    expect(selectors).toEqual([{ pool: "agents" }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("fewer than 2 workers");
    expect(warnings[0]?.fields).toEqual({
      allocatable_mib: 8192,
      node: "small",
      worker_memory_mb: 4608,
      workers_fit: 1,
    });
    expect(lines.at(-1)).toMatchObject({
      level: "info",
      fields: {
        nodes: [
          { node: "big", workers_fit: 3 },
          { node: "small", workers_fit: 1 },
        ],
      },
    });
  });

  test("a smaller worker.memoryMb clears the warning", async () => {
    const { warnings } = await run([node("small", "8Gi")], { memoryMb: 2048 });
    expect(warnings).toEqual([]);
  });

  test("leaves out nodes worker Pods cannot land on", async () => {
    const tainted = node("control-plane", "2Gi", {
      taints: [
        { key: "node-role.kubernetes.io/control-plane", effect: "NoSchedule" },
      ],
    });
    const cordoned = node("cordoned", "2Gi", { unschedulable: true });
    const preferred = node("preferred", "2Gi", {
      taints: [{ key: "spot", effect: "PreferNoSchedule" }],
    });
    const { warnings } = await run([
      node("worker", "32Gi"),
      tainted,
      cordoned,
      preferred,
    ]);
    expect(warnings.map((w) => (w.fields as { node: string }).node)).toEqual([
      "preferred",
    ]);
    const tolerated = await run([tainted], {
      tolerations: [
        { key: "node-role.kubernetes.io/control-plane", operator: "Exists" },
      ],
    });
    expect(tolerated.warnings).toHaveLength(1);
    const byValue = await run(
      [
        node("pool", "2Gi", {
          taints: [{ key: "pool", value: "agents", effect: "NoExecute" }],
        }),
      ],
      { tolerations: [{ key: "pool", value: "other" }] },
    );
    expect(byValue.warnings[0]?.message).toContain("no schedulable node");
  });

  test("a failed read is logged and skipped, never thrown", async () => {
    const { lines } = await run(new Error("nodes is forbidden"));
    expect(lines).toEqual([
      {
        level: "warn",
        message: "Node capacity check skipped: the nodes could not be read",
        fields: { error: "nodes is forbidden" },
      },
    ]);
  });

  test("an unreadable allocatable is skipped by name", async () => {
    const { warnings } = await run([node("odd", "a lot")]);
    expect(warnings).toEqual([
      {
        level: "warn",
        message:
          "Node capacity check skipped a node: its allocatable memory is not a quantity",
        fields: { allocatable: "a lot", node: "odd" },
      },
    ]);
  });
});
