import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import type { SessionCatalogView } from "../catalog/catalog.ts";
import type {
  ExtensionAttachment,
  ExtensionBundle,
} from "../extensions/ports/extension-bundle-store.ts";
import {
  checkAgentExtensions,
  resolveSessionExtensions,
  type SessionExtensionsDeps,
} from "../extensions/session-extensions.ts";
import { SessionServiceError } from "../musterrolle/index.ts";
import {
  callerFor,
  createAuthorizationPolicy,
  noAgentAuthority,
} from "../musterrolle/policy.ts";
import { testCatalog, testSpecSource } from "../testing/catalog-fakes.ts";
import type {
  AcceptSessionInput,
  SessionDetailRecord,
} from "./ports/session-unit-of-work.ts";
import { createSessionService } from "./session-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";

const catalog = testCatalog({
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

function bundle(
  n: number,
  name: string,
  opts: { scripts?: boolean; review?: ExtensionBundle["review"] } = {},
): ExtensionBundle {
  return {
    id: `019a0000-0000-7000-8000-0000000e00${n.toString().padStart(2, "0")}`,
    workspaceId: WORKSPACE,
    name,
    digest: n.toString(16).padStart(2, "0").repeat(32),
    label: name,
    source: "upload",
    git: null,
    sizeBytes: 10,
    manifest: {
      schema: 1,
      slug: name,
      skills: [{ name: "review", has_scripts: opts.scripts === true }],
    },
    review: opts.review ?? "approved",
    registeredBy: MEMBER,
    registeredAt: new Date(0),
    reviewedBy: MEMBER,
    reviewedAt: new Date(0),
    version: null,
    archivedAt: null,
    current: false,
  };
}

const lint = bundle(1, "lint");
const tools = bundle(2, "tools", { scripts: true });
const docs = bundle(3, "docs");

function extensionDeps(
  attachments: ExtensionAttachment[],
  skills = true,
): SessionExtensionsDeps {
  const all = [
    lint,
    tools,
    docs,
    ...attachments.flatMap((a) => (a.bundle === null ? [] : [a.bundle])),
  ];
  return {
    store: {
      async find(_workspaceId, id) {
        return all.find((b) => b.id === id) ?? null;
      },
      async listAttachments() {
        return attachments;
      },
    },
    skillCalling: () =>
      skills ? { tool: "Skill", names: "bundle_qualified" as const } : null,
  };
}

const attach = (
  bundle: ExtensionBundle,
  mode: ExtensionAttachment["mode"],
  scope: ExtensionAttachment["scope"] = "agent",
): ExtensionAttachment => ({
  scope,
  mode,
  name: bundle.name,
  follows: false,
  bundle,
  availability: "ok",
});

const unreached = async () => {
  throw new Error("not reached");
};

function setup(options: {
  extensions?: SessionExtensionsDeps;
  accept?: "accepted" | "replayed";
  session?: SessionDetailRecord;
  releaseTools?: string[];
  catalog?: SessionCatalogView;
}) {
  const accepted: AcceptSessionInput[] = [];
  const policy = createAuthorizationPolicy({
    // The caller is on the agent's managing team.
    agents: { ...noAgentAuthority, isInside: async () => true },
    credentials: { unboundRefs: async () => [] },
  });
  const service = createSessionService({
    authorization: policy,
    catalog: options.catalog ?? catalog,
    releases: {
      agentGitHubSettings: async () => null,
      repositoryCeiling: async () => ({
        repository_ids: ["app"],
        github_app_repositories: "listed",
      }),
      notRunnableReason: async () => null,
      async resolveRelease(_workspaceId, releaseId) {
        return {
          id: releaseId,
          agent_id: AGENT,
          approved_at: "2026-01-01T00:00:00.000Z",
          connection_id: "conn-1",
          repository_id: null,
          runtime_config_snapshot: {
            model: "claude-sonnet-5",
            runtime: { kind: "claude_agent_sdk", version: "0.3.270" },
          },
          effective_tools: {
            tools: options.releaseTools ?? ["Read", "Skill"],
            mcp: [],
          },
          policy_pins: {},
        };
      },
    },
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
    inputs: {
      async acceptInputAtomic(input) {
        accepted.push(input);
        if (input.extensionsRefused && options.accept !== "replayed") {
          return { outcome: "unsupported" };
        }
        return {
          outcome: options.accept ?? "accepted",
          response: {
            session_id: "019a0000-0000-7000-8000-00000000e0a1",
            turn_id: "1",
            receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
            receipt_status: "accepted",
            status: "queued",
            ...(input.extensions && input.extensions.length > 0
              ? { extensions: input.extensions }
              : {}),
          },
        };
      },
      appendInputAtomic: unreached,
    },
    controls: {
      terminateAtomic: unreached,
      pauseAtomic: unreached,
      closeAtomic: unreached,
      decideRecoveryAtomic: unreached,
      resumeAtomic: unreached,
      renameAtomic: unreached,
    },
    reader: {
      listSessions: unreached,
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
  return { service, caller, accepted };
}

const body = {
  agent_release_id: "rel-1",
  repository_id: "app",
  message: "hi",
} as const;

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionServiceError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a release whose tools do not list Skill", () => {
  test("refuses a session that resolves a bundle, saying what to edit", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([attach(lint, "required")]),
      releaseTools: ["Read"],
    });
    const error = await refusalOf(
      service.createSession(caller, { idempotencyKey: "k", body }),
    );
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.details).toMatchObject({
      reason_code: "skill_tool_not_allowed",
      bundle: "lint",
    });
    expect(error.message).toContain("this release's tools do not list it");
  });

  test("still runs a session with no bundles", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([]),
      releaseTools: ["Read"],
    });
    await service.createSession(caller, { idempotencyKey: "k", body });
    expect(accepted[0]?.extensions).toEqual([]);
  });
});

