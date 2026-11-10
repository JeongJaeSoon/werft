/**
 * The kind checks' agent (smoke.sh, upgrade.sh, replicas.sh through
 * release-key.sh): the first owner (bootstrapped with the cluster's
 * BOOTSTRAP_TOKEN) releases an agent on the installation's connection and
 * the sample repository, and issues a personal key, since every session
 * runs an agent release and only a workspace key names one. Made once per
 * cluster: a later run finds the agent and reuses its active release.
 * Prints shell assignments.
 *
 *   KIND_API_URL=... BOOTSTRAP_TOKEN=... bun deploy/kind/release.ts
 */
import { e2eStack } from "../../tests/e2e/client.ts";

const apiUrl = process.env.KIND_API_URL;
const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
if (!apiUrl || !bootstrapToken) {
  throw new Error("KIND_API_URL and BOOTSTRAP_TOKEN are required");
}
process.env.E2E_API_URL = apiUrl;
// e2eStack signs in with the bootstrap token; the key it returns replaces this.
process.env.E2E_API_KEY = "unused";
process.env.E2E_BOOTSTRAP_TOKEN = bootstrapToken;
const stack = await e2eStack({ needsMessages: false });
console.log(`KIND_RELEASE_ID=${stack.releaseId}`);
console.log(`KIND_API_KEY=${stack.apiKey}`);
