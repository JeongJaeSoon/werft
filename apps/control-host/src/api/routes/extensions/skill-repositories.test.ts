import { describe, expect, test } from "bun:test";
import {
  checkSkillRepositoryResponseSchema,
  putSkillRepositoryRefResponseSchema,
  registerSkillRepositoryResponseSchema,
  removeSkillRepositoryResponseSchema,
  type SkillRepositoryDetail,
  skillRepositoryDetailSchema,
  skillRepositoryListSchema,
} from "@werft-ai/contracts";
import {
  currentDeadline,
  RequestDeadline,
  runWithDeadline,
} from "@werft-ai/db/pool";
import {
  SessionServiceError,
  type SkillRepositoryService,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import {
  listingBeyondRequest,
  registerSkillRepositoryRoutes,
} from "./skill-repositories.ts";

const createApiApp = recordRouteErrors(
  "routes/extensions/skill-repositories.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const ADMIN = "019a0000-0000-7000-8000-00000000a0a1";
const ID = "019a0000-0000-7000-8000-00000000d0a1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };
const base = "/v1/workspace/skill-repositories";
const one = `${base}/${ID}`;

const DETAIL: SkillRepositoryDetail = {
  repository: {
    id: ID,
    repository_id: 7,
    repository: "acme/skills",
    ref: "main",
    access: "public",
    connection_id: "019a0000-0000-7000-8000-0000000000b1",
    installation_id: 42,
    owner_id: 70,
    license: "MIT",
    state: "active",
    last_commit: "a".repeat(40),
    last_sync: {
      at: "2026-11-28T00:00:00.000Z",
      trigger: { kind: "register", user_id: ADMIN },
      commit: "a".repeat(40),
      result: "listed",
      issues: [],
    },
    skill_count: 1,
    created_by: ADMIN,
    created_at: "2026-11-28T00:00:00.000Z",
    removed_by: null,
    removed_at: null,
  },
  skills: [
    {
      id: "019a0000-0000-7000-8000-00000000d0b1",
      path: "skills/pdf",
      name: "pdf",
      description: "Reads PDFs.",
      license: null,
      status: "off",
      issues: [],
      name_owner: null,
      name_shared: false,
      present: true,
      enabled: false,
      tree_sha: "b".repeat(40),
      file_count: 2,
      size_bytes: 120,
      has_scripts: false,
    },
  ],
};

type Code = ConstructorParameters<typeof SessionServiceError>[0];
const fail = (code: Code, reasonCode?: string) => async (): Promise<never> => {
  throw new SessionServiceError(
    code,
    "no",
    undefined,
    reasonCode === undefined ? undefined : { reason_code: reasonCode },
  );
};

const send = async (
  service: Partial<SkillRepositoryService>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSkillRepositoryRoutes(router, service as SkillRepositoryService),
  }).request(path, {
    method,
    headers: owner,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function status(
  response: Promise<Response>,
): Promise<[number, string, string | undefined]> {
  const answered = await response;
  const error = await errorOf(answered);
  return [
    answered.status,
    error.code,
    (error.details as { reason_code?: string } | undefined)?.reason_code,
  ];
}

describe("workspace skill repositories", () => {
  test("lists and reads one; a refusal is 403 and an unknown id 404", async () => {
    const listed = await send(
      { list: async () => ({ items: [DETAIL.repository] }) },
      "GET",
      base,
    );
    expect(listed.status).toBe(200);
    expect(
      skillRepositoryListSchema.parse(await listed.json()).items,
    ).toHaveLength(1);
    expect(
      await status(send({ list: fail("FORBIDDEN") }, "GET", base)),
    ).toEqual([403, "FORBIDDEN", undefined]);

    const read = await send(
      {
        get: async (_caller, id) => {
          expect(id).toBe(ID);
          return DETAIL;
        },
      },
      "GET",
      one,
    );
    expect(read.status).toBe(200);
    expect(skillRepositoryDetailSchema.parse(await read.json())).toEqual(
      DETAIL,
    );
    expect((await send({ get: fail("FORBIDDEN") }, "GET", one)).status).toBe(
      403,
    );
    expect((await send({ get: fail("NOT_FOUND") }, "GET", one)).status).toBe(
      404,
    );
    expect((await send({}, "GET", `${base}/not-a-uuid`)).status).toBe(404);
  });

  test("registers by a github.com address, with or without a ref", async () => {
    const seen: unknown[] = [];
    const register: SkillRepositoryService["register"] = async (
      _caller,
      request,
    ) => {
      seen.push(request);
      return { outcome: "registered", ...DETAIL, receipt_id: ID };
    };
    for (const body of [
      { url: "https://github.com/acme/skills" },
      { url: "https://github.com/acme/skills.git/", ref: "v1" },
    ]) {
      const created = await send({ register }, "POST", base, body);
      expect(created.status).toBe(201);
      registerSkillRepositoryResponseSchema.parse(await created.json());
    }
    expect(seen).toEqual([
      { url: "https://github.com/acme/skills" },
      { url: "https://github.com/acme/skills.git/", ref: "v1" },
    ]);
  });

  test("a registration's refusals", async () => {
    let reached = 0;
    const register: SkillRepositoryService["register"] = async () => {
      reached += 1;
      throw new Error("not reached");
    };
    for (const body of [
      {},
      { url: "http://github.com/acme/skills" },
      { url: "https://gitlab.com/acme/skills" },
      { url: "https://github.com/acme" },
      { url: "https://github.com/acme/skills/tree/main" },
      { url: "https://github.com/acme/skills", ref: "a..b" },
      { url: "https://github.com/acme/skills", connection_id: ID },
    ]) {
      expect((await send({ register }, "POST", base, body)).status).toBe(400);
    }
    expect(reached).toBe(0);
    const url = { url: "https://github.com/acme/skills" };
    for (const [code, reason, expected] of [
      ["BAD_REQUEST", "repository_not_public", 400],
      ["BAD_REQUEST", "listing_refused", 400],
      ["FORBIDDEN", "web_session_required", 403],
      ["ALREADY_EXISTS", "repository_already_registered", 409],
      ["GITHUB_UNAVAILABLE", "github_unreachable", 502],
    ] as const) {
      expect(
        await status(send({ register: fail(code, reason) }, "POST", base, url)),
      ).toEqual([expected, code, reason]);
    }
  });

  test("removes, and an unknown id is 404", async () => {
    const removed = await send(
      {
        remove: async (_caller, id) => {
          expect(id).toBe(ID);
          return {
            repository: {
              ...DETAIL.repository,
              state: "removed",
              removed_by: ADMIN,
              removed_at: "2026-11-28T01:00:00.000Z",
            },
            receipt_id: ID,
          };
        },
      },
      "DELETE",
      one,
    );
    expect(removed.status).toBe(200);
    expect(
      removeSkillRepositoryResponseSchema.parse(await removed.json()).repository
        .state,
    ).toBe("removed");
    expect(
      (await send({ remove: fail("NOT_FOUND") }, "DELETE", one)).status,
    ).toBe(404);
    expect(
      (await send({ remove: fail("FORBIDDEN") }, "DELETE", one)).status,
    ).toBe(403);
  });

  test("checks now; a removed repository is 400 and an unknown one 404", async () => {
    const check = `${one}/check`;
    const checked = await send(
      { checkNow: async () => ({ outcome: "queued", ...DETAIL }) },
      "POST",
      check,
    );
    expect(checked.status).toBe(200);
    expect(
      checkSkillRepositoryResponseSchema.parse(await checked.json()).outcome,
    ).toBe("queued");
    expect(
      await status(
        send(
          { checkNow: fail("BAD_REQUEST", "repository_removed") },
          "POST",
          check,
        ),
      ),
    ).toEqual([400, "BAD_REQUEST", "repository_removed"]);
    expect(
      (await send({ checkNow: fail("NOT_FOUND") }, "POST", check)).status,
    ).toBe(404);
  });

  test("changes the ref, and its refusals", async () => {
    const ref = `${one}/ref`;
    const changed = await send(
      {
        setRef: async (_caller, id, to) => {
          expect([id, to]).toEqual([ID, "v2"]);
          return { ...DETAIL, receipt_id: ID, check: "checked" };
        },
      },
      "PUT",
      ref,
      { ref: "v2" },
    );
    expect(changed.status).toBe(200);
    expect(
      putSkillRepositoryRefResponseSchema.parse(await changed.json()).check,
    ).toBe("checked");
    expect((await send({}, "PUT", ref, { ref: "" })).status).toBe(400);
    for (const [code, reason, expected] of [
      ["BAD_REQUEST", "ref_not_found", 400],
      ["NOT_FOUND", undefined, 404],
      ["REVISION_CONFLICT", "repository_changed", 409],
      ["GITHUB_UNAVAILABLE", "github_rejected", 502],
    ] as const) {
      expect(
        await status(
          send({ setRef: fail(code, reason) }, "PUT", ref, { ref: "v2" }),
        ),
      ).toEqual([expected, code, reason]);
    }
  });
});

describe("a listing past its request's deadline", () => {
  test("reads the repository and its App, records and lets go under deadlines of their own", async () => {
    const left: Record<string, number> = {};
    const noting =
      <T>(name: string, value: T) =>
      async () => {
        left[name] = currentDeadline()?.remainingMs() ?? Number.NaN;
        return value;
      };
    const manual = { kind: "manual" as const, userId: ADMIN };
    const store = {
      find: noting("find", null),
      record: noting("record", true),
      finish: noting("finish", null),
      begin: noting("begin", { outcome: "not_found" as const }),
      setRef: noting("setRef", { outcome: "not_found" as const }),
    };
    const wired = listingBeyondRequest(store, noting("apps", []));
    // As the pool sees a request that already answered 503.
    await runWithDeadline(
      new RequestDeadline(performance.now() - 1),
      async () => {
        await wired.store.setRef();
        await wired.store.begin(WORKSPACE, ID, manual, 1);
        left["manual"] = left["begin"] ?? Number.NaN;
        await wired.store.begin(WORKSPACE, ID, { ...manual, kind: "ref" }, 1);
        await wired.store.find(WORKSPACE, ID);
        await wired.apps();
        await wired.store.record({} as never);
        await wired.store.finish(WORKSPACE, ID, 1, "t");
      },
    );
    // A change, and a check someone asks for, start only within the request.
    expect(left["setRef"]).toBeLessThanOrEqual(0);
    expect(left["manual"]).toBeLessThanOrEqual(0);
    for (const name of ["begin", "find", "apps", "record", "finish"]) {
      expect(left[name]).toBeGreaterThan(0);
    }
  });
});
