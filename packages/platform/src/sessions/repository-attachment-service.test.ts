import { describe, expect, test } from "bun:test";
import {
  LISTED_REPOSITORY_MEANING as MEANING,
  type ReceiptActor,
} from "@werft-ai/contracts";
import type { GitHubSessionContext } from "../github/ports/github-gate.ts";
import { SessionServiceError } from "../musterrolle/index.ts";
import { agentPolicy, releasePolicy } from "../testing/github-fakes.ts";
import { refusal } from "../testing/refusal.ts";
import {
  attachCatalog,
  attachGitHub,
  attachmentContext,
  manyRepositoriesCatalog,
  memoryAttachmentStore,
} from "../testing/repository-attachment-fakes.ts";
import { createRepositoryAttachmentService } from "./repository-attachment-service.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const COMMIT = "c".repeat(40);
const APP = { id: "app", name: "acme/app", branch: "main" };
const DOCS = { id: "docs", name: "acme/docs", branch: "trunk" };
const actor: ReceiptActor = {
  principal: { kind: "user", id: "user-1" },
  actor_user_id: "user-1",
  agent_id: "agent-1",
};

function service(
  options: {
    context?: Partial<GitHubSessionContext>;
    attempts?: Set<string>;
    attached?: string[] | null;
    waitMs?: number;
    onSleep?: () => Promise<void> | void;
    readMs?: number;
    active?: string[];
  } = {},
) {
  const store = memoryAttachmentStore(options.attempts, options.attached);
  if (options.active !== undefined) {
    store.agent.active = {
      id: "release-2",
      github: attachGitHub(options.active),
    };
  }
  let clock = 0;
  let reads = 0;
  const find = store.find;
  store.find = async (sessionId, repositoryId) => {
    reads += 1;
    clock += options.readMs ?? 0;
    return find(sessionId, repositoryId);
  };
  const attachments = createRepositoryAttachmentService({
    store,
    context: { context: async () => attachmentContext(options.context) },
    catalog: attachCatalog,
    pollMs: 10,
    sleep: async (ms) => {
      clock += ms;
      await options.onSleep?.();
    },
    now: () => clock,
  });
  const attach = (repositoryId: string, attemptId = "att_1") =>
    attachments.attach({
      sessionId: SESSION,
      attemptId,
      actor,
      repositoryId,
      ...(options.waitMs === undefined ? {} : { waitMs: options.waitMs }),
    });
  return {
    store,
    attach,
    list: (page?: Parameters<typeof attachments.list>[1]) =>
      attachments.list(SESSION, page),
    reads: () => reads,
  };
}

