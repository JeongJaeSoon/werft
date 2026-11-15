import { createHash, randomBytes } from "node:crypto";

/**
 * Counts of what the authorization server did; no value it issued or was
 * sent is kept anywhere a caller can read.
 */
export type FakeOAuthStats = {
  registrations: number;
  authorizations: number;
  code_grants: number;
  refresh_grants: number;
  /** Refused token requests: a used or unknown code, a wrong verifier, a spent refresh token. */
  token_refusals: number;
  revocations: number;
};

export type FakeOAuth = {
  /** Null when the path is not the authorization server's. */
  handle(request: Request): Promise<Response | null>;
  /** Whether `token` is an access token it issued that is still good. */
  accepts(token: string): boolean;
  /** The 401 challenge that points at the resource metadata. */
  challenge(): string;
  stats(): FakeOAuthStats;
};

type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string | null;
};
type Grant = { clientId: string; scope: string | null };

const PREFIX = { access: "fmo_", refresh: "fmr_", code: "fmc_" } as const;

const issue = (prefix: string) =>
  `${prefix}${randomBytes(24).toString("base64url")}`;

const s256 = (verifier: string) =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

/**
 * The OAuth side of a remote MCP server as the MCP authorization spec asks:
 * protected resource metadata (RFC 9728), authorization server metadata
 * (RFC 8414) with `iss` in the response, dynamic client registration
 * (RFC 7591), PKCE S256 only, RFC 8707 `resource`, refresh tokens that
 * rotate, and revocation (RFC 7009). The authorize step consents at once as
 * one fixed account. Issued values carry a prefix (`fmo_`, `fmr_`, `fmc_`)
 * so a test can show they are absent without reading one.
 */
export function createFakeOAuth(options: {
  /** The origin the API reaches this server at; the issuer. */
  origin: () => string;
  /** The MCP endpoint these tokens are for. */
  resourcePath: string;
  scope: string;
  accessTtlSec: number;
}): FakeOAuth {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, Code>();
  const access = new Map<string, number>();
  const refresh = new Map<string, Grant>();
  const stats: FakeOAuthStats = {
    registrations: 0,
    authorizations: 0,
    code_grants: 0,
    refresh_grants: 0,
    token_refusals: 0,
    revocations: 0,
  };
  const resource = () => `${options.origin()}${options.resourcePath}`;
  const metadataPath = `/.well-known/oauth-protected-resource${options.resourcePath}`;

  const refuse = (error: string) => {
    stats.token_refusals += 1;
    return Response.json({ error }, { status: 400 });
  };

  const tokens = (grant: Grant) => {
    const accessToken = issue(PREFIX.access);
    const refreshToken = issue(PREFIX.refresh);
    access.set(accessToken, Date.now() + options.accessTtlSec * 1000);
    refresh.set(refreshToken, grant);
    return Response.json(
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: options.accessTtlSec,
        refresh_token: refreshToken,
        ...(grant.scope === null ? {} : { scope: grant.scope }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };

  async function token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const clientId = form.get("client_id") ?? "";
    if (!clients.has(clientId)) return refuse("invalid_client");
    if (form.get("resource") !== resource()) return refuse("invalid_target");
    if (form.get("grant_type") === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      // One use: a second exchange of the same code is refused.
      codes.delete(form.get("code") ?? "");
      if (
        code === undefined ||
        code.clientId !== clientId ||
        code.redirectUri !== form.get("redirect_uri") ||
        code.challenge !== s256(form.get("code_verifier") ?? "")
      ) {
        return refuse("invalid_grant");
      }
      stats.code_grants += 1;
      return tokens({ clientId, scope: code.scope });
    }
    if (form.get("grant_type") === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const grant = refresh.get(presented);
      refresh.delete(presented);
      if (grant === undefined || grant.clientId !== clientId) {
        return refuse("invalid_grant");
      }
      stats.refresh_grants += 1;
      return tokens(grant);
    }
    return refuse("unsupported_grant_type");
  }

  function authorize(url: URL): Response {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    if (
      q.get("response_type") !== "code" ||
      !clients.get(clientId)?.includes(redirectUri) ||
      q.get("code_challenge_method") !== "S256" ||
      (q.get("code_challenge") ?? "") === "" ||
      q.get("resource") !== resource()
    ) {
      return new Response("bad authorization request", { status: 400 });
    }
    const code = issue(PREFIX.code);
    codes.set(code, {
      clientId,
      redirectUri,
      challenge: q.get("code_challenge") ?? "",
      scope: q.get("scope"),
    });
    stats.authorizations += 1;
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state") ?? "");
    back.searchParams.set("iss", options.origin());
    return new Response(null, {
      status: 302,
      headers: { Location: back.toString() },
    });
  }

  return {
    async handle(request) {
      const url = new URL(request.url);
      const origin = options.origin();
      switch (`${request.method} ${url.pathname}`) {
        case `GET ${metadataPath}`:
          return Response.json({
            resource: resource(),
            authorization_servers: [origin],
            scopes_supported: [options.scope],
          });
        case "GET /.well-known/oauth-authorization-server":
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            revocation_endpoint: `${origin}/revoke`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            scopes_supported: [options.scope],
            authorization_response_iss_parameter_supported: true,
          });
        case "POST /register": {
          const body = (await request.json().catch(() => null)) as {
            redirect_uris?: unknown;
            token_endpoint_auth_method?: unknown;
            grant_types?: unknown;
            response_types?: unknown;
          } | null;
          const uris = Array.isArray(body?.redirect_uris)
            ? body.redirect_uris.filter((uri) => typeof uri === "string")
            : [];
          if (uris.length === 0) {
            return Response.json(
              { error: "invalid_redirect_uri" },
              { status: 400 },
            );
          }
          // RFC 7591 §2 defaults an omitted method to client_secret_basic
          // and omitted grants to authorization_code alone, so a client that
          // leaves either out would get no public client or no refresh from
          // a real server; this one refuses it outright.
          const grants = Array.isArray(body?.grant_types)
            ? body.grant_types
            : ["authorization_code"];
          const responses = Array.isArray(body?.response_types)
            ? body.response_types
            : ["code"];
          if (
            body?.token_endpoint_auth_method !== "none" ||
            !grants.includes("authorization_code") ||
            !grants.includes("refresh_token") ||
            grants.some(
              (grant) =>
                grant !== "authorization_code" && grant !== "refresh_token",
            ) ||
            responses.length !== 1 ||
            responses[0] !== "code"
          ) {
            return Response.json(
              { error: "invalid_client_metadata" },
              { status: 400 },
            );
          }
          const clientId = `fake-client-${clients.size + 1}`;
          clients.set(clientId, uris);
          stats.registrations += 1;
          return Response.json(
            {
              client_id: clientId,
              redirect_uris: uris,
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            },
            { status: 201 },
          );
        }
        case "GET /authorize":
          return authorize(url);
        case "POST /token":
          return token(request);
        case "POST /revoke": {
          const presented =
            new URLSearchParams(await request.text()).get("token") ?? "";
          if (access.delete(presented) || refresh.delete(presented)) {
            stats.revocations += 1;
          }
          return new Response(null, { status: 200 });
        }
        default:
          return null;
      }
    },
    accepts(token) {
      const expires = access.get(token);
      return expires !== undefined && expires > Date.now();
    },
    challenge() {
      return `Bearer resource_metadata="${options.origin()}${metadataPath}", scope="${options.scope}"`;
    },
    stats: () => ({ ...stats }),
  };
}
