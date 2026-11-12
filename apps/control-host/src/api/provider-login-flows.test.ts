import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { LOGIN_FLOW_COOKIE_NAME } from "@werft-ai/contracts";
import type { LoginProvider, LoginProviderStore } from "@werft-ai/platform";
import {
  type MockOidcClaims,
  type MockOidcServer,
  startMockOidcServer,
} from "@werft-ai/testkit/mock-oidc";
import { createFlowSealer, type LoginFlow } from "./oidc/flow-cookie.ts";
import {
  createProviderLogin,
  type ProviderLogin,
  ProviderLoginError,
} from "./provider-login.ts";

// The flows that end in something other than a plain sign-in: a sign-up by
// invite, and a link to a signed-in person's account.

const CLIENT_ID = "client-id.apps.example";
const CLIENT_KEY = randomBytes(24).toString("base64url");
// On loopback, so the stand-in provider's plain http is allowed.
const CONSOLE_ORIGIN = "http://localhost:5173";
const PROVIDER_ID = randomUUID();
const FLOW_KEY = randomBytes(32);
const INVITE_ID = randomUUID();
const PERSON = { userId: randomUUID(), sessionId: randomUUID() };

let idp: MockOidcServer;
beforeAll(async () => {
  idp = await startMockOidcServer({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_KEY,
  });
});
afterAll(() => idp.stop());

function loginFor(overrides: Partial<LoginProvider> = {}) {
  const row: LoginProvider = {
    id: PROVIDER_ID,
    displayName: "Mock",
    issuer: idp.issuer,
    authorizationEndpoint: `${idp.issuer}/authorize`,
    tokenEndpoint: `${idp.issuer}/token`,
    jwksUri: `${idp.issuer}/jwks`,
    userinfoEndpoint: null,
    signingAlgs: ["RS256"],
    issParameterRequired: false,
    clientId: CLIENT_ID,
    tokenAuthMethod: "client_secret_post",
    allowedDomains: [],
    jitRole: null,
    requireVerifiedEmail: true,
    enabled: true,
    configRevision: 1,
    ...overrides,
  };
  const providers: LoginProviderStore = {
    listEnabled: async () => [],
    findForSignIn: async (id) =>
      id === row.id ? { provider: { ...row }, clientSecret: CLIENT_KEY } : null,
  };
  const login = createProviderLogin({
    providers,
    consoleOrigin: CONSOLE_ORIGIN,
    flowKey: FLOW_KEY,
  });
  return { login, row };
}

const alice: MockOidcClaims = {
  sub: "1001",
  email: "alice@example.com",
  name: "Alice",
};

const sealer = createFlowSealer(FLOW_KEY, LOGIN_FLOW_COOKIE_NAME);

type Started = Awaited<ReturnType<ProviderLogin["start"]>>;
const starts = {
  login: (login: ProviderLogin) => login.start(PROVIDER_ID),
  invite: (login: ProviderLogin) =>
    login.startInvite({ providerId: PROVIDER_ID, inviteId: INVITE_ID }),
  link: (login: ProviderLogin) =>
    login.startLink({ providerId: PROVIDER_ID, ...PERSON }),
} satisfies Record<string, (login: ProviderLogin) => Promise<Started>>;

/** The person goes to the provider and comes back with its answer. */
async function back(started: Started, claims: MockOidcClaims = alice) {
  const answer = await idp.authorize(started.authorizationUrl, claims);
  return {
    cookieValue: started.cookieValue as string | undefined,
    providerId: PROVIDER_ID,
    code: answer.code,
    state: answer.state,
    responseIssuer: undefined as string | undefined,
  };
}

const ends = {
  login: (login: ProviderLogin, callback: Awaited<ReturnType<typeof back>>) =>
    login.finish(callback),
  invite: (login: ProviderLogin, callback: Awaited<ReturnType<typeof back>>) =>
    login.finishInvite(callback),
  link: (login: ProviderLogin, callback: Awaited<ReturnType<typeof back>>) =>
    login.finishLink({ ...callback, session: PERSON }),
};