describe("list", () => {
  test("names the session's own and every other one the release allows in one list; the unattached ones are not_attached", async () => {
    const s = service();
    expect(await s.list()).toEqual({
      repositories: [
        {
          ...APP,
          status: "attached",
          remote: "origin",
          meaning: MEANING.attached,
        },
        { ...DOCS, status: "not_attached", meaning: MEANING.not_attached },
        {
          id: "tools",
          name: "acme/tools",
          branch: "main",
          status: "not_attached",
          meaning: MEANING.not_attached,
        },
      ],
      next_cursor: null,
    });
  });

  test("an attach in flight is pending; a start list or a null list counts as attached, under a remote named after the id", async () => {
    const pending = service();
    await pending.attach("docs");
    const inFlight = (await pending.list()).repositories;
    expect(inFlight.map((entry) => entry.status)).toEqual([
      "attached",
      "pending",
      "not_attached",
    ]);
    // Only an attached repository has been given a remote name.
    expect(inFlight.map((entry) => "remote" in entry)).toEqual([
      true,
      false,
      false,
    ]);

    const started = (
      await service({ context: { attachedRepositoryIds: ["tools"] } }).list()
    ).repositories;
    expect(started.map((entry) => entry.status)).toEqual([
      "attached",
      "not_attached",
      "attached",
    ]);
    expect(started.map((entry) => entry.remote)).toEqual([
      "origin",
      undefined,
      "tools",
    ]);
    const all = (
      await service({ context: { attachedRepositoryIds: null } }).list()
    ).repositories;
    expect(all.map((entry) => entry.status)).toEqual([
      "attached",
      "attached",
      "attached",
    ]);
    expect(all.map((entry) => entry.remote)).toEqual([
      "origin",
      "docs",
      "tools",
    ]);
  });

  test("a settled fetch decides the remote: attached carries the id, failed carries none", async () => {
    const s = service();
    const docs = await s.attach("docs", "att_1");
    const tools = await s.attach("tools", "att_1");
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id: docs.receipt_id ?? "",
        status: "attached",
        commit: COMMIT,
      },
      {
        repository_id: "tools",
        receipt_id: tools.receipt_id ?? "",
        status: "failed",
        failure: "fetch_failed",
      },
    ]);
    const listed = (await s.list()).repositories;
    expect(
      listed.map((entry) => [entry.id, entry.status, entry.remote]),
    ).toEqual([
      ["app", "attached", "origin"],
      ["docs", "attached", "docs"],
      ["tools", "failed", undefined],
    ]);
    expect("remote" in (listed[2] ?? {})).toBe(false);
  });

  test("never answers primary or available, whatever the session holds", async () => {
    const contexts = [
      {},
      { attachedRepositoryIds: null },
      { attachedRepositoryIds: ["docs"] },
      { repositoryId: null, repository: null },
    ];
    for (const context of contexts) {
      const s = service({ context });
      await s.attach("tools");
      for (const entry of (await s.list()).repositories) {
        expect(entry.status === "primary").toBe(false);
        expect(entry.status === "available").toBe(false);
      }
    }
  });

  test("a session started without a repository lists every allowed one as not_attached and has no row of its own", async () => {
    const listed = (
      await service({
        context: { repositoryId: null, repository: null },
      }).list()
    ).repositories;
    expect(listed.map((entry) => [entry.id, entry.status])).toEqual([
      ["app", "not_attached"],
      ["docs", "not_attached"],
      ["tools", "not_attached"],
    ]);
  });

  test("no release list leaves only the session's own, still attached", async () => {
    expect(
      (await service({ context: { policy: releasePolicy(null) } }).list())
        .repositories,
    ).toEqual([
      {
        ...APP,
        status: "attached",
        remote: "origin",
        meaning: MEANING.attached,
      },
    ]);
  });

  describe("revoked: attached once, the agent's settings no longer allow it", () => {
    const REVOKED = { status: "revoked" as const, meaning: MEANING.revoked };
    const CEILING = {
      repository_ids: ["app", "docs", "tools", "secret"],
      github_app_repositories: "listed" as const,
    };
    // A session on the agent's settings, under a ceiling that holds them all.
    const agent = (repositories?: string[]) => ({
      policy: agentPolicy(attachGitHub(repositories), { revision: 5 }),
      repositoryCeiling: CEILING,
    });
    const statusesOf = async (s: ReturnType<typeof service>) =>
      (await s.list()).repositories.map((entry) => [entry.id, entry.status]);

    test("the agent's switch off revokes the session's own, which keeps no remote", async () => {
      const listed = await service({
        context: {
          agent: {
            id: "agent-1",
            workspaceId: "owner-a",
            githubEnabled: false,
          },
        },
      }).list();
      expect(listed.repositories).toEqual([{ ...APP, ...REVOKED }]);
      expect("remote" in (listed.repositories[0] ?? {})).toBe(false);
    });

    test("the session's own is revoked when the saved list drops it or the person's list drops it, and stays attached otherwise", async () => {
      const dropped = [
        agent(["docs"]),
        {
          policy: {
            ...releasePolicy(attachGitHub()),
            currentRepositories: ["docs"],
          },
        },
        {
          ...agent(),
          repositoryCeiling: { ...CEILING, repository_ids: ["docs"] },
        },
        // A release without a pin has no list of its own, but a person's
        // saved list still takes the repository away, as the gate does.
        {
          policy: {
            ...releasePolicy(attachGitHub()),
            settings: null,
            currentRepositories: ["docs"],
          },
        },
      ];
      for (const context of dropped) {
        expect((await statusesOf(service({ context })))[0]).toEqual([
          "app",
          "revoked",
        ]);
      }
      expect((await statusesOf(service({ context: agent() })))[0]).toEqual([
        "app",
        "attached",
      ]);
    });

    test("a repository attached by a fetch or the start list and then taken off the list is revoked; allowed ones are not", async () => {
      const fetched = service({ context: agent() });
      await fetched.attach("docs");
      await fetched.store.settle(SESSION, [
        {
          repository_id: "docs",
          receipt_id:
            (await fetched.store.find(SESSION, "docs"))?.receiptId ?? "",
          status: "attached",
          commit: COMMIT,
        },
      ]);
      const taken = service({ context: agent(["app", "tools"]) });
      // The same store rows under a list without docs.
      taken.store.list = fetched.store.list;
      const rows = (await taken.list()).repositories;
      expect(rows.map((entry) => [entry.id, entry.status])).toEqual([
        ["app", "attached"],
        ["docs", "revoked"],
        ["tools", "not_attached"],
      ]);
      const docs = rows.find((entry) => entry.id === "docs");
      expect(docs).toMatchObject({ name: "acme/docs", branch: "trunk" });
      expect("remote" in (docs ?? {})).toBe(false);

      // A start-list id off the settings list shows as revoked too.
      expect(
        await statusesOf(
          service({
            context: {
              ...agent(),
              attachedRepositoryIds: ["secret", "tools"],
            },
          }),
        ),
      ).toEqual([
        ["app", "attached"],
        ["docs", "not_attached"],
        ["secret", "revoked"],
        ["tools", "attached"],
      ]);
    });

    test("a row still pending or failed keeps its status, and an emptied settings list still reads the rows", async () => {
      const s = service({ context: agent() });
      await s.attach("docs");
      const none = service({ context: agent([]) });
      none.store.list = s.store.list;
      expect(await statusesOf(none)).toEqual([
        ["app", "revoked"],
        ["docs", "pending"],
      ]);
    });

    test("what a newer release allows does not cover a revoked row, and the catalog may not know the repository", async () => {
      const s = service({
        context: {
          ...agent(),
          attachedRepositoryIds: ["gone"],
        },
        active: ["gone"],
      });
      const listed = (await s.list()).repositories;
      expect(listed.find((entry) => entry.id === "gone")).toEqual({
        id: "gone",
        name: "gone",
        branch: null,
        status: "revoked",
        meaning: MEANING.revoked,
      });
    });

    test("an unknown id that looks like a prototype key is only an id", async () => {
      const listed = (
        await service({
          context: {
            ...agent(),
            attachedRepositoryIds: ["constructor"],
          },
        }).list()
      ).repositories;
      expect(listed.find((entry) => entry.id === "constructor")).toMatchObject({
        name: "constructor",
        status: "revoked",
      });
    });
  });

  test("never carries a credential an old session URL held", async () => {
    const listed = await service({
      context: {
        repository: {
          url: "https://x-access-token:hunter2@github.com/acme/app.git",
          branch: "main",
        },
      },
    }).list();
    expect(listed.repositories[0]?.name).toBe("acme/app");
    expect(JSON.stringify(listed)).not.toContain("hunter2");
    expect(JSON.stringify(listed)).not.toContain("https://");
  });

  test("a session without a repository lists none of its own", async () => {
    expect(
      (
        await service({
          context: { repositoryId: null, repository: null },
        }).list()
      ).repositories.map((entry) => entry.id),
    ).toEqual(["app", "docs", "tools"]);
  });
});

