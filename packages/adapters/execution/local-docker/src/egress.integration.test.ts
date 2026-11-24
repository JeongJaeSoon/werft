import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hashWorkerToken,
  type LaunchIntent,
  launchNonceFingerprint,
  sessionObjectPrefix,
} from "@werft-ai/platform";
import {
  createLocalstackBucket,
  type LocalstackBucket,
} from "@werft-ai/testkit";
import {
  asPrintfEscapes,
  clientHello,
  EXTENSION_ENCRYPTED_CLIENT_HELLO,
} from "@werft-ai/testkit/tls-client-hello";
import {
  containerNameFor,
  ENV,
  LABELS,
  LocalDockerBackend,
  networkNameFor,
  workerEnvironmentFor,
} from "./backend.ts";
import type { LocalDockerBackendConfig } from "./config.ts";
import { DockerClient } from "./docker-client.ts";
import { OFF_QUOTA, testDockerHost } from "./testing.ts";

/**
 * The egress contract end to end, against a real daemon and no internet:
 * an internal worker network, an egress proxy that is its only member with
 * a route off it, and two HTTP servers on the outer network — one
 * allowlisted, one not. Opt in with `DOCKER_BACKEND_TEST=1`.
 *
 * The proxy runs from `apps/egress-proxy`, mounted read-only into a stock
 * Bun image. The released image (apps/egress-proxy/Dockerfile) is that same
 * base with the same source copied in and nothing installed, so the fixture
 * boots what compose runs without a build step here; image-smoke.sh checks
 * the built image itself.
 */
const enabled = process.env.DOCKER_BACKEND_TEST === "1";
const integration = enabled ? describe : describe.skip;
const IMAGE = process.env.DOCKER_BACKEND_TEST_IMAGE ?? "busybox:1.36";
const PROXY_IMAGE = process.env.EGRESS_PROXY_TEST_IMAGE ?? "oven/bun:1.3.14";
/**
 * A real TLS client for the tunnel: curl on OpenSSL, which sends a plain
 * ClientHello. Bun's own fetch is BoringSSL and sends GREASE ECH, which the
 * proxy refuses on purpose, so it is the negative case below, not this.
 */
const CURL_IMAGE =
  process.env.EGRESS_CURL_TEST_IMAGE ?? "curlimages/curl:8.11.1";
/** CI points it, like the others, at its mirror (ci-image-mirror.yml). */
const LOCALSTACK_IMAGE =
  process.env.LOCALSTACK_TEST_IMAGE ?? "localstack/localstack:3";
const REPOSITORY = resolve(import.meta.dir, "../../../../..");
const PROXY_SOURCE = join(REPOSITORY, "apps/egress-proxy");
const OBJECT_REGION = "ap-northeast-1";
const dockerHost = await testDockerHost();

