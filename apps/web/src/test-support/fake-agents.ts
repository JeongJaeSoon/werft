import {
  type AgentCard,
  type AgentCardRequest,
  type AgentDetail,
  type AgentRelease,
  type AgentVersion,
  CREDENTIAL_REVOKE_NOTICE,
  type CredentialBindingView,
  type ProfileSummary,
  type TeamView,
} from "@werft-ai/contracts";
import {
  apiError,
  json,
  RECEIPT_ID,
  USER_ID,
  WORKSPACE_ID,
} from "./fake-api.ts";

export const AGENT_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
export const TEAM_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
export const TEAM: TeamView = {
  id: TEAM_ID,
  workspace_id: WORKSPACE_ID,
  name: "재무",
  member_count: 2,
  created_by: USER_ID,
  created_at: "2026-10-01T00:00:00.000Z",
  revision: 1,
};
const VERSION_IDS = [
  "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
  "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  "8d9e0f1a-2b3c-4d4e-9f5a-6b7c8d9e0f1a",
];

/** A card as the console writes it: no role or instructions. */
export const CARD: AgentCardRequest = {
  language: "ko",
  model: "claude-sonnet-5",
  capabilities: { tools: null, mcp: null, forbidden: [] },
  rules: [],
};

const sha = (n: number) => n.toString(16).padStart(64, "0");
const bindingId = (n: number) =>
  `9e0f1a2b-3c4d-4e5f-8a6b-${n.toString(16).padStart(12, "0")}`;

/**
 * The agents API as one stateful server: two tabs on the same server see
 * each other's writes, and activation is a compare-and-swap on the revision
 * exactly as the real route does it.
 */
