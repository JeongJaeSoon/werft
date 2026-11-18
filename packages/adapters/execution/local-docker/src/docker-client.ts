/**
 * The slice of the Docker Engine API this backend uses, spoken directly over
 * the daemon socket with Bun's `fetch`. No SDK: the surface is a handful of
 * calls and the request bodies are the audit trail for what a worker
 * container gets and what network it is allowed onto.
 */

export const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock";
export const DEFAULT_DOCKER_API_VERSION = "v1.44";

export type DockerEndpoint =
  | { kind: "unix"; socketPath: string }
  | { kind: "http"; baseUrl: string };

/** Accepts the `DOCKER_HOST` forms: `unix://`, `tcp://`, `http(s)://`. */
export function parseDockerHost(host: string): DockerEndpoint {
  if (host.startsWith("unix://")) {
    const socketPath = host.slice("unix://".length);
    if (socketPath.length === 0) {
      throw new Error(`DOCKER_HOST ${host} has no socket path`);
    }
    return { kind: "unix", socketPath };
  }
  if (host.startsWith("tcp://")) {
    return { kind: "http", baseUrl: `http://${host.slice("tcp://".length)}` };
  }
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return { kind: "http", baseUrl: host };
  }
  throw new Error(
    `DOCKER_HOST ${host} must start with unix://, tcp://, http:// or https://`,
  );
}

export const DEFAULT_DOCKER_REQUEST_TIMEOUT_MS = 30_000;

/** The daemon accepted the connection but did not answer within the deadline. */
export class DockerTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Docker API ${method} ${path} did not answer within ${timeoutMs}ms`);
    this.name = "DockerTimeoutError";
  }
}

export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Docker API ${method} ${path} failed with ${status}: ${body}`);
    this.name = "DockerApiError";
  }
}

export const PULL_ATTEMPTS = 3;

// The daemon reports a registry it could not reach as a 500. A stall shows up
// as the deadline passing before the answer, or while its stream drains.
function isTransientPullFailure(error: unknown): boolean {
  if (error instanceof DockerApiError) return error.status >= 500;
  if (error instanceof DockerTimeoutError) return true;
  return error instanceof Error && error.name === "TimeoutError";
}

export type ContainerCreateBody = {
  Cmd?: string[];
  /** Replaces the image's; the image's `Cmd` is then dropped as well. */
  Entrypoint?: string[];
  Env: string[];
  HostConfig: {
    CapAdd?: string[];
    CapDrop: string[];
    Memory: number;
    Mounts: Array<{
      ReadOnly?: boolean;
      Source: string;
      Target: string;
      Type: "volume" | "tmpfs";
      /**
       * Off by default in Docker: an empty volume mounted over a path the
       * image has files at gets those files copied in first.
       */
      VolumeOptions?: { NoCopy?: boolean };
    }>;
    NanoCpus: number;
    NetworkMode: string;
    PidsLimit: number;
    ReadonlyRootfs: boolean;
    RestartPolicy: { Name: "no" };
    SecurityOpt: string[];
    Tmpfs: Record<string, string>;
  };
  Image: string;
  Labels: Record<string, string>;
  User: string;
};

export type ContainerInspect = {
  Config: {
    Env: string[] | null;
    Labels: Record<string, string> | null;
    User: string;
  };
  HostConfig: Record<string, unknown>;
  Id: string;
  /** The id of the image it was created from, whatever name was asked for. */
  Image?: string;
  /**
   * What the container holds, as the daemon resolved it when the container
   * was created: a volume mount carries that volume's `Name`. Fixed for the
   * container's lifetime, and not the same question as which volume the
   * create asked for.
   */
  Mounts: Array<{ Destination: string; Name?: string; Type: string }>;
  Name: string;
  /**
   * Every network the container is attached to, keyed by name. `Aliases`
   * holds the names asked for at connect time (older daemons add the short
   * container id); a created, never-started container is listed too.
   */
  NetworkSettings?: {
    Networks?: Record<
      string,
      { Aliases?: string[] | null; IPAddress?: string; NetworkID?: string }
    > | null;
  };
  State: {
    ExitCode: number;
    OOMKilled?: boolean;
    Running: boolean;
    Status: string;
  };
};

export type NetworkInspect = {
  /** Running endpoints only: a created, never-started container is absent. */
  Containers: Record<string, { Name: string }> | null;
  /** RFC 3339. */
  Created?: string;
  Driver: string;
  EnableIPv6?: boolean;
  Id: string;
  /** The bridge address the host holds inside the network, when it has one. */
  IPAM?: { Config?: Array<{ Gateway?: string; Subnet?: string }> };
  Internal: boolean;
  Labels?: Record<string, string> | null;
  Name: string;
  /** Driver options as the daemon recorded them, known to it or not. */
  Options?: Record<string, string> | null;
};

