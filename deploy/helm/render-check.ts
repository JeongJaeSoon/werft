// Renders the chart with helm and fails on any manifest that breaks the
// chart's promises: every container hardened, sized and pinned by digest,
// probes on every long-running one, a token only where the scheduler needs
// one, the scheduler Role exactly the kubernetes backend's verbs, worker
// traffic held to the egress proxy (no DNS), the master key only on the api
// and the slack role, slack holding no provider or AWS key and its egress
// held to DNS, HTTPS and the database, and the Ingress routing only the
// api's public paths (the web console's "/" behind an ALB 404 on /internal)
// on an ALB that is not internet-facing, and the preview
// flag off in the AWS example. Run from the
// repository root:
// `bun deploy/helm/render-check.ts` (CI's helm-chart job).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageChart } from "../../.github/scripts/chart-package.ts";
import { parseImageRuntime } from "../../packages/runtime-core/src/image-runtime.ts";

const dir = import.meta.dir;
const chart = join(dir, "werft");
const ciDigests = join(dir, "ci-digests.yaml");
const awsExample = join(chart, "values-aws.example.yaml");

type ImageDefault = { repository: string; digest: string };

// The fields of rendered objects the checks read.
type RoleRule = { apiGroups?: string[]; resources: string[]; verbs: string[] };
type Port = { port?: number | string; protocol?: string };
type Peer = {
  podSelector?: { matchLabels?: Record<string, string> };
  namespaceSelector?: unknown;
};
type PolicyRule = { ports?: Port[]; to?: Peer[] };
type EnvVar = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { key: string };
    fieldRef?: { fieldPath?: string };
  };
};
// An entry a filter has already held to its secretKeyRef.
type SecretEnvVar = { valueFrom: { secretKeyRef: { key: string } } };
type Container = { env?: EnvVar[] };
type IngressPath = {
  path: string;
  pathType: string;
  backend?: { service?: { name: string; port?: { name?: string } } };
};

type Manifest = {
  kind: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  // biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
  spec?: any;
  rules?: RoleRule[];
};

function helmTemplate(
  args: string[],
  source = chart,
): { ok: boolean; out: string } {
  const result = spawnSync("helm", ["template", "ap", source, ...args], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: result.stdout + result.stderr };
}

function render(args: string[], source = chart): Manifest[] {
  const { ok, out } = helmTemplate(args, source);
  if (!ok) throw new Error(`helm template ${args.join(" ")} failed:\n${out}`);
  return (Bun.YAML.parse(out) as (Manifest | null)[]).filter(
    (doc): doc is Manifest => doc !== null,
  );
}

// biome-ignore lint/suspicious/noExplicitAny: rendered Kubernetes objects
function podSpecOf(m: Manifest): any {
  switch (m.kind) {
    case "Deployment":
    case "Job":
      return m.spec.template.spec;
    case "CronJob":
      return m.spec.jobTemplate.spec.template.spec;
    default:
      return undefined;
  }
}

const DIGEST_REF = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const SCHEDULER_RULES = {
  pods: ["create", "delete", "get", "list"],
  "pods/log": ["get"],
  secrets: ["create", "delete", "get", "list"],
  persistentvolumeclaims: ["create", "delete", "get", "list"],
};
const WORKER_LABELS = {
  "app.kubernetes.io/part-of": "werft",
  "app.kubernetes.io/component": "worker",
};

function check(
  label: string,
  manifests: Manifest[],
  scheduler: boolean,
): string[] {
  const errors: string[] = [];
  const fail = (m: Manifest, message: string) =>
    errors.push(`${label}: ${m.kind}/${m.metadata.name}: ${message}`);

  let workloads = 0;
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    workloads++;
    const component = m.metadata.labels?.["app.kubernetes.io/component"];
    if (pod.securityContext?.seccompProfile?.type !== "RuntimeDefault") {
      fail(m, "pod seccompProfile is not RuntimeDefault");
    }
    if (pod.securityContext?.runAsNonRoot !== true) {
      fail(m, "pod runAsNonRoot is not true");
    }
    const wantsToken = component === "scheduler";
    if (pod.automountServiceAccountToken !== wantsToken) {
      fail(m, `automountServiceAccountToken is not ${wantsToken}`);
    }
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const where = `container ${c.name}`;
      const sc = c.securityContext ?? {};
      if (sc.runAsNonRoot !== true) fail(m, `${where}: runAsNonRoot`);
      if (sc.allowPrivilegeEscalation !== false) {
        fail(m, `${where}: allowPrivilegeEscalation`);
      }
      if (sc.readOnlyRootFilesystem !== true) {
        fail(m, `${where}: readOnlyRootFilesystem`);
      }
      if (!sc.capabilities?.drop?.includes("ALL")) {
        fail(m, `${where}: capabilities.drop ALL`);
      }
      if (sc.seccompProfile?.type !== "RuntimeDefault") {
        fail(m, `${where}: seccompProfile RuntimeDefault`);
      }
      if (!c.resources?.requests?.memory || !c.resources?.limits?.memory) {
        fail(m, `${where}: memory request and limit`);
      }
      if (!DIGEST_REF.test(c.image)) {
        fail(m, `${where}: image ${c.image} is not repository@sha256:digest`);
      }
      // Long-running workloads only: a Job's pod has nothing to probe.
      if (m.kind === "Deployment" && !(c.readinessProbe && c.livenessProbe)) {
        fail(m, `${where}: readiness and liveness probes`);
      }
    }
  }
  if (workloads < 5) {
    errors.push(`${label}: only ${workloads} workloads rendered`);
  }

  const roles = manifests.filter((m) => m.kind === "Role");
  if (roles.length !== (scheduler ? 1 : 0)) {
    errors.push(
      `${label}: expected ${scheduler ? 1 : 0} Role, got ${roles.length}`,
    );
  }
  for (const role of roles) {
    const got: Record<string, string[]> = {};
    for (const rule of role.rules ?? []) {
      if (JSON.stringify(rule.apiGroups) !== '[""]') {
        fail(role, `rule outside the core API group: ${JSON.stringify(rule)}`);
      }
      for (const resource of rule.resources) {
        got[resource] = [...(got[resource] ?? []), ...rule.verbs].sort();
      }
    }
    if (JSON.stringify(got) !== JSON.stringify(SCHEDULER_RULES)) {
      fail(role, `rules ${JSON.stringify(got)} are not the contract's`);
    }
  }
  const schedulers = manifests.filter(
    (m) =>
      m.kind === "Deployment" &&
      m.metadata.labels?.["app.kubernetes.io/component"] === "scheduler",
  );
  if (schedulers.length !== (scheduler ? 1 : 0)) {
    errors.push(`${label}: expected ${scheduler ? 1 : 0} scheduler Deployment`);
  }
  for (const m of schedulers) {
    const variables: { name: string; value?: string }[] =
      podSpecOf(m).containers[0].env ?? [];
    const backend = variables.find((v) => v.name === "EXECUTION_BACKEND");
    if (backend?.value !== "kubernetes") {
      fail(m, "EXECUTION_BACKEND is not kubernetes");
    }
    const disk = variables.find(
      (v) => v.name === "EXECUTION_K8S_WORKER_EPHEMERAL_STORAGE_MB",
    );
    if (!/^[1-9]\d*$/.test(disk?.value ?? "")) {
      fail(m, "worker ephemeral-storage is not a positive MB count");
    }
  }
  if (manifests.some((m) => m.kind.startsWith("Cluster"))) {
    errors.push(`${label}: a cluster-scoped RBAC object rendered`);
  }

  const workerPolicy = manifests.find(
    (m) =>
      m.kind === "NetworkPolicy" &&
      m.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] ===
        "worker",
  );
  if (workerPolicy === undefined) {
    errors.push(`${label}: no worker NetworkPolicy`);
  } else {
    const spec = workerPolicy.spec;
    const selector = spec.podSelector.matchLabels;
    for (const [key, value] of Object.entries(WORKER_LABELS)) {
      if (selector[key] !== value) fail(workerPolicy, `selector ${key}`);
    }
    if (!selector["werft.installation"]) {
      fail(workerPolicy, "selector has no installation label");
    }
    if (
      JSON.stringify([...spec.policyTypes].sort()) !== '["Egress","Ingress"]' ||
      (spec.ingress ?? []).length !== 0
    ) {
      fail(workerPolicy, "must deny all ingress and restrict egress");
    }
    const targets = (spec.egress ?? []).map((rule: PolicyRule) => ({
      component:
        rule.to?.[0]?.podSelector?.matchLabels?.[
          "app.kubernetes.io/component"
        ] ?? rule.to?.[0]?.podSelector?.matchLabels?.["k8s-app"],
      hasNamespace: rule.to?.[0]?.namespaceSelector !== undefined,
      ports: (rule.ports ?? []).map((p) => `${p.protocol}/${p.port}`),
      peers: rule.to?.length ?? 0,
    }));
    const expected = [
      {
        component: "egress-proxy",
        hasNamespace: false,
        ports: ["TCP/3128", "TCP/3129"],
        peers: 1,
      },
    ];
    const dns = (spec.egress ?? []).some((rule: PolicyRule) =>
      // No port is every port.
      ((rule.ports ?? [{}]) as { port?: number }[]).some(
        (p) => p.port === undefined || p.port === 53,
      ),
    );
    if (dns) {
      fail(workerPolicy, "egress reaches DNS: a query is a way out");
    }
    if (JSON.stringify(targets) !== JSON.stringify(expected)) {
      fail(workerPolicy, `egress ${JSON.stringify(targets)}`);
    }
  }

  const apiPolicy = manifests.find(
    (m) =>
      m.kind === "NetworkPolicy" &&
      m.spec.podSelector?.matchLabels?.["app.kubernetes.io/component"] ===
        "api",
  );
  const authorizerRule = apiPolicy?.spec.ingress?.find((rule: PolicyRule) =>
    rule.ports?.some((p) => p.port === 3100),
  );
  if (
    authorizerRule?.from?.length !== 1 ||
    authorizerRule.from[0].podSelector?.matchLabels?.[
      "app.kubernetes.io/component"
    ] !== "egress-proxy"
  ) {
    errors.push(`${label}: api 3100 must admit the egress proxy alone`);
  }
  for (const service of manifests.filter((m) => m.kind === "Service")) {
    if (
      service.spec.ports.some((p: Port) => p.port === 3100) &&
      service.spec.type !== "ClusterIP"
    ) {
      fail(service, "the authorizer must stay ClusterIP");
    }
  }
  return errors;
}

