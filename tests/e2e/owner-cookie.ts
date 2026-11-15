/**
 * Prints the first owner's session cookie (bootstrapping the owner when the
 * stack has none) for a stack's seed step, scripts/lib/seed-credentials.sh.
 *
 *   E2E_API_URL=... E2E_BOOTSTRAP_TOKEN=... bun tests/e2e/owner-cookie.ts
 */
import { firstOwnerCookie } from "./client.ts";

const apiUrl = process.env.E2E_API_URL;
const token = process.env.E2E_BOOTSTRAP_TOKEN;
if (!apiUrl || !token) {
  throw new Error("E2E_API_URL and E2E_BOOTSTRAP_TOKEN are required");
}
process.stdout.write(await firstOwnerCookie(apiUrl, token));
