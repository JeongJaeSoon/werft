#!/usr/bin/env node
// Judges what Keycloak's token endpoint answered to a wrong PKCE verifier
// (keycloak-pkce.sh); the rule is pkce-refusal.mjs.
//
//   pkce-verdict.mjs <http status> <file with the response body>
//
// Prints one line and exits 0 only for the PKCE refusal. This file is the
// command and nothing imports it, so it judges however it was reached: a
// file that decided by its own path whether it was run would, through a
// symlink, print nothing and exit 0.
import { readFileSync } from "node:fs";
import { pkceVerdict } from "./pkce-refusal.mjs";

const [status, file] = process.argv.slice(2);
if (!status || !file) {
  console.error("usage: pkce-verdict.mjs <http status> <response body file>");
  process.exit(2);
}
const verdict = pkceVerdict(Number(status), readFileSync(file, "utf8"));
console.log(verdict.line);
process.exit(verdict.refused ? 0 : 1);