const OBJECT_STORE_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
const IRSA_ROLE = "eks.amazonaws.com/role-arn";

/**
 * Static S3 keys reach the api and its two object store jobs exactly when `keys`, and
 * no other workload ever. Without them the api's ServiceAccount must carry
 * an IRSA role, or nothing could sign the object store.
 */
function checkObjectStoreKeys(
  label: string,
  manifests: Manifest[],
  keys: boolean,
): string[] {
  const errors: string[] = [];
  const holders = ["api", "checkpoint-gc", "session-archive"];
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    const component = m.metadata.labels?.["app.kubernetes.io/component"] ?? "";
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const names = new Set((c.env ?? []).map((v: { name: string }) => v.name));
      const got = OBJECT_STORE_KEYS.filter((name) => names.has(name));
      const want = keys && holders.includes(component) ? OBJECT_STORE_KEYS : [];
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        errors.push(
          `${label}: ${m.kind}/${m.metadata.name}: container ${c.name} has AWS keys ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`,
        );
      }
    }
  }
  const apiAccount = manifests.find(
    (m) =>
      m.kind === "ServiceAccount" &&
      m.metadata.labels?.["app.kubernetes.io/component"] === "api",
  ) as
    | (Manifest & { metadata: { annotations?: Record<string, string> } })
    | undefined;
  if (!keys && !apiAccount?.metadata.annotations?.[IRSA_ROLE]) {
    errors.push(
      `${label}: no static keys and no IRSA role on the api ServiceAccount`,
    );
  }
  return errors;
}

const SECRET_KEY = "PLATFORM_SECRET_KEY";

const SECRET_KEY_HOLDERS = ["api", "slack"];

function checkSecretKey(
  label: string,
  manifests: Manifest[],
  slack: boolean,
): string[] {
  const errors: string[] = [];
  const holders: Record<string, number> = { api: 0, slack: 0 };
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    const component = m.metadata.labels?.["app.kubernetes.io/component"] ?? "";
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const entry = (c.env ?? []).find((v: EnvVar) => v.name === SECRET_KEY);
      if (entry === undefined) continue;
      const where = `${label}: ${m.kind}/${m.metadata.name}: container ${c.name}`;
      if (!SECRET_KEY_HOLDERS.includes(component) || c.name !== component) {
        errors.push(`${where} has ${SECRET_KEY}`);
        continue;
      }
      holders[component] = (holders[component] ?? 0) + 1;
      if (
        entry.valueFrom?.secretKeyRef === undefined ||
        entry.valueFrom.secretKeyRef.optional === true
      ) {
        errors.push(`${where}: ${SECRET_KEY} is not a required secretKeyRef`);
      }
    }
  }
  const want: Record<string, number> = { api: 1, slack: slack ? 1 : 0 };
  for (const holder of SECRET_KEY_HOLDERS) {
    if (holders[holder] !== want[holder]) {
      errors.push(
        `${label}: ${SECRET_KEY} is on ${holders[holder]} ${holder} containers, expected ${want[holder]}`,
      );
    }
  }
  return errors;
}

const SLACK_EGRESS = ["UDP/53", "TCP/53", "TCP/443", "TCP/5432"];
const SLACK_SECRETS = ["DATABASE_URL", SECRET_KEY];

function checkSlack(
  label: string,
  manifests: Manifest[],
  enabled: boolean,
): string[] {
  const errors: string[] = [];
  const want = enabled ? 1 : 0;
  const ofSlack = (kind: string) =>
    manifests.filter(
      (m) =>
        m.kind === kind &&
        m.metadata.labels?.["app.kubernetes.io/component"] === "slack",
    );
  for (const kind of ["Deployment", "NetworkPolicy"]) {
    const got = ofSlack(kind).length;
    if (got !== want) {
      errors.push(`${label}: expected ${want} slack ${kind}, got ${got}`);
    }
  }
  for (const m of ofSlack("Deployment")) {
    const where = `${label}: ${m.kind}/${m.metadata.name}`;
    const pod = podSpecOf(m);
    const workload = m.metadata.name.replace(/-slack$/, "-workload");
    if (pod.serviceAccountName !== workload) {
      errors.push(
        `${where}: ServiceAccount ${pod.serviceAccountName} is not ${workload}`,
      );
    }
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const secrets = (c.env ?? [])
        .filter((v: EnvVar) => v.valueFrom?.secretKeyRef !== undefined)
        .map((v: SecretEnvVar) => v.valueFrom.secretKeyRef.key as string);
      const extra = secrets.filter((key) => !SLACK_SECRETS.includes(key));
      if (extra.length > 0 || (c.envFrom ?? []).length > 0) {
        errors.push(
          `${where}: container ${c.name} holds Secret keys ${JSON.stringify(extra)} beyond ${JSON.stringify(SLACK_SECRETS)}`,
        );
      }
    }
  }
  for (const policy of ofSlack("NetworkPolicy")) {
    const spec = policy.spec;
    const ports = (spec.egress ?? []).flatMap((rule: PolicyRule) => {
      if (rule.ports === undefined) return ["any port"];
      return rule.ports.map((p) => `${p.protocol}/${p.port}`);
    });
    if (
      JSON.stringify(spec.policyTypes) !== '["Egress"]' ||
      JSON.stringify(ports) !== JSON.stringify(SLACK_EGRESS)
    ) {
      errors.push(
        `${label}: NetworkPolicy/${policy.metadata.name}: egress ${JSON.stringify(ports)} is not ${JSON.stringify(SLACK_EGRESS)}`,
      );
    }
  }
  return errors;
}

const WORKER_IMAGE_ROLES = ["api", "slack", "scheduler"];

/**
 * The api and slack judge release spec pins by the worker images' runtimes and the
 * scheduler picks each session's image by them: all three get the same
 * values, and only the scheduler, which launches on it, the previous image.
 */
