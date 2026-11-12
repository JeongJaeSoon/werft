import { describe, expect, test } from "bun:test";
import { attemptOf, batch } from "../testing/ingest.ts";
import { valueMasker } from "./adapters.ts";
import { decodeTraceRequest } from "./otlp-json.ts";
import { sanitizeSpan } from "./sanitize.ts";

const FORGED = "99999999-9999-4999-8999-999999999999";

function run(
  options: Parameters<typeof batch>[0],
  ctx: Partial<Parameters<typeof sanitizeSpan>[1]> = {},
) {
  const [span] = decodeTraceRequest(batch(options));
  if (span === undefined) throw new Error("no span");
  return sanitizeSpan(span, {
    attempt: attemptOf(),
    contentMode: "full",
    contentDropped: false,
    fenced: false,
    masker: valueMasker,
    ...ctx,
  });
}

const forged: [string, string][] = [
  ["werft.workspace_id", FORGED],
  ["werft.session_id", FORGED],
  ["langfuse.trace.public", "true"],
  ["langfuse.user.id", "mallory"],
  ["session.id", FORGED],
  ["gen_ai.conversation.id", FORGED],
];

describe("tenant attributes", () => {
  test("a forged workspace or backend key survives at no level", () => {
    const out = run({
      attributes: forged,
      eventAttributes: forged,
      linkAttributes: forged,
      resource: forged,
    });
    const levels = [
      out.attributes,
      out.resource,
      ...out.events.map((e) => e.attributes),
      ...out.links.map((l) => l.attributes),
    ];
    for (const level of levels) {
      expect(JSON.stringify(level)).not.toContain(FORGED);
      expect(Object.keys(level).some((k) => k.startsWith("langfuse."))).toBe(
        false,
      );
    }
  });

  test("the credential's own identity is stamped on span and resource", () => {
    const attempt = attemptOf();
    const out = run({ attributes: forged, resource: forged });
    for (const level of [out.attributes, out.resource]) {
      expect(level["werft.workspace_id"]).toBe(attempt.workspaceId);
      expect(level["werft.session_id"]).toBe(attempt.sessionId);
      expect(level["session.id"]).toBe(attempt.sessionId);
      expect(level["gen_ai.conversation.id"]).toBe(attempt.sessionId);
      expect(level["werft.attempt_id"]).toBe(attempt.attemptId);
    }
    expect(out.resource["werft.execution_id"]).toBe("exe_1");
    expect(out.resource["werft.execution_generation"]).toBe(3);
  });

  test("a session without a workspace stamps none, so it goes to the install tenant", () => {
    const out = run(
      { attributes: forged },
      { attempt: attemptOf({ workspaceId: undefined }) },
    );
    expect("werft.workspace_id" in out.attributes).toBe(false);
  });

  test("no collector-specific key is added", () => {
    const out = run({ attributes: [["gen_ai.tool.call.result", "ok"]] });
    const keys = [...Object.keys(out.attributes), ...Object.keys(out.resource)];
    expect(keys.filter((k) => k.startsWith("langfuse."))).toEqual([]);
  });
});

describe("content mode", () => {
  const content: [string, string][] = [
    ["gen_ai.tool.call.result", "secret output"],
    ["gen_ai.tool.call.arguments", "{}"],
    ["gen_ai.tool.name", "Bash"],
  ];

  test("metadata mode removes content at every level and keeps the rest", () => {
    const out = run(
      {
        attributes: content,
        eventAttributes: content,
        linkAttributes: content,
      },
      { contentMode: "metadata" },
    );
    for (const level of [
      out.attributes,
      out.events[0]?.attributes ?? {},
      out.links[0]?.attributes ?? {},
    ]) {
      expect("gen_ai.tool.call.result" in level).toBe(false);
      expect("gen_ai.tool.call.arguments" in level).toBe(false);
      expect(level["gen_ai.tool.name"]).toBe("Bash");
    }
  });

  test("metadata mode passes only keys that describe the work", () => {
    const out = run(
      {
        attributes: [
          ["output.value", "private tool output"],
          ["input.value", "private"],
          ["werft.tool.name", "x".repeat(1000)],
        ],
        eventAttributes: [["output.value", "private tool output"]],
        resource: [
          ["output.value", "private"],
          ["service.name", "worker"],
        ],
        statusMessage: "free text with private details",
      },
      { contentMode: "metadata" },
    );
    for (const level of [
      out.attributes,
      out.resource,
      out.events[0]?.attributes ?? {},
    ]) {
      expect(JSON.stringify(level)).not.toContain("private");
    }
    expect(out.attributes["werft.tool.name"]).toHaveLength(256);
    expect(out.resource["service.name"]).toBe("worker");
    expect(out.status.message).toBeUndefined();
  });

  test("full mode keeps content, masked a second time", () => {
    const out = run({
      attributes: [
        [
          "gen_ai.tool.call.result",
          "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        ],
      ],
    });
    expect(out.attributes["gen_ai.tool.call.result"]).not.toContain("sk-ant");
  });

  test("an exhausted trace budget drops content and says so", () => {
    const out = run({ attributes: content }, { contentDropped: true });
    expect("gen_ai.tool.call.result" in out.attributes).toBe(false);
    expect(out.attributes["werft.content_dropped"]).toBe(true);
  });

  test("a status message is masked", () => {
    const out = run({
      statusMessage:
        "failed with sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect(out.status.message).not.toContain("sk-ant");
  });
});

describe("fence", () => {
  test("a span from a fenced attempt is tagged, a held one is not", () => {
    expect(run({}, { fenced: true }).attributes["werft.fenced"]).toBe(true);
    expect(
      "werft.fenced" in
        run({ attributes: [["werft.fenced", true]] }).attributes,
    ).toBe(false);
  });
});
