import { describe, expect, test } from "bun:test";
import { GitHubCallError } from "../github/ports/github-gate.ts";
import type {
  ForgeContractSubject,
  MakeForgeSubject,
} from "./forge-contract-subject.ts";

/**
 * What every `RepositoryReadable` promises (`action/ports/capabilities.ts`):
 * a success is a value, a failure is a `GitHubCallError` that carries the
 * status and never what the forge answered.
 */
export function describeRepositoryReadableContract(make: MakeForgeSubject) {
  describe("RepositoryReadable", () => {
    test("answers the repository's default branch and visibility", async () => {
      const { api, repository } = await make();
      const found = await api.getRepository();
      expect(found.defaultBranch).toBe(repository.defaultBranch);
      expect(typeof found.id).toBe("number");
      expect(typeof found.private).toBe("boolean");
    });

    test("reads a file from a branch head by tree and blob sha, one level at a time", async () => {
      const { api, repository } = await make();
      const [path = "", text = ""] = Object.entries(repository.files)[0] ?? [];
      const head = await api.getBranchHead(repository.defaultBranch);
      expect(head.commitSha).toMatch(/^[0-9a-f]{40}$/);
      const tree = await api.readTree(head.treeSha);
      expect(tree.truncated).toBe(false);
      const entry = tree.entries.find((candidate) => candidate.name === path);
      expect(entry).toMatchObject({ mode: "100644", type: "blob" });
      expect(entry?.size).toBe(Buffer.byteLength(text));
      const blob = await api.readBlob(entry?.sha ?? "");
      expect(new TextDecoder().decode(blob)).toBe(text);
    });

    test("a branch or object the forge does not have is a GitHubCallError with its status", async () => {
      const { api } = await make();
      const missing = await api
        .getBranchHead("no-such-branch")
        .catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(GitHubCallError);
      expect(missing).toMatchObject({ status: 404 });
      const absent = await api
        .readBlob("9".repeat(40))
        .catch((error: unknown) => error);
      expect(absent).toBeInstanceOf(GitHubCallError);
      expect(absent).toMatchObject({ status: 404 });
    });

    test("a failed read names the status and not what the forge said", async () => {
      for (const read of [
        (s: ForgeContractSubject) => s.api.getRepository(),
        (s: ForgeContractSubject) =>
          s.api.getBranchHead(s.repository.defaultBranch),
        (s: ForgeContractSubject) => s.api.readTree("1".repeat(40)),
        (s: ForgeContractSubject) => s.api.readBlob("1".repeat(40)),
      ]) {
        // A fresh subject per read: a forge that retries a 502 eats the
        // failures and leaves none for the next read.
        const subject = await make();
        subject.failNext(502, 10);
        const failed = await read(subject).catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(GitHubCallError);
        expect(failed).toMatchObject({ status: 502 });
        expect(JSON.stringify(failed)).not.toContain("Server Error");
        expect((failed as Error).message).not.toContain("Server Error");
      }
    });
  });
}
