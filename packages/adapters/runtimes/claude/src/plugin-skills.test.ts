import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeRuntimeConfig } from "./config.ts";
import {
  expectedPluginSkills,
  type PluginSkills,
  PluginTreeError,
  skillSetDifference,
} from "./plugin-skills.ts";
import { ResumedHistory } from "./resumed-history.ts";
import { ClaudeSdkRun, InputStream } from "./run.ts";
import { buildSdkOptions, ClaudeSdkRuntime } from "./runtime.ts";
import { TurnLedger } from "./turn-ledger.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true });
});

function tree(
  name: string | null,
  skills: string[],
  frontmatter: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "plugin-tree-"));
  made.push(root);
  if (name !== null) {
    mkdirSync(join(root, ".claude-plugin"));
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name }),
    );
  }
  mkdirSync(join(root, "skills"));
  for (const skill of skills) {
    mkdirSync(join(root, "skills", skill));
    writeFileSync(
      join(root, "skills", skill, "SKILL.md"),
      frontmatter[skill] ?? "---\n---\n",
    );
  }
  return root;
}

const HIDDEN = "---\nuser-invocable: false\n---\n";

/** What the pinned engine lists beside a session's own skills. */
const BUILT_IN = [
  { name: "init" },
  { name: "compact" },
  { name: "dataviz" },
  { name: "code-review" },
];

type Engine = {
  initialization: object;
  reloaded?: object;
};

function fakeQuery(engine: Engine, reloads: { count: number } = { count: 0 }) {
  return {
    initializationResult: async () => engine.initialization,
    reloadSkills: async () => {
      reloads.count += 1;
      return engine.reloaded;
    },
  };
}

function run(
  engine: Engine,
  expected: PluginSkills | undefined,
  ledger = new TurnLedger(),
): ClaudeSdkRun {
  return new ClaudeSdkRun(
    "run",
    new InputStream(),
    fakeQuery(engine) as never,
    new AbortController(),
    ResumedHistory.empty(),
    ledger,
    undefined,
    undefined,
    expected,
  );
}

/** `fix`, a hidden `helper`, and `manual`, which only a person may call. */
const lint: PluginSkills = {
  all: ["lint:fix", "lint:helper", "lint:manual"],
  userInvocable: ["lint:fix", "lint:manual"],
  modelInvocable: ["lint:fix", "lint:helper"],
};

/** The engine of a session with the `lint` bundle above. */
function engineOf(
  commands: string[] = ["lint:fix", "lint:manual"],
  skills: string[] = ["lint:fix", "lint:helper"],
): Engine {
  return {
    initialization: {
      plugins_applied: true,
      commands: [...BUILT_IN, ...commands.map((name) => ({ name }))],
    },
    reloaded: {
      skills: [...BUILT_IN, ...skills.map((name) => ({ name }))],
    },
  };
}

describe("expectedPluginSkills", () => {
  test("names every skill of a published tree under the plugin's manifest name", () => {
    const path = tree("lint", ["fix", "check"]);
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual({
      all: ["lint:check", "lint:fix"],
      userInvocable: ["lint:check", "lint:fix"],
      modelInvocable: ["lint:check", "lint:fix"],
    });
  });

  test("keeps a user-invocable: false skill out of the user-invocable list only", () => {
    const path = tree("lint", ["check", "fix", "helper", "odd"], {
      helper: '---\ndescription: "h"\nuser-invocable: false\n---\nbody\n',
      fix: "---\nuser-invocable: true\n---\n",
      // Not the plain line the registered form has: counted as invocable.
      odd: "---\nuser-invocable: 'false'\n---\n",
    });
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual({
      all: ["lint:check", "lint:fix", "lint:helper", "lint:odd"],
      userInvocable: ["lint:check", "lint:fix", "lint:odd"],
      modelInvocable: ["lint:check", "lint:fix", "lint:helper", "lint:odd"],
    });
  });

  test("keeps a disable-model-invocation: true skill out of the model-invocable list only", () => {
    const path = tree("lint", ["check", "manual", "neither"], {
      manual: "---\ndisable-model-invocation: true\n---\n",
      neither:
        "---\ndisable-model-invocation: true\nuser-invocable: false\n---\n",
    });
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual({
      all: ["lint:check", "lint:manual", "lint:neither"],
      userInvocable: ["lint:check", "lint:manual"],
      modelInvocable: ["lint:check"],
    });
  });

  test("a user-invocable: false line outside the frontmatter does not hide a skill", () => {
    const path = tree("lint", ["check"], {
      check: "---\n---\nuser-invocable: false\n",
    });
    expect(
      expectedPluginSkills([{ path, type: "local" }]).userInvocable,
    ).toEqual(["lint:check"]);
  });

  test("a flag written inside a multi-line description does not hide a skill", () => {
    // The stored form of a block scalar description: one quoted line, its
    // breaks escaped, so no flag line can start inside it.
    const path = tree("lint", ["check"], {
      check:
        '---\nname: "check"\ndescription: "Checks.\\nuser-invocable: false\\ndisable-model-invocation: true"\n---\nBody.\n',
    });
    expect(expectedPluginSkills([{ path, type: "local" }])).toEqual({
      all: ["lint:check"],
      userInvocable: ["lint:check"],
      modelInvocable: ["lint:check"],
    });
  });

  test("refuses a tree that cannot be read as a plugin", () => {
    const noManifest = tree(null, ["a"]);
    expect(() =>
      expectedPluginSkills([{ path: noManifest, type: "local" }]),
    ).toThrow(PluginTreeError);
    expect(() =>
      expectedPluginSkills([{ path: "/nonexistent/ext", type: "local" }]),
    ).toThrow(PluginTreeError);
  });
});

