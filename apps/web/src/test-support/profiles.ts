import type {
  InstallationProfileOptionsResponse,
  InstallationProfileState,
  ProfileSummary,
} from "@werft-ai/contracts";
import { USER_ID } from "./fake-api.ts";

/** Profiles as GET /v1/profiles lists them, for the run profile screens. */

export const RECEIPT_ID = "00000000-0000-4000-8000-000000000001";

export const CATALOG_ID = "claude_agent_sdk@0.3.270+claude-code@2.1.270";

/** A trimmed copy of the pinned catalog: one tool per boundary at least. */
export const CATALOG_TOOLS = [
  { name: "Read", boundary: "local" },
  { name: "Edit", boundary: "local" },
  { name: "Write", boundary: "local" },
  { name: "Bash", boundary: "local" },
  { name: "WebFetch", boundary: "egress" },
  { name: "WebSearch", boundary: "provider" },
] as const;

/** What GET /v1/profiles lists as `deny` for `tools` on the catalog's version. */
export const denyFor = (tools: readonly string[]): string[] =>
  CATALOG_TOOLS.map((tool) => tool.name).filter(
    (name) => !tools.includes(name),
  );

/** `deny` as the listing works it out: from the catalog, unless given. */
const withDeny = (profile: ProfileSummary): ProfileSummary => ({
  ...profile,
  deny:
    profile.deny !== undefined
      ? profile.deny
      : profile.runtime_version === "0.3.270"
        ? denyFor(profile.tools)
        : null,
});

type Installation = NonNullable<ProfileSummary["installation"]>;

export function imported(
  id: string,
  narrowed: Partial<ProfileSummary> = {},
  state: InstallationProfileState = "usable",
): ProfileSummary {
  return withDeny({
    id,
    source: "operator",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-haiku-5"],
    tools: ["Read", "Edit", "Bash"],
    permission_mode: "acceptEdits",
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    billing: "metered",
    repository_mode: "required",
    repository_ids: ["platform"],
    ...narrowed,
    installation: {
      name: null,
      version: 1,
      origin: "catalog",
      state,
      connection_id: "anthropic",
      title_model: null,
      project_settings: { claude_md: false },
      previous_id: null,
      created_by: null,
      created_at: "2026-10-20T00:00:00.000Z",
      retired_by: null,
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
    },
  });
}

/** Version `n` of the console ceiling `name`, `op_<name>_v<n>`. */
export function ceiling(
  name: string,
  n: number,
  narrowed: Partial<ProfileSummary> = {},
  installation: Partial<Installation> = {},
): ProfileSummary {
  const base = imported(`op_${name}_v${n}`, narrowed);
  const state = installation.state ?? "usable";
  return {
    ...base,
    installation: {
      ...(base.installation as Installation),
      name,
      version: n,
      origin: "console",
      title_model: "claude-haiku-5",
      project_settings: { claude_md: true },
      previous_id: n === 1 ? null : `op_${name}_v${n - 1}`,
      created_by: USER_ID,
      created_at: `2026-10-2${n}T00:00:00.000Z`,
      retired_by: state === "retired" ? USER_ID : null,
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
      ...installation,
    },
  };
}

/**
 * Version `n` of the workspace profile `strict`, an admin's narrowing of
 * `base`: a lineage row (`op_wl_<name>_v<n>`) that carries the profile it
 * was derived from, listed like any other profile.
 */
export function version(
  n: number,
  state: InstallationProfileState,
  narrowed: Partial<ProfileSummary> = {},
  base = "coding-claude",
  name = "strict",
): ProfileSummary {
  const { installation: source, deny: _deny, ...over } = imported(base);
  return withDeny({
    ...over,
    id: `op_wl_${name}_v${n}`,
    models: ["claude-sonnet-5"],
    tools: ["Read"],
    permission_mode: "default",
    ...narrowed,
    installation: {
      ...(source as Installation),
      name,
      version: n,
      origin: "console",
      state,
      derived_from: base,
      previous_id: n === 1 ? null : `op_wl_${name}_v${n - 1}`,
      created_by: USER_ID,
      created_at: `2026-10-2${n}T00:00:00.000Z`,
      retired_by: state === "retired" ? USER_ID : null,
      retired_at: state === "retired" ? "2026-10-27T01:00:00.000Z" : null,
    },
  });
}

export const OPTIONS: InstallationProfileOptionsResponse = {
  connections: [
    { id: "anthropic", kind: "anthropic", billing: "metered" },
    { id: "local", kind: "litellm", billing: "none" },
  ],
  runtimes: [
    {
      runtime_kind: "claude_agent_sdk",
      permission_modes: [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "bypassPermissions",
      ],
    },
  ],
  repositories: [{ id: "docs" }, { id: "platform" }],
  // One entry per version spelling, as the server lists a catalog.
  tool_catalogs: ["0.3.270", "2.1.270"].map((runtime_version) => ({
    id: CATALOG_ID,
    runtime_kind: "claude_agent_sdk" as const,
    runtime_version,
    tools: CATALOG_TOOLS.map((tool) => ({ ...tool })),
  })),
  unattended_allowed: false,
};

export function refusal(
  status: number,
  code: string,
  details: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: String(details.reason_code ?? code),
        retryable: false,
        request_id: "req-1",
        details,
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}
