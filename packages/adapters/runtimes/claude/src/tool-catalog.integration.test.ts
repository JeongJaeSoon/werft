import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CanUseTool,
  type HookCallback,
  type Options,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { pinnedClaudeToolCatalog } from "@werft-ai/runtime-claude-codec";
import {
  type FakeAnthropicServer,
  type RecordedRequest,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { ClaudeRuntimeConfig, PermissionMode } from "./config.ts";
import { InputStream } from "./run.ts";
import { buildSdkOptions } from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

/**
 * The engine harness behind the built-in tool catalog. Every tool the pinned
 * build's catalog lists is driven through the real SDK and its bundled engine,
 * on the main loop and inside a subagent, and has to
 *   1. pass the PreToolUse gate — and the permission callback, where the
 *      engine consults it — and do what it is for, when the profile allows it;
 *   2. not run when the profile leaves it out: the SDK's tool set refuses it,
 *      and with the engine offering it anyway, the platform's own gates do;
 *   3. not run while a checkpoint lease is held.
 * A tool goes into the catalog only once all of this passes for it.
 */

const catalog = pinnedClaudeToolCatalog();
const catalogTools = (catalog?.tools ?? []).map((tool) => tool.name);
const SUBAGENT_MARKER = "HARNESS_SUBAGENT";
const MAIN_MARKER = "HARNESS_MAIN";
const AGENT_CALL = "toolu_main_spawn_Agent";
const OUTSIDE_ALLOWLIST = "Tool is outside the server allowlist";

/**
 * Tools this build runs without asking in the default mode. In an attended
 * mode nothing but the SDK's tool set keeps them out of a profile that does
 * not list them; the gates scenario pins that down so a change shows here.
 */
const RUNS_UNASKED = new Set([
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  // The probe redirects into the workspace, which the Edit rule covers.
  "Bash",
]);
/** Tools this build does not hand to a subagent at all. */
const MAIN_LOOP_ONLY = new Set(["AskUserQuestion"]);

type Path = "main" | "subagent";
type Scenario = "allowed" | "outside_allowlist" | "gates_only" | "under_lease";
type RunOptions = {
  path: Path;
  permissionMode: PermissionMode;
  /** Read stays allowed, for the calls the engine refuses on an unread file. */
  readAllowed?: true;
  scenario: Scenario;
};

type HookSeen = { agentId?: string; decision: string; tool: string };

type Observed = {
  canUseTool: Map<string, HookSeen>;
  /** Connections the WebFetch target accepted. */
  fetched: number;
  offered: Map<Path, string[]>;
  post: Map<string, HookSeen>;
  pre: Map<string, HookSeen>;
  requests: RecordedRequest[];
  results: Map<string, { isError: boolean; text: string }>;
};

type Step = {
  /** Whether the call did what the tool is for; refused calls must leave it false. */
  effect: (observed: Observed) => Promise<boolean>;
  id: string;
  input: Record<string, unknown>;
  name: string;
  /** The engine refuses it on a file the conversation has not read, before any gate. */
  needsRead?: true;
};

function stepsFor(
  path: Path,
  workspace: string,
  fetchUrl: string,
): {
  probes: Step[];
  setup: Step[];
} {
  const seed = join(workspace, "seed.txt");
  const other = join(workspace, "other.txt");
  const notebook = join(workspace, "notebook.ipynb");
  const resultHas = (id: string, text: string) => async (o: Observed) => {
    const result = o.results.get(id);
    return (
      result !== undefined && !result.isError && result.text.includes(text)
    );
  };
  const fileHas = (file: string, text: string) => async () =>
    (await readFile(file, "utf8").catch(() => "")).includes(text);
  const id = (name: string) => `toolu_${path}_probe_${name}`;
  const probes: Record<string, Step> = {
    Read: {
      name: "Read",
      id: id("Read"),
      input: { file_path: other },
      effect: resultHas(id("Read"), "probe content"),
    },
    Edit: {
      name: "Edit",
      id: id("Edit"),
      needsRead: true,
      input: {
        file_path: seed,
        old_string: "seed line",
        new_string: "edited line",
      },
      effect: fileHas(seed, "edited line"),
    },
    Write: {
      name: "Write",
      id: id("Write"),
      input: { file_path: join(workspace, "written.txt"), content: "written" },
      effect: fileHas(join(workspace, "written.txt"), "written"),
    },
    Glob: {
      name: "Glob",
      id: id("Glob"),
      input: { pattern: "*.txt", path: workspace },
      effect: resultHas(id("Glob"), "other.txt"),
    },
    Grep: {
      name: "Grep",
      id: id("Grep"),
      input: { pattern: "grep-target", path: workspace },
      effect: resultHas(id("Grep"), "other.txt"),
    },
    NotebookEdit: {
      name: "NotebookEdit",
      id: id("NotebookEdit"),
      needsRead: true,
      input: {
        notebook_path: notebook,
        cell_id: "cell-1",
        new_source: "print('edited')",
      },
      effect: fileHas(notebook, "edited"),
    },
    Bash: {
      name: "Bash",
      id: id("Bash"),
      input: {
        command: `printf ran > ${JSON.stringify(join(workspace, "bash.txt"))}`,
      },
      effect: fileHas(join(workspace, "bash.txt"), "ran"),
    },
    AskUserQuestion: {
      name: "AskUserQuestion",
      id: id("AskUserQuestion"),
      input: {
        questions: [
          {
            question: "Which one?",
            header: "Pick",
            multiSelect: false,
            options: [
              { label: "First", description: "the first" },
              { label: "Second", description: "the second" },
            ],
          },
        ],
      },
      // Allowed without answers, the engine reports the question unanswered.
      effect: resultHas(id("AskUserQuestion"), "did not answer"),
    },
    WebFetch: {
      name: "WebFetch",
      id: id("WebFetch"),
      input: { url: fetchUrl, prompt: "Summarize the page" },
      // The engine upgrades to TLS and the target speaks none, so the call
      // fails; that the worker's own process dialled out is what it shows.
      effect: async (o) => o.fetched > 0,
    },
    WebSearch: {
      name: "WebSearch",
      id: id("WebSearch"),
      input: { query: "harness search" },
      // Run by the provider: the engine asks the Messages API to search.
      effect: async (o) =>
        o.requests.some((request) =>
          (request.body.tools ?? []).some((tool) =>
            String((tool as { type?: unknown }).type ?? "").startsWith(
              "web_search",
            ),
          ),
        ),
    },
  };
  // The engine refuses an edit to a file the conversation has not read.
  const setup: Step[] = [
    {
      name: "Read",
      id: `toolu_${path}_setup_seed`,
      input: { file_path: seed },
      effect: async () => true,
    },
    {
      name: "Read",
      id: `toolu_${path}_setup_notebook`,
      input: { file_path: notebook },
      effect: async () => true,
    },
  ];
  return {
    setup,
    probes: catalogTools.map((name) => {
      const probe = probes[name];
      if (probe === undefined) {
        throw new Error(`The harness has no call for catalog tool ${name}`);
      }
      return probe;
    }),
  };
}

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;
let fetchTarget: Bun.TCPSocketListener<undefined> | undefined;
const report: string[] = [];

afterEach(() => cleanUp());

async function cleanUp(): Promise<void> {
  server?.stop();
  fetchTarget?.stop(true);
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
  fetchTarget = undefined;
}

afterAll(() => {
  console.log(
    [
      `engine harness, catalog ${catalog?.id}`,
      "path     scenario          mode              tool            offered pre   canUseTool ran effect result",
      ...report,
    ].join("\n"),
  );
});

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join(" ");
  if (content !== null && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

/** Which scripted conversation a request belongs to, and how many calls it made so far. */
function conversationOf(request: RecordedRequest): {
  calls: number;
  marker: string | undefined;
} {
  const messages = (request.body.messages ?? []) as Array<{
    content?: unknown;
    role?: string;
  }>;
  const first = JSON.stringify(messages[0]?.content ?? "");
  const marker = [SUBAGENT_MARKER, MAIN_MARKER].find((m) => first.includes(m));
  const calls = messages.filter(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (block) => (block as { type?: string }).type === "tool_use",
      ),
  ).length;
  return { calls, marker };
}

function toolNames(request: RecordedRequest): string[] {
  return (request.body.tools ?? []).map(
    (tool) => (tool as { name?: string }).name ?? "",
  );
}

async function runScenario(options: RunOptions): Promise<{
  observed: Observed;
  probes: Step[];
  quiescent: string;
}> {
  await cleanUp();
  isolated = await createIsolatedWorkspace({ prefix: "94s-1316-" });
  const { home, workspace } = isolated;
  await writeFile(join(workspace, "seed.txt"), "seed line\n");
  await writeFile(join(workspace, "other.txt"), "probe content grep-target\n");
  await writeFile(
    join(workspace, "notebook.ipynb"),
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          id: "cell-1",
          metadata: {},
          source: ["print('seed')"],
          outputs: [],
          execution_count: null,
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );

  const observed: Observed = {
    canUseTool: new Map(),
    fetched: 0,
    offered: new Map(),
    post: new Map(),
    pre: new Map(),
    requests: [],
    results: new Map(),
  };
  const target = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        observed.fetched += 1;
        socket.end();
      },
      data() {},
    },
  });
  fetchTarget = target;
  const ledger = new TurnLedger(
    options.scenario === "under_lease" ? "seeded" : undefined,
  );
  let lease = null as { release(): void } | null;
  let script: Step[] = [];
  let probeIds = new Set<string>();

  server = startFakeAnthropicServer((request) => {
    for (const message of (request.body.messages ?? []) as Array<{
      content?: unknown;
    }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== "tool_result") continue;
        observed.results.set(String(block.tool_use_id), {
          isError: block.is_error === true,
          text: textOf(block.content),
        });
      }
    }
    const { calls, marker } = conversationOf(request);
    if (options.path === "subagent" && marker === MAIN_MARKER) {
      observed.offered.set("main", toolNames(request));
      return calls === 0
        ? toolReply(
            "Agent",
            {
              description: "harness subagent",
              prompt: `${SUBAGENT_MARKER}: run the scripted calls`,
              subagent_type: "general-purpose",
              // This build backgrounds a subagent unless told not to, and the
              // turn would end before it ran anything.
              run_in_background: false,
            },
            AGENT_CALL,
          )
        : textReply("subagent finished");
    }
    const scripted =
      (options.path === "main" && marker === MAIN_MARKER) ||
      (options.path === "subagent" && marker === SUBAGENT_MARKER);
    if (!scripted) return textReply("auxiliary reply");
    observed.offered.set(options.path, toolNames(request));
    const next = script[calls];
    if (options.scenario === "under_lease") {
      lease?.release();
      lease = null;
      if (next !== undefined && probeIds.has(next.id)) {
        // The Agent call stays in flight while its subagent runs, and the
        // ledger rightly refuses a lease then. Settling it here is the
        // harness's doing: what is under test is that a held lease refuses a
        // subagent's call, not when one may be taken.
        if (options.path === "subagent") ledger.toolSettled(AGENT_CALL);
        const grant = ledger.leaseCheckpoint();
        if (grant.lease === null) {
          throw new Error(
            `No lease before ${next.id}: ${JSON.stringify(grant.preparation)}`,
          );
        }
        lease = grant.lease;
      }
    }
    return next === undefined
      ? textReply("scripted calls done")
      : toolReply(next.name, next.input, next.id);
  });
  observed.requests = server.requests;
  const { setup, probes } = stepsFor(
    options.path,
    workspace,
    `http://127.0.0.1:${target.port}/harness-page`,
  );
  script = [...setup, ...probes];
  probeIds = new Set(probes.map((step) => step.id));

  const spawn = [
    ...(options.path === "subagent" ? ["Agent"] : []),
    ...(options.readAllowed ? ["Read"] : []),
  ];
  const allowlist =
    options.scenario === "outside_allowlist" ||
    options.scenario === "gates_only"
      ? spawn
      : [...catalogTools, ...spawn];
  const config: ClaudeRuntimeConfig = {
    claudeConfigDir: home,
    correlationId: "tool-catalog-harness",
    mode: "new",
    cwd: workspace,
    home,
    maxTurns: 30,
    model: "claude-sonnet-4-5",
    permissionMode: options.permissionMode,
    profile: {
      kind: "anthropic",
      endpoint: server.url,
      auth: { kind: "api_key", value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: ["project"],
    tools: allowlist,
  };
  const abortController = new AbortController();
  const sdkOptions: Options = buildSdkOptions(
    config,
    { onPermission: async () => ({ behavior: "allow" }) },
    ledger,
    abortController,
  );
  // The engine offers every catalog tool while the platform's allowlist holds
  // none of them: only the platform's own gates stand in the way.
  if (options.scenario === "gates_only") {
    sdkOptions.tools = [...catalogTools, ...spawn];
  }
  observe(sdkOptions, observed);

  const input = new InputStream();
  const consume = (async () => {
    for await (const message of query({ prompt: input, options: sdkOptions })) {
      if (options.scenario !== "under_lease") ledger.observe(message as never);
      if (message.type === "result") input.finish();
    }
  })();
  input.push({
    message: `${MAIN_MARKER}: run the scripted calls`,
    uuid: crypto.randomUUID(),
  });
  // A run that hangs is aborted and awaited, so the engine is gone before
  // the server and workspace it uses are torn down.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, 50_000);
  await consume
    .catch((error: unknown) => {
      if (!timedOut) throw error;
    })
    .finally(() => clearTimeout(timer));
  if (timedOut) throw new Error("The harness run did not settle in 50s");
  lease?.release();
  const preparation = ledger.prepareCheckpoint();
  return {
    observed,
    probes,
    quiescent:
      preparation.status === "ready"
        ? "ready"
        : `${preparation.reason}: ${preparation.detail}`,
  };
}

/** Wraps the production gates so every call they judge is recorded; decisions untouched. */
function observe(options: Options, observed: Observed): void {
  const gate = options.canUseTool as CanUseTool;
  options.canUseTool = async (tool, input, callOptions) => {
    const decision = await gate(tool, input, callOptions);
    observed.canUseTool.set(callOptions.toolUseID, {
      tool,
      decision:
        decision === null
          ? "none"
          : "message" in decision
            ? `${decision.behavior}: ${decision.message}`
            : decision.behavior,
      ...(callOptions.agentID === undefined
        ? {}
        : { agentId: callOptions.agentID }),
    });
    return decision;
  };
  const wrap = (
    event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure",
    into: Map<string, HookSeen>,
  ) => {
    for (const matcher of options.hooks?.[event] ?? []) {
      matcher.hooks = matcher.hooks.map(
        (hook): HookCallback =>
          async (input, toolUseId, hookOptions) => {
            const output = await hook(input, toolUseId, hookOptions);
            if ("tool_use_id" in input && "tool_name" in input) {
              const specific = (
                output as {
                  hookSpecificOutput?: {
                    permissionDecision?: string;
                    permissionDecisionReason?: string;
                  };
                }
              ).hookSpecificOutput;
              into.set(input.tool_use_id, {
                tool: input.tool_name,
                decision:
                  specific?.permissionDecision === undefined
                    ? "pass"
                    : `${specific.permissionDecision}: ${specific.permissionDecisionReason}`,
                ...(input.agent_id === undefined
                  ? {}
                  : { agentId: input.agent_id }),
              });
            }
            return output;
          },
      );
    }
  };
  wrap("PreToolUse", observed.pre);
  wrap("PostToolUse", observed.post);
  wrap("PostToolUseFailure", observed.post);
}

type Judged = {
  asked: HookSeen | undefined;
  effect: boolean;
  offered: boolean;
  pre: HookSeen | undefined;
  result: { isError: boolean; text: string } | undefined;
  ran: boolean;
  step: string;
};

async function judge(
  options: RunOptions,
  step: Step,
  observed: Observed,
): Promise<Judged> {
  const judged: Judged = {
    asked: observed.canUseTool.get(step.id),
    effect: await step.effect(observed),
    offered: (observed.offered.get(options.path) ?? []).includes(step.name),
    pre: observed.pre.get(step.id),
    ran: observed.post.has(step.id),
    result: observed.results.get(step.id),
    step: step.id,
  };
  const short = (seen: HookSeen | undefined) =>
    seen === undefined ? "-" : (seen.decision.split(":")[0] ?? "-");
  report.push(
    [
      options.path.padEnd(8),
      options.scenario.padEnd(17),
      options.permissionMode.padEnd(17),
      step.name.padEnd(15),
      (judged.offered ? "yes" : "no").padEnd(7),
      short(judged.pre).padEnd(5),
      short(judged.asked).padEnd(10),
      (judged.ran ? "yes" : "no").padEnd(3),
      (judged.effect ? "yes" : "no").padEnd(6),
      judged.result === undefined
        ? "-"
        : `${judged.result.isError ? "error" : "ok"}: ${judged.result.text.slice(0, 70).replaceAll(/\s+/g, " ")}`,
    ].join(" "),
  );
  return judged;
}

/** The fields a refused call must show, in one object so a failure names its step. */
function refused(judged: Judged) {
  return {
    step: judged.step,
    ran: judged.ran,
    effect: judged.effect,
    isError: judged.result?.isError,
  };
}

describe(`engine harness for catalog ${catalog?.id}`, () => {
  test("has a call for every tool of the pinned build's catalog", () => {
    expect(catalog).toBeDefined();
    const { probes } = stepsFor("main", "/w", "http://127.0.0.1:1/");
    expect(probes.map((step) => step.name)).toEqual(catalogTools);
  });

  for (const path of ["main", "subagent"] as const) {
    const agentId = path === "subagent" ? { agentId: expect.any(String) } : {};

    test(`${path}: an allowed catalog tool passes its gates and does its work`, async () => {
      const options: RunOptions = {
        path,
        permissionMode: "default",
        scenario: "allowed",
      };
      const { observed, probes, quiescent } = await runScenario(options);
      for (const step of probes) {
        const judged = await judge(options, step, observed);
        if (path === "subagent" && MAIN_LOOP_ONLY.has(step.name)) {
          expect(refused(judged)).toEqual({
            step: step.id,
            ran: false,
            effect: false,
            isError: true,
          });
          expect(judged.result?.text).toContain("No such tool available");
          continue;
        }
        expect({
          step: step.id,
          offered: judged.offered,
          pre: judged.pre,
        }).toEqual({
          step: step.id,
          offered: true,
          pre: { tool: step.name, decision: "pass", ...agentId },
        });
        expect({
          step: step.id,
          ran: judged.ran,
          effect: judged.effect,
        }).toEqual({
          step: step.id,
          ran: true,
          effect: true,
        });
        expect({ step: step.id, asked: judged.asked }).toEqual({
          step: step.id,
          asked: RUNS_UNASKED.has(step.name)
            ? undefined
            : { tool: step.name, decision: "allow", ...agentId },
        });
      }
      expect(quiescent).toBe("ready");
    }, 120_000);

    for (const permissionMode of ["default", "bypassPermissions"] as const) {
      test(`${path}: a catalog tool the profile leaves out is not offered and never runs (${permissionMode})`, async () => {
        const options: RunOptions = {
          path,
          permissionMode,
          scenario: "outside_allowlist",
        };
        const { observed, probes } = await runScenario(options);
        if (path === "subagent")
          expect(observed.post.has(AGENT_CALL)).toBe(true);
        for (const step of probes) {
          const judged = await judge(options, step, observed);
          expect(refused(judged)).toEqual({
            step: step.id,
            ran: false,
            effect: false,
            isError: true,
          });
          expect({
            step: step.id,
            offered: judged.offered,
            pre: judged.pre,
          }).toEqual({
            step: step.id,
            offered: false,
            pre: undefined,
          });
          expect(judged.result?.text).toContain("No such tool available");
        }
      }, 120_000);

      // A run with Read left out judges the calls that need no read; a run
      // with Read in judges the rest, which the engine would otherwise refuse
      // on an unread file before any gate saw them.
      for (const readAllowed of [false, true]) {
        test(`${path}: with the engine offering a catalog tool the profile leaves out, the platform gates refuse it (${permissionMode}, ${readAllowed ? "calls that need a read" : "calls that need none"})`, async () => {
          const options: RunOptions = {
            path,
            permissionMode,
            scenario: "gates_only",
            ...(readAllowed ? { readAllowed: true as const } : {}),
          };
          const { observed, probes } = await runScenario(options);
          if (path === "subagent")
            expect(observed.post.has(AGENT_CALL)).toBe(true);
          for (const step of probes.filter(
            (probe) => (probe.needsRead === true) === readAllowed,
          )) {
            const judged = await judge(options, step, observed);
            if (path === "subagent" && MAIN_LOOP_ONLY.has(step.name)) {
              expect(judged.offered).toBe(false);
              expect(refused(judged).ran).toBe(false);
              continue;
            }
            expect(judged.offered).toBe(true);
            // PreToolUse binds in every mode, so canUseTool (and any session
            // rule that would skip it) is never what keeps the tool out.
            expect({
              step: step.id,
              pre: judged.pre,
              asked: judged.asked,
            }).toEqual({
              step: step.id,
              pre: {
                tool: step.name,
                decision: `deny: ${OUTSIDE_ALLOWLIST}`,
                ...agentId,
              },
              asked: undefined,
            });
            expect(refused(judged)).toEqual({
              step: step.id,
              ran: false,
              effect: false,
              isError: true,
            });
          }
        }, 120_000);
      }
    }

    test(`${path}: a catalog tool asked to start under a checkpoint lease never runs`, async () => {
      const options: RunOptions = {
        path,
        permissionMode: "default",
        scenario: "under_lease",
      };
      const { observed, probes } = await runScenario(options);
      for (const step of probes) {
        const judged = await judge(options, step, observed);
        expect(refused(judged)).toEqual({
          step: step.id,
          ran: false,
          effect: false,
          isError: true,
        });
        expect(judged.asked).toBeUndefined();
        if (path === "subagent" && MAIN_LOOP_ONLY.has(step.name)) continue;
        expect({ step: step.id, pre: judged.pre?.decision }).toEqual({
          step: step.id,
          pre: expect.stringContaining("deny: A checkpoint is being saved"),
        });
        if (path === "subagent") expect(judged.pre?.agentId).toBeString();
      }
    }, 120_000);
  }
});
