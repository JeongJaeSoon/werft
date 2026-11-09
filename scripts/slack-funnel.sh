#!/usr/bin/env bash
# Opens only Slack's paths of a local API to the internet through Tailscale
# Funnel, so Slack can reach POST /v1/slack/events/<agent_id> and
# POST /v1/slack/interactions/<agent_id> (buttons and modals).
# Funnel is switched on per port, not per path: anything else served on
# that port (e.g. a `tailscale serve` of the console) goes public too, so
# give the console another port.
#
#   on      https://<host>.ts.net[:<https>]/v1/slack/<path> → http://127.0.0.1:$PORT/v1/slack/<path>
#           for events and interactions, then warns if <host>.ts.net does not
#           resolve in public DNS yet
#   off     removes those mappings (the same --https and --set-path as on)
#   status  tailscale funnel status
#
# Set SLACK_EVENTS_PUBLIC_URL=https://<host>.ts.net[:<https>] on the API (this
# entrance is apart from the console, so CONSOLE_ORIGIN cannot stand for it)
# afterwards, then run Finalize (an install, or `slack-app finalize`).
#
# Usage: PORT=<api port> scripts/slack-funnel.sh on
#        scripts/slack-funnel.sh off|status
# SLACK_FUNNEL_HTTPS_PORT picks the public port: 443 (default), 8443 or 10000,
# the ports Funnel serves.
set -euo pipefail

SLACK_PATHS=(/v1/slack/events /v1/slack/interactions)
HTTPS_PORT="${SLACK_FUNNEL_HTTPS_PORT:-443}"

usage() {
  sed -n '/^# Usage:/,/^# the ports/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# A Funnel name can take a while to appear in public DNS. Until it does,
# Slack cannot reach the Request URL, so warn before an app is created.
# Warns only; never fails the command.
public_dns_check() {
  local name=$1 resolver answer failed=""
  for resolver in https://dns.google/resolve https://cloudflare-dns.com/dns-query; do
    answer=$(curl -fsS --max-time 5 -H 'accept: application/dns-json' \
      "$resolver?name=$name&type=A" 2>/dev/null || true)
    if [[ "$answer" =~ \"Status\":[[:space:]]*0[,}] ]]; then
      [[ "$answer" == *'"Answer"'* ]] ||
        failed+=" ${resolver#https://}: no address;"
    elif [[ "$answer" =~ \"Status\":[[:space:]]*3[,}] ]]; then
      failed+=" ${resolver#https://}: NXDOMAIN;"
    else
      failed+=" ${resolver#https://}: no answer;"
    fi
  done
  if [[ -z "$failed" ]]; then
    echo "slack-funnel: $name resolves in public DNS (dns.google, cloudflare-dns.com)"
  else
    failed=${failed# }
    echo "slack-funnel: warning: $name does not resolve in public DNS yet (${failed%;}). Slack cannot reach the Request URL until it does; wait before creating the Slack app." >&2
  fi
}

[[ $# -eq 1 ]] || usage
case "$HTTPS_PORT" in
  443 | 8443 | 10000) ;;
  *)
    echo "slack-funnel: SLACK_FUNNEL_HTTPS_PORT must be 443, 8443 or 10000" >&2
    exit 2
    ;;
esac
command -v tailscale >/dev/null || {
  echo "slack-funnel: tailscale is not on PATH" >&2
  exit 1
}

case "$1" in
  on)
    if [[ ! "${PORT:-}" =~ ^[0-9]{1,5}$ ]] || ((PORT < 1 || PORT > 65535)); then
      echo "slack-funnel: set PORT to the API's local port" >&2
      exit 2
    fi
    for path in "${SLACK_PATHS[@]}"; do
      tailscale funnel --bg "--https=$HTTPS_PORT" "--set-path=$path" \
        "http://127.0.0.1:$PORT$path"
    done
    tailscale funnel status
    # Without peers, the only DNSName in the answer is this machine's.
    name=$(tailscale status --json --peers=false |
      sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -n 1 || true)
    if [[ -n "$name" ]]; then
      public_dns_check "$name"
    else
      echo "slack-funnel: warning: could not read this machine's Tailscale name to check public DNS" >&2
    fi
    ;;
  off)
    for path in "${SLACK_PATHS[@]}"; do
      tailscale funnel "--https=$HTTPS_PORT" "--set-path=$path" off
    done
    tailscale funnel status
    ;;
  status)
    tailscale funnel status
    ;;
  *) usage ;;
esac