describe("POST /v1/sessions resolves extensions once", () => {
  test("a server without the dependency runs with none and stores nothing", async () => {
    const { service, caller, accepted } = setup({});
    await service.createSession(caller, { idempotencyKey: "k", body });
    expect(accepted[0]?.extensions).toBeUndefined();
    expect(accepted[0]?.extensionsRefused).toBeUndefined();
  });

  test("a required bundle of the agent is stored and returned", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([attach(lint, "required")]),
    });
    const response = await service.createSession(caller, {
      idempotencyKey: "k",
      body,
    });
    expect(accepted[0]?.extensions).toEqual([
      {
        bundle_id: lint.id,
        name: "lint",
        digest: lint.digest,
        scope: "agent",
      },
    ]);
    expect(response.extensions).toEqual(accepted[0]?.extensions);
  });

  test("a session with no bundles stores an empty list, not null", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([]),
    });
    const response = await service.createSession(caller, {
      idempotencyKey: "k",
      body,
    });
    expect(accepted[0]?.extensions).toEqual([]);
    expect(response.extensions).toBeUndefined();
  });

  test("the request turns an optional bundle on", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([attach(docs, "optional")]),
    });
    await service.createSession(caller, {
      idempotencyKey: "k",
      body: { ...body, extensions: { enable: [docs.id] } },
    });
    expect(accepted[0]?.extensions?.map((e) => [e.name, e.scope])).toEqual([
      ["docs", "session"],
    ]);
  });

  test("a forbidden or unoffered bundle cannot be turned on", async () => {
    const forbidden = setup({
      extensions: extensionDeps([attach(docs, "forbidden")]),
    });
    const error = await refusalOf(
      forbidden.service.createSession(forbidden.caller, {
        idempotencyKey: "k",
        body: { ...body, extensions: { enable: [docs.id] } },
      }),
    );
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.details).toMatchObject({
      reason_code: "forbidden_revived",
      bundle: "docs",
    });
    const unoffered = setup({ extensions: extensionDeps([]) });
    const other = await refusalOf(
      unoffered.service.createSession(unoffered.caller, {
        idempotencyKey: "k",
        body: { ...body, extensions: { enable: [lint.id] } },
      }),
    );
    expect(other.details).toMatchObject({ reason_code: "not_optional" });
  });

  test("a bundle of another workspace is not found", async () => {
    const { service, caller } = setup({ extensions: extensionDeps([]) });
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body: {
          ...body,
          extensions: { enable: ["019a0000-0000-7000-8000-0000000e0fff"] },
        },
      }),
    );
    expect(error.details).toMatchObject({ reason_code: "bundle_not_found" });
  });

  test("an approved scripted skill runs: its review lets it", async () => {
    const ok = setup({
      extensions: extensionDeps([attach(tools, "required")]),
    });
    await ok.service.createSession(ok.caller, { idempotencyKey: "k", body });
    expect(ok.accepted[0]?.extensions?.[0]?.name).toBe("tools");
  });

  test("a runtime that offers no skills refuses a bundle with skills", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([attach(lint, "required")], false),
    });
    const error = await refusalOf(
      service.createSession(caller, { idempotencyKey: "k", body }),
    );
    expect(error.details).toMatchObject({ reason_code: "feature_unsupported" });
  });

  test("a refusal still lets a replay of an earlier acceptance through", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([attach(lint, "required")]),
      accept: "replayed",
      releaseTools: ["Read"],
    });
    const response = await service.createSession(caller, {
      idempotencyKey: "k",
      body,
    });
    expect(accepted[0]?.extensionsRefused).toBe(true);
    expect(response.status).toBe("queued");
  });

  test("a request that names bundles on a server without the dependency is refused", async () => {
    const { service, caller } = setup({});
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, extensions: { enable: [lint.id] } },
      }),
    );
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
  });
});

