import { tmpdir } from "node:os";
import {
  assertGitEnvironment,
  assertUserEnvironment,
} from "@werft-ai/runtime-core";
import { z } from "zod";

import { describeComponents } from "./component-identity.ts";
import type { ClaudeRuntimeConfig, RuntimeProfile } from "./config.ts";

const principalSchema = z.object({ ownerScope: z.string().min(1) }).strict();
const egressTokenSchema = z
  .object({
    kind: z.literal("egress_token"),
    token: z.string().min(1),
    transport: z
      .string()
      .url()
      .refine((value) => /^https?:$/.test(new URL(value).protocol), {
        message: "transport must be http or https",
      }),
  })
  .strict();
const profileSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: z.string().url(),
      auth: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("api_key"), value: z.string().min(1) })
          .strict(),
        egressTokenSchema,
      ]),
      principal: principalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: z.string().url(),
      principal: principalSchema,
      auth: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("api_key"), value: z.string().min(1) })
          .strict(),
        z
          .object({ kind: z.literal("bearer"), value: z.string().min(1) })
          .strict(),
        egressTokenSchema,
      ]),
    })
    .strict(),
]);

export type RuntimePolicy = {
  endpoints: string[];
  models: string[];
};

export function validateRuntimeConfig(
  config: ClaudeRuntimeConfig,
  policy: RuntimePolicy,
): ClaudeRuntimeConfig {
  const profile = profileSchema.parse(config.profile);
  const endpoint = normalizeEndpoint(profile.endpoint);
  const approvedEndpoints = new Set(policy.endpoints.map(normalizeEndpoint));
  if (!approvedEndpoints.has(endpoint)) {
    throw new Error("Runtime endpoint is not approved");
  }
  if (!policy.models.includes(config.model)) {
    throw new Error("Runtime model is not approved");
  }
  // A component the fingerprint cannot name makes every checkpoint of this
  // run unverifiable, and a resume unmatchable. Refusing here, for new and
  // resumed runs alike, is what turns that into a start-time error with a
  // reason instead of a checkpoint that quietly never commits.
  describeComponents(config);
  if (
    config.repositoryClaudeMd !== undefined &&
    (config.settingSources ?? ["project"]).length > 0
  ) {
    throw new Error(
      "repositoryClaudeMd lets CLAUDE.md in without the project settings; it needs settingSources: []",
    );
  }
  if (
    config.mode === "resume" &&
    config.localTranscriptResume !== true &&
    config.sessionStore?.revisionScoped !== true
  ) {
    // Two ways to get this wrong, and they look identical from here: handing
    // over the live mirror, which holds whatever was written after the
    // checkpoint being resumed, or handing over nothing at all, which leaves
    // the engine replaying the container's local disk. Either is a different
    // conversation than the one that was committed. A store bound to a
    // restore plan declares `revisionScoped`; a genuinely local
    // resume has to say so out loud.
    throw new Error("Resume needs a revision-scoped transcript mirror");
  }
  if (config.permissionMode === undefined) return config;
  if (config.permissionMode === "default") return config;
  if (
    ["acceptEdits", "dontAsk", "plan", "bypassPermissions", "auto"].includes(
      config.permissionMode,
    )
  ) {
    return config;
  }
  throw new Error("Unsupported permission mode");
}

/**
 * The only host variables the engine inherits verbatim. On the worker
 * network the egress proxy is the sole route to the Messages endpoint and
 * the container learns it through these; the SDK replaces the
 * child's environment rather than merging it, so they have to be carried
 * across by hand. Each is forwarded only when the host sets it: an uppercase
 * twin the host never had would change which value the engine prefers.
 *
 * Deliberately not here: `NODE_EXTRA_CA_CERTS`. A CA bundle changes who may
 * impersonate the Messages endpoint, so it comes from `trustedCaBundle` on
 * the config, never from whatever the host happens to trust.
 */
const HOST_PROXY_VARIABLES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

/**
 * The descriptor the engine reads its API key from. The engine
 * reads it once, closes it and drops the variable before any tool runs, and
 * a socket, unlike a pipe or a file, cannot be reopened through the
 * engine's fd directory under /proc by a process it was never handed to.
 */