/** The kind and the logged reason a call was refused with. */
async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProviderLoginError) {
      return { kind: error.kind, reason: error.reason };
    }
    throw error;
  }
  return null;
}

describe("what a flow is started for", () => {
  test("an invite's flow is sealed with that invite, a link's with the person and their session", async () => {
    const { login } = loginFor();
    const invite = sealer.open((await starts.invite(login)).cookieValue);
    expect(invite).toMatchObject({
      purpose: "invite",
      providerId: PROVIDER_ID,
      invite: { inviteId: INVITE_ID },
    });
    expect(invite?.link).toBeUndefined();
    const link = sealer.open((await starts.link(login)).cookieValue);
    expect(link).toMatchObject({
      purpose: "link",
      providerId: PROVIDER_ID,
      link: PERSON,
    });
    expect(link?.invite).toBeUndefined();
    // The cookie tells the callback which end to run, and nothing else does.
    expect(login.purposeOf((await starts.link(login)).cookieValue)).toBe(
      "link",
    );
    expect(login.purposeOf("not a cookie")).toBeNull();
    expect(login.purposeOf(undefined)).toBeNull();
  });

  test("neither starts on a provider that is off or not there", async () => {
    const { login } = loginFor({ enabled: false });
    expect(await refusal(starts.invite(login))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });
    expect(await refusal(starts.link(login))).toEqual({
      kind: "not_found",
      reason: "provider_off",
    });
    expect(
      await refusal(
        loginFor().login.startInvite({
          providerId: randomUUID(),
          inviteId: INVITE_ID,
        }),
      ),
    ).toEqual({ kind: "not_found", reason: "provider_off" });
  });
});

describe("what a flow ends as", () => {
  const purposes = ["login", "invite", "link"] as const;
  for (const startedAs of purposes) {
    for (const endedAs of purposes) {
      if (startedAs === endedAs) continue;
      test(`a flow started as ${startedAs} does not end as ${endedAs}`, async () => {
        const { login } = loginFor();
        const callback = await back(await starts[startedAs](login));
        expect(await refusal(ends[endedAs](login, callback))).toEqual({
          kind: "rejected",
          reason: "flow_purpose",
        });
        // Refused before the provider was asked: the code is still good.
        expect(await refusal(ends[startedAs](login, callback))).toBeNull();
      });
    }
  }

  test("an invite's flow ends with who the provider says it is and the invite it was started with", async () => {
    const { login, row } = loginFor();
    const answer = await login.finishInvite(
      await back(await starts.invite(login)),
    );
    expect(answer.inviteId).toBe(INVITE_ID);
    expect(answer.provider).toMatchObject({ id: row.id, configRevision: 1 });
    expect(answer.identity).toMatchObject({
      issuer: idp.issuer,
      subject: "1001",
      email: "alice@example.com",
    });
    expect(answer.admission.ownsEmail).toBe(true);
  });

  test("a cookie that says invite or link and names none is refused", async () => {
    const { login } = loginFor();
    for (const purpose of ["invite", "link"] as const) {
      const callback = await back(await starts.login(login));
      const opened = sealer.open(callback.cookieValue) as LoginFlow;
      const bare = {
        ...callback,
        cookieValue: sealer.seal({ ...opened, purpose }),
      };
      expect(await refusal(ends[purpose](login, bare))).toEqual({
        kind: "rejected",
        reason: purpose === "invite" ? "flow_invite" : "link_session",
      });
    }
  });
});

describe("a link ends only in the session it was started from", () => {
  const strangers: Array<
    [string, { userId: string; sessionId: string } | null]
  > = [
    ["no session", null],
    [
      "another session of the same person",
      { userId: PERSON.userId, sessionId: randomUUID() },
    ],
    [
      "another person holding the session's id",
      { userId: randomUUID(), sessionId: PERSON.sessionId },
    ],
  ];
  for (const [who, session] of strangers) {
    test(`refused for ${who}, before the provider is asked anything`, async () => {
      const { login } = loginFor();
      const callback = await back(await starts.link(login));
      expect(await refusal(login.finishLink({ ...callback, session }))).toEqual(
        {
          kind: "rejected",
          reason: "link_session",
        },
      );
      // The code was not spent on the refusal.
      const answer = await login.finishLink({ ...callback, session: PERSON });
      expect(answer.identity.subject).toBe("1001");
    });
  }
});

