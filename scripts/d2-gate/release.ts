/**
 * The gate's agent, run by scripts/d2-gate/run.sh once the api is up: the
 * first owner (bootstrapped with BOOTSTRAP_TOKEN) releases an agent on the
 * gate-messages connection and issues a personal key, since every session
 * runs an agent release and only a workspace key names one. Prints the
 * variables the gate reads, as shell assignments.
 *
 *   D2_GATE_API_URL=... BOOTSTRAP_TOKEN=... bun scripts/d2-gate/release.ts
 */
import { e2eStack } from "../../tests/e2e/client.ts";

const apiUrl = process.env.D2_GATE_API_URL;
const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
if (!apiUrl || !bootstrapToken) {
  throw new Error("D2_GATE_API_URL and BOOTSTRAP_TOKEN are required");
}
process.env.E2E_API_URL = apiUrl;
// e2eStack signs in with the bootstrap token; the key it returns replaces this.
process.env.E2E_API_KEY = "unused";
process.env.E2E_BOOTSTRAP_TOKEN = bootstrapToken;
const stack = await e2eStack({
  needsMessages: false,
  connectionId: "gate-messages",
  repositoryId: "gate-app",
});
console.log(`D2_GATE_RELEASE_ID=${stack.releaseId}`);
console.log(`D2_GATE_API_KEY=${stack.apiKey}`);
// The owner's second key answers requests: a key never answers a session it
// started (`self_approval`).
console.log(`D2_GATE_APPROVE_KEY=${stack.approveKey}`);
