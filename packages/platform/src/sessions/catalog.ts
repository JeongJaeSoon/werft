import { createHash, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import {
  type ActionClass,
  type AgentGitHubSettingsRow,
  type AgentRelease,
  canonicalJson,
  credentialRefSchema,
  GITHUB_MCP_SERVER,
  GITHUB_MCP_TOOL_CLASSES,
  type GitHubAppRepositories,
  listedGitHubMcpTools,
  MCP_TOOL_PREFIX,
  mcpServerIdSchema,
  newSessionGitHubPolicy,
  type ProviderKind,
  type RepositoryCeiling,
  RUNTIME_KIND_OF_PROVIDER,
  type RuntimeConfig,
  type RuntimeKind,
  type runtimeConfigSchema,
  startRepositoryOf,
} from "@werft-ai/contracts";
import { z } from "zod";
import { type GitCredential, repoRefOf } from "../action/ports/forge.ts";
import type { ToolCatalogs } from "./tool-names.ts";

// An entry never holds a credential value outside `secret_values`: it names a
// stored value, an environment variable or a Secrets Manager secret.
//
// A connection's kind decides the runtime a release on it runs
// (`runtimeKindOfProvider`); a kind no installed runtime serves is refused
// when the release is made.

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The settings rows a console-stored value belongs to
 * (settings-replace-file-catalog.md §2). A `stored` reference names its own
 * row, `<kind>:<id>`, so two rows alike in every other field still differ.
 */
export const STORED_OWNER_KINDS = ["connection", "repository", "mcp"] as const;
export type StoredOwnerKind = (typeof STORED_OWNER_KINDS)[number];
const storedRefPattern = new RegExp(`^(${STORED_OWNER_KINDS.join("|")}):\\S+$`);

const credentialRefFields = {
  value_env: z.string().min(1).optional(),
  secret_id: z.string().min(1).optional(),
  stored: z
    .string()
    .regex(
      storedRefPattern,
      "must be connection:, repository: or mcp: and an id",
    )
    .optional(),
};
function namesOneRef(auth: {
  value_env?: string | undefined;
  secret_id?: string | undefined;
  stored?: string | undefined;
}): boolean {
  return (
    [auth.value_env, auth.secret_id, auth.stored].filter(
      (field) => field !== undefined,
    ).length === 1
  );
}
const ONE_REF_MESSAGE = "name exactly one of value_env, secret_id or stored";
function credentialRef<K extends z.ZodType<string>>(kind: K) {
  return z
    .object({ kind, ...credentialRefFields })
    .strict()
    .refine(namesOneRef, { message: ONE_REF_MESSAGE });
}

// A credential in a URL would ride every fingerprint, snapshot and claim
// that repeats the URL; it has to come through a reference instead.
function carriesCredential(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // scp-style `git@host:path`: the part before `@` is a login name, and a
    // password cannot be spelled in that form.
    return false;
  }
  if (url.password !== "") return true;
  const web = url.protocol === "http:" || url.protocol === "https:";
  return web && (url.username !== "" || url.search !== "");
}
const credentialFreeUrl = z
  .string()
  .min(1)
  .refine((value) => !carriesCredential(value), {
    message: "must not carry a credential (userinfo or query string)",
  });

// A worker's only way out is the HTTP(S) egress proxy, so an ssh
// git or file remote, or a non-web endpoint, would pass here and fail only
// after a session took a slot. Other transports need a route first.
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
// The egress proxy refuses an upstream with a fragment, so one
// here would pass startup and fail every call through the route.
const webUrl = credentialFreeUrl
  .refine(isWebUrl, { message: "must be an http:// or https:// URL" })
  .refine((value) => !isWebUrl(value) || new URL(value).hash === "", {
    message: "must not carry a fragment",
  })
  // The egress proxy checks an https upstream's certificate for a name, so
  // one addressed by IP would pass here and fail every call.
  .refine(
    (value) =>
      !isWebUrl(value) ||
      new URL(value).protocol !== "https:" ||
      isIP(new URL(value).hostname.replace(/^\[|\]$/g, "")) === 0,
    { message: "https must name its host, not an address" },
  );

// `none` is the operator's word that this endpoint does not bill per token
// (a model served on their own hardware): its usage is recorded at no cost
// and no dollar limit applies to its sessions. Absent means `per_token`.
const billingSchema = z.enum(["per_token", "none"]).optional();

export const catalogProviderSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("anthropic"),
      endpoint: webUrl,
      auth: credentialRef(z.literal("api_key")),
      billing: billingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("litellm"),
      endpoint: webUrl,
      auth: credentialRef(z.enum(["api_key", "bearer"])),
      billing: billingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("openai_responses"),
      endpoint: webUrl,
      auth: credentialRef(z.literal("api_key")),
      billing: billingSchema,
    })
    .strict(),
]);

export const catalogConnectionsSchema = z.record(
  z.string().min(1),
  catalogProviderSchema,
);