describe("a session under the agent's settings", () => {
  const ceiling = {
    repository_ids: ["app", "docs", "secret"],
    github_app_repositories: "listed" as const,
  };
  const under = (settings = attachGitHub(["app", "docs"])) => ({
    policy: agentPolicy(settings, { revision: 5 }),
    repositoryCeiling: ceiling,
    ceilingRevision: 2,
  });
  const ids = (list: { repositories: Array<{ id: string }> }) =>
    list.repositories.map(({ id }) => id);

  test("list and attach read the agent's list and the workspace's ceiling", async () => {
    const s = service({ context: under() });
    expect(ids(await s.list())).toEqual(["app", "docs"]);
    expect(await refusal(s.attach("secret"))).toMatchObject({
      details: { reason_code: "repository_not_allowed" },
    });
    expect(s.store.receipts.at(-1)?.result).toMatchObject({
      policy_source: "agent",
      agent_settings_revision: 5,
      workspace_ceiling_revision: 2,
    });
  });

  test("a repository on the list but off the ceiling is not offered", async () => {
    const s = service({
      context: { ...under(), repositoryCeiling: null },
    });
    expect(ids(await s.list())).toEqual(["app"]);
  });

  test("has no newer release to wait for: a repository off its list is plainly not allowed", async () => {
    const s = service({
      context: under(attachGitHub(["app"])),
      active: ["app", "docs"],
    });
    expect(await refusal(s.attach("docs"))).toMatchObject({
      details: { reason_code: "repository_not_allowed" },
    });
    expect(ids(await s.list())).toEqual(["app"]);
  });
});

