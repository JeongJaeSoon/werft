/**
 * The kind checks' agent (smoke.sh, upgrade.sh, replicas.sh through
 * release-key.sh): the first owner (bootstrapped from the cluster's
 * setup link) releases an agent on the installation's connection and
 * the sample repository, and issues a personal key, since every session
 * runs an agent release and only a workspace key names one, plus a second
 * key of the same owner that answers requests (a key never answers a session
 * it started: `self_approval`). Made once per
 * cluster: a later run finds the agent and reuses its active release.
 * Prints shell assignments.
 *
 *   KIND_API_URL=... E2E_OWNER_SECRET=... [E2E_SETUP_TOKEN=...] bun deploy/kind/release.ts
 */
import { e2eStack } from "../../tests/e2e/client.ts";

const apiUrl = process.env.KIND_API_URL;
if (!apiUrl) throw new Error("KIND_API_URL is required");
process.env.E2E_API_URL = apiUrl;
// e2eStack signs in as the first owner (E2E_OWNER_SECRET, E2E_SETUP_TOKEN); the key
// it returns replaces this.
process.env.E2E_API_KEY = "unused";
const stack = await e2eStack({ needsMessages: false });
console.log(`KIND_RELEASE_ID=${stack.releaseId}`);
console.log(`KIND_API_KEY=${stack.apiKey}`);
console.log(`KIND_APPROVE_KEY=${stack.approveKey}`);
