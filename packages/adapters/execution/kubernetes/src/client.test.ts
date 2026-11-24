import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionFromKubeconfig,
  type FetchLike,
  KubernetesApiError,
  KubernetesClient,
  KubernetesTimeoutError,
} from "./client.ts";

const dir = await mkdtemp(join(tmpdir(), "kubeconfig-"));
afterAll(() => rm(dir, { force: true, recursive: true }));

async function kubeconfig(user: string, cluster = ""): Promise<string> {
  const path = join(dir, `${crypto.randomUUID()}.yaml`);
  await writeFile(
    path,
    `apiVersion: v1
kind: Config
current-context: kind
contexts:
- name: kind
  context: { cluster: kind, user: kind }
clusters:
- name: kind
  cluster:
    server: https://127.0.0.1:6443/
    certificate-authority-data: ${Buffer.from("CA").toString("base64")}
${cluster}
users:
- name: kind
  user:
${user}
`,
  );
  return path;
}

describe("connectionFromKubeconfig", () => {
  test("reads the current context's server, CA and client certificate", async () => {
    const path = await kubeconfig(
      `    client-certificate-data: ${Buffer.from("CERT").toString("base64")}
    client-key-data: ${Buffer.from("KEY").toString("base64")}`,
    );
    expect(await connectionFromKubeconfig(path)).toEqual({
      ca: "CA",
      cert: "CERT",
      key: "KEY",
      server: "https://127.0.0.1:6443",
    });
  });

  test("refuses an exec plugin rather than running it", async () => {
    const path = await kubeconfig("    exec: { command: aws }");
    await expect(connectionFromKubeconfig(path)).rejects.toThrow(
      "through a plugin",
    );
  });

  test("refuses a context that skips TLS verification", async () => {
    const path = await kubeconfig(
      "    token: t",
      "    insecure-skip-tls-verify: true",
    );
    await expect(connectionFromKubeconfig(path)).rejects.toThrow(
      "skips TLS verification",
    );
  });
});

describe("KubernetesClient", () => {
  function recording(status: number, body = "{}") {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch: FetchLike = async (url, init) => {
      requests.push({ init, url });
      return new Response(body, { status });
    };
    const client = new KubernetesClient(
      { server: "https://k8s", token: async () => "token" },
      { fetch, timeoutMs: 1_000 },
    );
    return { client, requests };
  }

  test("a delete carries the UID as a precondition", async () => {
    const { client, requests } = recording(200);
    await client.delete("ns", "pods", "ap-worker-x-g1", {
      gracePeriodSeconds: 30,
      uid: "uid-1",
    });
    const [request] = requests;
    expect(request?.url).toBe(
      "https://k8s/api/v1/namespaces/ns/pods/ap-worker-x-g1",
    );
    expect(request?.init.method).toBe("DELETE");
    expect(JSON.parse(String(request?.init.body))).toEqual({
      apiVersion: "v1",
      gracePeriodSeconds: 30,
      kind: "DeleteOptions",
      preconditions: { uid: "uid-1" },
      propagationPolicy: "Background",
    });
    expect(
      (request?.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer token");
  });

  test("a refused precondition is a 409 with the server's message", async () => {
    const { client } = recording(
      409,
      JSON.stringify({ message: "Precondition failed: UID in precondition" }),
    );
    const refused = await client
      .delete("ns", "pods", "p", { uid: "old" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(KubernetesApiError);
    expect((refused as KubernetesApiError).status).toBe(409);
    expect((refused as Error).message).toContain("Precondition failed");
  });

  test("404 reads as absent; a list selects by label", async () => {
    const { client, requests } = recording(404);
    expect(await client.get("ns", "pods", "nope")).toBeNull();
    const listing = recording(200, JSON.stringify({ items: [] }));
    await listing.client.list("ns", "secrets", { a: "1", b: "2" });
    expect(listing.requests[0]?.url).toBe(
      "https://k8s/api/v1/namespaces/ns/secrets?labelSelector=a%3D1%2Cb%3D2",
    );
    expect(requests).toHaveLength(1);
  });

  test("a log is read as text with its bounds; a gone Pod has none", async () => {
    const { client, requests } = recording(200, "line 1\nline 2\n");
    expect(
      await client.podLog("ns", "ap-worker-x-g1", {
        container: "worker",
        limitBytes: 65_536,
        tailLines: 200,
      }),
    ).toBe("line 1\nline 2\n");
    expect(requests[0]?.url).toBe(
      "https://k8s/api/v1/namespaces/ns/pods/ap-worker-x-g1/log?container=worker&limitBytes=65536&tailLines=200",
    );
    // A real API server refuses `text/plain` here with 406.
    expect((requests[0]?.init.headers as Record<string, string>).accept).toBe(
      "application/json",
    );
    const gone = recording(404);
    expect(
      await gone.client.podLog("ns", "p", {
        container: "worker",
        limitBytes: 1,
        tailLines: 1,
      }),
    ).toBeNull();
  });

  test("nodes are listed cluster-wide, by label when one is given", async () => {
    const all = recording(
      200,
      JSON.stringify({ items: [{ metadata: { name: "n1" } }] }),
    );
    expect(await all.client.listNodes({})).toEqual([
      { metadata: { name: "n1" } },
    ]);
    expect(all.requests[0]?.url).toBe("https://k8s/api/v1/nodes");
    const pool = recording(200, JSON.stringify({ items: [] }));
    await pool.client.listNodes({ pool: "agents" });
    expect(pool.requests[0]?.url).toBe(
      "https://k8s/api/v1/nodes?labelSelector=pool%3Dagents",
    );
  });

  test("no answer within the deadline is a timeout, not a refusal", async () => {
    const client = new KubernetesClient(
      { server: "https://k8s" },
      {
        fetch: (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            ),
          ),
        timeoutMs: 10,
      },
    );
    await expect(client.get("ns", "pods", "p")).rejects.toBeInstanceOf(
      KubernetesTimeoutError,
    );
  });
});
