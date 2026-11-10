import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type ExecutionResources,
  hashWorkerToken,
  type LaunchIntent,
  LaunchOutcomeUnknownError,
  LaunchSpecMismatchError,
  launchNonceFingerprint,
  launchSpecFingerprint,
} from "@werft-ai/platform";
import {
  containerNameFor,
  ENV,
  ExecutionConflictError,
  GatewayModeUnsupportedError,
  IsolationContractError,
  isolationStampFor,
  LABELS,
  LocalDockerBackend,
  NetworkIsolationError,
  NO_PROXY_VALUE,
  networkNameFor,
  stateOf,
  volumeLabelsOf,
  WorkspaceQuotaError,
  WorkspaceQuotaUnsupportedError,
  workerEnvironmentFor,
  workspaceVolumePrefixFor,
} from "./backend.ts";
import {
  type LocalDockerBackendConfig,
  localDockerConfigFromEnv,
} from "./config.ts";
import {
  type ContainerCreateBody,
  DockerApiError,
  DockerClient,
  DockerTimeoutError,
} from "./docker-client.ts";
import { INODE_HELPER_LABEL } from "./workspace-inodes.ts";

const GATEWAY_MODE_OPTION = "com.docker.network.bridge.gateway_mode_ipv4";

type FakeContainer = {
  body: ContainerCreateBody;
  /** Unix seconds; absent means just now. */
  created?: number;
  id: string;
  name: string;
  status: string;
  exitCode: number;
  oomKilled?: boolean;
  /** Lines the container wrote, each sent as frames of at most 7 bytes. */
  output?: string[];
};

type FakeNetwork = {
  /** Endpoints made by `connect`, keyed by container id. */
  attached: Map<string, { aliases: string[] }>;
  driver: string;
  /** The host's address on the network; empty in the isolated mode. */
  gateway: string;
  id: string;
  ipv6: boolean;
  internal: boolean;
  labels: Record<string, string>;
  name: string;
  options: Record<string, string>;
};

/** A container that is not a worker: the egress proxy, or a stranger. */
type FakeProxy = {
  id: string;
  labels: Record<string, string>;
  name: string;
  status: string;
};

type FakeVolume = {
  createdAt: string;
  labels: Record<string, string>;
  name: string;
  options: Record<string, string> | null;
};

/**
 * Just enough of the Engine API to exercise the backend: create/start/
 * inspect/list/stop/delete with Docker's status codes, including the 409 a
 * name clash returns.
 */
class FakeDocker {
  readonly containers = new Map<string, FakeContainer>();
  /** By name. Ids are `net-<name>`, so two fakes agree on them. */
  readonly networks = new Map<string, FakeNetwork>();
  /** Containers other than workers, by id: proxies and strangers. */
  readonly others = new Map<string, FakeProxy>();
  /** Every network connect answers 403 without attaching anything. */
  refuseConnects = false;
  /**
   * Container names whose worker is draining its turn: a stop is not
   * answered, the way the daemon answers only once the container is gone.
   */
  readonly draining = new Set<string>();
  /** Every network disconnect answers 500 and leaves the endpoint. */
  refuseDisconnects = false;
  /** The next network create answers 409 as if a racer had just made it. */
  networkCreateRace: FakeNetwork | null = null;
  /** Containers whose endpoint names its network without the id. */
  readonly nameOnlyEndpoints = new Set<string>();
  /** What `GET /version` reports; 1.48 is Docker 28. */
  apiVersion = "1.48";
  /**
   * A daemon from before Docker 27.1: it records a driver option it does not
   * know and gives the host a gateway anyway.
   */
  ignoresGatewayMode = false;
  readonly requests: Array<{ method: string; path: string; query: string }> =
    [];
  /** Image name → the `VOLUME` paths it declares. */
  readonly images = new Map<string, string[]>([["worker:test", []]]);
  /** References whose inspect comes back without an id. */
  readonly imagesWithoutId = new Set<string>();
  /** A `docker volume prune` that lands between the check and the create. */
  pruneVolumesOnCreate = false;
  private nextId = 1;
  private server: ReturnType<typeof Bun.serve> | undefined;
  /** When set, the next create returns 409 without creating anything. */
  conflictNextCreate = false;
  /** Labels the race winner carries, so the winner can be a stale one. */
  raceWinnerLabels: Record<string, string> = {};
  /** Every create loses the race and leaves nothing behind. */
  conflictEveryCreate = false;
  readonly volumes = new Map<string, FakeVolume>();
  /** Off: the storage behind the `local` driver cannot carry a quota. */
  quotaSupported = true;
  /** Volumes a removal must report as still mounted, the way 409 does. */
  readonly volumesInUse = new Set<string>();
  /** Labels the next create comes back with, as if the name were taken. */
  createReturnsLabels: Record<string, string> | null = null;
  /** The next create fails with 400 and quotes the request body back. */
  echoNextCreate = false;
  /** Every start is refused with 500, the way an OCI runtime error is. */
  refuseStarts = false;
  /** Every start waits this long before it answers, and then takes. */
  stallStartsMs = 0;
  /** Every worker create takes, then waits this long before it answers. */
  stallCreatesMs = 0;
  /** What every inode helper exits with; 0 is "limit read back in force". */
  inodeHelperExit = 0;
  /** Every inode helper create waits on this before the daemon takes it. */
  holdHelperCreates: Promise<void> | null = null;
  /** Every inode helper started, in order. */
  readonly inodeHelperRuns: ContainerCreateBody[] = [];
  /** Ids of every inode helper ever created, removed or not. */
  readonly inodeHelperIds = new Set<string>();

  constructor() {
    this.addOther("egress-proxy-a", { [LABELS.egressProxy]: "test-a" });
    this.addOther("egress-proxy-b", { [LABELS.egressProxy]: "test-b" });
  }

  addOther(
    name: string,
    labels: Record<string, string>,
    status = "running",
  ): FakeProxy {
    const other = { id: `id-${name}`, labels, name, status };
    this.others.set(other.id, other);
    return other;
  }

  addNetwork(
    name: string,
    overrides: Partial<Omit<FakeNetwork, "name">> = {},
  ): FakeNetwork {
    const network: FakeNetwork = {
      attached: new Map(),
      driver: "bridge",
      gateway: "",
      id: `net-${name}`,
      internal: true,
      ipv6: false,
      labels: {},
      name,
      options: { [GATEWAY_MODE_OPTION]: "isolated" },
      ...overrides,
    };
    this.networks.set(name, network);
    return network;
  }

  networkByIdOrName(key: string): FakeNetwork | undefined {
    return (
      this.networks.get(key) ??
      [...this.networks.values()].find((n) => n.id === key)
    );
  }

  /** Running members, the way a network inspect lists them. */
  membersOf(network: FakeNetwork): Record<string, { Name: string }> {
    const members: Record<string, { Name: string }> = {};
    for (const container of this.containers.values()) {
      const mode = container.body.HostConfig.NetworkMode;
      if (
        container.status === "running" &&
        (mode === network.id || mode === network.name)
      ) {
        members[container.id] = { Name: container.name };
      }
    }
    for (const [id] of network.attached) {
      const other = this.others.get(id);
      const worker = [...this.containers.values()].find((c) => c.id === id);
      if (other?.status === "running" || worker?.status === "running") {
        members[id] = { Name: other?.name ?? worker?.name ?? id };
      }
    }
    return members;
  }

  /** What a container inspect reports under `NetworkSettings.Networks`. */
  attachmentsOf(
    id: string,
    networkMode?: string,
  ): Record<string, { Aliases: string[] | null; NetworkID: string }> {
    const attachments: Record<
      string,
      { Aliases: string[] | null; NetworkID: string }
    > = {};
    if (networkMode !== undefined && networkMode !== "") {
      const network = this.networkByIdOrName(networkMode);
      const name = network?.name ?? networkMode.replace(/^net-/, "");
      attachments[name] = {
        Aliases: null,
        NetworkID: this.nameOnlyEndpoints.has(id)
          ? ""
          : (network?.id ?? networkMode),
      };
    }
    for (const network of this.networks.values()) {
      const endpoint = network.attached.get(id);
      if (endpoint) {
        attachments[network.name] = {
          Aliases: endpoint.aliases,
          NetworkID: network.id,
        };
      }
    }
    return attachments;
  }

