import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createSdkMcpServer,
  type HookEvent,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createProbeContext,
  deadline,
  type FakeAnthropicServer,
  type ProbeContext,
  runSdkQuery,
  sdkOptions,
  startFakeAnthropicServer,
  textReply,
  toolReply,
  toolsReply,
} from "./harness";

/** How long one AskUserQuestion callback waits for its sibling to arrive. */
const CONCURRENT_CALLBACK_WINDOW_MS = 5_000;

let context: ProbeContext | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await context?.dispose();
  context = undefined;
  server = undefined;
});

describe.serial("Agent SDK 0.3.319 and Claude Code 2.1.319", () => {
  test("loads project instructions and the Claude Code system preset", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer(() => textReply("contract passed"));
    await writeFile(
      join(context.workspace, "CLAUDE.md"),
      "PROJECT_INSTRUCTION_SENTINEL_SDK_COMPAT",
    );
    const rulesDirectory = join(context.workspace, ".claude", "rules");
    await mkdir(rulesDirectory, { recursive: true });
    await writeFile(
      join(rulesDirectory, "contract-rule.md"),
      "PROJECT_RULE_SENTINEL_SDK_COMPAT",
    );

    const messages = await runSdkQuery(context, server.url, "Reply briefly.", {
      maxTurns: 1,
    });
    const request = JSON.stringify(server.requests[0]);

    expect(request).toContain("PROJECT_INSTRUCTION_SENTINEL_SDK_COMPAT");
    expect(request).toContain("PROJECT_RULE_SENTINEL_SDK_COMPAT");
    expect(request).toContain("APPEND_SENTINEL_SDK_COMPAT");
    expect(server.requests[0]?.path).toBe("/v1/messages?beta=true");
    expect(messageTypes(messages)).toEqual(["system", "assistant", "result"]);
    expect(JSON.stringify(messages)).toContain("contract passed");
  }, 30_000);

  test("expands and invokes a project custom command", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer(() => textReply("command complete"));
    const commandsDirectory = join(context.workspace, ".claude", "commands");
    await mkdir(commandsDirectory, { recursive: true });
    await writeFile(
      join(commandsDirectory, "contract-command.md"),
      "CUSTOM_COMMAND_SENTINEL_SDK_COMPAT arguments=$ARGUMENTS",
    );

    await runSdkQuery(
      context,
      server.url,
      "/contract-command payload-sdk-compat",
      {
        maxTurns: 1,
      },
    );

    const request = JSON.stringify(server.requests[0]?.body.messages);
    expect(request).toContain("CUSTOM_COMMAND_SENTINEL_SDK_COMPAT");
    expect(request).toContain("payload-sdk-compat");
  }, 30_000);

  test("invokes a project skill through the native Skill tool", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Skill",
            { skill: "contract-skill" },
            "toolu_sdkcompat_skill",
          )
        : textReply("skill complete"),
    );
    const skillDirectory = join(
      context.workspace,
      ".claude",
      "skills",
      "contract-skill",
    );
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: contract-skill",
        "description: Contract probe skill",
        "---",
        "SKILL_SENTINEL_SDK_COMPAT",
      ].join("\n"),
    );

    await runSdkQuery(context, server.url, "Use the contract skill.", {
      skills: ["contract-skill"],
    });

    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "SKILL_SENTINEL_SDK_COMPAT",
    );
  }, 30_000);

  test("invokes an in-process local MCP tool", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "mcp__contract__echo",
            { value: "mcp-input-sdk-compat" },
            "toolu_sdkcompat_mcp",
          )
        : textReply("mcp complete"),
    );
    const calls: string[] = [];
    const mcpServer = createSdkMcpServer({
      name: "contract",
      version: "1.0.0",
      tools: [
        tool(
          "echo",
          "Echo the contract probe value",
          { value: z.string() },
          async ({ value }) => {
            calls.push(value);
            return {
              content: [
                { type: "text", text: `MCP_SENTINEL_SDK_COMPAT:${value}` },
              ],
            };
          },
        ),
      ],
    });

    await runSdkQuery(context, server.url, "Use the local MCP tool.", {
      allowedTools: ["mcp__contract__echo"],
      mcpServers: { contract: mcpServer },
    });

    expect(calls).toEqual(["mcp-input-sdk-compat"]);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "MCP_SENTINEL_SDK_COMPAT:mcp-input-sdk-compat",
    );
  }, 30_000);

  test("loads and invokes a command from a local plugin", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer(() => textReply("plugin complete"));
    const pluginRoot = join(context.root, "contract-plugin");
    await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await writeFile(
      join(pluginRoot, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        description: "SDK gate contract plugin",
        name: "contract-plugin",
        version: "1.0.0",
      }),
    );
    await writeFile(
      join(pluginRoot, "commands", "probe.md"),
      "PLUGIN_COMMAND_SENTINEL_SDK_COMPAT arguments=$ARGUMENTS",
    );

    await runSdkQuery(
      context,
      server.url,
      "/contract-plugin:probe plugin-payload-sdk-compat",
      { maxTurns: 1, plugins: [{ path: pluginRoot, type: "local" }] },
    );

    const request = JSON.stringify(server.requests[0]?.body.messages);
    expect(request).toContain("PLUGIN_COMMAND_SENTINEL_SDK_COMPAT");
    expect(request).toContain("plugin-payload-sdk-compat");
  }, 30_000);

  test("invokes a configured subagent and returns its result", async () => {
    context = await createProbeContext();
    server = startFakeAnthropicServer((_request, index) => {
      if (index === 0) {
        return toolReply(
          "Agent",
          {
            description: "Run the SDK gate subagent",
            prompt: "SUBAGENT_TASK_SENTINEL_SDK_COMPAT",
            subagent_type: "contract-subagent",
          },
          "toolu_sdkcompat_agent",
        );
      }
      return index === 1
        ? textReply("SUBAGENT_RESULT_SENTINEL_SDK_COMPAT")
        : textReply("subagent complete");
    });

    await runSdkQuery(context, server.url, "Delegate the probe.", {
      agents: {
        "contract-subagent": {
          description: "SDK gate subagent",
          prompt: "SUBAGENT_PROMPT_SENTINEL_SDK_COMPAT",
          tools: [],
        },
      },
      allowedTools: ["Agent"],
      tools: ["Agent"],
    });

    const requests = JSON.stringify(server.requests);
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    expect(requests).toContain("SUBAGENT_TASK_SENTINEL_SDK_COMPAT");
    expect(requests).toContain("SUBAGENT_PROMPT_SENTINEL_SDK_COMPAT");
    expect(requests).toContain("SUBAGENT_RESULT_SENTINEL_SDK_COMPAT");
  }, 30_000);

  test("keeps concurrent AskUserQuestion answers bound to their tool IDs", async () => {
    context = await createProbeContext();
    const question = (label: string) => ({
      header: label,
      multiSelect: false,
      options: [
        { description: `${label} first`, label: `${label}-one` },
        { description: `${label} second`, label: `${label}-two` },
      ],
      question: `Choose ${label}`,
    });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolsReply([
            {
              id: "toolu_sdkcompat_question_alpha",
              input: { questions: [question("alpha")] },
              name: "AskUserQuestion",
            },
            {
              id: "toolu_sdkcompat_question_beta",
              input: { questions: [question("beta")] },
              name: "AskUserQuestion",
            },
          ])
        : textReply("questions complete"),
    );
    const callbackAnswers = new Map<string, string>();
    let activeCallbacks = 0;
    let maximumActiveCallbacks = 0;
    // Both callbacks are held until the second one arrives, so the overlap is
    // observed rather than raced for. A fixed sleep only overlaps when the SDK
    // happens to dispatch the second call inside it, which a loaded runner
    // does not guarantee. The bound keeps a genuinely serialising SDK a named
    // assertion failure instead of a deadlock.
    const bothInFlight = Promise.withResolvers<void>();

    await runSdkQuery(context, server.url, "Ask both questions.", {
      canUseTool: async (name, input, options) => {
        expect(name).toBe("AskUserQuestion");
        activeCallbacks += 1;
        maximumActiveCallbacks = Math.max(
          maximumActiveCallbacks,
          activeCallbacks,
        );
        if (activeCallbacks === 2) bothInFlight.resolve();
        const barrier = deadline(CONCURRENT_CALLBACK_WINDOW_MS);
        await Promise.race([bothInFlight.promise, barrier.expired]);
        barrier.cancel();
        const answer = options.toolUseID.endsWith("alpha")
          ? "alpha custom response"
          : "beta-one";
        callbackAnswers.set(options.toolUseID, answer);
        activeCallbacks -= 1;
        const firstQuestion = (
          input.questions as Array<{ question: string }>
        )[0]?.question;
        return {
          behavior: "allow",
          updatedInput: {
            ...input,
            answers:
              firstQuestion === undefined ? {} : { [firstQuestion]: answer },
          },
        };
      },
      tools: ["AskUserQuestion"],
    });

    expect(maximumActiveCallbacks).toBe(2);
    expect(callbackAnswers).toEqual(
      new Map([
        ["toolu_sdkcompat_question_alpha", "alpha custom response"],
        ["toolu_sdkcompat_question_beta", "beta-one"],
      ]),
    );
    const followUp = JSON.stringify(server.requests[1]?.body.messages);
    expect(followUp).toContain("toolu_sdkcompat_question_alpha");
    expect(followUp).toContain("alpha custom response");
    expect(followUp).toContain("toolu_sdkcompat_question_beta");
    expect(followUp).toContain("beta-one");
  }, 30_000);

  test("resumes in a new CLI process without re-running a completed tool", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "resume-once.txt");
    server = startFakeAnthropicServer((_request, index) => {
      if (index === 0) {
        return toolReply(
          "Bash",
          { command: `printf once >> ${JSON.stringify(outputPath)}` },
          "toolu_sdkcompat_resume_once",
        );
      }
      return index === 1
        ? textReply("FIRST_TURN_COMPLETE_SDK_COMPAT")
        : textReply("RESUMED_TURN_COMPLETE_SDK_COMPAT");
    });

    const firstMessages = await runSdkQuery(
      context,
      server.url,
      "Run the command once.",
      {
        allowedTools: ["Bash"],
        tools: ["Bash"],
      },
    );
    const sessionId = sessionIdFrom(firstMessages);
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const resumedMessages = await runSdkQuery(
      context,
      server.url,
      "Continue after the worker restart.",
      { maxTurns: 1, resume: sessionId },
    );

    expect(await readFile(outputPath, "utf8")).toBe("once");
    expect(JSON.stringify(server.requests.at(-1)?.body.messages)).toContain(
      "FIRST_TURN_COMPLETE_SDK_COMPAT",
    );
    expect(JSON.stringify(resumedMessages)).toContain(
      "RESUMED_TURN_COMPLETE_SDK_COMPAT",
    );
  }, 30_000);

  test("deduplicates a stable user UUID but treats a regenerated UUID as a new turn", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "repeated-user-message.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0 || index === 2
        ? toolReply(
            "Bash",
            { command: `printf 'once\\n' >> ${JSON.stringify(outputPath)}` },
            `toolu_sdkcompat_repeated_${index}`,
          )
        : textReply(`turn ${index} complete`),
    );
    const uuid = crypto.randomUUID();

    const firstMessages: SDKMessage[] = [];
    for await (const message of query({
      prompt: oneMessage("Run the repeated message fixture.", uuid),
      options: sdkOptions(context, server.url, {
        allowedTools: ["Bash"],
        tools: ["Bash"],
      }),
    })) {
      firstMessages.push(message);
    }

    for await (const _message of query({
      prompt: oneMessage("Run the repeated message fixture.", uuid),
      options: sdkOptions(context, server.url, {
        allowedTools: ["Bash"],
        resume: sessionIdFrom(firstMessages),
        tools: ["Bash"],
      }),
    })) {
      void _message;
    }

    expect(await readFile(outputPath, "utf8")).toBe("once\n");

    for await (const _message of query({
      prompt: oneMessage(
        "Run the repeated message fixture.",
        crypto.randomUUID(),
      ),
      options: sdkOptions(context, server.url, {
        allowedTools: ["Bash"],
        resume: sessionIdFrom(firstMessages),
        tools: ["Bash"],
      }),
    })) {
      void _message;
    }

    expect(await readFile(outputPath, "utf8")).toBe("once\nonce\n");
  }, 30_000);

  test("interrupts only the current turn and accepts a same-process follow-up", async () => {
    context = await createProbeContext();
    const firstRequestStarted = deferred<void>();
    const sendFollowUp = deferred<void>();
    server = startFakeAnthropicServer(async (_request, index) => {
      if (index === 0) {
        firstRequestStarted.resolve();
        await Bun.sleep(500);
        return textReply("INTERRUPTED_RESPONSE_MUST_NOT_SURFACE_SDK_COMPAT");
      }
      return textReply("FOLLOW_UP_RESPONSE_SDK_COMPAT");
    });
    const firstUuid = crypto.randomUUID();
    const followUpUuid = crypto.randomUUID();
    const prompts = async function* (): AsyncGenerator<SDKUserMessage> {
      yield userMessage("Start a slow turn.", firstUuid);
      await sendFollowUp.promise;
      yield userMessage("Run the follow-up.", followUpUuid);
    };
    const sdkQuery = query({
      prompt: prompts(),
      options: sdkOptions(context, server.url),
    });
    const messages: SDKMessage[] = [];
    const consume = (async () => {
      for await (const message of sdkQuery) {
        messages.push(message);
      }
    })();

    await firstRequestStarted.promise;
    const receipt = await sdkQuery.interrupt();
    sendFollowUp.resolve();
    await consume;

    expect(receipt?.still_queued).toEqual([]);
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain(
      "INTERRUPTED_RESPONSE_MUST_NOT_SURFACE_SDK_COMPAT",
    );
    expect(serialized).toContain("FOLLOW_UP_RESPONSE_SDK_COMPAT");
    expect(serialized).toContain(firstUuid);
    expect(serialized).toContain(followUpUuid);
  }, 30_000);

  test("routes a Bash permission ask through canUseTool and invokes hooks", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "permission-allowed.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf allowed > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_allowed",
          )
        : textReply("tool complete"),
    );
    const callbacks: Array<{
      event: string;
      requestId?: string;
      toolUseId?: string;
    }> = [];

    const messages = await runSdkQuery(
      context,
      server.url,
      "Run the command.",
      {
        canUseTool: async (_name, input, options) => {
          callbacks.push({
            event: "canUseTool",
            requestId: options.requestId,
            toolUseId: options.toolUseID,
          });
          return { behavior: "allow", updatedInput: input };
        },
        hooks: Object.fromEntries(
          (["PreToolUse", "PostToolUse"] satisfies HookEvent[]).map((event) => [
            event,
            [
              {
                hooks: [
                  async (_input: unknown, toolUseId: string | undefined) => {
                    callbacks.push({
                      event,
                      ...(toolUseId === undefined ? {} : { toolUseId }),
                    });
                    return { continue: true };
                  },
                ],
              },
            ],
          ]),
        ),
        permissionMode: "default",
        tools: ["Bash"],
      },
    );

    expect(await readFile(outputPath, "utf8")).toBe("allowed");
    expect(callbacks).toContainEqual({
      event: "canUseTool",
      requestId: expect.any(String),
      toolUseId: "toolu_sdkcompat_allowed",
    });
    expect(callbacks).toContainEqual({
      event: "PreToolUse",
      toolUseId: "toolu_sdkcompat_allowed",
    });
    expect(callbacks).toContainEqual({
      event: "PostToolUse",
      toolUseId: "toolu_sdkcompat_allowed",
    });
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
    expect(messageTypes(messages)).toContain("result");
  }, 30_000);

  test("a session rule returned with an allow lets the next calls pass without canUseTool", async () => {
    context = await createProbeContext();
    const command = "touch session-rule.txt";
    server = startFakeAnthropicServer((_request, index) =>
      index < 3
        ? toolReply("Bash", { command }, `toolu_sdkcompat_session_${index}`)
        : textReply("session rule complete"),
    );
    const asked: string[] = [];

    await runSdkQuery(context, server.url, "Run the command.", {
      canUseTool: async (_name, input, options) => {
        asked.push(options.toolUseID);
        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: [
            {
              type: "addRules",
              behavior: "allow",
              destination: "session",
              rules: [{ toolName: "Bash", ruleContent: command }],
            },
          ],
        };
      },
      permissionMode: "default",
      tools: ["Bash"],
    });

    // Once the rule is installed, the later calls are not asked about.
    expect(asked).toEqual(["toolu_sdkcompat_session_0"]);
    // All three calls ran: two tool results came back after the first.
    expect(JSON.stringify(server.requests.at(-1)?.body.messages)).toContain(
      "toolu_sdkcompat_session_2",
    );
  }, 60_000);

  test("a session rule lives in the engine process: a new engine asks about the same call again", async () => {
    context = await createProbeContext();
    const command = "touch session-rule.txt";
    const askedByRun: string[][] = [];
    let resume: string | undefined;
    for (const run of [0, 1]) {
      server = startFakeAnthropicServer((_request, index) =>
        index < 2
          ? toolReply(
              "Bash",
              { command },
              `toolu_sdkcompat_restart_${run}_${index}`,
            )
          : textReply("restart complete"),
      );
      const asked: string[] = [];
      const messages = await runSdkQuery(
        context,
        server.url,
        "Run the command.",
        {
          // The second engine resumes the first one's conversation, so only
          // the process, not the transcript, differs between the runs.
          ...(resume === undefined ? {} : { resume }),
          canUseTool: async (_name, input, options) => {
            asked.push(options.toolUseID);
            return {
              behavior: "allow",
              updatedInput: input,
              updatedPermissions: [
                {
                  type: "addRules",
                  behavior: "allow",
                  destination: "session",
                  rules: [{ toolName: "Bash", ruleContent: command }],
                },
              ],
            };
          },
          permissionMode: "default",
          tools: ["Bash"],
        },
      );
      resume = messages.find((message) => "session_id" in message)?.session_id;
      expect(resume).toBeDefined();
      askedByRun.push(asked);
      server.stop();
    }
    // Each engine asks once for the first call and not for the second.
    expect(askedByRun).toEqual([
      ["toolu_sdkcompat_restart_0_0"],
      ["toolu_sdkcompat_restart_1_0"],
    ]);
  }, 90_000);

  test("a PreToolUse deny binds a call that a session rule would let through", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "session-rule-denied.txt");
    const command = `printf x >> ${JSON.stringify(outputPath)}`;
    server = startFakeAnthropicServer((_request, index) =>
      index < 2
        ? toolReply("Bash", { command }, `toolu_sdkcompat_hooked_${index}`)
        : textReply("hook complete"),
    );
    const asked: string[] = [];

    await runSdkQuery(context, server.url, "Run the command.", {
      canUseTool: async (_name, input, options) => {
        asked.push(options.toolUseID);
        return {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: [
            {
              type: "addRules",
              behavior: "allow",
              destination: "session",
              rules: (options.suggestions ?? []).flatMap((update) =>
                update.type === "addRules" ? update.rules : [],
              ),
            },
          ],
        };
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (_input: unknown, toolUseId: string | undefined) =>
                toolUseId === "toolu_sdkcompat_hooked_1"
                  ? {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason: "outside the allowlist",
                      },
                    }
                  : { continue: true },
            ],
          },
        ],
      },
      permissionMode: "default",
      tools: ["Bash"],
    });

    // The first call ran and installed the rule. The second never asked
    // canUseTool, and the hook's deny still stopped it.
    expect(asked).toEqual(["toolu_sdkcompat_hooked_0"]);
    expect(await readFile(outputPath, "utf8")).toBe("x");
  }, 60_000);

  // A platform tool (`trusted`) gets a PreToolUse allow from the adapter and
  // nothing else: the claim is that the allow takes the call out of the
  // whole permission stage, the auto classifier included. The auto stage is
  // in play only on a model it is offered for (`claude-sonnet-5`; on
  // `claude-sonnet-4-5`, the harness default, auto asks canUseTool and never
  // judges). On the fake upstream the control run is refused by the safety
  // check and the allowed run must not be.
  // The in-process server stands in for the adapter's relay, which is an
  // SDK MCP server too.
  describe("a PreToolUse allow on an MCP tool", () => {
    const PUSH = "mcp__github__request_push";
    const allowHook = async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "allow" as const,
      },
    });
    const denyHook = async () => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "outside the allowlist",
      },
    });
    async function pushRun(
      permissionMode: "auto" | "default",
      hooks: (typeof allowHook | typeof denyHook)[],
    ) {
      context = await createProbeContext();
      server = startFakeAnthropicServer((request, index) =>
        index === 0
          ? toolReply(PUSH, { value: "p" }, "toolu_sdkcompat_trusted")
          : (request.body.tools ?? []).length === 0
            ? // The classifier's question; no verdict it can parse.
              textReply("no verdict")
            : textReply("push complete"),
      );
      const ran: string[] = [];
      const asked: string[] = [];
      await runSdkQuery(context, server.url, "Push it.", {
        model: "claude-sonnet-5",
        canUseTool: async (name, input) => {
          asked.push(name);
          return { behavior: "allow", updatedInput: input };
        },
        hooks:
          hooks.length === 0
            ? {}
            : { PreToolUse: hooks.map((hook) => ({ hooks: [hook] })) },
        mcpServers: {
          github: createSdkMcpServer({
            name: "github",
            version: "1.0.0",
            tools: [
              tool(
                "request_push",
                "Push the checkpoint",
                { value: z.string() },
                async ({ value }) => {
                  ran.push(value);
                  return { content: [{ type: "text", text: "pushed" }] };
                },
              ),
            ],
          }),
        },
        permissionMode,
      });
      const classifierRequests = server.requests.filter(
        (request) =>
          (request.body.tools ?? []).length === 0 &&
          JSON.stringify(request.body).includes("request_push"),
      ).length;
      return { asked, classifierRequests, ran };
    }

    // 0.3.319 judges an auto call on the server's side, so no classifier
    // request reaches the fake upstream. With no server verdict, auto mode
    // refuses the call and says so in the tool result: that refusal is how
    // the control run shows the stage is in play.
    const autoRefusals = () =>
      (server?.requests ?? []).filter((request) =>
        JSON.stringify(request.body).includes("Auto mode is unavailable"),
      ).length;

    test("auto: a control run is refused by the safety check, and the allow is not", async () => {
      const control = await pushRun("auto", []);
      expect(autoRefusals()).toBeGreaterThan(0);
      expect(control).toEqual({ asked: [], classifierRequests: 0, ran: [] });
      await context?.dispose();
      server?.stop();

      const allowed = await pushRun("auto", [allowHook]);
      expect(autoRefusals()).toBe(0);
      expect(allowed).toEqual({ asked: [], classifierRequests: 0, ran: ["p"] });
    }, 120_000);

    test("default: a control run asks canUseTool, and the allow does not", async () => {
      const control = await pushRun("default", []);
      expect(control).toEqual({
        asked: [PUSH],
        classifierRequests: 0,
        ran: ["p"],
      });
      await context?.dispose();
      server?.stop();

      const allowed = await pushRun("default", [allowHook]);
      expect(allowed).toEqual({ asked: [], classifierRequests: 0, ran: ["p"] });
    }, 120_000);

    test.each([
      ["deny after allow", [allowHook, denyHook]],
      ["deny before allow", [denyHook, allowHook]],
    ] as const)(
      "loses to a PreToolUse deny: %s",
      async (_name, hooks) => {
        const result = await pushRun("auto", [...hooks]);
        expect(result.ran).toEqual([]);
        expect(result.asked).toEqual([]);
      },
      60_000,
    );
  });

  // The engine proposes a rule for the call it asks about, and for a command
  // with a redirect or a second command the rule does not match that call.
  // The adapter's offerableRules relies on this; it has no API to ask.
  test.each([
    ["touch a.txt", "touch a.txt", 1],
    ["git commit -m 'x y'", "git commit *", 1],
    ["echo alpha > hello.txt", "echo alpha *", 2],
    ["echo alpha >> hello.txt", "echo alpha *", 2],
    ["cd sub && touch b.txt", "cd sub *", 2],
  ])(
    "the rule the engine suggests for %s is %s and the same call is asked %d time(s)",
    async (command, suggested, askedCount) => {
      context = await createProbeContext();
      server = startFakeAnthropicServer((_request, index) =>
        index < 2
          ? toolReply("Bash", { command }, `toolu_sdkcompat_suggest_${index}`)
          : textReply("suggestion complete"),
      );
      const rules: string[] = [];
      let asked = 0;

      await runSdkQuery(context, server.url, "Run the command.", {
        canUseTool: async (_name, input, options) => {
          asked += 1;
          const proposed = (options.suggestions ?? []).flatMap((update) =>
            update.type === "addRules" && update.behavior === "allow"
              ? update.rules
              : [],
          );
          for (const rule of proposed) rules.push(rule.ruleContent ?? "");
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: [
              {
                type: "addRules",
                behavior: "allow",
                destination: "session",
                rules: proposed,
              },
            ],
          };
        },
        permissionMode: "default",
        tools: ["Bash"],
      });

      expect(new Set(rules)).toEqual(new Set([suggested]));
      expect(asked).toBe(askedCount);
    },
    60_000,
  );

  test("bypasses canUseTool for a fully allowed Bash rule", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "rule-allowed.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf rule > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_rule",
          )
        : textReply("tool complete"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Run the command.", {
      allowedTools: ["Bash"],
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      permissionMode: "default",
      tools: ["Bash"],
    });

    expect(await readFile(outputPath, "utf8")).toBe("rule");
    expect(callbackCount).toBe(0);
  }, 30_000);

  test("applies a project deny rule before allowedTools and canUseTool", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "project-deny.txt");
    await writeProjectSettings(context, { deny: ["Bash"] });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_project_deny",
          )
        : textReply("deny complete"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Run the command.", {
      allowedTools: ["Bash"],
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(callbackCount).toBe(0);
  }, 30_000);

  test("holds a project allow rule in an untrusted SDK workspace", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "project-allow.txt");
    await writeProjectSettings(context, { allow: ["Bash(*)"] });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf allowed > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_project_allow",
          )
        : textReply("allow complete"),
    );
    let callbackCount = 0;
    const stderr: string[] = [];

    await runSdkQuery(context, server.url, "Run the command.", {
      canUseTool: async () => {
        callbackCount += 1;
        return { behavior: "deny", message: "callback deny" };
      },
      stderr: (line) => stderr.push(line),
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(callbackCount).toBe(1);
    expect(stderr.join("\n")).toContain("workspace has not been trusted");
  }, 30_000);

  test("routes a project ask rule through canUseTool despite allowedTools", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "project-ask.txt");
    await writeProjectSettings(context, { ask: ["Bash"] });
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_project_ask",
          )
        : textReply("ask complete"),
    );
    let matchedAskRule: unknown;

    await runSdkQuery(context, server.url, "Run the command.", {
      allowedTools: ["Bash"],
      canUseTool: async (_name, _input, options) => {
        matchedAskRule = options.matchedAskRule;
        return { behavior: "deny", message: "host rejected ask" };
      },
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(matchedAskRule).toEqual(
      expect.objectContaining({ source: "projectSettings" }),
    );
  }, 30_000);

  test("acceptEdits writes a file without consulting canUseTool", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "accept-edits.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Write",
            { content: "accepted", file_path: outputPath },
            "toolu_sdkcompat_accept_edits",
          )
        : textReply("write complete"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Write the file.", {
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      permissionMode: "acceptEdits",
      tools: ["Write"],
    });

    expect(await readFile(outputPath, "utf8")).toBe("accepted");
    expect(callbackCount).toBe(0);
  }, 30_000);

  test("lets an explicit canUseTool allow override plan mode", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "plan-mode.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf blocked > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_plan",
          )
        : textReply("plan denial observed"),
    );
    let callbackCount = 0;

    await runSdkQuery(context, server.url, "Try to run the command.", {
      canUseTool: async (_name, input) => {
        callbackCount += 1;
        return { behavior: "allow", updatedInput: input };
      },
      permissionMode: "plan",
      tools: ["Bash"],
    });

    expect(await readFile(outputPath, "utf8")).toBe("blocked");
    expect(callbackCount).toBe(1);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
  }, 30_000);

  test("denies an emitted Bash call in plan mode without an approval surface", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "plan-mode-no-host.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_plan_no_host",
          )
        : textReply("plan denial observed"),
    );

    await runSdkQuery(context, server.url, "Try to run the command.", {
      permissionMode: "plan",
      permissionPrompts: "none",
      tools: ["Bash"],
    });

    expect(await exists(outputPath)).toBe(false);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
  }, 30_000);

  test("denies an unapproved Bash call in dontAsk mode without a callback", async () => {
    context = await createProbeContext();
    const outputPath = join(context.workspace, "dont-ask.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf denied > ${JSON.stringify(outputPath)}` },
            "toolu_sdkcompat_dontask",
          )
        : textReply("denial observed"),
    );
    let callbackCount = 0;

    const messages = await runSdkQuery(
      context,
      server.url,
      "Run the command.",
      {
        canUseTool: async (_name, input) => {
          callbackCount += 1;
          return { behavior: "allow", updatedInput: input };
        },
        permissionMode: "dontAsk",
        tools: ["Bash"],
      },
    );

    expect(await exists(outputPath)).toBe(false);
    expect(callbackCount).toBe(0);
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "tool_result",
    );
    expect(JSON.stringify(messages)).toContain("permission_denials");
  }, 30_000);
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function messageTypes(messages: SDKMessage[]): string[] {
  return messages.map((message) => message.type);
}

function sessionIdFrom(messages: SDKMessage[]): string {
  const message = messages.find(
    (candidate) =>
      candidate.type === "system" &&
      "subtype" in candidate &&
      candidate.subtype === "init" &&
      "session_id" in candidate,
  );
  if (message === undefined || !("session_id" in message)) {
    throw new Error("SDK init message did not include a session ID");
  }
  return String(message.session_id);
}

async function writeProjectSettings(
  probeContext: ProbeContext,
  permissions: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
  },
): Promise<void> {
  await writeFile(
    join(probeContext.workspace, ".claude", "settings.json"),
    JSON.stringify({ permissions }),
  );
}

function userMessage(
  content: string,
  uuid: `${string}-${string}-${string}-${string}-${string}`,
): SDKUserMessage {
  return {
    message: { content, role: "user" },
    origin: { kind: "human" },
    parent_tool_use_id: null,
    type: "user",
    uuid,
  };
}

async function* oneMessage(
  content: string,
  uuid: `${string}-${string}-${string}-${string}-${string}`,
): AsyncGenerator<SDKUserMessage> {
  yield userMessage(content, uuid);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