export type NetworkCreateBody = {
  Driver?: string;
  EnableIPv6?: boolean;
  Internal: boolean;
  Labels?: Record<string, string>;
  Name: string;
  Options?: Record<string, string>;
};

export type ContainerSummary = {
  /** Unix seconds, by the daemon's clock. */
  Created?: number;
  Id: string;
  Labels: Record<string, string> | null;
  Names: string[];
  State: string;
};

export type ImageInspect = {
  Config: {
    /** Declared `VOLUME` paths, as a set with empty values. */
    Volumes?: Record<string, unknown> | null;
  };
  /** `sha256:…`; the only name for an image that cannot be repointed. */
  Id: string;
};

export type VolumeInspect = {
  /** RFC 3339; absent on daemons older than the field. */
  CreatedAt?: string;
  Driver: string;
  Labels: Record<string, string> | null;
  Mountpoint: string;
  Name: string;
  /** The driver options the volume was *created* with, not the ones asked for. */
  Options: Record<string, string> | null;
};

export type VolumeCreateBody = {
  Driver: string;
  DriverOpts?: Record<string, string>;
  Labels: Record<string, string>;
  Name: string;
};

/**
 * Splits an image reference the way `/images/create` wants it: registry
 * ports (`host:5000/x`) belong to the name, a digest (`@sha256:…`) or the
 * last `:` after the final `/` is the tag.
 */
export function parseImageReference(image: string): {
  name: string;
  tag: string;
} {
  const at = image.indexOf("@");
  if (at >= 0) {
    return { name: image.slice(0, at), tag: image.slice(at + 1) };
  }
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) {
    return { name: image.slice(0, colon), tag: image.slice(colon + 1) };
  }
  return { name: image, tag: "latest" };
}

export class DockerClient {
  private readonly endpoint: DockerEndpoint;
  private readonly prefix: string;
  private readonly timeoutMs: number;

