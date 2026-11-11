import type { Receipt, ReceiptOperation } from "@werft-ai/contracts";

/**
 * Where a receipt names an agent or one of its releases (94S-902), so a
 * reader who may not use that agent (a private agent outside their teams) is
 * not told its id. One row per operation that carries one; an operation with
 * no row declares it carries none, and `tests/receipt-agent-refs.test.ts`
 * fails when the code that writes an operation's receipt puts an agent or
 * release id in it and this table has no row for that operation.
 */
export type AgentRefs = {
  /** `result` fields holding an agent id, or an array of them. */
  agents?: readonly string[];
  /** `result` fields holding a release id, or an array of them. */
  releases?: readonly string[];
  /**
   * `target_ref` is that resource, not a session: its id is the agent's (or
   * the release's) own. A reader who may not use it gets 404.
   */
  target?: "agent" | "agent_release";
};

const ON_AGENT = { target: "agent" } as const;
// What the GitHub gate writes on a session: the agent and the release it ran.
const GATE = { agents: ["agent_id"], releases: ["agent_release_id"] } as const;
// What an egress exchange writes on a session.
const EXCHANGE = { agents: ["agent_id"], releases: ["release_id"] } as const;

export const RECEIPT_AGENT_REFS: Partial<Record<ReceiptOperation, AgentRefs>> =
  {
    // The usage listing of a team that went, and the agents it left.
    delete_team: { agents: ["agent_ids", "usage_agent_ids"] },

    // The agent's own settings: the target is the agent.
    create_agent: ON_AGENT,
    update_agent: ON_AGENT,
    create_agent_release: { ...ON_AGENT, releases: ["release_id"] },
    activate_agent: {
      ...ON_AGENT,
      releases: ["release_id", "previous_release_id"],
    },
    set_agent_managing_team: ON_AGENT,
    set_agent_usage: ON_AGENT,
    add_agent_admin: ON_AGENT,
    remove_agent_admin: ON_AGENT,
    bind_credential: ON_AGENT,
    unbind_credential: ON_AGENT,
    link_agent_identity: ON_AGENT,
    revoke_agent_identity: ON_AGENT,
    set_agent_github: { ...ON_AGENT, agents: ["agent_id"] },
    set_agent_mcp: { ...ON_AGENT, agents: ["agent_id"] },
    set_agent_pull_request_settings: { ...ON_AGENT, agents: ["agent_id"] },
    // A key made for an agent, or revoked.
    create_api_key: ON_AGENT,
    revoke_api_key: ON_AGENT,
    // The target is the binding; its agent is in the result.
    set_surface_binding: { agents: ["agent_id"] },
    request_surface_binding: { agents: ["agent_id"] },
    resolve_surface_binding: { agents: ["agent_id"] },

    // A start or an input refused for an unbound credential, or an env value
    // refused: on the agent when no session exists yet, else on the session.
    create_session: {
      ...ON_AGENT,
      agents: ["agent_id"],
      releases: ["release_id"],
    },
    append_message: {
      ...ON_AGENT,
      agents: ["agent_id"],
      releases: ["release_id"],
    },
    reject_session_env: {
      ...ON_AGENT,
      agents: ["agent_id"],
      releases: ["release_id"],
    },

    // On a session.
    mint_github_token: GATE,
    dispatch_workflow: GATE,
    rerun_workflow: GATE,
    review_pull_request: GATE,
    merge_pull_request: GATE,
    call_mcp: EXCHANGE,
    fetch_github_package: EXCHANGE,
  };

type Hidden = {
  agentIds: ReadonlySet<string>;
  releaseIds: ReadonlySet<string>;
};

/** The ids a receipt names through its table row, to ask which of them are hidden. */
export function agentRefsOf(receipt: Receipt): {
  agentIds: string[];
  releaseIds: string[];
} {
  const row = RECEIPT_AGENT_REFS[receipt.operation];
  const found = { agentIds: [] as string[], releaseIds: [] as string[] };
  // Whichever the operation, an agent key's receipt names that agent as actor.
  if (receipt.actor?.agent_id) found.agentIds.push(receipt.actor.agent_id);
  if (row === undefined) return found;
  const result = (receipt.result ?? {}) as Record<string, unknown>;
  for (const [fields, into] of [
    [row.agents ?? [], found.agentIds],
    [row.releases ?? [], found.releaseIds],
  ] as const) {
    for (const field of fields) {
      const value = result[field];
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id === "string") into.push(id);
      }
    }
  }
  const target = receipt.target_ref;
  if (
    row.target !== undefined &&
    "resource" in target &&
    target.resource.kind === row.target
  ) {
    (row.target === "agent" ? found.agentIds : found.releaseIds).push(
      target.resource.id,
    );
  }
  return found;
}

/** Whether the receipt's own target is a hidden agent or release. */
export function targetsHidden(receipt: Receipt, hidden: Hidden): boolean {
  const row = RECEIPT_AGENT_REFS[receipt.operation];
  const target = receipt.target_ref;
  if (
    row?.target === undefined ||
    !("resource" in target) ||
    target.resource.kind !== row.target
  ) {
    return false;
  }
  return row.target === "agent"
    ? hidden.agentIds.has(target.resource.id.toLowerCase())
    : hidden.releaseIds.has(target.resource.id);
}

/**
 * The receipt without the hidden ids its table row names: a scalar becomes
 * null and a list loses them. Everything else stays, so the receipt reads as
 * it did for a person who could see the agent, minus what names it.
 */
export function maskAgentRefs(receipt: Receipt, hidden: Hidden): Receipt {
  const actor = receipt.actor;
  return maskResult(
    actor?.agent_id && hidden.agentIds.has(actor.agent_id.toLowerCase())
      ? { ...receipt, actor: { ...actor, agent_id: null } }
      : receipt,
    hidden,
  );
}

function maskResult(receipt: Receipt, hidden: Hidden): Receipt {
  const row = RECEIPT_AGENT_REFS[receipt.operation];
  if (row === undefined || receipt.result === null) return receipt;
  const result = { ...(receipt.result as Record<string, unknown>) };
  for (const [fields, ids, lower] of [
    [row.agents ?? [], hidden.agentIds, true],
    [row.releases ?? [], hidden.releaseIds, false],
  ] as const) {
    const hides = (id: unknown) =>
      typeof id === "string" && ids.has(lower ? id.toLowerCase() : id);
    for (const field of fields) {
      const value = result[field];
      if (Array.isArray(value)) {
        result[field] = value.filter((id) => !hides(id));
      } else if (hides(value)) {
        result[field] = null;
      }
    }
  }
  return { ...receipt, result };
}