  get host(): string {
    if (!this.server) throw new Error("not started");
    return `tcp://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      fetch: (request) => this.handle(request),
      hostname: "127.0.0.1",
      port: 0,
    });
  }

  stop(): void {
    this.server?.stop(true);
  }

  add(name: string, body: ContainerCreateBody, status = "running") {
    const id = `${String(this.nextId++).padStart(4, "0")}${"a".repeat(60)}`;
    const container: FakeContainer = { body, exitCode: 0, id, name, status };
    this.containers.set(name, container);
    return container;
  }

  addVolume(
    name: string,
    labels: Record<string, string>,
    options: Record<string, string> | null = null,
    createdAt = new Date(0).toISOString(),
  ): FakeVolume {
    const volume = { createdAt, labels, name, options };
    this.volumes.set(name, volume);
    return volume;
  }

  byIdOrName(key: string): FakeContainer | undefined {
    return (
      this.containers.get(key) ??
      [...this.containers.values()].find((c) => c.id === key)
    );
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1\.\d+/, "");
    this.requests.push({ method: request.method, path, query: url.search });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
        status,
      });

    if (request.method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      // The knobs below stage races over a worker's name; the inode helper
      // takes a fresh name each run and is never part of one.
      const peek = (await request.clone().json()) as ContainerCreateBody;
      if (peek.Labels[INODE_HELPER_LABEL] !== undefined) {
        await this.holdHelperCreates;
        // Docker makes a mount's missing volume afresh, with no size.
        const source = peek.HostConfig.Mounts[0]?.Source ?? "";
        if (!this.volumes.has(source)) {
          this.addVolume(source, {}, null, new Date().toISOString());
        }
        const helper = this.add(name, peek, "created");
        this.inodeHelperIds.add(helper.id);
        return json({ Id: helper.id, Warnings: [] }, 201);
      }
      if (this.pruneVolumesOnCreate) this.volumes.clear();
      if (this.conflictEveryCreate) {
        return json({ message: "Conflict. Lost the create race" }, 409);
      }
      if (this.echoNextCreate) {
        this.echoNextCreate = false;
        return json(
          { message: `invalid request: ${await request.text()}` },
          400,
        );
      }
      if (this.conflictNextCreate && !this.containers.has(name)) {
        // The other launcher won the race: its container exists by the time
        // this create is rejected, exactly what Docker reports with 409.
        this.conflictNextCreate = false;
        const winner = (await request.json()) as ContainerCreateBody;
        winner.Labels = { ...winner.Labels, ...this.raceWinnerLabels };
        this.add(name, winner);
        return json({ message: "Conflict. Lost the create race" }, 409);
      }
      if (this.containers.has(name)) {
        return json(
          {
            message: `Conflict. The container name "/${name}" is already in use`,
          },
          409,
        );
      }
      const body = (await request.json()) as ContainerCreateBody;
      const container = this.add(name, body, "created");
      if (this.stallCreatesMs > 0) await Bun.sleep(this.stallCreatesMs);
      return json({ Id: container.id, Warnings: [] }, 201);
    }
    if (request.method === "GET" && path === "/containers/json") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as {
        label?: string[];
        network?: string[];
      };
      const wanted = (filters.label ?? []).map(
        (l) => l.split("=") as [string, string],
      );
      // Any status: unlike a network inspect, the listing keeps stopped and
      // never-started members.
      const onNetwork = (id: string, mode?: string) =>
        filters.network === undefined ||
        filters.network.some((key) => {
          const network = this.networkByIdOrName(key);
          return (
            network !== undefined &&
            (mode === network.id ||
              mode === network.name ||
              network.attached.has(id))
          );
        });
      const matching = [...this.containers.values()].filter(
        (c) =>
          wanted.every(([k, v]) => c.body.Labels[k] === v) &&
          onNetwork(c.id, c.body.HostConfig.NetworkMode),
      );
      const others = [...this.others.values()].filter(
        (o) => wanted.every(([k, v]) => o.labels[k] === v) && onNetwork(o.id),
      );
      return json([
        ...matching.map((c) => ({
          Created: c.created ?? Math.floor(Date.now() / 1000),
          Id: c.id,
          Labels: c.body.Labels,
          Names: [`/${c.name}`],
          State: c.status,
        })),
        ...others.map((o) => ({
          Id: o.id,
          Labels: o.labels,
          Names: [`/${o.name}`],
          State: o.status,
        })),
      ]);
    }
    const asVolume = (volume: FakeVolume) => ({
      CreatedAt: volume.createdAt,
      Driver: "local",
      Labels: Object.keys(volume.labels).length === 0 ? null : volume.labels,
      Mountpoint: `/var/lib/docker/volumes/${volume.name}/_data`,
      Name: volume.name,
      Options: volume.options,
    });
    if (request.method === "POST" && path === "/volumes/create") {
      const body = (await request.json()) as {
        DriverOpts?: Record<string, string>;
        Labels?: Record<string, string>;
        Name: string;
      };
      const existing =
        this.volumes.get(body.Name) ??
        (this.createReturnsLabels === null
          ? undefined
          : this.addVolume(body.Name, this.createReturnsLabels));
      // Docker's create is not create-or-fail: an existing name comes back
      // 201 with the volume as it already is, options and labels untouched.
      if (existing) return json(asVolume(existing), 201);
      if (body.DriverOpts?.size !== undefined && !this.quotaSupported) {
        return json(
          {
            message: `create ${body.Name}: quota size requested but no quota support`,
          },
          400,
        );
      }
      return json(
        asVolume(
          this.addVolume(
            body.Name,
            body.Labels ?? {},
            body.DriverOpts ?? null,
            new Date().toISOString(),
          ),
        ),
        201,
      );
    }
    if (request.method === "GET" && path === "/volumes") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as {
        label?: string[];
        name?: string[];
      };
      const wanted = (filters.label ?? []).map(
        (l) => l.split("=") as [string, string],
      );
      const matching = [...this.volumes.values()].filter(
        (v) =>
          wanted.every(([k, value]) => v.labels[k] === value) &&
          (filters.name ?? []).every((part) => v.name.includes(part)),
      );
      return json({ Volumes: matching.map(asVolume), Warnings: null });
    }
    const volume = path.match(/^\/volumes\/([^/]+)$/);
    if (volume) {
      const name = decodeURIComponent(volume[1] ?? "");
      const found = this.volumes.get(name);
      if (!found) return json({ message: `no such volume: ${name}` }, 404);
      if (request.method === "GET") return json(asVolume(found));
      if (request.method === "DELETE") {
        if (this.volumesInUse.has(name)) {
          return json({ message: `volume ${name} is in use` }, 409);
        }
        this.volumes.delete(name);
        return new Response(null, { status: 204 });
      }
    }
    const image = path.match(/^\/images\/(.+)\/json$/);
    if (request.method === "GET" && image) {
      const requested = decodeURIComponent(image[1] ?? "");
      // Docker answers for an image by its id as well as by its tag.
      const name =
        [...this.images.keys()].find((tag) => imageIdOf(tag) === requested) ??
        requested;
      const declared = this.images.get(name);
      if (declared === undefined) {
        return json({ message: `No such image: ${name}` }, 404);
      }
      return json({
        Config: {
          Volumes:
            declared.length === 0
              ? null
              : Object.fromEntries(declared.map((v) => [v, {}])),
        },
        Id: this.imagesWithoutId.has(name) ? "" : imageIdOf(name),
      });
    }
    if (request.method === "GET" && path === "/version") {
      return json({ ApiVersion: this.apiVersion, Version: "fake" });
    }
    const asNetwork = (network: FakeNetwork, withMembers: boolean) => ({
      Containers: withMembers ? this.membersOf(network) : {},
      Driver: network.driver,
      EnableIPv6: network.ipv6,
      IPAM: {
        Config: [{ Gateway: network.gateway, Subnet: "10.9.0.0/24" }],
      },
      Id: network.id,
      Internal: network.internal,
      Labels: network.labels,
      Name: network.name,
      Options: network.options,
    });
    if (request.method === "POST" && path === "/networks/create") {
      const body = (await request.json()) as {
        Driver?: string;
        EnableIPv6?: boolean;
        Internal: boolean;
        Labels?: Record<string, string>;
        Name: string;
        Options?: Record<string, string>;
      };
      if (this.networkCreateRace !== null) {
        const racer = this.networkCreateRace;
        this.networkCreateRace = null;
        this.networks.set(racer.name, racer);
      }
      if (this.networks.has(body.Name)) {
        return json(
          { message: `network with name ${body.Name} already exists` },
          409,
        );
      }
      const options = body.Options ?? {};
      const created = this.addNetwork(body.Name, {
        driver: body.Driver ?? "bridge",
        gateway:
          options[GATEWAY_MODE_OPTION] === "isolated" &&
          !this.ignoresGatewayMode
            ? ""
            : "10.9.0.1",
        internal: body.Internal,
        // A daemon with IPv6 on by default: only an explicit false turns it off.
        ipv6: body.EnableIPv6 ?? true,
        labels: body.Labels ?? {},
        options,
      });
      return json({ Id: created.id, Warning: "" }, 201);
    }
    if (request.method === "GET" && path === "/networks") {
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as {
        label?: string[];
      };
      const wanted = (filters.label ?? []).map(
        (l) => l.split("=") as [string, string],
      );
      return json(
        [...this.networks.values()]
          .filter((n) => wanted.every(([k, v]) => n.labels[k] === v))
          .map((n) => asNetwork(n, false)),
      );
    }
    const networkAction = path.match(
      /^\/networks\/([^/]+)\/(connect|disconnect)$/,
    );
    if (request.method === "POST" && networkAction) {
      const network = this.networkByIdOrName(
        decodeURIComponent(networkAction[1] ?? ""),
      );
      const body = (await request.json()) as {
        Container: string;
        EndpointConfig?: { Aliases?: string[] };
      };
      const target =
        this.others.get(body.Container) ??
        [...this.others.values()].find((o) => o.name === body.Container) ??
        this.byIdOrName(body.Container);
      if (!target) {
        return json({ message: `No such container: ${body.Container}` }, 404);
      }
      if (!network) return json({ message: "network not found" }, 404);
      if (networkAction[2] === "connect") {
        if (this.refuseConnects || network.attached.has(target.id)) {
          return json(
            {
              message: `endpoint with name ${target.name} already exists in network ${network.name}`,
            },
            403,
          );
        }
        network.attached.set(target.id, {
          aliases: body.EndpointConfig?.Aliases ?? [],
        });
        return new Response(null, { status: 200 });
      }
      if (this.refuseDisconnects) {
        return json({ message: "failed to disconnect" }, 500);
      }
      const worker = this.byIdOrName(body.Container);
      const mode = worker?.body.HostConfig.NetworkMode;
      if (worker && (mode === network.id || mode === network.name)) {
        // The network it was created on; nothing is left in its place.
        worker.body.HostConfig.NetworkMode = "";
        return new Response(null, { status: 200 });
      }
      if (!network.attached.delete(target.id)) {
        return json(
          {
            message: `container ${target.id} is not connected to network ${network.name}`,
          },
          500,
        );
      }
      return new Response(null, { status: 200 });
    }
    const network = path.match(/^\/networks\/([^/]+)$/);
    if (network) {
      const found = this.networkByIdOrName(
        decodeURIComponent(network[1] ?? ""),
      );
      if (!found) return json({ message: "network not found" }, 404);
      if (request.method === "GET") return json(asNetwork(found, true));
      if (request.method === "DELETE") {
        if (Object.keys(this.membersOf(found)).length > 0) {
          return json(
            {
              message: `error while removing network: network ${found.name} has active endpoints`,
            },
            403,
          );
        }
        this.networks.delete(found.name);
        return new Response(null, { status: 204 });
      }
    }
    const match = path.match(
      /^\/containers\/([^/]+)(?:\/(start|stop|json|wait|logs))?$/,
    );
    if (!match) return json({ message: "not found" }, 404);
    const key = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    const other =
      this.others.get(key) ??
      [...this.others.values()].find((o) => o.name === key);
    if (other && request.method === "GET" && action === "json") {
      return json({
        Config: { Env: [], Labels: other.labels, User: "" },
        HostConfig: {},
        Id: other.id,
        Mounts: [],
        Name: `/${other.name}`,
        NetworkSettings: { Networks: this.attachmentsOf(other.id) },
        State: {
          ExitCode: 0,
          Running: other.status === "running",
          Status: other.status,
        },
      });
    }
    const container = this.byIdOrName(key);
    if (!container) return json({ message: `No such container: ${key}` }, 404);
    const isHelper = container.body.Labels[INODE_HELPER_LABEL] !== undefined;
    if (request.method === "POST" && action === "start") {
      if (this.refuseStarts && !isHelper) {
        return json(
          {
            message:
              "failed to create task for container: OCI runtime create failed",
          },
          500,
        );
      }
      if (this.stallStartsMs > 0 && !isHelper) {
        await Bun.sleep(this.stallStartsMs);
      }
      if (container.status === "running")
        return new Response(null, { status: 304 });
      if (isHelper) {
        // The helper does its work and exits before anyone waits on it. A
        // volume created without a size has no xfs project of its own.
        this.inodeHelperRuns.push(container.body);
        container.status = "exited";
        const source = container.body.HostConfig.Mounts[0]?.Source ?? "";
        container.exitCode =
          this.volumes.get(source)?.options?.size === undefined
            ? 12
            : this.inodeHelperExit;
        return new Response(null, { status: 204 });
      }
      container.status = "running";
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && action === "wait") {
      if (container.status === "running") {
        return json(
          { message: "the fake only waits on exited containers" },
          501,
        );
      }
      return json({ StatusCode: container.exitCode });
    }
    if (request.method === "POST" && action === "stop") {
      if (container.status !== "running")
        return new Response(null, { status: 304 });
      if (this.draining.has(container.name)) {
        return new Promise<Response>(() => undefined);
      }
      container.status = "exited";
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && action === "json") {
      return json({
        Config: {
          Env: container.body.Env,
          Labels: container.body.Labels,
          User: container.body.User,
        },
        HostConfig: container.body.HostConfig,
        Id: container.id,
        Mounts: container.body.HostConfig.Mounts.filter(
          (mount) => mount.Type === "volume",
        ).map((mount) => ({
          Destination: mount.Target,
          Name: mount.Source,
          Type: mount.Type,
        })),
        Name: `/${container.name}`,
        NetworkSettings: {
          Networks: this.attachmentsOf(
            container.id,
            container.body.HostConfig.NetworkMode,
          ),
        },
        State: {
          ExitCode: container.exitCode,
          OOMKilled: container.oomKilled ?? false,
          Running: container.status === "running",
          Status: container.status,
        },
      });
    }
    if (request.method === "GET" && action === "logs") {
      const tail = Number(url.searchParams.get("tail"));
      const lines = (container.output ?? []).slice(-tail);
      // Frames split mid-header across chunks, as a socket may deliver them.
      const bytes = lines
        .flatMap((line) =>
          [...new TextEncoder().encode(`${line}\n`)].reduce<number[][]>(
            (frames, byte, index) => {
              if (index % 7 === 0) frames.push([]);
              frames.at(-1)?.push(byte);
              return frames;
            },
            [],
          ),
        )
        .flatMap((payload) => [
          2,
          0,
          0,
          0,
          0,
          0,
          0,
          payload.length,
          ...payload,
        ]);
      return new Response(
        new ReadableStream({
          start(controller) {
            for (let at = 0; at < bytes.length; at += 5) {
              controller.enqueue(new Uint8Array(bytes.slice(at, at + 5)));
            }
            controller.close();
          },
        }),
      );
    }
    if (request.method === "DELETE" && action === undefined) {
      this.containers.delete(container.name);
      return new Response(null, { status: 204 });
    }
    return json({ message: "unsupported" }, 405);
  }
}

const RESOURCES = { cpus: 1.5, memoryBytes: 2 * 1024 ** 3, pidsLimit: 512 };

/** Container creates for workers: every launch also runs an inode helper. */
function workerCreates(docker: FakeDocker) {
  return docker.requests.filter(
    (r) => r.path === "/containers/create" && !r.query.includes("ap-inodes-"),
  );
}

/** DELETEs of anything but an inode helper, which removes itself each run. */
function workerRemovals(docker: FakeDocker) {
  return docker.requests.filter(
    (r) =>
      r.method === "DELETE" &&
      !docker.inodeHelperIds.has(r.path.replace(/^\/containers\//, "")),
  );
}

/** How often the registry was asked for a credential; only creating asks. */
let nonceIssues = 0;

/** What the label carries for `nonce`, as the registry would compute it. */
function fingerprintOf(nonce: string): string {
  return launchNonceFingerprint(hashWorkerToken(nonce));
}

function intentFor(overrides: Partial<LaunchIntent> = {}): LaunchIntent {
  return {
    // The registry accepts exactly the credential this fixture issues, so a
    // container this backend created is always adoptable unless a test
    // changes one side.
    bootstrapCredentialState: async () => ({
      claimed: false,
      fingerprint: fingerprintOf("nonce-abc"),
    }),
    executionId: "exec-11111111-2222-3333-4444-555555555555",
    generation: 1,
    image: "worker:test",
    issueBootstrapNonce: async () => {
      nonceIssues += 1;
      return "nonce-abc";
    },
    launchSpec: null,
    operationId: "op-1",
    resources: RESOURCES,
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    ...overrides,
  };
}

const QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
const QUOTA_INODES = 250_000;

let docker: FakeDocker;
let backend: LocalDockerBackend;

function configFor(host: string): LocalDockerBackendConfig {
  return {
    apiVersion: "v1.44",
    dockerHost: host,
    egressCredentialPort: 3129,
    egressProxyUrl: "http://egress-proxy:3128",
    gatewayUrl: "http://host.docker.internal:3000",
    homeDir: "/home/worker",
    installationId: "test-a",
    objectStore: {
      bucket: "claude-sessions",
      region: "ap-northeast-1",
    },
    requestTimeoutMs: 5_000,
    stopTimeoutSeconds: 3,
    tmpfsSizeBytes: 64 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    volumeLabelNamespace: "werft",
    volumeNamePrefix: "werft-ws-",
    workspaceGcMinAgeMs: 0,
    workspaceQuota: {
      helperImage: "worker:test",
      inodes: QUOTA_INODES,
      mode: "enforced",
      sizeBytes: QUOTA_BYTES,
    },
  };
}

function naming(installationId: string) {
  return {
    installationId,
    volumeLabelNamespace: "werft",
    volumeNamePrefix: "werft-ws-",
  };
}

const VOLUME_LABELS = volumeLabelsOf(naming("test-a"));

beforeEach(() => {
  docker = new FakeDocker();
  docker.start();
  backend = new LocalDockerBackend(configFor(docker.host));
  nonceIssues = 0;
});

afterEach(() => {
  docker.stop();
});

/** The name a workspace had before names became single-use. */
function legacyWorkspaceName(
  sessionId: string,
  installationId: string,
): string {
  return workspaceVolumePrefixFor(sessionId, naming(installationId)).slice(
    0,
    -1,
  );
}

/** The bounded volume a container's create left behind on the daemon. */
function seedMountedWorkspace(
  docker: FakeDocker,
  body: ContainerCreateBody,
  sessionId: string,
): string {
  const name = mountedWorkspaceOf(body);
  docker.addVolume(
    name,
    {
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [LABELS.sessionId]: sessionId,
      [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    },
    { size: String(QUOTA_BYTES) },
  );
  return name;
}

function mountedWorkspaceOf(body: ContainerCreateBody): string {
  const mount = body.HostConfig.Mounts.find((one) => one.Type === "volume");
  if (!mount) throw new Error("the create body mounts no volume");
  return mount.Source;
}

/** This session's workspace as the daemon holds it, whatever its suffix. */
function workspaceNameOf(
  docker: FakeDocker,
  sessionId: string,
  installationId: string,
): string | undefined {
  const prefix = workspaceVolumePrefixFor(sessionId, naming(installationId));
  return [...docker.volumes.keys()].find((name) => name.startsWith(prefix));
}

test("hands the worker the installation's turn and retry limits when they are set", () => {
  const intent = intentFor();
  const base = configFor("unix:///fake.sock");
  const without = workerEnvironmentFor(base, intent, "nonce-abc");
  expect(without.some((entry) => entry.startsWith(ENV.maxTurnSeconds))).toBe(
    false,
  );
  const limited = workerEnvironmentFor(
    { ...base, workerLimits: { maxTurnSeconds: 900, providerMaxRetries: 0 } },
    intent,
    "nonce-abc",
  );
  expect(limited).toEqual([
    ...without,
    "WORKER_MAX_TURN_SEC=900",
    "WORKER_PROVIDER_MAX_RETRIES=0",
  ]);
});

test("hands the worker no OTEL_* key even when the scheduler's own environment has them", () => {
  // Standard OTel keys mean something to auto-configuring libraries: a worker
  // given them would export to whatever they name. Tracing reaches the worker
  // through the bootstrap claim only.
  const keys = {
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_EXPORTER_OTLP_HEADERS: "authorization=SECRET",
    OTEL_TRACES_SAMPLER: "traceidratio",
  };
  const before = { ...process.env };
  Object.assign(process.env, keys);
  try {
    const env = workerEnvironmentFor(
      configFor("unix:///fake.sock"),
      intentFor(),
      "nonce-abc",
    );
    expect(env.filter((entry) => entry.startsWith("OTEL_"))).toEqual([]);
    expect(env.join("\n")).not.toContain("SECRET");
  } finally {
    for (const key of Object.keys(keys)) {
      const original = before[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
});

test("hands the worker the scheduler's LOG_LEVEL without changing the isolation stamp", () => {
  const intent = intentFor();
  const base = configFor("unix:///fake.sock");
  const without = workerEnvironmentFor(base, intent, "nonce-abc");
  expect(without.some((entry) => entry.startsWith("LOG_LEVEL="))).toBe(false);
  const quiet = { ...base, logLevel: "warn" };
  expect(workerEnvironmentFor(quiet, intent, "nonce-abc")).toEqual([
    ...without,
    "LOG_LEVEL=warn",
  ]);
  expect(isolationStampFor(quiet)).toBe(isolationStampFor(base));
});

test("a container started under another inode limit, or before one, is stale", () => {
  // Not for the volume's sake — the limit is set in place — but because
  // only a launch sets it, and replacing the container is what launches.
  const base = configFor("unix:///fake.sock");
  const quota = base.workspaceQuota;
  if (quota.mode !== "enforced") throw new Error("fixture must be enforced");
  expect(
    isolationStampFor({
      ...base,
      workspaceQuota: { ...quota, inodes: quota.inodes + 1 },
    }),
  ).not.toBe(isolationStampFor(base));
  // Which image runs the helper is not part of the worker's boundary.
  expect(
    isolationStampFor({
      ...base,
      workspaceQuota: { ...quota, helperImage: "worker:next" },
    }),
  ).toBe(isolationStampFor(base));
});

test("a container started under other worker limits, or none, is stale", () => {
  const base = configFor("unix:///fake.sock");
  const limited = {
    ...base,
    workerLimits: { maxTurnSeconds: 900, providerMaxRetries: 2 },
  };
  expect(isolationStampFor(limited)).not.toBe(isolationStampFor(base));
  expect(
    isolationStampFor({
      ...limited,
      workerLimits: { maxTurnSeconds: 1800, providerMaxRetries: 2 },
    }),
  ).not.toBe(isolationStampFor(limited));
});

describe("LocalDockerBackend.ensureExecution", () => {
  test("creates and starts a container whose config matches the isolation contract", async () => {
    const intent = intentFor();
    const result = await backend.ensureExecution(intent);

    expect(result.created).toBe(true);
    expect(result.state).toBe("running");
    const name = containerNameFor(intent, "test-a");
    const container = docker.containers.get(name);
    expect(container).toBeDefined();
    if (!container) throw new Error("missing");
    expect(result.providerRef).toBe(container.id);

    const { body } = container;
    // The id the inspect resolved, not the tag it was asked for.
    expect(body.Image).toBe("sha256:workertest");
    expect(body.User).toBe("1000:1000");
    // Exactly the variables the worker contract needs, nothing else leaks in.
    expect(body.Env.sort()).toEqual(
      [
        `${ENV.home}=/home/worker`,
        `${ENV.workspaceDir}=/workspace`,
        `${ENV.workspaceMountDir}=/workspace`,
        `${ENV.workspaceQuotaMode}=enforced`,
        `${ENV.workspaceQuotaBytes}=4294967296`,
        `${ENV.bootstrapNonce}=nonce-abc`,
        `${ENV.executionGeneration}=1`,
        `${ENV.executionId}=${intent.executionId}`,
        `${ENV.gatewayUrl}=http://host.docker.internal:3000`,
        `${ENV.egressCredentialUrl}=http://egress-proxy:3129`,
        `${ENV.httpProxy}=http://egress-proxy:3128`,
        `${ENV.httpProxyLower}=http://egress-proxy:3128`,
        `${ENV.httpsProxy}=http://egress-proxy:3128`,
        `${ENV.httpsProxyLower}=http://egress-proxy:3128`,
        `${ENV.noProxy}=${NO_PROXY_VALUE},egress-proxy`,
        `${ENV.noProxyLower}=${NO_PROXY_VALUE},egress-proxy`,
        `${ENV.objectBucket}=claude-sessions`,
        `${ENV.objectPrefix}=sessions/${intent.sessionId}/`,
        `${ENV.objectRegion}=ap-northeast-1`,
        `${ENV.stopGrace}=3`,
      ].sort(),
    );
    expect(body.Labels).toEqual({
      [LABELS.bootstrapFingerprint]: fingerprintOf("nonce-abc"),
      [LABELS.executionId]: intent.executionId,
      [LABELS.generation]: "1",
      [LABELS.installation]: "test-a",
      [LABELS.isolation]: isolationStampFor(configFor(docker.host)),
      [LABELS.managed]: "true",
      [LABELS.operationId]: "op-1",
      [LABELS.sessionId]: intent.sessionId,
    });
    expect(body.HostConfig).toEqual({
      CapDrop: ["ALL"],
      Memory: RESOURCES.memoryBytes,
      Mounts: [
        {
          Source: expect.stringMatching(
            new RegExp(
              `^${workspaceVolumePrefixFor(intent.sessionId, naming("test-a"))}`,
            ),
          ),
          Target: "/workspace",
          Type: "volume",
        },
      ],
      NanoCpus: 1_500_000_000,
      NetworkMode: `net-${networkNameFor(intent, "test-a")}`,
      PidsLimit: 512,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: {
        "/home/worker": "rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
        "/tmp": "rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
      },
    });
    // No bind mounts at all: no Docker socket, no host HOME.
    expect(JSON.stringify(body)).not.toContain("docker.sock");
    expect("Binds" in body.HostConfig).toBe(false);
    // The host-gateway mapping would be a route around the proxy.
    expect(JSON.stringify(body)).not.toContain("host-gateway");
  });

  test("the same intent twice yields one container and reports created=false", async () => {
    const intent = intentFor();
    const first = await backend.ensureExecution(intent);
    const second = await backend.ensureExecution(intent);
    expect(second).toEqual({
      created: false,
      providerRef: first.providerRef,
      state: "running",
    });
    // Adopting must not mint a second credential: the container already
    // running holds the first one, and issuing would invalidate it.
    expect(nonceIssues).toBe(1);
    expect(docker.containers.size).toBe(1);
    expect(workerCreates(docker)).toHaveLength(1);
  });

  test("a create that loses the name race adopts the winner instead of failing", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    const result = await backend.ensureExecution(intent);
    expect(result).toMatchObject({ created: false, state: "running" });
    expect(docker.containers.size).toBe(1);
    expect(workerCreates(docker)).toHaveLength(1);
  });

  test("the winner of a create race is judged by the isolation contract too", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    docker.raceWinnerLabels = { [LABELS.isolation]: "1" };

    const result = await backend.ensureExecution(intent);

    // The winner was stale, so it is replaced rather than adopted.
    expect(result).toMatchObject({ created: true, state: "running" });
    expect(docker.containers.size).toBe(1);
    const fresh = docker.containers.get(containerNameFor(intent, "test-a"));
    expect(fresh?.body.Labels[LABELS.isolation]).toBe(
      isolationStampFor(configFor(docker.host)),
    );
  });

  test("a race winner holding another credential is replaced, not adopted", async () => {
    // Attempt 0 issued nonce-abc and lost the name to a container built with
    // some other nonce; the registry only accepts nonce-abc, so that
    // container could never claim.
    const intent = intentFor();
    docker.conflictNextCreate = true;
    docker.raceWinnerLabels = {
      [LABELS.bootstrapFingerprint]: fingerprintOf("nonce-from-elsewhere"),
    };
    const before = nonceIssues;

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(docker.containers.size).toBe(1);
    const fresh = docker.containers.get(containerNameFor(intent, "test-a"));
    expect(fresh?.body.Labels[LABELS.bootstrapFingerprint]).toBe(
      fingerprintOf("nonce-abc"),
    );
    // Only creates mint: one for the lost attempt, one for the replacement.
    expect(nonceIssues - before).toBe(2);
    expect(workerRemovals(docker).map((r) => r.path)).toHaveLength(1);
  });

  test("a race winner is adopted when its credential is the accepted one", async () => {
    // A create whose reply was lost: the daemon has the container from this
    // very request, built with the nonce the registry holds.
    const intent = intentFor();
    docker.conflictNextCreate = true;
    const result = await backend.ensureExecution(intent);
    expect(result).toMatchObject({ created: false, state: "running" });
    expect(workerRemovals(docker)).toHaveLength(0);
  });

  test("a container from before the fingerprint label is adopted as before", async () => {
    // It cannot be judged, and its worker may be mid-claim with a good
    // nonce; the registry is not even asked. A wrong credential on it is
    // left to the expiry path, exactly as before the label existed.
    const intent = intentFor({
      bootstrapCredentialState: async () => {
        throw new Error("must not be consulted for an unlabelled container");
      },
    });
    const body = await createBodyOf(intentFor());
    delete body.Labels[LABELS.bootstrapFingerprint];
    const unlabelled = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toEqual({
      created: false,
      providerRef: unlabelled.id,
      state: "running",
    });
  });

  test("a launch the registry no longer holds tears nothing down", async () => {
    const intent = intentFor({
      bootstrapCredentialState: async () => {
        throw new Error("Launch is released or unknown");
      },
    });
    const body = await createBodyOf(intentFor());
    body.Labels[LABELS.bootstrapFingerprint] = fingerprintOf("whatever");
    docker.add(containerNameFor(intent, "test-a"), body);

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "released or unknown",
    );
    expect(docker.containers.size).toBe(1);
    expect(workerRemovals(docker)).toHaveLength(0);
  });

  test("inspect reports the fingerprint label for the scheduler to judge", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    expect(await backend.inspect(intent)).toMatchObject({
      credentialFingerprint: fingerprintOf("nonce-abc"),
      found: true,
    });
    const body = await createBodyOf(intent);
    delete body.Labels[LABELS.bootstrapFingerprint];
    docker.containers.clear();
    docker.add(containerNameFor(intent, "test-a"), body);
    expect(await backend.inspect(intent)).toMatchObject({
      credentialFingerprint: null,
      found: true,
    });
  });

  test("a registry that accepts no credential adopts nothing", async () => {
    // Revoked after expiry, or never issued: whatever the container holds,
    // there is nothing for it to match.
    const intent = intentFor({
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: null,
      }),
    });
    const body = await createBodyOf(intentFor());
    const orphan = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(docker.byIdOrName(orphan.id)).toBeUndefined();
  });

  test("a claimed launch's container is adopted whatever its label says", async () => {
    // The worker already traded its nonce for a binding. The registry says
    // so, and that is the whole of the judgement: replacing it would kill a
    // bound worker, and adopting never issues a credential.
    const intent = intentFor({
      bootstrapCredentialState: async () => ({ claimed: true }),
    });
    const body = await createBodyOf(intentFor());
    body.Labels[LABELS.bootstrapFingerprint] = fingerprintOf("rotated-away");
    const bound = docker.add(containerNameFor(intent, "test-a"), body);
    const before = nonceIssues;

    const result = await backend.ensureExecution(intent);

    expect(result).toEqual({
      created: false,
      providerRef: bound.id,
      state: "running",
    });
    expect(nonceIssues).toBe(before);
    expect(workerRemovals(docker)).toHaveLength(0);
  });

  test("a credential mismatch on a container that is not ours is a conflict", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.operationId] = "someone-else";
    body.Labels[LABELS.bootstrapFingerprint] = fingerprintOf("theirs");
    docker.add(containerNameFor(intent, "test-a"), body);
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
    expect(docker.containers.size).toBe(1);
  });

  test("the fingerprint label is derived from the credential and never contains it", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const created = docker.containers.get(containerNameFor(intent, "test-a"));
    const labels = created?.body.Labels ?? {};
    expect(labels[LABELS.bootstrapFingerprint]).toBe(
      fingerprintOf("nonce-abc"),
    );
    expect(labels[LABELS.bootstrapFingerprint]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(labels)).not.toContain("nonce-abc");
    // Not even the registry's own lookup key.
    expect(JSON.stringify(labels)).not.toContain(
      Buffer.from(hashWorkerToken("nonce-abc")).toString("hex"),
    );
  });

  test("the registry names a container's credential before the container exists", async () => {
    // The scheduler fences an exit confirmation on this credential
    // a worker can only bind to a container the launch row
    // already names, so a pass holding an older one cannot end its binding.
    const intent = intentFor({
      issueBootstrapNonce: async () => {
        existedAtIssue = docker.containers.has(
          containerNameFor(intent, "test-a"),
        );
        return "nonce-abc";
      },
    });
    let existedAtIssue: boolean | undefined;
    await backend.ensureExecution(intent);
    expect(existedAtIssue).toBe(false);
    expect(
      docker.containers.get(containerNameFor(intent, "test-a"))?.body.Labels?.[
        LABELS.bootstrapFingerprint
      ],
    ).toBe(fingerprintOf("nonce-abc"));
  });

  test("a race lost to a newer contract is refused, not adopted", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    docker.raceWinnerLabels = { [LABELS.isolation]: "9:0123456789abcdef" };
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      IsolationContractError,
    );
  });

  test("a name another launcher keeps taking is a conflict, not a loop", async () => {
    const intent = intentFor();
    // Every create loses, and the winner vanishes before it can be judged.
    docker.conflictEveryCreate = true;
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "taken by another launcher",
    );
    expect(workerCreates(docker)).toHaveLength(2);
  });

  test("a container with the same name but another operation id is a conflict, not adopted", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.operationId] = "someone-else";
    docker.add(containerNameFor(intent, "test-a"), body);
    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
    expect(docker.containers.size).toBe(1);
  });

  test("a container from an older isolation contract is replaced, not adopted", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "1";
    const stale = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(result.providerRef).not.toBe(stale.id);
    expect(docker.containers.size).toBe(1);
    const fresh = docker.containers.get(containerNameFor(intent, "test-a"));
    expect(fresh?.body.Labels[LABELS.isolation]).toBe(
      isolationStampFor(configFor(docker.host)),
    );
  });

  test("a container built on other isolation settings is replaced too", async () => {
    // Same contract version, but the proxy moved: the label has to notice.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = isolationStampFor({
      ...configFor(docker.host),
      egressProxyUrl: "http://egress-proxy-2:3128",
    });
    const stale = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(result.providerRef).not.toBe(stale.id);
  });

  test("a container started with another stop grace is replaced", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = isolationStampFor({
      ...configFor(docker.host),
      stopTimeoutSeconds: configFor(docker.host).stopTimeoutSeconds + 90,
    });
    const stale = docker.add(containerNameFor(intent, "test-a"), body);

    const result = await backend.ensureExecution(intent);

    expect(result).toMatchObject({ created: true, state: "running" });
    expect(result.providerRef).not.toBe(stale.id);
  });

  test("a container from a newer contract is refused, never adopted or replaced", async () => {
    // A rollback can neither trust a boundary it cannot read nor swap it for
    // a weaker one, so it refuses and leaves the container standing.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "9:0123456789abcdef";
    const newer = docker.add(containerNameFor(intent, "test-a"), body);

    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      IsolationContractError,
    );
    await expect(backend.inspect(intent)).rejects.toBeInstanceOf(
      IsolationContractError,
    );
    expect(docker.containers.get(newer.name)?.id).toBe(newer.id);
  });

  test("an older container that is not ours is a conflict, not replaced", async () => {
    const intent = intentFor();
    for (const [label, value] of [
      [LABELS.installation, "someone-else"],
      [LABELS.operationId, "someone-else"],
    ] as const) {
      const body = await createBodyOf(intent);
      body.Labels[LABELS.isolation] = "1";
      body.Labels[label] = value;
      const name = containerNameFor(intent, "test-a");
      docker.containers.clear();
      docker.add(name, body);
      await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
        ExecutionConflictError,
      );
      expect(docker.containers.get(name)?.body.Labels[label]).toBe(value);
    }
  });

  test("a created-but-never-started container is started on the retry", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    seedMountedWorkspace(docker, body, intent.sessionId);
    docker.add(containerNameFor(intent, "test-a"), body, "created");
    const result = await backend.ensureExecution(intent);
    expect(result).toMatchObject({ created: false, state: "running" });
  });

  test("a start the daemon refuses takes the created container away, so the retry creates afresh", async () => {
    const intent = intentFor();
    docker.refuseStarts = true;
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      /OCI runtime create failed.*; the created container was removed$/,
    );
    expect(docker.containers.size).toBe(0);

    docker.refuseStarts = false;
    const retried = await backend.ensureExecution(intent);
    expect(retried).toMatchObject({ created: true, state: "running" });
    expect(nonceIssues).toBe(2);
  });

  test("a refused start of a created-but-never-started container takes it away too", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    seedMountedWorkspace(docker, body, intent.sessionId);
    docker.add(containerNameFor(intent, "test-a"), body, "created");
    docker.refuseStarts = true;
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "the created container was removed",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a start that never answered leaves the container for the next pass to inspect", async () => {
    const client = new DockerClient(docker.host, "v1.44", { timeoutMs: 200 });
    const impatient = new LocalDockerBackend(configFor(docker.host), client);
    const intent = intentFor();
    docker.stallStartsMs = 1_000;
    const refusal = await impatient.ensureExecution(intent).catch((e) => e);
    // Not a launch failure: the scheduler keeps the credential.
    expect(refusal).toBeInstanceOf(LaunchOutcomeUnknownError);
    expect((refusal as Error).cause).toBeInstanceOf(DockerTimeoutError);
    // The start may have taken, so nothing is removed on a guess.
    await Bun.sleep(1_000);
    expect(docker.containers.size).toBe(1);
    docker.stallStartsMs = 0;
    const state = await impatient.inspect(intent);
    expect(state).toMatchObject({ found: true, state: "running" });
  });

  test("a create that never answered is adopted and started by the next ensure, on the same credential", async () => {
    const client = new DockerClient(docker.host, "v1.44", { timeoutMs: 200 });
    const impatient = new LocalDockerBackend(configFor(docker.host), client);
    const intent = intentFor();
    docker.stallCreatesMs = 1_000;
    await expect(impatient.ensureExecution(intent)).rejects.toBeInstanceOf(
      LaunchOutcomeUnknownError,
    );
    await Bun.sleep(1_000);
    docker.stallCreatesMs = 0;
    expect(await impatient.inspect(intent)).toMatchObject({
      found: true,
      state: "pending",
    });

    const retried = await impatient.ensureExecution(intent);
    expect(retried).toMatchObject({ created: false, state: "running" });
    expect(docker.containers.size).toBe(1);
    expect(nonceIssues).toBe(1);
  });

  test("a created container is not started on a workspace that lost its ceiling", async () => {
    // What a create leaves behind when the volume was pruned under it and the
    // cleanup that should have taken the container away did not manage it:
    // the unlabelled, unbounded volume Docker conjures out of a mount spec.
    // Adopting on the contract label alone would start a worker on it.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    docker.addVolume(mountedWorkspaceOf(body), {});
    docker.add(containerNameFor(intent, "test-a"), body, "created");

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "was created under quota <none>",
    );
    // Taken away here, so the next attempt creates one that mounts the
    // workspace this call made rather than inheriting the unbounded one.
    expect(docker.containers.size).toBe(0);
  });
});