integration("worker egress is confined to the proxy allowlist", () => {
  const client = new DockerClient(dockerHost, "v1.44", { timeoutMs: 120_000 });
  const suffix = crypto.randomUUID().slice(0, 8);
  const installationId = `eg-${suffix}`;
  const workerNetwork = `ap-it-worker-${suffix}`;
  const outerNetwork = `ap-it-outer-${suffix}`;
  const allowedName = `ap-it-allowed-${suffix}`;
  const deniedName = `ap-it-denied-${suffix}`;
  const proxyName = `ap-it-proxy-${suffix}`;
  const tlsName = `ap-it-tls-${suffix}`;
  const proxyUrl = `http://${proxyName}:3128`;
  const localstackName = `ap-it-localstack-${suffix}`;
  /** The API's side of the object store route, with the only key. */
  const authorizerName = `ap-it-authorizer-${suffix}`;
  /** Answers like the API: Bun.serve, after an await. */
  const gatewayName = `ap-it-gateway-${suffix}`;
  /** A second installation on the same daemon, with a proxy of its own. */
  const otherInstallationId = `eg2-${suffix}`;
  const otherProxyName = `ap-it-proxy2-${suffix}`;
  const created: string[] = [];
  const volumes: string[] = [];
  let bucket: LocalstackBucket;
  let probeDir: string;
  /** Where the test opens sessions and claims generations, from the host. */
  let authorizerControl: string;

  // Built once the bucket exists, since its name is part of the config.
  let backend: LocalDockerBackend;
  const configFor = (bucketName: string): LocalDockerBackendConfig => ({
    apiVersion: "v1.44",
    command: ["sleep", "600"],
    dockerHost,
    egressCredentialPort: 3129,
    egressProxyUrl: proxyUrl,
    gatewayUrl: `http://${allowedName}:8080`,
    homeDir: "/home/worker",
    installationId,
    objectStore: { bucket: bucketName, region: OBJECT_REGION },
    requestTimeoutMs: 60_000,
    stopTimeoutSeconds: 1,
    tmpfsSizeBytes: 16 * 1024 * 1024,
    user: "1000:1000",
    workspaceDir: "/workspace",
    volumeLabelNamespace: "werft",
    volumeNamePrefix: "werft-ws-",
    workspaceGcMinAgeMs: 0,
    // Neither Docker Desktop nor a stock Linux runner puts its storage on a
    // quota-capable filesystem; the quota itself is covered by
    // workspace.integration.test.ts, which probes for one first.
    workspaceQuota: OFF_QUOTA,
  });

  beforeAll(async () => {
    await client.version();
    for (const image of [IMAGE, PROXY_IMAGE, LOCALSTACK_IMAGE, CURL_IMAGE]) {
      await client.pullImage(image);
    }
    await client.createNetwork({ Internal: true, Name: workerNetwork });
    await client.createNetwork({ Internal: false, Name: outerNetwork });
    probeDir = await mkdtemp(join(tmpdir(), "ap-object-probe-"));
    await startServer(allowedName, "allowed-upstream");
    await startServer(deniedName, "denied-upstream", true);
    await startTlsServer();
    await startLocalstack();
    await startAuthorizer();
    await startGateway();
    await startProxy();
  }, 300_000);

  afterAll(async () => {
    await bucket?.destroy().catch(() => undefined);
    if (probeDir) await rm(probeDir, { recursive: true, force: true });
    for (const name of created) {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
    for (const volume of volumes) {
      await raw("DELETE", `/volumes/${volume}?force=true`).catch(
        () => undefined,
      );
    }
    // What the backends made for their workers, now empty of containers.
    for (const owner of [installationId, otherInstallationId]) {
      const owned = await client
        .listNetworks([`${LABELS.installation}=${owner}`])
        .catch(() => []);
      for (const network of owned) {
        await client.removeNetwork(network.Id).catch(() => undefined);
      }
    }
    for (const network of [workerNetwork, outerNetwork]) {
      await client.removeNetwork(network).catch(() => undefined);
    }
  }, 120_000);

  /**
   * A one-file HTTP server on the outer network, reachable only by name.
   * `publish` also binds it to a host port, which needs `ExposedPorts`: the
   * daemon ignores a binding for a port the container never declared.
   */
  async function startServer(
    name: string,
    body: string,
    publish = false,
  ): Promise<void> {
    created.push(name);
    const response = await raw("POST", `/containers/create?name=${name}`, {
      Cmd: [
        "sh",
        "-c",
        `mkdir -p /www && echo ${body} > /www/index.html && httpd -f -p 8080 -h /www`,
      ],
      // Deliberately the worst case: bound to every host address, which is
      // what a carelessly configured dev stack does.
      ...(publish ? { ExposedPorts: { "8080/tcp": {} } } : {}),
      HostConfig: {
        NetworkMode: outerNetwork,
        ...(publish
          ? {
              PortBindings: {
                "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }],
              },
            }
          : {}),
      },
      Image: IMAGE,
      User: "0:0",
    });
    expect(response.status).toBe(201);
    await client.startContainer(name);
  }

  /** The host port Docker picked for a published container port. */
  async function publishedPortOf(
    name: string,
    containerPort = "8080/tcp",
  ): Promise<string> {
    const inspected = (await (
      await raw("GET", `/containers/${name}/json`)
    ).json()) as {
      NetworkSettings: {
        Ports: Record<string, Array<{ HostPort: string }> | null>;
      };
    };
    const port = inspected.NetworkSettings.Ports[containerPort]?.[0]?.HostPort;
    if (!port) throw new Error(`${name} published no host port`);
    return port;
  }

  /**
   * Runs the worker's own object-store module on the worker network with
   * exactly the env the backend would put in a worker container. The
   * repository is mounted read-only into a stock Bun image the way the
   * proxy is, so this is the production factory — bounded S3 client, prefix
   * guard and all — not a re-implementation of it.
   */
  async function objectProbe(
    environment: string[],
    binds: string[] = [],
    source = OBJECT_PROBE,
  ): Promise<{ exitCode: number; output: string }> {
    const name = `ap-it-object-probe-${crypto.randomUUID().slice(0, 8)}`;
    const script = join(probeDir, `${name}.ts`);
    await writeFile(script, source);
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: ["bun", "run", "/probe/probe.ts"],
      Env: environment,
      HostConfig: {
        Binds: [
          `${REPOSITORY}:/app:ro`,
          `${script}:/probe/probe.ts:ro`,
          ...binds,
        ],
        NetworkMode: workerNetwork,
        // Bun writes its cache under HOME; the worker's HOME is a tmpfs.
        Tmpfs: { "/home/worker": "rw,size=16m" },
      },
      Image: PROXY_IMAGE,
      Tty: true,
      WorkingDir: "/app",
    });
    try {
      await client.startContainer(name);
      const waited = (await (
        await raw("POST", `/containers/${name}/wait`)
      ).json()) as { StatusCode: number };
      return { exitCode: waited.StatusCode, output: await logsOf(name) };
    } finally {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
  }

  function workerEnv(sessionId: string): string[] {
    return workerEnvironmentFor(
      configFor(bucket.bucket),
      { executionId: `exec-${suffix}`, generation: 1, sessionId },
      `wln-${suffix}`,
    );
  }

  /**
   * A new session in the authorizer's database, claimed at generation 1:
   * its id and the object store token that claim handed out.
   */
  async function openObjectSession(): Promise<{
    sessionId: string;
    token: string;
  }> {
    const response = await fetch(`${authorizerControl}/session`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { sessionId: string; token: string };
  }

  /** The session's next generation claims; returns its token. */
  async function nextGeneration(sessionId: string): Promise<string> {
    const response = await fetch(
      `${authorizerControl}/claim?session=${sessionId}`,
      { method: "POST", signal: AbortSignal.timeout(30_000) },
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { token: string }).token;
  }

  /**
   * The object store, on the outer network like every other upstream and
   * published to the host so the test can make the bucket and look inside
   * it. Workers only ever see it through the proxy's object store route.
   */
  async function startLocalstack(): Promise<void> {
    created.push(localstackName);
    const response = await raw(
      "POST",
      `/containers/create?name=${localstackName}`,
      {
        Env: ["SERVICES=s3", "EAGER_SERVICE_LOADING=1"],
        ExposedPorts: { "4566/tcp": {} },
        HostConfig: {
          NetworkMode: outerNetwork,
          PortBindings: {
            "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        },
        Image: LOCALSTACK_IMAGE,
      },
    );
    expect(response.status).toBe(201);
    await client.startContainer(localstackName);
    const port = await publishedPortOf(localstackName, "4566/tcp");
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const health = await fetch(`${endpoint}/_localstack/health`, {
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      if (health?.ok) break;
      if (Date.now() > deadline) {
        throw new Error(
          `LocalStack never came up; logs were:\n${await logsOf(localstackName)}`,
        );
      }
      await Bun.sleep(1_000);
    }
    bucket = await createLocalstackBucket({
      env: {
        accessKeyId: "test",
        endpoint,
        region: OBJECT_REGION,
        secretAccessKey: "test",
      },
      prefix: "egress-it",
    });
    backend = new LocalDockerBackend(configFor(bucket.bucket), client);
  }

  /**
   * A TLS upstream on the outer network, so the CONNECT path is exercised
   * by a real handshake and not only by a hand-written request line. The
   * certificate is minted on the host with openssl; only the fixture ever
   * trusts it.
   */
  async function startTlsServer(): Promise<void> {
    const tlsDir = join(probeDir, "tls");
    await mkdir(tlsDir, { recursive: true });
    const generate = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        `/CN=${tlsName}`,
        "-addext",
        `subjectAltName=DNS:${tlsName}`,
        "-keyout",
        join(tlsDir, "key.pem"),
        "-out",
        join(tlsDir, "cert.pem"),
      ],
      { stderr: "pipe", stdout: "ignore" },
    );
    if ((await generate.exited) !== 0) {
      throw new Error(
        `openssl could not mint a test certificate:\n${await new Response(generate.stderr).text()}`,
      );
    }
    await writeFile(join(tlsDir, "server.ts"), TLS_SERVER);
    created.push(tlsName);
    const response = await raw("POST", `/containers/create?name=${tlsName}`, {
      Cmd: ["bun", "run", "/tls/server.ts"],
      HostConfig: {
        Binds: [`${tlsDir}:/tls:ro`],
        NetworkMode: outerNetwork,
      },
      Image: PROXY_IMAGE,
    });
    expect(response.status).toBe(201);
    await client.startContainer(tlsName);
    const deadline = Date.now() + 90_000;
    while (!(await logsOf(tlsName)).includes("tls listening")) {
      if (Date.now() > deadline) {
        throw new Error(
          `TLS upstream never came up; logs were:\n${await logsOf(tlsName)}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  /**
   * The control plane's side of the object store route, on the outer
   * network where the API would be: the real gateway over PGlite and the
   * real authorizer and signer (`tests/object-route-fixture.ts`), holding
   * the only key LocalStack is given. A second port, published to the host
   * and to nothing a worker can reach, lets the test open sessions and
   * claim generations.
   */
  async function startAuthorizer(): Promise<void> {
    const script = join(probeDir, "authorizer.ts");
    await writeFile(script, AUTHORIZER);
    created.push(authorizerName);
    const response = await raw(
      "POST",
      `/containers/create?name=${authorizerName}`,
      {
        Cmd: ["bun", "run", "/fixture/authorizer.ts"],
        Env: [
          `OBJECT_STORE=${JSON.stringify({
            ...bucket.env,
            bucket: bucket.bucket,
            endpoint: `http://${localstackName}:4566`,
          })}`,
        ],
        ExposedPorts: { "3200/tcp": {} },
        HostConfig: {
          Binds: [
            `${REPOSITORY}:/app:ro`,
            `${script}:/fixture/authorizer.ts:ro`,
          ],
          NetworkMode: outerNetwork,
          PortBindings: {
            "3200/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          },
        },
        Image: PROXY_IMAGE,
        WorkingDir: "/app",
      },
    );
    expect(response.status).toBe(201);
    await client.startContainer(authorizerName);
    const deadline = Date.now() + 120_000;
    while (!(await logsOf(authorizerName)).includes("authorizer listening")) {
      if (Date.now() > deadline) {
        throw new Error(
          `authorizer never came up; logs were:\n${await logsOf(authorizerName)}`,
        );
      }
      await Bun.sleep(500);
    }
    authorizerControl = `http://127.0.0.1:${await publishedPortOf(authorizerName, "3200/tcp")}`;
  }

  /**
   * A stand-in for the worker gateway that behaves like the real one on the
   * wire: Bun.serve answering after an await, which leaves the connection
   * open whatever `connection: close` the proxy sent it.
   */
  async function startGateway(): Promise<void> {
    await writeFile(join(probeDir, "gateway.ts"), GATEWAY);
    created.push(gatewayName);
    const response = await raw(
      "POST",
      `/containers/create?name=${gatewayName}`,
      {
        Cmd: ["bun", "run", "/gateway/gateway.ts"],
        HostConfig: {
          Binds: [`${join(probeDir, "gateway.ts")}:/gateway/gateway.ts:ro`],
          NetworkMode: outerNetwork,
        },
        Image: PROXY_IMAGE,
      },
    );
    expect(response.status).toBe(201);
    await client.startContainer(gatewayName);
    const deadline = Date.now() + 90_000;
    while (!(await logsOf(gatewayName)).includes("gateway listening")) {
      if (Date.now() > deadline) {
        throw new Error(
          `gateway never came up; logs were:\n${await logsOf(gatewayName)}`,
        );
      }
      await Bun.sleep(500);
    }
  }

  /** curl on the worker network, through the proxy, with the fixture's CA. */
  async function curlProbe(url: string): Promise<{
    exitCode: number;
    output: string;
  }> {
    const name = `ap-it-curl-probe-${crypto.randomUUID().slice(0, 8)}`;
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: [
        "curl",
        "-sS",
        "--max-time",
        "20",
        "--proxy",
        proxyUrl,
        "--cacert",
        "/tls/cert.pem",
        url,
      ],
      HostConfig: {
        Binds: [`${join(probeDir, "tls")}:/tls:ro`],
        NetworkMode: workerNetwork,
      },
      Image: CURL_IMAGE,
      Tty: true,
    });
    try {
      await client.startContainer(name);
      const waited = (await (
        await raw("POST", `/containers/${name}/wait`)
      ).json()) as { StatusCode: number };
      return { exitCode: waited.StatusCode, output: await logsOf(name) };
    } finally {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
  }

  /**
   * Bun's fetch on the worker network, told to use the proxy: the BoringSSL
   * client that sent GREASE ECH up to Bun 1.3.13.
   */
  async function bunFetchProbe(url: string): Promise<{
    exitCode: number;
    output: string;
  }> {
    const name = `ap-it-tls-probe-${crypto.randomUUID().slice(0, 8)}`;
    const script = join(probeDir, `${name}.ts`);
    await writeFile(
      script,
      `const response = await fetch(${JSON.stringify(url)}, {
  proxy: ${JSON.stringify(proxyUrl)},
  tls: { rejectUnauthorized: false },
});
console.log("TLS " + response.status + " " + (await response.text()));
`,
    );
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: ["bun", "run", "/probe/probe.ts"],
      HostConfig: {
        Binds: [`${script}:/probe/probe.ts:ro`],
        NetworkMode: workerNetwork,
      },
      Image: PROXY_IMAGE,
      Tty: true,
    });
    try {
      await client.startContainer(name);
      const waited = (await (
        await raw("POST", `/containers/${name}/wait`)
      ).json()) as { StatusCode: number };
      return { exitCode: waited.StatusCode, output: await logsOf(name) };
    } finally {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
  }

  async function startProxy(): Promise<void> {
    created.push(proxyName);
    const fixture = (await (
      await fetch(`${authorizerControl}/fixture`)
    ).json()) as { authorizerToken: string };
    const response = await raw("POST", `/containers/create?name=${proxyName}`, {
      Cmd: ["bun", "run", "/app/src/main.ts"],
      Env: [
        `EGRESS_PRIVATE_ALLOWLIST=${allowedName}:8080,${tlsName}:8443,${gatewayName}:3000`,
        "EGRESS_PROXY_PORT=3128",
        // The object store is an upstream of the credential routes only:
        // LocalStack takes any signature, so the forward proxy must not
        // reach it.
        `EGRESS_AUTHORIZER_URL=http://${authorizerName}:3100`,
        `EGRESS_AUTHORIZER_TOKEN=${fixture.authorizerToken}`,
        "EGRESS_CREDENTIAL_PORT=3129",
        `EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST=${localstackName}:4566`,
      ],
      HostConfig: {
        Binds: [`${PROXY_SOURCE}:/app:ro`],
        NetworkMode: outerNetwork,
      },
      Image: PROXY_IMAGE,
      // How the backend finds it to attach to each worker network it makes.
      Labels: { [LABELS.egressProxy]: installationId },
    });
    expect(response.status).toBe(201);
    // Two networks: the outer one to reach upstreams, the fixture's internal
    // one to be reachable by the probes below. Only the first can be given
    // at create time.
    const connected = await raw("POST", `/networks/${workerNetwork}/connect`, {
      Container: proxyName,
    });
    expect(connected.status).toBe(200);
    await client.startContainer(proxyName);
    await waitForProxy();
  }

  async function waitForProxy(): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const logs = await logsOf(proxyName);
      if (logs.includes("Egress proxy listening")) return;
      await Bun.sleep(500);
    }
    throw new Error(
      `egress proxy never came up; logs were:\n${await logsOf(proxyName)}`,
    );
  }

  async function logsOf(name: string): Promise<string> {
    const response = await raw(
      "GET",
      `/containers/${name}/logs?stdout=true&stderr=true`,
    );
    return response.ok ? await response.text() : "";
  }

  /**
   * Runs one busybox probe on the worker network and reports what it saw.
   * `Tty` keeps the log stream unmultiplexed so the output reads plainly.
   */
  async function probe(
    command: string,
    environment: string[] = [],
  ): Promise<{ exitCode: number; output: string }> {
    const name = `ap-it-probe-${crypto.randomUUID().slice(0, 8)}`;
    await raw("POST", `/containers/create?name=${name}`, {
      Cmd: ["sh", "-c", command],
      Env: environment,
      HostConfig: { NetworkMode: workerNetwork },
      Image: IMAGE,
      Tty: true,
    });
    try {
      await client.startContainer(name);
      const waited = (await (
        await raw("POST", `/containers/${name}/wait`)
      ).json()) as { StatusCode: number };
      return { exitCode: waited.StatusCode, output: await logsOf(name) };
    } finally {
      await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
    }
  }

  async function raw(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const socket = dockerHost.startsWith("unix://")
      ? dockerHost.slice("unix://".length)
      : undefined;
    const base = socket
      ? "http://docker"
      : dockerHost.replace(/^tcp:\/\//, "http://");
    return fetch(`${base}/v1.44${path}`, {
      method,
      signal: AbortSignal.timeout(120_000),
      ...(socket ? { unix: socket } : {}),
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    } as RequestInit);
  }

  const withProxy = (): string[] => [
    `http_proxy=${proxyUrl}`,
    `https_proxy=${proxyUrl}`,
  ];

  test("the worker network is internal and the backend agrees", async () => {
    const network = await client.inspectNetwork(workerNetwork);
    expect(network).toMatchObject({ Internal: true, Name: workerNetwork });
    await expect(backend.verifyNetworkIsolation()).resolves.toBeUndefined();
  }, 60_000);

  test("without the proxy a worker reaches nothing at all", async () => {
    // The allowlisted upstream, a container on another network and the
    // instance-metadata address are equally unreachable: there is no route.
    const direct = await probe(`wget -T 3 -q -O - http://${allowedName}:8080/`);
    expect(direct.exitCode).not.toBe(0);
    expect(direct.output).not.toContain("allowed-upstream");

    const metadata = await probe(
      "wget -T 3 -q -O - http://169.254.169.254/latest/meta-data/",
    );
    expect(metadata.exitCode).not.toBe(0);

    const gateway = await probe("nc -w 3 -z host.docker.internal 3000");
    expect(gateway.exitCode).not.toBe(0);
  }, 180_000);

  test("the network gateway is not a way back to ports published on the host", async () => {
    // An internal network still has a bridge, and that bridge address is the
    // host. If the worker could open it, every port the dev stack publishes
    // on 0.0.0.0 would be one hop away and the proxy would be decoration.
    const network = await client.inspectNetwork(workerNetwork);
    const gateway = network?.IPAM?.Config?.[0]?.Gateway;
    expect(gateway).toBeTruthy();
    if (!gateway) throw new Error("the worker network has no gateway");
    const hostPort = await publishedPortOf(deniedName);

    // The publish really works, so the refusal below is not vacuous.
    const fromHost = await fetch(`http://127.0.0.1:${hostPort}/`, {
      signal: AbortSignal.timeout(10_000),
    });
    expect(await fromHost.text()).toContain("denied-upstream");

    const direct = await probe(`nc -w 3 -z ${gateway} ${hostPort}`);
    expect(direct.exitCode).not.toBe(0);
    // And the proxy will not carry it either: the gateway is a private
    // address and no allowlist entry names it.
    const proxied = await probe(
      `wget -T 10 -O - http://${gateway}:${hostPort}/ 2>&1`,
      withProxy(),
    );
    expect(proxied.output).toContain("403");
    expect(proxied.output).not.toContain("denied-upstream");
  }, 180_000);

  test("through the proxy an allowlisted destination is reachable", async () => {
    const allowed = await probe(
      `wget -T 10 -q -O - http://${allowedName}:8080/`,
      withProxy(),
    );
    expect(allowed.output).toContain("allowed-upstream");
    expect(allowed.exitCode).toBe(0);
  }, 180_000);

  test("through the proxy everything else is refused", async () => {
    const denied = await probe(
      `wget -T 10 -O - http://${deniedName}:8080/ 2>&1`,
      withProxy(),
    );
    expect(denied.output).toContain("403");
    expect(denied.output).not.toContain("denied-upstream");

    const metadata = await probe(
      "wget -T 10 -O - http://169.254.169.254/latest/meta-data/ 2>&1",
      withProxy(),
    );
    expect(metadata.output).toContain("403");
  }, 240_000);

  test("CONNECT is judged by the same allowlist as plain HTTP", async () => {
    // busybox wget has no TLS, so the tunnel request is spoken by hand. The
    // sleep keeps nc's stdin open long enough for the reply to arrive.
    const connect = (target: string) =>
      probe(
        `{ printf 'CONNECT ${target} HTTP/1.1\\r\\nhost: ${target}\\r\\n\\r\\n'; sleep 3; } | nc ${proxyName} 3128`,
      );
    expect((await connect(`${allowedName}:8080`)).output).toContain(
      "200 Connection Established",
    );
    expect((await connect(`${deniedName}:8080`)).output).toContain("403");
    expect((await connect("169.254.169.254:80")).output).toContain("403");
  }, 240_000);

  test("a real TLS client handshakes through the tunnel when its server name is the authority", async () => {
    // The fixture CA proves the tunnel carried a genuine handshake with the
    // upstream and not merely bytes.
    const result = await curlProbe(`https://${tlsName}:8443/`);
    expect(result.output).toContain("tls-upstream");
    expect(result.exitCode).toBe(0);
    expect(await logsOf(tlsName)).toContain(`served ${tlsName}:8443`);
  }, 240_000);

  test("Bun's own fetch handshakes through the tunnel", async () => {
    // Bun 1.3.10–1.3.13 put GREASE encrypted_client_hello on every fetch and
    // node:https hello, which this proxy refuses; 1.3.14 does not.
    // This pins that where a runtime upgrade would change it back.
    const before = await logsOf(proxyName);
    const result = await bunFetchProbe(`https://${tlsName}:8443/`);
    expect(result.output).toContain("tls-upstream");
    expect(result.exitCode).toBe(0);
    const after = (await logsOf(proxyName)).slice(before.length);
    expect(after).not.toContain("encrypted_client_hello");
  }, 240_000);

  test("a hello that carries encrypted_client_hello is refused", async () => {
    // GREASE or real, the proxy cannot tell them apart.
    const hello = asPrintfEscapes(
      clientHello({
        extensions: [
          {
            data: Uint8Array.from([1]),
            type: EXTENSION_ENCRYPTED_CLIENT_HELLO,
          },
        ],
        serverNames: [tlsName],
      }),
    );
    const before = await logsOf(proxyName);
    const result = await probe(
      `{ printf 'CONNECT ${tlsName}:8443 HTTP/1.1\\r\\nhost: ${tlsName}:8443\\r\\n\\r\\n'; sleep 1; printf '${hello}'; sleep 3; } | nc ${proxyName} 3128`,
    );
    expect(result.output).toContain("200 Connection Established");
    const after = (await logsOf(proxyName)).slice(before.length);
    expect(after).toContain("encrypted_client_hello");
  }, 240_000);

  test("a tunnel to an allowlisted authority is cut when the handshake names another host", async () => {
    // busybox has no TLS client, so the ClientHello is spelled out for
    // printf: the same bytes a client would send, with the server name of
    // a host the allowlist never judged.
    const hello = asPrintfEscapes(clientHello({ serverNames: [deniedName] }));
    const before = await logsOf(proxyName);
    const result = await probe(
      `{ printf 'CONNECT ${tlsName}:8443 HTTP/1.1\\r\\nhost: ${tlsName}:8443\\r\\n\\r\\n'; sleep 1; printf '${hello}'; sleep 3; } | nc ${proxyName} 3128`,
    );
    expect(result.output).toContain("200 Connection Established");
    const after = (await logsOf(proxyName)).slice(before.length);
    expect(after).toContain("failed the gate");
    expect(after).toContain(
      `server name ${deniedName} is not the CONNECT authority ${tlsName}`,
    );
    // And the TLS upstream never heard from that client at all.
    expect(await logsOf(tlsName)).not.toContain(deniedName);
  }, 240_000);

  test("through the route the worker's object store reaches its session prefix and nothing else", async () => {
    const session = await openObjectSession();
    const prefix = sessionObjectPrefix(session.sessionId);
    const result = await objectProbe([
      ...workerEnv(session.sessionId),
      `PROBE_OBJECT_TOKEN=${session.token}`,
    ]);
    expect(result.output).toContain("PROBE ");
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(
      result.output.slice(result.output.indexOf("PROBE ") + "PROBE ".length),
    ) as Record<string, unknown>;
    expect(report).toEqual({
      conflict: "conflict",
      duplicate: "duplicate",
      foreignGet: "ObjectScopeError",
      foreignList: "ObjectScopeError",
      foreignPut: "ObjectScopeError",
      get: '{"revision":0}',
      head: 14,
      list: [`${prefix}checkpoints/0000000000/a1/manifest.json`],
      put: "ok",
      putImmutable: "created",
    });
    // What the probe wrote is really in the bucket, under the session.
    const stored = await bucket.s3.send(
      new (await import("@aws-sdk/client-s3")).ListObjectsV2Command({
        Bucket: bucket.bucket,
        Prefix: prefix,
      }),
    );
    expect((stored.Contents ?? []).map((o) => o.Key).sort()).toEqual([
      `${prefix}checkpoints/0000000000/a1/manifest.json`,
      `${prefix}transcript/part-0`,
    ]);
  }, 300_000);

  // the wrapper above is the worker's own code, which a worker
  // that runs anything can bypass. This is what bypassing it gets: its
  // token as the key of a plain S3 client, from inside the worker network.
  test("a raw S3 client with the worker's token reaches no other session's objects", async () => {
    const mine = await openObjectSession();
    const theirs = await openObjectSession();
    const foreign = sessionObjectPrefix(theirs.sessionId);
    const s3 = await import("@aws-sdk/client-s3");
    await bucket.s3.send(
      new s3.PutObjectCommand({
        Body: "theirs",
        Bucket: bucket.bucket,
        Key: `${foreign}x`,
      }),
    );
    const result = await objectProbe(
      [
        ...workerEnv(mine.sessionId),
        `PROBE_OBJECT_TOKEN=${mine.token}`,
        `PROBE_FOREIGN_PREFIX=${foreign}`,
      ],
      [],
      RAW_PROBE,
    );
    expect(result.output).toContain("PROBE ");
    const report = JSON.parse(
      result.output.slice(result.output.indexOf("PROBE ") + "PROBE ".length),
    ) as Record<string, unknown>;
    expect(report).toEqual({
      // The same client is let through at home, so every refusal below is
      // about where it aimed, not how it asked.
      ownPut: "allowed",
      foreignGet: "AccessDenied",
      foreignPut: "AccessDenied",
      foreignList: "AccessDenied",
      everySessionList: "AccessDenied",
      ownOverwrite: "AccessDenied",
      foreignDelete: "AccessDenied",
      ownDelete: "AccessDenied",
      legalHold: "AccessDenied",
      forgedToken: "InvalidAccessKeyId",
    });
    const left = await bucket.s3.send(
      new s3.ListObjectsV2Command({ Bucket: bucket.bucket, Prefix: foreign }),
    );
    expect((left.Contents ?? []).map((o) => o.Key)).toEqual([`${foreign}x`]);
    const body = await bucket.s3.send(
      new s3.GetObjectCommand({ Bucket: bucket.bucket, Key: `${foreign}x` }),
    );
    expect(await body.Body?.transformToString()).toBe("theirs");
  }, 300_000);

  test("once the next generation claims, the previous token writes nothing", async () => {
    const session = await openObjectSession();
    const later = await nextGeneration(session.sessionId);
    const prefix = sessionObjectPrefix(session.sessionId);
    const result = await objectProbe(
      [
        ...workerEnv(session.sessionId),
        `PROBE_OBJECT_TOKEN=${later}`,
        `PROBE_EARLIER_TOKEN=${session.token}`,
      ],
      [],
      RAW_PROBE,
    );
    expect(result.output).toContain("PROBE ");
    const report = JSON.parse(
      result.output.slice(result.output.indexOf("PROBE ") + "PROBE ".length),
    ) as { ownPut: string; earlierPut: string };
    expect(report.ownPut).toBe("allowed");
    expect(["AccessDenied", "InvalidAccessKeyId"]).toContain(report.earlierPut);
    const stored = await bucket.s3.send(
      new (await import("@aws-sdk/client-s3")).ListObjectsV2Command({
        Bucket: bucket.bucket,
        Prefix: prefix,
      }),
    );
    expect((stored.Contents ?? []).map((o) => o.Key)).toEqual([`${prefix}raw`]);
  }, 300_000);

  test("the object store itself is out of reach, directly or through the forward proxy", async () => {
    const target = `http://${localstackName}:4566/${bucket.bucket}?list-type=2`;
    const direct = await probe(`wget -T 3 -q -O - '${target}' 2>&1`);
    expect(direct.exitCode).not.toBe(0);
    expect(direct.output).not.toContain("ListBucketResult");
    const proxied = await probe(
      `wget -T 10 -O - '${target}' 2>&1`,
      withProxy(),
    );
    expect(proxied.output).toContain("403");
    expect(proxied.output).not.toContain("ListBucketResult");
  }, 180_000);

  // every new session's worker died here. Its gateway claim left
  // the pooled proxy connection open (Bun.serve ignores `connection: close`
  // after an await), and the session store's first S3 list went down it to
  // the gateway, whose JSON answer the SDK failed to parse as XML. Then the
  // first transcript append hung behind an object store that, like the
  // gateway, keeps its connection open: Bun's node:http reuses a connection
  // after a 404 even when told to close, so the PUT after the slot read went
  // down a hop the proxy had stopped forwarding and was never answered.
  test("a new session's first object calls after a gateway call reach the object store", async () => {
    const session = await openObjectSession();
    const result = await objectProbe(
      [
        ...workerEnv(session.sessionId),
        `PROBE_OBJECT_TOKEN=${session.token}`,
        `GATEWAY_PROBE_URL=http://${gatewayName}:3000`,
      ],
      [],
      SESSION_START_PROBE,
    );
    expect(result.output).toContain("PROBE ");
    const report = JSON.parse(
      result.output.slice(result.output.indexOf("PROBE ") + "PROBE ".length),
    ) as Record<string, unknown>;
    expect(report).toEqual({
      append: "ok",
      claim: "gateway /internal/worker/bootstrap-claim",
      fresh: "ok",
      heartbeat: "gateway /internal/worker/heartbeat",
      load: 1,
    });
    expect(result.exitCode).toBe(0);
  }, 300_000);

  test("a worker container launched by the backend gets the proxy variables", async () => {
    const intent: LaunchIntent = {
      executionId: `exec-${suffix}`,
      generation: 1,
      image: IMAGE,
      bootstrapCredentialState: async () => ({
        claimed: false,
        fingerprint: launchNonceFingerprint(hashWorkerToken(`wln-${suffix}`)),
      }),
      issueBootstrapNonce: async () => `wln-${suffix}`,
      launchSpec: null,
      operationId: `op-${suffix}`,
      resources: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pidsLimit: 32 },
      sessionId: crypto.randomUUID(),
    };
    const launched = await backend.ensureExecution(intent);
    created.push(launched.providerRef);
    for (const volume of await client.listVolumes([
      `${LABELS.sessionId}=${intent.sessionId}`,
    ])) {
      volumes.push(volume.Name);
    }
    const inspected = await client.inspectContainer(launched.providerRef);
    expect(inspected?.Config.Env ?? []).toContain(`HTTP_PROXY=${proxyUrl}`);
    expect(inspected?.Config.Env ?? []).toContain(`http_proxy=${proxyUrl}`);
    expect(inspected?.Config.Env ?? []).toContain(
      `${ENV.egressCredentialUrl}=http://${proxyName}:3129`,
    );
    // No way to the object store but the route: no endpoint, no key.
    expect(
      (inspected?.Config.Env ?? []).filter((entry) =>
        /^AWS_(ACCESS_KEY_ID|ENDPOINT_URL|SECRET_ACCESS_KEY|SESSION_TOKEN)=/.test(
          entry,
        ),
      ),
    ).toEqual([]);
    expect(inspected?.Config.Env ?? []).toContain(
      `${ENV.objectPrefix}=${sessionObjectPrefix(intent.sessionId)}`,
    );
    expect(JSON.stringify(inspected?.HostConfig)).not.toContain("host-gateway");
    // On a network of its own, not the fixture's shared one.
    expect(Object.keys(inspected?.NetworkSettings?.Networks ?? {})).toEqual([
      networkNameFor(intent, installationId),
    ]);
  }, 180_000);

  /**
   * workers launched by the backend, each on the network it made
   * for them. B serves HTTP; A and a worker of another installation, C, try
   * to reach it. Every refusal below is paired with a positive control, so a
   * dead server, a wrong address or a failed lookup cannot pass as isolation.
   */
  describe("workers do not reach one another", () => {
    const lateral = {
      a: intentOf("a"),
      b: intentOf("b"),
      c: intentOf("c"),
    };
    let bAddress = "";
    let proxyAddresses: string[] = [];
    let other: LocalDockerBackend;

    function intentOf(tag: string): LaunchIntent {
      return {
        bootstrapCredentialState: async () => ({
          claimed: false,
          fingerprint: launchNonceFingerprint(
            hashWorkerToken(`wln-${tag}-${suffix}`),
          ),
        }),
        executionId: `exec-${tag}-${suffix}`,
        generation: 1,
        image: IMAGE,
        issueBootstrapNonce: async () => `wln-${tag}-${suffix}`,
        launchSpec: null,
        operationId: `op-${tag}-${suffix}`,
        resources: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pidsLimit: 32 },
        sessionId: crypto.randomUUID(),
      };
    }

    beforeAll(async () => {
      const serving = new LocalDockerBackend(
        {
          ...configFor(bucket.bucket),
          // The worker image is busybox here; its httpd is the open port.
          command: [
            "sh",
            "-c",
            "echo lateral-target > /tmp/index.html && exec httpd -f -p 8080 -h /tmp",
          ],
        },
        client,
      );
      // The other installation's proxy only has to exist to be attached;
      // nothing below goes through it.
      created.push(otherProxyName);
      const response = await raw(
        "POST",
        `/containers/create?name=${otherProxyName}`,
        {
          Cmd: ["sleep", "600"],
          Image: IMAGE,
          Labels: { [LABELS.egressProxy]: otherInstallationId },
        },
      );
      expect(response.status).toBe(201);
      await client.startContainer(otherProxyName);
      other = new LocalDockerBackend(
        { ...configFor(bucket.bucket), installationId: otherInstallationId },
        client,
      );
      for (const [owner, intent] of [
        [backend, lateral.a],
        [serving, lateral.b],
        [other, lateral.c],
      ] as const) {
        created.push((await owner.ensureExecution(intent)).providerRef);
      }
      const b = await client.inspectContainer(
        containerNameFor(lateral.b, installationId),
      );
      bAddress =
        b?.NetworkSettings?.Networks?.[
          networkNameFor(lateral.b, installationId)
        ]?.IPAddress ?? "";
      expect(bAddress).not.toBe("");
      const proxy = await client.inspectContainer(proxyName);
      proxyAddresses = Object.values(proxy?.NetworkSettings?.Networks ?? {})
        .map((endpoint) => endpoint.IPAddress ?? "")
        .filter((address) => address !== "");
      // Its own network, one for each of this installation's workers, and
      // the fixture's.
      expect(proxyAddresses.length).toBeGreaterThanOrEqual(3);
      const deadline = Date.now() + 30_000;
      while (
        (await execIn(lateral.b, "wget -q -Y off -O - http://127.0.0.1:8080/"))
          .exitCode !== 0
      ) {
        if (Date.now() > deadline) throw new Error("worker B never served");
        await Bun.sleep(250);
      }
    }, 300_000);

    /** Runs `command` inside a launched worker; the worker's own env applies. */
    async function execIn(
      intent: LaunchIntent,
      command: string,
      owner = installationId,
    ): Promise<{ exitCode: number; output: string }> {
      const created = (await (
        await raw(
          "POST",
          `/containers/${containerNameFor(intent, owner)}/exec`,
          {
            AttachStderr: true,
            AttachStdout: true,
            Cmd: ["sh", "-c", command],
            Tty: true,
          },
        )
      ).json()) as { Id: string };
      const output = await (
        await raw("POST", `/exec/${created.Id}/start`, {
          Detach: false,
          Tty: true,
        })
      ).text();
      const inspected = (await (
        await raw("GET", `/exec/${created.Id}/json`)
      ).json()) as { ExitCode: number };
      return { exitCode: inspected.ExitCode, output };
    }

    test("B's port is open to anything that shares its network", async () => {
      // The positive control for every refusal below: the address is right
      // and the server answers it.
      const name = `ap-it-sibling-${suffix}`;
      await raw("POST", `/containers/create?name=${name}`, {
        Cmd: ["sh", "-c", `wget -T 5 -q -O - http://${bAddress}:8080/`],
        HostConfig: {
          NetworkMode: networkNameFor(lateral.b, installationId),
        },
        Image: IMAGE,
        Tty: true,
      });
      try {
        await client.startContainer(name);
        const waited = (await (
          await raw("POST", `/containers/${name}/wait`)
        ).json()) as { StatusCode: number };
        expect(waited.StatusCode).toBe(0);
        expect(await logsOf(name)).toContain("lateral-target");
      } finally {
        await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
      }
    }, 60_000);

    test("worker A reaches no port of worker B, by address or by name", async () => {
      const scan = await execIn(lateral.a, `nc -z -w 3 ${bAddress} 8080`);
      expect(scan.exitCode).not.toBe(0);
      const direct = await execIn(
        lateral.a,
        `wget -T 3 -q -Y off -O - http://${bAddress}:8080/`,
      );
      expect(direct.exitCode).not.toBe(0);
      expect(direct.output).not.toContain("lateral-target");
      const byName = await execIn(
        lateral.a,
        `wget -T 3 -q -Y off -O - http://${containerNameFor(lateral.b, installationId)}:8080/`,
      );
      expect(byName.exitCode).not.toBe(0);
      // Nor through the proxy, which refuses private addresses it was not
      // told about.
      const relayed = await execIn(
        lateral.a,
        `wget -T 5 -q -O - http://${bAddress}:8080/`,
      );
      expect(relayed.output).not.toContain("lateral-target");
    }, 120_000);

    test("worker A still reaches the allowlist through the proxy", async () => {
      const allowed = await execIn(
        lateral.a,
        `wget -T 10 -q -O - http://${allowedName}:8080/`,
      );
      expect(allowed.output).toContain("allowed-upstream");
      expect(allowed.exitCode).toBe(0);
    }, 60_000);

    test("another installation's worker reaches neither our workers nor our proxy", async () => {
      const toWorker = await execIn(
        lateral.c,
        `wget -T 3 -q -Y off -O - http://${bAddress}:8080/`,
        otherInstallationId,
      );
      expect(toWorker.exitCode).not.toBe(0);
      expect(toWorker.output).not.toContain("lateral-target");
      for (const address of proxyAddresses) {
        const toProxy = await execIn(
          lateral.c,
          `nc -z -w 3 ${address} 3128`,
          otherInstallationId,
        );
        expect(toProxy.exitCode).not.toBe(0);
      }
      // Its network carries its own installation's proxy, not ours.
      const network = await client.inspectNetwork(
        networkNameFor(lateral.c, otherInstallationId),
      );
      expect(
        Object.values(network?.Containers ?? {})
          .map((member) => member.Name)
          .sort(),
      ).toEqual(
        [
          containerNameFor(lateral.c, otherInstallationId),
          otherProxyName,
        ].sort(),
      );
    }, 120_000);

    describe("a host process on a wildcard address", () => {
      let hostPort = 0;
      let stopListener: () => Promise<void> = async () => undefined;
      /** Whether the listener is this very process, not a stand-in. */
      let listenerIsThisProcess = false;

      /**
       * Where "the host" is depends on the daemon, not on this client. When
       * this process holds an address the daemon gave a bridge, it shares
       * the daemon's network namespace (native Linux, as in CI), and the
       * listener is this process itself — a real host process. Otherwise
       * (Docker Desktop's VM, a remote daemon) the listener is a container
       * in the daemon host's namespace, the same position relative to the
       * bridges.
       */
      beforeAll(async () => {
        const gateway =
          (await client.inspectNetwork(workerNetwork))?.IPAM?.Config?.[0]
            ?.Gateway ?? "";
        listenerIsThisProcess = Object.values(networkInterfaces())
          .flat()
          .some((entry) => entry?.address === gateway);
        if (listenerIsThisProcess) {
          const server = Bun.serve({
            fetch: () => new Response("host-listener"),
            hostname: "0.0.0.0",
            port: 0,
          });
          hostPort = server.port ?? 0;
          stopListener = async () => {
            await server.stop(true);
          };
        } else {
          const name = `ap-it-hostlistener-${suffix}`;
          hostPort = 20_000 + Math.floor(Math.random() * 20_000);
          created.push(name);
          const response = await raw(
            "POST",
            `/containers/create?name=${name}`,
            {
              Cmd: [
                "sh",
                "-c",
                `mkdir -p /www && echo host-listener > /www/index.html && exec httpd -f -p 0.0.0.0:${hostPort} -h /www`,
              ],
              HostConfig: { NetworkMode: "host" },
              Image: IMAGE,
              User: "0:0",
            },
          );
          expect(response.status).toBe(201);
          await client.startContainer(name);
          stopListener = () => client.stopAndRemoveContainer(name, 1);
        }
        expect(hostPort).toBeGreaterThan(0);
        // CI's runner is native Linux: there the acceptance check has to be
        // made against a real host process, never the stand-in.
        if (process.env.CI === "true" && process.platform === "linux") {
          expect(listenerIsThisProcess).toBe(true);
        }
      }, 60_000);

      afterAll(async () => {
        await stopListener().catch(() => undefined);
      });

      /**
       * Runs `command` in the daemon host's network namespace: the test
       * process's own on native Linux, the VM's on Docker Desktop.
       */
      async function onDaemonHost(
        command: string,
      ): Promise<{ exitCode: number; output: string }> {
        const name = `ap-it-hostns-${crypto.randomUUID().slice(0, 8)}`;
        await raw("POST", `/containers/create?name=${name}`, {
          Cmd: ["sh", "-c", command],
          HostConfig: { NetworkMode: "host" },
          Image: IMAGE,
          Tty: true,
        });
        try {
          await client.startContainer(name);
          const waited = (await (
            await raw("POST", `/containers/${name}/wait`)
          ).json()) as { StatusCode: number };
          return { exitCode: waited.StatusCode, output: await logsOf(name) };
        } finally {
          await client.stopAndRemoveContainer(name, 1).catch(() => undefined);
        }
      }

      /** Every IPv4 address the daemon host holds, loopback aside. */
      async function daemonHostAddresses(): Promise<string[]> {
        const listed = await onDaemonHost("ip -o -4 addr show");
        expect(listed.exitCode).toBe(0);
        return [...listed.output.matchAll(/inet (\d+\.\d+\.\d+\.\d+)\//g)]
          .map((match) => match[1] ?? "")
          .filter((address) => address !== "" && !address.startsWith("127."));
      }

      test("is reached through the gateway of a network without the gateway mode", async () => {
        // The positive control: the listener is up, and an internal network
        // that keeps the default mode does hand the host an address on it —
        // one the host really holds.
        const network = await client.inspectNetwork(workerNetwork);
        const gateway = network?.IPAM?.Config?.[0]?.Gateway ?? "";
        expect(gateway).not.toBe("");
        expect(await daemonHostAddresses()).toContain(gateway);
        const deadline = Date.now() + 30_000;
        let reached = await probe(
          `wget -T 5 -q -O - http://${gateway}:${hostPort}/`,
        );
        while (reached.exitCode !== 0 && Date.now() < deadline) {
          await Bun.sleep(500);
          reached = await probe(
            `wget -T 5 -q -O - http://${gateway}:${hostPort}/`,
          );
        }
        expect(reached.output).toContain("host-listener");
        expect(reached.exitCode).toBe(0);
      }, 60_000);

      test("is reached at no address from a worker's own network, which gives the host none", async () => {
        const network = await client.inspectNetwork(
          networkNameFor(lateral.a, installationId),
        );
        expect(network?.Options).toMatchObject({
          "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
        });
        const config = network?.IPAM?.Config ?? [];
        expect(config.length).toBeGreaterThan(0);
        expect(config.every((entry) => !entry.Gateway)).toBe(true);
        // The bridge itself is there on the host, without an IPv4 address.
        const bridge = `br-${network?.Id.slice(0, 12)}`;
        const link = await onDaemonHost(`ip -o link show ${bridge}`);
        expect(link.exitCode).toBe(0);
        const addressed = await onDaemonHost(
          `ip -o -4 addr show dev ${bridge}`,
        );
        expect(addressed.exitCode).toBe(0);
        expect(addressed.output).not.toContain("inet ");

        // The worker is alive and on its link: it reaches the proxy directly.
        const toProxy = await execIn(lateral.a, `nc -z -w 3 ${proxyName} 3128`);
        expect(toProxy.exitCode).toBe(0);
        const routes = await execIn(lateral.a, "ip -4 route");
        expect(routes.output).toContain(config[0]?.Subnet ?? "<no subnet>");
        expect(routes.output).not.toContain("default");

        // And every address the host holds is out of its reach. A network in
        // the default mode would have put one of them on this very link.
        const addresses = await daemonHostAddresses();
        expect(addresses.length).toBeGreaterThan(0);
        for (const address of addresses) {
          const direct = await execIn(
            lateral.a,
            `wget -T 2 -q -Y off -O - http://${address}:${hostPort}/`,
          );
          expect(direct.output).not.toContain("host-listener");
          expect(direct.exitCode).not.toBe(0);
        }
      }, 180_000);
    });

    test("a proxy that lost its attachment is given it back by the reconcile", async () => {
      const network = networkNameFor(lateral.a, installationId);
      await client.disconnectNetwork(network, proxyName);
      const cut = await execIn(
        lateral.a,
        `wget -T 3 -q -O - http://${allowedName}:8080/`,
      );
      expect(cut.output).not.toContain("allowed-upstream");

      const result = await backend.reconcileNetworks();

      expect(result.repaired).toContain(network);
      expect(result.failed).toEqual([]);
      const restored = await execIn(
        lateral.a,
        `wget -T 10 -q -O - http://${allowedName}:8080/`,
      );
      expect(restored.output).toContain("allowed-upstream");
    }, 120_000);

    test("a never-started stranger on a worker's network costs that network the proxy", async () => {
      // The network inspect lists running endpoints only; this one would
      // join the moment it started.
      const network = networkNameFor(lateral.b, installationId);
      const stranger = `ap-it-stranger-${suffix}`;
      created.push(stranger);
      const response = await raw(
        "POST",
        `/containers/create?name=${stranger}`,
        {
          Cmd: ["sleep", "600"],
          HostConfig: { NetworkMode: network },
          Image: IMAGE,
        },
      );
      expect(response.status).toBe(201);
      try {
        const result = await backend.reconcileNetworks();

        expect(result.failed).toEqual([
          {
            error: expect.stringMatching(
              new RegExp(`${stranger}.*egress proxy was detached`),
            ),
            id: network,
          },
        ]);
        const proxy = await client.inspectContainer(proxyName);
        expect(
          Object.keys(proxy?.NetworkSettings?.Networks ?? {}),
        ).not.toContain(network);
      } finally {
        await raw("DELETE", `/containers/${stranger}?force=true`);
      }
      // Once it is gone the next pass puts the proxy back.
      expect((await backend.reconcileNetworks()).repaired).toEqual([network]);
    }, 60_000);

    test("the network of a force-removed worker is gone after one reconcile", async () => {
      const network = networkNameFor(lateral.c, otherInstallationId);
      await raw(
        "DELETE",
        `/containers/${containerNameFor(lateral.c, otherInstallationId)}?force=true`,
      );
      expect(await client.inspectNetwork(network)).not.toBeNull();

      const result = await other.reconcileNetworks();

      expect(result.removed).toEqual([network]);
      expect(await client.inspectNetwork(network)).toBeNull();
    }, 60_000);
  });

  test("an upstream back on a new address is followed at once by the proxy and by the S3 handler", async () => {
    // Stop the upstream, start a placeholder in the gap and the upstream again,
    // so it comes back on another address. Docker's DNS gave the old answer a
    // TTL of 600s; a resolver that kept it would miss the new address for ten
    // minutes. The placeholder cannot be pinned to the old address (the
    // runner's daemon refuses a static IP on a network without a configured
    // subnet), but it keeps the upstream from being handed that address back
    // by an allocator that reuses the lowest free one.
    const addressOf = async (name: string): Promise<string> =>
      (await client.inspectContainer(name))?.NetworkSettings?.Networks?.[
        outerNetwork
      ]?.IPAddress ?? "";
    const proxied = () =>
      probe(`wget -T 5 -q -O - http://${allowedName}:8080/`, withProxy());
    const oldAddress = await addressOf(allowedName);
    expect(oldAddress).not.toBe("");
    expect((await proxied()).output).toContain("allowed-upstream");

    // One long-lived process on the upstream's network, the way the API and
    // the scheduler reach LocalStack: the storage package's S3 handler, and
    // node:dns beside it as the control.
    const watcher = `ap-it-follow-${suffix}`;
    const script = join(probeDir, `${watcher}.ts`);
    await writeFile(script, FOLLOW_PROBE);
    created.push(watcher);
    const watched = await raw("POST", `/containers/create?name=${watcher}`, {
      Cmd: ["bun", "run", "/probe/probe.ts"],
      Env: [`TARGET=${allowedName}`],
      HostConfig: {
        Binds: [`${REPOSITORY}:/app:ro`, `${script}:/probe/probe.ts:ro`],
        NetworkMode: outerNetwork,
      },
      Image: PROXY_IMAGE,
      Tty: true,
      WorkingDir: "/app",
    });
    expect(watched.status).toBe(201);
    await client.startContainer(watcher);
    const followed = async (since: number): Promise<FollowLine[]> => {
      const response = await raw(
        "GET",
        `/containers/${watcher}/logs?stdout=true&stderr=true&since=${since}`,
      );
      return (await response.text())
        .split("\n")
        .filter((line) => line.startsWith("FOLLOW "))
        .map((line) => JSON.parse(line.slice("FOLLOW ".length)));
    };
    const warmDeadline = Date.now() + 60_000;
    while (!(await followed(0)).some((line) => line.handler === "ok")) {
      if (Date.now() > warmDeadline) {
        throw new Error(
          `watcher never reached ${allowedName}:\n${await logsOf(watcher)}`,
        );
      }
      await Bun.sleep(500);
    }

    await raw("POST", `/containers/${allowedName}/stop?t=1`);
    const placeholder = `ap-it-old-address-${suffix}`;
    created.push(placeholder);
    const parked = await raw("POST", `/containers/create?name=${placeholder}`, {
      Cmd: ["sleep", "600"],
      HostConfig: { NetworkMode: outerNetwork },
      Image: IMAGE,
    });
    expect(parked.status).toBe(201);
    await client.startContainer(placeholder);
    // Only the restarted upstream can answer after this: the daemon stamps
    // each log line, and the watcher's lines from the next whole second on,
    // well after the stop, are the ones asked for below.
    const sinceSec = Math.ceil(Date.now() / 1000);
    await Bun.sleep(1_100);
    await client.startContainer(allowedName);
    const restartedAt = Date.now();
    const newAddress = await addressOf(allowedName);
    expect(newAddress).not.toBe("");
    expect(newAddress).not.toBe(oldAddress);

    let proxyAfterMs: number | undefined;
    let handlerAfterMs: number | undefined;
    let last: FollowLine | undefined;
    while (Date.now() - restartedAt <= 60_000) {
      if (proxyAfterMs === undefined) {
        const through = await proxied();
        if (through.output.includes("allowed-upstream")) {
          proxyAfterMs = Date.now() - restartedAt;
        }
      }
      const lines = await followed(sinceSec);
      last = lines.at(-1) ?? last;
      if (
        handlerAfterMs === undefined &&
        lines.some((l) => l.handler === "ok")
      ) {
        handlerAfterMs = Date.now() - restartedAt;
      }
      if (proxyAfterMs !== undefined && handlerAfterMs !== undefined) break;
      await Bun.sleep(500);
    }
    console.log(
      `94S-344: ${allowedName} ${oldAddress} -> ${newAddress}; proxy back after ${proxyAfterMs}ms, S3 handler after ${handlerAfterMs}ms; node:dns still answers ${last?.cares}`,
    );
    expect(proxyAfterMs).toBeDefined();
    expect(handlerAfterMs).toBeDefined();
    // The control: node:dns in the same process still hands out the old
    // address, so this run did reproduce the cache the fix steps around.
    expect(last?.cares).toBe(oldAddress);
  }, 240_000);
});

/** Answers one line over TLS; written to the fixture directory at run time. */
const TLS_SERVER = `
Bun.serve({
  port: 8443,
  tls: { cert: Bun.file("/tls/cert.pem"), key: Bun.file("/tls/key.pem") },
  fetch: (request) => {
    console.log("served " + new URL(request.url).host);
    return new Response("tls-upstream");
  },

});
console.log("tls listening");
`;

/**
 * The authorizer container: the route's control-plane side on :3100, and a
 * control port on :3200 for the test. Written to a file at run time like
 * the probes.
 */
const AUTHORIZER = `
const { startObjectRouteFixture } = await import("/app/tests/object-route-fixture.ts");
const fixture = await startObjectRouteFixture({
  hostname: "0.0.0.0",
  objectStore: JSON.parse(process.env.OBJECT_STORE),
  port: 3100,
});
const sessions = new Map();
Bun.serve({
  hostname: "0.0.0.0",
  port: 3200,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture") {
      return Response.json({ authorizerToken: fixture.authorizerToken });
    }
    if (url.pathname === "/session") {
      const session = await fixture.openSession();
      sessions.set(session.sessionId, session);
      return Response.json({ sessionId: session.sessionId, token: await session.claim() });
    }
    if (url.pathname === "/claim") {
      const session = sessions.get(url.searchParams.get("session"));
      if (session === undefined) return new Response(null, { status: 404 });
      return Response.json({ token: await session.claim() });
    }
    return new Response(null, { status: 404 });
  },
});
console.log("authorizer listening");
`;

type FollowLine = { cares: string; handler: string };

/**
 * A long-lived process calling one upstream every half second through the
 * storage package's S3 handler, with node:dns's answer for the same name
 * beside each result.
 */
const FOLLOW_PROBE = `
import { lookup } from "node:dns/promises";
const { FreshAddressHttpHandler, S3_REQUEST_BOUNDS } = await import(
  "/app/packages/storage/src/s3.ts"
);
const hostname = process.env.TARGET;
const handler = new FreshAddressHttpHandler({
  ...S3_REQUEST_BOUNDS,
  connectionTimeout: 1_000,
  requestTimeout: 2_000,
});
for (;;) {
  let result;
  try {
    const { response } = await handler.handle({
      headers: {},
      hostname,
      method: "GET",
      path: "/",
      port: 8080,
      protocol: "http:",
      query: {},
    });
    response.body.resume();
    result = response.statusCode === 200 ? "ok" : "status " + response.statusCode;
  } catch (error) {
    result = "error " + (error.code ?? error.name);
  }
  const cares = await lookup(hostname).then((entry) => entry.address, () => "none");
  console.log("FOLLOW " + JSON.stringify({ handler: result, cares }));
  await Bun.sleep(500);
}
`;

/**
 * Everything the worker's store must do, from inside the container, reported
 * as one JSON line. Written to a file at run time so no probe script lives
 * in the source tree; it imports the module under test from the mounted
 * repository, which is what makes this the real factory.
 */
const OBJECT_PROBE = `
const { createWorkerObjectStore, objectStoreConfigFromEnv } = await import(
  "/app/apps/worker/src/object-store.ts"
);
const store = createWorkerObjectStore(
  objectStoreConfigFromEnv(process.env, process.env.WORKER_EGRESS_CREDENTIAL_URL),
  () => process.env.PROBE_OBJECT_TOKEN,
);
const prefix = process.env.WORKER_OBJECT_PREFIX;
const key = prefix + "checkpoints/0000000000/a1/manifest.json";
const encode = (text) => new TextEncoder().encode(text);
const refusal = async (run) => {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return error.name;
  }
};
const report = {};
report.putImmutable = (await store.putImmutable(key, encode('{"revision":0}'))).outcome;
report.duplicate = (await store.putImmutable(key, encode('{"revision":0}'))).outcome;
report.conflict = (await store.putImmutable(key, encode('{"revision":1}'))).outcome;
await store.putImmutable(prefix + "transcript/part-0", encode("part"));
report.put = "ok";
report.get = new TextDecoder().decode(await store.get(key));
report.head = (await store.head(key))?.bytes;
report.list = await store.list(prefix + "checkpoints/");
const foreign = "sessions/" + crypto.randomUUID() + "/checkpoints/0000000000/a1/manifest.json";
report.foreignGet = await refusal(() => store.get(foreign));
report.foreignPut = await refusal(() => store.putImmutable(foreign, encode("x")));
report.foreignList = await refusal(() => store.list("sessions/"));
console.log("PROBE " + JSON.stringify(report));
`;

/**
 * A plain S3 client, no wrapper, with the worker's token as its key and the
 * route as its endpoint: what a worker that bypasses its own store sends.
 * Each outcome is "allowed" or the S3 error code that came back.
 */
const RAW_PROBE = `
const s3 = await import(
  Bun.resolveSync("@aws-sdk/client-s3", "/app/packages/storage/src")
);
const bucket = process.env.S3_BUCKET;
const own = process.env.WORKER_OBJECT_PREFIX;
const foreign = process.env.PROBE_FOREIGN_PREFIX;
const client = (token) =>
  new s3.S3Client({
    credentials: { accessKeyId: token, secretAccessKey: "anything" },
    endpoint: process.env.WORKER_EGRESS_CREDENTIAL_URL + "/object-store",
    forcePathStyle: true,
    maxAttempts: 1,
    region: process.env.AWS_REGION,
  });
const outcome = async (send) => {
  try {
    await send;
    return "allowed";
  } catch (error) {
    return error.name;
  }
};
const worker = client(process.env.PROBE_OBJECT_TOKEN);
const report = {};
report.ownPut = await outcome(
  worker.send(new s3.PutObjectCommand({ IfNoneMatch: "*", Body: "mine", Bucket: bucket, Key: own + "raw" })),
);
if (foreign !== undefined) {
  report.foreignGet = await outcome(
    worker.send(new s3.GetObjectCommand({ Bucket: bucket, Key: foreign + "x" })),
  );
  report.foreignPut = await outcome(
    worker.send(new s3.PutObjectCommand({ IfNoneMatch: "*", Body: "x", Bucket: bucket, Key: foreign + "x" })),
  );
  report.foreignList = await outcome(
    worker.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: foreign })),
  );
  report.everySessionList = await outcome(
    worker.send(new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: "sessions/" })),
  );
  report.ownOverwrite = await outcome(
    worker.send(new s3.PutObjectCommand({ Body: "x", Bucket: bucket, Key: own + "raw" })),
  );
  report.foreignDelete = await outcome(
    worker.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: foreign + "x" })),
  );
  report.ownDelete = await outcome(
    worker.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: own + "raw" })),
  );
  report.legalHold = await outcome(
    worker.send(
      new s3.PutObjectLegalHoldCommand({
        Bucket: bucket,
        Key: own + "raw",
        LegalHold: { Status: "OFF" },
      }),
    ),
  );
  report.forgedToken = await outcome(
    client("weo_forged").send(new s3.GetObjectCommand({ Bucket: bucket, Key: own + "raw" })),
  );
}
if (process.env.PROBE_EARLIER_TOKEN !== undefined) {
  report.earlierPut = await outcome(
    client(process.env.PROBE_EARLIER_TOKEN).send(
      new s3.PutObjectCommand({ IfNoneMatch: "*", Body: "late", Bucket: bucket, Key: own + "late" }),
    ),
  );
}
console.log("PROBE " + JSON.stringify(report));
process.exit(0);
`;

/**
 * What a worker does between its claim and its engine for a session with
 * nothing to restore (`SessionCheckpoints.restorePlan`), in one process and
 * so on the same pooled proxy connections: a gateway call with Bun's fetch,
 * the session store's freshness check — an S3 list through the real
 * factory — and another gateway call.
 */
const SESSION_START_PROBE = `
const { createWorkerObjectStore, objectStoreConfigFromEnv } = await import(
  "/app/apps/worker/src/object-store.ts"
);
const { installedRuntimes } = await import(
  "/app/packages/adapters/runtimes/registry/src/index.ts"
);
const gateway = process.env.GATEWAY_PROBE_URL;
const call = async (path) => {
  const response = await fetch(gateway + path, {
    body: JSON.stringify({ session_id: "s" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return (await response.json()).answer;
};
const report = {};
report.claim = await call("/internal/worker/bootstrap-claim");
const store = installedRuntimes[0].openTranscriptStore({
  generation: 1,
  objects: createWorkerObjectStore(
    objectStoreConfigFromEnv(process.env, process.env.WORKER_EGRESS_CREDENTIAL_URL),
    () => process.env.PROBE_OBJECT_TOKEN,
  ),
  prefix: process.env.WORKER_OBJECT_PREFIX + "transcripts",
});
const settle = async (work) => {
  try {
    return await Promise.race([
      work(),
      Bun.sleep(20_000).then(() => {
        throw new Error("no answer in 20s");
      }),
    ]);
  } catch (error) {
    return String(error?.message ?? error).split("\\n")[0];
  }
};
report.fresh = await settle(async () => {
  await store.ready();
  return "ok";
});
// The first append reads its slot (404) and then PUTs the part. Bun's
// node:http sends the PUT down the connection the 404 came back on, so the
// proxy has to have ended it or the PUT is never answered.
const key = { projectKey: "p", sessionId: "s" };
report.append = await settle(async () => {
  await store.append(key, [
    { message: "x".repeat(7_000), type: "user", uuid: "u-1" },
  ]);
  return "ok";
});
report.load = await settle(async () => (await store.load(key))?.length ?? 0);
report.heartbeat = await settle(() => call("/internal/worker/heartbeat"));
console.log("PROBE " + JSON.stringify(report));
// A stalled request would otherwise hold the process open.
process.exit(0);
`;

const GATEWAY = `
Bun.serve({
  hostname: "0.0.0.0",
  // Bun's default of 10s would close the idle hop and let a stalled client
  // retry; a stall has to outlast the probe's 20s to count as one.
  idleTimeout: 120,
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);
    await request.text();
    // The real gateway answers after its database; the await is what makes
    // Bun keep the connection open.
    await Bun.sleep(10);
    return Response.json({ answer: "gateway " + url.pathname });
  },
});
console.log("gateway listening");
`;
