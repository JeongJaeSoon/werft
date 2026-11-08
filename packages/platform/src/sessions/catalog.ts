import { createHash, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import {
  type ActionClass,
  type AgentGitHubSettingsRow,
  type AgentRelease,
  type InstallationProfileState as ContractInstallationProfileState,
  canonicalJson,
  credentialRefSchema,
  GITHUB_MCP_SERVER,
  GITHUB_MCP_TOOL_CLASSES,
  type GitHubAppRepositories,
  type GitHubPolicySource,
  listedGitHubMcpTools,
  MCP_TOOL_PREFIX,
  mcpServerIdSchema,
  narrowOnlyPolicy,
  newSessionGitHubPolicy,
  type ProfileDerivationPolicy,
  permissionModeSchema,
  projectSettingsSchema,
  type RepositoryCeiling,
  type RepositoryMode,
  type RepositoryScope,
  type RuntimeConfig,
  type RuntimeKind,
  repositoryModeSchema,
  type runtimeConfigSchema,
  runtimeKindSchema,
  startRepositoryOf,
  WORKSPACE_PROFILE_POLICY,
  type WorkspaceProfileState,
} from "@werft-ai/contracts";
import { z } from "zod";
import { type GitCredential, repoRefOf } from "../ports/forge.ts";
import type { InstallationProfileRecord } from "../ports/installation-profile-store.ts";
import type { ToolCatalogs } from "./profile-tools.ts";

// An entry never holds a credential value outside `secret_values`: it names a
// stored value, an environment variable or a Secrets Manager secret.
//
// The config block below is the Claude engine's shape whatever kind a
// profile names; a kind no installed runtime serves leaves the ceiling out
// as `runtime_unsupported` (`ProfileFeatureGate`). Other kinds get their own block when an adapter
// for them lands.

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
> = { anthropic: "https://api.anthropic.com" };

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

export const catalogProfileConfigSchema = z
  .object({
    runtime_kind: runtimeKindSchema,
    runtime_version: z.string().min(1),
    model: z.string().min(1),
    // Other models a session may name at create; `model` is the default.
    // Not part of what a session is pinned to, so adding one stops nothing.
    models: z.array(z.string().min(1)).min(1).optional(),
    // The model that names a session after its first turn; the session's own
    // when absent. Not pinned either: it never runs the session.
    title_model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)),
    permission_mode: permissionModeSchema,
    provider: catalogProviderSchema,
    // Off unless the operator turns it on: a profile written before this
    // field existed keeps the run it was reviewed for.
    project_settings: projectSettingsSchema.default({ claude_md: false }),
    // Absent reads as `required` (`repositoryModeOf`), except on a stored
    // row with no repository scope, which `parsedDefinition` marks `optional`.
    repository: repositoryModeSchema.optional(),
  })
  .strict()
  .refine(
    (profile) =>
      profile.repository !== "none" || !profile.project_settings.claude_md,
    {
      message:
        "a profile with repository none has no repository CLAUDE.md to read",
      path: ["project_settings", "claude_md"],
    },
  )
  .refine((profile) => billingFitsEndpoint(profile.provider), {
    message: BILLING_NONE_ENDPOINT_MESSAGE,
    path: ["provider", "billing"],
  });

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

// The pair of profile and repository is the unit of trust: a profile that
// lets the repository's CLAUDE.md into the system prompt must not carry
// that trust to a repository whose authors it was never granted for.
// Checked at create and again at claim, against the ceiling's
// `repository_ids` in the database; `profiles` here only seeds them.
export const catalogRepositorySchema = z
  .object({
    url: webUrl,
    branch: z.string().min(1),
    profiles: z.array(z.string().min(1)).min(1).optional(),
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

export const WORKSPACE_PROFILE_PREFIX = "ws_";

export const sessionCatalogConfigSchema = z
  .object({
    profiles: z.record(z.string().min(1), catalogProfileConfigSchema),
    repositories: z.record(z.string().min(1), catalogRepositorySchema),
    mcp_servers: z.record(mcpServerIdSchema, catalogMcpServerSchema).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const id of Object.keys(config.profiles)) {
      if (id.startsWith(WORKSPACE_PROFILE_PREFIX)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", id],
          message: `profile ids starting with ${WORKSPACE_PROFILE_PREFIX} are the workspace profiles' own`,
        });
      }
    }
    if (Object.hasOwn(config.mcp_servers ?? {}, GITHUB_MCP_SERVER)) {
      ctx.addIssue({
        code: "custom",
        path: ["mcp_servers", GITHUB_MCP_SERVER],
        message: `${GITHUB_MCP_SERVER} is the built-in MCP server's name`,
      });
    }
    if (
      Object.keys(config.repositories).length === 0 &&
      Object.keys(config.profiles).length > 0 &&
      Object.values(config.profiles).every(
        (profile) => repositoryModeOf(profile) === "required",
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["repositories"],
        message:
          "at least one repository is required unless a profile's repository is optional or none",
      });
    }
    for (const [id, repository] of Object.entries(config.repositories)) {
      repository.profiles?.forEach((profileId, index) => {
        if (
          Object.hasOwn(config.profiles, profileId) &&
          repositoryModeOf(config.profiles[profileId] ?? {}) === "none"
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["repositories", id, "profiles", index],
            message: `names profile ${profileId}, whose repository is none`,
          });
        }
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
export type CatalogProfileConfig = z.infer<typeof catalogProfileConfigSchema>;
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

// What the services hold: each credential resolved, its reference kept so
// the fingerprint can name where it came from without the value.
export type CatalogProfile = {
  runtime_kind: RuntimeKind;
  runtime_version: string;
  model: string;
  models?: string[] | undefined;
  title_model?: string | undefined;
  tools: string[];
  permission_mode: z.infer<typeof permissionModeSchema>;
  project_settings?: z.infer<typeof projectSettingsSchema> | undefined;
  /**
   * The `mcp__` names the stored profile blocks, sorted. Not part of the
   * definition: the registry reads them from the deny column. Absent when
   * none, so the fingerprint of a profile without them is unchanged.
   */
  mcp_deny?: string[] | undefined;
  // Absent is `required`, never spelled out: see `repositoryModeOf`.
  repository?: Exclude<RepositoryMode, "required"> | undefined;
  provider:
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
      };
};

