import { expect, test } from "bun:test";
import {
  apiError,
  json,
  runSample,
  type Seen,
} from "../../testing/sample-server.ts";

const SAMPLE = `${import.meta.dir}/discover.ts`;

const route = ({ path, url, headers }: Seen) => {
  expect(headers.get("authorization")).toBe("Bearer sample-agent-key");
  if (path === "/v1") return json({ status: "ok", owner_id: "fake-workspace" });
  if (path === "/v1/auth/me")
    return json({
      principal: {
        kind: "api_key",
        id: "fake-key",
        owner_id: "fake-workspace",
        workspace_id: "fake-workspace",
        scopes: ["sessions:read"],
      },
      user: null,
    });
  if (path === "/v1/connections")
    return json({
      items: [
        {
          id: "fake-messages",
          kind: "anthropic",
          billing: "metered",
          models: ["claude-sonnet-5"],
          model_successors: {},
        },
      ],
    });
  if (path === "/v1/limits") {
    expect(url.searchParams.get("scope")).toBe("installation");
    return apiError(403, "FORBIDDEN");
  }
  return apiError(404, "NOT_FOUND");
};

test("reads the key, the catalog and the limits a key may not see", async () => {
  const { exit, stdout, stderr } = await runSample(SAMPLE, route);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  for (const line of [
    "refused no API key",
    "refused plain http to a remote host",
    "refused a default Authorization header: headers cannot set Authorization",
    "refused a negative retry count",
    "principal: api_key, scopes sessions:read",
    "connection fake-messages: anthropic, metered, models claude-sonnet-5",
    "limits: 403 FORBIDDEN (owner sign-in only)",
  ])
    expect(stdout).toContain(line);
});

test("fails when the key lacks a scope the caller needs", async () => {
  const { exit, stderr } = await runSample(SAMPLE, route, {
    WERFT_REQUIRED_SCOPES: "sessions:read,sessions:write",
  });
  expect(exit).toBe(1);
  expect(stderr).toContain("the key lacks sessions:write");
});