function checkWorkerImages(
  label: string,
  manifests: Manifest[],
  want: {
    runtime?: string;
    previousRuntime?: string;
    previousImage?: string;
    /** images.workers: WORKER_IMAGES on all three, and no WORKER_IMAGE. */
    list?: string;
  },
): string[] {
  const errors: string[] = [];
  for (const role of WORKER_IMAGE_ROLES) {
    const deployments = manifests.filter(
      (m) =>
        m.kind === "Deployment" &&
        m.metadata.labels?.["app.kubernetes.io/component"] === role,
    );
    if (deployments.length !== 1) {
      errors.push(`${label}: expected 1 ${role} Deployment`);
      continue;
    }
    const [deployment] = deployments as [Manifest];
    const env = new Map<string, string>(
      podSpecOf(deployment)
        .containers.flatMap((c: Container) => c.env ?? [])
        .map((v: EnvVar) => [v.name, v.value]),
    );
    const expected: [string, string | undefined][] = [
      ["WORKER_IMAGE_RUNTIME", want.runtime],
      ["WORKER_IMAGE_PREVIOUS_RUNTIME", want.previousRuntime],
      [
        "WORKER_IMAGE_PREVIOUS",
        role === "scheduler" ? want.previousImage : undefined,
      ],
      ["WORKER_IMAGES", want.list],
      ...(want.list === undefined
        ? []
        : [["WORKER_IMAGE", undefined] as [string, undefined]]),
    ];
    for (const [name, value] of expected) {
      if (env.get(name) !== value) {
        errors.push(
          `${label}: ${role} ${name} is ${JSON.stringify(env.get(name))}, not ${JSON.stringify(value)}`,
        );
      }
    }
  }
  return errors;
}

const PREVIEW_ENV = "PREVIEW_NAMESPACE";

/**
 * PREVIEW_NAMESPACE (apps/control-host/src/api/demo-accounts.ts) is on the
 * api container exactly when `enabled`, and only from the pod's own
 * namespace: a literal value could name another namespace's database.
 */
function checkPreview(
  label: string,
  manifests: Manifest[],
  enabled: boolean,
): string[] {
  const errors: string[] = [];
  let holders = 0;
  for (const m of manifests) {
    const pod = podSpecOf(m);
    if (pod === undefined) continue;
    const role = m.metadata.labels?.["app.kubernetes.io/component"] ?? "";
    for (const c of [...(pod.initContainers ?? []), ...pod.containers]) {
      const env: EnvVar[] = c.env ?? [];
      // Every entry: with a duplicate name the last one wins.
      for (const entry of env.filter((v) => v.name === PREVIEW_ENV)) {
        const where = `${label}: ${m.kind}/${m.metadata.name}: container ${c.name}`;
        if (!enabled || role !== "api" || c.name !== "api") {
          errors.push(
            `${where} has ${PREVIEW_ENV}, expected ${enabled ? "only on the api container" : "nowhere: preview.enabled is off"}`,
          );
          continue;
        }
        holders++;
        if (
          entry.value !== undefined ||
          entry.valueFrom?.fieldRef?.fieldPath !== "metadata.namespace"
        ) {
          errors.push(`${where}: ${PREVIEW_ENV} is not the pod's namespace`);
        }
      }
    }
  }
  if (enabled && holders !== 1) {
    errors.push(`${label}: ${PREVIEW_ENV} is on ${holders} api containers`);
  }
  return errors;
}

// The api's public mounts (apps/control-host/src/api/app.ts). /internal is
// the workers' gateway and must never be reachable from the load balancer.
const PUBLIC_PATHS = [
  "Prefix /v1",
  "Prefix /v1/slack/events",
  "Prefix /v1/slack/interactions",
  "Prefix /docs",
  "Exact /healthz",
  "Exact /readyz",
];
// With the web console on, "/" would match /internal too, so an ALB
// fixed-response 404 on /internal has to come first. The controller ranks
// the longer Prefix first anyway; the spec order holds that on its face.
const CONSOLE_PATHS = ["Prefix /internal", ...PUBLIC_PATHS, "Prefix /"];
const ALB_ACTION = "alb.ingress.kubernetes.io/actions.";
const BLOCK_ACTION = {
  type: "fixed-response",
  fixedResponseConfig: { contentType: "text/plain", statusCode: "404" },
};
// Extra conditions, rewrites, a shared group's earlier rules or another
// controller can each send /internal past the 404 to the api.
const ROUTE_OVERRIDE =
  /^(alb\.ingress\.kubernetes\.io\/(actions|conditions|transforms|group)\.|kubernetes\.io\/ingress\.class$)/;

function blocksInternal(
  annotations: Record<string, string>,
  path: IngressPath,
): boolean {
  const service = path.backend?.service;
  if (
    path.path !== "/internal" ||
    path.pathType !== "Prefix" ||
    service?.port?.name !== "use-annotation"
  ) {
    return false;
  }
  try {
    const action = JSON.parse(annotations[`${ALB_ACTION}${service.name}`]);
    return Bun.deepEquals(action, BLOCK_ACTION, true);
  } catch {
    return false;
  }
}

function checkIngress(
  label: string,
  manifests: Manifest[],
  enabled: boolean,
  console = enabled,
): string[] {
  const errors: string[] = [];
  const ingresses = manifests.filter((m) => m.kind === "Ingress");
  if (ingresses.length !== (enabled ? 1 : 0)) {
    errors.push(
      `${label}: expected ${enabled ? 1 : 0} Ingress, got ${ingresses.length}`,
    );
  }
  for (const ingress of ingresses) {
    const fail = (message: string) =>
      errors.push(`${label}: Ingress/${ingress.metadata.name}: ${message}`);
    // The Ingress carries the api Service's name; its "http" port is 3000.
    const api = ingress.metadata.name;
    const apiService = manifests.find(
      (m) => m.kind === "Service" && m.metadata.name === api,
    );
    const httpPort = apiService?.spec.ports?.find(
      (port: { name: string }) => port.name === "http",
    );
    if (httpPort?.port !== 3000) {
      fail(`Service/${api} has no "http" port 3000`);
    }
    const annotations = ingress.metadata.annotations ?? {};
    if (annotations["alb.ingress.kubernetes.io/scheme"] === "internet-facing") {
      fail("the ALB scheme is internet-facing; the entrance is in-house only");
    }
    if (ingress.spec.defaultBackend !== undefined) {
      fail("a default backend routes every path");
    }
    if (console && ingress.spec.ingressClassName !== "alb") {
      fail("the console needs ingressClassName alb");
    }
    const blockAction = `${ALB_ACTION}block-internal`;
    for (const key of Object.keys(annotations)) {
      if (console && key !== blockAction && ROUTE_OVERRIDE.test(key)) {
        fail(`${key} can route /internal past the 404`);
      }
    }
    for (const rule of ingress.spec.rules ?? []) {
      const paths: IngressPath[] = rule.http?.paths ?? [];
      let blocked = false;
      for (const path of paths) {
        if (blocksInternal(annotations, path)) {
          blocked = true;
          continue;
        }
        const { path: p } = path;
        const service = path.backend?.service;
        if (service?.name !== api || service?.port?.name !== "http") {
          fail(`${p} does not route to Service/${api} port http`);
        }
        if (
          ("/internal/".startsWith(p) || p.startsWith("/internal")) &&
          !blocked
        ) {
          fail(`${p} routes /internal`);
        }
      }
      const want = console ? CONSOLE_PATHS : PUBLIC_PATHS;
      const got = paths.map((p) => `${p.pathType} ${p.path}`);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        fail(`paths ${JSON.stringify(got)} are not ${JSON.stringify(want)}`);
      }
    }
  }
  return errors;
}

/**
 * The metrics workload renders only when enabled: one replica replaced with
 * Recreate (a second would be a duplicate scrape target), a ClusterIP
 * Service, DATABASE_URL its one Secret key, and a NetworkPolicy admitting
 * the metrics port alone.
 */