  constructor(
    host: string = DEFAULT_DOCKER_HOST,
    apiVersion: string = DEFAULT_DOCKER_API_VERSION,
    options: { timeoutMs?: number } = {},
  ) {
    this.endpoint = parseDockerHost(host);
    this.prefix = `/${apiVersion.replace(/^\//, "")}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DOCKER_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Docker request timeout must be a positive number");
    }
  }

  async version(): Promise<{ ApiVersion: string; Version: string }> {
    return (await this.request("GET", "/version")).json();
  }

  /** 201 with the new id, or throws a `DockerApiError` (409 on a name clash). */
  async createContainer(
    name: string,
    body: ContainerCreateBody,
  ): Promise<{ Id: string }> {
    const response = await this.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    );
    return response.json();
  }

  /**
   * Pulls `image` if the daemon does not have it. The backend never calls
   * this (the worker image is provisioned out of band); tests do, so a fresh
   * daemon can run them. A registry that errors or stalls past the deadline
   * is asked again, up to PULL_ATTEMPTS times in all.
   */
  async pullImage(image: string): Promise<void> {
    const { name, tag } = parseImageReference(image);
    const path = `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.request("POST", path);
        // The pull streams progress JSON until it is done; drain it.
        await response.text();
        return;
      } catch (error) {
        if (attempt >= PULL_ATTEMPTS || !isTransientPullFailure(error)) {
          throw error;
        }
      }
    }
  }

  /** Idempotent: 304 (already started) is success. */
  async startContainer(idOrName: string): Promise<void> {
    await this.request(
      "POST",
      `/containers/${encodeURIComponent(idOrName)}/start`,
      undefined,
      [204, 304],
    );
  }

  /**
   * Blocks until the container is no longer running and answers its exit
   * status; a container that has already exited answers at once.
   */
  async waitContainer(idOrName: string, timeoutMs: number): Promise<number> {
    const response = await this.request(
      "POST",
      `/containers/${encodeURIComponent(idOrName)}/wait?condition=not-running`,
      undefined,
      [200],
      timeoutMs,
    );
    const { StatusCode } = (await response.json()) as { StatusCode: number };
    return StatusCode;
  }

  /**
   * The last `tail` lines a container without a TTY wrote to stdout and
   * stderr, read up to `limitBytes` of output; `cut` when there was more.
   * null when the container does not exist.
   */
  async containerLogs(
    idOrName: string,
    tail: number,
    limitBytes: number,
  ): Promise<{ output: Uint8Array; cut: boolean } | null> {
    const response = await this.request(
      "GET",
      `/containers/${encodeURIComponent(idOrName)}/logs?stdout=1&stderr=1&tail=${tail}`,
      undefined,
      [200, 404],
    );
    if (response.status === 404) return null;
    const reader = response.body?.getReader();
    const frames = new FrameReader();
    let cut = false;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      frames.push(value);
      // A frame still incomplete counts too: a header claiming a huge
      // payload must not buffer the whole response.
      if (frames.bufferedBytes > limitBytes) {
        cut = true;
        await reader.cancel();
        break;
      }
    }
    return { output: frames.payload().subarray(0, limitBytes), cut };
  }

  /** null when the container does not exist. */
  async inspectContainer(idOrName: string): Promise<ContainerInspect | null> {
    const response = await this.request(
      "GET",
      `/containers/${encodeURIComponent(idOrName)}/json`,
      undefined,
      [200, 404],
    );
    if (response.status === 404) return null;
    return response.json();
  }

  /**
   * The image as the daemon has it, or null when it is not pulled yet.
   * `Config.Volumes` is the interesting part: every path in it becomes a
   * writable anonymous volume on any container built from the image.
   */
  async inspectImage(name: string): Promise<ImageInspect | null> {
    const response = await this.request(
      "GET",
      `/images/${encodeURIComponent(name)}/json`,
      undefined,
      [200, 404],
    );
    if (response.status === 404) return null;
    return response.json();
  }

  /** 201 with the new id; 409 when a network of that name already exists. */
  async createNetwork(body: NetworkCreateBody): Promise<{ Id: string }> {
    return (await this.request("POST", "/networks/create", body, [201])).json();
  }

  /** null when the network does not exist. */
  async inspectNetwork(idOrName: string): Promise<NetworkInspect | null> {
    const response = await this.request(
      "GET",
      `/networks/${encodeURIComponent(idOrName)}`,
      undefined,
      [200, 404],
    );
    if (response.status === 404) return null;
    return response.json();
  }

  /**
   * Idempotent: a network that is already gone is success. A network that
   * still has endpoints answers 403 and is left to the caller.
   */
  async removeNetwork(idOrName: string): Promise<void> {
    await this.request(
      "DELETE",
      `/networks/${encodeURIComponent(idOrName)}`,
      undefined,
      [204, 404],
    );
  }

  async listNetworks(labels: string[]): Promise<NetworkInspect[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    return (await this.request("GET", `/networks?filters=${filters}`)).json();
  }

  /**
   * Every container attached to the network, stopped and never-started ones
   * included — what `NetworkInspect.Containers` leaves out. Asked by name
   * and by id because Docker may record either form when the container joins.
   */
  async listContainersOn(network: {
    Id: string;
    Name: string;
  }): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ network: [network.Name, network.Id] }),
    );
    const response = await this.request(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    return response.json();
  }

  /**
   * Not idempotent on the daemon's side: a container that is already
   * attached answers 403. Callers judge the outcome by inspecting the
   * attachment afterwards, not by the status code.
   */
  async connectNetwork(
    network: string,
    container: string,
    aliases: string[],
  ): Promise<void> {
    await this.request(
      "POST",
      `/networks/${encodeURIComponent(network)}/connect`,
      { Container: container, EndpointConfig: { Aliases: aliases } },
      [200],
    );
  }

  /**
   * A container that is not attached answers 500 ("is not connected"), not
   * 404, so callers re-inspect rather than trust any particular code.
   */
  async disconnectNetwork(network: string, container: string): Promise<void> {
    await this.request(
      "POST",
      `/networks/${encodeURIComponent(network)}/disconnect`,
      { Container: container, Force: true },
      [200],
    );
  }

  /**
   * 201 — but *not* necessarily with the volume that was asked for. A name
   * that already exists comes back as the existing volume with its original
   * driver options and labels, and no error. The caller has to compare the
   * returned `Options`/`Labels` against what it wanted; "the create
   * succeeded" says nothing about whether a quota is in force.
   */
  async createVolume(body: VolumeCreateBody): Promise<VolumeInspect> {
    return (await this.request("POST", "/volumes/create", body, [201])).json();
  }

  /** null when the volume does not exist. */
  async inspectVolume(name: string): Promise<VolumeInspect | null> {
    const response = await this.request(
      "GET",
      `/volumes/${encodeURIComponent(name)}`,
      undefined,
      [200, 404],
    );
    if (response.status === 404) return null;
    return response.json();
  }

  /**
   * `name` narrows by substring, the way Docker's filter does; callers that
   * need an exact name compare it themselves.
   */
  async listVolumes(labels: string[], name?: string): Promise<VolumeInspect[]> {
    const filters = encodeURIComponent(
      JSON.stringify({
        ...(labels.length === 0 ? {} : { label: labels }),
        ...(name === undefined ? {} : { name: [name] }),
      }),
    );
    const response = await this.request("GET", `/volumes?filters=${filters}`);
    const body: { Volumes: VolumeInspect[] | null } = await response.json();
    return body.Volumes ?? [];
  }

  /**
   * Idempotent on absence (404 is success). 409 means a container still has
   * it mounted and is left to the caller as a `DockerApiError`: forcing a
   * removal out from under a running worker is never what we want.
   */
  async removeVolume(name: string): Promise<void> {
    await this.request(
      "DELETE",
      `/volumes/${encodeURIComponent(name)}`,
      undefined,
      [204, 404],
    );
  }

  async listContainers(labels: string[]): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    const response = await this.request(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    return response.json();
  }

  /** Every container, running or not, that mounts the volume. */
  async listContainersUsingVolume(volume: string): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ volume: [volume] }));
    const response = await this.request(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    return response.json();
  }

  /** Stops (SIGTERM, then SIGKILL after `timeoutSeconds`) and removes. */
  async stopAndRemoveContainer(
    idOrName: string,
    timeoutSeconds: number,
  ): Promise<void> {
    // The daemon answers a stop only once the container is gone, which a
    // draining worker may take the whole grace for; the usual deadline would
    // cut that short and report a healthy daemon as stalled.
    await this.postStop(
      idOrName,
      timeoutSeconds,
      timeoutSeconds * 1_000 + this.timeoutMs,
    );
    await this.removeContainer(idOrName);
  }

  /**
   * Stops (SIGTERM, then SIGKILL after `timeoutSeconds`), waiting at most
   * `waitMs` for the container to be gone. False when it is still winding
   * down: the daemon carries the stop on after the request is dropped
   * (Engine 25 and later; this backend requires 28), so the SIGKILL still
   * lands `timeoutSeconds` after the SIGTERM. Asking again only sends
   * another SIGTERM, which a draining worker ignores. A request that never
   * reached the daemon reads the same; the next ask delivers it, and a
   * daemon that takes no requests at all fails the pass's inspects instead.
   */
  async stopContainer(
    idOrName: string,
    timeoutSeconds: number,
    waitMs: number,
  ): Promise<boolean> {
    try {
      await this.postStop(idOrName, timeoutSeconds, waitMs);
      return true;
    } catch (error) {
      if (error instanceof DockerTimeoutError) return false;
      throw error;
    }
  }

  private async postStop(
    idOrName: string,
    timeoutSeconds: number,
    waitMs: number,
  ): Promise<void> {
    await this.request(
      "POST",
      `/containers/${encodeURIComponent(idOrName)}/stop?t=${timeoutSeconds}`,
      undefined,
      [204, 304, 404],
      waitMs,
    );
  }

  async removeContainer(idOrName: string): Promise<void> {
    // `v=true` takes the container's *anonymous* volumes with it — the ones
    // Docker materializes for every `VOLUME` an image declares. Named volumes
    // are untouched by it, so the session workspace still outlives this call
    // and is reclaimed by GC instead.
    await this.request(
      "DELETE",
      `/containers/${encodeURIComponent(idOrName)}?force=true&v=true`,
      undefined,
      [204, 404],
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept: number[] = [200, 201, 204],
    timeoutMs: number = this.timeoutMs,
  ): Promise<Response> {
    const url =
      this.endpoint.kind === "unix"
        ? `http://docker${this.prefix}${path}`
        : `${this.endpoint.baseUrl}${this.prefix}${path}`;
    const init: RequestInit & { unix?: string } = {
      method,
      // Every call is bounded: a stalled daemon must fail the pass, not hang
      // the one-shot scheduler and every launch queued behind it.
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
      ...(this.endpoint.kind === "unix"
        ? { unix: this.endpoint.socketPath }
        : {}),
    };
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new DockerTimeoutError(method, path, timeoutMs);
      }
      throw error;
    }
    if (!accept.includes(response.status)) {
      throw new DockerApiError(
        response.status,
        method,
        path,
        await response.text(),
      );
    }
    return response;
  }
}

/**
 * Docker's multiplexed log stream: each frame is an 8-byte header (stream,
 * three zero bytes, a big-endian payload length) and its payload. Frames
 * arrive split across chunks, so bytes wait here until a frame is whole.
 */
class FrameReader {
  private pending = new Uint8Array();
  private readonly payloads: Uint8Array[] = [];
  payloadBytes = 0;

  push(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.pending.length + chunk.length);
    joined.set(this.pending);
    joined.set(chunk, this.pending.length);
    let offset = 0;
    while (joined.length - offset >= 8) {
      const size = new DataView(
        joined.buffer,
        joined.byteOffset + offset + 4,
        4,
      ).getUint32(0);
      if (joined.length - offset - 8 < size) break;
      this.payloads.push(joined.subarray(offset + 8, offset + 8 + size));
      this.payloadBytes += size;
      offset += 8 + size;
    }
    this.pending = joined.slice(offset);
  }

  get bufferedBytes(): number {
    return this.payloadBytes + this.pending.length;
  }

  payload(): Uint8Array {
    const out = new Uint8Array(this.payloadBytes);
    let offset = 0;
    for (const part of this.payloads) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}
