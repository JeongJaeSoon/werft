#!/usr/bin/env bash
# up.sh with a real Keycloak as a login provider (infra/compose.keycloak.yml):
# sign-in through a server this repository did not write, in a browser.
# Prints what up.sh prints (run directory on stdout, run id on stderr), once
# Keycloak answers on the issuer. When Keycloak never answers it still prints
# the run directory, exits 1 and leaves the stack up; when up.sh fails, up.sh
# has torn its run down and nothing is printed.
#
#   keycloak-up.sh [more overlays…]
#
# The provider sends the browser back to CONSOLE_ORIGIN, and the realm's
# redirect URIs are built on it, so the console's port is chosen here, before
# anything starts. The realm's client secret and its users' password are
# random values of this run; they live in the run's state and are typed by
# `browser.mjs … type-state`, never printed.
set -euo pipefail

# Two free loopback ports, held together so they differ. Another process can
# still take one before compose binds it; up.sh then fails and tears down.
read -r console keycloak < <(node -e '
const net = require("node:net");
const held = [net.createServer(), net.createServer()];
let listening = 0;
for (const server of held)
  server.listen(0, "127.0.0.1", () => {
    if (++listening < held.length) return;
    console.log(held.map((one) => one.address().port).join(" "));
    for (const one of held) one.close();
  });')

export VERIFY_CONSOLE_PORT=$console
export KEYCLOAK_PORT=$keycloak
export CONSOLE_ORIGIN=http://127.0.0.1:$console
KEYCLOAK_WERFT_CLIENT_SECRET=$(openssl rand -hex 16)
KEYCLOAK_WERFT_USER_PASSWORD=$(openssl rand -hex 12)
export KEYCLOAK_WERFT_CLIENT_SECRET KEYCLOAK_WERFT_USER_PASSWORD
export VERIFY_STATE_VARS="KEYCLOAK_PORT CONSOLE_ORIGIN KEYCLOAK_WERFT_CLIENT_SECRET KEYCLOAK_WERFT_USER_PASSWORD"

run=$("$(dirname "$0")/up.sh" infra/compose.keycloak.yml "$@")

# The API is ready before Keycloak has imported the realm.
issuer=http://localhost:$keycloak/realms/werft
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "$issuer/.well-known/openid-configuration" 2>/dev/null; then
    echo "keycloak: issuer $issuer, console $CONSOLE_ORIGIN" >&2
    echo "$run"
    exit 0
  fi
  sleep 2
done
echo "keycloak-up.sh: no discovery document at $issuer after 180 s; see \`ap_compose logs keycloak\`, then down.sh $(basename "$run")" >&2
# The stack is still up, so a caller can collect its logs and tear it down.
echo "$run"
exit 1
