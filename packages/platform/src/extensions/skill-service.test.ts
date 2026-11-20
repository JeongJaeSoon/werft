import { describe, expect, test } from "bun:test";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type {
  ArchiveExtensionBundleResult,
  AttachmentReceiptResult,
  ExtensionAttachment,
  ExtensionBundle,
  ExtensionBundleStore,
  ReviewExtensionBundleResult,
} from "./ports/extension-bundle-store.ts";
import { createSkillService } from "./skill-service.ts";

// The store's own rules (versions, self review, archive refusals) are in
// packages/db's extension-bundles.integration.test.ts; this file holds what
// the service decides before and after it.

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const USER = "019a0000-0000-7000-8000-0000000000d1";

const caller = (surface: "web" | "api", role: "owner" | "member" = "owner") =>
  callerFor(
    {
      kind: "user",
      id: USER,
      workspace_id: WORKSPACE,
      role,
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: surface },
    crypto.randomUUID(),
  );

const b64 = (text: string) => Buffer.from(text).toString("base64");
const skillMd = (name: string, body = "Do it.\n") =>
  `---\nname: ${name}\ndescription: Use for ${name}\n---\n${body}`;
const upload = (name: string, body?: string) => ({
  name,
  files: [
    { path: "SKILL.md", content_base64: b64(skillMd(name, body)) },
    {
      path: "scripts/run.sh",
      content_base64: b64("echo hi\n"),
      executable: true,
    },
  ],
});

function setup() {
  const rows: ExtensionBundle[] = [];
  const attachments: ExtensionAttachment[] = [];
  const calls: Parameters<ExtensionBundleStore["recordAttachment"]>[0][] = [];
  const outcomes: {
    review?: ReviewExtensionBundleResult;
    archive?: ArchiveExtensionBundleResult;
    attach?: AttachmentReceiptResult;
  } = {};
  let n = 0;
  const newId = () =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const store: ExtensionBundleStore = {
    find: async (_ws, id) => rows.find((r) => r.id === id) ?? null,
    findByDigest: async (_ws, digest) =>
      rows.find((r) => r.digest === digest) ?? null,
    list: async () => [...rows],
    mayManage: async () => "ok",
    async register(input) {
      const existing = rows.find((r) => r.digest === input.digest);
      if (existing) return { outcome: "already_registered", bundle: existing };
      const bundle: ExtensionBundle = {
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        digest: input.digest,
        label: input.label,
        source: input.source,
        sizeBytes: input.sizeBytes,
        manifest: input.manifest,
        review: "pending",
        registeredBy: USER,
        registeredAt: new Date(rows.length * 1000),
        reviewedBy: null,
        reviewedAt: null,
        version: rows.filter((r) => r.name === input.name).length + 1,
        archivedAt: null,
      };
      rows.push(bundle);
      return { outcome: "registered", bundle, receiptId: input.receiptId };
    },
    review: async (input) => {
      if (outcomes.review) return outcomes.review;
      const row = rows.find((r) => r.id === input.bundleId);
      if (!row) return { outcome: "not_found" };
      row.review = input.review;
      return {
        outcome: "reviewed",
        bundle: row,
        receiptId: input.receiptId,
        selfReview: false,
      };
    },
    async recordAttachment(input) {
      calls.push(input);
      if (outcomes.attach) return outcomes.attach;
      return { outcome: "recorded", receiptId: input.receiptId };
    },
    listAttachments: async () => [...attachments],
    archive: async () => outcomes.archive ?? { outcome: "not_found" },
  };
  const service = createSkillService({
    authorization: createAuthorizationPolicy({}),
    store,
    objects: createMemoryCheckpointObjectStore(),
    newId,
  });
  return { service, rows, attachments, calls, outcomes };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code: string;
      details?: { reason_code?: string };
    };
    return `${failure.code}:${failure.details?.reason_code ?? ""}`;
  }
  return "done";
};