export function agentServer({
  repositoryMode = "optional",
  description: initialDescription = null,
  tracking: initialTracking = "follow",
  modelSource: initialModelSource = "fixed",
  afterActivate,
  releaseRefusal,
  activity = [],
  releaseRepository = null,
}: {
  repositoryMode?: ProfileSummary["repository_mode"];
  description?: string | null;
  tracking?: "follow" | "pinned";
  modelSource?: "fixed" | "profile";
  afterActivate?: (release: AgentRelease) => {
    tracking?: "follow" | "pinned";
    modelSource?: "fixed" | "profile";
  };
  releaseRefusal?: string;
  activity?: readonly unknown[];
  releaseRepository?: string | null;
} = {}) {
  const versions: AgentVersion[] = [version(1, CARD)];
  let name = "결제 담당";
  let description = initialDescription;
  let team: TeamView | null = null;
  const releases: AgentRelease[] = [];
  const bindings: CredentialBindingView[] = [];
  let active: string | null = null;
  let revision = -1;
  let draftId: string | null = null;
  let tracking = initialTracking;
  let modelSource = initialModelSource;

  function saveRelease(
    body: { runtime_profile_id: string; model_source?: "fixed" | "profile" },
    versionId: string,
  ) {
    const refusal =
      releaseRefusal ??
      (/^(claude-coding-|ws_)/.test(body.runtime_profile_id)
        ? null
        : "profile_unknown");
    if (refusal !== null) {
      draftId = versionId;
      return {
        status: "failed" as const,
        reason: refusal,
        release_id: null,
        version_id: versionId,
      };
    }
    draftId = null;
    const card = versions.find((v) => v.id === versionId)?.card;
    const id = `rel-${versionId.slice(0, 8)}`;
    if (!releases.some((r) => r.id === id)) {
      releases.push(
        seedRelease(releases.length, {
          id,
          versionId,
          model: card?.model ?? "claude-sonnet-5",
          profile: body.runtime_profile_id,
          repositoryId: releaseRepository,
        }),
      );
    }
    previousActive = active;
    active = id;
    revision += 1;
    modelSource = body.model_source ?? modelSource;
    stamp(revision);
    return {
      status: "applied" as const,
      reason: null,
      release_id: id,
      version_id: versionId,
    };
  }
  let previousActive: string | null = null;
  function stamp(rev: number) {
    const at = `2026-10-11T02:0${rev}:00.000Z`;
    for (const release of releases) {
      if (release.id === previousActive) release.deactivated_at = at;
      if (release.id === active) {
        release.activated_at = at;
        release.deactivated_at = null;
      }
    }
  }

  function version(no: number, card: AgentCard): AgentVersion {
    return {
      id: VERSION_IDS[no - 1] ?? crypto.randomUUID(),
      agent_id: AGENT_ID,
      version_no: no,
      card,
      content_sha256: sha(no),
      created_by: USER_ID,
      created_at: `2026-10-11T00:0${no}:00.000Z`,
    };
  }

  function detail(): AgentDetail {
    return {
      agent: {
        id: AGENT_ID,
        workspace_id: WORKSPACE_ID,
        slug: "billing",
        name,
        description,
        managing_team_id: team?.id ?? null,
        managing_team_name: team?.name ?? null,
        status: "active",
        active_release_id: active,
        activation_revision: revision,
        created_by: USER_ID,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
      },
      versions: [...versions],
      releases: [...releases],
      active_release: releases.find((r) => r.id === active) ?? null,
      behavior_revision: 0,
      model_source: modelSource,
      profile_tracking: tracking,
      draft: draftId
        ? {
            version_id: draftId,
            runtime_profile_id: "claude-coding-local",
            model_source: "fixed",
            failure: "release_refused",
          }
        : null,
      effective_behavior: { applied: null, draft: null },
    };
  }

  const path = `/v1/agents/${AGENT_ID}`;
  const routes = {
    "GET /v1/agents": () =>
      json(200, { items: [detail().agent], next_cursor: null }),
    // Only claude-coding-local releases; the first one is refused, as when
    // the catalog changed under an open page.
    "GET /v1/profiles": () =>
      json(200, {
        items: [
          profile("claude-coding-fast", "claude-haiku-5", repositoryMode),
          profile("claude-coding-local", "claude-sonnet-5", repositoryMode),
        ],
      }),
    "GET /v1/teams": () => json(200, { items: [TEAM], next_cursor: null }),
    [`GET /v1/teams/${TEAM_ID}`]: () =>
      json(200, {
        ...TEAM,
        members: [
          {
            user_id: USER_ID,
            email: "owner@example.com",
            display_name: "Owner",
            role: "lead",
            added_by: USER_ID,
            added_at: "2026-10-01T00:00:00.000Z",
          },
        ],
      }),
    "GET /v1/my-teams": () =>
      json(200, {
        items: [{ id: TEAM.id, name: TEAM.name, role: "lead" }],
        next_cursor: null,
      }),
    // Creating the agent makes its first version from the card sent.
    "POST /v1/agents": async (request: Request) => {
      const body = (await request.json()) as {
        name: string;
        description?: string;
        managing_team_id?: string;
        card: AgentCard;
        runtime_profile_id?: string;
        model_source?: "fixed" | "profile";
      };
      if (
        body.managing_team_id !== undefined &&
        body.managing_team_id !== TEAM.id
      )
        return apiError(422, "TEAM_NOT_ALLOWED", "Team not allowed");
      versions.splice(0, versions.length, version(1, body.card));
      name = body.name;
      description = body.description ?? null;
      team = body.managing_team_id === undefined ? null : TEAM;
      const release =
        body.runtime_profile_id === undefined
          ? {
              status: "unchanged" as const,
              reason: null,
              release_id: null,
              version_id: null,
            }
          : saveRelease(
              {
                runtime_profile_id: body.runtime_profile_id,
                ...(body.model_source
                  ? { model_source: body.model_source }
                  : {}),
              },
              versions[0]?.id ?? "",
            );
      return json(201, { ...detail(), release });
    },
    [`GET ${path}/github/activity`]: () => json(200, { items: activity }),
    [`PUT ${path}/managing-team`]: async (request: Request) => {
      const body = (await request.json()) as { team_id: string };
      if (body.team_id !== TEAM.id)
        return apiError(422, "TEAM_NOT_ALLOWED", "Team not allowed");
      const changed = team === null;
      team = TEAM;
      return json(200, {
        agent: detail().agent,
        receipt_id: changed ? RECEIPT_ID : null,
      });
    },
    [`GET ${path}`]: () => json(200, detail()),
    [`GET ${path}/admins`]: () => json(200, { users: [], teams: [] }),
    [`GET ${path}/credential-bindings`]: () =>
      json(200, {
        items: bindings.filter((b) => !b.revoked_at),
        revoke_notice: CREDENTIAL_REVOKE_NOTICE,
      }),
    [`POST ${path}/credential-bindings`]: async (request: Request) => {
      const { credential_ref } = (await request.json()) as {
        credential_ref: string;
      };
      const existing = bindings.find(
        (b) => b.credential_ref === credential_ref && !b.revoked_at,
      );
      if (existing)
        return json(200, {
          binding: existing,
          created: false,
          receipt_id: null,
        });
      const binding: CredentialBindingView = {
        id: bindingId(bindings.length),
        agent_id: AGENT_ID,
        credential_ref,
        bound_by: USER_ID,
        bound_at: "2026-10-11T02:00:00.000Z",
        revoked_at: null,
        running_sessions: 0,
      };
      bindings.push(binding);
      return json(200, { binding, created: true, receipt_id: RECEIPT_ID });
    },
    [`PATCH ${path}`]: async (request: Request) => {
      const body = (await request.json()) as {
        name?: string;
        description?: string | null;
        card?: AgentCard;
        runtime_profile_id?: string;
        model_source?: "fixed" | "profile";
      };
      if (body.name !== undefined) name = body.name;
      if (body.description !== undefined) description = body.description;
      const card = body.card;
      let fresh = false;
      let saved = versions.find(
        (v) => JSON.stringify(v.card) === JSON.stringify(card),
      );
      if (card && !saved) {
        saved = version(versions.length + 1, card);
        versions.push(saved);
        draftId = saved.id;
        fresh = true;
      }
      if (body.runtime_profile_id !== undefined) {
        const release = saveRelease(
          {
            runtime_profile_id: body.runtime_profile_id,
            ...(body.model_source ? { model_source: body.model_source } : {}),
          },
          saved?.id ?? versions.at(-1)?.id ?? "",
        );
        return json(200, { ...detail(), release });
      }
      return json(200, {
        ...detail(),
        release: fresh
          ? {
              status: "failed",
              reason: "release_refused",
              release_id: null,
              version_id: draftId,
            }
          : {
              status: "unchanged",
              reason: null,
              release_id: null,
              version_id: null,
            },
      });
    },
    [`POST ${path}/activate`]: async (request: Request) => {
      const body = (await request.json()) as {
        release_id: string;
        expected_revision: number;
      };
      if (body.expected_revision !== revision)
        return apiError(
          409,
          "REVISION_CONFLICT",
          "The agent was activated by someone else",
        );
      const named =
        versions.find(
          (v) =>
            v.id === releases.find((r) => r.id === body.release_id)?.version_id,
        )?.card.capabilities.credential_refs ?? [];
      const bound = new Set(
        bindings.filter((b) => !b.revoked_at).map((b) => b.credential_ref),
      );
      const missing = named.filter((ref) => !bound.has(ref));
      if (missing.length > 0)
        return json(409, {
          error: {
            code: "CREDENTIAL_UNBOUND",
            message: `Release uses credentials not bound to this agent: ${missing.join(", ")}`,
            retryable: false,
            request_id: "req-1",
            details: { reason_code: "credential_unbound", missing },
          },
        });
      const previous = active;
      if (previous === body.release_id)
        return json(200, {
          active_release_id: previous,
          previous_release_id: previous,
          activation_revision: revision,
          receipt_id: null,
        });
      active = body.release_id;
      revision += 1;
      previousActive = previous;
      stamp(revision);
      const target = releases.find((r) => r.id === active);
      const changed = target ? afterActivate?.(target) : undefined;
      tracking = changed?.tracking ?? tracking;
      modelSource = changed?.modelSource ?? modelSource;
      return json(200, {
        active_release_id: active,
        previous_release_id: previous,
        activation_revision: revision,
        receipt_id: crypto.randomUUID(),
      });
    },
  };

  // The fake routes by exact path, so each id a bind can hand out gets one.
  for (let n = 0; n < 8; n += 1) {
    const id = bindingId(n);
    Object.assign(routes, {
      [`DELETE ${path}/credential-bindings/${id}`]: () => {
        const found = bindings.find((b) => b.id === id && !b.revoked_at);
        if (!found) return apiError(404, "NOT_FOUND", "Resource not found");
        found.revoked_at = "2026-10-11T03:00:00.000Z";
        return json(200, {
          binding: found,
          revoke_notice: CREDENTIAL_REVOKE_NOTICE,
          receipt_id: RECEIPT_ID,
        });
      },
    });
  }

  return { routes, detail, versions, releases, bindings };
}

