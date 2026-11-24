/**
 * The slice of the Kubernetes API this backend uses, spoken directly with
 * Bun's `fetch`. No client library: nothing in the lockfile speaks to the
 * API server, the surface is a dozen core/v1 calls, and the request bodies
 * stay the audit trail for what a worker Pod gets.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export type KubernetesConnection = {
  /** `https://host:port`, no trailing slash. */
  server: string;
  ca?: string;
  cert?: string;
  key?: string;
  /** Read per request: a projected ServiceAccount token is rotated on disk. */
  token?: () => Promise<string>;
};

export type FetchLike = (
  url: string,
  init: RequestInit & {
    tls?: { ca?: string; cert?: string; key?: string };
  },
) => Promise<Response>;

/** The API server did not answer within the deadline. */
export class KubernetesTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Kubernetes API ${method} ${path} did not answer within ${timeoutMs}ms`,
    );
    this.name = "KubernetesTimeoutError";
  }
}

export class KubernetesApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Kubernetes API ${method} ${path} failed with ${status}: ${body}`);
    this.name = "KubernetesApiError";
  }
}

export type ObjectMeta = {
  name: string;
  namespace?: string;
  uid?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  ownerReferences?: Array<{
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
  }>;
};

export type Pod = {
  metadata: ObjectMeta;
  spec: {
    containers: Array<{
      name: string;
      env?: Array<{
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef?: { name: string; key: string } };
      }>;
    }>;
    volumes?: Array<{
      name: string;
      persistentVolumeClaim?: { claimName: string };
    }>;
    nodeName?: string;
  };
  status?: {
    phase?: string;
    /** Pod-level cause, such as `Evicted`. */
    reason?: string;
    conditions?: Array<{
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }>;
    containerStatuses?: Array<{
      name?: string;
      state?: {
        terminated?: { exitCode: number; reason?: string };
        waiting?: { reason?: string; message?: string };
      };
    }>;
  };
};

export type Secret = { metadata: ObjectMeta };

export type PersistentVolumeClaim = {
  metadata: ObjectMeta;
  status?: { capacity?: { storage?: string } };
  spec: {
    resources?: { requests?: { storage?: string } };
    storageClassName?: string;
  };
};

/** The fields of a Node the scheduler's optional capacity check reads. */
export type Node = {
  metadata: ObjectMeta;
  spec?: {
    unschedulable?: boolean;
    taints?: Array<{ key: string; value?: string; effect: string }>;
  };
  status?: { allocatable?: { memory?: string } };
};

export type Kind = "pods" | "secrets" | "persistentvolumeclaims";

type ObjectOf<K extends Kind> = K extends "pods"
  ? Pod
  : K extends "secrets"
    ? Secret
    : PersistentVolumeClaim;

export class KubernetesClient {
  constructor(
    private readonly connection: KubernetesConnection,
    private readonly options: { timeoutMs: number; fetch?: FetchLike },
  ) {}

  async get<K extends Kind>(
    namespace: string,
    kind: K,
    name: string,
  ): Promise<ObjectOf<K> | null> {
    return this.request("GET", objectPath(namespace, kind, name), {
      absent: true,
    });
  }

  async list<K extends Kind>(
    namespace: string,
    kind: K,
    labelSelector?: Record<string, string>,
  ): Promise<ObjectOf<K>[]> {
    const query =
      labelSelector === undefined
        ? ""
        : `?labelSelector=${encodeURIComponent(
            Object.entries(labelSelector)
              .map(([key, value]) => `${key}=${value}`)
              .join(","),
          )}`;
    const list = await this.request<{ items: ObjectOf<K>[] }>(
      "GET",
      `${collectionPath(namespace, kind)}${query}`,
    );
    return list?.items ?? [];
  }