describe("the skill service", () => {
  test("no write goes through with an API key, and a member cannot register", async () => {
    const { service, rows, calls } = setup();
    const api = caller("api");
    expect(await refusal(service.register(api, upload("research")))).toBe(
      "FORBIDDEN:web_session_required",
    );
    expect(rows).toHaveLength(0);
    const id = "00000000-0000-4000-8000-000000000001";
    for (const write of [
      service.review(api, id, { decision: "approved" }),
      service.archive(api, id),
      service.putWorkspaceAttachment(api, "research", {
        version_id: id,
        mode: "required",
      }),
      service.deleteWorkspaceAttachment(api, "research"),
      service.putAgentAttachment(api, AGENT, "research", {
        version_id: id,
        mode: "optional",
      }),
      service.deleteAgentAttachment(api, AGENT, "research"),
    ]) {
      expect(await refusal(write)).toBe("FORBIDDEN:web_session_required");
    }
    expect(calls).toHaveLength(0);
    expect(
      await refusal(service.register(caller("web", "member"), upload("x"))),
    ).toStartWith("FORBIDDEN");
  });

  test("an upload is one skill directory; its issues name the uploaded paths", async () => {
    const { service } = setup();
    const web = caller("web");
    const registered = await service.register(web, upload("research"));
    expect(registered.outcome).toBe("registered");
    expect(registered.version).toMatchObject({
      name: "research",
      version: 1,
      has_scripts: true,
      review: "pending",
    });
    const again = await service.register(web, upload("research"));
    expect(again).toMatchObject({
      outcome: "already_registered",
      receipt_id: null,
    });
    const next = await service.register(web, upload("research", "Again.\n"));
    expect(next.version.version).toBe(2);

    try {
      await service.register(web, {
        name: "research",
        files: [
          { path: "SKILL.md", content_base64: b64(skillMd("research")) },
          {
            path: ".claude-plugin/plugin.json",
            content_base64: b64("{}"),
          },
          { path: "other/SKILL.md", content_base64: b64(skillMd("other")) },
        ],
      });
      throw new Error("expected a refusal");
    } catch (error) {
      const details = (error as { details: { issues: unknown[] } }).details;
      expect(details.issues).toEqual([
        expect.objectContaining({
          path: ".claude-plugin/plugin.json",
          code: "engine_manifest",
        }),
        expect.objectContaining({
          path: "other/SKILL.md",
          code: "multiple_skills",
        }),
      ]);
    }
  });

  test("the files of a version and the diff from the previous approved one", async () => {
    const { service } = setup();
    const web = caller("web");
    const first = await service.register(web, upload("research", "one\ntwo\n"));
    const pendingFirst = await service.files(web, first.version.id);
    expect(pendingFirst.previous_approved).toBeNull();
    expect(pendingFirst.files.map((f) => [f.path, f.change])).toEqual([
      [".claude-plugin/plugin.json", "added"],
      ["skills/research/SKILL.md", "added"],
      ["skills/research/scripts/run.sh", "added"],
    ]);
    expect(pendingFirst.files[2]).toMatchObject({
      executable: true,
      text: "echo hi\n",
      diff: null,
    });

    await service.review(web, first.version.id, { decision: "approved" });
    const second = await service.register(web, {
      name: "research",
      files: [
        {
          path: "SKILL.md",
          content_base64: b64(skillMd("research", "one\nthree\n")),
        },
        { path: "logo.png", content_base64: b64("\u0000PNG") },
      ],
    });
    const view = await service.files(web, second.version.id);
    expect(view.previous_approved?.id).toBe(first.version.id);
    const skill = view.files.find((f) => f.path === "skills/research/SKILL.md");
    expect(skill?.change).toBe("changed");
    expect(skill?.diff).toContain("-two\n+three");
    expect(view.files.find((f) => f.path.endsWith("logo.png"))).toMatchObject({
      change: "added",
      text: null,
    });
    expect(view.removed.map((f) => f.path)).toEqual([
      "skills/research/scripts/run.sh",
    ]);
    expect(
      await refusal(service.files(caller("web", "member"), second.version.id)),
    ).toStartWith("FORBIDDEN");
  });

  test("store refusals map to their errors", async () => {
    const { service, outcomes } = setup();
    const web = caller("web");
    const { version } = await service.register(web, upload("research"));
    outcomes.review = { outcome: "self_review" };
    expect(
      await refusal(service.review(web, version.id, { decision: "approved" })),
    ).toBe("FORBIDDEN:self_review");
    for (const [result, expected] of [
      [{ outcome: "attached" }, "BAD_REQUEST:version_attached"],
      [{ outcome: "in_use" }, "BAD_REQUEST:version_in_use"],
      [{ outcome: "self_review" }, "FORBIDDEN:self_review"],
    ] as const) {
      outcomes.archive = result;
      expect(await refusal(service.archive(web, version.id))).toBe(expected);
    }
    for (const [result, expected] of [
      [{ outcome: "not_approved" }, "BAD_REQUEST:version_not_approved"],
      [{ outcome: "archived" }, "BAD_REQUEST:version_archived"],
      [{ outcome: "outranked" }, "FORBIDDEN:role"],
    ] as const) {
      outcomes.attach = result;
      expect(
        await refusal(
          service.putWorkspaceAttachment(web, "research", {
            version_id: version.id,
            mode: "required",
          }),
        ),
      ).toBe(expected);
    }
    expect(
      await refusal(
        service.putWorkspaceAttachment(web, "other", {
          version_id: version.id,
          mode: "optional",
        }),
      ),
    ).toBe("BAD_REQUEST:version_name_mismatch");
  });

  test("an agent attachment goes to the store with the agent's manager roles", async () => {
    const { service, calls, attachments, rows } = setup();
    const web = caller("web");
    const { version } = await service.register(web, upload("research"));
    await service.putAgentAttachment(web, AGENT, "research", {
      version_id: version.id,
      mode: "optional",
    });
    expect(calls[0]).toMatchObject({
      scope: "agent",
      agentId: AGENT,
      kind: "attach",
      mode: "optional",
    });
    expect(
      await service.deleteAgentAttachment(web, AGENT, "research"),
    ).toMatchObject({ attachment: null, receipt_id: null });
    attachments.push({
      scope: "agent",
      mode: "optional",
      bundle: rows[0] as ExtensionBundle,
    });
    const taken = await service.deleteAgentAttachment(web, AGENT, "research");
    expect(taken.receipt_id).not.toBeNull();
    expect(calls[1]).toMatchObject({ kind: "detach", bundleId: version.id });
  });
});
