// Copies the cache service variables the runner gives JavaScript actions into
// GITHUB_ENV for the steps after this one. buildx reads them for a `type=gha`
// cache: the token, the v1 and v2 service URLs, and which version to speak.
const { appendFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");

const token = process.env.ACTIONS_RUNTIME_TOKEN;
if (!token || !process.env.GITHUB_ENV) {
  // Without them the builds still run, only without the cache.
  console.log(
    "::warning::no Actions runtime token; image builds will not read the cache",
  );
  process.exit(0);
}
console.log(`::add-mask::${token}`);
const values = {
  ACTIONS_RUNTIME_TOKEN: token,
  ACTIONS_CACHE_URL: process.env.ACTIONS_CACHE_URL,
  ACTIONS_RESULTS_URL: process.env.ACTIONS_RESULTS_URL,
  // GitHub-hosted runners speak cache service v2, at ACTIONS_RESULTS_URL.
  ACTIONS_CACHE_SERVICE_V2: process.env.ACTIONS_RESULTS_URL
    ? "true"
    : undefined,
};
let lines = "";
for (const [name, value] of Object.entries(values)) {
  if (!value) continue;
  const end = `END_${randomUUID()}`;
  lines += `${name}<<${end}\n${value}\n${end}\n`;
}
appendFileSync(process.env.GITHUB_ENV, lines);
console.log(
  `cache runtime: ${Object.keys(values)
    .filter((name) => values[name])
    .join(", ")}`,
);
