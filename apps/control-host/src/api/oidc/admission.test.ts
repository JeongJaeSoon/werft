import { describe, expect, test } from "bun:test";
import { type AdmissionPolicy, admit } from "./admission.ts";
import { GOOGLE_ISSUER } from "./issuer-rules.ts";

const identity = (
  email: string | null,
  claims: Record<string, unknown> = {},
  emailVerified: boolean | null = true,
) => ({ email, emailVerified, claims });

describe("admit: Google", () => {
  const open: AdmissionPolicy = {
    issuer: GOOGLE_ISSUER,
    allowedDomains: [],
    jitRole: null,
  };
  const restricted: AdmissionPolicy = {
    ...open,
    allowedDomains: ["example.com"],
  };
  const alice = identity("a@example.com", { hd: "example.com" });

  test("inside the list needs the hosted domain and the address to match it", () => {
    expect(admit(restricted, alice)).toEqual({
      jitRole: null,
      ownsEmail: true,
    });
    expect(admit({ ...restricted, jitRole: "member" }, alice)).toEqual({
      jitRole: "member",
      ownsEmail: true,
    });
    expect(admit(restricted, identity("a@example.com"))).toBeNull();
    expect(
      admit(restricted, identity("a@example.com", { hd: "other.example" })),
    ).toBeNull();
    expect(
      admit(restricted, identity("a@other.example", { hd: "example.com" })),
    ).toBeNull();
  });

  test("a consumer address is never inside a list, even one that names gmail.com", () => {
    expect(
      admit(
        { ...open, allowedDomains: ["gmail.com"], jitRole: "member" },
        identity("a@gmail.com"),
      ),
    ).toBeNull();
  });

  test("the hosted domain is compared without regard to case", () => {
    expect(
      admit(restricted, identity("a@example.com", { hd: "Example.COM" })),
    ).toEqual({ jitRole: null, ownsEmail: true });
  });

  test("with no list an address is owned only when Google vouches for it today", () => {
    expect(admit(open, alice)).toEqual({ jitRole: null, ownsEmail: true });
    expect(admit(open, identity("a@gmail.com"))).toEqual({
      jitRole: null,
      ownsEmail: true,
    });
    expect(admit(open, identity("a@example.com"))).toEqual({
      jitRole: null,
      ownsEmail: false,
    });
    expect(
      admit(open, identity("a@example.com", { hd: "other.example" })),
    ).toEqual({ jitRole: null, ownsEmail: false });
  });

  test("with no list nobody joins by themselves, whatever the JIT setting", () => {
    expect(admit({ ...open, jitRole: "member" }, alice)).toEqual({
      jitRole: null,
      ownsEmail: true,
    });
  });

  test("an unverified address is not owned and is outside every list", () => {
    const unverified = identity("a@example.com", { hd: "example.com" }, false);
    expect(admit(open, unverified)).toEqual({
      jitRole: null,
      ownsEmail: false,
    });
    expect(admit(restricted, unverified)).toBeNull();
  });
});

describe("admit: any other provider", () => {
  const open: AdmissionPolicy = {
    issuer: "https://idp.example.com",
    allowedDomains: [],
    jitRole: "member",
  };
  const restricted: AdmissionPolicy = {
    ...open,
    allowedDomains: ["example.com"],
  };

  test("a verified address is owned, and joins by itself where JIT is on", () => {
    expect(admit(open, identity("a@example.com"))).toEqual({
      jitRole: "member",
      ownsEmail: true,
    });
    expect(
      admit({ ...open, jitRole: null }, identity("a@example.com")),
    ).toEqual({ jitRole: null, ownsEmail: true });
  });

  test("the hd claim means nothing outside Google", () => {
    expect(
      admit(open, identity("a@example.com", { hd: "other.example" })),
    ).toEqual({ jitRole: "member", ownsEmail: true });
    expect(
      admit(restricted, identity("a@other.example", { hd: "example.com" })),
    ).toBeNull();
  });

  test("an address that is not verified, or not said to be, is not owned and does not join", () => {
    for (const emailVerified of [false, null]) {
      expect(admit(open, identity("a@example.com", {}, emailVerified))).toEqual(
        { jitRole: null, ownsEmail: false },
      );
      expect(
        admit(restricted, identity("a@example.com", {}, emailVerified)),
      ).toBeNull();
    }
  });

  test("no address at all is not owned, and is outside every list", () => {
    expect(admit(open, identity(null))).toEqual({
      jitRole: null,
      ownsEmail: false,
    });
    expect(admit(restricted, identity(null))).toBeNull();
  });

  test("a list lets in its own domains only, not a subdomain or a look-alike", () => {
    expect(admit(restricted, identity("a@example.com"))).toEqual({
      jitRole: "member",
      ownsEmail: true,
    });
    for (const email of [
      "a@sub.example.com",
      "a@notexample.com",
      "a@example.com.evil.example",
      "example.com@evil.example",
    ]) {
      expect(admit(restricted, identity(email))).toBeNull();
    }
  });
});
