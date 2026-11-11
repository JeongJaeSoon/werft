import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  exportSettingsResponseSchema,
  type ImportSettingsResponse,
  importSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
} from "@werft-ai/contracts";
import {
  SessionServiceError,
  type SettingsDocumentService,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerInstallationSettingsRoutes } from "../installation-settings.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/installation-settings.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const EXPORT_PATH = "/v1/installation/settings/export";
const IMPORT_PATH = "/v1/installation/settings/import";

const DOCUMENT = {
  version: 1,
  connections: {
    main: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true, last4: "wxyz" },
    },
  },
  repositories: {},
  mcp_servers: {},
};
const IMPORTED: ImportSettingsResponse = {
  outcome: "dry_run",
  added: ["connection:main"],
  unchanged: [],
  inactive: [],
  needs_value: ["connection:main"],
  receipt_ids: [],
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const refusing = (code: string) => async () => {
  throw new SessionServiceError(code as never, "no", undefined, {
    reason_code: "role",
  });
};

function request(
  settings: Partial<SettingsDocumentService>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerInstallationSettingsRoutes(
        router,
        settings as SettingsDocumentService,
      ),
  }).request(path, {
    method,
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function codeOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("GET /v1/installation/settings/export", () => {
  test("answers the document, and every refusal maps to its status", async () => {
    const answered = await request(
      {
        export: async () => ({
          document: DOCUMENT as never,
          digest: `sha256:${"a".repeat(64)}`,
        }),
      },
      "GET",
      EXPORT_PATH,
    );
    expect(answered.status).toBe(200);
    expect(exportSettingsResponseSchema.parse(await answered.json())).toEqual({
      document: DOCUMENT as never,
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(
      (await request({ export: refusing("FORBIDDEN") }, "GET", EXPORT_PATH))
        .status,
    ).toBe(403);
    expect((await request({ export: outage }, "GET", EXPORT_PATH)).status).toBe(
      503,
    );
  });
});

describe("POST /v1/installation/settings/import", () => {
  test("passes the document and dry_run, and every refusal maps to its status", async () => {
    const asked: unknown[] = [];
    const answered = await request(
      {
        import: async (_caller, document, options) => {
          asked.push(document, options);
          return IMPORTED;
        },
      },
      "POST",
      `${IMPORT_PATH}?dry_run=true`,
      DOCUMENT,
    );
    expect(answered.status).toBe(200);
    expect(importSettingsResponseSchema.parse(await answered.json())).toEqual(
      IMPORTED,
    );
    expect(asked).toEqual([DOCUMENT, { dryRun: true }]);

    for (const [path, body] of [
      [IMPORT_PATH, { ...DOCUMENT, version: 2 }],
      [IMPORT_PATH, { ...DOCUMENT, profiles: {} }],
      [`${IMPORT_PATH}?dry_run=yes`, DOCUMENT],
    ] as const) {
      expect((await request({}, "POST", path, body)).status).toBe(400);
    }
    // The outline is the route's to refuse: its issues name the field, and
    // the service's `invalid_document` is left to the entries.
    const outline = await request({}, "POST", IMPORT_PATH, {
      ...DOCUMENT,
      version: 2,
    });
    expect(
      apiErrorResponseSchema.parse(await outline.json()).error.details,
    ).toMatchObject({ issues: [{ path: "version" }] });
    expect(
      (
        await request(
          { import: refusing("BAD_REQUEST") },
          "POST",
          IMPORT_PATH,
          DOCUMENT,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request({}, "POST", IMPORT_PATH, {
          ...DOCUMENT,
          connections: { pad: { x: "x".repeat(REQUEST_BODY_MAX_BYTES) } },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(
          { import: refusing("FORBIDDEN") },
          "POST",
          IMPORT_PATH,
          DOCUMENT,
        )
      ).status,
    ).toBe(403);
    const conflict = await request(
      { import: refusing("REVISION_CONFLICT") },
      "POST",
      IMPORT_PATH,
      DOCUMENT,
    );
    expect(conflict.status).toBe(409);
    expect(await codeOf(conflict)).toBe("REVISION_CONFLICT");
    expect(
      (await request({ import: outage }, "POST", IMPORT_PATH, DOCUMENT)).status,
    ).toBe(503);
  });
});
