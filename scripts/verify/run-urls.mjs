#!/usr/bin/env node
// The run's non-secret addresses, for agents and browser.mjs: reads the host
// ports of the run's project from `docker compose ps`, writes them to
// <run>/state.json, points state.env's VERIFY_API at the API's current port
// and prints the JSON. A recreated or restarted service can get a new
// ephemeral port, so lib.sh's ap_compose runs this after up/restart/start.
//   node scripts/verify/run-urls.mjs <run id | run dir>
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRunState } from "./run-state.mjs";

// A name with one of these words (split on _ and -) names a secret: none
// may be a key of state.json, and no state value under such a name may
// appear in it.
const SECRET_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "key",
  "cookie",
  "credential",
  "credentials",
]);
export const isSecretName = (name) =>
  String(name)
    .toLowerCase()
    .split(/[_\-.]/)
    .some((word) => SECRET_WORDS.has(word));

// `docker compose ps --format json` prints one object per line (Compose v2.21+)
// or a single array (older); either way, published ports by service.
export function collectPorts(psOutput) {
  const text = psOutput.trim();
  const containers = text.startsWith("[")
    ? JSON.parse(text)
    : text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  const ports = {};
  for (const { Service, Publishers } of containers) {
    for (const { TargetPort, PublishedPort } of Publishers ?? []) {
      if (!PublishedPort) continue;
      ports[Service] ??= {};
      ports[Service][String(TargetPort)] = PublishedPort;
    }
  }
  return ports;
}

export function runUrls(state, ports) {
  const api = ports.api?.["3000"];
  if (!api)
    throw new Error(
      "the api service publishes no port for 3000; is the stack up?",
    );
  // apps/web is served by the API on the same origin.
  const base = `http://127.0.0.1:${api}`;
  const urls = {
    project: state.COMPOSE_PROJECT_NAME,
    web_url: base,
    api_url: base,
    ports,
  };
  assertNoSecrets(urls, state);
  return urls;
}

export function assertNoSecrets(urls, state) {
  const walk = (value, at) => {
    if (value === null || typeof value !== "object") return;
    for (const [name, inner] of Object.entries(value)) {
      if (isSecretName(name))
        throw new Error(
          `state.json would hold a secret-named field: ${at}${name}`,
        );
      walk(inner, `${at}${name}.`);
    }
  };
  walk(urls, "");
  const text = JSON.stringify(urls);
  for (const [name, value] of Object.entries(state)) {
    if (isSecretName(name) && value && text.includes(value))
      throw new Error(`state.json would hold the value of ${name}`);
  }
}

// state.env with VERIFY_API set to url, replacing the line or adding one.
export function withApi(text, url) {
  const line = `VERIFY_API=${url}`;
  if (/^VERIFY_API=.*$/m.test(text))
    return text.replace(/^VERIFY_API=.*$/m, line);
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

const replace = (path, content) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [runArg] = process.argv.slice(2);
  if (!runArg) {
    console.error("usage: run-urls.mjs <run id | run dir>");
    process.exit(2);
  }
  const root =
    process.env.VERIFY_AP_ROOT ??
    join(process.env.TMPDIR ?? tmpdir(), "verify-werft");
  const run = runArg.includes("/")
    ? runArg.replace(/\/$/, "")
    : join(root, runArg.replace(/^verify-ap-/, ""));
  const statePath = join(run, "state.env");
  const stateText = readFileSync(statePath, "utf8");
  // The state as lib.sh and down.sh read it, sourced by bash: a path up.sh
  // quoted with %q (a space in it) comes back unquoted, which parseRunState
  // does not do. The parser only names the file's variables.
  let shellEnv;
  try {
    shellEnv = JSON.parse(
      execFileSync(
        "bash",
        [
          "-c",
          'set -a && . "$1" >/dev/null && exec "$2" -e "process.stdout.write(JSON.stringify(process.env))"',
          "bash",
          statePath,
          process.execPath,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ),
    );
  } catch (error) {
    console.error(
      `run-urls.mjs: could not source ${statePath}: ${error.message}`,
    );
    process.exit(1);
  }
  const state = Object.fromEntries(
    Object.keys(parseRunState(stateText)).map((name) => [
      name,
      shellEnv[name] ?? "",
    ]),
  );
  if (!state.COMPOSE_PROJECT_NAME?.startsWith("verify-ap-")) {
    console.error(`run-urls.mjs: ${statePath} names no verify-ap-* project`);
    process.exit(1);
  }
  let urls;
  try {
    const ps = execFileSync(
      "docker",
      [
        "compose",
        "--profile",
        "apps",
        "--profile",
        "fake-model",
        "ps",
        "--format",
        "json",
      ],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: shellEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    urls = runUrls(state, collectPorts(ps));
  } catch (error) {
    console.error(`run-urls.mjs: ${error.message}`);
    process.exit(1);
  }
  replace(join(run, "state.json"), `${JSON.stringify(urls, null, 2)}\n`);
  const updated = withApi(stateText, urls.api_url);
  if (updated !== stateText) replace(statePath, updated);
  console.log(JSON.stringify(urls, null, 2));
}