function checkMetrics(
  label: string,
  manifests: Manifest[],
  enabled: boolean,
  networkPolicy: boolean,
): string[] {
  const errors: string[] = [];
  const ofMetrics = (kind: string) =>
    manifests.filter(
      (m) =>
        m.kind === kind &&
        m.metadata.labels?.["app.kubernetes.io/component"] === "metrics",
    );
  const want = (kind: string) =>
    !enabled ? 0 : kind === "NetworkPolicy" && !networkPolicy ? 0 : 1;
  for (const kind of ["Deployment", "Service", "NetworkPolicy"]) {
    const got = ofMetrics(kind).length;
    if (got !== want(kind)) {
      errors.push(
        `${label}: expected ${want(kind)} metrics ${kind}, got ${got}`,
      );
    }
  }
  for (const m of ofMetrics("Deployment")) {
    const where = `${label}: ${m.kind}/${m.metadata.name}`;
    if (m.spec.replicas !== 1 || m.spec.strategy?.type !== "Recreate") {
      errors.push(`${where}: not one replica replaced with Recreate`);
    }
    for (const c of podSpecOf(m).containers) {
      const secrets = (c.env ?? [])
        .filter((v: EnvVar) => v.valueFrom?.secretKeyRef !== undefined)
        .map((v: SecretEnvVar) => v.valueFrom.secretKeyRef.key as string);
      if (JSON.stringify(secrets) !== '["DATABASE_URL"]') {
        errors.push(
          `${where}: container ${c.name} holds Secret keys ${JSON.stringify(secrets)}`,
        );
      }
    }
  }
  for (const service of ofMetrics("Service")) {
    if (service.spec.type !== "ClusterIP") {
      errors.push(
        `${label}: Service/${service.metadata.name} is not ClusterIP`,
      );
    }
  }
  for (const policy of ofMetrics("NetworkPolicy")) {
    const ports = (policy.spec.ingress ?? []).flatMap((rule: PolicyRule) =>
      (rule.ports ?? [{}]).map((p: Port) => `${p.protocol}/${p.port}`),
    );
    if (
      JSON.stringify(policy.spec.policyTypes) !== '["Ingress"]' ||
      JSON.stringify(ports) !== '["TCP/9464"]'
    ) {
      errors.push(
        `${label}: NetworkPolicy/${policy.metadata.name}: ingress ${JSON.stringify(ports)} is not the metrics port alone`,
      );
    }
  }
  return errors;
}

// Renders that must fail, each with the message that says why.
const componentOf = (m: Manifest) =>
  m.metadata.labels?.["app.kubernetes.io/component"];

// The upgrade check gates the migration, so it must run first, on upgrades
// only, once, and see nothing but the database and the release's own values.
function checkUpgradeHook(
  label: string,
  manifests: Manifest[],
  scheduler: boolean,
  approved: string[],
): string[] {
  const errors: string[] = [];
  const checks = manifests.filter((m) => componentOf(m) === "upgrade-check");
  if (!scheduler) {
    if (checks.length > 0) {
      errors.push(`${label}: the upgrade check renders with no scheduler`);
    }
    return errors;
  }
  const [job] = checks;
  const migrate = manifests.find((m) => componentOf(m) === "migrate");
  if (checks.length !== 1 || job?.kind !== "Job" || migrate === undefined) {
    return [`${label}: expected one upgrade-check Job beside the migrate Job`];
  }
  const fail = (message: string) =>
    errors.push(`${label}: Job/${job.metadata.name}: ${message}`);
  const hook = job.metadata.annotations ?? {};
  if (hook["helm.sh/hook"] !== "pre-upgrade") {
    fail(`hook is ${hook["helm.sh/hook"]}, not pre-upgrade alone`);
  }
  const weight = Number(hook["helm.sh/hook-weight"]);
  const migrateWeight = Number(
    migrate.metadata.annotations?.["helm.sh/hook-weight"],
  );
  if (!(weight < migrateWeight)) {
    fail(
      `hook weight ${weight} does not run before migrate (${migrateWeight})`,
    );
  }
  if (job.spec?.backoffLimit !== 0) fail("backoffLimit is not 0");
  const env: { name: string; value?: string; valueFrom?: unknown }[] =
    job.spec.template.spec.containers[0].env;
  const secrets = env.filter((e) => e.valueFrom !== undefined);
  if (secrets.map((e) => e.name).join() !== "DATABASE_URL") {
    fail(`secret env ${secrets.map((e) => e.name).join()}, not DATABASE_URL`);
  }
  const value = (name: string) => env.find((e) => e.name === name)?.value;
  // lookup reads nothing under `helm template`, which the CLI refuses.
  for (const name of [
    "WORKER_IMAGES",
    "WORKER_IMAGE",
    "WORKER_IMAGE_RUNTIME",
    "WORKER_IMAGE_PREVIOUS",
    "WORKER_IMAGE_PREVIOUS_RUNTIME",
  ]) {
    if (value(`UPGRADE_DEPLOYED_${name}`) !== "") {
      fail(`UPGRADE_DEPLOYED_${name} is not empty without a cluster`);
    }
  }
  // Either value of it opens a path that skips a comparison.
  if (value("UPGRADE_DEPLOYED_STATE") !== "") {
    fail("UPGRADE_DEPLOYED_STATE is not empty without a cluster");
  }
  if (
    value("WORKER_IMAGES") === undefined &&
    !DIGEST_REF.test(value("WORKER_IMAGE") ?? "")
  ) {
    fail("WORKER_IMAGE is not the target worker digest");
  }
  // It must judge the images the target scheduler will launch on.
  const schedulerDeployment = manifests.find(
    (m) => m.kind === "Deployment" && componentOf(m) === "scheduler",
  );
  const schedulerEnv: { name: string; value?: string }[] =
    schedulerDeployment === undefined
      ? []
      : podSpecOf(schedulerDeployment).containers[0].env;
  for (const name of [
    "WORKER_IMAGES",
    "WORKER_IMAGE",
    "WORKER_IMAGE_PREVIOUS",
    "WORKER_IMAGE_RUNTIME",
    "WORKER_IMAGE_PREVIOUS_RUNTIME",
  ]) {
    const want = schedulerEnv.find((e) => e.name === name)?.value;
    if (value(name) !== want) {
      fail(`${name} is ${value(name)}, the scheduler's is ${want}`);
    }
  }
  if (value("UPGRADE_APPROVED_SESSIONS") !== JSON.stringify(approved)) {
    fail(
      `UPGRADE_APPROVED_SESSIONS is ${value("UPGRADE_APPROVED_SESSIONS")}, not ${JSON.stringify(approved)}`,
    );
  }
  return errors;
}

