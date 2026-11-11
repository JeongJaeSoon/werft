import { randomUUID } from "node:crypto";
import type { SpecSource } from "@werft-ai/contracts";
import {
  type CatalogConnection,
  type CatalogProvider,
  type ClaimCatalog,
  type ReleaseSpecRecord,
  releaseSpecRecord,
  type SessionCatalog,
  type ToolCatalogs,
} from "@werft-ai/platform";
import type { Database } from "../queries.ts";
import { agentReleases, agents, agentVersions, workspaces } from "../schema.ts";
import { fixtureTeam } from "./fixture-team.ts";

/** The connection the tests' sessions and releases run on. */
export const TEST_CONNECTION_ID = "test-connection";
export const TEST_MODEL = "claude-sonnet-5";
export const TEST_RUNTIME_VERSION = "0.3.319";
/** The runtimes the tests' agent services install: the claude engine only. */
export const TEST_RUNTIMES = {
  claude_agent_sdk: TEST_RUNTIME_VERSION,
} as const;

/** A spec source as a release on the test connection makes one. */
export function testSpecSource(
  overrides: Partial<SpecSource> = {},
): SpecSource {
  return {
    derivation_version: 2,
    runtime: { kind: "claude_agent_sdk", version: TEST_RUNTIME_VERSION },
    connection: {
      id: TEST_CONNECTION_ID,
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      billing: "per_token",
    },
    model: TEST_MODEL,
    permission_mode: "default",
    tools: ["Read", "Edit", "Bash"],
    repository_mode: "optional",
    ...overrides,
  };
}

/** The four spec columns of a release row, from a test source. */
export function releaseSpecColumns(overrides: Partial<SpecSource> = {}): {
  runtimeSpec: ReleaseSpecRecord["runtime_spec"];
  specSource: ReleaseSpecRecord["spec_source"];
  specSourceDigest: string;
  specDigest: string;
} {
  const record = releaseSpecRecord(testSpecSource(overrides));
  return {
    runtimeSpec: record.runtime_spec,
    specSource: record.spec_source,
    specSourceDigest: record.spec_source_digest,
    specDigest: record.spec_digest,
  };
}

/** A session row's spec pin and model, as a session of a test release holds them. */
export function sessionPinColumns(
  model = TEST_MODEL,
  overrides: Partial<SpecSource> = {},
) {
  return { model, ...releaseSpecColumns({ ...overrides, model }) };
}

/** The same as snake_case SQL values, for a raw INSERT. */
export function sessionPinValues(
  model = TEST_MODEL,
  overrides: Partial<SpecSource> = {},
) {
  const pin = sessionPinColumns(model, overrides);
  return {
    model: pin.model,
    runtime_spec: JSON.stringify(pin.runtimeSpec),
    spec_source: JSON.stringify(pin.specSource),
    spec_source_digest: pin.specSourceDigest,
    spec_digest: pin.specDigest,
  };
}

/** A claim catalog that runs the test connection and the given repositories. */
export function testClaimCatalog(
  repositories: ClaimCatalog["repositories"] = [],
  models: readonly string[] = [TEST_MODEL],
): ClaimCatalog {
  return {
    connections: [{ id: TEST_CONNECTION_ID, models }],
    repositories,
    runtimeVersions: null,
  };
}

const fixtureReleases = new WeakMap<object, Map<string, Promise<string>>>();

/**
 * An active agent with one release on the test connection, made once per
 * database handle and workspace: what a test that only needs some release
 * to start a session names as `agentReleaseId`. A session's release is of
 * its own workspace, so a test names the workspace its session is in; with
 * none, the agent gets a workspace of its own.
 */
export function fixtureRelease(
  db: Database,
  workspaceId?: string,
): Promise<string> {
  let byWorkspace = fixtureReleases.get(db);
  if (byWorkspace === undefined) {
    byWorkspace = new Map();
    fixtureReleases.set(db, byWorkspace);
  }
  const key = workspaceId ?? "";
  let made = byWorkspace.get(key);
  if (made === undefined) {
    made = makeFixtureRelease(
      db,
      workspaceId === undefined ? {} : { workspaceId },
    );
    byWorkspace.set(key, made);
  }
  return made;
}