export type CatalogMcpServerConfig = z.infer<typeof catalogMcpServerSchema>;
export type CatalogMcpServer = Omit<CatalogMcpServerConfig, "auth"> & {
  auth: { kind: "bearer"; value: string; ref: CredentialRef };
};

export type SessionCatalog = {
  profiles: Record<string, CatalogProfile>;
  repositories: Record<string, CatalogRepository>;
  mcp_servers?: Record<string, CatalogMcpServer> | undefined;
  /**
   * The installation settings generation the catalog was read at
   * (settings_generation); absent for a catalog read from no settings.
   */
  settings_generation?: number | undefined;
  /** Repository ids the settings hold that did not resolve here. */
  unavailable_repositories?: ReadonlySet<string> | undefined;
  workspace_profiles?: WorkspaceProfiles;
  installation?: InstallationProfiles;
  runtime_versions?: RuntimeVersions;
};

/**
 * Why an installation ceiling runs here or not. `retired` still runs what
 * already uses it; `runtime_unsupported` is this image's worker lacking the
 * runtime or its mode.
 */
export type InstallationProfileState = ContractInstallationProfileState;

export type InstallationProfileEntry = {
  id: string;
  origin: "catalog" | "console";
  state: InstallationProfileState;
  /** Repositories a console ceiling runs against beside `repositories.<id>.profiles`. */
  repository_ids: readonly string[];
  /** `installed` also runs every resolved GitHub App repository; absent is `listed`. */
  github_app_repositories?: GitHubAppRepositories | undefined;
  /**
   * Absent reads as `profile`: only a stored row can say `workspace`. Null:
   * the row names no repository, so the workspace's ceiling judges them.
   */
  repository_scope?: RepositoryScope | null | undefined;
  /** For a ceiling stopped only because a version it derives from is blocked: that version. */
  blocked_source?: string | undefined;
  /** The row as stored, for listing; absent in a snapshot built without rows. */
  record?: InstallationProfileRecord | undefined;
  /** The row's definition when it still parses, whatever the state. */
  definition?: CatalogProfileConfig | undefined;
  /** The connection its provider is, when it is one. */
  connection_id?: string | null | undefined;
};

/** Every installation ceiling this process has read, by id. */
export type InstallationProfiles = ReadonlyMap<
  string,
  InstallationProfileEntry
>;

/**
 * A version of a workspace profile as stored: an operator profile narrowed
 * by an owner or admin. Nothing in it changes but `retired_at`.
 */
export type WorkspaceProfileRecord = {
  id: string;
  workspace_id: string;
  name: string;
  version: number;
  base_profile_id: string;
  // `profileFingerprint` of the base when the version was made: a version
  // runs only while its base still hashes to this.
  base_fingerprint: string;
  model: string;
  models: string[];
  tools: string[];
  permission_mode: z.infer<typeof permissionModeSchema>;
  // The base as it was, for listing a version whose base the operator removed.
  base_runtime_version: string;
  base_billing: "metered" | "none";
  base_repository_mode: RepositoryMode;
  /** As on an installation ceiling: outside the base fingerprint and every digest. */
  deny?: string[] | null;
  tool_catalog_id?: string | null;
  created_by: string;
  created_at: Date;
  retired_by: string | null;
  retired_at: Date | null;
};

