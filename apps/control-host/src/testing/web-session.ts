import { WEB_SESSION_COOKIE_NAME } from "@werft-ai/contracts";
import type {
  IdentityStore,
  MembershipRole,
  ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../api/auth.ts";
import { hashApiKey } from "../api/keys.ts";

/**
 * Web sessions held in memory for route tests: cookieFor signs a member in,
 * identity resolves the cookie, and keyStore knows one personal key.
 */
export function fakeWebSessions(workspaceId: string) {
  const sessions = new Map<string, ResolvedWebSession>();

  function cookieFor(
    role: MembershipRole,
    options: { workspaceId?: string; userId?: string } = {},
  ): string {
    const token = generateWebSessionToken();
    sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
      sessionId: crypto.randomUUID(),
      userId: options.userId ?? crypto.randomUUID(),
      email: `${role}@example.com`,
      displayName: role,
      locale: null,
      workspaceId: options.workspaceId ?? workspaceId,
      role,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return `${WEB_SESSION_COOKIE_NAME}=${token}`;
  }

  const identity = {
    async resolveWebSession(tokenHash: Uint8Array) {
      return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
    },
    async renewWebSession() {
      return null;
    },
  } as unknown as IdentityStore;

  const key = { plaintext: `csp_${crypto.randomUUID()}` };
  const keyStore = {
    async find(candidate: Uint8Array) {
      if (
        !Buffer.from(hashApiKey(key.plaintext)).equals(Buffer.from(candidate))
      )
        return null;
      return {
        id: crypto.randomUUID(),
        ownerId: workspaceId,
        workspaceId,
        kind: "personal" as const,
        agentId: null,
        createdByUserId: crypto.randomUUID(),
        creatorRole: "owner" as const,
        scopes: ["sessions:read" as const, "sessions:write" as const],
      };
    },
  };

  return { sessions, cookieFor, identity, keyStore, key };
}
