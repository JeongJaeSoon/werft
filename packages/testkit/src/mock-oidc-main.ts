import { startMockOidcServer } from "./mock-oidc.ts";

// The mock OIDC provider as a process, for driving provider sign-in against
// a running stack (docs/operator/api-server.md "로그인 공급자"). The API container
// reaches it on MOCK_OIDC_ISSUER (host.docker.internal), a shell on this
// host on MOCK_OIDC_PUBLIC_URL; the account signing in is the `login_hint`
// added to the authorization URL (testkit/mock-oidc.ts loginHint).
const port = Number(process.env.MOCK_OIDC_PORT ?? "4020");
const server = await startMockOidcServer({
  clientId: process.env.MOCK_OIDC_CLIENT_ID ?? "mock-client",
  clientSecret: process.env.MOCK_OIDC_CLIENT_SECRET ?? "mock-secret",
  hostname: "0.0.0.0",
  port,
  issuer: process.env.MOCK_OIDC_ISSUER ?? `http://host.docker.internal:${port}`,
  publicUrl: process.env.MOCK_OIDC_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
});
console.error(`mock OIDC provider ${server.issuer} on port ${server.port}`);
