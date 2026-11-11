import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  type AgentGitHub,
  type AgentGitHubSettingsRow,
  type AuthorizationRequest,
  type CreateSessionRequest,
  GITHUB_FEATURES_NONE,
  listSessionsQuerySchema,
  type RepositoryCeiling,
  scopesForRole,
  sessionCredentialUnboundDetailsSchema,
} from "@werft-ai/contracts";
import { releaseNotRunnableReason } from "../agents/agent-service.ts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentContact } from "../ports/credential-binding-store.ts";
import {
  testCatalog,
  testConnection,
  testSpecSource,
} from "../testing/catalog-fakes.ts";
import {
  attachCatalog,
  attachmentContext,
  memoryAttachmentStore,
} from "../testing/repository-attachment-fakes.ts";
import type { SessionCatalogView } from "./catalog.ts";
import type {
  AcceptSessionInput,
  AcceptSessionResult,
  SessionDetailRecord,
  SessionRecord,
} from "./ports/session-unit-of-work.ts";
import { createRepositoryAttachmentService } from "./repository-attachment-service.ts";
import {
  createSessionService,
  SessionServiceError,
} from "./session-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const RECEIPT = "019a0000-0000-7000-8000-00000000c0a1";

const APP = {
  url: "https://example.invalid/app.git",
  branch: "main",
  auth: { kind: "github_app" as const, registered: true as const },
};
const connection = testConnection({
  models: ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-5-5"],
});
const catalog = testCatalog({
  connections: { "conn-1": connection },
  repositories: { app: APP },
});
// The workspace ceiling every session is held to; it holds the app.
const IN_CEILING: RepositoryCeiling = {
  repository_ids: ["app", "docs", "tools"],
  github_app_repositories: "listed",
};

const unreached = async () => {
  throw new Error("not reached");
};