describe("skillSetDifference", () => {
  test("leaves the engine's own names, which carry no namespace, out of the comparison", () => {
    expect(
      skillSetDifference(
        ["lint:fix"],
        ["init", "dataviz", "lint:fix", "mcp__docs__search"],
      ),
    ).toBeNull();
  });

  test("names what is missing and what was not attached", () => {
    expect(
      skillSetDifference(
        ["lint:check", "lint:fix"],
        ["init", "lint:fix", "other:fix", "lint:extra"],
      ),
    ).toEqual({ missing: ["lint:check"], extra: ["lint:extra", "other:fix"] });
  });
});

describe("the start check: a run handed plugins is ready only once the engine shows exactly its skills", () => {
  test("passes when both lists hold exactly the session's skills beside the built-in ones", async () => {
    await run(engineOf(), lint).ready();
  });

  test("fails when the engine says the plugins were not applied", async () => {
    for (const plugins_applied of [false, undefined]) {
      await expect(
        run(
          { initialization: { plugins_applied, commands: [] }, reloaded: {} },
          lint,
        ).ready(),
      ).rejects.toThrow("did not load the session's extension bundles");
    }
  });

  test("a missing user-invocable skill is refused before the hidden ones are read", async () => {
    const reloads = { count: 0 };
    const missing = new ClaudeSdkRun(
      "run",
      new InputStream(),
      fakeQuery(engineOf(["lint:manual"]), reloads) as never,
      new AbortController(),
      ResumedHistory.empty(),
      new TurnLedger(),
      undefined,
      undefined,
      lint,
    );
    await expect(missing.ready()).rejects.toThrow(
      "skill_set_mismatch: the engine's user-invocable commands differ from the session's skills (missing lint:fix)",
    );
    expect(reloads.count).toBe(0);
  });

  test("an extra namespaced command is refused", async () => {
    await expect(
      run(engineOf(["lint:fix", "lint:manual", "stray:fix"]), lint).ready(),
    ).rejects.toThrow("not attached stray:fix");
  });

  test("a hidden skill the engine has and the session did not attach is refused", async () => {
    await expect(
      run(
        engineOf(undefined, ["lint:fix", "lint:helper", "lint:secret"]),
        lint,
      ).ready(),
    ).rejects.toThrow(
      "skill_set_mismatch: the engine's model-invocable skills differ from the session's skills (not attached lint:secret)",
    );
  });

  test("a hidden skill the engine lost is refused", async () => {
    await expect(
      run(engineOf(undefined, ["lint:fix"]), lint).ready(),
    ).rejects.toThrow("(missing lint:helper)");
  });

  test("a hidden skill that shows up as a command is refused", async () => {
    await expect(
      run(engineOf(["lint:fix", "lint:helper", "lint:manual"]), lint).ready(),
    ).rejects.toThrow("not attached lint:helper");
  });

  test("a skill only a person may call that the model is offered is refused", async () => {
    await expect(
      run(
        engineOf(undefined, ["lint:fix", "lint:helper", "lint:manual"]),
        lint,
      ).ready(),
    ).rejects.toThrow("not attached lint:manual");
  });

  test("a skill neither a person nor the model may call fails the start, since no engine list would show it lost", async () => {
    const sealed: PluginSkills = {
      all: [...lint.all, "lint:sealed"],
      userInvocable: lint.userInvocable,
      modelInvocable: lint.modelInvocable,
    };
    await expect(run(engineOf(), sealed).ready()).rejects.toThrow(
      "skill_set_unconfirmable: lint:sealed",
    );
  });

  test("a reload reply without a skills list is a clear start failure", async () => {
    await expect(
      run({ ...engineOf(), reloaded: {} }, lint).ready(),
    ).rejects.toThrow("did not list its skills");
  });

  test("a run with no plugins is not held to any of it", async () => {
    const reloads = { count: 0 };
    const ledger = new TurnLedger();
    await new ClaudeSdkRun(
      "run",
      new InputStream(),
      fakeQuery({ initialization: { commands: [] } }, reloads) as never,
      new AbortController(),
      ResumedHistory.empty(),
      ledger,
    ).ready();
    expect(reloads.count).toBe(0);
    expect(await ledger.startConfirmed).toBe(true);
  });
});

