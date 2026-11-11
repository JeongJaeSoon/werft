import { createHash, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  SESSION_SCOPE_VALUES,
  type SessionScope,
  sessionScopeSchema,
} from "@werft-ai/contracts";
import {
  type ApiKeyKind,
  type ApiKeyRecord,
  type ApiKeyRevocation,
  createApiKey,
  type Database,
  findApiKey,
  findLiveRole,
  findWorkspace,
  revokeApiKey,
  touchApiKey,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import { messageOf } from "@werft-ai/platform";
import { withJobDatabase } from "../job-database.ts";

export interface ApiKeyStore {
  /** `touchDue`: the key's last use is older than the touch interval. */
  find(
    keyHash: Uint8Array,
  ): Promise<(ApiKeyRecord & { touchDue?: boolean }) | null>;
  /** Absent on stores that keep no last use. */
  touch?(keyId: string): Promise<unknown>;
}

export type NewApiKey = {
  id: string;
  ownerId: string;
  keyHash: Uint8Array;
  scopes: readonly SessionScope[];
  workspaceId?: string;
  kind?: ApiKeyKind;
  createdByUserId?: string;
};

export interface ApiKeyWriter {
  create(input: NewApiKey): Promise<void>;
  revoke(keyId: string): Promise<ApiKeyRevocation>;
}

export function hashApiKey(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

export function generateApiKey(): string {
  return `csp_${randomBytes(32).toString("base64url")}`;
}

export class DatabaseApiKeyStore implements ApiKeyStore, ApiKeyWriter {
  constructor(private readonly db: Database) {}

  find(keyHash: Uint8Array) {
    return findApiKey(this.db, keyHash);
  }

  touch(keyId: string) {
    return touchApiKey(this.db, keyId);
  }

  async create(input: NewApiKey): Promise<void> {
    await createApiKey(this.db, input);
  }

  revoke(keyId: string): Promise<ApiKeyRevocation> {
    return revokeApiKey(this.db, keyId);
  }
}

/**
 * `--scopes` is required: a key that silently got every scope, recovery
 * included, is what scoped keys exist to stop. Order and duplicates do not
 * matter; the stored list is the vocabulary's order.
 */
function parseScopes(value: string): SessionScope[] {
  const words = value
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    throw new Error("--scopes must name at least one scope");
  }
  const unknown = words.filter(
    (word) => !sessionScopeSchema.safeParse(word).success,
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown scope ${unknown.join(", ")}; expected ${SESSION_SCOPE_VALUES.join(", ")}`,
    );
  }
  return SESSION_SCOPE_VALUES.filter((scope) => words.includes(scope));
}

// Inside a workspace the CLI issues a member's personal key only: no key
// acts across a workspace as itself, and an agent's key is issued by a
// person who administers that agent.
export type KeyIssue =
  | { ownerId: string; scopes: readonly SessionScope[] }
  | {
      workspaceId: string;
      scopes: readonly SessionScope[];
      personalFor: string;
    };

export async function issueApiKey(
  writer: Pick<ApiKeyWriter, "create">,
  input: KeyIssue,
  generate: () => string = generateApiKey,
): Promise<{ keyId: string; plaintext: string }> {
  const ownerId = "workspaceId" in input ? input.workspaceId : input.ownerId;
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) {
    throw new Error("owner_id must not be empty");
  }
  if (input.scopes.length === 0) {
    throw new Error("an API key needs at least one scope");
  }
  const plaintext = generate();
  const keyId = randomUUID();
  await writer.create({
    id: keyId,
    ownerId: normalizedOwnerId,
    keyHash: hashApiKey(plaintext),
    scopes: input.scopes,
    ...("workspaceId" in input
      ? {
          workspaceId: normalizedOwnerId,
          kind: "personal" as const,
          createdByUserId: input.personalFor,
        }
      : { kind: "operator" as const }),
  });
  return { keyId, plaintext };
}

const USAGE = `Usage: bun run apps/control-host/src/api/keys.ts create <owner_id> --scopes <scope>[,<scope>...]
       bun run apps/control-host/src/api/keys.ts create --workspace <workspace_id> --personal <user_id> --scopes <scope>[,<scope>...]
       bun run apps/control-host/src/api/keys.ts revoke <key_id>
Scopes: ${SESSION_SCOPE_VALUES.join(", ")}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KeysCommand =
  | ({ command: "create" } & (
      | { ownerId: string; scopes: SessionScope[] }
      | { workspaceId: string; scopes: SessionScope[]; personalFor: string }
    ))
  | { command: "revoke"; keyId: string };

function parseStrict(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        scopes: { type: "string" },
        workspace: { type: "string" },
        personal: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new Error(`${messageOf(error)}\n${USAGE}`);
  }
}

function uuidOption(value: string, name: string): string {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID\n${USAGE}`);
  return value.toLowerCase();
}

export function parseKeysCommand(argv: string[]): KeysCommand {
  const parsed = parseStrict(argv);
  const [command, target, ...extra] = parsed.positionals;
  const { workspace, personal } = parsed.values;
  if (command === "create" && workspace !== undefined) {
    if (target !== undefined) throw new Error(USAGE);
    if (parsed.values.scopes === undefined) {
      throw new Error(`--scopes is required\n${USAGE}`);
    }
    const workspaceId = uuidOption(workspace, "--workspace");
    if (personal === undefined) {
      throw new Error(
        `--workspace needs --personal: a key in a workspace is a member's own\n${USAGE}`,
      );
    }
    return {
      command: "create",
      workspaceId,
      scopes: parseScopes(parsed.values.scopes),
      personalFor: uuidOption(personal, "--personal"),
    };
  }
  if (personal !== undefined) {
    throw new Error(`--personal needs --workspace\n${USAGE}`);
  }
  if (!target || extra.length > 0) {
    throw new Error(USAGE);
  }
  if (command === "revoke") {
    if (parsed.values.scopes !== undefined || workspace !== undefined) {
      throw new Error(USAGE);
    }
    // Checked here: a malformed id would reach the uuid column as a 22P02.
    if (!UUID.test(target)) {
      throw new Error(`key_id must be a UUID\n${USAGE}`);
    }
    return { command: "revoke", keyId: target.toLowerCase() };
  }
  if (command !== "create") {
    throw new Error(USAGE);
  }
  if (parsed.values.scopes === undefined) {
    throw new Error(`--scopes is required\n${USAGE}`);
  }
  return {
    command: "create",
    ownerId: target.trim(),
    scopes: parseScopes(parsed.values.scopes),
  };
}

