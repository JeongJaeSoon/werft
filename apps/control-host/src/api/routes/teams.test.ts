import { describe, expect, test } from "bun:test";
import {
  type AgentAdminsView,
  agentAdminChangeResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  type TeamView,
  teamChangeResponseSchema,
} from "@werft-ai/contracts";
import {
  type AgentAdminService,
  InvalidCursorError,
  SessionServiceError,
  type TeamService,
} from "@werft-ai/platform";
import { errorOf } from "../../test-support/api-error.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerTeamRoutes } from "./teams.ts";

const createApiApp = recordRouteErrors("routes/teams.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };

const TEAM_VIEW: TeamView = {
  id: TEAM,
  workspace_id: WORKSPACE,
  name: "research",
  member_count: 1,
  created_by: USER,
  created_at: "2026-10-11T00:00:00.000Z",
  revision: 1,
};
const ADMINS: AgentAdminsView = { users: [], teams: [] };

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const forbidden = async () => {
  throw new SessionServiceError("FORBIDDEN", "no", undefined, {
    reason_code: "role",
  });
};
const notFound = async () => {
  throw new SessionServiceError("NOT_FOUND", "Resource not found");
};
const taken = async () => {
  throw new SessionServiceError("ALREADY_EXISTS", "taken");
};

function app(
  teams: Partial<TeamService>,
  agentAdmins: Partial<AgentAdminService> = {},
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerTeamRoutes(
        router,
        teams as TeamService,
        agentAdmins as AgentAdminService,
      ),
  });
}

function call(
  api: ReturnType<typeof app>,
  method: string,
  path: string,
  body?: unknown,
) {
  return api.request(path, {
    method,
    headers: owner,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const PAD = "x".repeat(REQUEST_BODY_MAX_BYTES);

describe("POST /v1/teams", () => {
  test("creates, and every refusal maps to its status", async () => {
    let asked: unknown;
    const created = await call(
      app({
        createTeam: async (_caller, request) => {
          asked = request;
          return { team: TEAM_VIEW, receipt_id: RECEIPT };
        },
      }),
      "POST",
      "/v1/teams",
      { name: "  research " },
    );
    expect(created.status).toBe(201);
    expect(asked).toEqual({ name: "research" });
    expect(
      teamChangeResponseSchema.parse(await created.json()).receipt_id,
    ).toBe(RECEIPT);

    expect(
      (await call(app({}), "POST", "/v1/teams", { name: "" })).status,
    ).toBe(400);
    expect(
      (await call(app({}), "POST", "/v1/teams", { name: "x", pad: PAD }))
        .status,
    ).toBe(413);
    const refused = await call(
      app({ createTeam: forbidden }),
      "POST",
      "/v1/teams",
      { name: "x" },
    );
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    });
    const conflict = await call(
      app({ createTeam: taken }),
      "POST",
      "/v1/teams",
      {
        name: "x",
      },
    );
    expect(conflict.status).toBe(409);
    expect((await errorOf(conflict)).code).toBe("ALREADY_EXISTS");
    expect(
      (
        await call(app({ createTeam: outage }), "POST", "/v1/teams", {
          name: "x",
        })
      ).status,
    ).toBe(503);
  });
});

// Both team lists read a page and answer a bad query or cursor with 400.
async function pages(list: "listTeams" | "listMyTeams", path: string) {
  const queries: unknown[] = [];
  const paged = app({
    [list]: async (_caller: unknown, query: { cursor?: string }) => {
      queries.push(query);
      if (query.cursor === "forged") throw new InvalidCursorError();
      return { items: [], next_cursor: "next" };
    },
  });
  const listed = await call(paged, "GET", path);
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ items: [], next_cursor: "next" });
  expect((await call(paged, "GET", `${path}?limit=2&cursor=abc`)).status).toBe(
    200,
  );
  expect(queries).toEqual([{ limit: 50 }, { limit: 2, cursor: "abc" }]);
  for (const bad of ["?cursor=forged", "?limit=0", "?limit=101"]) {
    const response = await call(paged, "GET", `${path}${bad}`);
    expect(response.status, bad).toBe(400);
    expect((await errorOf(response)).code, bad).toBe("BAD_REQUEST");
  }
}