  async create<K extends Kind>(
    namespace: string,
    kind: K,
    body: unknown,
  ): Promise<ObjectOf<K>> {
    const created = await this.request<ObjectOf<K>>(
      "POST",
      collectionPath(namespace, kind),
      { body },
    );
    if (created === null) throw new Error(`Create of ${kind} returned nothing`);
    return created;
  }

  /** Cluster-scoped: needs a ClusterRole the chart grants only on request. */
  async listNodes(labelSelector: Record<string, string>): Promise<Node[]> {
    const selector = Object.entries(labelSelector)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
    const list = await this.request<{ items: Node[] }>(
      "GET",
      selector === ""
        ? "/api/v1/nodes"
        : `/api/v1/nodes?labelSelector=${encodeURIComponent(selector)}`,
    );
    return list?.items ?? [];
  }

  /**
   * Deletes the object only while it is still the one with `uid`: a name
   * that has come to mean a replacement answers 409 and is left alone.
   * Null when nothing is under the name.
   */
  async delete(
    namespace: string,
    kind: Kind,
    name: string,
    options: { uid: string; gracePeriodSeconds?: number },
  ): Promise<unknown | null> {
    return this.request("DELETE", objectPath(namespace, kind, name), {
      absent: true,
      body: {
        apiVersion: "v1",
        kind: "DeleteOptions",
        ...(options.gracePeriodSeconds === undefined
          ? {}
          : { gracePeriodSeconds: options.gracePeriodSeconds }),
        preconditions: { uid: options.uid },
        // Dependents (the Pod's nonce Secret) go with it, in the background.
        propagationPolicy: "Background",
      },
    });
  }

  /**
   * The last `tailLines` lines of one container's log, cut by the server at
   * `limitBytes`. Null when the Pod is gone.
   */
  async podLog(
    namespace: string,
    name: string,
    options: { container: string; tailLines: number; limitBytes: number },
  ): Promise<string | null> {
    const query = new URLSearchParams({
      container: options.container,
      limitBytes: String(options.limitBytes),
      tailLines: String(options.tailLines),
    });
    // Asked for as JSON like every other call: the API server answers
    // `text/plain` with 406, and sends the log as raw text either way.
    return this.exchange(
      "GET",
      `${objectPath(namespace, "pods", name)}/log?${query}`,
      { absent: true },
    );
  }

  /** Any path, for what the typed calls above do not cover (tests). */
  async request<T>(
    method: string,
    path: string,
    options: { absent?: boolean; body?: unknown } = {},
  ): Promise<T | null> {
    const text = await this.exchange(method, path, options);
    return text === null || text === "" ? null : (JSON.parse(text) as T);
  }

  private async exchange(
    method: string,
    path: string,
    { absent = false, body }: { absent?: boolean; body?: unknown },
  ): Promise<string | null> {
    const connection = this.connection;
    const options = this.options;
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (connection.token) {
      headers.authorization = `Bearer ${await connection.token()}`;
    }
    const tls = {
      ...(connection.ca === undefined ? {} : { ca: connection.ca }),
      ...(connection.cert === undefined ? {} : { cert: connection.cert }),
      ...(connection.key === undefined ? {} : { key: connection.key }),
    };
    let response: Response;
    let text: string;
    try {
      response = await (options.fetch ?? (fetch as FetchLike))(
        `${connection.server}${path}`,
        {
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers,
          method,
          signal: AbortSignal.timeout(options.timeoutMs),
          tls,
        },
      );
      text = await response.text();
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new KubernetesTimeoutError(method, path, options.timeoutMs);
      }
      throw error;
    }
    if (absent && response.status === 404) return null;
    if (!response.ok) {
      throw new KubernetesApiError(
        response.status,
        method,
        path,
        statusMessage(text),
      );
    }
    return text;
  }
}