function setup(
  options: {
    unbound?: string[];
    contacts?: AgentContact[];
    /** What the acceptance finds: an earlier acceptance, or an unbind. */
    accept?:
      | "replayed"
      | "credential_unbound"
      | "unsupported"
      | "variables_refused";
    /** The names release rel-1's card declares; absent, the dep is left out. */
    envNames?: string[];
    catalog?: SessionCatalogView;
    /** The runtime release rel-1's snapshot names; absent, 0.3.270. */
    releaseRuntime?: string;
    /** The agent's status; absent, active. */
    agentStatus?: "active" | "paused" | "archived";
    /** The release's approval; absent, approved. */
    approvedAt?: string | null;
    /** The session getSession and appendMessage find. */
    session?: SessionDetailRecord;
    /** What listSessions finds. */
    listed?: SessionRecord[];
    /** Idempotency keys of messages accepted earlier. */
    appendedKeys?: string[];
    /** The release's GitHub settings. */
    github?: AgentGitHub;
    /** The agent's own settings row. */
    agentSettings?: AgentGitHubSettingsRow;
    /** Absent: IN_CEILING. */
    repositoryCeiling?: RepositoryCeiling | null;
  } = {},
) {
  const accepted: AcceptSessionInput[] = [];
  const appended: string[] = [];
  const asked: AuthorizationRequest[] = [];
  const policy = createAuthorizationPolicy({
    credentials: { unboundRefs: async () => options.unbound ?? [] },
  });
  const service = createSessionService({
    authorization: {
      authorize: (request) => {
        asked.push(request);
        return policy.authorize(request);
      },
    },
    catalog: options.catalog ?? catalog,
    releases: {
      agentGitHubSettings: async () => options.agentSettings ?? null,
      repositoryCeiling: async () =>
        options.repositoryCeiling === undefined
          ? IN_CEILING
          : options.repositoryCeiling,
      notRunnableReason: (workspaceId, release) =>
        releaseNotRunnableReason(
          { agentStatus: async () => options.agentStatus ?? "active" },
          workspaceId,
          release,
        ),
      async resolveRelease(_workspaceId, releaseId) {
        if (releaseId !== "rel-1" && releaseId !== "rel-app") {
          throw new SessionServiceError("NOT_FOUND", "Resource not found");
        }
        return {
          id: releaseId,
          agent_id: AGENT,
          approved_at:
            options.approvedAt === undefined
              ? "2026-01-01T00:00:00.000Z"
              : options.approvedAt,
          connection_id: "conn-1",
          repository_id: releaseId === "rel-app" ? "app" : null,
          runtime_config_snapshot: {
            model: "claude-opus-5-5",
            runtime: {
              kind: "claude_agent_sdk",
              version: options.releaseRuntime ?? "0.3.270",
            },
          },
          effective_tools: { tools: ["Read"], mcp: [] },
          policy_pins:
            options.github === undefined ? {} : { github: options.github },
        };
      },
      ...(options.envNames === undefined
        ? {}
        : {
            envNames: async (workspaceId: string, releaseId: string) =>
              workspaceId === WORKSPACE && releaseId === "rel-1"
                ? (options.envNames ?? [])
                : [],
          }),
    },
    inputs: {
      async acceptInputAtomic(
        input: AcceptSessionInput,
      ): Promise<AcceptSessionResult> {
        accepted.push(input);
        // Like the database, after it finds no earlier acceptance of the key.
        if (input.notRunnableReason && options.accept !== "replayed") {
          return { outcome: "not_runnable", reason: input.notRunnableReason };
        }
        if (
          options.accept === "credential_unbound" ||
          (input.credentialsUnbound && options.accept !== "replayed")
        ) {
          return { outcome: "credential_unbound", receiptId: RECEIPT };
        }
        if (options.accept === "variables_refused") {
          return {
            outcome: "variables_refused",
            reason: "unresolved",
            receiptId: RECEIPT,
          };
        }
        return {
          outcome: options.accept ?? "accepted",
          response: {
            session_id: "019a0000-0000-7000-8000-00000000e0a1",
            turn_id: "1",
            receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
            receipt_status: "accepted",
            status: "queued",
          },
        };
      },
      async appendInputAtomic(input) {
        const replay = options.appendedKeys?.includes(input.idempotencyKey);
        if (!replay) appended.push(input.message);
        return {
          outcome: replay ? "replayed" : "accepted",
          response: {
            turn_id: "2",
            receipt_id: RECEIPT,
            receipt_status: "accepted",
          },
        };
      },
    },
    controls: {
      terminateAtomic: unreached,
      pauseAtomic: unreached,
      closeAtomic: unreached,
      decideRecoveryAtomic: unreached,
      resumeAtomic: unreached,
      renameAtomic: unreached,
    },
    credentials: {
      contacts: async (workspaceId, agentId) =>
        workspaceId === WORKSPACE && agentId === AGENT
          ? (options.contacts ?? [])
          : [],
    },
    reader: {
      listSessions: async () => ({
        items: options.listed ?? [],
        next_cursor: null,
      }),
      countSessions: unreached,
      getSession: async () => options.session ?? null,
      listTurns: unreached,
      getTurn: unreached,
      getReceipt: unreached,
      hiddenAgentRefs: unreached,
      readEvents: unreached,
    },
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });
  const caller = callerFor(
    {
      kind: "user",
      id: MEMBER,
      workspace_id: WORKSPACE,
      role: "member",
      scopes: [...scopesForRole("member")],
    },
    { kind: "web" },
    "r",
  );
  return { service, caller, accepted, appended, asked };
}

const body = { agent_release_id: "rel-1", repository_id: "app", message: "hi" };