describe("the provider's own rules hold for an invite and a link too", () => {
  for (const purpose of ["invite", "link"] as const) {
    test(`${purpose}: an address outside the allowed domains is forbidden`, async () => {
      const { login } = loginFor({ allowedDomains: ["example.com"] });
      const callback = await back(await starts[purpose](login), {
        ...alice,
        email: "alice@other.example",
      });
      expect(await refusal(ends[purpose](login, callback))).toEqual({
        kind: "forbidden",
        reason: "domain_not_allowed",
      });
    });

    test(`${purpose}: an unverified address is refused where verification is required, and owns nothing where it is not`, async () => {
      const unverified = { ...alice, email_verified: null };
      const strict = loginFor().login;
      expect(
        (
          await refusal(
            ends[purpose](
              strict,
              await back(await starts[purpose](strict), unverified),
            ),
          )
        )?.kind,
      ).toBe("rejected");
      const lax = loginFor({ requireVerifiedEmail: false }).login;
      const answer = await ends[purpose](
        lax,
        await back(await starts[purpose](lax), unverified),
      );
      expect(answer.identity.subject).toBe("1001");
      // The caller records no address for this account.
      expect(answer.admission.ownsEmail).toBe(false);
    });

    test(`${purpose}: settings changed since the start, or the provider off, end the flow`, async () => {
      const { login, row } = loginFor();
      const changed = await back(await starts[purpose](login));
      row.configRevision = 2;
      expect(await refusal(ends[purpose](login, changed))).toEqual({
        kind: "rejected",
        reason: "config_changed",
      });
      row.configRevision = 1;
      const off = await back(await starts[purpose](login));
      row.enabled = false;
      expect(await refusal(ends[purpose](login, off))).toEqual({
        kind: "not_found",
        reason: "provider_off",
      });
    });
  }
});

describe("flow cookie: what a flow is bound to", () => {
  const flow: LoginFlow = {
    purpose: "login",
    providerId: PROVIDER_ID,
    configRevision: 1,
    state: "s",
    nonce: "n",
    verifier: "v",
    startedAt: 1,
  };
  const invite = { inviteId: INVITE_ID };

  test("opens with the invite or the person the flow was sealed with", () => {
    const sealedInvite = { ...flow, purpose: "invite" as const, invite };
    expect(sealer.open(sealer.seal(sealedInvite))).toEqual(sealedInvite);
    const sealedLink = { ...flow, purpose: "link" as const, link: PERSON };
    expect(sealer.open(sealer.seal(sealedLink))).toEqual(sealedLink);
  });

  test("does not open with an invite or a person on a flow of another purpose", () => {
    for (const purpose of ["login", "link", "test"] as const) {
      expect(sealer.open(sealer.seal({ ...flow, purpose, invite }))).toBeNull();
    }
    for (const purpose of ["login", "invite", "test"] as const) {
      expect(
        sealer.open(sealer.seal({ ...flow, purpose, link: PERSON })),
      ).toBeNull();
    }
  });

  test("does not open with an invite or a person that is not all there", () => {
    const sealed = (bound: object) =>
      sealer.seal({ ...flow, ...bound } as LoginFlow);
    for (const bad of [{}, { inviteId: "" }, { inviteId: 7 }, null, "x"]) {
      expect(
        sealer.open(sealed({ purpose: "invite", invite: bad })),
      ).toBeNull();
    }
    for (const bad of [
      {},
      { userId: PERSON.userId },
      { sessionId: PERSON.sessionId },
      { userId: "", sessionId: PERSON.sessionId },
      null,
    ]) {
      expect(sealer.open(sealed({ purpose: "link", link: bad }))).toBeNull();
    }
  });
});