describe("GET /v1/teams", () => {
  test("reads a page; a bad query or cursor is 400", () =>
    pages("listTeams", "/v1/teams"));

  test("passes the trimmed q on and refuses an empty or too long one", async () => {
    const queries: unknown[] = [];
    const searched = app({
      listTeams: async (_caller: unknown, query: unknown) => {
        queries.push(query);
        return { items: [], next_cursor: null };
      },
    });
    expect(
      (await call(searched, "GET", "/v1/teams?q=%20Ops%25_%20")).status,
    ).toBe(200);
    expect(queries).toEqual([{ limit: 50, q: "Ops%_" }]);
    for (const bad of ["?q=", "?q=%20%20", `?q=${"a".repeat(201)}`]) {
      expect((await call(searched, "GET", `/v1/teams${bad}`)).status, bad).toBe(
        400,
      );
    }
  });

  test("lists, refuses and fails closed", async () => {
    const listed = await call(
      app({
        listTeams: async () => ({ items: [TEAM_VIEW], next_cursor: null }),
      }),
      "GET",
      "/v1/teams",
    );
    expect(listed.status).toBe(200);
    expect(
      (await call(app({ listTeams: forbidden }), "GET", "/v1/teams")).status,
    ).toBe(403);
    expect(
      (await call(app({ listTeams: outage }), "GET", "/v1/teams")).status,
    ).toBe(503);
  });
});

describe("GET /v1/teams/{team_id}", () => {
  test("reads a team with its members", async () => {
    const read = await call(
      app({ getTeam: async () => ({ ...TEAM_VIEW, members: [] }) }),
      "GET",
      `/v1/teams/${TEAM}`,
    );
    expect(read.status).toBe(200);
    expect((await call(app({}), "GET", "/v1/teams/nope")).status).toBe(404);
    expect(
      (await call(app({ getTeam: forbidden }), "GET", `/v1/teams/${TEAM}`))
        .status,
    ).toBe(403);
    expect(
      (await call(app({ getTeam: outage }), "GET", `/v1/teams/${TEAM}`)).status,
    ).toBe(503);
  });
});

describe("PATCH /v1/teams/{team_id}", () => {
  test("renames, and an unchanged name writes nothing", async () => {
    const path = `/v1/teams/${TEAM}`;
    const same = await call(
      app({
        renameTeam: async () => ({ team: TEAM_VIEW, receipt_id: null }),
      }),
      "PATCH",
      path,
      { name: "research" },
    );
    expect(same.status).toBe(200);
    expect(teamChangeResponseSchema.parse(await same.json()).receipt_id).toBe(
      null,
    );
    expect((await call(app({}), "PATCH", path, { title: "x" })).status).toBe(
      400,
    );
    expect(
      (await call(app({}), "PATCH", path, { name: "x", pad: PAD })).status,
    ).toBe(413);
    for (const [fail, status] of [
      [forbidden, 403],
      [notFound, 404],
      [taken, 409],
      [outage, 503],
    ] as const) {
      expect(
        (await call(app({ renameTeam: fail }), "PATCH", path, { name: "x" }))
          .status,
      ).toBe(status);
    }
  });
});

describe("DELETE /v1/teams/{team_id}", () => {
  test("deletes, refuses and fails closed", async () => {
    const path = `/v1/teams/${TEAM}`;
    const deleted = await call(
      app({ deleteTeam: async () => ({ receipt_id: RECEIPT }) }),
      "DELETE",
      path,
    );
    expect(deleted.status).toBe(200);
    for (const [fail, status] of [
      [forbidden, 403],
      [notFound, 404],
      [outage, 503],
    ] as const) {
      expect(
        (await call(app({ deleteTeam: fail }), "DELETE", path)).status,
      ).toBe(status);
    }
    const managing = await call(
      app({
        deleteTeam: async () => {
          throw new SessionServiceError(
            "TEAM_MANAGES_AGENTS",
            "manages",
            undefined,
            { agent_ids: [AGENT] },
          );
        },
      }),
      "DELETE",
      path,
    );
    expect(managing.status).toBe(409);
    expect(await errorOf(managing)).toMatchObject({
      code: "TEAM_MANAGES_AGENTS",
      details: { agent_ids: [AGENT] },
    });
  });
});

describe("PATCH /v1/teams/{team_id}/members/{user_id}", () => {
  test("sets the role, refuses and fails closed", async () => {
    const path = `/v1/teams/${TEAM}/members/${USER}`;
    let asked: unknown;
    const changed = await call(
      app({
        setTeamMemberRole: async (_caller, teamId, userId, request) => {
          asked = [teamId, userId, request];
          return { team: TEAM_VIEW, receipt_id: RECEIPT };
        },
      }),
      "PATCH",
      path,
      { role: "lead" },
    );
    expect(changed.status).toBe(200);
    expect(asked).toEqual([TEAM, USER, { role: "lead" }]);
    expect((await call(app({}), "PATCH", path, { role: "owner" })).status).toBe(
      400,
    );
    expect(
      (await call(app({}), "PATCH", path, { role: "lead", pad: PAD })).status,
    ).toBe(413);
    for (const [fail, status] of [
      [forbidden, 403],
      [notFound, 404],
      [outage, 503],
    ] as const) {
      expect(
        (
          await call(app({ setTeamMemberRole: fail }), "PATCH", path, {
            role: "member",
          })
        ).status,
      ).toBe(status);
    }
  });
});