describe("a session pinned to an agent release", () => {
  test("is authorized as that agent's and stores the pin", async () => {
    const { service, caller, accepted, asked } = setup();
    await service.createSession(caller, {
      idempotencyKey: "k",
      body,
    });
    expect(asked[0]?.resource).toMatchObject({
      id: null,
      agent_id: AGENT,
      release_id: "rel-1",
    });
    expect(accepted[0]?.agentReleaseId).toBe("rel-1");
  });

  test("a repository outside the release's GitHub repositories is refused as repository_not_allowed before acceptance", async () => {
    const github: AgentGitHub = {
      repositories: ["other"],
      push_approval: true,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    };
    const refused = setup({ github });
    const error = await refused.service
      .createSession(refused.caller, {
        idempotencyKey: "k",
        body,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "GITHUB_REFUSED",
      details: { reason_code: "repository_not_allowed", receipt_id: null },
    });
    expect(refused.accepted).toEqual([]);

    const allowed = setup({ github: { ...github, repositories: ["app"] } });
    await allowed.service.createSession(allowed.caller, {
      idempotencyKey: "k",
      body,
    });
    expect(allowed.accepted[0]?.repository).toMatchObject({ id: "app" });
  });

  describe("attached repositories", () => {
    const attaching = testCatalog({
      connections: catalog.connections,
      repositories: {
        app: APP,
        docs: {
          url: "https://example.invalid/docs.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
        tools: {
          url: "https://example.invalid/tools.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
        elsewhere: {
          url: "https://example.invalid/elsewhere.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    });
    const github: AgentGitHub = {
      repositories: ["app", "docs", "tools", "elsewhere"],
      push_approval: true,
      features: GITHUB_FEATURES_NONE,
      actions_allow: [],
    };
    type Options = Omit<NonNullable<Parameters<typeof setup>[0]>, "github"> & {
      /** Null: a release without GitHub settings. */
      github?: AgentGitHub | null;
    };
    const create = (
      { github: settings = github, ...options }: Options,
      sent: Record<string, unknown>,
    ) => {
      const target = setup({
        catalog: attaching,
        ...options,
        ...(settings === null ? {} : { github: settings }),
      });
      // An undefined value in `sent` leaves the key out.
      const merged = JSON.parse(
        JSON.stringify({ ...body, ...sent }),
      ) as CreateSessionRequest;
      return {
        ...target,
        result: target.service
          .createSession(target.caller, {
            idempotencyKey: "k",
            body: merged,
          })
          .catch((caught: unknown) => caught),
      };
    };

    test("are stored as sent, and as none when not sent", async () => {
      const listed = create({}, { attached_repository_ids: ["docs"] });
      await listed.result;
      expect(listed.accepted[0]?.attachedRepositoryIds).toEqual(["docs"]);
      const empty = create({}, { attached_repository_ids: [] });
      await empty.result;
      expect(empty.accepted[0]?.attachedRepositoryIds).toEqual([]);
      const omitted = create({}, {});
      await omitted.result;
      expect(omitted.accepted[0]?.attachedRepositoryIds).toEqual([]);
      const repositoryless = create({}, { repository_id: undefined });
      await repositoryless.result;
      expect(repositoryless.accepted[0]?.attachedRepositoryIds).toEqual([]);
    });

    test("not sent, the session's agent attaches a repository for real; a null list from before has the release's whole list already", async () => {
      const omitted = create({}, {});
      await omitted.result;
      const stored = omitted.accepted[0]?.attachedRepositoryIds ?? null;
      for (const [attached, expected] of [
        [stored, { status: "pending", already_attached: false }],
        [null, { status: "attached", already_attached: true }],
      ] as const) {
        const store = memoryAttachmentStore(undefined, attached);
        const attachments = createRepositoryAttachmentService({
          store,
          context: {
            context: async () =>
              attachmentContext({ attachedRepositoryIds: store.attached() }),
          },
          catalog: attachCatalog,
        });
        const outcome = await attachments.attach({
          sessionId: "11111111-1111-4111-8111-111111111111",
          attemptId: "att_1",
          actor: {
            principal: { kind: "user", id: MEMBER },
            actor_user_id: MEMBER,
            agent_id: AGENT,
          },
          repositoryId: "docs",
        });
        expect(outcome).toMatchObject(expected);
        expect(store.attached()).toEqual(attached === null ? null : ["docs"]);
        expect(store.receipts).toHaveLength(attached === null ? 0 : 1);
      }
    });

    test("are stored for a session started without a repository", async () => {
      const started = create(
        {},
        { repository_id: undefined, attached_repository_ids: ["docs"] },
      );
      expect(await started.result).not.toBeInstanceOf(Error);
      expect(started.accepted[0]?.repository).toBe("none");
      expect(started.accepted[0]?.attachedRepositoryIds).toEqual(["docs"]);
    });

    test("are refused as repository_not_allowed off the release's list or the ceiling, or as the session's own", async () => {
      const cases: Array<[Options, Record<string, unknown>]> = [
        // The release does not list it.
        [
          { github: { ...github, repositories: ["app", "docs"] } },
          { attached_repository_ids: ["docs", "tools"] },
        ],
        // A release without GitHub settings lists none.
        [{ github: null }, { attached_repository_ids: ["docs"] }],
        // The workspace ceiling does not hold it.
        [{}, { attached_repository_ids: ["elsewhere"] }],
        // No workspace ceiling holds none.
        [{ repositoryCeiling: null }, { attached_repository_ids: ["docs"] }],
        // Not in the catalog.
        [
          { github: { ...github, repositories: ["app", "missing"] } },
          { attached_repository_ids: ["missing"] },
        ],
        // The session's own repository.
        [{}, { attached_repository_ids: ["app"] }],
        // Without a repository, still the release's list.
        [
          { github: { ...github, repositories: ["docs"] } },
          { repository_id: undefined, attached_repository_ids: ["tools"] },
        ],
      ];
      for (const [options, sent] of cases) {
        const target = create(options, sent);
        expect(await target.result).toMatchObject({
          code: "GITHUB_REFUSED",
          details: { reason_code: "repository_not_allowed", receipt_id: null },
        });
        expect(target.accepted).toEqual([]);
      }
    });
  });

  test("runs the card's model unless the request names another the connection offers", async () => {
    const { service, caller, accepted } = setup();
    const create = (extra: object) =>
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, agent_release_id: "rel-1", ...extra },
      });
    await create({});
    expect(accepted[0]?.model).toBe("claude-opus-5-5");
    await create({ model: "claude-haiku-5-5" });
    expect(accepted[1]?.model).toBe("claude-haiku-5-5");
    await create({ model: "claude-fable-5-1" });
    expect(accepted[2]).toMatchObject({ repository: null });
    expect(accepted[2]?.model).toBeUndefined();
  });

  test("a new session says which model left the list, whether the request or the release named it", async () => {
    // The connection no longer offers claude-opus-5-5, the release's model.
    const narrowed = testCatalog({
      connections: {
        "conn-1": testConnection({ models: ["claude-haiku-5-5"] }),
      },
      repositories: { app: APP },
    });
    const refused = async (extra: object) => {
      const { service, caller } = setup({
        accept: "unsupported",
        catalog: narrowed,
      });
      return service
        .createSession(caller, {
          idempotencyKey: "k",
          body: { ...body, agent_release_id: "rel-1", ...extra },
        })
        .catch((error: unknown) => error);
    };
    expect(await refused({})).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      message: expect.stringContaining("claude-opus-5-5"),
    });
    expect(await refused({ model: "claude-fable-5-1" })).toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      message: expect.stringContaining("claude-fable-5-1"),
    });
  });

  describe("a model the connection dropped while a newer one of its series is listed", () => {
    const families = {
      "claude-opus-5-5": { family: "opus", rank: 5 },
      "claude-opus-5-6": { family: "opus", rank: 6 },
      "claude-haiku-5-5": { family: "haiku", rank: 5 },
    };
    const moved = (models: string[]) =>
      testCatalog({
        connections: {
          "conn-1": testConnection({ models, model_families: families }),
        },
        repositories: { app: APP },
      });

    test("a new session on the release starts on the successor's row, the release untouched", async () => {
      const { service, caller, accepted } = setup({
        catalog: moved(["claude-opus-5-6", "claude-haiku-5-5"]),
      });
      await service.createSession(caller, {
        idempotencyKey: "k",
        body,
      });
      expect(accepted[0]?.model).toBe("claude-opus-5-5");
      expect(accepted[0]?.agentReleaseId).toBe("rel-1");
    });

    test("a model the request names is still its own choice and is refused", async () => {
      const { service, caller, accepted } = setup({
        accept: "unsupported",
        catalog: moved(["claude-opus-5-6", "claude-haiku-5-5"]),
      });
      const error = await service
        .createSession(caller, {
          idempotencyKey: "k",
          body: {
            ...body,
            agent_release_id: "rel-1",
            model: "claude-opus-5-5",
          },
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
        message: expect.stringContaining("claude-opus-5-5"),
      });
      expect(accepted[0]?.repository).toBeNull();
    });

    test("a newer model of another family is no successor: the release is refused as before", async () => {
      const { service, caller } = setup({
        accept: "unsupported",
        catalog: moved(["claude-haiku-5-5"]),
      });
      const error = await service
        .createSession(caller, {
          idempotencyKey: "k",
          body,
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "UNSUPPORTED_CAPABILITY",
        message: expect.stringContaining("claude-opus-5-5"),
      });
    });

    test("a waiting session shows no attention while one with no successor still does", async () => {
      const row = {
        ...sessionOn(),
        model: "claude-opus-5-5",
        spec: testSpecSource({ model: "claude-opus-5-5" }),
      };
      const withSuccessor = moved(["claude-opus-5-6"]);
      const a = setup({ catalog: withSuccessor, session: row });
      expect((await a.service.getSession(a.caller, SESSION)).attention).toBe(
        null,
      );
      const optedOut = setup({
        catalog: withSuccessor,
        session: { ...row, auto_model_migration: false },
      });
      expect(
        (await optedOut.service.getSession(optedOut.caller, SESSION)).attention,
      ).toMatchObject({ code: "CATALOG_MISMATCH" });
      const b = setup({ catalog: moved(["claude-haiku-5-5"]), session: row });
      expect(
        (await b.service.getSession(b.caller, SESSION)).attention,
      ).toMatchObject({
        code: "CATALOG_MISMATCH",
        reason: expect.stringContaining("claude-opus-5-5"),
      });
    });
  });

  test("a release on a runtime the worker images no longer accept takes no new session", async () => {
    const stale = setup({
      accept: "unsupported",
      catalog: {
        ...catalog,
        runtime_versions: {
          current: ["0.3.280", "2.1.280"],
          accepted: ["0.3.280", "2.1.280"],
        },
      },
    });
    await expect(
      stale.service.createSession(stale.caller, { idempotencyKey: "k", body }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      message: expect.stringContaining(
        "claude_agent_sdk 0.3.270, which the current worker images do not ship",
      ),
    });
    expect(stale.accepted[0]).toMatchObject({ repository: null });
    expect(stale.accepted[0]?.model).toBeUndefined();

    const current = setup({
      catalog: {
        ...catalog,
        runtime_versions: {
          current: ["0.3.270", "2.1.270"],
          accepted: ["0.3.270", "2.1.270"],
        },
      },
    });
    await current.service.createSession(current.caller, {
      idempotencyKey: "k",
      body,
    });
    expect(current.accepted[0]?.repository).toMatchObject({ id: "app" });
  });

  test("with only the release named, runs on its connection and its repository", async () => {
    const { service, caller, accepted } = setup();
    await service.createSession(caller, {
      idempotencyKey: "k",
      body: { agent_release_id: "rel-app", message: "hi" },
    });
    expect(accepted[0]).toMatchObject({
      agentReleaseId: "rel-app",
      repository: {
        id: "app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
    });
    // A release without a repository runs without one.
    await service.createSession(caller, {
      idempotencyKey: "k2",
      body: { agent_release_id: "rel-1", message: "hi" },
    });
    expect(accepted[1]).toMatchObject({ repository: "none" });
  });

  test.each(["paused", "archived"] as const)(
    "refuses a %s agent with agent_inactive",
    async (agentStatus) => {
      const { service, caller, accepted } = setup({ agentStatus });
      const error = await service
        .createSession(caller, {
          idempotencyKey: "k",
          body,
        })
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "AGENT_NOT_RUNNABLE",
        details: { reason_code: "agent_inactive", agent_id: AGENT },
      });
      expect(accepted[0]?.notRunnableReason).toBe("agent_inactive");
    },
  );

  test("a retry of a session made before the agent was paused gets its first answer", async () => {
    const { service, caller } = setup({
      agentStatus: "paused",
      accept: "replayed",
    });
    const created = await service.createSession(caller, {
      idempotencyKey: "k",
      body,
    });
    expect(created.session_id).toBe("019a0000-0000-7000-8000-00000000e0a1");
  });

  test("refuses a release that was never approved with release_unapproved", async () => {
    const { service, caller, accepted } = setup({ approvedAt: null });
    const error = await service
      .createSession(caller, {
        idempotencyKey: "k",
        body,
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "AGENT_NOT_RUNNABLE",
      details: { reason_code: "release_unapproved", release_id: "rel-1" },
    });
    expect(accepted[0]?.notRunnableReason).toBe("release_unapproved");
  });

  test("an approved release starts while the agent is active, whether or not it is the active release", async () => {
    const { service, caller, accepted } = setup();
    await service.createSession(caller, {
      idempotencyKey: "k",
      body,
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.notRunnableReason).toBeUndefined();
  });

  test("an unknown release is not found, and nothing is accepted", async () => {
    const { service, caller, accepted } = setup();
    expect(
      await service
        .createSession(caller, {
          idempotencyKey: "k",
          body: { ...body, agent_release_id: "rel-2" },
        })
        .catch((e: unknown) => e),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(accepted).toEqual([]);
  });

  test("does not start while a credential its release uses is unbound", async () => {
    const admins: AgentContact[] = [
      {
        userId: "019a0000-0000-7000-8000-0000000000a2",
        displayName: "관리자",
        email: "admin+bot@example.invalid",
      },
      {
        userId: "019a0000-0000-7000-8000-0000000000a3",
        displayName: "둘째",
        email: "second@example.invalid",
      },
    ];
    const { service, caller, accepted } = setup({
      unbound: ["slack_bot_token"],
      contacts: admins,
    });
    const error = await service
      .createSession(caller, {
        idempotencyKey: "k",
        body,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: {
        reason_code: "credential_unbound",
        guidance:
          "연결 설정이 바뀌어 시작하지 못했어요. 에이전트 관리자에게 문의하세요",
        agent_id: AGENT,
        admins: [
          {
            user_id: admins[0]?.userId,
            display_name: "관리자",
            email: "admin+bot@example.invalid",
          },
          {
            user_id: admins[1]?.userId,
            display_name: "둘째",
            email: "second@example.invalid",
          },
        ],
        admin_link:
          "mailto:admin%2Bbot%40example.invalid,second%40example.invalid",
      },
    });
    // The requester learns who to ask, never which names are missing.
    expect(JSON.stringify(error)).not.toContain("slack_bot_token");
    expect(
      sessionCredentialUnboundDetailsSchema.parse(
        (error as SessionServiceError).details,
      ),
    ).toBeTruthy();
    // Only the acceptance can tell a replay, so it is asked for nothing else.
    expect(accepted.map((input) => input.credentialsUnbound)).toEqual([true]);
  });

  test("with no one to ask, the link is null", async () => {
    const { service, caller } = setup({ unbound: ["x"] });
    expect(
      await service
        .createSession(caller, {
          idempotencyKey: "k",
          body,
        })
        .catch((e: unknown) => e),
    ).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: { admins: [], admin_link: null },
    });
  });

  test("a replay of a session accepted before the unbind gets its answer back", async () => {
    const { service, caller } = setup({
      unbound: ["slack_bot_token"],
      accept: "replayed",
    });
    expect(
      await service.createSession(caller, {
        idempotencyKey: "k",
        body,
      }),
    ).toMatchObject({ session_id: "019a0000-0000-7000-8000-00000000e0a1" });
  });

  test("an unbind between the decision and the acceptance still refuses", async () => {
    const { service, caller, accepted } = setup({
      accept: "credential_unbound",
    });
    expect(
      await service
        .createSession(caller, {
          idempotencyKey: "k",
          body,
        })
        .catch((e: unknown) => e),
    ).toMatchObject({
      code: "CREDENTIAL_UNBOUND",
      details: {
        reason_code: "credential_unbound",
        agent_id: AGENT,
        receipt_id: RECEIPT,
      },
    });
    expect(accepted[0]?.credentialsUnbound).toBeUndefined();
  });
});