describe("LocalDockerBackend.inspect", () => {
  test("maps Docker statuses and reports a missing container as not found", async () => {
    const intent = intentFor();
    expect(await backend.inspect(intent)).toMatchObject({
      found: false,
      providerRef: null,
      state: "unknown",
    });
    const container = docker.add(
      containerNameFor(intent, "test-a"),
      await createBodyOf(intent),
    );
    expect(await backend.inspect(intent)).toMatchObject({
      found: true,
      providerRef: container.id,
      state: "running",
    });
    container.status = "exited";
    container.exitCode = 137;
    expect(await backend.inspect(intent)).toMatchObject({
      exitCode: 137,
      found: true,
      state: "terminated",
    });
  });

  test("an exited worker that failed is reported with the end of its output, read before anything removes it", async () => {
    const intent = intentFor();
    const container = docker.add(
      containerNameFor(intent, "test-a"),
      await createBodyOf(intent),
    );
    container.output = Array.from({ length: 300 }, (_, line) => `line ${line}`);
    container.status = "exited";
    container.exitCode = 0;
    expect((await backend.inspect(intent)).logTail).toBeUndefined();
    expect(docker.requests.some((r) => r.path.endsWith("/logs"))).toBe(false);

    container.exitCode = 1;
    container.oomKilled = true;
    const observed = await backend.inspect(intent);
    expect(observed).toMatchObject({
      exitCode: 1,
      state: "terminated",
      terminationReason: "OOMKilled",
    });
    expect(observed.logTail?.startsWith("line 100\n")).toBe(true);
    expect(observed.logTail?.endsWith("line 299\n")).toBe(true);

    // More than a read can hold: fewer lines, and then only the start of a
    // last line too long to reach the end of.
    container.output = [
      "x".repeat(40_000),
      "y".repeat(40_000),
      "z".repeat(100),
    ];
    expect((await backend.inspect(intent)).logTail).toBe(
      `${"z".repeat(100)}\n`,
    );
    container.output = ["w".repeat(70_000)];
    const cut = (await backend.inspect(intent)).logTail;
    expect(cut?.startsWith("w".repeat(8 * 1024))).toBe(true);
    expect(cut).toContain("[log tail cut:");
  });

  test("a container from an older isolation contract is reported stale", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "1";
    docker.add(containerNameFor(intent, "test-a"), body);
    expect(await backend.inspect(intent)).toMatchObject({
      found: true,
      stale: true,
      state: "running",
    });
  });

  test("a contract-5 container, whose network gives the host an address, is stale", async () => {
    // Its settings are today's; only the contract number moved.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    const [, digest] = isolationStampFor(configFor(docker.host)).split(":");
    body.Labels[LABELS.isolation] = `5:${digest}`;
    docker.add(containerNameFor(intent, "test-a"), body);
    expect(await backend.inspect(intent)).toMatchObject({ stale: true });
  });

  test("a stale container is reported without the workspace being read", async () => {
    // Whether the replacement can be built is `assertReplaceable`'s question,
    // asked by the scheduler before it tears anything down. Answering it here
    // too would make an observation throw on a workspace nobody is replacing.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "1";
    docker.add(containerNameFor(intent, "test-a"), body);
    docker.addVolume(legacyWorkspaceName(intent.sessionId, "test-a"), {});

    expect((await backend.inspect(intent)).stale).toBe(true);
  });

  test("a stale container that already exited reports its exit code", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.isolation] = "1";
    const container = docker.add(containerNameFor(intent, "test-a"), body);
    container.status = "exited";
    container.exitCode = 0;

    expect(await backend.inspect(intent)).toMatchObject({
      exitCode: 0,
      stale: true,
      state: "terminated",
    });
  });

  test("a replacement is refused while the workspace cannot be reused", async () => {
    // The volume an implicit `Mounts` create left behind on the old contract.
    // The scheduler asks this before the teardown, so the refusal is what
    // keeps the running worker alive.
    const intent = intentFor();
    docker.addVolume(legacyWorkspaceName(intent.sessionId, "test-a"), {});

    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      "was created under quota <none>",
    );
  });

  test("a replacement is refused while the image is not on the daemon", async () => {
    // A tag that was removed or repointed between the launch and the upgrade:
    // the create would fail, and by then the old worker would be gone.
    const intent = intentFor();
    docker.images.delete("worker:test");

    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      "is not on this daemon",
    );
  });

  test("a replacement with both an image and a usable workspace is allowed", async () => {
    const intent = intentFor();
    docker.addVolume(
      legacyWorkspaceName(intent.sessionId, "test-a"),
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: intent.sessionId,
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );

    expect(await backend.assertReplaceable(intent)).toBeUndefined();
  });

  test("a replacement for a session with no workspace yet is allowed", async () => {
    expect(await backend.assertReplaceable(intentFor())).toBeUndefined();
  });

  test("a workspace that vanishes during the replacement is not made anew", async () => {
    // `docker volume prune` between the teardown and the create: for that
    // moment no container mounts the volume. Creating a fresh one would look
    // like a launch and read as a session that lost everything it had.
    const intent = intentFor();
    const workspace = legacyWorkspaceName(intent.sessionId, "test-a");
    docker.addVolume(
      workspace,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: intent.sessionId,
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await backend.assertReplaceable(intent);
    docker.volumes.delete(workspace);

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "would start the session on an empty tree",
    );
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  test("a replacement onto the workspace it was checked against launches", async () => {
    const intent = intentFor();
    docker.addVolume(
      legacyWorkspaceName(intent.sessionId, "test-a"),
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: intent.sessionId,
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await backend.assertReplaceable(intent);

    expect(await backend.ensureExecution(intent)).toMatchObject({
      created: true,
      state: "running",
    });
  });

  test("a container on the current contract is not stale", async () => {
    const intent = intentFor();
    docker.add(containerNameFor(intent, "test-a"), await createBodyOf(intent));
    expect((await backend.inspect(intent)).stale).toBeUndefined();
  });

  test("an image that declares its own VOLUME refuses the launch", async () => {
    // Docker gives each declared path a writable anonymous volume: outside
    // the quota, outside the labels, and left behind at termination.
    docker.images.set("worker:test", ["/var/cache", "/data"]);

    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "declares VOLUME /data, /var/cache",
    );
    expect(docker.containers.size).toBe(0);
    // Refused before anything was created for it.
    expect(docker.volumes.size).toBe(0);
  });

  test("the image declaring the workspace path itself is fine", async () => {
    // That target is mounted from the named volume we made, so nothing
    // anonymous comes of it.
    docker.images.set("worker:test", ["/workspace"]);

    await expect(backend.ensureExecution(intentFor())).resolves.toMatchObject({
      created: true,
    });
  });

  test("resolveImage pins the reference to the image id the daemon has", async () => {
    expect(await backend.resolveImage("worker:test")).toBe("sha256:workertest");
    // The id resolves to itself, so a pinned launch can be created again.
    expect(await backend.resolveImage("sha256:workertest")).toBe(
      "sha256:workertest",
    );
    docker.images.set("worker:test", ["/data"]);
    await expect(backend.resolveImage("worker:test")).rejects.toThrow(
      "declares VOLUME",
    );
    await expect(backend.resolveImage("worker:missing")).rejects.toThrow(
      "is not on this daemon",
    );
    // Without an id there is nothing to pin to; the tag is never passed
    // through in its place.
    docker.imagesWithoutId.add("worker:test");
    docker.images.set("worker:test", []);
    await expect(backend.resolveImage("worker:test")).rejects.toThrow(
      "carries no id",
    );
  });

  test("a launch with a stored spec is labelled with it, one without is not", async () => {
    const spec = launchSpecFingerprint("sha256:workertest", RESOURCES);
    const pinned = intentFor({ image: "sha256:workertest", launchSpec: spec });
    await backend.ensureExecution(pinned);
    const created = docker.containers.get(containerNameFor(pinned, "test-a"));
    expect(created?.body.Labels[LABELS.launchSpec]).toBe(spec);
    expect(created?.body.Image).toBe("sha256:workertest");
    expect(await backend.inspect(pinned)).toMatchObject({
      found: true,
      launchSpec: spec,
    });

    const legacy = intentFor({ executionId: "exec-legacy" });
    await backend.ensureExecution(legacy);
    const unlabelled = docker.containers.get(
      containerNameFor(legacy, "test-a"),
    );
    expect(LABELS.launchSpec in (unlabelled?.body.Labels ?? {})).toBe(false);
    expect(await backend.inspect(legacy)).toMatchObject({
      found: true,
      launchSpec: null,
    });
  });

  test("a container built from another spec is refused, never adopted or removed", async () => {
    // It may hold the credential the registry accepts, and a worker may be
    // presenting it right now; only the scheduler's fenced replacement may
    // take it away.
    const intent = intentFor({
      launchSpec: launchSpecFingerprint("worker:test", RESOURCES),
    });
    const body = await createBodyOf(intent);
    body.Labels[LABELS.launchSpec] = launchSpecFingerprint(
      "sha256:other",
      RESOURCES,
    );
    docker.add(containerNameFor(intent, "test-a"), body);
    const before = nonceIssues;

    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      LaunchSpecMismatchError,
    );
    expect(docker.containers.size).toBe(1);
    expect(workerRemovals(docker)).toHaveLength(0);
    expect(nonceIssues).toBe(before);
  });

  test("a container without the spec label is adopted as before", async () => {
    const intent = intentFor({
      launchSpec: launchSpecFingerprint("worker:test", RESOURCES),
    });
    const body = await createBodyOf(intentFor());
    delete body.Labels[LABELS.launchSpec];
    const existing = docker.add(containerNameFor(intent, "test-a"), body);

    expect(await backend.ensureExecution(intent)).toEqual({
      created: false,
      providerRef: existing.id,
      state: "running",
    });
  });

  test("the container is created from the image id that was inspected", async () => {
    // A tag can be repointed between the two calls; the id cannot.
    const intent = intentFor();
    await backend.ensureExecution(intent);

    const created = docker.containers.get(containerNameFor(intent, "test-a"));
    expect(created?.body.Image).toBe("sha256:workertest");
  });

  test("a workspace pruned between the check and the create is not started", async () => {
    // Docker conjures a replacement for the mount — unlabelled, unbounded —
    // and the container would come up on it. Nothing has run in it yet, so it
    // is removed rather than started.
    docker.pruneVolumesOnCreate = true;

    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "disappeared between the check and the container",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("an image the daemon does not have refuses the launch", async () => {
    // Passing the reference through would let a pull that lands between this
    // 404 and the create launch an image nothing looked at — and an image
    // declaring a VOLUME brings a writable volume no ceiling covers.
    docker.images.delete("worker:test");

    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "is not on this daemon",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("terminate takes the container's anonymous volumes with it", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    docker.requests.length = 0;

    await backend.terminate(intent);

    const removal = workerRemovals(docker)[0];
    // Named volumes are untouched by `v`, so the workspace still outlives it.
    expect(removal?.query).toContain("v=true");
    expect(workspaceNameOf(docker, intent.sessionId, "test-a")).toBeDefined();
  });

  test("status mapping covers every Docker state", () => {
    expect(stateOf("created")).toBe("pending");
    expect(stateOf("running")).toBe("running");
    expect(stateOf("restarting")).toBe("running");
    expect(stateOf("paused")).toBe("suspended");
    expect(stateOf("removing")).toBe("terminating");
    expect(stateOf("exited")).toBe("terminated");
    expect(stateOf("dead")).toBe("terminated");
    expect(stateOf("weird")).toBe("unknown");
  });
});

describe("LocalDockerBackend.listManaged", () => {
  test("returns only containers carrying the managed label with parsable ids", async () => {
    const ours = intentFor();
    docker.add(containerNameFor(ours, "test-a"), await createBodyOf(ours));
    const foreign = await createBodyOf(
      intentFor({ executionId: "exec-other" }),
    );
    delete foreign.Labels[LABELS.managed];
    docker.add("someone-elses-container", foreign);
    const broken = await createBodyOf(
      intentFor({ executionId: "exec-broken" }),
    );
    broken.Labels[LABELS.generation] = "not-a-number";
    docker.add("ap-worker-broken", broken);

    expect(await backend.listManaged()).toEqual([
      {
        executionId: ours.executionId,
        generation: 1,
        providerRef: expect.any(String),
        sessionId: ours.sessionId,
        state: "running",
      },
    ]);
  });
});

describe("two installations sharing one daemon", () => {
  test("a same-named foreign container is never reported as ours", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.Labels[LABELS.installation] = "test-b";
    docker.add(containerNameFor(intent, "test-a"), body);
    await expect(backend.inspect(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
  });

  test("resources Docker would read as unlimited are refused", async () => {
    const base = intentFor();
    const cases: Array<[ExecutionResources, string]> = [
      [{ cpus: 1e-10, memoryBytes: 1024, pidsLimit: 8 }, "no CPU limit"],
      [{ cpus: 1, memoryBytes: 0, pidsLimit: 8 }, "memoryBytes"],
      [{ cpus: 1, memoryBytes: 1024, pidsLimit: 0 }, "pidsLimit"],
      [{ cpus: 1, memoryBytes: 1024, pidsLimit: -1 }, "pidsLimit"],
    ];
    for (const [resources, message] of cases) {
      await expect(
        backend.ensureExecution({ ...base, resources }),
      ).rejects.toThrow(message);
    }
    expect(docker.containers.size).toBe(0);
  });

  test("neither lists, adopts nor terminates the other's containers", async () => {
    const intent = intentFor();
    const other = new LocalDockerBackend({
      ...configFor(docker.host),
      installationId: "test-b",
    });
    await backend.ensureExecution(intent);

    expect(await other.listManaged()).toEqual([]);
    expect((await backend.listManaged()).map((m) => m.executionId)).toEqual([
      intent.executionId,
    ]);
    // Same ids (a cloned database) land on distinct names and volumes, so
    // the other installation gets its own container instead of adopting ours.
    const theirs = await other.ensureExecution(intent);
    expect(theirs.created).toBe(true);
    expect(docker.containers.size).toBe(2);
    expect(docker.containers.has(containerNameFor(intent, "test-b"))).toBe(
      true,
    );
    const theirBody = docker.containers.get(containerNameFor(intent, "test-b"));
    expect(theirBody?.body.HostConfig.Mounts[0]?.Source).toBe(
      workspaceNameOf(docker, intent.sessionId, "test-b"),
    );
    expect(await other.inspect(intent)).toMatchObject({ found: true });

    expect(await other.terminate(intent)).toMatchObject({
      outcome: "terminated",
    });
    expect(docker.containers.has(containerNameFor(intent, "test-a"))).toBe(
      true,
    );
    expect(await other.listManaged()).toEqual([]);
    expect(await backend.listManaged()).toHaveLength(1);
  });
});

describe("LocalDockerBackend.terminate", () => {
  test("stops and removes the matching generation only", async () => {
    const gen1 = intentFor({ generation: 1, operationId: "op-1" });
    const gen2 = intentFor({ generation: 2, operationId: "op-2" });
    docker.add(containerNameFor(gen1, "test-a"), await createBodyOf(gen1));
    const kept = docker.add(
      containerNameFor(gen2, "test-a"),
      await createBodyOf(gen2),
    );

    const result = await backend.terminate(gen1);
    expect(result.outcome).toBe("terminated");
    expect(docker.containers.has(containerNameFor(gen1, "test-a"))).toBe(false);
    expect(docker.containers.get(containerNameFor(gen2, "test-a"))).toBe(kept);
    expect(kept.status).toBe("running");
    expect(
      docker.requests.filter(
        (r) => r.path.endsWith("/stop") || r.method === "DELETE",
      ),
    ).toHaveLength(2);
  });

  test("reports a generation mismatch without touching the other generation", async () => {
    const live = intentFor({ generation: 3 });
    const container = docker.add(
      containerNameFor(live, "test-a"),
      await createBodyOf(live),
    );
    const result = await backend.terminate({ ...live, generation: 2 });
    expect(result).toEqual({
      foundGeneration: 3,
      outcome: "generation_mismatch",
    });
    expect(container.status).toBe("running");
    expect(workerRemovals(docker)).toHaveLength(0);
  });

  test("a terminate pinned to a provider id refuses a container that replaced it", async () => {
    const intent = intentFor();
    const first = await backend.ensureExecution(intent);
    const body = await createBodyOf(intent);
    docker.containers.clear();
    const replacement = docker.add(containerNameFor(intent, "test-a"), body);

    expect(
      await backend.terminate(intent, { providerRef: first.providerRef }),
    ).toEqual({
      foundProviderRef: replacement.id,
      outcome: "provider_mismatch",
    });
    expect(docker.containers.size).toBe(1);
    expect(
      await backend.terminate(intent, { providerRef: replacement.id }),
    ).toEqual({ outcome: "terminated", providerRef: replacement.id });
  });

  test("without waitForExit, a worker still draining is left stopping and removed by a later call", async () => {
    const quick = new LocalDockerBackend({
      ...configFor(docker.host),
      requestTimeoutMs: 200,
    });
    const intent = intentFor();
    const name = containerNameFor(intent, "test-a");
    const container = docker.add(name, await createBodyOf(intent));
    docker.draining.add(name);

    expect(await quick.terminate(intent, { waitForExit: false })).toEqual({
      outcome: "stopping",
      providerRef: container.id,
    });
    expect(docker.containers.get(name)).toBe(container);
    expect(workerRemovals(docker)).toHaveLength(0);

    docker.draining.delete(name);
    container.status = "exited";
    expect(await quick.terminate(intent, { waitForExit: false })).toEqual({
      outcome: "terminated",
      providerRef: container.id,
    });
    expect(docker.containers.has(name)).toBe(false);
  });

  test("reports absent when nothing exists for the execution", async () => {
    expect(await backend.terminate(intentFor())).toEqual({ outcome: "absent" });
  });

  test("a label that lies about its generation is not terminated", async () => {
    const intent = intentFor({ generation: 1 });
    const body = await createBodyOf(intent);
    body.Labels[LABELS.generation] = "7";
    docker.add(containerNameFor(intent, "test-a"), body);
    expect(await backend.terminate(intent)).toEqual({
      foundGeneration: 7,
      outcome: "generation_mismatch",
    });
    expect(docker.containers.size).toBe(1);
  });
});

describe("a daemon that accepts the connection but never answers", () => {
  test("every call fails with DockerTimeoutError at the configured deadline", async () => {
    const stalled = Bun.serve({
      fetch: () => new Promise<Response>(() => undefined),
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const client = new DockerClient(
        `tcp://127.0.0.1:${stalled.port}`,
        "v1.44",
        { timeoutMs: 100 },
      );
      const slow = new LocalDockerBackend(
        configFor(`tcp://127.0.0.1:${stalled.port}`),
        client,
      );
      const started = Date.now();
      await expect(slow.inspect(intentFor())).rejects.toBeInstanceOf(
        DockerTimeoutError,
      );
      await expect(slow.ensureExecution(intentFor())).rejects.toBeInstanceOf(
        DockerTimeoutError,
      );
      await expect(slow.listManaged()).rejects.toBeInstanceOf(
        DockerTimeoutError,
      );
      // Three calls at a 100ms deadline. The bound is loose because it only
      // has to catch "the deadline is not honoured at all" — if a timeout
      // never fired the promises would never settle and the test's own
      // deadline would end it. A tighter bound measures the runner, not the
      // client: the same 6x margin in sessions.integration.test.ts read
      // 4524ms against 3000ms on a loaded CI runner.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      stalled.stop(true);
    }
  }, 30_000);

  test("rejects a non-positive deadline", () => {
    expect(
      () => new DockerClient("tcp://127.0.0.1:1", "v1.44", { timeoutMs: 0 }),
    ).toThrow("timeout");
  });
});

describe("LocalDockerBackend worker networks", () => {
  const PROXY = "id-egress-proxy-a";

  function networkOf(intent: LaunchIntent, installationId = "test-a") {
    return docker.networks.get(networkNameFor(intent, installationId));
  }

  test("each execution gets an internal network of its own with the proxy on it", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);

    const network = networkOf(intent);
    expect(network).toMatchObject({
      driver: "bridge",
      // The host keeps no address on it.
      gateway: "",
      internal: true,
      ipv6: false,
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: "1",
        [LABELS.installation]: "test-a",
        [LABELS.sessionId]: intent.sessionId,
        [LABELS.workerNetwork]: "true",
      },
    });
    if (!network) throw new Error("no network");
    // Under the name the worker's HTTP_PROXY dials, or DNS cannot answer it.
    expect(network.attached.get(PROXY)).toEqual({ aliases: ["egress-proxy"] });
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    // Created against the id, so a network recreated under the same name in
    // between cannot stand in for the one that was checked.
    expect(worker?.body.HostConfig.NetworkMode).toBe(network.id);
    expect(Object.values(docker.membersOf(network)).map((m) => m.Name)).toEqual(
      [containerNameFor(intent, "test-a"), "egress-proxy-a"],
    );
  });

  test("two workers never share a network", async () => {
    const first = intentFor();
    const second = intentFor({
      executionId: "exec-second",
      operationId: "op-2",
      sessionId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    await backend.ensureExecution(first);
    await backend.ensureExecution(second);

    const a = networkOf(first);
    const b = networkOf(second);
    if (!a || !b) throw new Error("missing network");
    expect(a.id).not.toBe(b.id);
    expect(Object.keys(docker.membersOf(a))).not.toContain(
      docker.containers.get(containerNameFor(second, "test-a"))?.id,
    );
  });

  test("the same intent again reuses its network instead of making another", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const before = docker.networks.size;
    await backend.ensureExecution(intent);

    expect(docker.networks.size).toBe(before);
    expect(
      docker.requests.filter((r) => r.path === "/networks/create"),
    ).toHaveLength(1);
  });

  test("a network under this execution's name that is not what this host would make is refused", async () => {
    const intent = intentFor();
    const ours = {
      [LABELS.executionId]: intent.executionId,
      [LABELS.generation]: "1",
      [LABELS.installation]: "test-a",
      [LABELS.workerNetwork]: "true",
    };
    const cases: Array<[Partial<FakeNetwork>, string]> = [
      [{ internal: false, labels: ours }, "is not internal"],
      [{ ipv6: true, labels: ours }, "IPv6"],
      [{ driver: "macvlan", labels: ours }, "driver macvlan"],
      [
        { labels: { ...ours, [LABELS.installation]: "test-b" } },
        "is not this execution's",
      ],
      [{ labels: {} }, "is not this execution's"],
    ];
    for (const [overrides, message] of cases) {
      docker.networks.clear();
      docker.addNetwork(networkNameFor(intent, "test-a"), overrides);
      const attempt = backend.ensureExecution(intent);
      await expect(attempt).rejects.toBeInstanceOf(NetworkIsolationError);
      await expect(attempt).rejects.toThrow(message);
    }
    expect(docker.containers.size).toBe(0);
    expect(nonceIssues).toBe(0);
  });

  /**
   * A worker made under contract 5 on the network made with it: the host
   * has an address there, which contract 6 no longer allows.
   */
  async function legacyWorker(
    intent: LaunchIntent,
    stamp = "5:0000000000000000",
  ) {
    const network = docker.addNetwork(networkNameFor(intent, "test-a"), {
      gateway: "10.9.0.1",
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: String(intent.generation),
        [LABELS.installation]: "test-a",
        [LABELS.sessionId]: intent.sessionId,
        [LABELS.workerNetwork]: "true",
      },
      options: {},
    });
    network.attached.set(PROXY, { aliases: ["egress-proxy"] });
    const body = await createBodyOf(intent);
    body.HostConfig.NetworkMode = network.id;
    body.Labels[LABELS.isolation] = stamp;
    const worker = docker.add(containerNameFor(intent, "test-a"), body);
    return { network, worker };
  }

  test("a network that gives the host an address is refused however it got that way", async () => {
    const intent = intentFor();
    const cases: Array<[Partial<FakeNetwork>, string]> = [
      // Made before contract 6, or by hand.
      [{ gateway: "10.9.0.1", options: {} }, "gives the host an address on it"],
      // The mode asked for but not in effect: a daemon that records an
      // option it does not know.
      [
        { gateway: "10.9.0.1", options: { [GATEWAY_MODE_OPTION]: "isolated" } },
        "gateway 10.9.0.1",
      ],
      [
        { options: { [GATEWAY_MODE_OPTION]: "nat" } },
        `${GATEWAY_MODE_OPTION}=nat`,
      ],
    ];
    for (const [overrides, message] of cases) {
      docker.networks.clear();
      docker.containers.clear();
      const { network, worker } = await legacyWorker(intent);
      Object.assign(network, overrides);
      // A current worker: nothing earns this network any grace.
      worker.body.Labels[LABELS.isolation] = isolationStampFor(
        configFor(docker.host),
      );
      const attempt = backend.ensureExecution(intent);
      await expect(attempt).rejects.toBeInstanceOf(NetworkIsolationError);
      await expect(attempt).rejects.toThrow(message);
      expect(docker.containers.get(worker.name)?.id).toBe(worker.id);
    }
  });

  test("a pre-contract-6 network whose worker is gone is made again with the host kept off it", async () => {
    const intent = intentFor();
    const { worker } = await legacyWorker(intent);
    docker.containers.delete(worker.name);

    await backend.ensureExecution(intent);

    expect(networkOf(intent)).toMatchObject({
      gateway: "",
      options: { [GATEWAY_MODE_OPTION]: "isolated" },
    });
    expect(
      docker.requests
        .filter((r) => r.path.startsWith("/networks/"))
        .map((r) => `${r.method} ${r.path}`),
    ).toContain(`DELETE /networks/net-${networkNameFor(intent, "test-a")}`);
    expect(docker.containers.size).toBe(1);
  });

  test("a pre-contract-6 network with a stranger on it is refused, not removed", async () => {
    const intent = intentFor();
    const { network, worker } = await legacyWorker(intent);
    docker.containers.delete(worker.name);
    const stranger = docker.addOther("snooper", {});
    network.attached.set(stranger.id, { aliases: [] });

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "still has members other than the egress proxy (snooper)",
    );
    expect(networkOf(intent)?.gateway).toBe("10.9.0.1");
    expect(network.attached.has(PROXY)).toBe(false);
    expect(docker.containers.size).toBe(0);
  });

  test("a contract-5 worker's replacement keeps its network until the teardown takes both", async () => {
    const intent = intentFor();
    const { worker } = await legacyWorker(intent);

    // The scheduler's order: check, tear down, create.
    await backend.assertReplaceable(intent);
    expect(networkOf(intent)?.gateway).toBe("10.9.0.1");
    expect(docker.containers.get(worker.name)?.id).toBe(worker.id);
    await backend.terminate(intent);
    expect(networkOf(intent)).toBeUndefined();
    await backend.ensureExecution(intent);

    expect(networkOf(intent)).toMatchObject({
      gateway: "",
      options: { [GATEWAY_MODE_OPTION]: "isolated" },
    });
    const replaced = docker.containers.get(worker.name);
    expect(replaced?.id).not.toBe(worker.id);
    expect(replaced?.body.Labels[LABELS.isolation]).toBe(
      isolationStampFor(configFor(docker.host)),
    );
  });

  test("a launch never lands on a pre-contract-6 network its old worker still holds", async () => {
    const intent = intentFor();
    const { worker } = await legacyWorker(intent);

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "gives the host an address on it",
    );
    expect(docker.containers.get(worker.name)?.id).toBe(worker.id);
  });

  test("only a contract-5 worker on that very network earns it the grace", async () => {
    for (const setUp of [
      // Newer than 5 but on a network without the mode: not how this host
      // made it.
      async (intent: LaunchIntent) =>
        legacyWorker(intent, "6:0000000000000000"),
      // Older than 5 belongs on the shared network, handled apart.
      async (intent: LaunchIntent) =>
        legacyWorker(intent, "4:0000000000000000"),
      // A contract-5 worker, but attached to another network than this one.
      async (intent: LaunchIntent) => {
        const made = await legacyWorker(intent);
        made.worker.body.HostConfig.NetworkMode = "net-elsewhere";
        return made;
      },
    ]) {
      docker.networks.clear();
      docker.containers.clear();
      const intent = intentFor();
      await setUp(intent);
      await expect(backend.assertReplaceable(intent)).rejects.toThrow(
        "gives the host an address on it",
      );
    }
  });

  test("an endpoint without this network's id earns the grace only before the worker ever ran", async () => {
    for (const [status, allowed] of [
      ["created", true],
      ["running", false],
      ["exited", false],
    ] as const) {
      docker.networks.clear();
      docker.containers.clear();
      const intent = intentFor();
      const { worker } = await legacyWorker(intent);
      worker.status = status;
      docker.nameOnlyEndpoints.add(worker.id);
      const attempt = backend.assertReplaceable(intent);
      if (allowed) await expect(attempt).resolves.toBeUndefined();
      else await expect(attempt).rejects.toThrow("gives the host an address");
    }
  });

  test("a daemon that ignores the gateway mode gets no worker on the network it made", async () => {
    docker.ignoresGatewayMode = true;
    const intent = intentFor();

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "gives the host an address on it",
    );
    expect(docker.containers.size).toBe(0);
    expect(networkOf(intent)?.attached.has(PROXY)).toBe(false);
  });

  test("a network that gained a stranger is not launched onto", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    await backend.terminate(intent);
    await backend.ensureExecution(intent);
    const stranger = docker.addOther("snooper", {});
    networkOf(intent)?.attached.set(stranger.id, { aliases: [] });
    docker.containers.clear();

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "has members other than its worker and the egress proxy (snooper)",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a same-named container of another launch never gets the proxy", async () => {
    const intent = intentFor();
    const network = docker.addNetwork(networkNameFor(intent, "test-a"), {
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: "1",
        [LABELS.installation]: "test-a",
        [LABELS.workerNetwork]: "true",
      },
    });
    const body = await createBodyOf(intentFor({ operationId: "op-other" }));
    body.HostConfig.NetworkMode = network.id;
    docker.add(containerNameFor(intent, "test-a"), body);

    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
    expect(network.attached.has(PROXY)).toBe(false);
  });

  test("a replacement's network is made ready, proxy and all, before the teardown", async () => {
    const intent = intentFor();
    await backend.assertReplaceable(intent);

    expect(networkOf(intent)?.attached.get(PROXY)).toEqual({
      aliases: ["egress-proxy"],
    });
    expect(docker.containers.size).toBe(0);
  });

  test("a replacement is refused before the teardown when its network cannot be used", async () => {
    const intent = intentFor();
    docker.addNetwork(networkNameFor(intent, "test-a"), {
      internal: false,
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: "1",
        [LABELS.installation]: "test-a",
        [LABELS.workerNetwork]: "true",
      },
    });

    await expect(backend.assertReplaceable(intent)).rejects.toBeInstanceOf(
      NetworkIsolationError,
    );
  });

  test("a create race is judged by the network the racer left behind", async () => {
    const intent = intentFor();
    docker.networkCreateRace = {
      attached: new Map(),
      driver: "bridge",
      gateway: "",
      id: `net-${networkNameFor(intent, "test-a")}`,
      internal: false,
      ipv6: false,
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: "1",
        [LABELS.installation]: "test-a",
        [LABELS.workerNetwork]: "true",
      },
      name: networkNameFor(intent, "test-a"),
      options: { [GATEWAY_MODE_OPTION]: "isolated" },
    };

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "is not internal",
    );
  });

  test("a proxy that joined without its alias is given it", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    networkOf(intent)?.attached.set(PROXY, { aliases: [] });

    await backend.ensureExecution(intent);

    expect(networkOf(intent)?.attached.get(PROXY)).toEqual({
      aliases: ["egress-proxy"],
    });
  });

  test("an attach is judged by what the proxy reports, not by the status code", async () => {
    const intent = intentFor();
    docker.refuseConnects = true;
    // 403 and nothing attached: the worker would have no route out at all.
    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "could not be given the egress proxy",
    );
    expect(docker.containers.size).toBe(0);

    // 403 because it is already there: nothing to do.
    networkOf(intent)?.attached.set(PROXY, { aliases: ["egress-proxy"] });
    await expect(backend.ensureExecution(intent)).resolves.toMatchObject({
      created: true,
    });
  });

  test("a worker attached to another network besides its own is not adopted", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    if (!worker) throw new Error("no worker");
    docker.addNetwork("somewhere-else").attached.set(worker.id, {
      aliases: [],
    });

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "is not the only network",
    );
    // Refused, not destroyed: whoever attached it has to be asked why. But
    // not with the allowlist while it also reaches somewhere else.
    expect(docker.containers.get(worker.name)?.id).toBe(worker.id);
    expect(networkOf(intent)?.attached.has(PROXY)).toBe(false);
  });

  test("a refusal whose proxy detach did not hold says so", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    if (!worker) throw new Error("no worker");
    docker.addNetwork("somewhere-else").attached.set(worker.id, {
      aliases: [],
    });
    docker.refuseDisconnects = true;

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      /is not the only network.*could NOT be detached/,
    );
  });

  test("a refused replacement takes a pre-contract-5 worker off the shared network", async () => {
    const intent = intentFor();
    const body = await createBodyOf(intent);
    docker.addNetwork("werft-worker");
    body.HostConfig.NetworkMode = "werft-worker";
    body.Labels[LABELS.isolation] = "4:0000000000000000";
    const old = docker.add(containerNameFor(intent, "test-a"), body);
    docker.images.delete("worker:test");

    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      /is not on this daemon.*taken off its networks/,
    );
    // Still there for the next pass to replace, but reaching no one.
    expect(docker.containers.get(old.name)?.id).toBe(old.id);
    expect(
      docker.attachmentsOf(old.id, old.body.HostConfig.NetworkMode),
    ).toEqual({});
  });

  test("a refused replacement leaves a claimed pre-contract-5 worker connected", async () => {
    // The scheduler tears a claimed one down itself; cutting it off here
    // would only race that.
    const intent = intentFor({
      bootstrapCredentialState: async () => ({
        claimed: true,
        fingerprint: fingerprintOf("nonce-abc"),
      }),
    });
    const body = await createBodyOf(intent);
    docker.addNetwork("werft-worker");
    body.HostConfig.NetworkMode = "werft-worker";
    body.Labels[LABELS.isolation] = "4:0000000000000000";
    const old = docker.add(containerNameFor(intent, "test-a"), body);
    docker.images.delete("worker:test");

    const refusal = await backend.assertReplaceable(intent).catch((e) => e);
    expect(String(refusal)).toContain("is not on this daemon");
    expect(String(refusal)).not.toContain("taken off");
    expect(
      Object.keys(
        docker.attachmentsOf(old.id, old.body.HostConfig.NetworkMode),
      ),
    ).toEqual(["werft-worker"]);
  });

  test("a pre-contract-5 worker that claims while being cut off gets its network back", async () => {
    let reads = 0;
    const intent = intentFor({
      // Unclaimed when first asked, claimed by the time it is asked again.
      bootstrapCredentialState: async () => {
        reads += 1;
        return { claimed: reads > 1, fingerprint: fingerprintOf("nonce-abc") };
      },
    });
    const body = await createBodyOf(intent);
    docker.addNetwork("werft-worker");
    body.HostConfig.NetworkMode = "werft-worker";
    body.Labels[LABELS.isolation] = "4:0000000000000000";
    const old = docker.add(containerNameFor(intent, "test-a"), body);
    docker.images.delete("worker:test");

    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      "was claimed while being taken off its networks and was put back",
    );
    expect(
      Object.keys(
        docker.attachmentsOf(old.id, old.body.HostConfig.NetworkMode),
      ),
    ).toEqual(["werft-worker"]);
  });

  test("a claimed worker that could not be put back says so", async () => {
    let reads = 0;
    const intent = intentFor({
      bootstrapCredentialState: async () => {
        reads += 1;
        return { claimed: reads > 1, fingerprint: fingerprintOf("nonce-abc") };
      },
    });
    const body = await createBodyOf(intent);
    docker.addNetwork("werft-worker");
    body.HostConfig.NetworkMode = "werft-worker";
    body.Labels[LABELS.isolation] = "4:0000000000000000";
    docker.add(containerNameFor(intent, "test-a"), body);
    docker.images.delete("worker:test");
    docker.refuseConnects = true;

    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      "could NOT be put back on werft-worker",
    );
  });

  test("a refused replacement leaves a worker on its own network where it is", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    if (!worker) throw new Error("no worker");
    docker.images.delete("worker:test");

    await expect(backend.assertReplaceable(intent)).rejects.toThrow(
      "is not on this daemon",
    );
    expect(
      Object.keys(
        docker.attachmentsOf(worker.id, worker.body.HostConfig.NetworkMode),
      ),
    ).toEqual([networkNameFor(intent, "test-a")]);
  });

  test("no proxy means no launch, and nothing is created on the way", async () => {
    docker.others.delete(PROXY);
    const intent = intentFor();

    await expect(backend.ensureExecution(intent)).rejects.toThrow(
      "No running container",
    );
    expect(docker.networks.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(nonceIssues).toBe(0);
  });

  test("a replacement is refused before the teardown when there is no proxy", async () => {
    docker.others.delete(PROXY);
    await expect(backend.assertReplaceable(intentFor())).rejects.toThrow(
      "No running container",
    );
  });

  test("terminate takes the network with the container", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);

    expect(await backend.terminate(intent)).toMatchObject({
      outcome: "terminated",
    });
    expect(networkOf(intent)).toBeUndefined();
  });

  test("a stopped stranger on the network counts, though the inspect does not list it", async () => {
    const intent = intentFor();
    const network = docker.addNetwork(networkNameFor(intent, "test-a"), {
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: "1",
        [LABELS.installation]: "test-a",
        [LABELS.sessionId]: intent.sessionId,
        [LABELS.workerNetwork]: "true",
      },
    });
    const stranger = docker.addOther("sleeper", {}, "exited");
    network.attached.set(stranger.id, { aliases: [] });

    await expect(backend.ensureExecution(intent)).rejects.toThrow("sleeper");
    expect(network.attached.has(PROXY)).toBe(false);
    expect(docker.containers.size).toBe(0);
  });

  test("a launcher that takes the name after the check leaves the network without the proxy", async () => {
    const intent = intentFor();
    docker.conflictNextCreate = true;
    docker.raceWinnerLabels = { [LABELS.operationId]: "op-other" };

    await expect(backend.ensureExecution(intent)).rejects.toBeInstanceOf(
      ExecutionConflictError,
    );
    expect(networkOf(intent)?.attached.has(PROXY)).toBe(false);
  });

  test("terminate leaves a network something else still holds, and still terminates", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const stranger = docker.addOther("snooper", {});
    networkOf(intent)?.attached.set(stranger.id, { aliases: [] });

    expect(await backend.terminate(intent)).toMatchObject({
      outcome: "terminated",
    });
    // Kept for someone to look at, but without this installation's proxy:
    // whatever joined it does not get the allowlist.
    expect(networkOf(intent)).toBeDefined();
    expect(networkOf(intent)?.attached.has(PROXY)).toBe(false);
  });
});

