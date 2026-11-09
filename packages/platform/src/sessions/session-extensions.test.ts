import { describe, expect, test } from "bun:test";
import { scopesForRole } from "@werft-ai/contracts";
import {
  checkAgentExtensions,
  resolveSessionExtensions,
  type SessionExtensionsDeps,
} from "../extensions/session-extensions.ts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type {
  ExtensionAttachment,
  ExtensionBundle,
} from "../ports/extension-bundle-store.ts";
import type {
  AcceptSessionInput,
  SessionDetailRecord,
} from "../ports/session-unit-of-work.ts";
import { profileFingerprint, type SessionCatalog } from "./catalog.ts";
import { withSeededInstallation } from "./profile-registry.ts";
import {
  createSessionService,
  SessionServiceError,
} from "./session-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const MEMBER = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";

const base: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: [],
  tools: ["Read", "Skill"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "test",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const unattended = { ...base, permission_mode: "auto" as const };
const noSkill = { ...base, tools: ["Read"] };
const catalog: SessionCatalog = withSeededInstallation({
  profiles: {
    "coding-v1": base,
    "unattended-v1": unattended,
    "no-skill-v1": noSkill,
  },
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["coding-v1", "unattended-v1", "no-skill-v1"],
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
  };
}

const lint = bundle(1, "lint");
const tools = bundle(2, "tools", { scripts: true });
const docs = bundle(3, "docs");

function extensionDeps(
  attachments: ExtensionAttachment[],
  skills = true,
): SessionExtensionsDeps {
  const all = [lint, tools, docs, ...attachments.map((a) => a.bundle)];
  return {
    store: {
      async find(_workspaceId, id) {
        return all.find((b) => b.id === id) ?? null;
      },
      async listAttachments() {
        return attachments;
      },
    },
    offersSkills: () => skills,
  };
}

const attach = (
  bundle: ExtensionBundle,
  mode: ExtensionAttachment["mode"],
  scope: ExtensionAttachment["scope"] = "agent",
): ExtensionAttachment => ({ scope, mode, bundle });

const unreached = async () => {
  throw new Error("not reached");
};

function setup(options: {
  extensions?: SessionExtensionsDeps;
  accept?: "accepted" | "replayed";
  session?: SessionDetailRecord;
  changeProfile?: (input: { profile: unknown }) => unknown;
  releaseTools?: string[];
}) {
  const accepted: AcceptSessionInput[] = [];
  const policy = createAuthorizationPolicy({
    credentials: { unboundRefs: async () => [] },
  });
  const service = createSessionService({
    authorization: policy,
    catalog,
    releases: {
      agentGitHubSettings: async () => null,
      repositoryCeiling: async () => null,
      async resolveRelease(_workspaceId, releaseId) {
        return {
          id: releaseId,
          agent_id: AGENT,
          runtime_profile_id: "coding-v1",
          repository_id: null,
          runtime_config_snapshot: {
            tools: options.releaseTools ?? base.tools,
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
      changeProfileAtomic:
        (options.changeProfile as typeof unreached | undefined) ?? unreached,
      renameAtomic: unreached,
    },
    reader: {
      listSessions: unreached,
      countSessions: unreached,
      getSession: async () => options.session ?? null,
      listTurns: unreached,
      getTurn: unreached,
      getReceipt: unreached,
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
  profile_id: "coding-v1",
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

describe("a profile that does not list Skill", () => {
  test("refuses a session that resolves a bundle, saying what to edit", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([attach(lint, "required")]),
    });
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, profile_id: "no-skill-v1" },
      }),
    );
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.details).toMatchObject({
      reason_code: "skill_tool_not_allowed",
      bundle: "lint",
    });
    expect(error.message).toContain('Add "Skill" to the profile');
  });

  test("a release whose tool snapshot lacks Skill is refused though the profile lists it, as the claim would run the snapshot", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([attach(lint, "required")]),
      releaseTools: ["Read"],
    });
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, agent_release_id: "rel-1" },
      }),
    );
    expect(error.details).toMatchObject({
      reason_code: "skill_tool_not_allowed",
      bundle: "lint",
    });
  });

  test("a snapshot this image cannot read allows no tool, so it is refused too", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([attach(lint, "required")]),
      releaseTools: "garbled" as never,
    });
    const error = await refusalOf(
      service.createSession(caller, {
        idempotencyKey: "k",
        body: { ...body, agent_release_id: "rel-1" },
      }),
    );
    expect(error.details).toMatchObject({
      reason_code: "skill_tool_not_allowed",
    });
  });

  test("still runs a session with no bundles", async () => {
    const { service, caller, accepted } = setup({
      extensions: extensionDeps([]),
    });
    await service.createSession(caller, {
      idempotencyKey: "k",
      body: { ...body, profile_id: "no-skill-v1" },
    });
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
      body: { ...body, agent_release_id: "rel-1" },
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

  test("the profile fingerprint does not depend on the bundles", async () => {
    const none = setup({ extensions: extensionDeps([]) });
    await none.service.createSession(none.caller, {
      idempotencyKey: "k",
      body,
    });
    const some = setup({
      extensions: extensionDeps([attach(lint, "required", "workspace")]),
    });
    await some.service.createSession(some.caller, {
      idempotencyKey: "k",
      body,
    });
    expect(none.accepted[0]?.profileFingerprint).toBeDefined();
    expect(some.accepted[0]?.profileFingerprint).toBe(
      none.accepted[0]?.profileFingerprint,
    );
    expect(some.accepted[0]?.profileFingerprint).toBe(profileFingerprint(base));
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

  test("a scripted skill is refused on an unattended profile and passes on default", async () => {
    const deps = extensionDeps([attach(tools, "required")]);
    const auto = setup({ extensions: deps });
    const error = await refusalOf(
      auto.service.createSession(auto.caller, {
        idempotencyKey: "k",
        body: { ...body, profile_id: "unattended-v1" },
      }),
    );
    expect(error.details).toMatchObject({
      reason_code: "scripts_need_default_mode",
    });
    const ok = setup({ extensions: deps });
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
      extensions: extensionDeps([attach(tools, "required")]),
      accept: "replayed",
    });
    const response = await service.createSession(caller, {
      idempotencyKey: "k",
      body: { ...body, profile_id: "unattended-v1" },
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
        permissionMode: "default",
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
        permissionMode: "default",
        runtimeKind: "claude_agent_sdk",
        tools: ["Read", "Skill"],
      },
    );
    expect(required.ok === false && required.refusal.code).toBe(
      "bundle_not_approved",
    );
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
        body: { ...body, agent_release_id: "rel-1" },
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

  test("an optional scripted bundle blocks activation on an unattended profile", async () => {
    const deps = extensionDeps([attach(tools, "optional")]);
    const auto = await checkAgentExtensions(deps, {
      ...input,
      permissionMode: "auto",
    });
    expect(auto.ok === false && auto.refusal.code).toBe(
      "scripts_need_default_mode",
    );
    const ok = await checkAgentExtensions(deps, {
      ...input,
      permissionMode: "default",
    });
    expect(ok.ok).toBe(true);
  });

  test("a profile whose tools lack Skill blocks activation for a bundle with skills, and one without bundles is untouched", async () => {
    const withoutSkill = {
      ...input,
      tools: ["Read"],
      permissionMode: "default",
    };
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
      { ...input, permissionMode: "default" },
    );
    expect(result.ok === false && result.refusal.code).toBe(
      "required_replaced",
    );
  });
});

describe("a profile change judges the bundles the session is pinned to", () => {
  const SESSION = "019a0000-0000-7000-8000-00000000d0a1";
  const pinnedTo = (bundles: ExtensionBundle[]) =>
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
      profile_id: "coding-v1",
      model: "claude-sonnet-5",
      profile_fingerprint: null,
      extensions: bundles.map((b) => ({
        bundle_id: b.id,
        name: b.name,
        digest: b.digest,
        scope: "agent",
      })),
    }) as unknown as SessionDetailRecord;

  async function change(bundles: ExtensionBundle[], profile: string) {
    let sent: { profile: unknown } | null = null;
    const { service, caller } = setup({
      extensions: extensionDeps([]),
      session: pinnedTo(bundles),
      changeProfile: (input) => {
        sent = input;
        throw new Error("captured");
      },
    });
    await service
      .changeSessionProfile(caller, SESSION, {
        idempotencyKey: "k",
        body: { profile_id: profile, expected_revision: 1 },
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "captured") {
          throw error;
        }
      });
    if (sent === null) throw new Error("changeProfileAtomic was not reached");
    return (sent as { profile: { id: string } | null }).profile;
  }

  test("a scripted bundle accepted on default does not move to an unattended profile", async () => {
    expect(await change([tools], "unattended-v1")).toBeNull();
  });

  test("the refusal carries the same details as creation and activation", async () => {
    const { service, caller } = setup({
      extensions: extensionDeps([]),
      session: pinnedTo([lint]),
      changeProfile: (input) =>
        input.profile === null ? { outcome: "unsupported" } : { outcome: "ok" },
    });
    const error = await refusalOf(
      service.changeSessionProfile(caller, SESSION, {
        idempotencyKey: "k",
        body: { profile_id: "no-skill-v1", expected_revision: 1 },
      }),
    );
    expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
    expect(error.details).toEqual({
      reason_code: "skill_tool_not_allowed",
      bundle: "lint",
    });
  });

  test("a session pinned to bundles does not move to a profile without Skill", async () => {
    expect(await change([lint], "no-skill-v1")).toBeNull();
    expect((await change([], "no-skill-v1"))?.id).toBe("no-skill-v1");
  });

  test("the same session may change to a profile that still allows its bundles", async () => {
    expect((await change([lint], "unattended-v1"))?.id).toBe("unattended-v1");
    expect((await change([], "unattended-v1"))?.id).toBe("unattended-v1");
  });
});