const LISTED_RUNTIME = { engine: "claude", sdkVersion: "1", cliVersion: "1" };
const listedWorker = (fields: Record<string, unknown> = {}) => ({
  repository: "reg/worker",
  digest: `sha256:${"5".repeat(64)}`,
  runtime: LISTED_RUNTIME,
  releasedAt: "2026-11-10T00:00:00Z",
  ...fields,
});
// A packaged chart fills images.worker, and helm merges a map into the
// default: only null clears its runtime.
const listInstead = (workers: unknown) => [
  "--set",
  "images.worker.digest=",
  "--set-json",
  "images.worker.runtime=null",
  "--set-json",
  `images.workers=${JSON.stringify(workers)}`,
];
const MUST_FAIL: [string, string[], RegExp][] = [
  ["default values (no digests)", [], /digest must be sha256/],
  [
    "the console on a controller other than the ALB",
    [
      "-f",
      ciDigests,
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hosts[0].host=agent-platform.example.com",
      "--set",
      "ingress.console.enabled=true",
    ],
    /ingress\.console\.enabled needs ingress\.className alb/,
  ],
  ...[
    "alb.ingress.kubernetes.io/conditions.block-internal",
    "alb.ingress.kubernetes.io/conditions.ap-werft-api",
    "alb.ingress.kubernetes.io/transforms.ap-werft-api",
    "alb.ingress.kubernetes.io/actions.block-internal",
    "alb.ingress.kubernetes.io/group.name",
    "kubernetes.io/ingress.class",
  ].map((key): [string, string[], RegExp] => [
    `${key} with the console on`,
    [
      "-f",
      ciDigests,
      "-f",
      awsExample,
      "--set",
      "ingress.console.enabled=true",
      "--set-string",
      `ingress.annotations.${key.replaceAll(".", "\\.")}=x`,
    ],
    /ingress\.annotations must not set .* while ingress\.console\.enabled/,
  ]),
  [
    "a tag-only image",
    [
      "-f",
      ciDigests,
      "--set",
      "images.controlHost.repository=example/control-host:1.0",
    ],
    /must not carry a tag or digest/,
  ],
  [
    "a malformed digest",
    ["-f", ciDigests, "--set", "images.egressProxy.digest=sha256:abc"],
    /digest must be sha256/,
  ],
  ...["29", "3651", "45.5", "abc", "-30"].map(
    (days): [string, string[], RegExp] => [
      `sessionArchive.afterDays=${days}`,
      ["-f", ciDigests, "--set", `sessionArchive.afterDays=${days}`],
      /sessionArchive.afterDays must be 0 \(off\) or 30–3650/,
    ],
  ),
  [
    "an installation id that is no label value",
    ["-f", ciDigests, "--set", "installationId=not/a/label"],
    /installationId must be a Kubernetes label value/,
  ],
  [
    "a previous worker image without its runtime",
    [
      "-f",
      ciDigests,
      "--set-json",
      'images.worker.runtime={"engine":"claude","sdkVersion":"0.3.280","cliVersion":"2.1.280","profileDigestScheme":1}',
      "--set",
      `images.workerPrevious.digest=sha256:${"4".repeat(64)}`,
    ],
    /images\.workerPrevious\.runtime is required/,
  ],
  [
    "a previous worker runtime without its image",
    [
      "-f",
      ciDigests,
      "--set-json",
      'images.worker.runtime={"engine":"claude","sdkVersion":"0.3.280","cliVersion":"2.1.280","profileDigestScheme":1}',
      "--set-json",
      'images.workerPrevious.runtime={"engine":"claude","sdkVersion":"0.3.270","cliVersion":"2.1.270","profileDigestScheme":1}',
    ],
    /images\.workerPrevious\.digest is required/,
  ],
  [
    "a previous worker image without the current one's runtime",
    [
      "-f",
      ciDigests,
      "--set",
      `images.workerPrevious.digest=sha256:${"4".repeat(64)}`,
      "--set-json",
      'images.workerPrevious.runtime={"engine":"claude","sdkVersion":"0.3.270","cliVersion":"2.1.270","profileDigestScheme":1}',
    ],
    /images\.workerPrevious needs images\.worker\.runtime/,
  ],
  [
    "a worker runtime missing its CLI version",
    [
      "-f",
      ciDigests,
      "--set-json",
      'images.worker.runtime={"engine":"claude","sdkVersion":"0.3.280","profileDigestScheme":1}',
    ],
    /images\.worker\.runtime\.cliVersion must be a non-empty string/,
  ],
  [
    "a worker runtime naming an engine the platform does not have",
    [
      "-f",
      ciDigests,
      "--set-json",
      'images.worker.runtime={"engine":"claude-agent-sdk","sdkVersion":"0.3.280","cliVersion":"2.1.280","profileDigestScheme":1}',
    ],
    /images\.worker\.runtime\.engine must be one of: claude/,
  ],
  [
    "a previous worker runtime with a scheme of zero",
    [
      "-f",
      ciDigests,
      "--set-json",
      'images.worker.runtime={"engine":"claude","sdkVersion":"0.3.280","cliVersion":"2.1.280","profileDigestScheme":1}',
      "--set",
      `images.workerPrevious.digest=sha256:${"4".repeat(64)}`,
      "--set-json",
      'images.workerPrevious.runtime={"engine":"claude","sdkVersion":"0.3.270","cliVersion":"2.1.270","profileDigestScheme":0}',
    ],
    /images\.workerPrevious\.runtime\.profileDigestScheme must be a positive integer/,
  ],
  ...[
    "api.extraEnv.PREVIEW_NAMESPACE=prod",
    "scheduler.extraEnv.PREVIEW_NAMESPACE=prod",
    "config.limits.PREVIEW_NAMESPACE=prod",
    "secrets.catalogEnv={ANTHROPIC_API_KEY,PREVIEW_NAMESPACE}",
  ].map((set): [string, string[], RegExp] => [
    `PREVIEW_NAMESPACE through ${set.split(/[.=]/).slice(0, 2).join(".")}`,
    ["-f", ciDigests, "--set", set],
    /PREVIEW_NAMESPACE must not be set through/,
  ]),
  ...[
    "scheduler.extraEnv.WORKER_IMAGE=reg/worker@sha256:x",
    "scheduler.extraEnv.WORKER_IMAGES=x",
    "api.extraEnv.WORKER_IMAGE_RUNTIME=x",
    "config.limits.WORKER_IMAGE_PREVIOUS=reg/worker@sha256:x",
    "secrets.catalogEnv={ANTHROPIC_API_KEY,WORKER_IMAGE_PREVIOUS_RUNTIME}",
    "scheduler.enabled=false,api.extraEnv.WORKER_IMAGE_RUNTIME=x",
  ].map((set): [string, string[], RegExp] => [
    `a worker image variable through ${set.split(/[.=]/).slice(0, 2).join(".")}`,
    ["-f", ciDigests, "--set", set],
    /must not be set through extraEnv, config\.limits or secrets\.catalogEnv/,
  ]),
  [
    "images.workers beside images.worker",
    [
      "-f",
      ciDigests,
      "--set-json",
      `images.workers=[{"repository":"reg/worker","digest":"sha256:${"5".repeat(64)}","runtime":{"engine":"claude","sdkVersion":"1","cliVersion":"1"},"releasedAt":"2026-11-10T00:00:00Z"}]`,
    ],
    /images\.workers replaces images\.worker and images\.workerPrevious/,
  ],
  // Each one the readers' workerImageListFromEnv also refuses: the chart must
  // not render a list every process then fails to start on.
  ...(
    [
      ["not a list", { a: 1 }, /images\.workers must be a list/],
      [
        "an unknown field",
        [listedWorker({ tag: "x" })],
        /images\.workers\[0\] has unknown field\(s\): tag/,
      ],
      [
        "no runtime",
        [listedWorker({ runtime: undefined })],
        /images\.workers\[0\]\.runtime is required/,
      ],
      [
        "a bad runtime",
        [listedWorker({ runtime: { ...LISTED_RUNTIME, engine: "gemini" } })],
        /images\.workers\[0\]\.runtime\.engine must be one of/,
      ],
      [
        "a release time that is not a string",
        [listedWorker({ releasedAt: 20261110 })],
        /images\.workers\[0\]\.releasedAt must be/,
      ],
      [
        "a release time that is not a time",
        [listedWorker({ releasedAt: "oops" })],
        /images\.workers\[0\]\.releasedAt "oops" is not an RFC 3339 time/,
      ],
      [
        "a release time in a two-digit year",
        [listedWorker({ releasedAt: "0099-11-10T00:00:00Z" })],
        /is not an RFC 3339 time/,
      ],
      [
        "release times finer than a millisecond",
        [
          listedWorker({ releasedAt: "2026-11-10T00:00:00.0002Z" }),
          listedWorker({
            digest: `sha256:${"6".repeat(64)}`,
            releasedAt: "2026-11-10T00:00:00.0001Z",
          }),
        ],
        /images\.workers\[0\]\.releasedAt .* is not an RFC 3339 time/,
      ],
      [
        "a release time out of range",
        [listedWorker({ releasedAt: "2026-02-30T00:00:00Z" })],
        /is not an RFC 3339 time/,
      ],
      [
        "the older image first",
        [
          listedWorker({ releasedAt: "2026-10-01T00:00:00Z" }),
          listedWorker({ digest: `sha256:${"6".repeat(64)}` }),
        ],
        /images\.workers\[1\]\.releasedAt .* is not before the claude image above it/,
      ],
      [
        "one release time twice",
        [listedWorker(), listedWorker({ digest: `sha256:${"6".repeat(64)}` })],
        /images\.workers\[1\]\.releasedAt .* is not before/,
      ],
      [
        "one digest twice",
        [listedWorker(), listedWorker({ releasedAt: "2026-10-01T00:00:00Z" })],
        /images\.workers\[1\]\.digest .* is listed twice/,
      ],
      [
        "an engine's older image first, past another engine's",
        [
          listedWorker({
            releasedAt: "2026-10-01T00:00:00Z",
            runtime: { ...LISTED_RUNTIME, engine: "codex" },
          }),
          listedWorker({ digest: `sha256:${"6".repeat(64)}` }),
          listedWorker({
            digest: `sha256:${"7".repeat(64)}`,
            releasedAt: "2026-11-12T00:00:00Z",
            runtime: { ...LISTED_RUNTIME, engine: "codex" },
          }),
        ],
        /images\.workers\[2\]\.releasedAt .* is not before the codex image above it/,
      ],
      [
        "three images of one engine beside another's",
        [
          listedWorker(),
          ...["6", "7", "8"].map((digit, index) =>
            listedWorker({
              digest: `sha256:${digit.repeat(64)}`,
              releasedAt: `2026-11-0${3 - index}T00:00:00Z`,
              runtime: { ...LISTED_RUNTIME, engine: "codex" },
            }),
          ),
        ],
        /images\.workers lists 3 unretracted codex images: at most 2 per engine/,
      ],
      [
        "three images",
        ["5", "6", "7"].map((digit, index) =>
          listedWorker({
            digest: `sha256:${digit.repeat(64)}`,
            releasedAt: `2026-1${2 - index}-01T00:00:00Z`,
          }),
        ),
        /images\.workers lists 3 unretracted claude images: at most 2/,
      ],
      [
        "three unretracted beside a retracted one",
        ["5", "6", "7", "8"].map((digit, index) =>
          listedWorker({
            digest: `sha256:${digit.repeat(64)}`,
            releasedAt: `2026-0${9 - index}-01T00:00:00Z`,
            ...(index === 3 ? { retracted: true } : {}),
          }),
        ),
        /images\.workers lists 3 unretracted claude images: at most 2/,
      ],
      [
        "retracted as text",
        [listedWorker({ retracted: "true" })],
        /images\.workers\[0\]\.retracted must be true or false/,
      ],
      [
        "a repository no reference allows",
        [listedWorker({ repository: "bad repo" })],
        /images\.workers\[0\]\.repository: "bad repo@sha256:.*" is not an image reference/,
      ],
      [
        "no digest",
        [listedWorker({ digest: undefined })],
        /images\.workers\[0\]\.digest must be sha256/,
      ],
    ] as const
  ).map(([what, workers, error]): [string, string[], RegExp] => [
    `images.workers with ${what}`,
    ["-f", ciDigests, ...listInstead(workers)],
    error,
  ]),
];