/** A new agent with one release on the test connection; its ids. */
export async function makeFixtureRelease(
  db: Database,
  options: {
    workspaceId?: string;
    model?: string;
    status?: "active" | "paused" | "archived";
    /** Spec fields other than the model, e.g. a permission mode. */
    spec?: Partial<SpecSource>;
  } = {},
): Promise<string> {
  const workspaceId = options.workspaceId ?? randomUUID();
  // A test's owner id may name no workspace row yet; the agent needs one.
  await db
    .insert(workspaces)
    .values({
      id: workspaceId,
      slug: `fixture-${workspaceId}`,
      name: "fixture",
    })
    .onConflictDoNothing();
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    slug: `fixture-${agentId.slice(0, 8)}`,
    name: "fixture agent",
    status: options.status ?? "active",
    managingTeamId: await fixtureTeam(db, workspaceId),
  });
  const versionId = randomUUID();
  const model = options.model ?? TEST_MODEL;
  await db.insert(agentVersions).values({
    id: versionId,
    agentId,
    versionNo: 1,
    card: { model, capabilities: {}, language: "follow-user", rules: [] },
    contentSha256: "0".repeat(64),
  });
  const releaseId = `sha256:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
  const spec = releaseSpecColumns({ ...options.spec, model });
  await db.insert(agentReleases).values({
    id: releaseId,
    agentId,
    versionId,
    cardSha256: "0".repeat(64),
    connectionId: TEST_CONNECTION_ID,
    runtimeConfigSnapshot: {
      model,
      tools: spec.specSource.tools,
      permission_mode: spec.specSource.permission_mode,
      provider: { kind: "anthropic", endpoint: "https://api.anthropic.com" },
      runtime: spec.specSource.runtime,
    },
    effectiveTools: { tools: spec.specSource.tools, mcp: [] },
    ...spec,
  });
  return releaseId;
}

const TEST_PROVIDER: CatalogProvider = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  auth: {
    kind: "api_key",
    value: "test-provider-key",
    ref: { value_env: "TEST_PROVIDER_KEY" },
  },
};

/** The built-in tools the test runtime installs, for every version. */
const TEST_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];

export function testToolCatalogs(
  tools: readonly string[] = TEST_TOOLS,
): ToolCatalogs {
  const catalog = {
    id: "test@1",
    runtimeKind: "claude_agent_sdk",
    sdkVersion: TEST_RUNTIME_VERSION,
    engineVersion: TEST_RUNTIME_VERSION,
    tools: tools.map((name) => ({ name, boundary: "local" as const })),
  };
  return { all: [catalog], for: () => catalog };
}

/**
 * A catalog whose one connection (`TEST_CONNECTION_ID`) offers `models`
 * through `provider`, with the rest of the catalog as given, and the test
 * runtime's tool catalog an agent service makes releases with.
 */
export function testSessionCatalog(
  input: Omit<SessionCatalog, "connections"> & {
    provider?: CatalogProvider;
    models?: readonly string[];
    model_families?: CatalogConnection["model_families"];
    auto_mode?: CatalogConnection["auto_mode"];
  } = { repositories: {} },
): SessionCatalog & { tool_catalogs: ToolCatalogs } {
  const { provider, models, model_families, auto_mode, ...rest } = input;
  return {
    tool_catalogs: testToolCatalogs(),
    connections: {
      [TEST_CONNECTION_ID]: {
        provider: provider ?? TEST_PROVIDER,
        models: models ?? [TEST_MODEL],
        ...(model_families === undefined ? {} : { model_families }),
        auto_mode: auto_mode ?? "unknown",
      },
    },
    ...rest,
  };
}

/** The release spec columns, for a raw `INSERT INTO agent_releases`. */
export const RELEASE_SPEC_SQL_COLUMNS =
  "connection_id, spec_source, spec_source_digest, runtime_spec, spec_digest";

/** SQL literals for `RELEASE_SPEC_SQL_COLUMNS`, in the same order. */
export function releaseSpecSqlValues(
  overrides: Partial<SpecSource> = {},
): string {
  const spec = releaseSpecColumns(overrides);
  const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    text(overrides.connection?.id ?? TEST_CONNECTION_ID),
    `${text(JSON.stringify(spec.specSource))}::jsonb`,
    text(spec.specSourceDigest),
    `${text(JSON.stringify(spec.runtimeSpec))}::jsonb`,
    text(spec.specDigest),
  ].join(", ");
}

/** A session's pin columns, for a raw `INSERT INTO sessions`. */
export const SESSION_PIN_SQL_COLUMNS = `model, ${RELEASE_SPEC_SQL_COLUMNS.replace("connection_id, ", "")}`;

/** SQL literals for `SESSION_PIN_SQL_COLUMNS`, in the same order. */
export function sessionPinSqlValues(
  model = TEST_MODEL,
  overrides: Partial<SpecSource> = {},
): string {
  const pin = sessionPinColumns(model, overrides);
  const text = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    text(model),
    `${text(JSON.stringify(pin.specSource))}::jsonb`,
    text(pin.specSourceDigest),
    `${text(JSON.stringify(pin.runtimeSpec))}::jsonb`,
    text(pin.specDigest),
  ].join(", ");
}
