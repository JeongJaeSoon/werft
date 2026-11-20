import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import {
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  REQUEST_BODY_MAX_BYTES,
  registerSkillResponseSchema,
  SKILL_UPLOAD_BODY_MAX_BYTES,
  SKILL_UPLOAD_FILES_MAX,
  type SkillVersion,
  skillAttachmentResponseSchema,
  skillListSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type IdentityStore,
  SessionServiceError,
  type SkillService,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerSkillRoutes } from "./skills.ts";

const createApiApp = recordRouteErrors("routes/musterrolle/skills.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const VERSION_ID = "019a0000-0000-7000-8000-00000000e0a1";
const AGENT_ID = "019a0000-0000-7000-8000-00000000c0a1";
const ADMIN = "019a0000-0000-7000-8000-00000000a0a1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };
const base = "/v1/workspace/skills";
const versionPath = `${base}/versions/${VERSION_ID}`;
const agentPath = `/v1/agents/${AGENT_ID}/skills`;

const VERSION: SkillVersion = {
  id: VERSION_ID,
  name: "research",
  version: 1,
  digest: "a".repeat(64),
  source: "upload",
  size_bytes: 120,
  has_scripts: false,
  review: "pending",
  registered_by: ADMIN,
  registered_at: "2026-11-20T00:00:00.000Z",
  reviewed_by: null,
  reviewed_at: null,
  archived_at: null,
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
  service: Partial<SkillService>,
  method: string,
  path: string,
  body?: string,
): Promise<Response> =>
  createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSkillRoutes(router, service as SkillService),
  }).request(path, {
    method,
    headers: owner,
    ...(body === undefined ? {} : { body }),
  });