/**
 * The workspace profiles this process has read. The database holds them, so
 * a version another replica made shows here only after `refresh`.
 */
export interface WorkspaceProfiles {
  readonly records: ReadonlyMap<string, WorkspaceProfileRecord>;
  /** How its versions may differ from their bases; `WORKSPACE_PROFILE_POLICY` when unset. */
  readonly policy?: ProfileDerivationPolicy;
  /** Reads them again unless the last read began within `maxAgeMs`. */
  refresh(maxAgeMs?: number): Promise<void>;
}

type ProviderView<P> = P extends { auth: infer A }
  ? Omit<P, "auth"> & { auth: Omit<A, "value"> }
  : never;

/**
 * A profile as session admission reads it: every setting and where its
 * credential comes from, never the credential. A `CatalogProfile` is one.
 */
export type CatalogProfileView = Omit<CatalogProfile, "provider"> & {
  provider: ProviderView<CatalogProfile["provider"]>;
};
/**
 * A repository without its credentials. `github_app` is set when it uses the
 * App registered in the console, which an `installed` ceiling allows; that
 * `auth` holds no secret.
 */
export type CatalogRepositoryView = Omit<CatalogRepository, "auth"> & {
  github_app?: true;
};

/**
 * The catalog without credential values: what creating a session and
 * appending to one read. A `SessionCatalog` is one; `sessionCatalogView`
 * builds one from the config for a process that holds no provider key.
 */
