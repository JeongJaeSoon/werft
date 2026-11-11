import {
  API_SPEC_VERSION,
  type ClientOptions,
  isApiError,
  SDK_VERSION,
  SUPPORTED_SSE_SCHEMA_VERSIONS,
  Werft,
} from "@werft-ai/sdk";

const signal = AbortSignal.timeout(60_000);
const required = (process.env.WERFT_REQUIRED_SCOPES ?? "sessions:read")
  .split(",")
  .filter(Boolean);

// Each of these would leak the key or misbehave, so construction throws
// before anything is sent.
const unsafe: [string, ClientOptions][] = [
  ["no API key", { baseUrl: "https://agents.example.com", apiKey: "" }],
  [
    "plain http to a remote host",
    { baseUrl: "http://agents.example.com", apiKey: "unused" },
  ],
  [
    "a default Authorization header",
    {
      baseUrl: "https://agents.example.com",
      apiKey: "unused",
      defaultHeaders: { Authorization: "Bearer other" },
    },
  ],
  [
    "a negative retry count",
    { baseUrl: "https://agents.example.com", apiKey: "unused", maxRetries: -1 },
  ],
];

async function run(): Promise<void> {
  console.log(
    `@werft-ai/sdk ${SDK_VERSION}, API spec ${API_SPEC_VERSION}, SSE schema ${SUPPORTED_SSE_SCHEMA_VERSIONS.join(",")}`,
  );
  for (const [label, options] of unsafe) {
    try {
      new Werft(options);
    } catch (error) {
      console.log(`refused ${label}: ${(error as Error).message}`);
      continue;
    }
    throw new Error(`the client accepted ${label}`);
  }

  // WERFT_BASE_URL and WERFT_API_KEY; one quick attempt for each read.
  const client = new Werft().withOptions({ timeoutMs: 10_000, maxRetries: 0 });

  const root = await client.root.get({ signal });
  console.log(`api: ${root.status}, key owner ${root.owner_id}`);

  const me = await client.auth.me({ signal });
  const { principal } = me;
  console.log(
    `principal: ${principal.kind}${"role" in principal ? ` (${principal.role})` : ""}, scopes ${principal.scopes.join(",")}`,
  );
  const missing = required.filter(
    (scope) => !(principal.scopes as string[]).includes(scope),
  );
  if (missing.length > 0)
    throw new Error(`the key lacks ${missing.join(", ")}`);

  const connections = await client.connections.list({ signal });
  for (const connection of connections.items) {
    console.log(
      `connection ${connection.id}: ${connection.kind}, ${connection.billing}, models ${connection.models.join(", ") || "(none)"}`,
    );
  }
  if (connections.items.length === 0)
    throw new Error("no provider connection is enabled");

  // Installation limits are for a signed-in workspace owner; a key gets 403.
  try {
    const limits = await client.limits.get({ signal });
    console.log("limits:", limits);
  } catch (error) {
    if (!isApiError(error, "FORBIDDEN")) throw error;
    console.log(`limits: ${error.status} ${error.code} (owner sign-in only)`);
  }
}

try {
  await run();
} catch (error) {
  if (isApiError(error))
    console.error(error.code, error.message, "request_id:", error.requestId);
  else console.error(error instanceof Error ? error.message : "Sample failed");
  process.exitCode = 1;
}
