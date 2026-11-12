import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { SecretOwnerRef } from "../ports/secret-store.ts";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_HEX = /^[0-9a-fA-F]{64}$/;

export const SECRET_KEY_VERSION = 1;

export class SecretKeyError extends Error {
  override name = "SecretKeyError";
}

/** Raised for any ciphertext that does not open; it says nothing else. */
export class SecretDecryptError extends Error {
  override name = "SecretDecryptError";
  constructor() {
    super("Stored secret could not be decrypted");
  }
}

/**
 * The master key. Its bytes are not an enumerable property, so a logger or
 * JSON.stringify that reaches it prints nothing of the key.
 */
export class SecretKey {
  readonly #bytes: Buffer;
  readonly version: number;

  private constructor(bytes: Buffer, version: number) {
    this.#bytes = bytes;
    this.version = version;
  }

  /** `source` names where the value came from; the value is never in an error. */
  static fromHex(value: string, source: string): SecretKey {
    if (!KEY_HEX.test(value)) {
      throw new SecretKeyError(
        `${source} must be 64 hexadecimal characters (32 bytes); generate one with \`openssl rand -hex 32\``,
      );
    }
    return new SecretKey(Buffer.from(value, "hex"), SECRET_KEY_VERSION);
  }

  /** @internal for sealSecret and openSecret */
  bytes(): Buffer {
    return this.#bytes;
  }

  toJSON(): string {
    return "[secret key]";
  }
}

export type SecretAadFields = {
  id: string;
  workspaceId: string;
  ownerRef: SecretOwnerRef;
  purpose: string;
  secretVersion: number;
  keyVersion: number;
};

export type SealedSecret = { nonce: Buffer; ciphertext: Buffer };

/** `id|workspace_id|owner_ref|purpose|secret_version|key_version` */
export function secretAad(fields: SecretAadFields): Buffer {
  const parts = [
    fields.id,
    fields.workspaceId,
    fields.ownerRef,
    fields.purpose,
    String(fields.secretVersion),
    String(fields.keyVersion),
  ];
  if (parts.some((part) => part.length === 0 || part.includes("|"))) {
    throw new Error("Secret AAD fields must be non-empty and contain no '|'");
  }
  return Buffer.from(parts.join("|"), "utf8");
}

export function sealSecret(
  key: SecretKey,
  fields: SecretAadFields,
  value: string,
): SealedSecret {
  if (fields.keyVersion !== key.version) {
    throw new Error("Secret key version does not match the AAD");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key.bytes(), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(secretAad(fields));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { nonce, ciphertext };
}

export function openSecret(
  key: SecretKey,
  fields: SecretAadFields,
  sealed: SealedSecret,
): string {
  if (
    fields.keyVersion !== key.version ||
    sealed.nonce.length !== NONCE_BYTES ||
    sealed.ciphertext.length < TAG_BYTES
  ) {
    throw new SecretDecryptError();
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes(), sealed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(secretAad(fields));
    decipher.setAuthTag(sealed.ciphertext.subarray(-TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.ciphertext.subarray(0, -TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new SecretDecryptError();
  }
}

/**
 * A 32-byte key for one use other than stored secrets (HKDF-SHA256, `use`
 * as the info), so what that use seals cannot be opened as a stored secret
 * or by another use, and the master key itself seals only stored secrets.
 */
export function derivedSecretKey(key: SecretKey, use: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key.bytes(), Buffer.alloc(0), use, 32));
}

/** What a reader may see of a value: its last four characters. */
export function lastFour(value: string): string {
  return value.slice(-4);
}