describe("which policy a new session runs on", () => {
  const ROW: AgentGitHubSettingsRow = {
    repositories: ["app"],
    pushApproval: true,
    features: { ...GITHUB_FEATURES_NONE },
    actionsAllow: [],
    startRepositoryId: "app",
    pushAttached: null,
    revision: 2,
    updatedBy: null,
  };
  const CEILING: RepositoryCeiling = {
    repository_ids: ["app"],
    github_app_repositories: "listed",
  };
  const PIN: AgentGitHub = {
    repositories: ["app"],
    push_approval: true,
    features: GITHUB_FEATURES_NONE,
    actions_allow: [],
  };
  const start = async (
    options: Parameters<typeof setup>[0],
    sent: Partial<CreateSessionRequest> = {},
    release = "rel-1",
  ) => {
    const run = setup(options);
    const outcome = await run.service
      .createSession(run.caller, {
        idempotencyKey: "k",
        body: {
          message: "hi",
          agent_release_id: release,
          ...sent,
        },
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    return { refusal: outcome, accepted: run.accepted[0] };
  };

  test("no row: the release's, with its repository, as before", async () => {
    const { refusal, accepted } = await start({ github: PIN }, {}, "rel-app");
    expect(refusal).toBeNull();
    expect(accepted).toMatchObject({
      repository: { id: "app" },
      githubPolicySource: "release",
    });
    // The release's pin is the whole policy: nothing to snapshot.
    expect(accepted).not.toHaveProperty("captureGitHubPolicyStart");
  });

  test("a row: the agent's, starting without a repository though the row names one, with the settings snapshotted at start", async () => {
    expect(ROW.startRepositoryId).toBe("app");
    const { refusal, accepted } = await start({
      agentSettings: ROW,
      repositoryCeiling: CEILING,
    });
    expect(refusal).toBeNull();
    expect(accepted).toMatchObject({
      githubPolicySource: "agent",
      captureGitHubPolicyStart: true,
    });
    expect(accepted?.repository).toBe("none");
  });

  test("a row's start repository, list and ceiling do not stop a session that names none", async () => {
    for (const options of [
      { agentSettings: { ...ROW, repositories: ["docs"] } },
      { agentSettings: ROW },
      {
        agentSettings: ROW,
        repositoryCeiling: { ...CEILING, repository_ids: ["docs"] },
      },
    ]) {
      const { refusal, accepted } = await start(
        options as Parameters<typeof setup>[0],
      );
      expect(refusal).toBeNull();
      expect(accepted?.repository).toBe("none");
    }
  });

  test("a row with a repository the caller names starts on it", async () => {
    const { refusal, accepted } = await start(
      { agentSettings: ROW, repositoryCeiling: CEILING },
      { repository_id: "app" },
    );
    expect(refusal).toBeNull();
    expect(accepted).toMatchObject({ repository: { id: "app" } });
  });

  test("a row without a start repository starts on none", async () => {
    const { refusal, accepted } = await start({
      agentSettings: { ...ROW, startRepositoryId: null },
    });
    expect(refusal).toBeNull();
    expect(accepted).toMatchObject({
      githubPolicySource: "agent",
    });
    expect(accepted?.repository).toBe("none");
  });

  test.each([
    {
      name: "off the row's list",
      options: {
        agentSettings: { ...ROW, repositories: ["docs"] },
        repositoryCeiling: CEILING,
      },
    },
    {
      name: "no workspace ceiling",
      options: { agentSettings: ROW, repositoryCeiling: null },
    },
    {
      name: "off the workspace ceiling",
      options: {
        agentSettings: ROW,
        repositoryCeiling: { ...CEILING, repository_ids: ["docs"] },
      },
    },
    {
      name: "a row this image cannot read",
      options: {
        agentSettings: { ...ROW, repositories: "a later shape" },
        repositoryCeiling: CEILING,
      },
    },
  ])("a repository the caller names is refused: $name", async ({ options }) => {
    const { refusal, accepted } = await start(
      options as Parameters<typeof setup>[0],
      { repository_id: "app" },
    );
    expect(refusal).toBeInstanceOf(SessionServiceError);
    expect((refusal as SessionServiceError).code).toBe("GITHUB_REFUSED");
    expect(accepted).toBeUndefined();
  });
});

const SESSION = "019a0000-0000-7000-8000-00000000d0a1";

function sessionOn(): SessionDetailRecord {
  return {
    id: SESSION,
    title: "On a ceiling",
    agent: null,
    agent_hidden: false,
    created_by: null,
    channel: null,
    slack_permalink: null,
    revision: 1,
    admission_state: "active",
    status: "idle",
    repository_id: "app",
    repository: { id: "app", full_name: "app", branch: "main" },
    current_turn_id: null,
    queued_turn_count: 0,
    last_event_at: null,
    created_at: "2026-10-29T00:00:00.000Z",
    updated_at: "2026-10-29T00:00:00.000Z",
    execution: null,
    checkpoint_revision: null,
    pending_request_count: 0,
    attention: null,
    durability: {
      last_transcript_persisted_at: null,
      checkpoint_committed_at: null,
      checkpoint_revision: null,
      last_completed_turn_id: null,
      last_checkpointed_turn_id: null,
      checkpoint_pending_reason: null,
      checkpoint_fallback_revision: null,
      context_reset_turn_id: null,
    },
    model: "claude-sonnet-5",
    spec: testSpecSource(),
    cost_usd: 0,
    provider_tokens: 0,
    repo_url: "https://example.invalid/app.git",
    branch: "main",
    repository_mode: "repository",
    github_policy_source: "release",
    auto_model_migration: true,
  };
}

describe("attached repositories in a session read", () => {
  const withDocs = testCatalog({
    connections: catalog.connections,
    repositories: {
      ...catalog.repositories,
      docs: {
        url: "https://github.com/acme/docs.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
      tools: {
        url: "file:///srv/git/tools.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
    },
  });
  const read = async (ids: string[] | null) => {
    const record = {
      ...sessionOn(),
      attached_repository_ids: ids,
    };
    const { service, caller } = setup({
      catalog: withDocs,
      session: record,
      // The list reads the same record; the detail-only fields are ignored.
      listed: [record as unknown as SessionRecord],
    });
    return {
      detail: await service.getSession(caller, SESSION),
      listed: (
        await service.listSessions(caller, listSessionsQuerySchema.parse({}))
      ).items[0],
    };
  };

  test("name each id from the catalog, in id order, in both reads", async () => {
    const { detail, listed } = await read(["tools", "docs"]);
    const expected = [
      { id: "docs", full_name: "acme/docs" },
      { id: "tools", full_name: "tools" },
    ];
    expect(detail.attached_repositories).toEqual(expected);
    expect(listed?.attached_repositories).toEqual(expected);
  });

  test("none attached reads [], a list the session does not hold reads absent", async () => {
    const none = await read([]);
    expect(none.detail.attached_repositories).toEqual([]);
    expect(none.listed?.attached_repositories).toEqual([]);
    const unknown = await read(null);
    expect("attached_repositories" in unknown.detail).toBe(false);
    expect(unknown.listed && "attached_repositories" in unknown.listed).toBe(
      false,
    );
  });
});

// Session records keep the repo_url they started with, so moving the example
// repository to another host or path would strand every one of them.
describe("a session recorded on the example git host", () => {
  const RECORDED = "http://fake-git:3000/agent/sample-app.git";
  const root = join(import.meta.dir, "../../../..");

  test.each(["real-model", "fake-model", "local-model"])(
    "keeps running under %s",
    async (name) => {
      const { repositories } = (await Bun.file(
        join(root, "tests/fixtures/settings", `${name}.json`),
      ).json()) as {
        repositories: Record<string, { url: string; branch: string }>;
      };
      const example = repositories["sample-app"];
      if (example === undefined) throw new Error(`${name} has no sample-app`);
      const { service, caller } = setup({
        catalog: testCatalog({
          connections: catalog.connections,
          repositories: {
            app: { ...example, auth: { kind: "github_app", registered: true } },
          },
        }),
        session: { ...sessionOn(), repo_url: RECORDED },
      });
      const { attention } = await service.getSession(caller, SESSION);
      expect(attention).toBeNull();
    },
  );
});

describe("a session pinned to a release whose card declares variables", () => {
  const pinned = { ...body, agent_release_id: "rel-1" };

  test("the acceptance is handed the declared names", async () => {
    const { service, caller, accepted } = setup({
      envNames: ["REGION", "TEAM"],
    });
    await service.createSession(caller, { idempotencyKey: "k", body: pinned });
    expect(accepted[0]?.envNames).toEqual(["REGION", "TEAM"]);
  });

  test("a card that declares none, or a deployment that cannot read them, hands over nothing", async () => {
    for (const options of [{ envNames: [] }, {}]) {
      const { service, caller, accepted } = setup(options);
      await service.createSession(caller, {
        idempotencyKey: "k",
        body: pinned,
      });
      expect(Object.keys(accepted[0] ?? {})).not.toContain("envNames");
    }
  });

  test("a name with no value is 409 VARIABLE_UNRESOLVED that names the administrators, never the name", async () => {
    const admins: AgentContact[] = [
      {
        userId: "019a0000-0000-7000-8000-0000000000a2",
        displayName: "관리자",
        email: "admin@example.invalid",
      },
    ];
    const { service, caller } = setup({
      envNames: ["SECRET_REGION_NAME"],
      accept: "variables_refused",
      contacts: admins,
    });
    const error = await service
      .createSession(caller, { idempotencyKey: "k", body: pinned })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionServiceError);
    expect(error).toMatchObject({
      code: "VARIABLE_UNRESOLVED",
      details: {
        reason_code: "variable_unresolved",
        agent_id: AGENT,
        admins: [
          {
            user_id: admins[0]?.userId,
            display_name: "관리자",
            email: "admin@example.invalid",
          },
        ],
        admin_link: "mailto:admin%40example.invalid",
      },
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_REGION_NAME");
    expect((error as Error).message).not.toContain("SECRET_REGION_NAME");
  });
});