const awsRender = (...args: string[]) =>
  render(["-f", ciDigests, "-f", awsExample, ...args]);
const consoleRender = () => awsRender("--set", "ingress.console.enabled=true");
const slackOff = render(["-f", ciDigests, "--set", "slack.enabled=false"]);
const errors = [
  ...check("default", render(["-f", ciDigests]), true),
  ...check("slack off", slackOff, true),
  ...check(
    "scheduler off",
    render(["-f", ciDigests, "--set", "scheduler.enabled=false"]),
    false,
  ),
  ...check("aws example", render(["-f", ciDigests, "-f", awsExample]), true),
  ...check(
    "aws example, scheduler off",
    render([
      "-f",
      ciDigests,
      "-f",
      awsExample,
      "--set",
      "scheduler.enabled=false",
    ]),
    false,
  ),
];
for (const declaration of [undefined, false, true]) {
  const manifests = render([
    "-f",
    ciDigests,
    ...(declaration === undefined
      ? []
      : ["--set", `worker.workspace.enforcedByStorage=${declaration}`]),
  ]);
  const scheduler = manifests.find(
    (m) =>
      m.kind === "Deployment" &&
      m.metadata.labels?.["app.kubernetes.io/component"] === "scheduler",
  );
  const env: { name: string; value?: string }[] =
    scheduler === undefined ? [] : podSpecOf(scheduler).containers[0].env;
  if (
    env.find(
      (entry) => entry.name === "EXECUTION_WORKSPACE_ENFORCED_BY_STORAGE",
    )?.value !== String(declaration ?? false)
  ) {
    errors.push(
      `workspace storage declaration ${declaration}: scheduler env did not preserve the boolean`,
    );
  }
}
errors.push(
  ...checkUpgradeHook("default", render(["-f", ciDigests]), true, []),
  ...checkUpgradeHook(
    "approved sessions",
    render([
      "-f",
      ciDigests,
      "--set-json",
      'upgrade.approvedSessions=["s-1","s-2"]',
    ]),
    true,
    ["s-1", "s-2"],
  ),
  ...checkUpgradeHook(
    "scheduler off",
    render(["-f", ciDigests, "--set", "scheduler.enabled=false"]),
    false,
    [],
  ),
  ...checkObjectStoreKeys("default", render(["-f", ciDigests]), true),
  ...checkObjectStoreKeys(
    "aws example",
    render(["-f", ciDigests, "-f", awsExample]),
    false,
  ),
  ...checkSecretKey("default", render(["-f", ciDigests]), true),
  ...checkSecretKey(
    "aws example",
    render(["-f", ciDigests, "-f", awsExample]),
    true,
  ),
  ...checkSecretKey("slack off", slackOff, false),
  ...checkSlack("default", render(["-f", ciDigests]), true),
  ...checkSlack(
    "aws example",
    render(["-f", ciDigests, "-f", awsExample]),
    true,
  ),
  ...checkSlack("slack off", slackOff, false),
  ...checkIngress("default", render(["-f", ciDigests]), false),
  ...checkIngress(
    "default, ingress on",
    render([
      "-f",
      ciDigests,
      "--set",
      "ingress.enabled=true",
      "--set",
      "ingress.hosts[0].host=agent-platform.example.com",
    ]),
    true,
    false,
  ),
  ...checkIngress("aws example", awsRender(), true, false),
  ...checkIngress("aws example, console on", consoleRender(), true, true),
);
// The chart cannot render these, so break a good render by hand.
const CONSOLE_BREAKS: [string, (ingress: Manifest) => void, string][] = [
  [
    "no /internal rule",
    (ingress) => ingress.spec.rules[0].http.paths.shift(),
    "/ routes /internal",
  ],
  [
    "/ ahead of /internal",
    ({ spec }) =>
      spec.rules[0].http.paths.unshift(spec.rules[0].http.paths.pop()),
    "/ routes /internal",
  ],
  [
    "no fixed-response action",
    ({ metadata }) => {
      for (const key of Object.keys(metadata.annotations ?? {})) {
        if (key.startsWith(ALB_ACTION)) delete metadata.annotations?.[key];
      }
    },
    "/internal routes /internal",
  ],
  [
    "a fixed-response the ALB refuses",
    ({ metadata }) => {
      for (const key of Object.keys(metadata.annotations ?? {})) {
        if (key.startsWith(ALB_ACTION) && metadata.annotations) {
          metadata.annotations[key] = metadata.annotations[key].replace(
            "text/plain",
            "invalid",
          );
        }
      }
    },
    "/internal routes /internal",
  ],
  [
    "a fixed-response with a body over the ALB's limit",
    ({ metadata }) => {
      if (metadata.annotations) {
        metadata.annotations[`${ALB_ACTION}block-internal`] = JSON.stringify({
          ...BLOCK_ACTION,
          fixedResponseConfig: {
            ...BLOCK_ACTION.fixedResponseConfig,
            messageBody: "x".repeat(1025),
          },
        });
      }
    },
    "/internal routes /internal",
  ],
  [
    "another controller",
    ({ spec }) => {
      spec.ingressClassName = "nginx";
    },
    "the console needs ingressClassName alb",
  ],
  ...[
    "alb.ingress.kubernetes.io/conditions.block-internal",
    "alb.ingress.kubernetes.io/conditions.ap-werft-api",
    "alb.ingress.kubernetes.io/transforms.ap-werft-api",
    "alb.ingress.kubernetes.io/group.order",
    "kubernetes.io/ingress.class",
  ].map((key): [string, (ingress: Manifest) => void, string] => [
    key,
    ({ metadata }) => {
      metadata.annotations = { ...metadata.annotations, [key]: "x" };
    },
    `${key} can route /internal past the 404`,
  ]),
  [
    "/ on another Service",
    ({ spec }) => {
      spec.rules[0].http.paths.at(-1).backend.service.name = "elsewhere";
    },
    "/ does not route to Service/ap-werft-api port http",
  ],
];
for (const [name, breakIngress, expected] of CONSOLE_BREAKS) {
  const manifests = consoleRender();
  manifests.filter((m) => m.kind === "Ingress").forEach(breakIngress);
  if (!checkIngress(name, manifests, true).some((e) => e.endsWith(expected))) {
    errors.push(`a console Ingress with ${name} was not refused`);
  }
}
const exposed = checkIngress(
  "aws example, internet-facing",
  render([
    "-f",
    ciDigests,
    "-f",
    awsExample,
    "--set-string",
    "ingress.annotations.alb\\.ingress\\.kubernetes\\.io/scheme=internet-facing",
  ]),
  true,
);
if (!exposed.some((error) => error.includes("internet-facing;"))) {
  errors.push("an internet-facing ALB scheme was not refused");
}
errors.push(
  ...checkPreview("default", render(["-f", ciDigests]), false),
  ...checkPreview(
    "aws example",
    render(["-f", ciDigests, "-f", awsExample]),
    false,
  ),
  ...checkPreview(
    "preview",
    render(["-f", ciDigests, "--set", "preview.enabled=true"]),
    true,
  ),
  // A YAML-quoted key must stay that literal name, never PREVIEW_NAMESPACE.
  ...checkPreview(
    "quoted extraEnv key",
    render([
      "-f",
      ciDigests,
      "--set-json",
      'api.extraEnv={"\\"PREVIEW_NAMESPACE\\"":"prod"}',
      "--set-json",
      'config.limits={"\\"PREVIEW_NAMESPACE\\"":"prod"}',
    ]),
    false,
  ),
);
const awsPreview = checkPreview(
  "aws example, preview on",
  render(["-f", ciDigests, "-f", awsExample, "--set", "preview.enabled=true"]),
  false,
);
if (!awsPreview.some((error) => error.includes("preview.enabled is off"))) {
  errors.push("the aws example with preview.enabled on was not refused");
}
const metricsOn = render(["-f", ciDigests, "--set", "metrics.enabled=true"]);
const metricsOnNoPolicy = render([
  "-f",
  ciDigests,
  "--set",
  "metrics.enabled=true",
  "--set",
  "networkPolicy.enabled=false",
]);
const metricsOnAws = render([
  "-f",
  ciDigests,
  "-f",
  awsExample,
  "--set",
  "metrics.enabled=true",
]);
errors.push(
  ...check("metrics on", metricsOn, true),
  ...check("aws example, metrics on", metricsOnAws, true),
  ...checkObjectStoreKeys("metrics on", metricsOn, true),
  ...checkSecretKey("metrics on", metricsOn, true),
  ...checkMetrics("default", render(["-f", ciDigests]), false, true),
  ...checkMetrics("metrics on", metricsOn, true, true),
  ...checkMetrics(
    "metrics on, no network policy",
    metricsOnNoPolicy,
    true,
    false,
  ),
  ...checkMetrics("aws example, metrics on", metricsOnAws, true, true),
);
const CURRENT_RUNTIME = {
  engine: "claude",
  sdkVersion: "0.3.280",
  cliVersion: "2.1.280",
  profileDigestScheme: 1,
};
const PREVIOUS_RUNTIME = {
  ...CURRENT_RUNTIME,
  sdkVersion: "0.3.270",
  cliVersion: "2.1.270",
};
const CODEX_RUNTIME = {
  engine: "codex",
  sdkVersion: "0.167.0",
  cliVersion: "0.167.0",
  profileDigestScheme: 1,
};
const PACKAGED_AT = "2026-11-12T00:00:00Z";
const PREVIOUS_DIGEST = `sha256:${"4".repeat(64)}`;
const workerImages = [
  "--set-json",
  `images.worker.runtime=${JSON.stringify(CURRENT_RUNTIME)}`,
  "--set-json",
  `images.workerPrevious.runtime=${JSON.stringify(PREVIOUS_RUNTIME)}`,
  "--set",
  `images.workerPrevious.digest=${PREVIOUS_DIGEST}`,
];
// helm's toJson sorts keys; the processes parse the value, so order is free.
const asRendered = (runtime: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(runtime).sort()));
errors.push(
  ...checkWorkerImages("default", render(["-f", ciDigests]), {}),
  ...checkWorkerImages(
    "current runtime only",
    render([
      "-f",
      ciDigests,
      "--set-json",
      `images.worker.runtime=${JSON.stringify(CURRENT_RUNTIME)}`,
    ]),
    { runtime: asRendered(CURRENT_RUNTIME) },
  ),
  ...checkWorkerImages(
    "two images",
    render(["-f", ciDigests, ...workerImages]),
    {
      runtime: asRendered(CURRENT_RUNTIME),
      previousRuntime: asRendered(PREVIOUS_RUNTIME),
      previousImage: `ghcr.io/jeongjaesoon/werft-worker@${PREVIOUS_DIGEST}`,
    },
  ),
  ...checkUpgradeHook(
    "two images",
    render(["-f", ciDigests, ...workerImages]),
    true,
    [],
  ),
);