export const ENGINE_API_KEY_DESCRIPTOR = 3;

/** The key `runtimeEnvironment` leaves out, for the spawn to write down the descriptor. */
export function engineApiKey(profile: RuntimeProfile): string | undefined {
  const auth = profile.auth;
  if (auth.kind === "bearer") return undefined;
  return auth.kind === "egress_token" ? auth.token : auth.value;
}

export function runtimeEnvironment(
  config: Pick<
    ClaudeRuntimeConfig,
    | "claudeConfigDir"
    | "gitEnvironment"
    | "home"
    | "profile"
    | "providerMaxRetries"
    | "trustedCaBundle"
    | "userEnvironment"
  >,
  host: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {
    // First, so every key below overwrites a user name that got past the
    // reserved list. The conditional keys (proxy, CA, retries) are on that
    // list too: they are absent when their config is, and nothing below
    // would overwrite a user value for them then.
    ...(config.userEnvironment === undefined
      ? {}
      : assertUserEnvironment(config.userEnvironment)),
    ANTHROPIC_BASE_URL: normalizeEndpoint(config.profile.endpoint),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    HOME: config.home,
    LANG: host.LANG ?? "en_US.UTF-8",
    PATH: host.PATH,
    TMPDIR: host.TMPDIR ?? tmpdir(),
  };
  for (const name of HOST_PROXY_VARIABLES) {
    const value = host[name];
    if (value !== undefined) environment[name] = value;
  }
  if (config.gitEnvironment !== undefined) {
    Object.assign(environment, assertGitEnvironment(config.gitEnvironment));
  }
  if (config.providerMaxRetries !== undefined) {
    environment.CLAUDE_CODE_MAX_RETRIES = String(config.providerMaxRetries);
  }
  if (config.trustedCaBundle !== undefined) {
    environment.NODE_EXTRA_CA_CERTS = config.trustedCaBundle;
  }
  const auth = config.profile.auth;
  if (auth.kind === "bearer") {
    environment.ANTHROPIC_AUTH_TOKEN = auth.value;
  } else {
    // What the engine's environment holds, every tool it runs inherits and
    // anything else of the same uid reads in its environ under /proc, so
    // the key comes down a socket instead (engineApiKey).
    environment.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR = String(
      ENGINE_API_KEY_DESCRIPTOR,
    );
  }
  if (auth.kind === "egress_token") {
    // The engine talks to the egress proxy's credential route, which puts the
    // real credential on the request; the token is all it holds.
    // The route is plain HTTP on the worker network, so it must not be sent
    // through the forward proxy, which would refuse it anyway.
    environment.ANTHROPIC_BASE_URL = normalizeEndpoint(auth.transport);
    bypassProxyFor(environment, new URL(auth.transport).hostname, host);
  }
  return environment;
}

/**
 * Adds `hostname` to whichever of `NO_PROXY`/`no_proxy` the host sets, or to
 * both when it sets neither, so no twin ever disagrees with the other.
 */
function bypassProxyFor(
  environment: Record<string, string | undefined>,
  hostname: string,
  host: NodeJS.ProcessEnv,
): void {
  const names = (["NO_PROXY", "no_proxy"] as const).filter(
    (name) => host[name] !== undefined,
  );
  for (const name of names.length === 0 ? ["NO_PROXY", "no_proxy"] : names) {
    const current = host[name] ?? "";
    environment[name] = current === "" ? hostname : `${current},${hostname}`;
  }
}

/**
 * The profile with the credential left behind and the principal kept: what
 * may be hashed, logged or compared without leaking a secret. An egress
 * token's transport is left behind too: where the proxy listens is plumbing,
 * and moving it must not orphan every checkpoint.
 */
export function publicProfile(profile: RuntimeProfile): {
  auth_kind: RuntimeProfile["auth"]["kind"];
  endpoint: string;
  kind: RuntimeProfile["kind"];
  principal: { ownerScope: string };
} {
  return {
    kind: profile.kind,
    endpoint: normalizeEndpoint(profile.endpoint),
    auth_kind: profile.auth.kind,
    principal: { ownerScope: profile.principal.ownerScope },
  };
}

function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}
