import { expect, test } from "bun:test";
import { KubernetesApiError } from "./client.ts";
import { workerEnvironmentFor } from "./specs.ts";
import { FakeKubernetes } from "./testing/fake-client.ts";
import { testConfig } from "./testing/index.ts";
import { storageBytes, workspaceCapacity } from "./workspace-capacity.ts";

test("PVC capacity is read from status, never inferred from its request", async () => {
  const api = new FakeKubernetes();
  await api.create("agents", "persistentvolumeclaims", {
    metadata: { name: "workspace" },
    spec: { resources: { requests: { storage: "8Gi" } } },
    status: { capacity: { storage: "4Gi" } },
  });
  const bytes = await workspaceCapacity(api.asClient(), "agents", "workspace");
  expect(bytes).toBe(4 * 1024 ** 3);
  const environment = workerEnvironmentFor(
    testConfig("agents", "test"),
    {
      executionId: "exec",
      generation: 1,
      sessionId: "session",
    },
    "bootstrap",
    bytes,
  );
  expect(environment).toContainEqual({
    name: "WORKER_WORKSPACE_PVC_CAPACITY_BYTES",
    value: String(bytes),
  });
  expect(api.calls.at(-1)).toEqual({
    verb: "get",
    kind: "persistentvolumeclaims",
    name: "workspace",
  });
});

test("missing Role, missing claim and pending capacity omit evidence", async () => {
  const api = new FakeKubernetes();
  api.failures.push({
    verb: "get",
    kind: "persistentvolumeclaims",
    error: new KubernetesApiError(403, "GET", "claim", "Forbidden"),
  });
  expect(
    await workspaceCapacity(api.asClient(), "agents", "workspace"),
  ).toBeUndefined();
  expect(
    await workspaceCapacity(api.asClient(), "agents", "workspace"),
  ).toBeUndefined();
  await api.create("agents", "persistentvolumeclaims", {
    metadata: { name: "workspace" },
    spec: { resources: { requests: { storage: "4Gi" } } },
  });
  expect(
    await workspaceCapacity(api.asClient(), "agents", "workspace"),
  ).toBeUndefined();
  const environment = workerEnvironmentFor(
    testConfig("agents", "test"),
    { executionId: "exec", generation: 1, sessionId: "session" },
    "bootstrap",
  );
  expect(
    environment.some(
      ({ name }) => name === "WORKER_WORKSPACE_PVC_CAPACITY_BYTES",
    ),
  ).toBe(false);
});

test("unavailable API is not silently reported as missing permission", async () => {
  const api = new FakeKubernetes();
  api.failures.push({
    verb: "get",
    kind: "persistentvolumeclaims",
    error: new KubernetesApiError(500, "GET", "claim", "Failed"),
  });
  await expect(
    workspaceCapacity(api.asClient(), "agents", "workspace"),
  ).rejects.toThrow();
});

test("capacity quantities reject unsupported, zero and unsafe values", () => {
  expect(storageBytes("4096Mi")).toBe(4 * 1024 ** 3);
  expect(storageBytes("1.5Gi")).toBe(1.5 * 1024 ** 3);
  expect(storageBytes("4G")).toBe(4e9);
  for (const value of [undefined, "", "0", "-1Gi", "unlimited", "1Ei"])
    expect(storageBytes(value)).toBeUndefined();
});