/**
 * A kind's official address, filled in when a settings entry leaves its
 * endpoint empty. Only at write: a row keeps a concrete URL, so changing a
 * value here moves no session and no stored key. A kind absent here (a
 * proxy the operator runs) has to name its own.
 */
export const CONNECTION_ENDPOINT_DEFAULTS: Readonly<
  Partial<Record<z.infer<typeof catalogProviderSchema>["kind"], string>>
> = {
  anthropic: "https://api.anthropic.com",
  openai_responses: "https://api.openai.com",
};

const PRIVATE_NAME_SUFFIXES = [
  ".internal",
  ".local",
  ".localhost",
  ".lan",
  ".home.arpa",
];

function privateIpv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Whether a host can only be reached inside the operator's network: a
 * private address, or a name public DNS does not serve (a compose service,
 * `*.internal`). Necessary for `billing: none`, not sufficient: a private
 * gateway may still front a paid API, which is the operator's to rule out.
 */
export function isPrivateEndpointHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  switch (isIP(host)) {
    case 4:
      return privateIpv4(host);
    // fc00::/7 and fe80::/10, written out to a full first group.
    case 6:
      return (
        host === "::1" || /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(host)
      );
  }
  const name = host.replace(/\.$/, "");
  return (
    !name.includes(".") ||
    PRIVATE_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

export const BILLING_NONE_ENDPOINT_MESSAGE =
  "billing none needs an endpoint on a private address or a name public DNS does not serve";

export function billingFitsEndpoint(provider: {
  billing?: unknown;
  endpoint: string;
}): boolean {
  return (
    provider.billing !== "none" ||
    !isWebUrl(provider.endpoint) ||
    isPrivateEndpointHost(new URL(provider.endpoint).hostname)
  );
}

export const modelFamiliesSchema = z
  .record(
    z.string().min(1),
    z.object({ family: z.string().min(1), rank: z.number().int() }).strict(),
  )
  .refine(
    (families) => {
      const seen = new Set<string>();
      for (const { family, rank } of Object.values(families)) {
        const key = `${family}\u0000${rank}`;
        if (seen.has(key)) return false;
        seen.add(key);
      }
      return true;
    },
    { message: "two models of one family cannot share a rank" },
  );
export type ModelFamilies = z.infer<typeof modelFamiliesSchema>;

// A GitHub App installation: the API signs a JWT with the App's private key
// (the referenced value, a PEM) and trades it for an installation token
// scoped to this one repository and the access a route needs. Written as
// just `{ kind: github_app }`, the repository uses the App registered in the
// console and the installation GitHub reports for it.
export const GITHUB_API_BASE = "https://api.github.com";
const githubAppAuthSchema = z
  .object({
    kind: z.literal("github_app"),
    app_id: z.number().int().positive().optional(),
    installation_id: z.number().int().positive().optional(),
    ...credentialRefFields,
    // GHES: `https://<host>/api/v3`. The JWT and the token cross it, so
    // plain http only to a host inside the operator's network.
    api_base: webUrl
      .refine(
        (value) =>
          !isWebUrl(value) ||
          new URL(value).protocol === "https:" ||
          isPrivateEndpointHost(new URL(value).hostname),
        { message: "must be https unless the host is private" },
      )
      .optional(),
  })
  .strict()
  .refine(
    (auth) =>
      isRegisteredGitHubApp(auth) ||
      (auth.app_id !== undefined &&
        auth.installation_id !== undefined &&
        // An explicit App's key is the deployment's, never the console's.
        auth.stored === undefined &&
        (auth.value_env === undefined) !== (auth.secret_id === undefined)),
    {
      message:
        "name app_id, installation_id and exactly one of value_env or secret_id, or none of them to use the App registered in the console",
    },
  );

/** `{ kind: github_app }` alone: the App registered in the console. */
export function isRegisteredGitHubApp(auth: {
  kind: string;
  app_id?: number | undefined;
  installation_id?: number | undefined;
  value_env?: string | undefined;
  secret_id?: string | undefined;
  stored?: string | undefined;
  api_base?: string | undefined;
}): boolean {
  return (
    auth.kind === "github_app" &&
    auth.app_id === undefined &&
    auth.installation_id === undefined &&
    auth.value_env === undefined &&
    auth.secret_id === undefined &&
    auth.stored === undefined &&
    auth.api_base === undefined
  );
}

// A repository the installation lists. Which sessions may reach it is the
// workspace ceiling's and the agent's GitHub settings' to say, checked at
// create and again at claim.
export const catalogRepositorySchema = z
  .object({
    url: webUrl,
    branch: z.string().min(1),
    auth: githubAppAuthSchema,
  })
  .strict()
  .refine(
    (repository) =>
      repository.auth?.kind !== "github_app" ||
      repoRefOf(repository.url) !== null,
    {
      message: "github_app needs a URL of the form <host>/<owner>/<name>",
      path: ["url"],
    },
  )
  // The console App's tokens come from github.com; on another host they
  // would be handed to a server they were never issued for.
  .refine(
    (repository) =>
      repository.auth === undefined ||
      !isRegisteredGitHubApp(repository.auth) ||
      !isWebUrl(repository.url) ||
      new URL(repository.url).origin === "https://github.com",
    {
      message:
        "{ kind: github_app } alone is for https://github.com; name app_id, installation_id and api_base for another host",
      path: ["url"],
    },
  );

// A remote MCP server an agent card may name. The operator fixes the
// pairing of server, credential and workspaces here: a card names only the
// server, so it cannot point one server's credential at another URL, and
// an admin elsewhere who binds the same credential name gets nothing. The
// value reaches only the egress proxy, as a bearer on the session's MCP
// route. Workspaces are named by slug, which never changes.
export const catalogMcpServerSchema = z
  .object({
    url: webUrl.refine(
      (value) => !isWebUrl(value) || new URL(value).search === "",
      { message: "must not carry a query" },
    ),
    credential_ref: credentialRefSchema,
    auth: credentialRef(z.literal("bearer")),
    workspaces: z
      .array(z.string().min(1))
      .min(1)
      .refine((slugs) => new Set(slugs).size === slugs.length, {
        message: "must not repeat a workspace",
      }),
  })
  .strict();

export const sessionCatalogConfigSchema = z
  .object({
    repositories: z.record(z.string().min(1), catalogRepositorySchema),
    mcp_servers: z.record(mcpServerIdSchema, catalogMcpServerSchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (Object.hasOwn(config.mcp_servers ?? {}, GITHUB_MCP_SERVER)) {
      ctx.addIssue({
        code: "custom",
        path: ["mcp_servers", GITHUB_MCP_SERVER],
        message: `${GITHUB_MCP_SERVER} is the built-in MCP server's name`,
      });
    }
  });

export type SessionCatalogConfig = z.infer<typeof sessionCatalogConfigSchema>;

/**
 * `sessionCatalogConfigSchema.safeParse`, except that with
 * `tolerateNoRepositories` a catalog left without any repository (every
 * entry was an old one the import skipped) is not refused for that alone.
 * Every other rule still applies.
 */
export function safeParseCatalogConfig(
  input: { repositories: Record<string, unknown> } & Record<string, unknown>,
  tolerateNoRepositories: boolean,
) {
  if (!tolerateNoRepositories || Object.keys(input.repositories).length > 0) {
    return sessionCatalogConfigSchema.safeParse(input);
  }
  const placeholder = "placeholder";
  const parsed = sessionCatalogConfigSchema.safeParse({
    ...input,
    repositories: {
      [placeholder]: {
        url: "https://github.com/placeholder/placeholder",
        branch: "main",
        auth: { kind: "github_app" },
      },
    },
  });
  if (parsed.success) delete parsed.data.repositories[placeholder];
  return parsed;
}
export type CatalogProviderConfig = z.infer<typeof catalogProviderSchema>;
export type CatalogRepositoryConfig = z.infer<typeof catalogRepositorySchema>;
export type RepositoryCredential =
  | {
      kind: "github_app";
      app_id: number;
      installation_id: number;
      api_base: string;
      /** The App's private key, PEM. */
      value: string;
      ref: CredentialRef;
    }
  // Resolved per request from the App registered in the console.
  | { kind: "github_app"; registered: true };
export type CatalogRepository = Omit<CatalogRepositoryConfig, "auth"> & {
  auth: RepositoryCredential;
};
export type CredentialRef =
  | { value_env: string }
  | { secret_id: string }
  | { stored: string };

/** A connection's provider with its credential resolved, its reference kept. */
export type CatalogProvider =
  | {
      kind: "anthropic";
      endpoint: string;
      auth: { kind: "api_key"; value: string; ref: CredentialRef };
      billing?: "none" | undefined;
    }
  | {
      kind: "litellm";
      endpoint: string;
      billing?: "none" | undefined;
      auth: {
        kind: "api_key" | "bearer";
        value: string;
        ref: CredentialRef;
      };
    }
  | {
      kind: "openai_responses";
      endpoint: string;
      auth: { kind: "api_key"; value: string; ref: CredentialRef };
      billing?: "none" | undefined;
    };

/**
 * A provider connection as the services hold it: where calls go, the models
 * an agent may name on it, their series for a retired model's successor,
 * and whether the engine's auto mode classifier works over it.
 */
export type CatalogConnection = {
  provider: CatalogProvider;
  models: readonly string[];
  model_families?: ModelFamilies | undefined;
  auto_mode: ConnectionAutoMode;
};

export type CatalogMcpServerConfig = z.infer<typeof catalogMcpServerSchema>;
export type CatalogMcpServer = Omit<CatalogMcpServerConfig, "auth"> & {
  auth: { kind: "bearer"; value: string; ref: CredentialRef };
};

export type SessionCatalog = {
  /** The enabled connections whose credential resolves, by id. */
  connections: Record<string, CatalogConnection>;
  repositories: Record<string, CatalogRepository>;
  mcp_servers?: Record<string, CatalogMcpServer> | undefined;
  /**
   * The installation settings generation the catalog was read at
   * (settings_generation); absent for a catalog read from no settings.
   */
  settings_generation?: number | undefined;
  /** Repository ids the settings hold that did not resolve here. */
  unavailable_repositories?: ReadonlySet<string> | undefined;
  /**
   * Connection ids the settings hold that this read could not resolve:
   * another replica may, so a session on one is not failed here.
   */
  unavailable_connections?: ReadonlySet<string> | undefined;
  runtime_versions?: RuntimeVersions;
};

type ProviderView<P> = P extends { auth: infer A }
  ? Omit<P, "auth"> & { auth: Omit<A, "value"> }
  : never;

/** A connection without its credential value. */
export type CatalogConnectionView = Omit<CatalogConnection, "provider"> & {
  provider: ProviderView<CatalogProvider>;
};
/**
 * A repository without its credentials. `github_app` is set when it uses the
 * App registered in the console, which an `installed` ceiling allows; that
 * `auth` holds no secret.
 */
export type CatalogRepositoryView = Omit<CatalogRepository, "auth"> & {
  /** The console's GitHub App reaches it. */
  github_app?: true;
  /** A GitHub App the settings document names reaches it. */
  own_github_app?: true;
};

/**
 * The catalog without credential values: what creating a session and
 * appending to one read. A `SessionCatalog` is one; `sessionCatalogView`
 * builds one from the config for a process that holds no provider key.
 */
export type SessionCatalogView = {
  connections: Readonly<Record<string, CatalogConnectionView>>;
  repositories: Readonly<Record<string, CatalogRepositoryView>>;
  runtime_versions?: RuntimeVersions | undefined;
  /** The built-in tool catalogs this image installs. */
  tool_catalogs?: ToolCatalogs | undefined;
  /** The MCP servers this installation lists (keys only are read). */
  mcp_servers?: Readonly<Record<string, unknown>> | undefined;
};

/** A remote MCP server the session's agent release names, as claimed. */
export type SessionMcp = {
  releaseId: string;
  server: string;
  /** The release's `mcp__<server>__*` tools pinned `allow`. */
  tools: string[];
};

/**
 * What an MCP egress token is held to: the release, and the server's URL
 * and credential name as the catalog had them at the claim. A catalog edit
 * since refuses the route, and the checkpoint fingerprint names this in
 * place of the token, so a server or credential renamed makes another
 * digest.
 */
export function mcpBinding(
  releaseId: string,
  serverId: string,
  server: Pick<CatalogMcpServer, "url" | "credential_ref">,
): string {
  return sha256({
    release_id: releaseId,
    server_id: serverId,
    url: server.url,
    credential_ref: server.credential_ref,
  });
}

/** Where the MCP route goes and the service account it calls as. */
export function mcpUpstreamOf(server: CatalogMcpServer): EgressUpstream {
  return {
    url: server.url,
    headers: [["authorization", `Bearer ${server.auth.value}`]],
  };
}

function pinnedWith(
  serverId: string,
  perTool: Readonly<Record<string, string>>,
  wanted: string,
): string[] {
  const prefix = `${MCP_TOOL_PREFIX}${serverId}__`;
  return Object.entries(perTool)
    .filter(
      ([tool, policy]) =>
        tool.startsWith(prefix) &&
        tool.length > prefix.length &&
        policy === wanted,
    )
    .map(([tool]) => tool)
    .sort();
}

/** The release's MCP tools a session runs: its `allow` pins for the server. */
export function pinnedMcpTools(
  serverId: string,
  perTool: Readonly<Record<string, string>>,
): string[] {
  return pinnedWith(serverId, perTool, "allow");
}

/**
 * Every `mcp__` tool the release pins as `deny`, whichever server it names.
 * An explicit block list: the agent's saved settings may follow another
 * server than the card's, and cannot reopen a name the release denies.
 */
export function deniedMcpTools(
  perTool: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(perTool)
    .filter(
      ([tool, policy]) => tool.startsWith(MCP_TOOL_PREFIX) && policy === "deny",
    )
    .map(([tool]) => tool)
    .sort();
}

/** The built-in `github` server a session's release attaches (design github-agent.md §3). */
export type SessionGitHubMcp = {
  releaseId: string;
  /** The `mcp__github__<tool>` names the release's features expose. */
  tools: string[];
};

/**
 * The built-in server's binding: the release alone, which never changes
 * under a session, so a checkpoint made with the server stays restorable.
 */
export function githubMcpBinding(releaseId: string): string {
  return sha256({
    release_id: releaseId,
    server_id: GITHUB_MCP_SERVER,
    builtin: true,
  });
}

// The worker calls every server through the proxy's `/mcp/<name>` route;
// the built-in one has no address of its own to name here.
export const GITHUB_MCP_ENDPOINT = "https://builtin.invalid/mcp/github";

export type ClaimedMcpServer = {
  name: string;
  endpoint: string;
  binding: string;
  tools: string[];
  /** Set on the built-in server of a claim whose worker announced `platform_tool_trust`. */
  trusted?: string[];
};

/**
 * The tools of the built-in server the server judges itself, which a worker
 * lets past the engine's permission stage: the classes whose every write the
 * server decides again (push approval, the release's exposure, the grant).
 * Reviews and workflows stay with the engine.
 */
export function trustedGitHubTools(tools: readonly string[]): string[] {
  const prefix = `${MCP_TOOL_PREFIX}${GITHUB_MCP_SERVER}__`;
  return listedGitHubMcpTools(
    tools
      .filter((tool) => tool.startsWith(prefix))
      .map((tool) => tool.slice(prefix.length)),
  )
    .filter((name) =>
      TRUSTED_ACTION_CLASSES.includes(GITHUB_MCP_TOOL_CLASSES[name]),
    )
    .map((name) => `${prefix}${name}`);
}

const TRUSTED_ACTION_CLASSES: readonly ActionClass[] = [
  "push",
  "pull_request.write",
  "repository.read",
];

/**
 * The runtime config a claim hands over, with the session's MCP servers:
 * the current config and every restore config go through here, so a
 * checkpoint made with a server is restorable on the same terms.
 */
export function runtimeConfigWithMcp(
  config: RuntimeConfig,
  servers: readonly ClaimedMcpServer[],
  token: string,
): RuntimeConfig {
  if (servers.length === 0) return config;
  return {
    ...config,
    tools: [...config.tools, ...servers.flatMap((server) => server.tools)],
    mcp_servers: servers.map((server) => ({
      name: server.name,
      endpoint: server.endpoint,
      binding: server.binding,
      access: { kind: "egress_token", token },
      ...(server.trusted === undefined || server.trusted.length === 0
        ? {}
        : { platform: true as const, trusted: server.trusted }),
    })),
  };
}

/**
 * The provider as the worker protocol carries it: where the proxy
 * will send the engine's requests, and the attempt's token for that route.
 * The credential stays here; `providerUpstreamOf` is what the proxy gets.
 */
export function runtimeProviderOf(
  provider: Pick<CatalogProvider, "kind" | "endpoint">,
  token: string,
): z.infer<typeof runtimeConfigSchema.shape.provider> {
  return {
    kind: provider.kind,
    endpoint: provider.endpoint,
    auth: { kind: "egress_token", token },
  };
}

/**
 * A built-in tool list without the tools a session's caller limit denies.
 * `mcp__` names pass through untouched: MCP decisions are not made here.
 * The list itself comes back when nothing is removed.
 */
export function withoutDeniedTools<T extends readonly string[]>(
  tools: T,
  denied: readonly string[] | undefined,
): T | string[] {
  if (denied === undefined || denied.length === 0) return tools;
  const out = new Set(denied.filter((tool) => !tool.startsWith("mcp__")));
  const kept = tools.filter(
    (tool) => tool.startsWith("mcp__") || !out.has(tool),
  );
  return kept.length === tools.length ? tools : kept;
}

/**
 * Whether the engine's auto mode classifier works over a connection, as an
 * admin judged it. A connection nobody judged is `unknown`.
 */
export type ConnectionAutoMode = "supported" | "unsupported" | "unknown";

/** One request the egress proxy makes on a worker's behalf. */
export type EgressUpstream = {
  /** The base the route's path is appended to. */
  url: string;
  /** Set on the upstream request, replacing whatever the worker sent. */
  headers: Array<[string, string]>;
};

function ceilingHolds(
  catalog: { repositories: Readonly<Record<string, CatalogRepositoryView>> },
  ceiling: {
    repository_ids: readonly string[];
    github_app_repositories?: GitHubAppRepositories | undefined;
  },
  repositoryId: string,
): boolean {
  if (ceiling.repository_ids.includes(repositoryId)) return true;
  if (ceiling.github_app_repositories !== "installed") return false;
  const repository = Object.hasOwn(catalog.repositories, repositoryId)
    ? catalog.repositories[repositoryId]
    : undefined;
  return repository !== undefined && usesGitHubApp(repository);
}

/**
 * Whether a GitHub App reaches the repository: the console's, or one the
 * settings document names for it. An `installed` ceiling opens these; a
 * repository on a personal token is open only where a ceiling names it.
 */
export function usesGitHubApp(
  repository: CatalogRepositoryView | CatalogRepository,
): boolean {
  if (usesConsoleApp(repository)) return true;
  if ("own_github_app" in repository && repository.own_github_app === true) {
    return true;
  }
  const auth = "auth" in repository ? repository.auth : undefined;
  return auth?.kind === "github_app";
}

/** The workspace's ceiling on a repository; null allows none. */
export function repositoryInCeiling(
  catalog: { repositories: Readonly<Record<string, CatalogRepositoryView>> },
  ceiling: RepositoryCeiling | null,
  repositoryId: string,
): boolean {
  return ceiling !== null && ceilingHolds(catalog, ceiling, repositoryId);
}

/** Whether it uses the App registered in the console, view or not. */
export function usesConsoleApp(
  repository: CatalogRepositoryView | CatalogRepository,
): boolean {
  if ("github_app" in repository && repository.github_app === true) {
    return true;
  }
  const auth = "auth" in repository ? repository.auth : undefined;
  return auth?.kind === "github_app" && "registered" in auth;
}

/** Where a provider route goes and how it authenticates there. */
export function providerUpstreamOf(provider: CatalogProvider): EgressUpstream {
  const { auth, endpoint, kind } = provider;
  return {
    url: endpoint,
    // OpenAI takes its API key as a bearer token, whatever the connection
    // calls the credential.
    headers:
      auth.kind === "bearer" || kind === "openai_responses"
        ? [["authorization", `Bearer ${auth.value}`]]
        : [["x-api-key", auth.value]],
  };
}

/** The one provider path only an `openai_responses` connection serves. */
export const RESPONSES_PROVIDER_PATH = "/v1/responses";

/**
 * Whether a session on a connection of this kind may call the provider route
 * at `path`. The proxy names a path only for `/v1/responses` (none means a
 * Messages call), so the rule is that the Responses path and an
 * `openai_responses` connection go together: a Claude or LiteLLM session is
 * refused the Responses path, and an OpenAI one the Messages paths.
 */
export function providerPathAllowed(
  kind: ProviderKind,
  path: string | undefined,
): boolean {
  return (kind === "openai_responses") === (path === RESPONSES_PROVIDER_PATH);
}

/**
 * Where a repository route goes and how it authenticates there. A forge
 * repository's credential is issued per request (`GitHubGate.grant`).
 */
export function repositoryUpstreamOf(
  repository: CatalogRepository,
  issued?: GitCredential,
): EgressUpstream {
  const { url } = repository;
  if (issued !== undefined) {
    return { url, headers: [["authorization", basicAuthorization(issued)]] };
  }
  throw new Error("a github_app repository needs an issued credential");
}

function basicAuthorization(login: { username: string; password: string }) {
  return `Basic ${Buffer.from(`${login.username}:${login.password}`, "utf8").toString("base64")}`;
}

function withoutRepositorySecret(repository: CatalogRepository) {
  if (repository.auth === undefined || "registered" in repository.auth) {
    return repository;
  }
  const { value: _value, ...auth } = repository.auth;
  return { ...repository, auth };
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

// Bumped when the hashed shape changes, so an old value can never equal a
// new one by accident.
const BINDING_FINGERPRINT_VERSION = 1;

/** The models a connection offers, in its order. */
export function connectionModels(connection: {
  models: readonly string[];
}): string[] {
  return [...new Set(connection.models)];
}

type ModelList = {
  models: readonly string[];
  model_families?: ModelFamilies | undefined;
};

/**
 * The listed model of the same series a session on `removed` moves to: the
 * next rank up. Null while `removed` is still listed, or when no listed
 * model is a later version of it.
 */
export function modelSuccessor(
  connection: ModelList,
  removed: string,
): string | null {
  const families = connection.model_families;
  const listed = connectionModels(connection);
  const from = families?.[removed];
  if (!families || !from || listed.includes(removed)) return null;
  let best: { model: string; rank: number } | null = null;
  for (const model of listed) {
    const entry = families[model];
    if (
      entry?.family === from.family &&
      entry.rank > from.rank &&
      (best === null || entry.rank < best.rank)
    ) {
      best = { model, rank: entry.rank };
    }
  }
  return best?.model ?? null;
}

/** Every retired model of the connection with the model its sessions move to. */
export function modelMoves(
  connection: ModelList,
): Array<{ from: string; to: string }> {
  return Object.keys(connection.model_families ?? {}).flatMap((from) => {
    const to = modelSuccessor(connection, from);
    return to === null ? [] : [{ from, to }];
  });
}

/**
 * The engine versions the configured worker images ship (each image's SDK
 * and CLI version). A session whose spec names any `accepted` version runs;
 * `current` is the image new releases are made on.
 */
export type RuntimeVersions = {
  readonly accepted: readonly string[];
  readonly current: readonly string[];
};

/** Without configured images: none is listed, and every version runs. */
export function acceptedRuntimeVersions(catalog: {
  runtime_versions?: RuntimeVersions | undefined;
}): readonly string[] {
  return catalog.runtime_versions?.accepted ?? [];
}

/** Whether a release's runtime version runs on the configured images. */
export function runtimeVersionAccepted(
  catalog: { runtime_versions?: RuntimeVersions | undefined },
  version: string,
): boolean {
  const accepted = catalog.runtime_versions?.accepted;
  return accepted === undefined || accepted.includes(version);
}

/**
 * What a repository route is authorized against: the entry's URL, branch
 * and where its credential comes from, never the credential. A token issued
 * under one binding stops working if the entry is re-pointed, while the
 * value behind the same reference may still be rotated.
 */
export function repositoryBinding(
  id: string,
  repository: CatalogRepository,
): string {
  return sha256({
    fingerprint_version: BINDING_FINGERPRINT_VERSION,
    id,
    repository: withoutRepositorySecret(repository),
  });
}

/** The connection an id names, when it is enabled and its credential resolves. */
export function connectionOf<C extends CatalogConnectionView>(
  catalog: { connections: Readonly<Record<string, C>> },
  connectionId: string,
): C | undefined {
  return Object.hasOwn(catalog.connections, connectionId)
    ? catalog.connections[connectionId]
    : undefined;
}

/** The runtime a connection's kind runs on. */
export function runtimeKindOfProvider(kind: ProviderKind): RuntimeKind {
  return RUNTIME_KIND_OF_PROVIDER[kind];
}

/**
 * Why a session on `model` over `connectionId` cannot run here, or null when
 * it can: the connection is disabled or gone, or the model left its list
 * with no successor to move to.
 */
export function connectionRefusal(
  catalog: { connections: Readonly<Record<string, CatalogConnectionView>> },
  connectionId: string,
  model: string,
): "connection_missing" | "model_removed" | null {
  const connection = connectionOf(catalog, connectionId);
  if (connection === undefined) return "connection_missing";
  if (connectionModels(connection).includes(model)) return null;
  return modelSuccessor(connection, model) === null ? "model_removed" : null;
}

/**
 * Whether a session of the release that names no repository, as Slack's do,
 * can start: its connection runs its model here, and the repository its
 * policy starts on passes the agent's list and the workspace's ceiling as
 * `createSession` applies them.
 */
export function releaseStartable(
  catalog: SessionCatalogView,
  release: Pick<
    AgentRelease,
    "connection_id" | "repository_id" | "policy_pins"
  > & {
    model: string | undefined;
  },
  agentRow: AgentGitHubSettingsRow | null,
  repositoryCeiling: RepositoryCeiling | null,
): boolean {
  if (
    release.model === undefined ||
    connectionRefusal(catalog, release.connection_id, release.model) !== null
  ) {
    return false;
  }
  const policy = newSessionGitHubPolicy(agentRow, release.policy_pins.github);
  const repositoryId = startRepositoryOf(null, policy, release.repository_id);
  if (policy.source === "agent" && policy.settings === "invalid") return false;
  if (repositoryId === null) return true;
  if (!Object.hasOwn(catalog.repositories, repositoryId)) return false;
  if (
    policy.source === "agent" &&
    policy.settings !== "invalid" &&
    !policy.settings?.repositories.includes(repositoryId)
  ) {
    return false;
  }
  return repositoryInCeiling(catalog, repositoryCeiling, repositoryId);
}

export function credentialRefOf(auth: {
  value_env?: string | undefined;
  secret_id?: string | undefined;
  stored?: string | undefined;
}): CredentialRef {
  if (auth.value_env !== undefined) return { value_env: auth.value_env };
  if (auth.stored !== undefined) return { stored: auth.stored };
  return { secret_id: auth.secret_id as string };
}

/** The reference as `field: name`, for a message; never a value. */
export function describeCredentialRef(ref: CredentialRef): string {
  if ("value_env" in ref) return `value_env: ${ref.value_env}`;
  if ("stored" in ref) return `stored: ${ref.stored}`;
  return `secret_id: ${ref.secret_id}`;
}

export class CatalogCredentialError extends Error {
  /** `path` is where the reference sits, e.g. `connections.<id>.auth`. */
  constructor(
    readonly path: string,
    readonly ref: CredentialRef,
    reason = "is not set",
  ) {
    super(`${path}.${describeCredentialRef(ref)} ${reason}`);
  }
}

/** Every credential reference in the catalog, with where it sits. */
export function catalogCredentialRefs(
  config: SessionCatalogConfig,
  connections: Readonly<Record<string, CatalogProviderConfig>> = {},
): Array<{ path: string; ref: CredentialRef }> {
  const refs: Array<{ path: string; ref: CredentialRef }> = [];
  for (const [id, provider] of Object.entries(connections)) {
    const { kind: _kind, ...fields } = provider.auth;
    refs.push({ path: `connections.${id}.auth`, ref: credentialRefOf(fields) });
  }
  for (const [id, repository] of Object.entries(config.repositories)) {
    if (
      repository.auth === undefined ||
      isRegisteredGitHubApp(repository.auth)
    ) {
      continue;
    }
    refs.push({
      path: `repositories.${id}.auth`,
      ref: credentialRefOf(repository.auth),
    });
  }
  for (const [id, server] of Object.entries(config.mcp_servers ?? {})) {
    refs.push({
      path: `mcp_servers.${id}.auth`,
      ref: credentialRefOf(server.auth),
    });
  }
  return refs;
}

/**
 * The egress proxy watches its responses for the value it injected, and a
 * streamed body is only checked for values at least this long (shorter ones
 * turn up in pack data by chance). A shorter credential would pass through
 * unchecked, so it is refused here instead.
 */
export const MIN_CREDENTIAL_BYTES = 8;

/**
 * The catalog without credential values, read from the config alone: no
 * reference is looked up, so it needs no key and fails on none.
 */
export function sessionCatalogView(
  config: SessionCatalogConfig,
): Pick<SessionCatalogView, "repositories"> {
  const repositories: Record<string, CatalogRepositoryView> = {};
  for (const [id, repository] of Object.entries(config.repositories)) {
    repositories[id] = repositoryView(repository);
  }
  return { repositories };
}

/** The repository without its credentials, keeping the console App's mark. */
export function repositoryView(
  repository: Omit<CatalogRepositoryConfig, "auth"> & {
    auth?: CatalogRepositoryConfig["auth"] | RepositoryCredential;
  },
): CatalogRepositoryView {
  const { auth, ...rest } = repository;
  if (auth === undefined) return rest;
  if ("registered" in auth) return { ...rest, github_app: true };
  return auth.kind === "github_app" ? { ...rest, own_github_app: true } : rest;
}

/** One reference's value, refused naming `path` when it cannot go into a header. */
export function resolveCredential(
  path: string,
  ref: CredentialRef,
  lookup: (ref: CredentialRef) => string | undefined,
): string {
  const value = lookup(ref);
  if (!value) throw new CatalogCredentialError(path, ref);
  // It goes into a header as it is (or base64'd with the login): a
  // trailing newline from `echo` into a secret, say, would pass here and
  // be refused by the egress proxy on every call.
  if (hasControlCharacter(value) || value.trim() !== value) {
    throw new CatalogCredentialError(
      path,
      ref,
      "has a control character or surrounding whitespace",
    );
  }
  if (Buffer.byteLength(value, "utf8") < MIN_CREDENTIAL_BYTES) {
    throw new CatalogCredentialError(
      path,
      ref,
      `is shorter than ${MIN_CREDENTIAL_BYTES} bytes`,
    );
  }
  return value;
}

/**
 * The resolved catalog. `lookup` hands back each reference's value, already
 * fetched (a Secrets Manager read is the loader's job, not this pure step);
 * an absent or empty value fails naming where the reference sits, never a
 * value.
 */
export function resolveSessionCatalog(
  config: SessionCatalogConfig,
  lookup: (ref: CredentialRef) => string | undefined,
): Pick<SessionCatalog, "repositories" | "mcp_servers"> {
  const resolved = (path: string, ref: CredentialRef): string =>
    resolveCredential(path, ref, lookup);
  const repositories: Record<string, CatalogRepository> = {};
  for (const [id, repository] of Object.entries(config.repositories)) {
    const { auth, ...rest } = repository;
    if (isRegisteredGitHubApp(auth)) {
      repositories[id] = {
        ...rest,
        auth: { kind: "github_app", registered: true },
      };
      continue;
    }
    const ref = credentialRefOf(auth);
    const path = `repositories.${id}.auth`;
    if (auth.kind === "github_app") {
      repositories[id] = {
        ...rest,
        auth: {
          kind: "github_app",
          // Both present: the schema refuses an entry with only some.
          app_id: auth.app_id as number,
          installation_id: auth.installation_id as number,
          api_base: auth.api_base ?? GITHUB_API_BASE,
          value: privateKeyPem(path, ref, lookup(ref)),
          ref,
        },
      };
    }
  }
  if (config.mcp_servers === undefined) return { repositories };
  const mcp_servers: Record<string, CatalogMcpServer> = {};
  for (const [id, server] of Object.entries(config.mcp_servers)) {
    const ref = credentialRefOf(server.auth);
    mcp_servers[id] = {
      ...server,
      auth: {
        kind: "bearer",
        value: resolved(`mcp_servers.${id}.auth`, ref),
        ref,
      },
    };
  }
  return { repositories, mcp_servers };
}

/** A connection's provider with its credential looked up, or why it cannot be. */
export function resolveProvider(
  id: string,
  provider: CatalogProviderConfig,
  lookup: (ref: CredentialRef) => string | undefined,
): CatalogProvider {
  const { kind: authKind, ...fields } = provider.auth;
  const ref = credentialRefOf(fields);
  const value = resolveCredential(`connections.${id}.auth`, ref, lookup);
  const { billing, ...rest } = provider;
  return {
    ...rest,
    ...(billing === "none" ? { billing } : {}),
    auth: { kind: authKind, value, ref },
  } as CatalogProvider;
}

// A PEM spans lines, which an environment variable often carries as `\n`
// escapes. Parsed here so a key that cannot sign fails startup, not the
// first clone.
function privateKeyPem(
  path: string,
  ref: CredentialRef,
  raw: string | undefined,
): string {
  if (!raw) throw new CatalogCredentialError(path, ref);
  const pem = raw.replace(/\\n/g, "\n").trim();
  try {
    if (createPrivateKey(pem).asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    throw new CatalogCredentialError(
      path,
      ref,
      "is not an RSA private key PEM",
    );
  }
  return pem;
}

/** Environment-only lookup: a secret reference resolves to nothing here. */
export function environmentCredentials(
  env: Record<string, string | undefined>,
): (ref: CredentialRef) => string | undefined {
  return (ref) => ("value_env" in ref ? env[ref.value_env] : undefined);
}

/** A zod failure as one line naming each path, for a startup error. */
export function describeConfigError(error: unknown): string {
  return error instanceof z.ZodError
    ? error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
}