export type SessionCatalogView = {
  profiles: Record<string, CatalogProfileView>;
  repositories: Record<string, CatalogRepositoryView>;
  workspace_profiles?: WorkspaceProfiles;
  installation?: InstallationProfiles;
  runtime_versions?: RuntimeVersions;
  /** What a profile's deny names; read on the write path and for listing only. */
  tool_catalogs?: ToolCatalogs;
  /**
   * The MCP servers this installation lists (keys only are read): the
   * servers a profile's deny may name tools of. Absent lists none.
   */
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

/** The release's MCP tools a session runs: its `allow` pins for the server. */
export function pinnedMcpTools(
  serverId: string,
  perTool: Readonly<Record<string, string>>,
): string[] {
  const prefix = `${MCP_TOOL_PREFIX}${serverId}__`;
  return Object.entries(perTool)
    .filter(
      ([tool, policy]) =>
        tool.startsWith(prefix) &&
        tool.length > prefix.length &&
        policy === "allow",
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
  profile: CatalogProfile,
  token: string,
): z.infer<typeof runtimeConfigSchema.shape.provider> {
  return {
    kind: profile.provider.kind,
    endpoint: profile.provider.endpoint,
    auth: { kind: "egress_token", token },
  };
}

/**
 * Whether a claim runs a session's release tools instead of its profile's.
 * An API older than the one that offers both lists as restore configs
 * cannot resume a checkpoint made with the release's, so that one is the
 * rollback floor (site page run-server/self-hosting/operate/images-and-supply-chain).
 */
export const CLAIM_RUNS_RELEASE_TOOLS = true;

export type ToolList = "profile" | "release";

/**
 * The built-in tool lists a session's checkpoints may be made with under
 * `profile`, and the one its engine runs. `release` is null when the
 * session has no release (`releaseTools` null) or it keeps every profile
 * tool; it is taken within the profile, so no list ever holds a tool the
 * profile does not.
 *
 * A claim offers the profile lists of every restore profile before any
 * release list: the protocol caps restore configs, and the profile lists
 * are what every checkpoint from before release lists ran with.
 */
export function claimToolLists(
  profile: CatalogProfile,
  releaseTools: readonly string[] | null,
  runRelease: boolean = CLAIM_RUNS_RELEASE_TOOLS,
): {
  profile: readonly string[];
  release: readonly string[] | null;
  runs: ToolList;
} {
  const chosen = releaseTools === null ? null : new Set(releaseTools);
  const release = chosen && profile.tools.filter((tool) => chosen.has(tool));
  const narrower =
    release !== null && release.length !== profile.tools.length
      ? release
      : null;
  return {
    profile: profile.tools,
    release: narrower,
    runs: runRelease && narrower !== null ? "release" : "profile",
  };
}

/**
 * The profile as a claim hands it to the worker, which hashes it into the
 * checkpoint fingerprint; `scripts/lib/checkpoint-pins.ts` rebuilds it to ask
 * a target image for that digest. A session without a repository has no
 * CLAUDE.md to read, whatever an `optional` profile says.
 */
export function runtimeConfigOf(
  profile: CatalogProfile,
  providerToken: string,
  hasRepository: boolean,
  tools: readonly string[] = profile.tools,
): RuntimeConfig {
  return {
    model: profile.model,
    tools: [...tools],
    permission_mode: profile.permission_mode,
    provider: runtimeProviderOf(profile, providerToken),
    ...(hasRepository && profile.project_settings?.claude_md === true
      ? { project_settings: profile.project_settings }
      : {}),
  };
}

/** One request the egress proxy makes on a worker's behalf. */
export type EgressUpstream = {
  /** The base the route's path is appended to. */
  url: string;
  /** Set on the upstream request, replacing whatever the worker sent. */
  headers: Array<[string, string]>;
};

/** A profile that does not say is `required`: that is what older rows meant. */
export function repositoryModeOf(profile: {
  repository?: RepositoryMode | undefined;
}): RepositoryMode {
  return profile.repository ?? "required";
}

/** Where a profile id is looked up: the operator's, then the workspaces'. */
export type ProfileLookup<P extends CatalogProfileView> = {
  profiles: Readonly<Record<string, P>>;
  workspace_profiles?: WorkspaceProfiles | undefined;
  installation?: InstallationProfiles | undefined;
  runtime_versions?: RuntimeVersions | undefined;
};

export type ProfileNarrowing = Pick<
  WorkspaceProfileRecord,
  "model" | "models" | "tools" | "permission_mode"
>;

export function derivationPolicyOf(catalog: {
  workspace_profiles?: WorkspaceProfiles | undefined;
}): ProfileDerivationPolicy {
  return catalog.workspace_profiles?.policy ?? WORKSPACE_PROFILE_POLICY;
}

/**
 * Why `narrowing` would widen `base`, naming the request field, or null when
 * every value is the base's or narrower.
 */
export function narrowingRefusal(
  base: CatalogProfileView,
  narrowing: ProfileNarrowing,
): { field: keyof ProfileNarrowing; message: string } | null {
  return narrowOnlyPolicy.refusal(base, narrowing);
}

/** Whether a workspace profile version takes new releases and sessions. */
export function workspaceProfileState(
  catalog: ProfileLookup<CatalogProfileView>,
  record: WorkspaceProfileRecord,
): WorkspaceProfileState {
  // Before retired: a block stops the version's existing releases too.
  if (catalog.installation?.get(record.base_profile_id)?.state === "blocked") {
    return "base_blocked";
  }
  if (record.retired_at !== null) return "retired";
  const base = Object.hasOwn(catalog.profiles, record.base_profile_id)
    ? catalog.profiles[record.base_profile_id]
    : undefined;
  if (!base) return "base_missing";
  if (
    !baseHolds(
      derivationPolicyOf(catalog),
      base,
      record,
      acceptedRuntimeVersions(catalog),
    )
  ) {
    return "base_changed";
  }
  return catalog.installation?.get(record.base_profile_id)?.state === "retired"
    ? "base_retired"
    : "usable";
}

function baseHolds(
  policy: ProfileDerivationPolicy,
  base: CatalogProfileView,
  record: WorkspaceProfileRecord,
  versions: readonly string[],
): boolean {
  return (
    underVersions(base, versions).some(
      (seen) => profileFingerprint(seen) === record.base_fingerprint,
    ) && policy.refusal(base, record) === null
  );
}

/**
 * The profile an id runs: the operator's entry, or a workspace version over
 * its base. A version whose base changed since it was made runs nothing, as
 * an operator profile edited in place does; a retired one still runs what
 * already uses it.
 */
export function catalogProfile<P extends CatalogProfileView>(
  catalog: ProfileLookup<P>,
  profileId: string,
): P | undefined {
  if (Object.hasOwn(catalog.profiles, profileId)) {
    return catalog.profiles[profileId];
  }
  const record = catalog.workspace_profiles?.records.get(profileId);
  if (!record) return undefined;
  const base = Object.hasOwn(catalog.profiles, record.base_profile_id)
    ? catalog.profiles[record.base_profile_id]
    : undefined;
  const policy = derivationPolicyOf(catalog);
  return base &&
    baseHolds(policy, base, record, acceptedRuntimeVersions(catalog))
    ? policy.apply(base, record)
    : undefined;
}

/** Every workspace version that runs now, with the operator profile it narrows. */
export function workspaceCatalogProfiles<P extends CatalogProfileView>(
  catalog: ProfileLookup<P>,
): Array<{ id: string; baseId: string; profile: P }> {
  return [...(catalog.workspace_profiles?.records.values() ?? [])].flatMap(
    (record) => {
      const profile = catalogProfile(catalog, record.id);
      return profile
        ? [{ id: record.id, baseId: record.base_profile_id, profile }]
        : [];
    },
  );
}

/**
 * Why `workspaceId` may not name `profileId` for a new release or session,
 * or null when it may. Another workspace's version reads as unknown.
 * `retiredAllowed`: a session of a release already made on a retired
 * version still starts.
 */
export function workspaceProfileRefusal(
  catalog: ProfileLookup<CatalogProfileView>,
  workspaceId: string,
  profileId: string,
  options: { retiredAllowed?: boolean } = {},
): {
  state: WorkspaceProfileState | "blocked" | "unknown" | "connection_missing";
  message: string;
} | null {
  if (!profileId.startsWith(WORKSPACE_PROFILE_PREFIX)) {
    const owner = catalog.installation?.get(profileId)?.record?.workspace_id;
    if (owner != null && owner !== workspaceId) {
      return { state: "unknown", message: `Unknown profile ${profileId}` };
    }
    const state = catalog.installation?.get(profileId)?.state;
    if (state === "blocked") {
      return {
        state,
        message: `Profile ${profileId} is blocked by the operator`,
      };
    }
    // Without a usable key the connection is left out of the catalog; say so
    // instead of letting the start read as an unknown profile.
    if (state === "connection_missing") {
      return {
        state,
        message: `Profile ${profileId} cannot run: its model connection has no usable key. Add the key under Settings > Workspace settings > Model connections.`,
      };
    }
    return !options.retiredAllowed && state === "retired"
      ? {
          state: "retired",
          message: `Profile ${profileId} is retired: pick a newer version`,
        }
      : null;
  }
  const record = catalog.workspace_profiles?.records.get(profileId);
  if (!record || record.workspace_id !== workspaceId) {
    return { state: "unknown", message: `Unknown profile ${profileId}` };
  }
  const state = workspaceProfileState(catalog, record);
  if (
    state === "usable" ||
    (options.retiredAllowed &&
      (state === "retired" || state === "base_retired"))
  ) {
    return null;
  }
  return {
    state,
    message:
      state === "retired"
        ? `Profile ${profileId} is retired: pick a newer version`
        : state === "base_retired"
          ? `The base of profile ${profileId} is retired: make a new version over a newer one`
          : state === "base_blocked"
            ? `The base of profile ${profileId} is blocked by the operator`
            : `The operator changed or removed the base of profile ${profileId}: make a new version`,
  };
}

const WORKSPACE_PROFILE_KNOWN_MAX_AGE_MS = 1000;

/**
 * Brings the workspace versions among `profileIds` up to date enough to
 * resolve them. A failed read keeps what was read before: an operator
 * profile never waits on the database. `strict` throws it instead, for a
 * new use of a version, which a retirement elsewhere must stop.
 */
export async function refreshWorkspaceProfilesFor(
  catalog: Pick<ProfileLookup<CatalogProfileView>, "workspace_profiles"> &
    Partial<ProfileLookup<CatalogProfileView>>,
  profileIds: ReadonlyArray<string | null | undefined>,
  options: { strict?: boolean } = {},
): Promise<void> {
  const registry = catalog.workspace_profiles;
  // With installation ceilings in the database any id may be one another
  // replica made or retired, not only a workspace version.
  const named = profileIds.filter(
    (id): id is string =>
      typeof id === "string" &&
      (catalog.installation !== undefined ||
        id.startsWith(WORKSPACE_PROFILE_PREFIX)),
  );
  if (!registry || named.length === 0) return;
  const unread = named.some(
    (id) =>
      !registry.records.has(id) &&
      !catalog.installation?.has(id) &&
      !Object.hasOwn(catalog.profiles ?? {}, id),
  );
  const read = registry.refresh(
    unread ? 0 : WORKSPACE_PROFILE_KNOWN_MAX_AGE_MS,
  );
  await (options.strict ? read : read.catch(() => undefined));
}

function trustedProfileId(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
): string {
  return (
    catalog.workspace_profiles?.records.get(profileId)?.base_profile_id ??
    profileId
  );
}

/**
 * Whether `profileId` (or the ceiling a workspace version narrows) may run
 * against the repository: among the ceiling's `repository_ids`, or, on an
 * `installed` ceiling, a repository of the console's GitHub App.
 */
export function profileAllowsRepository(
  catalog: ProfileLookup<CatalogProfileView> & {
    repositories: Readonly<Record<string, CatalogRepositoryView>>;
  },
  profileId: string,
  repositoryId: string,
): boolean {
  const ceiling = catalog.installation?.get(
    trustedProfileId(catalog, profileId),
  );
  return ceiling !== undefined && ceilingHolds(catalog, ceiling, repositoryId);
}

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
  return repository !== undefined && usesConsoleApp(repository);
}

/** The workspace's ceiling on a repository; null allows none. */
export function repositoryInCeiling(
  catalog: { repositories: Readonly<Record<string, CatalogRepositoryView>> },
  ceiling: RepositoryCeiling | null,
  repositoryId: string,
): boolean {
  return ceiling !== null && ceilingHolds(catalog, ceiling, repositoryId);
}

/**
 * Whether the workspace's repository ceiling, not the profile's, judges the
 * session: an `agent` session, or a profile that says so. That ceiling is not
 * in the catalog, so `allowedPair` and `allowedRun` stop at the catalog for
 * these and the caller that can read it judges it: session start, the gate.
 */
export function usesWorkspaceCeiling(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string | null,
  source: GitHubPolicySource,
): boolean {
  if (source !== "release") return true;
  if (profileId === null) return false;
  const scope = catalog.installation?.get(
    trustedProfileId(catalog, profileId),
  )?.repository_scope;
  return scope === "workspace" || scope === null;
}

/** The ceiling's `github_app_repositories`; null for a profile with no ceiling. */
export function ceilingAppRepositories(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
): GitHubAppRepositories | null {
  const ceiling = catalog.installation?.get(
    trustedProfileId(catalog, profileId),
  );
  if (ceiling === undefined) return null;
  return ceiling.github_app_repositories ?? "listed";
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

/** Whether every session of the profile names a repository; false for an unknown profile. */
export function profileNeedsRepository(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
): boolean {
  const profile = catalogProfile(catalog, profileId);
  return profile !== undefined && repositoryModeOf(profile) === "required";
}

/** Whether the profile declared `billing: none`: no cost, no dollar limit. */
export function isUnmetered(profile: CatalogProfileView): boolean {
  return profile.provider.billing === "none";
}

/** Where a provider route goes and how it authenticates there. */
export function providerUpstreamOf(profile: CatalogProfile): EgressUpstream {
  const { auth, endpoint } = profile.provider;
  return {
    url: endpoint,
    headers:
      auth.kind === "bearer"
        ? [["authorization", `Bearer ${auth.value}`]]
        : [["x-api-key", auth.value]],
  };
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

function withoutSecret(profile: CatalogProfileView) {
  const {
    value: _value,
    ...auth
  }: CatalogProfileView["provider"]["auth"] & { value?: unknown } =
    profile.provider.auth;
  return { ...profile, provider: { ...profile.provider, auth } };
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

// Bumped when the hashed shape changes, so an old value can never equal a
// new one by accident.
const BINDING_FINGERPRINT_VERSION = 1;

// 2: the model and the repository mode left the hash; they live in the
// row's `model` and `repository_mode`.
const PROFILE_FINGERPRINT_VERSION = 2;

/**
 * Identifies what a profile runs apart from which of its models: every
 * setting and where its credential comes from, never the credential. Two ids
 * with the same settings share one. This is not the checkpoint fingerprint
 * (which also covers the owner, the model and the engine's components); a
 * session snapshots this one together with its model.
 */
export function profileFingerprint(profile: CatalogProfileView): string {
  const {
    models: _models,
    model: _model,
    repository: _repository,
    title_model: _titleModel,
    ...runs
  } = withoutSecret(profile);
  return sha256({
    fingerprint_version: PROFILE_FINGERPRINT_VERSION,
    profile: runs,
  });
}

function profileFingerprintV1(profile: CatalogProfileView): string {
  const {
    models: _models,
    title_model: _titleModel,
    ...runs
  } = withoutSecret(profile);
  return sha256({ fingerprint_version: 1, profile: runs });
}

/** The models a session of this profile may name, the default first. */
export function profileModels(profile: CatalogProfileView): string[] {
  return [...new Set([profile.model, ...(profile.models ?? [])])];
}

/**
 * The profile as a session that named `model` runs it, or null when the
 * profile does not offer that model. Everything downstream — fingerprint,
 * runtime config, egress route — takes this, never the catalog entry.
 */
export function profileWithModel<P extends CatalogProfileView>(
  profile: P,
  model: string = profile.model,
): P | null {
  if (!profileModels(profile).includes(model)) return null;
  const { models: _models, ...rest } = profile;
  return { ...rest, model } as unknown as P;
}

/** What a row holds a profile to: its fingerprint and the model it names. */
export type ProfilePin = {
  fingerprint: string | null;
  model: string | null;
};

/**
 * The engine versions the configured worker images ship (each image's SDK
 * and CLI version). A worker image upgrade moves a profile's
 * `runtime_version` while a session pinned before it resumes on the
 * previous image, so a pin taken under any `accepted` version still names
 * the profile. `current` is the image new sessions start on.
 */
export type RuntimeVersions = {
  readonly accepted: readonly string[];
  readonly current: readonly string[];
};

/** Without configured images: a pin matches the profile as written only. */
export function acceptedRuntimeVersions(catalog: {
  runtime_versions?: RuntimeVersions | undefined;
}): readonly string[] {
  return catalog.runtime_versions?.accepted ?? [];
}

/**
 * Whether a new session of `profile` starts on the engine its
 * `runtime_version` names. Nothing is checked without configured images.
 */
export function runsOnCurrentImage(
  catalog: { runtime_versions?: RuntimeVersions | undefined },
  profile: Pick<CatalogProfileView, "runtime_version">,
): boolean {
  const current = catalog.runtime_versions?.current;
  return current === undefined || current.includes(profile.runtime_version);
}

// The profile as written, then as a row pinned under each other accepted
// version saw it. Only `runtime_version` differs.
function underVersions<P extends CatalogProfileView>(
  profile: P,
  versions: readonly string[],
): P[] {
  const others = [...new Set(versions)].filter(
    (version) => version !== profile.runtime_version,
  );
  return [
    profile,
    ...others.map((version) => ({ ...profile, runtime_version: version })),
  ];
}

// The model `fingerprint` pins this profile to: the row's for version 2, the
// one a version 1 fingerprint was taken with. Undefined when the profile no
// longer hashes to it under any accepted runtime version.
function pinnedModel(
  profile: CatalogProfileView,
  pin: ProfilePin & { fingerprint: string },
  versions: readonly string[],
): string | null | undefined {
  for (const seen of underVersions(profile, versions)) {
    if (pin.fingerprint === profileFingerprint(seen)) return pin.model;
    const model = profileModels(seen).find((model) => {
      const runs = profileWithModel(seen, model);
      return runs !== null && profileFingerprintV1(runs) === pin.fingerprint;
    });
    if (model !== undefined) return model;
  }
  return undefined;
}

/**
 * Whether `fingerprint` still names this profile's settings, under either
 * version, whichever model it was taken with. What a release digest is held
 * to: it runs no model of its own.
 */
export function profilePinned(
  profile: CatalogProfileView,
  fingerprint: string,
  versions: readonly string[],
): boolean {
  return (
    pinnedModel(profile, { fingerprint, model: null }, versions) !== undefined
  );
}

/**
 * The profile a row pinned to `pin` runs, or null when none does (the model
 * was taken off the list, or the profile changed). A row from before the pin
 * runs the default model, which its first claim then pins.
 */
export function sessionProfile<P extends CatalogProfileView>(
  profile: P,
  pin: ProfilePin,
  versions: readonly string[],
): P | null {
  if (pin.fingerprint === null) return profileWithModel(profile);
  const model = pinnedModel(
    profile,
    { ...pin, fingerprint: pin.fingerprint },
    versions,
  );
  return model == null ? null : profileWithModel(profile, model);
}

/**
 * The model a row pinned to `fingerprint` under `profileId` runs, as far as
 * the fingerprint itself says: a version 1 one names it, a version 2 one
 * leaves it to the row. Null when it does not say or the catalog moved.
 */
export function fingerprintModel(
  catalog: ProfileLookup<CatalogProfileView>,
  profileId: string,
  fingerprint: string,
): string | null {
  const profile = catalogProfile(catalog, profileId);
  if (!profile) return null;
  return (
    sessionProfile(
      profile,
      { fingerprint, model: null },
      acceptedRuntimeVersions(catalog),
    )?.model ?? null
  );
}

/**
 * Every pin a row of this profile may hold, its default model first: the
 * version 2 fingerprint once per offered model, then each model's version 1
 * fingerprint, which names its model itself (`model` null: any row model);
 * then the same under each other accepted runtime version.
 */
export function profilePins(
  profile: CatalogProfileView,
  versions: readonly string[],
): Array<{ fingerprint: string; model: string | null }> {
  return underVersions(profile, versions).flatMap((seen) => {
    const models = profileModels(seen);
    const current = profileFingerprint(seen);
    return [
      ...models.map((model) => ({ fingerprint: current, model })),
      ...models.flatMap((model) => {
        const runs = profileWithModel(seen, model);
        return runs
          ? [{ fingerprint: profileFingerprintV1(runs), model: null }]
          : [];
      }),
    ];
  });
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

/** The pair a session may run as, or null when the catalog forbids it. */
export function allowedPair<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  profileId: string,
  repositoryId: string,
  source: GitHubPolicySource = "release",
): { profile: P; repository: R } | null {
  const profile = catalogProfile(catalog, profileId);
  const repository = Object.hasOwn(catalog.repositories, repositoryId)
    ? catalog.repositories[repositoryId]
    : undefined;
  if (
    !profile ||
    !repository ||
    (!usesWorkspaceCeiling(catalog, profileId, source) &&
      !profileAllowsRepository(catalog, profileId, repositoryId))
  ) {
    return null;
  }
  return { profile, repository };
}

/**
 * What a session may run as: `allowedPair` for one with a repository, and
 * for one without (`repositoryId` null) the profile alone, when its
 * repository mode lets a session go without one. Null when the catalog
 * forbids it.
 */
export function allowedRun<
  P extends CatalogProfileView,
  R extends CatalogRepositoryView,
>(
  catalog: ProfileLookup<P> & { repositories: Record<string, R> },
  profileId: string,
  repositoryId: string | null,
  source: GitHubPolicySource = "release",
): { profile: P; repository: R | null } | null {
  if (repositoryId !== null)
    return allowedPair(catalog, profileId, repositoryId, source);
  const profile = catalogProfile(catalog, profileId);
  return profile &&
    (usesWorkspaceCeiling(catalog, profileId, source) ||
      repositoryModeOf(profile) !== "required")
    ? { profile, repository: null }
    : null;
}

/**
 * Whether a session of the release that names no repository, as Slack's do,
 * can start: on the repository its policy starts on, with the agent's list
 * and the workspace's ceiling applied as `createSession` applies them.
 */
export function releaseStartable(
  catalog: SessionCatalogView,
  release: Pick<
    AgentRelease,
    "runtime_profile_id" | "repository_id" | "policy_pins"
  >,
  agentRow: AgentGitHubSettingsRow | null,
  repositoryCeiling: RepositoryCeiling | null,
): boolean {
  const profileId = release.runtime_profile_id;
  const policy = newSessionGitHubPolicy(agentRow, release.policy_pins.github);
  const repositoryId = startRepositoryOf(null, policy, release.repository_id);
  if (policy.source === "agent" && policy.settings === "invalid") return false;
  if (allowedRun(catalog, profileId, repositoryId, policy.source) === null) {
    return false;
  }
  if (repositoryId === null) return true;
  if (
    policy.source === "agent" &&
    policy.settings !== "invalid" &&
    !policy.settings?.repositories.includes(repositoryId)
  ) {
    return false;
  }
  return (
    !usesWorkspaceCeiling(catalog, profileId, policy.source) ||
    repositoryInCeiling(catalog, repositoryCeiling, repositoryId)
  );
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
  /** `path` is where the reference sits, e.g. `profiles.<id>.provider.auth`. */
  constructor(
    readonly path: string,
    readonly ref: CredentialRef,
    reason = "is not set",
  ) {
    super(`${path}.${describeCredentialRef(ref)} ${reason}`);
  }
}

/**
 * Every credential reference in the catalog, with where it sits. With
 * `connections` a provider credential is a connection's, never a profile's.
 */
export function catalogCredentialRefs(
  config: SessionCatalogConfig,
  connections?: Readonly<Record<string, CatalogProfileConfig["provider"]>>,
): Array<{ path: string; ref: CredentialRef }> {
  const refs: Array<{ path: string; ref: CredentialRef }> = [];
  const providers = connections
    ? Object.entries(connections).map(([id, provider]) => ({
        path: `connections.${id}.auth`,
        provider,
      }))
    : Object.entries(config.profiles).map(([id, profile]) => ({
        path: `profiles.${id}.provider.auth`,
        provider: profile.provider,
      }));
  for (const { path, provider } of providers) {
    const { kind: _kind, ...fields } = provider.auth;
    refs.push({ path, ref: credentialRefOf(fields) });
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
): SessionCatalogView {
  const profiles: Record<string, CatalogProfileView> = {};
  for (const [id, profile] of Object.entries(config.profiles)) {
    const { kind, ...refFields } = profile.provider.auth;
    const { billing, ...provider } = profile.provider;
    const { repository, ...settings } = profile;
    profiles[id] = {
      ...settings,
      provider: {
        ...provider,
        auth: { kind, ref: credentialRefOf(refFields) },
        ...(billing === "none" ? { billing } : {}),
      },
      ...(repository === undefined || repository === "required"
        ? {}
        : { repository }),
    } as CatalogProfileView;
  }
  const repositories: Record<string, CatalogRepositoryView> = {};
  for (const [id, repository] of Object.entries(config.repositories)) {
    repositories[id] = repositoryView(repository);
  }
  return { profiles, repositories };
}

/** The repository without its credentials, keeping the console App's mark. */
export function repositoryView(
  repository: Omit<CatalogRepositoryConfig, "auth"> & {
    auth?: CatalogRepositoryConfig["auth"] | RepositoryCredential;
  },
): CatalogRepositoryView {
  const { auth, ...rest } = repository;
  return auth !== undefined && "registered" in auth
    ? { ...rest, github_app: true }
    : rest;
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
): SessionCatalog {
  const resolved = (path: string, ref: CredentialRef): string =>
    resolveCredential(path, ref, lookup);
  const profiles: Record<string, CatalogProfile> = {};
  for (const [id, profile] of Object.entries(
    sessionCatalogView(config).profiles,
  )) {
    const { auth } = profile.provider;
    const value = resolved(`profiles.${id}.provider.auth`, auth.ref);
    profiles[id] = {
      ...profile,
      provider: { ...profile.provider, auth: { ...auth, value } },
    } as CatalogProfile;
  }
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
  if (config.mcp_servers === undefined) return { profiles, repositories };
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
  return { profiles, repositories, mcp_servers };
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
