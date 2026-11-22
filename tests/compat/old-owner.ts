/**
 * Makes the first owner of a release from before setup links, the way its
 * console did: POST /v1/auth/bootstrap with the BOOTSTRAP_TOKEN its API was
 * handed. The password is the one tests/e2e/client.ts derives, so every
 * stage after it logs in. An owner already made answers 409.
 *
 *   E2E_API_URL=... E2E_OWNER_SECRET=... bun tests/compat/old-owner.ts
 */
import { e2eOwnerBody } from "../e2e/client.ts";

const apiUrl = process.env.E2E_API_URL;
const ownerSecret = process.env.E2E_OWNER_SECRET;
if (!apiUrl || !ownerSecret) {
  throw new Error("E2E_API_URL and E2E_OWNER_SECRET are required");
}
const booted = await fetch(`${apiUrl}/v1/auth/bootstrap`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-requested-with": "werft-web",
  },
  body: JSON.stringify({
    bootstrap_token: ownerSecret,
    ...e2eOwnerBody(ownerSecret),
  }),
});
if (booted.status !== 201 && booted.status !== 409) {
  throw new Error(`the old bootstrap answered ${booted.status}`);
}
