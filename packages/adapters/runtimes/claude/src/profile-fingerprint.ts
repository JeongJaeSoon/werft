import { canonicalJsonOfJson } from "@werft-ai/contracts";
import { sha256Hex } from "@werft-ai/runtime-claude-codec";
import { describeComponents } from "./component-identity.ts";
import type { ClaudeRuntimeConfig } from "./config.ts";
import { publicProfile } from "./profile.ts";

/**
 * Which way `claudeProfileFingerprint` hashes. Bump it with any change that
 * moves a digest for the same configuration: an image with the same engine
 * build but another scheme cannot resume a checkpoint this one sealed, and
 * the scheduler tells the two apart only by this number. The golden test
 * fails a digest change that keeps it.
 */
export const CLAUDE_PROFILE_DIGEST_SCHEME = 2;

/**
 * The schemes whose checkpoints an image of this build can resume: its own,
 * and the earlier ones it can still compute for the candidates of a restore
 * (`claudeProfileFingerprint(config, scheme)`). Scheme 2 left the permission
 * mode out of the digest; scheme 1 put it in.
 */
export const CLAUDE_RESTORABLE_SCHEMES: readonly number[] = [1, 2];

/**
 * Digest of everything about a run's configuration that changes how a stored
 * transcript replays, plus who the run acts for. The model credential is
 * excluded — `publicProfile` drops it — so rotating a key does not invalidate
 * a checkpoint, while pointing the run at a different endpoint, tool
 * allowlist or owner partition does. The principal is what keeps two tenants
 * on one shared endpoint from producing the same digest and resuming each
 * other's sessions.
 *
 * MCP servers and plugins go through `describeComponents`: a serializable
 * server is hashed as its configuration with credential containers reduced to
 * key names, and anything the fingerprint cannot hash by value — an
 * in-process server, a plugin's contents — is hashed as the identity its
 * caller declared. A component without one throws
 * `UnidentifiedComponentError`; run validation calls this first so such a
 * config is refused before it starts rather than at its first checkpoint.
 *
 * It stays in this package, not in the SDK-free codec package, because it
 * reads the run's configuration; the control plane only compares digests.
 *
 * Scheme 2 (the default) leaves `permissionMode` out: the permission rules a
 * run is held to change with the workspace's policy at every claim and do not
 * change how a stored transcript replays. Scheme 1 keeps it, to compute the
 * digest an older image stamped a checkpoint with.
 */
export function claudeProfileFingerprint(
  config: Pick<
    ClaudeRuntimeConfig,
    | "appendSystemPrompt"
    | "identities"
    | "mcpServers"
    | "model"
    | "permissionMode"
    | "plugins"
    | "profile"
    | "repositoryClaudeMd"
    | "settingSources"
    | "tools"
  > & {
    /**
     * Where a plugin under it is read from. A plugin below `home` is hashed by
     * its path relative to it, so two images that mount the same bundle under
     * another HOME still resume each other's checkpoints.
     */
    home?: string;
  },
  scheme: number = CLAUDE_PROFILE_DIGEST_SCHEME,
): string {
  if (!CLAUDE_RESTORABLE_SCHEMES.includes(scheme)) {
    throw new Error(`No profile digest is defined for scheme ${scheme}`);
  }
  const components = describeComponents(config);
  const plugins = components.plugins.map((plugin) => ({
    ...plugin,
    path: relativeTo(config.home, plugin.path),
  }));
  return sha256Hex(
    canonicalJsonOfJson({
      appendSystemPrompt: config.appendSystemPrompt ?? null,
      mcpServers: components.mcpServers,
      model: config.model,
      ...(scheme === 1
        ? { permissionMode: config.permissionMode ?? "default" }
        : {}),
      plugins,
      profile: publicProfile(config.profile),
      // Only when on, so a run that never let CLAUDE.md in keeps the
      // digest its checkpoints were taken under before this switch existed.
      ...(config.repositoryClaudeMd === undefined
        ? {}
        : { repositoryClaudeMd: true }),
      settingSources: config.settingSources ?? ["project"],
      tools: [...config.tools].sort(),
    }),
  );
}

function relativeTo(home: string | undefined, path: string): string {
  if (home === undefined || home === "") return path;
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
