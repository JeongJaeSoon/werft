import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startFakeGitHub } from "./fake-github.ts";

// Local catalogs use production's App JWT and installation-token flow. The
// signing key lives in this disposable stack's volume, so a restarted fake
// keeps the key the console already holds for the repository.
const env = process.env;
const keyFile =
  env.FAKE_GITHUB_APP_KEY_FILE ?? "/var/lib/fake-github/app-key.pem";
let privateKey: string;
try {
  privateKey = readFileSync(keyFile, "utf8");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile, privateKey, { flag: "wx", mode: 0o600 });
}
if (privateKey.trim() === "") throw new Error(`${keyFile} is empty`);
const git = await startFakeGitHub({
  appId: 1,
  installationId: 1,
  publicKey: createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString(),
  hostname: "0.0.0.0",
  port: Number(env.FAKE_GIT_PORT ?? "3000"),
});
const repositories = process.argv.slice(2);
if (repositories.length === 0)
  throw new Error("at least one repository is required");
for (const name of repositories) {
  await git.createRepository(env.FAKE_GIT_OWNER ?? "agent", name, {
    "README.md": `# ${name}\n`,
  });
}
console.log(
  JSON.stringify({
    msg: "Local fake GitHub App listening",
    port: git.port,
    repositories,
  }),
);
process.on("SIGTERM", async () => {
  await git.stop();
  process.exit(0);
});