// A console session of `role`, the way the cookie path resolves one.
const signedIn = (
  role: "owner" | "member",
  service: Partial<SkillService>,
  skillUploads = true,
) =>
  createApiApp({
    identity: {
      resolveWebSession: async () => ({
        sessionId: "s1",
        userId: ADMIN,
        email: "admin@example.com",
        displayName: "Admin",
        locale: null,
        workspaceId: WORKSPACE,
        role,
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
      renewWebSession: async () => null,
    } as unknown as IdentityStore,
    skillUploads,
    registerRoutes: (router) =>
      registerSkillRoutes(router, service as SkillService),
  });
const cookieHeaders = {
  "Content-Type": "application/json",
  Cookie: `${WEB_SESSION_COOKIE_NAME}=token`,
  [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
};

const upload = (bytes: number) =>
  JSON.stringify({
    name: "research",
    files: [{ path: "SKILL.md", content_base64: "A".repeat(bytes) }],
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

describe("workspace skills", () => {
  test("lists, and a refusal is 403", async () => {
    const listed = await send(
      {
        list: async () => ({
          items: [
            {
              name: "research",
              versions: [VERSION],
              workspace_attachment: null,
            },
          ],
        }),
      },
      "GET",
      base,
    );
    expect(listed.status).toBe(200);
    expect(skillListSchema.parse(await listed.json()).items).toHaveLength(1);
    expect(
      await status(send({ list: fail("FORBIDDEN") }, "GET", base)),
    ).toEqual([403, "FORBIDDEN", undefined]);
  });

  test("only a console owner or admin gets the upload's larger body limit", async () => {
    let seen = 0;
    const register: SkillService["register"] = async (_caller, request) => {
      seen = request.files[0]?.content_base64.length ?? 0;
      return { outcome: "registered", version: VERSION, receipt_id: null };
    };
    const big = REQUEST_BODY_MAX_BYTES * 1.5;
    const post = (app: ReturnType<typeof signedIn>, body: string) =>
      app.request(base, { method: "POST", headers: cookieHeaders, body });
    const created = await post(signedIn("owner", { register }), upload(big));
    expect(created.status).toBe(201);
    expect(seen).toBe(big);
    registerSkillResponseSchema.parse(await created.json());

    seen = 0;
    for (const refused of [
      // A member is refused by the service anyway, so reads no more than any
      // other route; so does a caller without a console session, and an
      // installation that serves no skill routes.
      post(signedIn("member", { register }), upload(big)),
      post(signedIn("owner", { register }, false), upload(big)),
      send({ register }, "POST", base, upload(big)),
    ]) {
      expect((await refused).status).toBe(413);
    }
    expect(seen).toBe(0);

    const tooBig = await post(
      signedIn("owner", { register }),
      upload(SKILL_UPLOAD_BODY_MAX_BYTES),
    );
    expect(tooBig.status).toBe(413);
    expect(seen).toBe(0);

    const tooMany = await post(
      signedIn("owner", { register }),
      JSON.stringify({
        name: "research",
        files: Array.from({ length: SKILL_UPLOAD_FILES_MAX + 1 }, (_, i) => ({
          path: `f${i}.md`,
          content_base64: "QQ==",
        })),
      }),
    );
    expect(tooMany.status).toBe(400);
    expect(seen).toBe(0);

    const again = await send(
      {
        register: async () => ({
          outcome: "already_registered",
          version: VERSION,
          receipt_id: null,
        }),
      },
      "POST",
      base,
      upload(8),
    );
    expect(again.status).toBe(200);
  });

  test("past the transport cap an unauthenticated body is refused before any route runs", async () => {
    let reached = 0;
    const app = signedIn("owner", {});
    const server = Bun.serve({
      port: 0,
      // server.ts's cap; ingest.integration.test.ts pins that line.
      maxRequestBodySize: SKILL_UPLOAD_BODY_MAX_BYTES,
      fetch: (request) => {
        reached += 1;
        return app.fetch(request);
      },
    });
    try {
      const socket = connect(Number(server.port), "127.0.0.1");
      socket.on("error", () => {});
      const answer = new Promise<string>((resolve) => {
        socket.once("data", (chunk) => resolve(chunk.toString("latin1")));
        socket.once("end", () => resolve(""));
      });
      await new Promise((resolve) => socket.once("connect", resolve));
      const bytes = 1024 * 1024;
      socket.write(
        `POST ${base} HTTP/1.1\r\nHost: test\r\nContent-Type: application/json\r\nContent-Length: ${bytes}\r\n\r\n`,
      );
      socket.write(Buffer.alloc(bytes, 97));
      expect(await answer).toStartWith("HTTP/1.1 413");
      socket.destroy();
      expect(reached).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("an upload's refusals", async () => {
    expect(
      (await send({}, "POST", base, JSON.stringify({ name: "Bad" }))).status,
    ).toBe(400);
    expect(
      await status(
        send(
          { register: fail("BAD_REQUEST", "skill_invalid") },
          "POST",
          base,
          upload(8),
        ),
      ),
    ).toEqual([400, "BAD_REQUEST", "skill_invalid"]);
    expect(
      await status(
        send(
          { register: fail("ALREADY_EXISTS", "name_taken") },
          "POST",
          base,
          upload(8),
        ),
      ),
    ).toEqual([409, "ALREADY_EXISTS", "name_taken"]);
    expect(
      await status(
        send(
          { register: fail("FORBIDDEN", "web_session_required") },
          "POST",
          base,
          upload(8),
        ),
      ),
    ).toEqual([403, "FORBIDDEN", "web_session_required"]);
  });

  test("a version's files: unknown is 404, a member is 403", async () => {
    expect(
      (await send({ files: fail("NOT_FOUND") }, "GET", `${versionPath}/files`))
        .status,
    ).toBe(404);
    expect(
      (await send({ files: fail("FORBIDDEN") }, "GET", `${versionPath}/files`))
        .status,
    ).toBe(403);
  });

  test("review and archive", async () => {
    const review = `${versionPath}/review`;
    const archive = `${versionPath}/archive`;
    const reviewed = await send(
      {
        review: async (_caller, id, request) => {
          expect([id, request.decision]).toEqual([VERSION_ID, "approved"]);
          return { version: VERSION, receipt_id: null };
        },
      },
      "POST",
      review,
      JSON.stringify({ decision: "approved" }),
    );
    expect(reviewed.status).toBe(200);
    expect(
      (await send({}, "POST", review, JSON.stringify({ decision: "maybe" })))
        .status,
    ).toBe(400);
    expect(
      (
        await send(
          {},
          "POST",
          review,
          JSON.stringify({ decision: "x".repeat(REQUEST_BODY_MAX_BYTES) }),
        )
      ).status,
    ).toBe(413);
    expect(
      await status(
        send(
          { review: fail("FORBIDDEN", "self_review") },
          "POST",
          review,
          JSON.stringify({ decision: "approved" }),
        ),
      ),
    ).toEqual([403, "FORBIDDEN", "self_review"]);
    expect(
      (
        await send(
          { review: fail("NOT_FOUND") },
          "POST",
          review,
          JSON.stringify({ decision: "approved" }),
        )
      ).status,
    ).toBe(404);

    expect(
      await status(
        send(
          { archive: fail("BAD_REQUEST", "version_attached") },
          "POST",
          archive,
        ),
      ),
    ).toEqual([400, "BAD_REQUEST", "version_attached"]);
    expect(
      (await send({ archive: fail("NOT_FOUND") }, "POST", archive)).status,
    ).toBe(404);
  });

  test("workspace attachment", async () => {
    const path = `${base}/research/attachment`;
    const body = JSON.stringify({ version_id: VERSION_ID, mode: "required" });
    const attached = await send(
      {
        putWorkspaceAttachment: async (_caller, name, request) => ({
          name,
          scope: "workspace",
          agent_id: null,
          attachment: request,
          receipt_id: null,
        }),
      },
      "PUT",
      path,
      body,
    );
    expect(attached.status).toBe(200);
    expect(
      skillAttachmentResponseSchema.parse(await attached.json()).attachment,
    ).toEqual({ version_id: VERSION_ID, mode: "required" });
    expect((await send({}, "PUT", `${base}/Bad/attachment`, body)).status).toBe(
      404,
    );
    expect(
      (await send({}, "PUT", path, JSON.stringify({ mode: "always" }))).status,
    ).toBe(400);
    expect(
      await status(
        send(
          {
            putWorkspaceAttachment: fail("BAD_REQUEST", "version_not_approved"),
          },
          "PUT",
          path,
          body,
        ),
      ),
    ).toEqual([400, "BAD_REQUEST", "version_not_approved"]);
    expect(
      (
        await send(
          {},
          "PUT",
          path,
          JSON.stringify({ version_id: "x".repeat(REQUEST_BODY_MAX_BYTES) }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await send(
          { putWorkspaceAttachment: fail("NOT_FOUND") },
          "PUT",
          path,
          body,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await send(
          { deleteWorkspaceAttachment: fail("NOT_FOUND") },
          "DELETE",
          path,
        )
      ).status,
    ).toBe(404);
  });
});

describe("agent skills", () => {
  const one = `${agentPath}/research`;
  const body = JSON.stringify({ version_id: VERSION_ID, mode: "optional" });

  test("lists, attaches and takes back by the agent and name in the path", async () => {
    const listed = await send(
      { listAgent: async () => ({ items: [] }) },
      "GET",
      agentPath,
    );
    expect(listed.status).toBe(200);
    const attached = await send(
      {
        putAgentAttachment: async (_caller, agentId, name, request) => ({
          name,
          scope: "agent",
          agent_id: agentId,
          attachment: request,
          receipt_id: null,
        }),
      },
      "PUT",
      one,
      body,
    );
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({ agent_id: AGENT_ID });
    const detached = await send(
      {
        deleteAgentAttachment: async (_caller, agentId, name) => ({
          name,
          scope: "agent",
          agent_id: agentId,
          attachment: null,
          receipt_id: null,
        }),
      },
      "DELETE",
      one,
    );
    expect(detached.status).toBe(200);
  });

  test("refusals", async () => {
    expect(
      (await send({ listAgent: fail("NOT_FOUND") }, "GET", agentPath)).status,
    ).toBe(404);
    expect(
      (await send({ listAgent: fail("FORBIDDEN") }, "GET", agentPath)).status,
    ).toBe(403);
    expect((await send({}, "PUT", `${agentPath}/Bad`, body)).status).toBe(404);
    expect(
      (await send({}, "PUT", one, JSON.stringify({ mode: "always" }))).status,
    ).toBe(400);
    expect(
      (
        await send(
          {},
          "PUT",
          one,
          JSON.stringify({ version_id: "x".repeat(REQUEST_BODY_MAX_BYTES) }),
        )
      ).status,
    ).toBe(413);
    expect(
      (await send({ putAgentAttachment: fail("NOT_FOUND") }, "PUT", one, body))
        .status,
    ).toBe(404);
    expect(
      (await send({ deleteAgentAttachment: fail("NOT_FOUND") }, "DELETE", one))
        .status,
    ).toBe(404);
  });
});
