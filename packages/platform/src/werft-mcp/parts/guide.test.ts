import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { skillNameSchema } from "@werft-ai/contracts";
import {
  checkSkillVersion,
  INSTRUCTION_PATTERNS,
  plainTextHostExtractor,
} from "../../extensions/skill-checks.ts";
import { WERFT_FIRST_RULE } from "../instructions.ts";
import { maskSecrets } from "../secrets.ts";
import { createWerftMcpServer } from "../server.ts";
import {
  guidePart,
  WERFT_SKILL,
  WERFT_SKILL_ENTRY,
  WERFT_SKILL_NAME,
  WERFT_SKILL_URI,
} from "./guide.ts";

const GRANT = { sessionId: "session-1", attemptId: "att_1" };

type Answer = {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function ask() {
  const handle = createWerftMcpServer({
    parts: [guidePart({ version: "v9.9.9" })],
    version: "v9.9.9",
  });
  return async (method: string, params?: unknown): Promise<Answer> =>
    (await handle(
      GRANT,
      {
        jsonrpc: "2.0",
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      },
      "req-1",
    )) as Answer;
}

function frontmatterOf(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match === null) throw new Error("no frontmatter");
  return Object.fromEntries(
    (match[1] ?? "").split("\n").map((line) => {
      const at = line.indexOf(": ");
      return [line.slice(0, at), line.slice(at + 2)];
    }),
  );
}

describe("the guide part of the built-in werft server", () => {
  test("serves its usage guide as a read-only tool whose description carries the criteria", async () => {
    const server = ask();
    const tools = (await server("tools/list")).result?.tools as {
      name: string;
      description: string;
      annotations: unknown;
    }[];
    expect(tools.map((tool) => tool.name)).toEqual(["read_skill"]);
    const [tool] = tools;
    expect(tool?.annotations).toEqual({ readOnlyHint: true });
    // The criteria, as the instructions have them, for an engine that reads only descriptions.
    expect(tool?.description).toContain(WERFT_FIRST_RULE);
    expect(tool?.description).toContain("never returns a secret value");
    expect(tool?.description).toContain('"Can you use GitHub?"');
    expect(tool?.description).toContain(WERFT_SKILL_URI);
    // Arguments an engine adds on its own are no reason to refuse.
    expect(
      (
        await server("tools/call", {
          name: "read_skill",
          arguments: { name: "werft" },
        })
      ).result,
    ).toEqual({ content: [{ type: "text", text: WERFT_SKILL }] });
  });

  test("serves the same guide as the skill resource, with an entry that binds its bytes", async () => {
    const server = ask();
    expect((await server("resources/list")).result?.resources).toEqual([
      {
        uri: WERFT_SKILL_URI,
        name: WERFT_SKILL_NAME,
        title: "Werft usage guide",
        description: WERFT_SKILL_ENTRY.frontmatter.description,
        mimeType: "text/markdown",
      },
    ]);
    const read = (await server("resources/read", { uri: WERFT_SKILL_URI }))
      .result?.contents as { uri: string; mimeType: string; text: string }[];
    expect(read).toEqual([
      { uri: WERFT_SKILL_URI, mimeType: "text/markdown", text: WERFT_SKILL },
    ]);
    // What a host verifies: the bytes read match the manifest, and the
    // frontmatter the entry. The server masks on the way out, so the guide
    // holds nothing it would mask and change the digest of.
    const bytes = new TextEncoder().encode(read[0]?.text);
    expect(WERFT_SKILL_ENTRY.resources).toEqual([
      {
        uri: WERFT_SKILL_URI,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.byteLength,
      },
    ]);
    expect(maskSecrets(WERFT_SKILL)).toBe(WERFT_SKILL);
    expect(frontmatterOf(WERFT_SKILL)).toEqual(WERFT_SKILL_ENTRY.frontmatter);
    // The URI ends in the skill's name, which is a valid Werft skill name.
    expect(WERFT_SKILL_URI).toBe(`skill://${WERFT_SKILL_NAME}/SKILL.md`);
    expect(skillNameSchema.safeParse(WERFT_SKILL_NAME).success).toBe(true);
    // A URI that is not its own is no answer of this part.
    expect(
      (await server("resources/read", { uri: "skill://other/SKILL.md" })).error
        ?.code,
    ).toBe(-32002);
  });

  test("the guide passes the checks a workspace skill gets before it is approved", () => {
    const bytes = new TextEncoder().encode(WERFT_SKILL);
    const file = {
      path: "SKILL.md",
      mode: 0o644 as const,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(checkSkillVersion(null, [file], plainTextHostExtractor)).toEqual([]);
    // Nothing that widens what a host lets it do.
    expect(Object.keys(frontmatterOf(WERFT_SKILL))).toEqual([
      "name",
      "description",
    ]);
    for (const line of WERFT_SKILL.split("\n")) {
      const normal = line.normalize("NFKC").toLowerCase();
      for (const { pattern } of INSTRUCTION_PATTERNS) {
        expect(normal).not.toMatch(pattern);
      }
    }
  });

  test("the guide says to check status first, answer from the console's menus, and give no CLI setup", () => {
    for (const said of [
      "Check this agent's status on the werft server first",
      "connected, not connected, or not allowed for this agent",
      "Werft console menu",
      "search the documentation on the werft server",
      "gh auth login",
      "never returns a secret value",
    ]) {
      expect(WERFT_SKILL).toContain(said);
    }
  });

  test("serves the three common checks as prompts that start from the agent's status", async () => {
    const server = ask();
    const prompts = (await server("prompts/list")).result?.prompts as {
      name: string;
      arguments?: unknown;
    }[];
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      "check_github_connection",
      "check_slack_connection",
      "what_this_agent_can_do",
    ]);
    for (const { name, arguments: args } of prompts) {
      expect(args).toBeUndefined();
      const { result } = await server("prompts/get", { name });
      const messages = result?.messages as {
        role: string;
        content: { type: string; text: string };
      }[];
      expect(messages).toHaveLength(1);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content.text).toContain(
        "Check your status on the werft server first",
      );
      expect(messages[0]?.content.text).toContain("Werft console menu");
    }
  });
});
