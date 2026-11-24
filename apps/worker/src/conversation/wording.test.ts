import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONVERSATION_RUNTIME_ROUTE_PREFIX,
  CONVERSATION_RUNTIME_ROUTES,
} from "@werft-ai/contracts";

const root = join(import.meta.dir, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// Everything this runtime adds that an operator reads or types: its code and
// logs, its command, its deployment and their settings.
const SOURCES = [
  ...readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `apps/worker/src/conversation/${name}`),
  "apps/control-host/src/api/conversation-runtime.ts",
  "apps/control-host/src/api/conversation-turn.ts",
  "apps/control-host/src/api/routes/workers/conversation-runtime.ts",
  "packages/contracts/src/worker-protocol/conversation-runtime.ts",
  "packages/platform/src/conversations/conversation-turns.ts",
  "packages/platform/src/ports/conversation-turn-queue.ts",
  "infra/compose.conversation-runtime.yml",
  "deploy/helm/werft/templates/conversation-runtime.yaml",
];

// The engine is the bundled one, run as it ships; the product is not named
// after it.
test("nothing of the conversation runtime names the product after the bundled engine", () => {
  expect(SOURCES.length).toBeGreaterThan(10);
  for (const path of SOURCES) {
    expect({ path, named: /claude[\s_-]*code/i.test(read(path)) }).toEqual({
      path,
      named: false,
    });
  }
});

test("its routes, settings, log events and deployment names carry no engine name", () => {
  const settings = [
    ...read("apps/worker/src/conversation/config.ts").matchAll(
      /^ {2}([A-Z][A-Z0-9_]+)\?:/gm,
    ),
    ...read("apps/control-host/src/api/conversation-runtime.ts").matchAll(
      /env\.([A-Z][A-Z0-9_]+)/g,
    ),
  ].map((match) => match[1]);
  const events = [
    ...read("apps/worker/src/conversation/conversation-host.ts").matchAll(
      /"(conversation_[a-z_.]+)"/g,
    ),
  ].map((match) => match[1]);
  expect(settings.length).toBeGreaterThan(8);
  expect(events.length).toBeGreaterThan(8);
  const names = [
    CONVERSATION_RUNTIME_ROUTE_PREFIX,
    ...Object.keys(CONVERSATION_RUNTIME_ROUTES),
    ...settings,
    ...events,
    ...[
      ...read("deploy/helm/werft/templates/conversation-runtime.yaml").matchAll(
        /"component" "([a-z-]+)"/g,
      ),
    ].map((match) => match[1]),
  ];
  expect(names.filter((name) => /claude|anthropic/i.test(name ?? ""))).toEqual(
    [],
  );
});