const WORKER_REPOSITORY = "ghcr.io/jeongjaesoon/werft-worker";
const CURRENT_DIGEST = `sha256:${"5".repeat(64)}`;
const workerList = [
  {
    repository: WORKER_REPOSITORY,
    digest: CURRENT_DIGEST,
    runtime: CURRENT_RUNTIME,
    releasedAt: "2026-11-10T00:00:00Z",
  },
  {
    repository: WORKER_REPOSITORY,
    digest: PREVIOUS_DIGEST,
    runtime: { ...PREVIOUS_RUNTIME, restorableSchemes: [1] },
    releasedAt: "2026-10-01T00:00:00Z",
  },
];
const sortedDeep = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortedDeep)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([k, v]) => [k, sortedDeep(v)]),
        )
      : value;
const renderedList = {
  list: JSON.stringify(
    sortedDeep(
      workerList.map((w) => ({
        image: `${w.repository}@${w.digest}`,
        runtime: w.runtime,
        released_at: w.releasedAt,
      })),
    ),
  ),
};
const listManifests = render(["-f", ciDigests, ...listInstead(workerList)]);
errors.push(
  ...checkWorkerImages("image list", listManifests, renderedList),
  ...checkUpgradeHook("image list", listManifests, true, []),
);
// A retracted image stays listed beside the two that launch, marked so; one
// not retracted renders no flag, as the readers default it.
const retractedEntry = {
  repository: WORKER_REPOSITORY,
  digest: `sha256:${"7".repeat(64)}`,
  runtime: PREVIOUS_RUNTIME,
  releasedAt: "2026-09-01T00:00:00Z",
};
errors.push(
  ...checkWorkerImages(
    "image list with a retracted image",
    render([
      "-f",
      ciDigests,
      ...listInstead([...workerList, { ...retractedEntry, retracted: true }]),
    ]),
    {
      list: JSON.stringify(
        sortedDeep([
          ...JSON.parse(renderedList.list),
          {
            image: `${retractedEntry.repository}@${retractedEntry.digest}`,
            released_at: retractedEntry.releasedAt,
            retracted: true,
            runtime: retractedEntry.runtime,
          },
        ]),
      ),
    },
  ),
  // Two engines, two images each, ordered within each engine only: the
  // codex image may share the claude one's release time.
  ...(() => {
    const codexEntries = [
      {
        repository: WORKER_REPOSITORY,
        digest: `sha256:${"8".repeat(64)}`,
        runtime: { ...CURRENT_RUNTIME, engine: "codex" },
        releasedAt: "2026-11-10T00:00:00Z",
      },
      {
        repository: WORKER_REPOSITORY,
        digest: `sha256:${"9".repeat(64)}`,
        runtime: { ...PREVIOUS_RUNTIME, engine: "codex" },
        releasedAt: "2026-11-01T00:00:00Z",
      },
    ];
    const [claudeNew, claudeOld] = workerList;
    const mixed = [codexEntries[0], claudeNew, codexEntries[1], claudeOld];
    const manifests = render(["-f", ciDigests, ...listInstead(mixed)]);
    return [
      ...checkWorkerImages("image list of two engines", manifests, {
        list: JSON.stringify(
          sortedDeep(
            mixed.map((w) => ({
              image: `${w?.repository}@${w?.digest}`,
              runtime: w?.runtime,
              released_at: w?.releasedAt,
            })),
          ),
        ),
      }),
      ...checkUpgradeHook("image list of two engines", manifests, true, []),
    ];
  })(),
  ...checkWorkerImages(
    "image list with retracted: false",
    render([
      "-f",
      ciDigests,
      ...listInstead(
        workerList.map((worker) => ({ ...worker, retracted: false })),
      ),
    ]),
    renderedList,
  ),
);