describe("a repository only the agent's active release allows", () => {
  // The session runs release-1 (app, docs); the owner then allowed tools,
  // and release-2 became active.
  const pinned = {
    policy: releasePolicy(attachGitHub(["app", "docs"])),
  };

  test("attach refuses it as allowed in a newer release, saying a new session can use it", async () => {
    const s = service({ context: pinned, active: ["app", "docs", "tools"] });
    let message = "";
    const refused = await refusal(
      s.attach("tools").catch((error: unknown) => {
        if (error instanceof SessionServiceError) message = error.message;
        throw error;
      }),
    );
    expect(refused).toEqual({
      code: "GITHUB_REFUSED",
      details: {
        reason_code: "allowed_in_newer_release",
        receipt_id: "receipt-1",
      },
    });
    expect(message).toContain("new session");
    expect(message).toContain("does not need to be allowed again");
    expect(s.store.receipts).toEqual([
      expect.objectContaining({
        status: "failed",
        result: expect.objectContaining({
          agent_release_id: "release-1",
          reason_code: "allowed_in_newer_release",
        }),
      }),
    ]);
    expect(s.store.rows.size).toBe(0);
    expect(s.store.attached()).toEqual([]);
  });

  test("one no release allows, or a session already on the active release, stays repository_not_allowed", async () => {
    for (const [repository, options] of [
      ["secret", { context: pinned, active: ["app", "docs", "tools"] }],
      ["tools", { context: pinned, active: ["app", "docs"] }],
      ["tools", { context: pinned }],
      [
        "tools",
        {
          context: {
            release: { id: "release-2" },
            policy: releasePolicy(attachGitHub(["app"])),
          },
          active: ["app", "docs", "tools"],
        },
      ],
      [
        "tools",
        {
          context: {
            ...pinned,
            agent: {
              id: "agent-1",
              workspaceId: "owner-a",
              githubEnabled: false,
            },
          },
          active: ["app", "docs", "tools"],
        },
      ],
    ] as Array<[string, Parameters<typeof service>[0]]>) {
      expect(
        (await refusal(service(options).attach(repository))).details,
      ).toEqual({
        reason_code: "repository_not_allowed",
        receipt_id: "receipt-1",
      });
    }
  });

  test("list marks it apart from what the session may attach", async () => {
    expect(
      (
        await service({
          context: pinned,
          active: ["app", "tools", "docs"],
        }).list()
      ).repositories,
    ).toEqual([
      {
        ...APP,
        status: "attached",
        remote: "origin",
        meaning: MEANING.attached,
      },
      { ...DOCS, status: "not_attached", meaning: MEANING.not_attached },
      {
        id: "tools",
        name: "acme/tools",
        branch: "main",
        status: "allowed_in_newer_release",
        meaning: MEANING.allowed_in_newer_release,
      },
    ]);
    expect(
      (await service({ context: pinned }).list()).repositories.map(
        (entry) => entry.status,
      ),
    ).toEqual(["attached", "not_attached"]);
  });

  test("an allowed attach never reads the active release", async () => {
    const s = service({ active: ["app"] });
    expect((await s.attach("tools")).status).toBe("pending");
    expect(s.store.agent.activeReads).toBe(0);
  });
});

