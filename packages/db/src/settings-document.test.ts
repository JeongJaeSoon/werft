import { expect, test } from "bun:test";
import { receiptDestinationOf } from "./settings-document.ts";

test("a receipt's host:port is the egress allowlists' spelling of the endpoint", () => {
  const hostPort = (endpoint: string) =>
    receiptDestinationOf(endpoint).host_port;
  // The host in lower case, with the scheme's port when none is given.
  expect(hostPort("https://API.Anthropic.COM")).toBe("api.anthropic.com:443");
  expect(hostPort("http://fake-model")).toBe("fake-model:80");
  expect(hostPort("https://models.example:8443/v1")).toBe(
    "models.example:8443",
  );
  // A scheme's own port is the same as none.
  expect(hostPort("https://models.example:443")).toBe("models.example:443");
  // An international name as punycode, as DNS and the proxy see it.
  expect(hostPort("https://Bücher.example/v1")).toBe(
    "xn--bcher-kva.example:443",
  );
  // No trailing dot, and an IPv6 address without its brackets.
  expect(hostPort("https://models.example./v1")).toBe("models.example:443");
  expect(hostPort("http://[FD00::1]:4000")).toBe("fd00::1:4000");
  expect(hostPort("http://10.0.0.5:4000")).toBe("10.0.0.5:4000");
});

test("an endpoint carrying a credential is kept without it; a clean one as written", () => {
  expect(
    receiptDestinationOf("https://user:secret@models.example/v1?api_key=abc#x"),
  ).toEqual({
    endpoint: "https://models.example/v1",
    host_port: "models.example:443",
  });
  expect(receiptDestinationOf("https://models.example/v1?")).toEqual({
    endpoint: "https://models.example/v1",
    host_port: "models.example:443",
  });
  // Not rewritten: the receipt shows what the row holds.
  expect(receiptDestinationOf("https://API.example.com")).toEqual({
    endpoint: "https://API.example.com",
    host_port: "api.example.com:443",
  });
});

test("an endpoint that is no URL leaves both out rather than guessing", () => {
  expect(receiptDestinationOf("not a url")).toEqual({
    endpoint: null,
    host_port: null,
  });
  expect(receiptDestinationOf(undefined)).toEqual({
    endpoint: null,
    host_port: null,
  });
});
