import { readFileSync } from "node:fs";

// Sets the stored values of a disposable stack's imported settings rows
// through the console's own credential routes. Runs beside the fake GitHub
// App so a repository gets that App's private key. Values come on stdin and
// the owner's session in SEED_COOKIE, so neither shows in a process listing.
const env = process.env;
const cookie = env.SEED_COOKIE ?? "";
if (cookie === "")
  throw new Error("SEED_COOKIE must hold the owner's session cookie");
const api = (env.SEED_API_URL ?? "http://api:3000").replace(/\/+$/, "");
const keyFile =
  env.FAKE_GITHUB_APP_KEY_FILE ?? "/var/lib/fake-github/app-key.pem";

type Seed = {
  connections?: Record<string, string>;
  repositories?: string[];
};
const seed = JSON.parse(await Bun.stdin.text()) as Seed;

async function set(section: string, id: string, value: string) {
  const path = `/v1/installation/settings/${section}/${encodeURIComponent(id)}/credential`;
  const response = await fetch(`${api}${path}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "x-requested-with": "werft-web",
    },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) {
    console.error(`POST ${path}: ${response.status} ${await response.text()}`);
    process.exit(1);
  }
  console.log(`set ${section}/${id}`);
}

for (const [id, value] of Object.entries(seed.connections ?? {}))
  await set("connections", id, value);
if (seed.repositories?.length) {
  const pem = readFileSync(keyFile, "utf8");
  for (const id of seed.repositories) await set("repositories", id, pem);
}
