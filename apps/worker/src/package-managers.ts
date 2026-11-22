import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Where npm, Bundler and Go look for their user configuration under the
 * engine's HOME. Only these are written: a repository's own files are the
 * session's work, and changing them would show up in its diff.
 */
export const PACKAGE_MANAGER_FILES = {
  npm: ".npmrc",
  bundler: ".bundle/config",
  go: ".config/go/env",
} as const;

// Bundler takes the token from a URL's userinfo and sends it as Basic; the
// proxy reads the password and ignores this name. Go refuses userinfo on an
// http URL, so its token rides in the path instead.
const BASIC_USER = "werft";

/** GitHub Packages owners per registry, lowercase, as the claim names them. */
export type GitHubOwners = { npm: string[]; rubygems: string[] };

// Bundler's own spelling of a setting's name in its config file. It reads
// the name back lowercased, so a Gemfile source must name the owner in
// lowercase to meet its mirror.
function bundlerKey(setting: string): string {
  return `BUNDLE_${setting.replaceAll(".", "__").replaceAll("-", "___").toUpperCase()}`;
}

/**
 * The user-level configuration that points npm, Bundler and Go at the egress
 * proxy's packages route, keyed by the file under HOME. Go gets no `direct`
 * fallback and its checksum database through the route as well, so nothing
 * leaves for a VCS host or sum.golang.org on its own; `-mod=readonly` keeps a
 * build from rewriting go.mod to versions the lockfile does not name.
 */
export function packageManagerFiles(
  credentialUrl: string,
  token: string,
  github: GitHubOwners = { npm: [], rubygems: [] },
  privateModules: readonly string[] = [],
): Record<keyof typeof PACKAGE_MANAGER_FILES, string> {
  const route = new URL(credentialUrl);
  const base = `${route.protocol}//${route.host}/packages`;
  const authed = `${route.protocol}//${BASIC_USER}:${encodeURIComponent(token)}@${route.host}/packages`;
  const npmGitHub =
    github.npm.length === 0
      ? []
      : [
          // npm resolves a tarball's location against the default registry,
          // so GitHub's `/download/@owner/...` reaches the npm route, where
          // the authorizer hands it to GitHub Packages.
          "replace-registry-host=always",
          ...github.npm.map(
            (owner) => `@${owner}:registry=${base}/github-npm/`,
          ),
          `//${route.host}/packages/github-npm/:_authToken=${token}`,
        ];
  return {
    npm: [
      `registry=${base}/npm/`,
      `//${route.host}/packages/npm/:_authToken=${token}`,
      ...npmGitHub,
      "",
    ].join("\n"),
    bundler: [
      "---",
      `BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG/: "${authed}/rubygems"`,
      ...github.rubygems.map(
        (owner) =>
          `${bundlerKey(`mirror.https://rubygems.pkg.github.com/${owner}/`)}: "${authed}/github-rubygems/${owner}"`,
      ),
      "",
    ].join("\n"),
    go: [
      `GOPROXY=${base}/go/_token/${encodeURIComponent(token)}`,
      `GOSUMDB=sum.golang.org ${base}/gosum/_token/${encodeURIComponent(token)}`,
      "GOFLAGS=-mod=readonly",
      // The session's own repositories, through the repository route with
      // git (repository-routes.ts); GOPRIVATE also keeps them off the
      // checksum database.
      ...(privateModules.length === 0
        ? []
        : [`GOPRIVATE=${privateModules.join(",")}`]),
      "",
    ].join("\n"),
  };
}

/** Writes this claim's package manager configuration under HOME. */
export async function writePackageManagerConfig(
  home: string,
  credentialUrl: string,
  token: string,
  github?: GitHubOwners,
  privateModules: readonly string[] = [],
): Promise<void> {
  const contents = packageManagerFiles(
    credentialUrl,
    token,
    github,
    privateModules,
  );
  for (const [manager, relative] of Object.entries(PACKAGE_MANAGER_FILES)) {
    const path = join(home, relative);
    const content = contents[manager as keyof typeof PACKAGE_MANAGER_FILES];
    await mkdir(dirname(path), { recursive: true });
    const staged = `${path}.${process.pid}.tmp`;
    // The token is attempt-scoped, but still nobody else's to read.
    await writeFile(staged, content, { mode: 0o600 });
    await rename(staged, path);
  }
}
