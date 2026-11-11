import type {
  GitHubPackagesAllowEntry,
  GitHubPackagesRegistry,
} from "@werft-ai/contracts";

/**
 * What one GitHub Packages request reads, from its path alone. `name` is
 * null for an owner's whole index (RubyGems' `versions` and `specs` files,
 * which list every gem of the owner); `file` is a gem file or gemspec whose
 * name and version only an allowlist entry can split, since both may hold
 * dashes.
 */
export type GitHubPackageRead =
  | {
      registry: GitHubPackagesRegistry;
      owner: string;
      kind: "package";
      name: string;
      version: string | null;
    }
  | { registry: "rubygems"; owner: string; kind: "index" }
  | { registry: "rubygems"; owner: string; kind: "gem_file"; file: string }
  | { registry: "rubygems"; owner: string; kind: "gems"; names: string[] };

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
const NPM_NAME = "[a-z0-9][a-z0-9._-]{0,213}";
const VERSION = "[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}";

// The metadata document, with the scope's slash encoded or not.
const NPM_METADATA = new RegExp(`^/@(${OWNER})(?:%2[fF]|/)(${NPM_NAME})$`);
// GitHub's own tarball location, `/download/@owner/name/version/digest`.
const NPM_GITHUB_TARBALL = new RegExp(
  `^/download/@(${OWNER})/(${NPM_NAME})/(${VERSION})/[0-9a-f]{6,128}$`,
);
// The location the public registry's layout would give the same tarball.
const NPM_TARBALL = new RegExp(
  `^/@(${OWNER})/(${NPM_NAME})/-/([^/]{1,300})\\.tgz$`,
);
const VERSION_ONLY = new RegExp(`^${VERSION}$`);

const GEM_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,213}";
const GEM_INDEX = new RegExp(
  `^/(${OWNER})/(?:versions|(?:latest_|prerelease_)?specs\\.4\\.8\\.gz)$`,
);
const GEM_INFO = new RegExp(`^/(${OWNER})/info/(${GEM_NAME})$`);
const GEM_FILE = new RegExp(
  `^/(${OWNER})/(?:gems/(${GEM_NAME})\\.gem|quick/Marshal\\.4\\.8/(${GEM_NAME})\\.gemspec\\.rz)$`,
);
const GEM_DEPENDENCIES = new RegExp(`^/(${OWNER})/api/v1/dependencies$`);
// What follows `<name>-` in a gem file: a release version (no dash) and an
// optional platform whose segments start with a letter. Anything looser lets
// `foo-2fa-1.0.0.gem`, gem `foo-2fa`, pass as a version of `foo`.
const GEM_VERSION_AND_PLATFORM =
  /^[0-9]+(?:\.[0-9A-Za-z]+)*(?:-[A-Za-z][A-Za-z0-9_.]*)*$/;

/**
 * The GitHub tarball path npm sends to the public npm route. With
 * `replace-registry-host=always`, npm 11 resolves a tarball location against
 * the default registry, not the scope's, so GitHub's
 * `/download/@owner/...` arrives on `npm`. The public registry has no such
 * path, which is what makes it safe to take for GitHub's.
 */
export function isGitHubNpmTarball(path: string): boolean {
  return NPM_GITHUB_TARBALL.test(path);
}

