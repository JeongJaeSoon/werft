/**
 * What every engine adapter promises the platform, as checks an adapter's
 * own test registers before it goes into the installed runtimes. Nothing
 * here knows which engine it is: what only the adapter can read comes in
 * through the harness.
 */
import { deepStrictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PERMISSION_MODE_VALUES,
  type PermissionMode,
} from "@werft-ai/contracts";
import { type GitEnvironment, gitEnvironment } from "../git-environment.ts";

export type AdapterConformanceHarness = {
  /**
   * The text the engine is set up to add on its own to a commit message and
   * to a pull request description, in a run started with `permissionMode`.
   * `undefined` means the adapter left the engine's default in place.
   */
  engineSignature(
    permissionMode: PermissionMode,
  ):
    | { commit: string | undefined; pr: string | undefined }
    | Promise<{ commit: string | undefined; pr: string | undefined }>;
  /**
   * How a run started with `gitEnvironment` launches the engine: the
   * environment its process gets, and everything else the adapter passes
   * (arguments, options) as one value the check searches.
   */
  engineLaunch(gitEnvironment: GitEnvironment): {
    environment: Readonly<Record<string, string | undefined>>;
    rest: unknown;
  };
  /**
   * Starts a run whose `platform` MCP server marks `trusted` tools, has the
   * model call `tool`, and says who judged the call:
   *   skipped  the engine ran it with no judgment of its own (no person, no
   *            classifier)
   *   engine   the engine's permission stage judged it, as for any tool
   *   refused  the adapter refused it before running
   * `admission: "fails"` is a host whose checkpoint admission guard throws.
   *
   * An engine whose descriptor declares no MCP leaves this out and supplies
   * `mcpBundle` instead: a harness that returned fixed answers here would
   * pass without the engine having anything to judge.
   */
  toolJudgment?(call: {
    allowlist: readonly string[];
    trusted: readonly string[];
    tool: string;
    permissionMode: PermissionMode;
    admission: "ok" | "fails";
  }): Promise<"skipped" | "engine" | "refused">;
  /**
   * For an engine without MCP: starts a run whose bundle names an MCP server
   * and says whether the adapter `refused` it before the engine ran or let
   * the run `started` (the server's tools would then run unjudged).
   */
  mcpBundle?(): Promise<"refused" | "started">;
};

export type AdapterConformanceItem = {
  name: string;
  /** Throws when the adapter breaks the promise. */
  check(harness: AdapterConformanceHarness): void | Promise<void>;
};

export const ADAPTER_CONFORMANCE: readonly AdapterConformanceItem[] = [
  {
    name: "1. the engine adds no signature of its own to commits or pull requests",
    async check(harness) {
      for (const permissionMode of PERMISSION_MODE_VALUES) {
        deepStrictEqual(
          {
            permissionMode,
            ...(await harness.engineSignature(permissionMode)),
          },
          { permissionMode, commit: "", pr: "" },
        );
      }
    },
  },
  {
    name: "2. gitEnvironment reaches the engine's git at command line level and on no command line",
    check(harness) {
      const root = mkdtempSync(join(tmpdir(), "conformance-git-"));
      try {
        const hooks = join(root, "platform-hooks");
        const name = "Conformance[bot]";
        const launch = harness.engineLaunch(
          gitEnvironment([
            { key: "core.hooksPath", value: hooks },
            { key: "user.name", value: name },
          ]) as GitEnvironment,
        );
        const git = (...args: string[]) => {
          const run = spawnSync("git", args, {
            cwd: root,
            encoding: "utf8",
            env: {
              ...launch.environment,
              PATH: launch.environment.PATH ?? process.env.PATH,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: join(root, "no-global"),
            },
          });
          if (run.status !== 0)
            throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
          return run.stdout.trimEnd();
        };
        git("init", "-q");
        // What husky writes; the engine's setting has to outrank it.
        git("config", "core.hooksPath", ".husky");
        git("config", "user.name", "Local");
        deepStrictEqual(
          [
            git("config", "--show-origin", "--get", "core.hooksPath"),
            git("config", "--show-origin", "--get", "user.name"),
          ],
          [`command line:\t${hooks}`, `command line:\t${name}`],
        );
        const rest = JSON.stringify(launch.rest) ?? "";
        deepStrictEqual(
          {
            hooksPathElsewhere: rest.includes(hooks),
            nameElsewhere: rest.includes(name),
          },
          { hooksPathElsewhere: false, nameElsewhere: false },
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: "3. a trusted tool of a platform server runs with no judgment of the engine's, after the allowlist and the admission guard; every other tool goes through the permission stage (an engine without MCP refuses the bundle before it starts)",
    async check(harness) {
      const { toolJudgment } = harness;
      if (toolJudgment === undefined) {
        if (harness.mcpBundle === undefined) {
          throw new Error(
            "A harness without toolJudgment has to show how its engine refuses an MCP bundle (mcpBundle)",
          );
        }
        deepStrictEqual(await harness.mcpBundle(), "refused");
        return;
      }
      const trusted = "mcp__github__request_push";
      const other = "mcp__github__submit_review";
      const allowlist = ["Bash", trusted, other];
      const judged = async (
        tool: string,
        over: Partial<
          Parameters<NonNullable<AdapterConformanceHarness["toolJudgment"]>>[0]
        >,
      ) =>
        toolJudgment.call(harness, {
          allowlist,
          trusted: [trusted],
          tool,
          permissionMode: "default",
          admission: "ok",
          ...over,
        });
      // `plan` promises no side effects, so it is not in this list.
      for (const permissionMode of PERMISSION_MODE_VALUES.filter(
        (mode) => mode !== "plan",
      )) {
        deepStrictEqual(
          {
            permissionMode,
            trusted: await judged(trusted, { permissionMode }),
            other: await judged(other, { permissionMode }),
            builtin: await judged("Bash", { permissionMode }),
          },
          {
            permissionMode,
            trusted: "skipped",
            other: "engine",
            builtin: "engine",
          },
        );
      }
      deepStrictEqual(
        {
          outsideAllowlist: await judged(trusted, {
            allowlist: ["Bash", other],
          }),
          guardFails: await judged(trusted, { admission: "fails" }),
          nothingTrusted: await judged(trusted, { trusted: [] }),
        },
        {
          outsideAllowlist: "refused",
          guardFails: "refused",
          nothingTrusted: "engine",
        },
      );
    },
  },
];
