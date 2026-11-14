import {
  type AgentCard,
  type AgentCardRequest,
  type AgentDetail,
  type AgentMcpSettings,
  type AgentRelease,
  type AgentVersion,
  type ConnectionOption,
  CREDENTIAL_REVOKE_NOTICE,
  type CredentialBindingView,
  type TeamView,
} from "@werft-ai/contracts";
import {
  agentEngineSettings,
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
  capabilities: { mcp: null, forbidden: [] },
  rules: [],
};

const sha = (n: number) => n.toString(16).padStart(64, "0");
const bindingId = (n: number) =>
  `9e0f1a2b-3c4d-4e5f-8a6b-${n.toString(16).padStart(12, "0")}`;

/** The connections the fake offers: the second runs only the smaller model. */
export const CONNECTIONS: ConnectionOption[] = [
  {
    id: "anthropic-main",
    kind: "anthropic",
    billing: "metered",
    models: ["claude-haiku-5", "claude-sonnet-5"],
    model_successors: {},
  },
  {
    id: "anthropic-fast",
    kind: "anthropic",
    billing: "metered",
    models: ["claude-haiku-5"],
    model_successors: {},
  },
];

/**
 * The agents API as one stateful server: two tabs on the same server see
 * each other's writes, and activation is a compare-and-swap on the revision
 * exactly as the real route does it.
 */
export function agentServer({
  description: initialDescription = null,
  afterActivate,
  releaseRefusal,
  activity = [],
  releaseRepository = null,
  mcpSettings,
  availableServers = ["docs", "wiki"],
}: {
  mcpSettings?: AgentMcpSettings;
  availableServers?: readonly string[];
  description?: string | null;
  afterActivate?: (release: AgentRelease) => void;
  releaseRefusal?: string;
  activity?: readonly unknown[];
  releaseRepository?: string | null;
} = {}) {
  const versions: AgentVersion[] = [version(1, CARD)];
  let name = "결제 담당";
  let description = initialDescription;
  let team: TeamView = TEAM;
  const releases: AgentRelease[] = [];
  const bindings: CredentialBindingView[] = [];
  let mcpRow: { settings: AgentMcpSettings; revision: number } | null =
    mcpSettings === undefined ? null : { settings: mcpSettings, revision: 1 };
  let active: string | null = null;
  let revision = -1;
  let draftId: string | null = null;
  let draftConnection = "anthropic-main";

  function saveRelease(body: { connection_id: string }, versionId: string) {
    const card = versions.find((v) => v.id === versionId)?.card;
    const connection = CONNECTIONS.find((c) => c.id === body.connection_id);
    draftConnection = body.connection_id;
    const refusal =
      releaseRefusal ??
      (connection === undefined
        ? "connection_unknown"
        : card !== undefined && !connection.models.includes(card.model)
          ? "model_not_in_connection"
          : null);
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
    const id = `rel-${versionId.slice(0, 8)}`;
    if (!releases.some((r) => r.id === id)) {
      releases.push(
        seedRelease(releases.length, {
          id,
          versionId,
          model: card?.model ?? "claude-sonnet-5",
          connection: body.connection_id,
          repositoryId: releaseRepository,
        }),
      );
    }
    previousActive = active;
    active = id;
    revision += 1;
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
        managing_team_id: team.id,
        managing_team_name: team.name,
        status: "active",
        active_release_id: active,
        activation_revision: revision,
        auto_model_migration: true,
        created_by: USER_ID,
        created_at: "2026-10-11T00:00:00.000Z",
        updated_at: "2026-10-11T00:00:00.000Z",
      },
      versions: [...versions],
      releases: [...releases],
      active_release: releases.find((r) => r.id === active) ?? null,
      behavior_revision: 0,
      draft: draftId
        ? {
            version_id: draftId,
            connection_id: draftConnection,
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
    "GET /v1/connections": () => json(200, { items: CONNECTIONS }),
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
        connection_id?: string;
      };
      if (
        body.managing_team_id !== undefined &&
        body.managing_team_id !== TEAM.id
      )
        return apiError(422, "TEAM_NOT_ALLOWED", "Team not allowed");
      versions.splice(0, versions.length, version(1, body.card));
      name = body.name;
      description = body.description ?? null;
      team = TEAM;
      const release =
        body.connection_id === undefined
          ? {
              status: "unchanged" as const,
              reason: null,
              release_id: null,
              version_id: null,
            }
          : saveRelease(
              { connection_id: body.connection_id },
              versions[0]?.id ?? "",
            );
      return json(201, { ...detail(), release });
    },
    [`GET ${path}/github/activity`]: () => json(200, { items: activity }),
    [`PUT ${path}/managing-team`]: async (request: Request) => {
      const body = (await request.json()) as { team_id: string };
      if (body.team_id !== TEAM.id)
        return apiError(422, "TEAM_NOT_ALLOWED", "Team not allowed");
      const changed = team.id !== body.team_id;
      team = TEAM;
      return json(200, {
        agent: detail().agent,
        receipt_id: changed ? RECEIPT_ID : null,
      });
    },
    [`GET ${path}`]: () => json(200, detail()),
    [`GET ${path}/admins`]: () => json(200, { users: [], teams: [] }),
    [`GET ${path}/engine-settings`]: () => json(200, agentEngineSettings()),
    [`GET ${path}/mcp/settings`]: () => {
      const settings = mcpRow?.settings ?? {
        server: null,
        allowed_tools: [],
        credential_refs: [],
      };
      const live = new Set(
        bindings.filter((b) => !b.revoked_at).map((b) => b.credential_ref),
      );
      return json(200, {
        source: mcpRow === null ? "release" : "agent",
        settings,
        settings_revision: mcpRow?.revision ?? null,
        active_release_id: active,
        bound_credential_refs: settings.credential_refs.filter((ref) =>
          live.has(ref),
        ),
        available_servers: [...availableServers],
      });
    },
    [`PUT ${path}/mcp/settings`]: async (request: Request) => {
      const body = (await request.json()) as {
        expected_revision: number | null;
        settings: AgentMcpSettings;
      };
      if (body.expected_revision !== (mcpRow?.revision ?? null))
        return apiError(409, "REVISION_CONFLICT", "The settings changed");
      mcpRow = {
        settings: body.settings,
        revision: (mcpRow?.revision ?? 0) + 1,
      };
      return json(200, {
        settings_revision: mcpRow.revision,
        receipt_id: RECEIPT_ID,
      });
    },
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
        connection_id?: string;
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
      if (body.connection_id !== undefined) {
        const release = saveRelease(
          { connection_id: body.connection_id },
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
      const named = [
        ...new Set([
          ...(versions.find(
            (v) =>
              v.id ===
              releases.find((r) => r.id === body.release_id)?.version_id,
          )?.card.capabilities.credential_refs ?? []),
          ...(mcpRow?.settings.credential_refs ?? []),
        ]),
      ];
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
      if (target) afterActivate?.(target);
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
    connection = "anthropic-main",
    model = "claude-sonnet-5",
    createdBy = USER_ID,
    repositoryId = null,
  }: {
    id?: string;
    versionId?: string;
    connection?: string;
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
    connection_id: connection,
    repository_id: repositoryId,
    runtime_config_snapshot: { model },
    effective_tools: { tools: ["Read"], mcp: [] },
    policy_pins: {},
    created_by: createdBy,
    created_at: `2026-10-11T01:0${n}:00.000Z`,
    approved_by: null,
    approved_at: null,
    label: `2026-10-11_10:0${n}:00`,
    activated_at: null,
    deactivated_at: null,
  };
}
