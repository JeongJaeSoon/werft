// The only place product code reaches the GitHub forge adapter (R3). Roles
// import the factories from here and receive the built services as arguments.
export {
  connectionsOf,
  createAppBotUsers,
  createGitHubAppDirectory,
  createGitHubManifestConverter,
  createGitPusher,
  createRegisteredGitHubConnections,
} from "@werft-ai/forge-github";
