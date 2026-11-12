import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;

/**
 * What a flow may end in. `login` signs someone in; the others (an invite
 * sign-up, linking to a signed-in account, an owner's test sign-in) carry
 * more than this and are checked again by the callback that handles them.
 */
export type FlowPurpose = "login" | "invite" | "link" | "test";

/** One sign-in flow, from the start request to the callback. */
export type LoginFlow = {
  purpose: FlowPurpose;
  /** The provider the flow was started for, and its settings then. */
  providerId: string;
  configRevision: number;
  // The three values the browser must bring back; never logged.
  state: string;
  nonce: string;
  verifier: string;
  /** Milliseconds since the epoch, on this server's clock. */
  startedAt: number;
  /**
   * A `test` flow: the owner who started it, their session, and the stored
   * secret it tries (the row and its version: a slot emptied and filled
   * again counts from 1 on another row).
   */
  test?: {
    userId: string;
    sessionId: string;
    secretSlot: "current" | "next";
    secretId: string;
    secretVersion: number;
  };
};

const PURPOSES: readonly string[] = ["login", "invite", "link", "test"];

function testOf(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const test = value as Record<string, unknown>;
  return (
    typeof test.userId === "string" &&
    test.userId !== "" &&
    typeof test.sessionId === "string" &&
    test.sessionId !== "" &&
    (test.secretSlot === "current" || test.secretSlot === "next") &&
    typeof test.secretId === "string" &&
    test.secretId !== "" &&
    Number.isInteger(test.secretVersion)
  );
}

function flowOf(value: unknown): LoginFlow | null {
  if (typeof value !== "object" || value === null) return null;
  const flow = value as Record<string, unknown>;
  const text = (name: string) =>
    typeof flow[name] === "string" && flow[name] !== "";
  if (
    typeof flow.purpose !== "string" ||
    !PURPOSES.includes(flow.purpose) ||
    !text("providerId") ||
    !text("state") ||
    !text("nonce") ||
    !text("verifier") ||
    !Number.isInteger(flow.configRevision) ||
    !Number.isFinite(flow.startedAt) ||
    // A test flow names who runs it; no other flow carries that.
    (flow.purpose === "test") !== (flow.test !== undefined) ||
    (flow.test !== undefined && !testOf(flow.test))
  ) {
    return null;
  }
  return value as LoginFlow;
}

/**
 * Seals a flow into a cookie value and opens it again (AES-256-GCM). The
 * browser holds the value and can neither read nor change it: what the
 * callback opens is exactly what the start request sealed. The cookie's
 * name and the format version are bound in, so a value sealed for anything
 * else does not open here.
 *
 * `key` is 32 bytes kept for this use alone.
 */
export function createFlowSealer(key: Buffer, cookieName: string) {
  const aad = Buffer.from(`${cookieName}|v${FORMAT_VERSION}`, "utf8");
  return {
    seal(flow: LoginFlow): string {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce, {
        authTagLength: TAG_BYTES,
      });
      cipher.setAAD(aad);
      return Buffer.concat([
        nonce,
        cipher.update(JSON.stringify(flow), "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]).toString("base64url");
    },

    /** Null for a value that does not open or is not a flow. */
    open(value: string | undefined): LoginFlow | null {
      if (!value) return null;
      const bytes = Buffer.from(value, "base64url");
      if (bytes.length < NONCE_BYTES + TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          key,
          bytes.subarray(0, NONCE_BYTES),
          { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(-TAG_BYTES));
        const text = Buffer.concat([
          decipher.update(bytes.subarray(NONCE_BYTES, -TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
        return flowOf(JSON.parse(text));
      } catch {
        return null;
      }
    },
  };
}

export type FlowSealer = ReturnType<typeof createFlowSealer>;
