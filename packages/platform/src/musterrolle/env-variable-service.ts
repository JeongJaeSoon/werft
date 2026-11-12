import {
  type AgentEnvVariables,
  type DeleteEnvVariableResponse,
  type EnvVariable,
  type EnvVariableList,
  envNameProblem,
  envValueProblem,
  type PutEnvVariableFields,
  type PutEnvVariableGrantsRequest,
  type PutEnvVariableGrantsResponse,
  type PutEnvVariableResponse,
} from "@werft-ai/contracts";
import type {
  EnvVariableRecord,
  EnvVariableScope,
  EnvVariableStore,
} from "../ports/env-variable-store.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import { NOT_FOUND, SessionServiceError } from "./service-errors.ts";

// User variables (E-41, design section 7). Owners and admins manage the
// workspace's own; an agent's admins, owners and admins manage that agent's.
// Never an API key: both actions sit in MANAGEMENT_ROLES, which the policy
// holds to people. A value is only ever put in or, for a plain variable, read
// back; no message or detail below carries one.

export type WritePrecondition = { create: true } | { ifMatch: number };

/** The raw `If-Match` / `If-None-Match` header values of one request. */
export type PreconditionHeaders = {
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
};

const required = () =>
  new SessionServiceError(
    "PRECONDITION_REQUIRED",
    "Send If-None-Match: * to create or If-Match with the version to change",
  );

const malformed = (message: string) =>
  new SessionServiceError("BAD_REQUEST", message);

// A version is a plain integer, or a strong entity tag that quotes one.
// A weak tag never matches under If-Match's strong comparison.
function versionOf(header: string): number {
  const match = /^(?:"(\d{1,15})"|(\d{1,15}))$/.exec(header.trim());
  const digits = match?.[1] ?? match?.[2];
  if (!digits) throw malformed("If-Match must be a version number");
  return Number(digits);
}

/** A write that creates names `If-None-Match: *`; one that changes names `If-Match`. */
export function writePreconditionOf(
  headers: PreconditionHeaders,
): WritePrecondition {
  const { ifMatch, ifNoneMatch } = headers;
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw malformed("Send If-Match or If-None-Match, not both");
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() !== "*") {
      throw malformed("If-None-Match must be *");
    }
    return { create: true };
  }
  if (ifMatch === undefined) throw required();
  return { ifMatch: versionOf(ifMatch) };
}

/** The version a delete or a grant change was read at. */
export function ifMatchOf(ifMatch: string | undefined): number {
  if (ifMatch === undefined) throw required();
  return versionOf(ifMatch);
}

const mismatch = (current: number | null) =>
  new SessionServiceError(
    "VERSION_MISMATCH",
    "The variable changed since it was read; read it again",
    undefined,
    { current_version: current },
  );

function checkName(name: string): void {
  const problem = envNameProblem(name);
  if (problem === "invalid") {
    throw new SessionServiceError(
      "VARIABLE_NAME_INVALID",
      "A variable name is upper case: a letter, then letters, digits or _ (64 at most)",
    );
  }
  if (problem === "reserved") {
    throw new SessionServiceError(
      "VARIABLE_NAME_RESERVED",
      "The platform sets that name itself",
    );
  }
}

// Plain variables only until the secret path (E-41 P7) can carry one.
function checkBody(body: PutEnvVariableFields): void {
  if (body.kind === "secret") {
    throw new SessionServiceError(
      "SECRET_ENV_UNSUPPORTED",
      "No runtime carries a secret variable yet",
    );
  }
  if (
    body.engine_delivery === true ||
    body.allow_automation === true ||
    body.acknowledge_engine_exposure === true
  ) {
    throw malformed("engine_delivery and allow_automation are for secrets");
  }
  const problem = envValueProblem(body.value, body.kind);
  if (problem === "invalid_text") {
    throw new SessionServiceError(
      "VARIABLE_VALUE_INVALID",
      "A value is text without NUL bytes",
    );
  }
  if (problem === "too_large") {
    throw new SessionServiceError(
      "VARIABLE_VALUE_TOO_LARGE",
      "A value is 48 KB at most",
    );
  }
}

