import { describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { createFlowSealer, type LoginFlow } from "./flow-cookie.ts";

const NAME = "__Host-werft_login_flow";
const KEY = randomBytes(32);
const flow: LoginFlow = {
  purpose: "login",
  providerId: "5b0c7e2a-9d41-4f6b-8a3e-7c1d2e3f4a5b",
  configRevision: 3,
  state: "state-value",
  nonce: "nonce-value",
  verifier: "verifier-value",
  startedAt: 1_700_000_000_000,
};

/** A value sealed the way the sealer does, around any JSON. */
function sealRaw(payload: unknown, key = KEY, aad = `${NAME}|v1`): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([
    nonce,
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}

describe("flow cookie", () => {
  const sealer = createFlowSealer(KEY, NAME);

  test("opens to exactly what was sealed", () => {
    expect(sealer.open(sealer.seal(flow))).toEqual(flow);
    // The helper below stands in for the sealer in the refusals.
    expect(sealer.open(sealRaw(flow))).toEqual(flow);
  });

  test("the value shows none of the flow and differs every time", () => {
    const value = sealer.seal(flow);
    const text = Buffer.from(value, "base64url").toString("latin1");
    for (const secret of [flow.state, flow.nonce, flow.verifier]) {
      expect(value).not.toContain(secret);
      expect(text).not.toContain(secret);
    }
    expect(sealer.seal(flow)).not.toBe(value);
  });

  test("no value, an empty one and one too short to hold a tag do not open", () => {
    expect(sealer.open(undefined)).toBeNull();
    expect(sealer.open("")).toBeNull();
    expect(sealer.open("not-a-cookie")).toBeNull();
    expect(sealer.open(randomBytes(27).toString("base64url"))).toBeNull();
  });

  test("a value changed anywhere does not open", () => {
    const bytes = Buffer.from(sealer.seal(flow), "base64url");
    for (const index of [0, 12, bytes.length - 17, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[index] = (changed[index] ?? 0) ^ 0x01;
      expect(sealer.open(changed.toString("base64url"))).toBeNull();
    }
    expect(sealer.open(bytes.subarray(0, -1).toString("base64url"))).toBeNull();
  });

  test("a value sealed with another key, for another cookie or in another format does not open", () => {
    expect(sealer.open(sealRaw(flow, randomBytes(32)))).toBeNull();
    expect(
      sealer.open(createFlowSealer(KEY, "__Host-werft_session").seal(flow)),
    ).toBeNull();
    expect(sealer.open(sealRaw(flow, KEY, `${NAME}|v2`))).toBeNull();
  });

  test("a sealed value that is not a whole flow does not open", () => {
    const broken: unknown[] = [
      null,
      "flow",
      [],
      { ...flow, purpose: "admin" },
      { ...flow, purpose: undefined },
      { ...flow, providerId: "" },
      { ...flow, state: "" },
      { ...flow, nonce: 7 },
      { ...flow, verifier: undefined },
      { ...flow, configRevision: 1.5 },
      { ...flow, configRevision: "3" },
      { ...flow, startedAt: null },
      { ...flow, startedAt: "1700000000000" },
    ];
    for (const payload of broken) {
      expect(sealer.open(sealRaw(payload))).toBeNull();
    }
  });

  const owner = {
    userId: "3e7f1a90-5c2d-4b8e-8f61-2a9d0c4b7e35",
    sessionId: "0f8b6a52-3d1e-4c7a-9b2f-5e6d7c8a9b01",
    secretSlot: "next",
    secretVersion: 2,
  } as const;

  test("every purpose a flow can have opens as that purpose", () => {
    for (const purpose of ["login", "invite", "link"] as const) {
      expect(sealer.open(sealer.seal({ ...flow, purpose }))?.purpose).toBe(
        purpose,
      );
    }
    expect(
      sealer.open(sealer.seal({ ...flow, purpose: "test", test: owner })),
    ).toEqual({ ...flow, purpose: "test", test: owner });
  });

  test("a test flow names who runs it and which secret it tries, and no other flow does", () => {
    const broken: unknown[] = [
      // A test with nobody behind it.
      { ...flow, purpose: "test" },
      // A sign-in dressed as someone's test.
      { ...flow, purpose: "login", test: owner },
      { ...flow, purpose: "test", test: { ...owner, userId: "" } },
      { ...flow, purpose: "test", test: { ...owner, sessionId: undefined } },
      { ...flow, purpose: "test", test: { ...owner, secretSlot: "other" } },
      { ...flow, purpose: "test", test: { ...owner, secretVersion: "2" } },
      { ...flow, purpose: "test", test: "owner" },
      { ...flow, purpose: "test", test: null },
    ];
    for (const payload of broken) {
      expect(sealer.open(sealRaw(payload)), JSON.stringify(payload)).toBeNull();
    }
  });
});
