import { describe, expect, test } from "bun:test";
import { ForgeCredentialError } from "../action/ports/forge.ts";
import type { MakeForgeSubject } from "./forge-contract-subject.ts";

/**
 * What every `Commentable` promises: one comment per marker. The first
 * `upsertComment` writes it (`created: true`), a later one with the same
 * marker edits that comment (`created: false`), and only a comment the
 * credential itself wrote counts as the marker's. A failed call throws
 * `ForgeCredentialError`.
 */
export function describeCommentableContract(make: MakeForgeSubject) {
  describe("Commentable", () => {
    test("states the longest body it takes", async () => {
      const { api } = await make();
      expect(Number.isInteger(api.maxBodyLength)).toBe(true);
      expect(api.maxBodyLength).toBeGreaterThan(0);
    });

    test("writes one comment per marker and edits it on the next call", async () => {
      const { api, newBranch, openPullRequest, commentsOnForge } = await make();
      const number = await openPullRequest(await newBranch());
      const marker = "<!-- werft:s:status -->";
      const first = await api.upsertComment(number, marker, "Running.");
      expect(first.created).toBe(true);
      const other = await api.upsertComment(
        number,
        "<!-- werft:s:other -->",
        "Elsewhere.",
      );
      const second = await api.upsertComment(number, marker, "Done.");
      expect(second).toEqual({ id: first.id, url: first.url, created: false });
      expect(commentsOnForge(number)).toEqual([
        { id: first.id, body: `Done.\n\n${marker}` },
        { id: other.id, body: expect.stringContaining("Elsewhere.") },
      ]);
    });

    test("a marker a person pasted into their own comment is left alone", async () => {
      const {
        api,
        newBranch,
        openPullRequest,
        commentAsPerson,
        commentsOnForge,
      } = await make();
      const number = await openPullRequest(await newBranch());
      const marker = "<!-- werft:s:pasted -->";
      commentAsPerson(number, `Copied ${marker}`);
      const ours = await api.upsertComment(number, marker, "Running.");
      expect(ours.created).toBe(true);
      expect(await api.upsertComment(number, marker, "Done.")).toEqual({
        ...ours,
        created: false,
      });
      const [pasted] = commentsOnForge(number);
      expect(pasted?.body).toBe(`Copied ${marker}`);
    });

    test("a call the forge fails throws ForgeCredentialError", async () => {
      const { api, newBranch, openPullRequest, failNext } = await make();
      const number = await openPullRequest(await newBranch());
      failNext(502, 10);
      expect(
        await api
          .upsertComment(number, "<!-- werft:s:x -->", "Hi")
          .catch((error: unknown) => error),
      ).toBeInstanceOf(ForgeCredentialError);
    });
  });
}