/** What `path` (with its query) reads, or null for any path not listed here. */
export function githubPackageReadOf(
  registry: GitHubPackagesRegistry,
  pathWithQuery: string,
): GitHubPackageRead | null {
  const at = pathWithQuery.indexOf("?");
  const path = at === -1 ? pathWithQuery : pathWithQuery.slice(0, at);
  const query = at === -1 ? "" : pathWithQuery.slice(at + 1);
  if (registry === "npm") {
    if (query !== "") return null;
    const metadata = NPM_METADATA.exec(path);
    if (metadata !== null) {
      return package_("npm", metadata[1], metadata[2], null);
    }
    const github = NPM_GITHUB_TARBALL.exec(path);
    if (github !== null) {
      return package_("npm", github[1], github[2], github[3]);
    }
    const tarball = NPM_TARBALL.exec(path);
    const name = tarball?.[2] ?? "";
    const version = tarball?.[3]?.startsWith(`${name}-`)
      ? tarball[3].slice(name.length + 1)
      : null;
    if (tarball !== null && version !== null && VERSION_ONLY.test(version)) {
      return package_("npm", tarball[1], name, version);
    }
    return null;
  }
  const dependencies = GEM_DEPENDENCIES.exec(path);
  if (dependencies !== null) {
    const params = new URLSearchParams(query);
    const all = params.getAll("gems");
    const gems = all[0];
    // One `gems` only: the upstream may read a repeated key's last value.
    if ([...params.keys()].some((key) => key !== "gems") || all.length !== 1) {
      return null;
    }
    if (!gems) return null;
    const names = gems.split(",");
    return names.every((name) => new RegExp(`^${GEM_NAME}$`).test(name))
      ? { registry, owner: dependencies[1] ?? "", kind: "gems", names }
      : null;
  }
  if (query !== "") return null;
  const index = GEM_INDEX.exec(path);
  if (index !== null) return { registry, owner: index[1] ?? "", kind: "index" };
  const info = GEM_INFO.exec(path);
  if (info !== null) return package_("rubygems", info[1], info[2], null);
  const file = GEM_FILE.exec(path);
  if (file !== null) {
    return {
      registry,
      owner: file[1] ?? "",
      kind: "gem_file",
      file: file[2] ?? file[3] ?? "",
    };
  }
  return null;
}

function package_(
  registry: GitHubPackagesRegistry,
  owner: string | undefined,
  name: string | undefined,
  version: string | null | undefined,
): GitHubPackageRead {
  return {
    registry,
    owner: owner ?? "",
    kind: "package",
    name: name ?? "",
    version: version ?? null,
  };
}

/** Who is asking: an entry naming another repository or agent does not apply. */
export type GitHubPackagesAsker = {
  repositoryId: string | null;
  agentId: string | null;
};

export function entriesFor(
  allowlist: readonly GitHubPackagesAllowEntry[],
  asker: GitHubPackagesAsker,
): GitHubPackagesAllowEntry[] {
  return allowlist.filter(
    (entry) =>
      (entry.repository_id === null ||
        entry.repository_id === asker.repositoryId) &&
      (entry.agent_id === null || entry.agent_id === asker.agentId),
  );
}

/**
 * The package and version a read is recorded under when one of `entries`
 * allows it, or null when none does. GitHub owners are case-insensitive;
 * names are compared as npm and RubyGems compare them.
 */
export function allowedRead(
  read: GitHubPackageRead,
  entries: readonly GitHubPackagesAllowEntry[],
): { name: string | null; version: string | null } | null {
  const owners = entries.filter(
    (entry) =>
      entry.registry === read.registry &&
      entry.owner.toLowerCase() === read.owner.toLowerCase(),
  );
  const allows = (name: string) =>
    owners.some((entry) => entry.name === "*" || entry.name === name);
  switch (read.kind) {
    case "index":
      return owners.length > 0 ? { name: null, version: null } : null;
    case "package":
      return allows(read.name)
        ? { name: read.name, version: read.version }
        : null;
    case "gems":
      return read.names.every(allows)
        ? { name: read.names.join(","), version: null }
        : null;
    case "gem_file": {
      for (const entry of owners) {
        if (entry.name === "*") return { name: read.file, version: null };
        const rest = read.file.startsWith(`${entry.name}-`)
          ? read.file.slice(entry.name.length + 1)
          : null;
        if (rest !== null && GEM_VERSION_AND_PLATFORM.test(rest)) {
          return { name: entry.name, version: rest };
        }
      }
      return null;
    }
  }
}

/** The owners per registry the allowlist names, for the worker's configuration. */
export function allowedOwners(
  entries: readonly GitHubPackagesAllowEntry[],
): Record<GitHubPackagesRegistry, string[]> {
  const of = (registry: GitHubPackagesRegistry) => [
    ...new Set(
      entries
        .filter((entry) => entry.registry === registry)
        .map((entry) => entry.owner.toLowerCase()),
    ),
  ];
  return { npm: of("npm"), rubygems: of("rubygems") };
}