describe("LocalDockerBackend.reconcileNetworks", () => {
  const PROXY = "id-egress-proxy-a";

  test("the network of a container that was force-removed is removed", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    docker.containers.clear();

    const result = await backend.reconcileNetworks();

    expect(result).toEqual({
      failed: [],
      removed: [networkNameFor(intent, "test-a")],
      repaired: [],
    });
    expect(docker.networks.size).toBe(0);
  });

  test("a network whose container still exists is kept, even if it has stopped", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    if (worker) worker.status = "exited";

    expect(await backend.reconcileNetworks()).toEqual({
      failed: [],
      removed: [],
      repaired: [],
    });
    expect(docker.networks.has(networkNameFor(intent, "test-a"))).toBe(true);
  });

  test("a recreated proxy is put back on every live worker's network", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    // `compose up` recreating the proxy: new id, attached to none of them.
    docker.others.delete(PROXY);
    docker.addOther("egress-proxy-a-new", { [LABELS.egressProxy]: "test-a" });

    const result = await backend.reconcileNetworks();

    expect(result.repaired).toEqual([networkNameFor(intent, "test-a")]);
    expect(
      docker.networks
        .get(networkNameFor(intent, "test-a"))
        ?.attached.get("id-egress-proxy-a-new"),
    ).toEqual({ aliases: ["egress-proxy"] });
  });

  test("another installation's networks are neither removed nor repaired", async () => {
    const intent = intentFor();
    const other = new LocalDockerBackend({
      ...configFor(docker.host),
      installationId: "test-b",
    });
    await other.ensureExecution(intent);
    docker.containers.clear();

    expect(await backend.reconcileNetworks()).toEqual({
      failed: [],
      removed: [],
      repaired: [],
    });
    expect(docker.networks.has(networkNameFor(intent, "test-b"))).toBe(true);
  });

  test("an orphan with a stranger on it is kept and reported, the proxy taken off", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    docker.containers.clear();
    const stranger = docker.addOther("snooper", {});
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    network?.attached.set(stranger.id, { aliases: [] });

    const result = await backend.reconcileNetworks();

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([
      {
        error: expect.stringMatching(/snooper.*egress proxy was detached/),
        id: networkNameFor(intent, "test-a"),
      },
    ]);
    expect(network?.attached.has(PROXY)).toBe(false);
    expect(network?.attached.has(stranger.id)).toBe(true);
  });

  test("a live network that gained a stranger is reported and loses the proxy", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const stranger = docker.addOther("snooper", {});
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    network?.attached.set(stranger.id, { aliases: [] });

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringContaining("snooper"),
        id: networkNameFor(intent, "test-a"),
      },
    ]);
    expect(network?.attached.has(PROXY)).toBe(false);
  });

  test("a worker that also joined another network is reported", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    if (!worker) throw new Error("no worker");
    docker.addNetwork("somewhere-else").attached.set(worker.id, {
      aliases: [],
    });

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringContaining("is not the only network"),
        id: networkNameFor(intent, "test-a"),
      },
    ]);
  });

  test("a network made ready for a replacement is left alone while the old worker runs", async () => {
    // The old-contract container still has the name and sits on the old
    // shared network; its replacement's network was made before teardown.
    const intent = intentFor();
    const body = await createBodyOf(intent);
    body.HostConfig.NetworkMode = "werft-worker";
    body.Labels[LABELS.isolation] = "4:0000000000000000";
    docker.add(containerNameFor(intent, "test-a"), body);
    await backend.assertReplaceable(intent);

    expect(await backend.reconcileNetworks()).toEqual({
      failed: [],
      removed: [],
      repaired: [],
    });
  });

  test("a contract-5 worker's network keeps the proxy until the worker goes", async () => {
    // A claimed worker is drained without a replacement check; the reconcile
    // must not cut its egress first.
    const intent = intentFor();
    const network = docker.addNetwork(networkNameFor(intent, "test-a"), {
      gateway: "10.9.0.1",
      labels: {
        [LABELS.executionId]: intent.executionId,
        [LABELS.generation]: "1",
        [LABELS.installation]: "test-a",
        [LABELS.workerNetwork]: "true",
      },
      options: {},
    });
    network.attached.set(PROXY, { aliases: ["egress-proxy"] });
    const body = await createBodyOf(intent);
    body.HostConfig.NetworkMode = network.id;
    body.Labels[LABELS.isolation] = "5:0000000000000000";
    docker.add(containerNameFor(intent, "test-a"), body);

    expect(await backend.reconcileNetworks()).toEqual({
      failed: [],
      removed: [],
      repaired: [],
    });
    expect(network.attached.has(PROXY)).toBe(true);
  });

  test("a current worker's network that gives the host an address loses the proxy", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    if (!network) throw new Error("no network");
    network.gateway = "10.9.0.1";

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringContaining("gives the host an address on it"),
        id: network.name,
      },
    ]);
    expect(network.attached.has(PROXY)).toBe(false);
  });

  test("a stopped stranger keeps an orphan in place and the proxy off it", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    docker.containers.clear();
    const stranger = docker.addOther("sleeper", {}, "exited");
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    network?.attached.set(stranger.id, { aliases: [] });

    const result = await backend.reconcileNetworks();

    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([
      {
        error: expect.stringMatching(/sleeper.*egress proxy was detached/),
        id: networkNameFor(intent, "test-a"),
      },
    ]);
    expect(network?.attached.has(PROXY)).toBe(false);
  });

  test("a stopped proxy is taken off an orphan so the network can go", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    docker.containers.clear();
    const old = docker.addOther(
      "egress-proxy-a-old",
      { [LABELS.egressProxy]: "test-a" },
      "exited",
    );
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    network?.attached.set(old.id, { aliases: ["egress-proxy"] });

    const result = await backend.reconcileNetworks();

    expect(result).toEqual({
      failed: [],
      removed: [networkNameFor(intent, "test-a")],
      repaired: [],
    });
  });

  test("a current worker that left its network for another is reported, the proxy taken off", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const worker = docker.containers.get(containerNameFor(intent, "test-a"));
    if (!worker) throw new Error("no worker");
    worker.body.HostConfig.NetworkMode = "net-somewhere-else";
    docker.addNetwork("somewhere-else");
    const network = docker.networks.get(networkNameFor(intent, "test-a"));

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringContaining("is not the only network"),
        id: networkNameFor(intent, "test-a"),
      },
    ]);
    expect(network?.attached.has(PROXY)).toBe(false);
  });

  test("an execution's labels on a network of another name do not earn it the proxy", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const own = docker.networks.get(networkNameFor(intent, "test-a"));
    const copy = docker.addNetwork("lookalike", { labels: { ...own?.labels } });

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringContaining("under another name"),
        id: "lookalike",
      },
    ]);
    expect(copy.attached.has(PROXY)).toBe(false);
  });

  test("a stopped predecessor proxy is taken off a live network, the running one kept", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const old = docker.addOther(
      "egress-proxy-a-old",
      { [LABELS.egressProxy]: "test-a" },
      "exited",
    );
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    network?.attached.set(old.id, { aliases: ["egress-proxy"] });

    const result = await backend.reconcileNetworks();

    expect(result).toEqual({
      failed: [],
      removed: [],
      repaired: [networkNameFor(intent, "test-a")],
    });
    expect(network?.attached.has(old.id)).toBe(false);
    expect(network?.attached.has(PROXY)).toBe(true);
  });

  test("two running proxies cost every live network all of them", async () => {
    const intent = intentFor();
    await backend.ensureExecution(intent);
    const second = docker.addOther("egress-proxy-a-2", {
      [LABELS.egressProxy]: "test-a",
    });
    const network = docker.networks.get(networkNameFor(intent, "test-a"));
    network?.attached.set(second.id, { aliases: ["egress-proxy"] });

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringMatching(
          /2 running containers carry.*egress proxy was detached/,
        ),
        id: networkNameFor(intent, "test-a"),
      },
    ]);
    expect(network?.attached.has(PROXY)).toBe(false);
    expect(network?.attached.has(second.id)).toBe(false);
  });

  test("a labelled network that names no execution is reported, not guessed at", async () => {
    const mystery = docker.addNetwork("werft-net-test-a-mystery", {
      labels: {
        [LABELS.installation]: "test-a",
        [LABELS.workerNetwork]: "true",
      },
    });
    const stranger = docker.addOther("snooper", {});
    mystery.attached.set(stranger.id, { aliases: [] });
    mystery.attached.set(PROXY, { aliases: ["egress-proxy"] });

    const result = await backend.reconcileNetworks();

    expect(result.failed).toEqual([
      {
        error: expect.stringMatching(
          /names no execution.*egress proxy was detached/,
        ),
        id: "werft-net-test-a-mystery",
      },
    ]);
    expect(docker.networks.has("werft-net-test-a-mystery")).toBe(true);
    expect(mystery.attached.has(PROXY)).toBe(false);
    expect(mystery.attached.has(stranger.id)).toBe(true);
  });

  test("without a proxy, orphans are still removed and live networks reported", async () => {
    const live = intentFor();
    const gone = intentFor({
      executionId: "exec-gone",
      operationId: "op-gone",
      sessionId: "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    await backend.ensureExecution(live);
    await backend.ensureExecution(gone);
    docker.containers.delete(containerNameFor(gone, "test-a"));
    docker.others.delete(PROXY);
    for (const network of docker.networks.values()) network.attached.clear();

    const result = await backend.reconcileNetworks();

    expect(result.removed).toEqual([networkNameFor(gone, "test-a")]);
    expect(result.failed).toEqual([
      {
        error: expect.stringContaining("No running container"),
        id: networkNameFor(live, "test-a"),
      },
    ]);
  });
});

