/**
 * Prints the first owner's session cookie (bootstrapping the owner from the
 * stack's setup link when it has none) for a stack's seed step,
 * scripts/lib/seed-credentials.sh.
 *
 *   E2E_API_URL=... E2E_OWNER_SECRET=... [E2E_SETUP_TOKEN=...] bun tests/e2e/owner-cookie.ts
 */
import { e2eOwnerCookie } from "./client.ts";

const apiUrl = process.env.E2E_API_URL;
if (!apiUrl) throw new Error("E2E_API_URL is required");
process.stdout.write(await e2eOwnerCookie(apiUrl));