export function seedRelease(
  n: number,
  {
    id = `rel-${n}`,
    versionId = VERSION_IDS[0] ?? "",
    profile = "claude-coding-local",
    model = "claude-sonnet-5",
    createdBy = USER_ID,
    repositoryId = null,
  }: {
    id?: string;
    versionId?: string;
    profile?: string;
    model?: string;
    createdBy?: string | null;
    repositoryId?: string | null;
  } = {},
): AgentRelease {
  return {
    id,
    agent_id: AGENT_ID,
    version_id: versionId,
    card_sha256: sha(n + 10),
    runtime_profile_id: profile,
    repository_id: repositoryId,
    profile_digest: "digest-1",
    runtime_config_snapshot: { model },
    effective_tools: { tools: ["Read"], mcp: [] },
    policy_pins: {},
    created_by: createdBy,
    created_at: `2026-10-11T01:0${n}:00.000Z`,
    approved_by: null,
    approved_at: null,
    note: null,
    label: `2026-10-11_10:0${n}:00`,
    activated_at: null,
    deactivated_at: null,
  };
}

function profile(
  id: string,
  model: string,
  repositoryMode: ProfileSummary["repository_mode"],
): ProfileSummary {
  return {
    id,
    source: "operator",
    model,
    models: [model],
    tools: ["Read"],
    permission_mode: "default",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: repositoryMode,
    repository_ids: ["sample-app"],
  };
}