function collectionPath(namespace: string, kind: Kind): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/${kind}`;
}

function objectPath(namespace: string, kind: Kind, name: string): string {
  return `${collectionPath(namespace, kind)}/${encodeURIComponent(name)}`;
}

/** A `Status` reply's message, or the raw body when it is not one. */
function statusMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {}
  return text.slice(0, 2_000);
}

/**
 * `KUBECONFIG` when set (tests, local runs), otherwise the Pod's own
 * ServiceAccount — how the scheduler reaches the API server in a cluster.
 */
export async function kubernetesConnectionFromEnv(environment: {
  [key: string]: string | undefined;
}): Promise<KubernetesConnection> {
  const kubeconfig = environment.KUBECONFIG?.trim();
  if (kubeconfig) {
    // Like kubectl, the first file of a list holds the current context.
    const [first = ""] = kubeconfig.split(":");
    return connectionFromKubeconfig(first);
  }
  const host = environment.KUBERNETES_SERVICE_HOST;
  const port = environment.KUBERNETES_SERVICE_PORT;
  if (!host || !port) {
    throw new Error(
      "Neither KUBECONFIG nor an in-cluster ServiceAccount (KUBERNETES_SERVICE_HOST) is available",
    );
  }
  const tokenFile = `${SERVICE_ACCOUNT_DIR}/token`;
  return {
    ca: await readFile(`${SERVICE_ACCOUNT_DIR}/ca.crt`, "utf8"),
    server: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
    token: async () => (await readFile(tokenFile, "utf8")).trim(),
  };
}

type Kubeconfig = {
  "current-context"?: string;
  contexts?: Array<{
    name: string;
    context: { cluster: string; user: string };
  }>;
  clusters?: Array<{ name: string; cluster: Record<string, unknown> }>;
  users?: Array<{ name: string; user: Record<string, unknown> }>;
};

/**
 * The current context's server, CA and credential. Only what a kubeconfig
 * can hold inline or by file: an `exec` plugin (e.g. `aws eks get-token`)
 * is refused rather than run, since the scheduler authenticates in-cluster.
 */
export async function connectionFromKubeconfig(
  path: string,
): Promise<KubernetesConnection> {
  const config = Bun.YAML.parse(await readFile(path, "utf8")) as Kubeconfig;
  const base = dirname(path);
  const contextName = config["current-context"];
  const context = config.contexts?.find((c) => c.name === contextName)?.context;
  if (context === undefined) {
    throw new Error(`Kubeconfig ${path} has no current context`);
  }
  const cluster = config.clusters?.find(
    (c) => c.name === context.cluster,
  )?.cluster;
  const user = config.users?.find((u) => u.name === context.user)?.user ?? {};
  if (cluster === undefined || typeof cluster.server !== "string") {
    throw new Error(`Kubeconfig ${path} names no server for ${contextName}`);
  }
  if (cluster["insecure-skip-tls-verify"] === true) {
    throw new Error(
      `Kubeconfig ${path} skips TLS verification for ${contextName}; refused`,
    );
  }
  if (user.exec !== undefined || user["auth-provider"] !== undefined) {
    throw new Error(
      `Kubeconfig ${path} authenticates ${contextName} through a plugin, which this client does not run; use a token, a client certificate or the in-cluster ServiceAccount`,
    );
  }
  const material = async (field: string, from: Record<string, unknown>) => {
    const inline = from[`${field}-data`];
    if (typeof inline === "string") {
      return Buffer.from(inline, "base64").toString("utf8");
    }
    const file = from[field];
    if (typeof file === "string") return readFile(resolve(base, file), "utf8");
    return undefined;
  };
  const ca = await material("certificate-authority", cluster);
  const cert = await material("client-certificate", user);
  const key = await material("client-key", user);
  const token =
    typeof user.token === "string"
      ? user.token
      : typeof user.tokenFile === "string"
        ? (await readFile(resolve(base, user.tokenFile), "utf8")).trim()
        : undefined;
  return {
    server: cluster.server.replace(/\/$/, ""),
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(token === undefined ? {} : { token: async () => token }),
  };
}