async function main(): Promise<void> {
  const command = parseKeysCommand(Bun.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  await withJobDatabase("keys", databaseUrl, createLogger(), async ({ db }) => {
    const store = new DatabaseApiKeyStore(db);
    if (command.command === "revoke") {
      const result = await store.revoke(command.keyId);
      if (result.outcome === "not_found") {
        console.error(`API key ${command.keyId} not found`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `${result.outcome} ${command.keyId} owner=${result.ownerId} revoked_at=${result.revokedAt.toISOString()}`,
      );
      return;
    }
    if ("workspaceId" in command) {
      if (!(await findWorkspace(db, command.workspaceId))) {
        console.error(`Workspace ${command.workspaceId} not found`);
        process.exitCode = 1;
        return;
      }
      if (
        (await findLiveRole(db, command.personalFor, command.workspaceId)) ===
        null
      ) {
        console.error(
          `User ${command.personalFor} is not a live member of workspace ${command.workspaceId}`,
        );
        process.exitCode = 1;
        return;
      }
    }
    const issued = await issueApiKey(store, command);
    // stdout carries the plaintext alone so scripts can capture it; the id,
    // which `revoke` takes, goes to stderr.
    console.error(`key_id ${issued.keyId}`);
    console.log(issued.plaintext);
  });
}

if (import.meta.main) {
  await main();
}
