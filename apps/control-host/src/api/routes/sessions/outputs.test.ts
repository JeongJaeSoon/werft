import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  apiErrorResponseSchema,
  listSessionOutputsResponseSchema,
  type SessionDetail,
} from "@werft-ai/contracts";
import {
  createSessionOutputService,
  type SessionOutputBodyResult,
  type SessionOutputsResult,
  SessionServiceError,
} from "@werft-ai/platform";
import type { CheckpointOutput } from "@werft-ai/runtime-core";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import {
  attachmentDisposition,
  registerSessionOutputRoutes,
} from "./outputs.ts";

const createApiApp = recordRouteErrors("routes/sessions/outputs.test.ts");

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const NO_CHECKPOINT = "1b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const DAMAGED = "2b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const UNKNOWN = "3b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const REPORT = new TextEncoder().encode("# 보고서\n");
const outputs: CheckpointOutput[] = [
  {
    path: "out/report.md",
    bytes: REPORT.byteLength,
    sha256: sha256(REPORT),
    key: `sessions/${SESSION}/checkpoints/0000000002/a/p/outputs/${sha256(REPORT)}`,
    version: "v1",
  },
  { path: "out/video.mp4", bytes: 70_000_000, omitted: "too_large" },
];
const opened: string[] = [];

const app = createApiApp({
  authMode: "none",
  registerRoutes: (router) =>
    registerSessionOutputRoutes(
      router,
      createSessionOutputService({
        sessions: {
          async getSession(_actor, id) {
            if (id === UNKNOWN) {
              throw new SessionServiceError("NOT_FOUND", "Resource not found");
            }
            return { id } as SessionDetail;
          },
        },
        source: {
          async readOutputs(id): Promise<SessionOutputsResult> {
            if (id === NO_CHECKPOINT) return { status: "none" };
            if (id === DAMAGED) {
              return { status: "unavailable", reason: "manifest damaged" };
            }
            return { status: "ready", revision: 2, outputs };
          },
          async openOutput(id, path): Promise<SessionOutputBodyResult> {
            opened.push(path);
            if (id === DAMAGED) {
              return { status: "unavailable", reason: "object gone" };
            }
            const output = outputs.find(
              (candidate) =>
                candidate.path === path && !("omitted" in candidate),
            );
            if (id === NO_CHECKPOINT || output === undefined) {
              return { status: "missing" };
            }
            return {
              status: "ready",
              output: output as Extract<CheckpointOutput, { key: string }>,
              body: (async function* () {
                yield REPORT.subarray(0, 4);
                yield REPORT.subarray(4);
              })(),
            };
          },
        },
      }),
    ),
});

const headers = { "X-Owner-Id": "owner-a" };

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("GET /v1/sessions/{id}/outputs", () => {
  test("lists stored and omitted outputs of the latest checkpoint", async () => {
    const response = await app.request(`/v1/sessions/${SESSION}/outputs`, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(
      listSessionOutputsResponseSchema.parse(await response.json()),
    ).toEqual({
      session_id: SESSION,
      checkpoint_revision: 2,
      items: [
        {
          path: "out/report.md",
          bytes: REPORT.byteLength,
          sha256: sha256(REPORT),
          omitted: null,
        },
        {
          path: "out/video.mp4",
          bytes: 70_000_000,
          sha256: null,
          omitted: "too_large",
        },
      ],
    });
  });

  test("a session without a committed checkpoint lists nothing", async () => {
    const response = await app.request(
      `/v1/sessions/${NO_CHECKPOINT}/outputs`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session_id: NO_CHECKPOINT,
      checkpoint_revision: null,
      items: [],
    });
  });

  test("an unknown or malformed session is 404", async () => {
    for (const id of [UNKNOWN, "not-a-uuid"]) {
      const response = await app.request(`/v1/sessions/${id}/outputs`, {
        headers,
      });
      expect(response.status, id).toBe(404);
      expect(await errorCode(response)).toBe("NOT_FOUND");
    }
  });

  test("an unreadable checkpoint is 409 CHECKPOINT_UNAVAILABLE", async () => {
    const response = await app.request(`/v1/sessions/${DAMAGED}/outputs`, {
      headers,
    });
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("CHECKPOINT_UNAVAILABLE");
  });
});

describe("GET /v1/sessions/{id}/outputs/{path}", () => {
  test("streams the file as an attachment the browser will not sniff", async () => {
    const response = await app.request(
      `/v1/sessions/${SESSION}/outputs/${encodeURIComponent("out/report.md")}`,
      { headers },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="report.md"; filename*=UTF-8''report.md`,
    );
    expect(response.headers.get("Content-Length")).toBe(
      String(REPORT.byteLength),
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(sha256(body)).toBe(sha256(REPORT));
  });

  test.each([
    ["an omitted file", "out/video.mp4"],
    ["a path the list does not name", "out/other.md"],
    ["a climbing path", "out/../../etc/passwd"],
  ])("%s is 404", async (_, path) => {
    const response = await app.request(
      `/v1/sessions/${SESSION}/outputs/${encodeURIComponent(path)}`,
      { headers },
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("NOT_FOUND");
    // Matched against the manifest as given, never turned into a key.
    expect(opened.at(-1)).toBe(path);
  });

  test("a path sent unencoded across segments is not a route", async () => {
    const response = await app.request(
      `/v1/sessions/${SESSION}/outputs/out/report.md`,
      { headers },
    );
    expect(response.status).toBe(404);
  });

  test("an unknown session and one without a checkpoint are 404", async () => {
    for (const id of [UNKNOWN, NO_CHECKPOINT]) {
      const response = await app.request(
        `/v1/sessions/${id}/outputs/out%2Freport.md`,
        { headers },
      );
      expect(response.status, id).toBe(404);
      expect(await errorCode(response)).toBe("NOT_FOUND");
    }
  });

  test("an unreadable object is 409 CHECKPOINT_UNAVAILABLE", async () => {
    const response = await app.request(
      `/v1/sessions/${DAMAGED}/outputs/out%2Freport.md`,
      { headers },
    );
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("CHECKPOINT_UNAVAILABLE");
  });
});

describe("attachmentDisposition", () => {
  test.each([
    [
      "out/보고서 (최종).md",
      `attachment; filename="________.md"; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%20%28%EC%B5%9C%EC%A2%85%29.md`,
    ],
    [
      'out/a"b\r\nSet-Cookie: x.txt',
      `attachment; filename="a_b__Set-Cookie__x.txt"; filename*=UTF-8''a%22b%0D%0ASet-Cookie%3A%20x.txt`,
    ],
    [
      "out/sub/it's.csv",
      `attachment; filename="it_s.csv"; filename*=UTF-8''it%27s.csv`,
    ],
    [
      "out/\uD800.bin",
      `attachment; filename="_.bin"; filename*=UTF-8''%EF%BF%BD.bin`,
    ],
  ])("names %j safely", (path, expected) => {
    expect(attachmentDisposition(path)).toBe(expected);
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