describe("attach", () => {
  test("the session's own repository is attached already: no row, no receipt", async () => {
    const s = service();
    expect(await s.attach("app")).toEqual({
      repository_id: "app",
      status: "attached",
      branch: "main",
      commit: null,
      failure: null,
      already_attached: true,
      receipt_id: null,
    });
    expect(s.store.receipts).toEqual([]);
  });

  test("one on the list the session started with, or on a null list, is attached already: no row, no receipt, no fetch", async () => {
    for (const attached of [["docs"], null]) {
      const s = service({ attached });
      expect(await s.attach("docs")).toEqual({
        repository_id: "docs",
        status: "attached",
        branch: "trunk",
        commit: null,
        failure: null,
        already_attached: true,
        receipt_id: null,
      });
      expect(s.store.receipts).toEqual([]);
      expect(await s.store.pending(SESSION)).toEqual([]);
      expect(s.store.attached()).toEqual(attached);
    }
  });

  test("the cap is the release's list, the settings, the ceiling and the agent's switch, and every refusal leaves a receipt", async () => {
    for (const [repository, context] of [
      ["secret", {}],
      ["unknown", {}],
      ["docs", { policy: releasePolicy(attachGitHub(["app"])) }],
      ["docs", { agent: { id: "a", workspaceId: "w", githubEnabled: false } }],
      ["docs", { release: null, policy: releasePolicy(null) }],
    ] as Array<[string, Partial<GitHubSessionContext>]>) {
      const s = service({ context });
      expect(await refusal(s.attach(repository))).toEqual({
        code: "GITHUB_REFUSED",
        details: {
          reason_code: "repository_not_allowed",
          receipt_id: "receipt-1",
        },
      });
      expect(s.store.receipts.map((r) => r.status)).toEqual(["failed"]);
      expect(s.store.rows.size).toBe(0);
    }
  });

  test("the list the session started with does not limit what it may attach", async () => {
    const s = service({ context: { attachedRepositoryIds: [] } });
    expect((await s.attach("tools")).status).toBe("pending");
    expect(s.store.attached()).toEqual(["tools"]);
  });

  test("attaching it again changes nothing and succeeds, pending or attached", async () => {
    const s = service();
    const first = await s.attach("docs");
    expect(first).toMatchObject({ status: "pending", already_attached: false });
    expect(await s.attach("docs")).toEqual(first);
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id: first.receipt_id ?? "",
        status: "attached",
        commit: COMMIT,
      },
    ]);
    expect(await s.attach("docs")).toEqual({
      repository_id: "docs",
      status: "attached",
      branch: "trunk",
      commit: COMMIT,
      failure: null,
      already_attached: true,
      receipt_id: first.receipt_id,
    });
    expect(s.store.receipts).toHaveLength(1);
  });

  test("an ended attempt's call is refused with a receipt", async () => {
    const s = service({ attempts: new Set(["att_2"]) });
    expect(await refusal(s.attach("docs", "att_1"))).toEqual({
      code: "STALE_EPOCH",
      details: { reason_code: "attempt_ended", receipt_id: "receipt-1" },
    });
    expect(s.store.receipts[0]?.result).toMatchObject({
      attempt_id: "att_1",
      repository_id: "docs",
      reason_code: "attempt_ended",
    });
    expect(s.store.rows.size).toBe(0);
  });

  test("answers pending at once when no wait is asked for", async () => {
    let sleeps = 0;
    const s = service({
      onSleep: () => {
        sleeps += 1;
      },
    });
    expect((await s.attach("docs")).status).toBe("pending");
    expect(sleeps).toBe(0);
    expect(s.reads()).toBe(0);
  });

  test("two calls waiting on the same fetch both answer what it fetched", async () => {
    let store: ReturnType<typeof memoryAttachmentStore> | undefined;
    let sleeps = 0;
    const s = service({
      waitMs: 1_000,
      onSleep: async () => {
        if (++sleeps === 2) {
          await store?.settle(SESSION, [
            {
              repository_id: "docs",
              receipt_id: "receipt-1",
              status: "attached",
              commit: COMMIT,
            },
          ]);
        }
      },
    });
    store = s.store;
    const [first, second] = await Promise.all([
      s.attach("docs"),
      s.attach("docs"),
    ]);
    expect(first.status).toBe("attached");
    expect(second.status).toBe("attached");
    expect(s.store.rows.size).toBe(1);
  });

  test("waits for the worker's report and answers what it fetched", async () => {
    let store: ReturnType<typeof memoryAttachmentStore> | undefined;
    let sleeps = 0;
    const s = service({
      waitMs: 1_000,
      onSleep: async () => {
        if (++sleeps === 3) {
          await store?.settle(SESSION, [
            {
              repository_id: "docs",
              receipt_id: "receipt-1",
              status: "attached",
              commit: COMMIT,
            },
          ]);
        }
      },
    });
    store = s.store;
    expect(await s.attach("docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
      already_attached: false,
    });
    expect(sleeps).toBe(3);
  });

  test("answers pending once the wait runs out, and the outcome on a later call", async () => {
    let sleeps = 0;
    const s = service({
      waitMs: 50,
      onSleep: () => {
        sleeps += 1;
      },
    });
    expect((await s.attach("docs")).status).toBe("pending");
    expect(sleeps).toBe(5);
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id: "receipt-1",
        status: "failed",
        failure: "fetch_timeout",
      },
    ]);
    expect(s.store.attached()).toEqual([]);
    expect(await s.attach("docs")).toMatchObject({
      status: "pending",
      receipt_id: "receipt-2",
    });
    expect(s.store.receipts.map((r) => r.status)).toEqual([
      "failed",
      "accepted",
    ]);
  });

  test("the wait counts the time its reads take, not only its sleeps", async () => {
    const s = service({ waitMs: 8_000, readMs: 3_000 });
    expect((await s.attach("docs")).status).toBe("pending");
    // Sleeps alone would read 800 times; three slow reads spend the budget.
    expect(s.reads()).toBe(3);
  });

  test("a read still running at the deadline is cut, and the last state answered", async () => {
    const store = memoryAttachmentStore();
    store.find = () => new Promise(() => {});
    const attachments = createRepositoryAttachmentService({
      store,
      context: { context: async () => attachmentContext() },
      catalog: attachCatalog,
      pollMs: 10,
    });
    const started = performance.now();
    const answered = await attachments.attach({
      sessionId: SESSION,
      attemptId: "att_1",
      actor,
      repositoryId: "docs",
      waitMs: 100,
    });
    expect(answered.status).toBe("pending");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a resent failure for an earlier request does not settle the request after it", async () => {
    const s = service();
    await s.attach("docs");
    const failed = {
      repository_id: "docs",
      receipt_id: "receipt-1",
      status: "failed" as const,
      failure: "fetch_failed" as const,
    };
    await s.store.settle(SESSION, [failed]);
    // The report's answer was lost; the agent asks again before it is resent.
    const again = await s.attach("docs");
    expect(again).toMatchObject({ status: "pending", receipt_id: "receipt-2" });
    await s.store.settle(SESSION, [failed]);
    expect(s.store.rows.get("docs")).toMatchObject({
      status: "pending",
      receiptId: "receipt-2",
    });
    expect(s.store.attached()).toEqual(["docs"]);
    expect(s.store.receipts.map((r) => r.status)).toEqual([
      "failed",
      "accepted",
    ]);
  });

  test("a retry from the next attempt after a crash attaches nothing twice", async () => {
    const attempts = new Set(["att_1"]);
    const s = service({ attempts });
    const first = await s.attach("docs", "att_1");
    // The worker died before reporting; the next attempt's agent asks again.
    attempts.delete("att_1");
    attempts.add("att_2");
    const retried = await s.attach("docs", "att_2");
    expect(retried).toEqual(first);
    expect(s.store.receipts).toHaveLength(1);
    // Both workers report; only the first report settles.
    const receipt_id = first.receipt_id ?? "";
    await s.store.settle(SESSION, [
      { repository_id: "docs", receipt_id, status: "attached", commit: COMMIT },
    ]);
    await s.store.settle(SESSION, [
      {
        repository_id: "docs",
        receipt_id,
        status: "failed",
        failure: "fetch_failed",
      },
    ]);
    expect(s.store.rows.get("docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
    });
    expect(s.store.receipts.map((r) => r.status)).toEqual(["succeeded"]);
  });
});

