# Sourced: the seed document packages/testkit/src/seed-credentials-main.ts
# reads on stdin, for a stack whose imported settings hold `"stored": true`
# rows. Each argument is `connections:<id>=<VAR>` or `repositories:<id>`
# (the fake GitHub App's key, read in the container). A value is read from
# the variable named, so it is in no argument and, with xtrace switched off
# here, in no trace.
seed_document() {
  local restore="" arg section id var value conn="" repos=""
  case $- in *x*) restore=1; set +x ;; esac
  for arg in "$@"; do
    section="${arg%%:*}"
    id="${arg#*:}"
    if [ "$section" = repositories ]; then
      repos+="${repos:+,}\"${id}\""
      continue
    fi
    var="${id#*=}"
    id="${id%%=*}"
    value="${!var:-}"
    value="${value//\\/\\\\}"
    value="${value//\"/\\\"}"
    case "$section" in
      connections) conn+="${conn:+,}\"${id}\":\"${value}\"" ;;
      *) echo "seed_document: unknown section in ${arg%%=*}" >&2; return 2 ;;
    esac
  done
  printf '{"connections":{%s},"repositories":[%s]}\n' "$conn" "$repos"
  [ -z "$restore" ] || set -x
}

# seed_credentials COOKIE_FN SPEC... -- COMMAND...: pipes the seed document
# to COMMAND with SEED_COOKIE, the owner's session cookie COOKIE_FN prints,
# exported to it alone. COMMAND passes it on by name, e.g.
# `docker compose exec -T -e SEED_COOKIE fake-git bun run
# packages/testkit/src/seed-credentials-main.ts`. The cookie, like the values,
# stays out of every argument and trace.
seed_credentials() {
  local restore="" status=0 cookie_fn="$1" specs=() SEED_COOKIE=""
  case $- in *x*) restore=1; set +x ;; esac
  shift
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    specs+=("$1")
    shift
  done
  [ "$#" -gt 0 ] && shift
  SEED_COOKIE="$("$cookie_fn")" || status=$?
  if [ "$status" = 0 ] && [ -z "$SEED_COOKIE" ]; then
    echo "seed_credentials: ${cookie_fn} printed no session cookie" >&2
    status=1
  fi
  if [ "$status" = 0 ]; then
    seed_document ${specs[@]+"${specs[@]}"} | (export SEED_COOKIE; "$@") || status=$?
  fi
  [ -z "$restore" ] || set -x
  return "$status"
}
