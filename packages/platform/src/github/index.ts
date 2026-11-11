// The entrance other platform domains import (A2 in package-structure.md):
// only the names sessions/ and workers/ use, not a barrel over the directory.
export { allowedOwners, isGitHubNpmTarball } from "./egress/github-packages.ts";
export { createGitHubPackagesEgress } from "./egress/github-packages-egress.ts";
export {
  createGitHubConnectionResolver,
  type GitHubConnectionResolver,
} from "./service/github-connection-resolver.ts";