describe("PUT /v1/agents/{id}/managing-team", () => {
  test("sets the team, never null, refuses and fails closed", async () => {
    const path = `/v1/agents/${AGENT}/managing-team`;
    let asked: unknown;
    const agent = {
      id: AGENT,
      workspace_id: WORKSPACE,
      slug: "finance",
      name: "Finance",
      description: null,
      managing_team_id: TEAM,
      managing_team_name: "Finance",
      status: "active" as const,
      active_release_id: null,
      activation_revision: -1,
      auto_model_migration: true,
      created_by: USER,
      created_at: "2026-10-11T00:00:00.000Z",
      updated_at: "2026-10-11T00:00:00.000Z",
    };
    const set = await call(
      app(
        {},
        {
          setManagingTeam: async (_caller, agentId, teamId) => {
            asked = [agentId, teamId];
            return { agent, receipt_id: RECEIPT };
          },
        },
      ),
      "PUT",
      path,
      { team_id: TEAM },
    );
    expect(set.status).toBe(200);
    expect(asked).toEqual([AGENT, TEAM]);
    expect(await set.json()).toEqual({ agent, receipt_id: RECEIPT });
    expect((await call(app({}), "PUT", path, { team_id: null })).status).toBe(
      400,
    );
    expect(
      (await call(app({}), "PUT", path, { team_id: TEAM, pad: PAD })).status,
    ).toBe(413);
    const notAllowed = async () => {
      throw new SessionServiceError("FORBIDDEN", "no", undefined, {
        reason_code: "team_not_allowed",
      });
    };
    const refused = await call(
      app({}, { setManagingTeam: notAllowed }),
      "PUT",
      path,
      { team_id: TEAM },
    );
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).details).toEqual({
      reason_code: "team_not_allowed",
    });
    for (const [fail, status] of [
      [notFound, 404],
      [outage, 503],
    ] as const) {
      expect(
        (
          await call(app({}, { setManagingTeam: fail }), "PUT", path, {
            team_id: TEAM,
          })
        ).status,
      ).toBe(status);
    }
  });
});

describe("POST /v1/teams/{team_id}/members", () => {
  test("adds at once, and names the person in the request", async () => {
    const path = `/v1/teams/${TEAM}/members`;
    let asked: unknown;
    const added = await call(
      app({
        addTeamMember: async (_caller, teamId, userId) => {
          asked = [teamId, userId];
          return { team: TEAM_VIEW, receipt_id: RECEIPT };
        },
      }),
      "POST",
      path,
      { user_id: USER },
    );
    expect(added.status).toBe(200);
    expect(asked).toEqual([TEAM, USER]);
    expect(
      (await call(app({}), "POST", path, { user_id: "someone" })).status,
    ).toBe(400);
    expect(
      (await call(app({}), "POST", path, { user_id: USER, pad: PAD })).status,
    ).toBe(413);
    for (const [fail, status] of [
      [forbidden, 403],
      [notFound, 404],
      [outage, 503],
    ] as const) {
      expect(
        (
          await call(app({ addTeamMember: fail }), "POST", path, {
            user_id: USER,
          })
        ).status,
      ).toBe(status);
    }
  });
});

describe("DELETE /v1/teams/{team_id}/members/{user_id}", () => {
  test("removes, refuses and fails closed", async () => {
    const path = `/v1/teams/${TEAM}/members/${USER}`;
    const removed = await call(
      app({
        removeTeamMember: async () => ({ team: TEAM_VIEW, receipt_id: null }),
      }),
      "DELETE",
      path,
    );
    expect(removed.status).toBe(200);
    expect(
      (await call(app({}), "DELETE", `/v1/teams/${TEAM}/members/x`)).status,
    ).toBe(404);
    for (const [fail, status] of [
      [forbidden, 403],
      [outage, 503],
    ] as const) {
      expect(
        (await call(app({ removeTeamMember: fail }), "DELETE", path)).status,
      ).toBe(status);
    }
  });
});