describe("list in pages", () => {
  const COUNT = 250;
  const names = Array.from(
    { length: COUNT },
    (_, i) => `r${String(i).padStart(4, "0")}`,
  );
  const many = () =>
    createRepositoryAttachmentService({
      store: memoryAttachmentStore(),
      context: {
        context: async () =>
          attachmentContext({
            policy: releasePolicy(attachGitHub(["app", ...names])),
            attachedRepositoryIds: null,
          }),
      },
      catalog: manyRepositoriesCatalog(COUNT),
    });

  test("a call from before pages gets the first page, which counts every row, and a cursor", async () => {
    const first = await many().list(SESSION);
    expect(first.repositories).toHaveLength(100);
    expect(first.repositories[0]).toMatchObject({
      id: "app",
      status: "attached",
      remote: "origin",
    });
    expect(first.repositories.at(-1)?.id).toBe("r0098");
    expect(first.next_cursor).toBe("r0098");
  });

  // The session's own id sits in the middle of the ids, so a page boundary
  // can fall on it; the list must not set it apart.
  const withOwn = (ownId: string) =>
    createRepositoryAttachmentService({
      store: memoryAttachmentStore(),
      context: {
        context: async () =>
          attachmentContext({
            repositoryId: ownId,
            policy: releasePolicy(attachGitHub(["app", ...names])),
            attachedRepositoryIds: null,
          }),
      },
      catalog: manyRepositoriesCatalog(COUNT),
    });
  const walk = async (
    service: ReturnType<typeof withOwn>,
    limit: number,
    query?: string,
  ) => {
    const seen: { id: string; status: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(SESSION, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(query === undefined ? {} : { query }),
      });
      expect(page.repositories.length).toBeLessThanOrEqual(limit);
      seen.push(...page.repositories);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return seen;
  };

  test("the session's own is one row among the others, wherever its id falls in a page", async () => {
    for (const [ownId, limit] of [
      ["r0099", 100], // last of the first page
      ["r0100", 100], // first of the second page
      ["r0150", 100], // middle of the second page
      ["r0249", 100], // last of the whole list
      ["r0042", 7],
    ] as const) {
      const seen = await walk(withOwn(ownId), limit);
      // The allowed list names the session's own id too; it is one row, the
      // session's own.
      expect(seen.map(({ id }) => id)).toEqual(["app", ...names]);
      expect(seen.find(({ id }) => id === ownId)?.status).toBe("attached");
    }
  });

  test("a query narrows the list and its pages still walk every match once", async () => {
    const seen = await walk(withOwn("r0150"), 4, "r01");
    expect(seen.map(({ id }) => id)).toEqual(
      names.filter((name) => name.startsWith("r01")),
    );
  });

  test("an id the allowed lists name twice is one row, and a page does not lose the next", async () => {
    const duplicated = createRepositoryAttachmentService({
      store: memoryAttachmentStore(),
      context: {
        context: async () =>
          attachmentContext({
            policy: releasePolicy(
              attachGitHub(["app", "docs", "docs", "tools"]),
            ),
            attachedRepositoryIds: [],
          }),
      },
      catalog: attachCatalog,
    });
    const seen = await walk(duplicated, 1);
    expect(seen.map(({ id }) => id)).toEqual(["app", "docs", "tools"]);
  });

  test("walking the cursor returns every repository once, in id order", async () => {
    const service = many();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.list(SESSION, {
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...page.repositories.map(({ id }) => id));
      cursor = page.next_cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(seen).toEqual(["app", ...names]);
  });

  test("the last page has no cursor, and a cursor past the end is an empty page", async () => {
    const last = await many().list(SESSION, { cursor: "r0200", limit: 100 });
    expect(last.repositories).toHaveLength(49);
    expect(last.next_cursor).toBeNull();
    const past = await many().list(SESSION, { cursor: "zzzz" });
    expect(past).toEqual({ repositories: [], next_cursor: null });
  });

  test("query keeps repositories whose id or name contains it", async () => {
    const found = await many().list(SESSION, { query: "R0042" });
    expect(found.repositories.map(({ id }) => id)).toEqual(["r0042"]);
    expect(found.next_cursor).toBeNull();
  });

  test("a small page continues after its cursor", async () => {
    const service = many();
    const before = await service.list(SESSION, { limit: 2 });
    const after = await service.list(SESSION, {
      limit: 2,
      cursor: before.next_cursor ?? "",
    });
    expect(before.repositories.map(({ id }) => id)).toEqual(["app", "r0000"]);
    expect(after.repositories.map(({ id }) => id)).toEqual(["r0001", "r0002"]);
  });
});