describe("no tool runs in a session whose skills do not match", () => {
  const config: ClaudeRuntimeConfig = {
    claudeConfigDir: "/tenant/config",
    correlationId: "gate",
    mode: "new",
    cwd: "/tenant/workspace",
    home: "/tenant/home",
    model: "primary",
    permissionMode: "bypassPermissions",
    profile: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value: "placeholder" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: [],
    tools: ["Read", "Skill"],
  };

  function preToolUse(ledger: TurnLedger) {
    const options = buildSdkOptions(
      config,
      { onPermission: async () => ({ behavior: "allow" }) },
      ledger,
    );
    const callback = options.hooks?.PreToolUse?.[0]?.hooks[0];
    if (callback === undefined) throw new Error("PreToolUse hook is required");
    return (toolUseId: string) =>
      callback(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: {},
          tool_use_id: toolUseId,
        } as never,
        toolUseId,
        { signal: new AbortController().signal },
      );
  }

  test("a tool the engine asks for before the check ends waits, and is refused when a hidden skill does not match", async () => {
    const ledger = new TurnLedger();
    let initialize: (value: object) => void = () => {};
    const initialization = new Promise<object>((resolve) => {
      initialize = resolve;
    });
    const mismatched = new ClaudeSdkRun(
      "run",
      new InputStream(),
      {
        initializationResult: () => initialization,
        reloadSkills: async () => ({
          skills: [{ name: "lint:fix" }, { name: "lint:secret" }],
        }),
      } as never,
      new AbortController(),
      ResumedHistory.empty(),
      ledger,
      undefined,
      undefined,
      {
        all: ["lint:fix"],
        userInvocable: ["lint:fix"],
        modelInvocable: ["lint:fix"],
      },
    );
    let answered = false;
    const call = preToolUse(ledger)("toolu_1").then((answer) => {
      answered = true;
      return answer;
    });
    await Bun.sleep(5);
    expect(answered).toBe(false);
    initialize({ plugins_applied: true, commands: [{ name: "lint:fix" }] });
    expect(await call).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "The engine's skills did not match the session's, so no tool runs in it. This is not a user decision.",
      },
    });
    await expect(mismatched.ready()).rejects.toThrow("lint:secret");
  });

  test("a tool in a session whose skills match runs as before", async () => {
    const ledger = new TurnLedger();
    const matched = run(engineOf(), lint, ledger);
    await matched.ready();
    expect(await preToolUse(ledger)("toolu_1")).toEqual({});
  });
});

describe("ClaudeSdkRuntime.start hands the published tree's skills to the start check", () => {
  const policy = {
    endpoints: ["https://api.anthropic.com"],
    models: ["primary"],
  };
  const hooks = { onPermission: async () => ({ behavior: "allow" as const }) };

  function started(
    path: string,
    engine: Engine,
    launched: { options?: Record<string, unknown> } = {},
  ) {
    // A start writes the engine's settings file here.
    const state = mkdtempSync(join(tmpdir(), "engine-state-"));
    made.push(state);
    const config: ClaudeRuntimeConfig = {
      claudeConfigDir: state,
      correlationId: "start-skills",
      mode: "new",
      cwd: "/tenant/workspace",
      home: "/tenant/home",
      model: "primary",
      profile: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.com",
        auth: { kind: "api_key", value: "placeholder" },
        principal: { ownerScope: "owner-a" },
      },
      identities: { plugins: { [path]: "digest" } },
      plugins: [{ type: "local", path }],
      settingSources: [],
      tools: ["Read", "Skill"],
    };
    const fake = ((args: { options: Record<string, unknown> }) => {
      launched.options = args.options;
      return fakeQuery(engine);
    }) as never;
    return new ClaudeSdkRuntime(policy, undefined, fake).start(config, hooks);
  }

  test("a tree whose skills the engine shows starts, and the engine is told to offer only them", async () => {
    const path = tree("lint", ["fix", "helper"], { helper: HIDDEN });
    const launched: { options?: Record<string, unknown> } = {};
    await started(path, engineOf(["lint:fix"]), launched).ready();
    expect(launched.options?.skills).toEqual(["lint:fix", "lint:helper"]);
  });

  test("a tree whose hidden skill the engine does not show fails the start", async () => {
    const path = tree("lint", ["fix", "helper"], { helper: HIDDEN });
    await expect(
      started(path, engineOf(["lint:fix"], ["lint:fix"])).ready(),
    ).rejects.toThrow("missing lint:helper");
  });

  test("an unreadable tree fails the start before the engine exists", () => {
    expect(() => started("/nonexistent/ext", { initialization: {} })).toThrow(
      PluginTreeError,
    );
  });

  test("an init reply without a commands list is a clear start failure", async () => {
    const path = tree("lint", ["check"]);
    await expect(
      started(path, { initialization: { plugins_applied: true } }).ready(),
    ).rejects.toThrow("did not list its commands");
  });
});