describe("GET /v1/agents/{id}/admins", () => {
  test("lists, refuses and fails closed", async () => {
    const path = `/v1/agents/${AGENT}/admins`;
    expect(
      (
        await call(
          app({}, { listAgentAdmins: async () => ADMINS }),
          "GET",
          path,
        )
      ).status,
    ).toBe(200);
    for (const [fail, status] of [
      [forbidden, 403],
      [notFound, 404],
      [outage, 503],
    ] as const) {
      expect(
        (await call(app({}, { listAgentAdmins: fail }), "GET", path)).status,
      ).toBe(status);
    }
  });
});

describe("POST /v1/agents/{id}/admins", () => {
  test("names a person or a team, never both", async () => {
    const path = `/v1/agents/${AGENT}/admins`;
    const asked: unknown[] = [];
    const service = {
      addAgentAdmin: async (
        _caller: unknown,
        agentId: string,
        kind: string,
        subjectId: string,
      ) => {
        asked.push([agentId, kind, subjectId]);
        return { admins: ADMINS, receipt_id: RECEIPT };
      },
    } as Partial<AgentAdminService>;
    expect(
      (await call(app({}, service), "POST", path, { team_id: TEAM })).status,
    ).toBe(200);
    const byUser = await call(app({}, service), "POST", path, {
      user_id: USER,
    });
    expect(
      agentAdminChangeResponseSchema.parse(await byUser.json()).receipt_id,
    ).toBe(RECEIPT);
    expect(asked).toEqual([
      [AGENT, "teams", TEAM],
      [AGENT, "users", USER],
    ]);
    expect(
      (
        await call(app({}, service), "POST", path, {
          user_id: USER,
          team_id: TEAM,
        })
      ).status,
    ).toBe(400);
    expect((await call(app({}, service), "POST", path, {})).status).toBe(400);
    expect(
      (await call(app({}, service), "POST", path, { team_id: TEAM, pad: PAD }))
        .status,
    ).toBe(413);
    for (const [fail, status] of [
      [forbidden, 403],
      [notFound, 404],
      [outage, 503],
    ] as const) {
      expect(
        (
          await call(app({}, { addAgentAdmin: fail }), "POST", path, {
            team_id: TEAM,
          })
        ).status,
      ).toBe(status);
    }
  });
});

describe("DELETE /v1/agents/{id}/admins/{kind}/{subject_id}", () => {
  test("removes a person or a team", async () => {
    let asked: unknown;
    const removed = await call(
      app(
        {},
        {
          removeAgentAdmin: async (_caller, agentId, kind, subjectId) => {
            asked = [agentId, kind, subjectId];
            return { admins: ADMINS, receipt_id: null };
          },
        },
      ),
      "DELETE",
      `/v1/agents/${AGENT}/admins/teams/${TEAM}`,
    );
    expect(removed.status).toBe(200);
    expect(asked).toEqual([AGENT, "teams", TEAM]);
    expect(
      (
        await call(
          app({}),
          "DELETE",
          `/v1/agents/${AGENT}/admins/groups/${TEAM}`,
        )
      ).status,
    ).toBe(404);
    for (const [fail, status] of [
      [forbidden, 403],
      [outage, 503],
    ] as const) {
      expect(
        (
          await call(
            app({}, { removeAgentAdmin: fail }),
            "DELETE",
            `/v1/agents/${AGENT}/admins/users/${USER}`,
          )
        ).status,
      ).toBe(status);
    }
  });
});

describe("GET /v1/administered-agents", () => {
  test("lists, refuses and fails closed", async () => {
    expect(
      (
        await call(
          app({}, { listAdministeredAgents: async () => ({ items: [] }) }),
          "GET",
          "/v1/administered-agents",
        )
      ).status,
    ).toBe(200);
    for (const [fail, status] of [
      [forbidden, 403],
      [outage, 503],
    ] as const) {
      expect(
        (
          await call(
            app({}, { listAdministeredAgents: fail }),
            "GET",
            "/v1/administered-agents",
          )
        ).status,
      ).toBe(status);
    }
  });
});

describe("GET /v1/my-teams", () => {
  test("reads a page; a bad query or cursor is 400", () =>
    pages("listMyTeams", "/v1/my-teams"));

  test("lists, refuses and fails closed", async () => {
    const listed = await call(
      app({
        listMyTeams: async () => ({
          items: [{ id: TEAM, name: "research", role: "member" }],
          next_cursor: null,
        }),
      }),
      "GET",
      "/v1/my-teams",
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      items: [{ id: TEAM, name: "research", role: "member" }],
      next_cursor: null,
    });
    for (const [fail, status] of [
      [forbidden, 403],
      [outage, 503],
    ] as const) {
      expect(
        (await call(app({ listMyTeams: fail }), "GET", "/v1/my-teams")).status,
      ).toBe(status);
    }
  });
});