export function envVariableViewOf(record: EnvVariableRecord): EnvVariable {
  return {
    name: record.name,
    kind: record.kind,
    // A secret is never read back; its value is null in the record as well.
    ...(record.kind === "plain" && record.value !== null
      ? { value: record.value }
      : {}),
    version: record.version,
    grant_all: record.grantAll,
    grant_version: record.grantVersion,
    granted_agents: record.grantedAgents.map((grant) => grant.id),
    engine_delivery: record.engineDelivery,
    updated_by: record.updatedBy,
    updated_at: record.updatedAt.toISOString(),
  };
}

function agentViewOf(
  own: EnvVariableRecord[],
  workspace: EnvVariableRecord[],
  agentId: string,
): AgentEnvVariables {
  // The path accepts any UUID case; stored ids are lower case.
  const wanted = agentId.toLowerCase();
  const granted = workspace.filter(
    (variable) =>
      variable.grantAll ||
      variable.grantedAgents.some((grant) => grant.id.toLowerCase() === wanted),
  );
  const grantedNames = new Set(granted.map((variable) => variable.name));
  const workspaceNames = new Set(workspace.map((variable) => variable.name));
  const ownNames = new Set(own.map((variable) => variable.name));
  const effective = [
    ...own.map((variable) => ({
      name: variable.name,
      kind: variable.kind,
      source: "agent" as const,
      shadows_workspace: grantedNames.has(variable.name),
      // Existence only: the workspace value itself is not this agent's.
      workspace_value_ungranted:
        workspaceNames.has(variable.name) && !grantedNames.has(variable.name),
    })),
    ...granted
      .filter((variable) => !ownNames.has(variable.name))
      .map((variable) => ({
        name: variable.name,
        kind: variable.kind,
        source: "workspace" as const,
        shadows_workspace: false,
        workspace_value_ungranted: false,
      })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return {
    effective,
    items: own.map(envVariableViewOf),
    granted_workspace_values: granted.map((variable) => ({
      name: variable.name,
      kind: variable.kind,
      ...(variable.kind === "plain" && variable.value !== null
        ? { value: variable.value }
        : {}),
    })),
  };
}

export function createEnvVariableService(deps: {
  authorization: AuthorizationPolicy;
  store: EnvVariableStore;
}) {
  const { authorization, store } = deps;

  const onWorkspace = (caller: Caller) =>
    requirePermitted(authorization, caller, "variable.workspace.manage", {
      kind: "workspace",
      id: caller.ownerId,
    });
  const onAgent = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "variable.agent.manage", {
      kind: "agent",
      id: agentId,
    });

  async function put(
    caller: Caller,
    scope: EnvVariableScope,
    name: string,
    body: PutEnvVariableFields,
    headers: PreconditionHeaders,
  ): Promise<PutEnvVariableResponse> {
    checkName(name);
    checkBody(body);
    const precondition = writePreconditionOf(headers);
    const result = await store.put({
      principal: caller,
      scope,
      name,
      value: body.value,
      precondition,
    });
    switch (result.outcome) {
      case "saved":
        return {
          name,
          version: result.version,
          grant_version: result.grantVersion,
        };
      case "version_mismatch":
        throw mismatch(result.current);
      case "quota_exceeded":
        throw new SessionServiceError(
          "VARIABLE_QUOTA_EXCEEDED",
          scope.agentId === null
            ? "The workspace holds its limit of variables"
            : "The agent holds its limit of variables",
        );
      default:
        throw NOT_FOUND();
    }
  }

  async function remove(
    caller: Caller,
    scope: EnvVariableScope,
    name: string,
    ifMatch: string | undefined,
  ): Promise<DeleteEnvVariableResponse> {
    const version = ifMatchOf(ifMatch);
    const result = await store.delete({
      principal: caller,
      scope,
      name,
      ifMatch: version,
    });
    switch (result.outcome) {
      case "deleted":
        return {
          affected_agents: result.affectedAgents,
          open_sessions: result.openSessions,
        };
      case "version_mismatch":
        throw mismatch(result.current);
      default:
        throw NOT_FOUND();
    }
  }

  return {
    async listWorkspace(caller: Caller): Promise<EnvVariableList> {
      await onWorkspace(caller);
      const records = await store.list({
        workspaceId: caller.ownerId,
        agentId: null,
      });
      return { items: records.map(envVariableViewOf) };
    },

    async putWorkspace(
      caller: Caller,
      name: string,
      body: PutEnvVariableFields,
      headers: PreconditionHeaders,
    ): Promise<PutEnvVariableResponse> {
      await onWorkspace(caller);
      return put(
        caller,
        { workspaceId: caller.ownerId, agentId: null },
        name,
        body,
        headers,
      );
    },

    async deleteWorkspace(
      caller: Caller,
      name: string,
      ifMatch: string | undefined,
    ): Promise<DeleteEnvVariableResponse> {
      await onWorkspace(caller);
      return remove(
        caller,
        { workspaceId: caller.ownerId, agentId: null },
        name,
        ifMatch,
      );
    },

    async putGrants(
      caller: Caller,
      name: string,
      body: PutEnvVariableGrantsRequest,
      ifMatch: string | undefined,
    ): Promise<PutEnvVariableGrantsResponse> {
      await onWorkspace(caller);
      if (body.grant_all && body.agents.length > 0) {
        throw malformed("grant_all takes no agents");
      }
      const version = ifMatchOf(ifMatch);
      const result = await store.setGrants({
        principal: caller,
        workspaceId: caller.ownerId,
        name,
        ifMatch: version,
        grantAll: body.grant_all,
        agents: body.agents.map((agent) => ({
          id: agent.id,
          allowAutomation: agent.allow_automation === true,
        })),
      });
      switch (result.outcome) {
        case "saved":
          return { name, grant_version: result.grantVersion };
        case "version_mismatch":
          throw mismatch(result.current);
        case "agent_not_found":
          throw malformed(
            "agents names an agent that is not in this workspace",
          );
        default:
          throw NOT_FOUND();
      }
    },

    // The path takes any UUID case. The store locks on the id as text, so
    // every agent entry point lower-cases it before anything else sees it.
    async listAgent(
      caller: Caller,
      pathAgentId: string,
    ): Promise<AgentEnvVariables> {
      const agentId = pathAgentId.toLowerCase();
      await onAgent(caller, agentId);
      if (!(await store.hasAgent(caller.ownerId, agentId))) throw NOT_FOUND();
      const { own, workspace } = await store.readAgentView(
        caller.ownerId,
        agentId,
      );
      return agentViewOf(own, workspace, agentId);
    },

    async putAgent(
      caller: Caller,
      pathAgentId: string,
      name: string,
      body: PutEnvVariableFields,
      headers: PreconditionHeaders,
    ): Promise<PutEnvVariableResponse> {
      const agentId = pathAgentId.toLowerCase();
      await onAgent(caller, agentId);
      return put(
        caller,
        { workspaceId: caller.ownerId, agentId },
        name,
        body,
        headers,
      );
    },

    async deleteAgent(
      caller: Caller,
      pathAgentId: string,
      name: string,
      ifMatch: string | undefined,
    ): Promise<DeleteEnvVariableResponse> {
      const agentId = pathAgentId.toLowerCase();
      await onAgent(caller, agentId);
      return remove(
        caller,
        { workspaceId: caller.ownerId, agentId },
        name,
        ifMatch,
      );
    },
  };
}

export type EnvVariableService = ReturnType<typeof createEnvVariableService>;
