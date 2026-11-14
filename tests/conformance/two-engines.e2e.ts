import { describe, expect, test } from "bun:test";
import { Api, e2eStack, poll } from "../e2e/client.ts";
import { docker, serviceContainer } from "./docker.ts";
import { type EngineFixture, modelCallSeen, scriptId } from "./engine.ts";
import { claudeEngine } from "./engines/claude.ts";
import { codexEngine } from "./engines/codex.ts";

/**
 * One stack running both engines (tests/e2e/run.sh --conformance two_engines,
 * infra/compose.two-engines.yml): a Claude session and a Codex session whose
 * turns are in flight together, each launched on its own engine's worker
 * image. Per session the verdict joins the container's Docker image id, the
 * image and engine its launch was reserved with and its claim was held to,
 * the engine its first checkpoint recorded, and its runtime kind. It shows
 * the routing; the WORKER_IMAGES list a Helm deployment uses is not on this
 * stack.
 */
const TIMEOUT = 600_000;
// Each fake answers a call only this long after it arrives, so once both
// calls have arrived and both sessions still run, both calls are pending at
// once. Long enough for one worker to start well after the other (seconds
// apart in a local run).
const HELD_MS = 180_000;

type Side = { engine: EngineFixture; name: string; image: string };

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is unset: run tests/e2e/run.sh --conformance two_engines`,
    );
  return value;
}

const installation = required("EXECUTION_INSTALLATION_ID");
const sides: Side[] = [
  {
    engine: claudeEngine(),
    name: "claude",
    image: required("WORKER_IMAGE_PREVIOUS"),
  },
  { engine: codexEngine(), name: "codex", image: required("WORKER_IMAGE") },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One row of the stack's database, its columns in order. */
async function row(query: string): Promise<string[]> {
  const out = await docker([
    "exec",
    await serviceContainer("postgres"),
    "psql",
    "-U",
    "postgres",
    "-d",
    "sessions",
    "-tAF",
    "|",
    "-c",
    query,
  ]);
  return (out.trim().split("\n")[0] ?? "").split("|");
}

async function imageId(image: string): Promise<string> {
  return (await docker(["image", "inspect", "--format", "{{.Id}}", image]))
    .trim()
    .split("\n")[0] as string;
}

describe("two engines on one stack", () => {
  test(
    "a Claude and a Codex session run at once, each on its own engine's image",
    async () => {
      // One after the other: the first one signs the stack's owner in.
      const runs = [];
      for (const side of sides) {
        const api = new Api(
          await e2eStack({
            needsMessages: false,
            connectionId: side.engine.connectionId,
          }),
        );
        runs.push({ ...side, api, id: scriptId(`two-engines-${side.name}`) });
      }
      const started = await Promise.all(
        runs.map(async (run) => {
          const created = await run.api.createSession(
            run.engine.prompt({
              id: run.id,
              commands: [],
              final: run.name,
              finalDelayMs: HELD_MS,
            }),
            undefined,
            run.engine.repositoryId,
          );
          expect(created.status).toBe(201);
          expect(created.body.session_id).toMatch(UUID);
          return { ...run, sessionId: created.body.session_id };
        }),
      );

      // Both model calls held at once: the two workers run side by side.
      await Promise.all(
        started.map((run) => modelCallSeen(run.engine, run.id, 0)),
      );
      for (const run of started) {
        expect([
          run.name,
          (await run.api.session(run.sessionId)).status,
        ]).toEqual([run.name, "running"]);
      }
      for (const run of started) {
        expect([
          run.name,
          (await run.api.settledTurn(run.sessionId, "1", HELD_MS + 120_000))
            .status,
        ]).toEqual([run.name, "completed"]);
      }

      for (const run of started) {
        const expected = await imageId(run.image);
        const containers = (
          await docker([
            "ps",
            "-q",
            "--filter",
            `label=werft.installation=${installation}`,
            "--filter",
            `label=werft.session-id=${run.sessionId}`,
          ])
        )
          .split("\n")
          .filter((line) => line.trim() !== "");
        expect([run.name, containers.length]).toEqual([run.name, 1]);
        const ran = (
          await docker([
            "inspect",
            "--format",
            "{{.Image}}",
            containers[0] as string,
          ])
        )
          .trim()
          .split("\n")[0];
        expect([run.name, ran]).toEqual([run.name, expected]);

        // The launch's pinned image and engine, which the claim was held to:
        // a worker of another engine is refused before it binds.
        expect([
          run.name,
          ...(await row(
            `SELECT count(*), min(image), min(runtime_engine), bool_and(claimed_attempt_id IS NOT NULL) FROM worker_launches WHERE session_id = '${run.sessionId}'`,
          )),
        ]).toEqual([run.name, "1", expected, run.name, "t"]);

        // What the worker ran, stamped on the session by its first checkpoint.
        const [kind, engine] = await poll(
          `${run.name} session's first checkpoint`,
          180_000,
          async () => {
            const found = await row(
              `SELECT runtime_spec -> 'runtime' ->> 'kind', runtime_engine FROM sessions WHERE id = '${run.sessionId}'`,
            );
            return found[1] ? found : null;
          },
        );
        expect([run.name, kind, engine]).toEqual([
          run.name,
          run.engine.runtimeKind,
          run.name,
        ]);
      }
    },
    TIMEOUT,
  );
});