describe("what is offered", () => {
  test("a bundle that is not approved is never offered; a required one refuses", async () => {
    const pending = bundle(4, "pending", { review: "pending" });
    const optional = await resolveSessionExtensions(
      extensionDeps([attach(pending, "optional")]),
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        runtimeKind: "claude_agent_sdk",
        tools: ["Read", "Skill"],
      },
    );
    expect(optional).toEqual({ ok: true, extensions: [] });
    const required = await resolveSessionExtensions(
      extensionDeps([attach(pending, "required")]),
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        runtimeKind: "claude_agent_sdk",
        tools: ["Read", "Skill"],
      },
    );
    expect(required.ok === false && required.refusal.code).toBe(
      "bundle_not_approved",
    );
  });

  test("a following attachment runs the current version a new session sees; with none, a required one refuses", async () => {
    const v1 = { ...bundle(5, "review"), version: 1, current: true };
    const v2 = { ...bundle(6, "review"), version: 2, current: true };
    const following: ExtensionAttachment = {
      scope: "workspace",
      mode: "required",
      name: "review",
      follows: true,
      bundle: v1,
      availability: "ok",
    };
    const attachments = [following];
    const { service, caller, accepted } = setup({
      extensions: extensionDeps(attachments),
    });
    await service.createSession(caller, { idempotencyKey: "k1", body });
    attachments[0] = { ...following, bundle: v2 };
    await service.createSession(caller, { idempotencyKey: "k2", body });
    expect(accepted.map((one) => one.extensions?.[0]?.digest)).toEqual([
      v1.digest,
      v2.digest,
    ]);

    const input = {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      runtimeKind: "claude_agent_sdk" as const,
      tools: ["Read", "Skill"],
    };
    const none = { ...following, bundle: null };
    const required = await resolveSessionExtensions(
      extensionDeps([none]),
      input,
    );
    expect(required.ok === false && required.refusal.code).toBe(
      "no_current_version",
    );
    expect(
      await resolveSessionExtensions(
        extensionDeps([{ ...none, mode: "optional" }]),
        input,
      ),
    ).toEqual({ ok: true, extensions: [] });
  });

  test("a workspace requirement the agent cannot drop is refused at create", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([
        attach(lint, "required", "workspace"),
        attach(lint, "forbidden", "agent"),
      ]),
    });
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body,
      }),
    );
    expect(error.details).toMatchObject({ reason_code: "required_removed" });
  });
});

describe("activation judges every bundle a session could turn on", () => {
  const input = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    runtimeKind: "claude_agent_sdk",
    tools: ["Read", "Skill"],
  } as const;

  test("an optional scripted bundle does not block activation: the release's mode is not asked", async () => {
    const deps = extensionDeps([attach(tools, "optional")]);
    const result = await checkAgentExtensions(deps, input);
    expect(result.ok).toBe(true);
  });

  test("a release whose tools lack Skill blocks activation for a bundle with skills, and one without bundles is untouched", async () => {
    const withoutSkill = { ...input, tools: ["Read"] };
    const blocked = await checkAgentExtensions(
      extensionDeps([attach(lint, "optional")]),
      withoutSkill,
    );
    expect(blocked.ok === false && blocked.refusal.code).toBe(
      "skill_tool_not_allowed",
    );
    const none = await checkAgentExtensions(extensionDeps([]), withoutSkill);
    expect(none.ok).toBe(true);
  });

  test("a workspace requirement the agent re-versions blocks activation", async () => {
    const lintV2 = { ...bundle(5, "lint"), digest: "ee".repeat(32) };
    const result = await checkAgentExtensions(
      extensionDeps([
        attach(lint, "required", "workspace"),
        attach(lintV2, "required", "agent"),
      ]),
      input,
    );
    expect(result.ok === false && result.refusal.code).toBe(
      "required_replaced",
    );
  });
});

