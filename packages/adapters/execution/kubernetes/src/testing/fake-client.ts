/**
 * An in-memory API server for unit tests: names, UIDs, label selectors and
 * the delete precondition behave as the real one's do; nothing schedules,
 * so a Pod's phase is whatever a test sets.
 */
import {
  type Kind,
  KubernetesApiError,
  type KubernetesClient,
  KubernetesTimeoutError,
} from "../client.ts";

type Stored = { metadata: Record<string, unknown> & { name: string } } & Record<
  string,
  unknown
>;

export type FakeCall = {
  verb: string;
  kind: Kind;
  name?: string;
  body?: unknown;
};

export class FakeKubernetes {
  readonly objects = new Map<string, Stored>();
  readonly calls: FakeCall[] = [];
  /** Throws instead of answering the next matching call, once. */
  readonly failures: Array<{ verb: string; kind: Kind; error: Error }> = [];

  asClient(): KubernetesClient {
    return this as unknown as KubernetesClient;
  }

  private key(namespace: string, kind: Kind, name: string): string {
    return `${namespace}/${kind}/${name}`;
  }

  private fail(verb: string, kind: Kind): void {
    const index = this.failures.findIndex(
      (f) => f.verb === verb && f.kind === kind,
    );
    if (index === -1) return;
    const [failure] = this.failures.splice(index, 1);
    if (failure) throw failure.error;
  }

  async get(namespace: string, kind: Kind, name: string) {
    this.calls.push({ kind, name, verb: "get" });
    this.fail("get", kind);
    return structuredClone(
      this.objects.get(this.key(namespace, kind, name)) ?? null,
    );
  }

  async list(namespace: string, kind: Kind, selector?: Record<string, string>) {
    this.calls.push({ kind, verb: "list" });
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(`${namespace}/${kind}/`))
      .map(([, object]) => object)
      .filter((object) =>
        Object.entries(selector ?? {}).every(
          ([k, v]) =>
            (object.metadata.labels as Record<string, string> | undefined)?.[
              k
            ] === v,
        ),
      )
      .map((object) => structuredClone(object));
  }

  async create(namespace: string, kind: Kind, body: Stored) {
    this.calls.push({ body, kind, name: body.metadata.name, verb: "create" });
    this.fail("create", kind);
    const key = this.key(namespace, kind, body.metadata.name);
    if (this.objects.has(key)) {
      throw new KubernetesApiError(409, "POST", key, "AlreadyExists");
    }
    const stored = structuredClone(body);
    stored.metadata.uid = crypto.randomUUID();
    stored.metadata.creationTimestamp = new Date(
      Date.now() - 1_000,
    ).toISOString();
    if (kind === "pods") stored.status = { phase: "Pending" };
    this.objects.set(key, stored);
    return structuredClone(stored);
  }

  async delete(
    namespace: string,
    kind: Kind,
    name: string,
    options: { uid: string; gracePeriodSeconds?: number },
  ) {
    this.calls.push({ body: options, kind, name, verb: "delete" });
    this.fail("delete", kind);
    const key = this.key(namespace, kind, name);
    const existing = this.objects.get(key);
    if (existing === undefined) return null;
    if (existing.metadata.uid !== options.uid) {
      throw new KubernetesApiError(
        409,
        "DELETE",
        key,
        "Precondition failed: UID",
      );
    }
    this.objects.delete(key);
    // Owned objects go with their owner, as the garbage collector does.
    for (const [other, object] of this.objects) {
      const owners = object.metadata.ownerReferences as
        | Array<{ uid: string }>
        | undefined;
      if (owners?.some((o) => o.uid === options.uid))
        this.objects.delete(other);
    }
    return {};
  }

  /** Each Pod's whole log by name; `podLog` answers its tail. */
  readonly logs = new Map<string, string>();

  async podLog(
    namespace: string,
    name: string,
    options: { container: string; tailLines: number; limitBytes: number },
  ) {
    this.calls.push({ body: options, kind: "pods", name, verb: "log" });
    this.fail("log", "pods");
    if (!this.objects.has(this.key(namespace, "pods", name))) return null;
    const lines = (this.logs.get(name) ?? "").split(/(?<=\n)/);
    return lines
      .slice(-options.tailLines)
      .join("")
      .slice(0, options.limitBytes);
  }

  /** Sets a stored Pod's phase, as the kubelet would. */
  setPhase(
    namespace: string,
    name: string,
    phase: string,
    status: Record<string, unknown> = {},
  ): void {
    const pod = this.objects.get(this.key(namespace, "pods", name));
    if (pod === undefined) throw new Error(`no pod ${name}`);
    pod.status = { ...status, phase };
  }

  /** Moves an object's creation back by `ms`. */
  age(namespace: string, kind: Kind, name: string, ms: number): void {
    const object = this.objects.get(this.key(namespace, kind, name));
    if (object === undefined) throw new Error(`no ${kind} ${name}`);
    object.metadata.creationTimestamp = new Date(Date.now() - ms).toISOString();
  }

  /** Replaces whatever is under the name with a copy that has another UID. */
  replace(namespace: string, kind: Kind, name: string): string {
    const object = this.objects.get(this.key(namespace, kind, name));
    if (object === undefined) throw new Error(`no ${kind} ${name}`);
    const uid = crypto.randomUUID();
    object.metadata.uid = uid;
    return uid;
  }

  removeRaw(namespace: string, kind: Kind, name: string): void {
    this.objects.delete(this.key(namespace, kind, name));
  }

  timeoutNext(verb: string, kind: Kind): void {
    this.failures.push({
      error: new KubernetesTimeoutError(verb, kind, 1),
      kind,
      verb,
    });
  }
}