describe("names", () => {
  test("container and volume names are deterministic and validated", () => {
    expect(
      containerNameFor({ executionId: "exec-1", generation: 2 }, "test-a"),
    ).toBe("ap-worker-test-a-exec-1-g2");
    expect(workspaceVolumePrefixFor("s-1", naming("test-a"))).toBe(
      "werft-ws-test-a-s-1-",
    );
    expect(() =>
      containerNameFor({ executionId: "../x", generation: 1 }, "test-a"),
    ).toThrow();
    expect(() => workspaceVolumePrefixFor("a b", naming("test-a"))).toThrow();
  });
});

/** Runs a throwaway backend against a throwaway daemon to capture the body. */
function imageIdOf(tag: string): string {
  return `sha256:${tag.replace(/[^a-z0-9]/g, "")}`;
}

async function createBodyOf(
  intent: LaunchIntent,
): Promise<ContainerCreateBody> {
  const scratch = new FakeDocker();
  scratch.start();
  try {
    await new LocalDockerBackend(configFor(scratch.host)).ensureExecution(
      intent,
    );
    const [container] = scratch.containers.values();
    if (!container) throw new Error("no container created");
    return JSON.parse(JSON.stringify(container.body));
  } finally {
    scratch.stop();
  }
}

describe("LocalDockerBackend.verifyNetworkIsolation", () => {
  test("one running proxy labelled for this installation passes", async () => {
    await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
  });

  test("no proxy of this installation refuses the launch", async () => {
    docker.others.delete("id-egress-proxy-a");
    // Another installation's proxy is no stand-in: its allowlist is not ours.
    await expect(backend.verifyNetworkIsolation()).rejects.toThrow(
      `No running container carries ${LABELS.egressProxy}=test-a`,
    );
  });

  test("a stopped proxy is no proxy", async () => {
    const proxy = docker.others.get("id-egress-proxy-a");
    if (!proxy) throw new Error("fixture has no proxy");
    proxy.status = "exited";
    await expect(backend.verifyNetworkIsolation()).rejects.toThrow(
      "No running container",
    );
  });

  test("two proxies for one installation refuse the launch", async () => {
    docker.addOther("egress-proxy-a2", { [LABELS.egressProxy]: "test-a" });
    await expect(backend.verifyNetworkIsolation()).rejects.toThrow(
      "exactly one proxy",
    );
  });

  test("a daemon older than Docker 28 refuses the launch", async () => {
    for (const version of ["1.47", "1.9", "0.99", "", "v1.48", "1.48.0"]) {
      docker.apiVersion = version;
      const attempt = backend.verifyNetworkIsolation();
      await expect(attempt).rejects.toBeInstanceOf(GatewayModeUnsupportedError);
      await expect(attempt).rejects.toThrow("Docker 28 (API 1.48) or later");
    }
  });

  test("Docker 28 and later pass", async () => {
    for (const version of ["1.48", "1.52", "2.0"]) {
      docker.apiVersion = version;
      await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
    }
  });

  test("the isolation stamp tracks the bucket and region the worker names", () => {
    const base = configFor("tcp://127.0.0.1:1");
    const stamp = isolationStampFor(base);
    expect(stamp.startsWith("7:")).toBe(true);
    for (const change of [
      { bucket: "other-bucket" },
      { region: "us-east-1" },
    ]) {
      expect(
        isolationStampFor({
          ...base,
          objectStore: { ...base.objectStore, ...change },
        }),
      ).not.toBe(stamp);
    }
  });

  test("a worker is handed no object store credential or endpoint", () => {
    // Built the way the scheduler builds it, from an environment that holds
    // the control host's own key: none of it reaches the container.
    const config = localDockerConfigFromEnv({
      AWS_ACCESS_KEY_ID: "control-host-key-id",
      AWS_ENDPOINT_URL: "http://localstack:4566",
      AWS_REGION: "ap-northeast-1",
      AWS_SECRET_ACCESS_KEY: "control-host-secret",
      AWS_SESSION_TOKEN: "control-host-session",
      EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
      S3_BUCKET: "claude-sessions",
      WORKER_GATEWAY_URL: "http://host.docker.internal:3000",
      WORKER_IMAGE: "werft-worker:dev",
    } as Parameters<typeof localDockerConfigFromEnv>[0]);
    const launched = workerEnvironmentFor(
      config,
      { executionId: "exec-1", generation: 1, sessionId: "s-1" },
      "wln-nonce",
    );
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_ENDPOINT_URL",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(launched.filter((entry) => entry.startsWith(`${name}=`))).toEqual(
        [],
      );
    }
    for (const entry of launched) expect(entry).not.toContain("control-host");
  });

  test("a daemon reply that quotes the create body reaches the caller without the secrets", async () => {
    docker.echoNextCreate = true;
    let caught: unknown;
    try {
      await backend.ensureExecution(
        intentFor({ issueBootstrapNonce: async () => "nonce-secret-xyz" }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DockerApiError);
    const error = caught as DockerApiError;
    expect(error.status).toBe(400);
    // The daemon really did echo the body, so the redaction is not vacuous.
    expect(error.message).toContain(`${ENV.objectBucket}=claude-sessions`);
    expect(error.message).toContain(`${ENV.bootstrapNonce}=[redacted]`);
    for (const text of [error.message, error.body, JSON.stringify(error)]) {
      expect(text).not.toContain("nonce-secret-xyz");
    }
  });
});

