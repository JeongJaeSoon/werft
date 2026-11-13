#!/usr/bin/env node
// Judges what Keycloak's token endpoint answered to a wrong PKCE verifier
// (keycloak-pkce.sh). A 400 alone proves nothing: a spent or expired code, a
// redirect URI that does not match and a failed client authentication are
// refused too. Only Keycloak's own PKCE refusal counts, and no token in the
// body. The description is the text of the Keycloak the overlay pins
// (infra/compose.keycloak.yml); a new image that words it differently fails
// here and is then read by a person.
//
//   pkce-verdict.mjs <http status> <file with the response body>
//
// Prints one line (the error, its description, the names of any tokens,
// never their values) and exits 0 only for the PKCE refusal.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TOKENS = ["id_token", "access_token", "refresh_token"];

export function pkceVerdict(status, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      refused: false,
      line: `${status} (the body is not a JSON object)`,
    };
  }
  const tokens = TOKENS.filter((name) => name in body);
  return {
    refused:
      status === 400 &&
      body.error === "invalid_grant" &&
      body.error_description === "PKCE verification failed: Code mismatch" &&
      tokens.length === 0,
    line: `${status} ${body.error} | ${body.error_description} | tokens: ${tokens.join(",") || "none"}`,
  };
}

// Run as a command, by whatever path: node keeps the path as it was typed
// and import.meta.url is the real one, so a checkout reached through a
// symlink would otherwise import this file, judge nothing and exit 0.
const command = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (command) {
  const [status, file] = process.argv.slice(2);
  const verdict = pkceVerdict(Number(status), readFileSync(file, "utf8"));
  console.log(verdict.line);
  process.exit(verdict.refused ? 0 : 1);
}