describe("a skill of a registered repository that is switched off or withdrawn", () => {
  const off = (
    one: ExtensionBundle,
    mode: ExtensionAttachment["mode"],
    availability: ExtensionAttachment["availability"],
    scope: ExtensionAttachment["scope"] = "agent",
  ): ExtensionAttachment => ({ ...attach(one, mode, scope), availability });

  test("a new session starts without it, required, optional, following or pinned; the rest resolve as before", async () => {
    for (const availability of ["hidden", "withdrawn"] as const) {
      const following: ExtensionAttachment = {
        scope: "agent",
        mode: "required",
        name: "review",
        follows: true,
        bundle: null,
        availability,
      };
      const { service, caller, accepted } = setup({
        extensions: extensionDeps([
          off(lint, "required", availability),
          off(tools, "optional", availability),
          following,
          attach(docs, "required"),
        ]),
      });
      await service.createSession(caller, { idempotencyKey: "k", body });
      expect(accepted[0]?.extensions).toEqual([
        {
          bundle_id: docs.id,
          name: "docs",
          digest: docs.digest,
          scope: "agent",
        },
      ]);
    }
  });

  test("a stale new-session screen that turns one on is refused, not run without it", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([off(docs, "optional", "hidden")]),
    });
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, extensions: { enable: [docs.id] } },
      }),
    );
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.details).toMatchObject({
      reason_code: "not_optional",
      bundle: "docs",
    });
    expect(accepted[0]?.extensionsRefused).toBe(true);
  });

  test("forbidding it still holds", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([
        off(docs, "forbidden", "withdrawn", "workspace"),
        attach(docs, "optional"),
      ]),
    });
    const error = await refusalOf(
      service.createSession(caller, { idempotencyKey: "k", body }),
    );
    expect(error.details).toMatchObject({ reason_code: "forbidden_revived" });
  });

  test("activation does not judge it: a release without Skill activates", async () => {
    const input = {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      runtimeKind: "claude_agent_sdk",
      tools: ["Read"],
    } as const;
    for (const availability of ["hidden", "withdrawn"] as const) {
      const skipped = await checkAgentExtensions(
        extensionDeps([
          off(lint, "required", availability),
          off(tools, "optional", availability),
        ]),
        input,
      );
      expect(skipped).toEqual({ ok: true, extensions: [] });
    }
    const judged = await checkAgentExtensions(
      extensionDeps([attach(lint, "required")]),
      input,
    );
    expect(judged.ok === false && judged.refusal.code).toBe(
      "skill_tool_not_allowed",
    );
  });
});

describe("the session view shows what the engine runs", () => {
  const SESSION = "019a0000-0000-7000-8000-00000000d0a2";
  const detailOn = (spec: ReturnType<typeof testSpecSource> | null) =>
    ({
      id: SESSION,
      revision: 1,
      admission_state: "active",
      status: "idle",
      repository_id: "app",
      repo_url: "https://example.invalid/app.git",
      branch: "main",
      repository_mode: "repository",
      github_policy_source: "release",
      model: "claude-sonnet-5",
      spec,
      extensions: [],
    }) as unknown as SessionDetailRecord;

  // Before, a spec recorded as default showed default.
  test("the spec's runtime, connection and model, and the mode its model runs", async () => {
    for (const mode of ["default", "auto"] as const) {
      const { service, caller } = setup({
        session: detailOn(testSpecSource({ permission_mode: mode })),
      });
      expect((await service.getSession(caller, SESSION)).runtime).toEqual({
        kind: "claude_agent_sdk",
        version: "0.3.270",
        connection_id: "conn-1",
        model: "claude-sonnet-5",
        permission_mode: "auto",
      });
    }
  });

  test("a session without a spec shows none", async () => {
    const { service, caller } = setup({ session: detailOn(null) });
    expect((await service.getSession(caller, SESSION)).runtime).toBeNull();
  });
});