describe("LocalDockerBackend workspace volumes", () => {
  /** A workspace under the name sessions derived before names were single-use. */
  const legacyName = legacyWorkspaceName(intentFor().sessionId, "test-a");
  /** One this host made: found by its labels, whatever the suffix says. */
  const ourName = `${workspaceVolumePrefixFor(intentFor().sessionId, naming("test-a"))}0f1e2d3c`;

  function backendWith(
    overrides: Partial<LocalDockerBackendConfig>,
  ): LocalDockerBackend {
    return new LocalDockerBackend({ ...configFor(docker.host), ...overrides });
  }

  test("the volume is created, labelled and bounded before the container", async () => {
    await backend.ensureExecution(intentFor());
    const volume = docker.volumes.get(
      workspaceNameOf(docker, intentFor().sessionId, "test-a") ?? "",
    );
    expect(volume?.options).toEqual({ size: String(QUOTA_BYTES) });
    expect(volume?.labels).toEqual({
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [LABELS.sessionId]: intentFor().sessionId,
      [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
    // Naming a volume in `Mounts` is enough for Docker to conjure an
    // unlabelled, unbounded one, so the order is the whole point.
    const paths = docker.requests.map((r) => r.path);
    expect(paths.indexOf("/volumes/create")).toBeLessThan(
      paths.indexOf("/containers/create"),
    );
  });

  test("an unlabelled volume from before the quota refuses the launch", async () => {
    // Exactly what an implicit `Mounts` create leaves behind: no labels, no
    // size, and no way to put one on it now.
    docker.addVolume(legacyName, {});
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "was created under quota <none>",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a volume created under another ceiling refuses the launch", async () => {
    docker.addVolume(
      ourName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: intentFor().sessionId,
        [VOLUME_LABELS.workspaceQuota]: "enforced:123",
      },
      { size: "123" },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "was created under quota enforced:123",
    );
  });

  test("a volume labelled ours but without the driver option refuses the launch", async () => {
    docker.addVolume(ourName, {
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [LABELS.sessionId]: intentFor().sessionId,
      [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "driver option size=<none>",
    );
  });

  test("another installation's volume under our name refuses the launch", async () => {
    docker.addVolume(legacyName, {
      [LABELS.installation]: "test-b",
      [LABELS.managed]: "true",
      [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "belongs to installation test-b",
    );
  });

  test("the right ceiling on the wrong session's volume refuses the launch", async () => {
    // Mounting it would hand this session someone else's working tree, and
    // GC reads the same label, so the mislabelled volume would also outlive
    // the session it actually belongs to.
    docker.addVolume(
      legacyName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: "some-other-session",
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "is not this session's workspace",
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a volume that is not managed refuses the launch", async () => {
    docker.addVolume(
      legacyName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.sessionId]: intentFor().sessionId,
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "managed=<none>",
    );
  });

  test("with the quota off the volume is created without a size", async () => {
    const off = backendWith({ workspaceQuota: { mode: "off" } });
    await off.ensureExecution(intentFor());
    const volume = docker.volumes.get(
      workspaceNameOf(docker, intentFor().sessionId, "test-a") ?? "",
    );
    expect(volume?.options).toBeNull();
    expect(volume?.labels[VOLUME_LABELS.workspaceQuota]).toBe("off");
  });

  test("a labelled workspace beside the legacy one refuses the launch", async () => {
    // An unfinished migration: the copy exists, the source was never
    // removed, so nothing says the copy is whole.
    docker.addVolume(legacyName, {});
    docker.addVolume(
      ourName,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [VOLUME_LABELS.migratedFrom]: legacyName,
        [LABELS.sessionId]: intentFor().sessionId,
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "finish the migration",
    );
    await expect(backend.assertReplaceable(intentFor())).rejects.toThrow(
      "finish the migration",
    );
    expect(docker.containers.size).toBe(0);

    // Once the source is gone the copy is the session's workspace.
    docker.volumes.delete(legacyName);
    await backend.ensureExecution(intentFor());
    expect(
      mountedWorkspaceOf(
        docker.containers.values().next().value?.body as ContainerCreateBody,
      ),
    ).toBe(ourName);
  });

  test("turning the quota on over an opted-out volume refuses the launch", async () => {
    await backendWith({ workspaceQuota: { mode: "off" } }).ensureExecution(
      intentFor(),
    );
    docker.containers.clear();
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "was created under quota off",
    );
  });
});

describe("LocalDockerBackend workspace inode limit", () => {
  const sessionId = intentFor().sessionId;

  test("every launch sets the limit on its workspace before the worker exists", async () => {
    await backend.ensureExecution(intentFor());
    const workspace = workspaceNameOf(docker, sessionId, "test-a");
    expect(docker.inodeHelperRuns).toHaveLength(1);
    const helper = docker.inodeHelperRuns[0] as ContainerCreateBody;
    // Mounted where the worker mounts it and never seeding it: the image's
    // `VOLUME /workspace` gets no anonymous twin, and the worker's first
    // mount still copies the directory's ownership in.
    expect(helper.HostConfig.Mounts).toEqual([
      {
        Source: workspace ?? "",
        Target: "/workspace",
        Type: "volume",
        VolumeOptions: { NoCopy: true },
      },
    ]);
    expect(helper.Entrypoint?.slice(-2)).toEqual([
      String(QUOTA_INODES),
      "/workspace",
    ]);
    // quotactl and the device node, nothing else, and no way out.
    expect(helper.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(helper.HostConfig.CapAdd).toEqual(["MKNOD", "SYS_ADMIN"]);
    expect(helper.HostConfig.NetworkMode).toBe("none");
    expect(helper.HostConfig.ReadonlyRootfs).toBe(true);
    expect("Privileged" in helper.HostConfig).toBe(false);
    // From the configured image, by the id it was inspected as.
    expect(helper.Image).toBe(imageIdOf("worker:test"));
    // And it removed itself; only the worker is left.
    expect(docker.containers.size).toBe(1);
    const paths = docker.requests.map((r) => r.path + r.query);
    expect(paths.findIndex((p) => p.includes("name=ap-inodes-"))).toBeLessThan(
      paths.findIndex((p) => p.includes("name=ap-worker-")),
    );
  });

  test("the helper runs from the scheduler's image, never the launch's", async () => {
    // A launch's image comes from a catalog entry; the helper holds
    // CAP_SYS_ADMIN, so which image gets that is not the catalog's call.
    docker.images.set("catalog:other", []);
    await backend.ensureExecution(intentFor({ image: "catalog:other" }));
    expect(docker.inodeHelperRuns[0]?.Image).toBe(imageIdOf("worker:test"));
  });

  test("a workspace from before the limit gets it on its next launch", async () => {
    // Its label only ever recorded bytes, which is all it had; the inode
    // limit can be set in place, so the volume is not refused for lacking it.
    docker.addVolume(
      `${workspaceVolumePrefixFor(sessionId, naming("test-a"))}0ld0ld00`,
      {
        [LABELS.installation]: "test-a",
        [LABELS.managed]: "true",
        [LABELS.sessionId]: sessionId,
        [VOLUME_LABELS.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
    await backend.ensureExecution(intentFor());
    expect(
      docker.inodeHelperRuns.map((run) => run.HostConfig.Mounts[0]?.Source),
    ).toEqual([
      `${workspaceVolumePrefixFor(sessionId, naming("test-a"))}0ld0ld00`,
    ]);
  });

  test("a limit that does not hold refuses the launch and starts no worker", async () => {
    docker.inodeHelperExit = 14;
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      WorkspaceQuotaError,
    );
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "has no inode limit: xfs_quota did not leave the limit in force",
    );
    expect(docker.containers.size).toBe(0);
    expect(workerCreates(docker)).toHaveLength(0);
  });

  test("an image without xfsprogs is named as the reason", async () => {
    docker.inodeHelperExit = 127;
    await expect(backend.ensureExecution(intentFor())).rejects.toThrow(
      "the helper image has no xfsprogs",
    );
  });

  test("a replacement is refused before teardown when the workspace cannot take the limit", async () => {
    // The labels and the size option all match; only setting the limit can
    // tell, and it has to tell while the old worker is still there.
    await backend.ensureExecution(intentFor());
    const running = docker.containers.size;
    docker.inodeHelperExit = 12;
    await expect(backend.assertReplaceable(intentFor())).rejects.toThrow(
      "has no inode limit: the volume has no xfs project of its own",
    );
    expect(docker.containers.size).toBe(running);
  });

  test("an opted-out host runs no helper", async () => {
    await new LocalDockerBackend({
      ...configFor(docker.host),
      workspaceQuota: { mode: "off" },
    }).ensureExecution(intentFor());
    expect(docker.inodeHelperRuns).toHaveLength(0);
  });

  test("a helper a dead process left behind is removed once it is old, not before", async () => {
    const helper = (name: string, created: number) => {
      const body = {
        Env: [],
        HostConfig: {
          CapDrop: ["ALL"],
          Memory: 0,
          Mounts: [],
          NanoCpus: 0,
          NetworkMode: "none",
          PidsLimit: 0,
          ReadonlyRootfs: true,
          RestartPolicy: { Name: "no" as const },
          SecurityOpt: [],
          Tmpfs: {},
        },
        Image: imageIdOf("worker:test"),
        Labels: { [INODE_HELPER_LABEL]: "test-a" },
        User: "0:0",
      };
      const added = docker.add(name, body, "exited");
      added.created = created;
      return added;
    };
    const now = Math.floor(Date.now() / 1000);
    helper("ap-inodes-test-a-old00000", now - 3600);
    // Young: another process's helper, still in the middle of its run.
    helper("ap-inodes-test-a-young000", now - 5);
    await backend.ensureExecution(intentFor());
    expect(docker.containers.has("ap-inodes-test-a-old00000")).toBe(false);
    expect(docker.containers.has("ap-inodes-test-a-young000")).toBe(true);
  });
});

describe("LocalDockerBackend.verifyWorkspaceQuota", () => {
  const probePrefix = "ap-quota-probe-test-a-";
  const probesLeft = () =>
    [...docker.volumes.keys()].filter((name) => name.startsWith(probePrefix));

  test("a quota-capable daemon passes and keeps no probe volume", async () => {
    await expect(backend.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(probesLeft()).toEqual([]);
  });

  test("the probe proves the inode limit too, on the probe volume", async () => {
    await backend.verifyWorkspaceQuota();
    expect(docker.inodeHelperRuns).toHaveLength(1);
    expect(docker.inodeHelperRuns[0]?.HostConfig.Mounts[0]?.Source).toStartWith(
      probePrefix,
    );
    expect(docker.containers.size).toBe(0);
  });

  test("a daemon that cannot hold the inode limit refuses to start, naming the opt-out", async () => {
    docker.inodeHelperExit = 1;
    const refusal = backend.verifyWorkspaceQuota();
    await expect(refusal).rejects.toBeInstanceOf(
      WorkspaceQuotaUnsupportedError,
    );
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      /inode limit: .*CAP_SYS_ADMIN.*EXECUTION_WORKSPACE_QUOTA=off/,
    );
    // Refused or not, the probe does not outlive the check.
    expect(probesLeft()).toEqual([]);
    expect(docker.containers.size).toBe(0);
  });

  test("a helper image this daemon does not have refuses to start", async () => {
    docker.images.delete("worker:test");
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "Image worker:test is not on this daemon",
    );
    expect(probesLeft()).toEqual([]);
  });

  test("a daemon with no quota support refuses to start, naming the opt-out", async () => {
    docker.quotaSupported = false;
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "EXECUTION_WORKSPACE_QUOTA=off",
    );
  });

  test("a probe volume left by an earlier run cannot make the probe pass", async () => {
    // The leftover goes first — by its labels, since the new probe takes a
    // name of its own — so the daemon still has to answer the create.
    docker.quotaSupported = false;
    docker.addVolume(
      `${probePrefix}aaaaaaaa`,
      {
        [LABELS.installation]: "test-a",
        [VOLUME_LABELS.quotaProbe]: "true",
      },
      { size: String(QUOTA_BYTES) },
    );
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "cannot put a size and inode quota",
    );
    expect(probesLeft()).toEqual([]);
  });

  test("a young probe is another preflight's, mid-run, and is left alone", async () => {
    // Only the old leftover is an interrupted run's. The preflight runs
    // outside the pass lock, so a young one may still be in use.
    const labels = {
      [LABELS.installation]: "test-a",
      [VOLUME_LABELS.quotaProbe]: "true",
    };
    docker.addVolume(`${probePrefix}old00000`, labels);
    docker.addVolume(
      `${probePrefix}young000`,
      labels,
      null,
      new Date(Date.now() - 5_000).toISOString(),
    );
    await expect(backend.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(probesLeft()).toEqual([`${probePrefix}young000`]);
  });

  test("nothing but the helper's create stands between the probe and its helper", async () => {
    // The stray-probe age is bounded by this: until a container references
    // the probe, another preflight's sweep could take it.
    await backend.verifyWorkspaceQuota();
    const paths = docker.requests.map((r) => r.path);
    expect(paths[paths.indexOf("/volumes/create") + 1]).toBe(
      "/containers/create",
    );
  });

  test("a long request timeout keeps a probe young for longer", async () => {
    // Twenty one-minute requests: a 15-minute-old probe may still be live.
    const patient = new LocalDockerBackend({
      ...configFor(docker.host),
      requestTimeoutMs: 60_000,
    });
    docker.addVolume(
      `${probePrefix}slow0000`,
      { [LABELS.installation]: "test-a", [VOLUME_LABELS.quotaProbe]: "true" },
      null,
      new Date(Date.now() - 15 * 60_000).toISOString(),
    );
    await expect(patient.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(probesLeft()).toEqual([`${probePrefix}slow0000`]);
  });

  test("two preflights at once both pass", async () => {
    // The second one's stray sweep lands between the first one's probe and
    // its helper, e.g. a standalone --once beside the loop's pass.
    let release = () => {};
    docker.holdHelperCreates = new Promise((resolve) => {
      release = resolve;
    });
    const probeCreates = () =>
      docker.requests.filter((r) => r.path === "/volumes/create").length;
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + 5_000;
      while (!done() && Date.now() < deadline) await Bun.sleep(1);
      expect(done()).toBe(true);
    };
    const first = backend.verifyWorkspaceQuota();
    await until(() => probesLeft().length === 1);
    const second = backend.verifyWorkspaceQuota();
    // Its create is asked for only once its sweep is done.
    await until(() => probeCreates() === 2);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(docker.inodeHelperRuns).toHaveLength(2);
    expect(probesLeft()).toEqual([]);
  });

  test("a volume that is not a probe is not this host's to remove", async () => {
    // The preflight is not a licence to delete a stranger's data on a shared
    // daemon, so what it cleans up is only what its own labels claim.
    docker.addVolume("someone-elses-data", { "com.example.owner": "them" });
    await expect(backend.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(docker.volumes.has("someone-elses-data")).toBe(true);
  });

  test("another installation's probe is not this one's to remove", async () => {
    const theirs = "ap-quota-probe-test-b-bbbbbbbb";
    docker.addVolume(theirs, {
      [LABELS.installation]: "test-b",
      [VOLUME_LABELS.quotaProbe]: "true",
    });
    await expect(backend.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(docker.volumes.has(theirs)).toBe(true);
  });

  test("a create that answers with someone else's volume proves nothing", async () => {
    // Whatever name the probe picks, the reply is what says whose volume it
    // is: an existing name comes back as the volume it already was.
    docker.createReturnsLabels = { "com.example.owner": "them" };
    await expect(backend.verifyWorkspaceQuota()).rejects.toThrow(
      "is not this host's quota probe",
    );
    // And it is still there: the probe does not clear up after a stranger.
    expect(docker.volumes.size).toBe(1);
  });

  test("the probe volume carries no managed label for GC to trip over", async () => {
    // Nothing to assert after the fact — it is removed — so the record of
    // what was asked for is the request the daemon saw.
    await backend.verifyWorkspaceQuota();
    const created = docker.requests.filter((r) => r.path === "/volumes/create");
    expect(created).toHaveLength(1);
    expect(docker.volumes.size).toBe(0);
    // And it is invisible to the reaper, which lists by the managed label.
    expect(await backend.listWorkspaces()).toEqual([]);
  });

  test("the opt-out asks the daemon nothing", async () => {
    const off = new LocalDockerBackend({
      ...configFor(docker.host),
      workspaceQuota: { mode: "off" },
    });
    await expect(off.verifyWorkspaceQuota()).resolves.toBeUndefined();
    expect(docker.requests).toHaveLength(0);
  });
});

describe("LocalDockerBackend workspace GC", () => {
  const ours = {
    [LABELS.installation]: "test-a",
    [LABELS.managed]: "true",
    [LABELS.sessionId]: "session-1",
  };

  test("lists only this installation's managed volumes", async () => {
    docker.addVolume("werft-ws-test-a-session-1", ours);
    docker.addVolume("werft-ws-test-b-session-2", {
      ...ours,
      [LABELS.installation]: "test-b",
    });
    docker.addVolume("someone-elses", {});
    const listed = await backend.listWorkspaces();
    expect(listed.map((w) => w.id)).toEqual(["werft-ws-test-a-session-1"]);
    expect(listed[0]?.sessionId).toBe("session-1");
  });

  test("a volume younger than the minimum age is not a candidate", async () => {
    const young = new LocalDockerBackend({
      ...configFor(docker.host),
      workspaceGcMinAgeMs: 60_000,
    });
    docker.addVolume("werft-ws-test-a-old", ours);
    docker.addVolume(
      "werft-ws-test-a-new",
      ours,
      null,
      new Date().toISOString(),
    );
    expect((await young.listWorkspaces()).map((w) => w.id)).toEqual([
      "werft-ws-test-a-old",
    ]);
  });

  test("a volume with no session label is reported, not judged by its name", async () => {
    docker.addVolume("werft-ws-test-a-session-9", {
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
    });
    expect((await backend.listWorkspaces())[0]?.sessionId).toBeNull();
  });

  test("removing reports removed, absent, in use and not ours", async () => {
    docker.addVolume("werft-ws-test-a-session-1", ours);
    expect(await backend.removeWorkspace("werft-ws-test-a-session-1")).toEqual({
      outcome: "removed",
    });
    expect(await backend.removeWorkspace("werft-ws-test-a-gone")).toEqual({
      outcome: "absent",
    });
    docker.addVolume("werft-ws-test-a-session-2", ours);
    docker.volumesInUse.add("werft-ws-test-a-session-2");
    expect(await backend.removeWorkspace("werft-ws-test-a-session-2")).toEqual({
      outcome: "in_use",
    });
    docker.addVolume("werft-ws-test-b-session-3", {
      ...ours,
      [LABELS.installation]: "test-b",
    });
    expect(await backend.removeWorkspace("werft-ws-test-b-session-3")).toEqual({
      outcome: "not_ours",
    });
    expect(docker.volumes.has("werft-ws-test-b-session-3")).toBe(true);
  });

  const legacySession = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
  const legacyVolume = `werft-ws-test-a-${legacySession}`;

  test("lists a legacy volume by the session its name derives from", async () => {
    docker.addVolume(legacyVolume, {});
    docker.addVolume("werft-ws-test-a-session-1", ours);
    // Not legacy: another installation's, a single-use name, not a uuid,
    // or labelled for another session.
    docker.addVolume(`werft-ws-test-b-${legacySession}`, {});
    docker.addVolume(`werft-ws-test-a-${legacySession}-0f1e2d3c`, {});
    docker.addVolume("werft-ws-test-a-not-a-session", {});
    docker.addVolume(`werft-ws-test-a-${legacySession.replace("0b", "1b")}`, {
      [LABELS.sessionId]: "someone-else",
    });

    const listed = await backend.listWorkspaces();

    expect(
      listed.map((w) => [w.id, w.sessionId, w.sessionFrom ?? "label"]).sort(),
    ).toEqual([
      [legacyVolume, legacySession, "name"],
      ["werft-ws-test-a-session-1", "session-1", "label"],
    ]);
  });

  test("neither side of an unfinished migration is listed for GC", async () => {
    const copy = `werft-ws-test-a-${legacySession}-0f1e2d3c`;
    docker.addVolume(legacyVolume, {});
    docker.addVolume(copy, {
      [LABELS.installation]: "test-a",
      [LABELS.managed]: "true",
      [VOLUME_LABELS.migratedFrom]: legacyVolume,
      [LABELS.sessionId]: legacySession,
    });
    docker.addVolume("werft-ws-test-a-session-1", ours);
    expect((await backend.listWorkspaces()).map((w) => w.id)).toEqual([
      "werft-ws-test-a-session-1",
    ]);

    // Finished: the source is gone, and the copy is an ordinary workspace.
    docker.volumes.delete(legacyVolume);
    expect((await backend.listWorkspaces()).map((w) => w.id).sort()).toEqual(
      [copy, "werft-ws-test-a-session-1"].sort(),
    );
  });

  test("a legacy volume is removed only for the session its name derives from", async () => {
    docker.addVolume(legacyVolume, {});
    // No owner: nothing proves an unlabelled volume ours.
    expect(await backend.removeWorkspace(legacyVolume)).toEqual({
      outcome: "not_ours",
    });
    expect(
      await backend.removeWorkspace(legacyVolume, {
        sessionId: "11111111-2222-4333-8444-555555555555",
      }),
    ).toEqual({ outcome: "not_ours" });
    expect(docker.volumes.has(legacyVolume)).toBe(true);
    expect(
      await backend.removeWorkspace(legacyVolume, { sessionId: legacySession }),
    ).toEqual({ outcome: "removed" });
  });

  test("a legacy name that came to carry another installation's volume is left", async () => {
    docker.addVolume(legacyVolume, { [LABELS.installation]: "test-b" });
    expect(
      await backend.removeWorkspace(legacyVolume, { sessionId: legacySession }),
    ).toEqual({ outcome: "not_ours" });
    expect(docker.volumes.has(legacyVolume)).toBe(true);
  });

  test("a removal asked for one session leaves another session's volume", async () => {
    docker.addVolume("werft-ws-test-a-session-1", ours);
    expect(
      await backend.removeWorkspace("werft-ws-test-a-session-1", {
        sessionId: "session-2",
      }),
    ).toEqual({ outcome: "not_ours" });
    expect(docker.volumes.has("werft-ws-test-a-session-1")).toBe(true);
    expect(
      await backend.removeWorkspace("werft-ws-test-a-session-1", {
        sessionId: "session-1",
      }),
    ).toEqual({ outcome: "removed" });
  });
});

describe("LocalDockerBackend volume naming settings", () => {
  const OTHER = {
    volumeLabelNamespace: "other-ns",
    volumeNamePrefix: "other-ws-",
  };
  const otherKeys = volumeLabelsOf(OTHER);
  const sessionId = intentFor().sessionId;
  const otherName = `${OTHER.volumeNamePrefix}test-a-${sessionId}-0f1e2d3c`;
  const ownName = `werft-ws-test-a-${sessionId}-0f1e2d3c`;

  function addWorkspace(name: string, keys: typeof VOLUME_LABELS) {
    docker.addVolume(
      name,
      {
        [keys.installation]: "test-a",
        [keys.managed]: "true",
        [keys.sessionId]: sessionId,
        [keys.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
      },
      { size: String(QUOTA_BYTES) },
    );
  }

  function configuredBackend(): LocalDockerBackend {
    return new LocalDockerBackend({ ...configFor(docker.host), ...OTHER });
  }

  test("unset, only the default names are listed, removed and mounted", async () => {
    addWorkspace(otherName, otherKeys);
    addWorkspace(ownName, VOLUME_LABELS);
    expect((await backend.listWorkspaces()).map((w) => w.id)).toEqual([
      ownName,
    ]);
    expect(await backend.removeWorkspace(otherName, { sessionId })).toEqual({
      outcome: "not_ours",
    });
    expect(docker.volumes.has(otherName)).toBe(true);
    await backend.ensureExecution(intentFor());
    const [container] = [...docker.containers.values()];
    expect(mountedWorkspaceOf(container?.body as ContainerCreateBody)).toBe(
      ownName,
    );
  });

  test("a volume under other names is invisible to the defaults, so the session gets a new one beside it", async () => {
    addWorkspace(otherName, otherKeys);
    await backend.ensureExecution(intentFor());
    const created = workspaceNameOf(docker, sessionId, "test-a");
    expect(created?.startsWith("werft-ws-test-a-")).toBe(true);
    expect(docker.volumes.has(otherName)).toBe(true);
  });

  test("set, only those names are listed, removed and mounted", async () => {
    const configured = configuredBackend();
    addWorkspace(otherName, otherKeys);
    addWorkspace(ownName, VOLUME_LABELS);
    expect((await configured.listWorkspaces()).map((w) => w.id)).toEqual([
      otherName,
    ]);
    expect(await configured.removeWorkspace(ownName, { sessionId })).toEqual({
      outcome: "not_ours",
    });
    expect(docker.volumes.has(ownName)).toBe(true);
    await configured.ensureExecution(intentFor());
    const [container] = [...docker.containers.values()];
    expect(mountedWorkspaceOf(container?.body as ContainerCreateBody)).toBe(
      otherName,
    );
    expect(docker.volumes.size).toBe(2);
  });

  test("a new volume made under the settings carries exactly those names", async () => {
    await configuredBackend().ensureExecution(intentFor());
    const name = workspaceNameOf(docker, sessionId, "test-a");
    expect(name).toBeUndefined();
    const created = [...docker.volumes.values()].find((volume) =>
      volume.name.startsWith(OTHER.volumeNamePrefix),
    );
    expect(created?.labels).toEqual({
      [otherKeys.installation]: "test-a",
      [otherKeys.managed]: "true",
      [otherKeys.sessionId]: sessionId,
      [otherKeys.workspaceQuota]: `enforced:${QUOTA_BYTES}`,
    });
  });

  test("a container's labels do not follow the volume setting", async () => {
    await configuredBackend().ensureExecution(intentFor());
    const [container] = [...docker.containers.values()];
    expect(Object.keys(container?.body.Labels ?? {}).sort()).toEqual(
      Object.values({
        bootstrapFingerprint: LABELS.bootstrapFingerprint,
        executionId: LABELS.executionId,
        generation: LABELS.generation,
        installation: LABELS.installation,
        isolation: LABELS.isolation,
        managed: LABELS.managed,
        operationId: LABELS.operationId,
        sessionId: LABELS.sessionId,
      }).sort(),
    );
  });

  describe("an install made before the rename", () => {
    // Literal on purpose: these are the keys and the prefix those volumes carry.
    const PREVIOUS = {
      volumeLabelNamespace: "agent-platform",
      volumeNamePrefix: "ap-ws-",
    };
    const previousKeys = {
      installation: "agent-platform.installation",
      managed: "agent-platform.managed",
      migratedFrom: "agent-platform.migration-source",
      migrationSourceCreatedAt: "agent-platform.migration-source-created-at",
      quotaProbe: "agent-platform.quota-probe",
      sessionId: "agent-platform.session-id",
      workspaceQuota: "agent-platform.workspace-quota",
    };
    const previousName = `ap-ws-test-a-${sessionId}-0f1e2d3c`;

    test("the setting derives all seven previous volume label keys exactly", () => {
      expect(volumeLabelsOf(PREVIOUS)).toEqual(previousKeys);
    });

    test("set to those values, its volume is listed and mounted; unset, it is not", async () => {
      addWorkspace(previousName, previousKeys);
      expect((await backend.listWorkspaces()).map((w) => w.id)).toEqual([]);
      const previous = new LocalDockerBackend({
        ...configFor(docker.host),
        ...PREVIOUS,
      });
      expect((await previous.listWorkspaces()).map((w) => w.id)).toEqual([
        previousName,
      ]);
      await previous.ensureExecution(intentFor());
      const [container] = [...docker.containers.values()];
      expect(mountedWorkspaceOf(container?.body as ContainerCreateBody)).toBe(
        previousName,
      );
      expect(docker.volumes.size).toBe(1);
    });
  });
});
