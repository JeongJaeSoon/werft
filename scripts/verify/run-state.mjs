// The run's state file as the .mjs helpers read it. lib.sh and down.sh source
// the same file in a shell; a line both readers agree on is `NAME=value` or
// `export NAME=value` with a value that needs no shell quoting, which is all
// up.sh writes.
export function parseRunState(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .map((line) =>
        line.replace(/^export /, "").match(/^([A-Z_][A-Z0-9_]*)=(.*)$/),
      )
      .filter(Boolean)
      .map(([, name, value]) => [name, value.replace(/^"(.*)"$/, "$1")]),
  );
}