// What a publishing run makes: a package that renders with no values at all,
// holding every promise above. Only the main and tag runs package for real, so
// this is the pull request's one look at helm's side of it.
const packaged = (() => {
  const defaults = Bun.YAML.parse(
    readFileSync(join(chart, "values.yaml"), "utf8"),
  ) as {
    images: Record<
      "controlHost" | "egressProxy" | "worker" | "workerCodex",
      ImageDefault
    >;
  };
  const digests = Bun.YAML.parse(readFileSync(ciDigests, "utf8")) as {
    images: Record<
      "controlHost" | "egressProxy" | "worker" | "workerCodex",
      ImageDefault
    >;
  };
  const image = (
    key: "controlHost" | "egressProxy" | "worker" | "workerCodex",
  ) => ({
    repository: defaults.images[key].repository,
    digest: digests.images[key].digest,
  });
  const out = join(mkdtempSync(join(tmpdir(), "render-check-")), "chart");
  const { chart: tgz } = packageChart({
    chartDir: chart,
    outDir: out,
    version: "0.0.0-main-0123456789ab",
    appVersion: "main-0123456789ab",
    images: {
      controlHost: image("controlHost"),
      egressProxy: image("egressProxy"),
      worker: {
        ...image("worker"),
        runtime: CURRENT_RUNTIME,
        releasedAt: PACKAGED_AT,
      },
      workerCodex: {
        ...image("workerCodex"),
        runtime: CODEX_RUNTIME,
        releasedAt: PACKAGED_AT,
      },
    },
  });
  return tgz;
})();
const packagedFile = (file: string) => {
  const result = spawnSync("tar", ["-xzOf", packaged, `werft/${file}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`the package has no ${file}: ${result.stderr}`);
  }
  return result.stdout;
};
/**
 * files/next-workers.jq of the package, run as the upgrade docs run it, on
 * the package's own files/release-images.json; the values file it writes.
 */
const nextWorkers = (
  phase: "control" | "final",
  deployed: unknown,
  known: Record<string, unknown> = {},
  release = packagedFile("files/release-images.json"),
): { ok: true; file: string } | { ok: false; out: string } => {
  const tmp = mkdtempSync(join(tmpdir(), "render-check-next-"));
  const program = join(tmp, "next-workers.jq");
  writeFileSync(program, packagedFile("files/next-workers.jq"));
  writeFileSync(join(tmp, "deployed.json"), JSON.stringify(deployed));
  writeFileSync(join(tmp, "release.json"), release);
  const result = spawnSync(
    "jq",
    [
      "-n",
      "-f",
      program,
      "--arg",
      "phase",
      phase,
      "--slurpfile",
      "deployed",
      join(tmp, "deployed.json"),
      "--slurpfile",
      "release",
      join(tmp, "release.json"),
      "--argjson",
      "known",
      JSON.stringify(known),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return { ok: false, out: result.stderr };
  const file = join(tmp, `${phase}.json`);
  writeFileSync(file, result.stdout);
  return { ok: true, file };
};
const packagedManifests = render([], packaged);
errors.push(
  ...check("package", packagedManifests, true),
  ...checkWorkerImages("package", packagedManifests, {
    runtime: asRendered(CURRENT_RUNTIME),
  }),
  ...checkUpgradeHook("package", packagedManifests, true, []),
  // The switch the docs give an operator of the packaged chart.
  ...checkWorkerImages(
    "package, image list",
    render(listInstead(workerList), packaged),
    renderedList,
  ),
);

// The upgrade docs' list procedure on the package: single image -> list ->
// next list, each values file from the package's own next-workers.jq.
{
  type Entry = {
    repository: string;
    digest: string;
    runtime: Record<string, unknown>;
    releasedAt: string;
  };
  const released = JSON.parse(
    packagedFile("files/release-images.json"),
  ) as Entry[];
  const asList = (entries: Entry[]) => ({
    list: JSON.stringify(
      sortedDeep(
        entries.map((e) => ({
          image: `${e.repository}@${e.digest}`,
          runtime: e.runtime,
          released_at: e.releasedAt,
        })),
      ),
    ),
  });
  const [claude, codex] = released as [Entry, Entry];
  const deployedImage: Entry = {
    repository: WORKER_REPOSITORY,
    digest: `sha256:${"7".repeat(64)}`,
    runtime: PREVIOUS_RUNTIME,
    releasedAt: "2026-10-01T00:00:00Z",
  };
  const egressProxy = {
    repository: "ghcr.io/jeongjaesoon/werft-egress-proxy",
    digest: `sha256:${"8".repeat(64)}`,
  };
  const single = {
    images: {
      worker: {
        repository: WORKER_REPOSITORY,
        digest: deployedImage.digest,
        runtime: {},
        releasedAt: PACKAGED_AT,
      },
      workerPrevious: {
        repository: WORKER_REPOSITORY,
        digest: "",
        runtime: {},
      },
      workers: [],
      egressProxy,
    },
  };
  const first = nextWorkers("final", single, {
    [deployedImage.digest]: {
      runtime: deployedImage.runtime,
      releasedAt: deployedImage.releasedAt,
    },
  });
  const listed = [claude, deployedImage, codex];
  const next: Entry = {
    ...claude,
    digest: `sha256:${"9".repeat(64)}`,
    releasedAt: "2026-11-20T00:00:00Z",
  };
  if (!first.ok) {
    errors.push(`next-workers, single image to list: ${first.out}`);
  } else {
    errors.push(
      ...checkWorkerImages(
        "next-workers, single image to list",
        render(["-f", first.file], packaged),
        asList(listed),
      ),
    );
    const deployedList = {
      images: {
        ...(
          JSON.parse(readFileSync(first.file, "utf8")) as {
            images: Record<string, unknown>;
          }
        ).images,
        egressProxy,
      },
    };
    const control = nextWorkers("control", deployedList);
    errors.push(
      ...(control.ok
        ? checkWorkerImages(
            "next-workers, control phase keeps the list",
            render(["-f", control.file], packaged),
            asList(listed),
          )
        : [`next-workers, control phase: ${control.out}`]),
    );
    const second = nextWorkers(
      "final",
      deployedList,
      {},
      JSON.stringify([next, codex]),
    );
    errors.push(
      ...(second.ok
        ? checkWorkerImages(
            "next-workers, list to next list",
            render(["-f", second.file], packaged),
            asList([next, claude, codex]),
          )
        : [`next-workers, list to next list: ${second.out}`]),
    );
    const older = nextWorkers(
      "final",
      deployedList,
      {},
      JSON.stringify([{ ...next, releasedAt: "2026-09-01T00:00:00Z" }, codex]),
    );
    if (
      older.ok ||
      !/is not newer than every deployed claude image/.test(older.out)
    ) {
      errors.push(
        `next-workers: a release older than the deployed image must be refused, got ${older.ok ? "a list" : older.out}`,
      );
    }
  }
}
for (const [label, args, message] of MUST_FAIL) {
  const { ok, out } = helmTemplate(args);
  if (ok || !message.test(out)) {
    errors.push(`${label}: expected the render to fail with ${message}`);
  }
}

// A deployment that runs the Codex worker image names its engine and the
// chart carries it to api, slack and the scheduler like Claude's.
{
  const codex = helmTemplate([
    "-f",
    ciDigests,
    "--set-json",
    'images.worker.runtime={"engine":"codex","sdkVersion":"0.167.0","cliVersion":"0.167.0","profileDigestScheme":1}',
  ]);
  if (!codex.ok || !codex.out.includes(String.raw`\"engine\":\"codex\"`)) {
    errors.push(
      `a Codex worker runtime: expected a render carrying engine codex, got ${codex.ok ? "no such value" : codex.out.slice(0, 200)}`,
    );
  }
}

// The chart takes a runtime value exactly when the readers do: one it lets
// through and they refuse stops api, slack and the scheduler at startup. The
// engine name is the one rule the chart keeps beyond them (see MUST_FAIL), so
// these values all name the supported engine.
const RUNTIME_EDGES = [
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c"}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":3}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":1e21}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profiles":{}}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":"1"}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":0}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":1.5}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":2,"restorableSchemes":[1,2]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","restorableSchemes":[1]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","profileDigestScheme":2,"restorableSchemes":[1]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","restorableSchemes":[]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","restorableSchemes":[0,1]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","restorableSchemes":[1.5,1]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","restorableSchemes":["1"]}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","restorableSchemes":1}',
  '{"engine":"","sdkVersion":"s","cliVersion":"c"}',
  '{"engine":"claude","sdkVersion":"s"}',
  '{"engine":"claude","sdkVersion":"s","cliVersion":"c","typo":1}',
];
for (const runtime of RUNTIME_EDGES) {
  let readers = true;
  try {
    parseImageRuntime(runtime);
  } catch {
    readers = false;
  }
  const chart = helmTemplate([
    "-f",
    ciDigests,
    "--set-json",
    `images.worker.runtime=${runtime}`,
  ]).ok;
  if (chart !== readers) {
    errors.push(
      `images.worker.runtime=${runtime}: the chart ${chart ? "takes" : "refuses"} it, the readers ${readers ? "take" : "refuse"} it`,
    );
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `render-check: default and aws example renders pass, a package renders with its own values, scheduler off and on, workspace storage declaration unset/false/true, slack off, preview on, metrics on, worker images (one, current runtime, two, a list) alike on api, slack and scheduler, the upgrade check ahead of migrate; ${MUST_FAIL.length} bad inputs, an internet-facing ALB, ${CONSOLE_BREAKS.length} broken console Ingresses and a preview aws example refused; the console Ingress on and off`,
);
