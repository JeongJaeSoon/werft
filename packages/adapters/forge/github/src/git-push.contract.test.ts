import { afterAll, beforeAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitPushInput, RepoRef } from "@werft-ai/platform";
import {
  describePushableContract,
  type PushableSubject,
} from "@werft-ai/platform/testing/pushable";
import {
  createGitBundleChain,
  type FakeGitHub,
  type GitBundleFixture,
  startFakeGitHub,
} from "@werft-ai/testkit";
import { createGitHubConnection } from "./forge-github.ts";
import { createGitPusher } from "./git-push.ts";

// The `Pushable` contract against the git pusher, with the testkit's fake
// GitHub as the remote it pushes to (git smart HTTP, token checked).
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

let github: FakeGitHub;
let chain: { base: GitBundleFixture; tip: GitBundleFixture };
let tempRoot: string;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  chain = await createGitBundleChain();
  tempRoot = await mkdtemp(join(tmpdir(), "git-push-contract-"));
});
afterAll(async () => {
  await github.stop();
  await rm(tempRoot, { force: true, recursive: true });
});

let remotes = 0;

async function subject(): Promise<PushableSubject> {
  remotes += 1;
  // A checkpoint builds on the repository it was cloned from.
  const related: RepoRef = { owner: "acme", name: `app-${remotes}` };
  await github.createRepository(related.owner, related.name, {
    "README.md": "hello\n",
  });
  await github.seedBranch(related.owner, related.name, "main", chain.base);
  const unrelated: RepoRef = { owner: "acme", name: `lone-${remotes}` };
  await github.createRepository(unrelated.owner, unrelated.name, {
    "README.md": "no shared history\n",
  });
  const connection = createGitHubConnection({
    apiBase: github.origin,
    credentials: { kind: "app", appId: 101, installationId: 202, privateKey },
    retryAfterBaseMs: 1,
    paced: false,
  });
  const { credential } = await connection.credential(related, {
    contents: "write",
  });
  const { credential: loneCredential } = await connection.credential(
    unrelated,
    { contents: "write" },
  );
  const basic = (login: { username: string; password: string }) =>
    `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;

  const inputFor = async (
    remoteUrl: string,
    ref: string,
    login: { username: string; password: string },
  ): Promise<GitPushInput> => {
    const directory = await mkdtemp(join(tempRoot, "push-"));
    const bundles: string[] = [];
    for (const [index, bundle] of [chain.base, chain.tip].entries()) {
      const path = join(directory, `push-${index}.bundle`);
      await writeFile(path, bundle.bytes);
      bundles.push(path);
    }
    return {
      directory,
      bundles,
      commit: chain.tip.commit,
      remoteUrl,
      ref,
      headers: [["authorization", basic(login)]],
      deadline: Date.now() + 60_000,
    };
  };
  const urlOf = (repo: RepoRef) =>
    `${github.origin}/${repo.owner}/${repo.name}.git`;

  return {
    pusher: createGitPusher(),
    commit: chain.tip.commit,
    input: (ref) => inputFor(urlOf(related), ref, credential),
    inputToUnrelatedRemote: (ref) =>
      inputFor(urlOf(unrelated), ref, loneCredential),
    // Port 9 (discard) refuses the connection on a test host.
    inputToUnreachableRemote: (ref) =>
      inputFor("http://127.0.0.1:9/acme/none.git", ref, credential),
    async remoteCommit(ref) {
      const refs = await github.refs(related.owner, related.name);
      const lone = await github.refs(unrelated.owner, unrelated.name);
      return refs[ref] ?? lone[ref] ?? null;
    },
    defaultBranchRef: "refs/heads/main",
    divergeRemote: async (ref) => {
      await github.writeUnrelatedCommit(
        related.owner,
        related.name,
        ref.replace(/^refs\/heads\//, ""),
      );
    },
    secret: credential.password,
  };
}

describePushableContract(subject);
