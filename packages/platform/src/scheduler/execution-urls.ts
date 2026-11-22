import { isIP } from "node:net";

export function checkGatewayUrl(raw: string): void {
  try {
    new URL(raw);
  } catch {
    throw new Error(`WORKER_GATEWAY_URL ${raw} is not a URL`);
  }
}

/**
 * The egress proxy every worker is handed: http, no credentials, only a host
 * and port, and a host name. `hostHint` ends the error for an address: what
 * the backend's workers reach the proxy by.
 */
export function parseEgressProxyUrl(raw: string, hostHint: string): URL {
  // Proxies are addressed over http even when they tunnel TLS, and every
  // HTTP client reads the variable that way.
  let proxy: URL;
  try {
    proxy = new URL(raw);
  } catch {
    // Not quoted: a value that failed to parse may still hold a credential.
    throw new Error("EXECUTION_EGRESS_PROXY_URL is not a URL");
  }
  if (proxy.username !== "" || proxy.password !== "") {
    throw new Error("EXECUTION_EGRESS_PROXY_URL must not carry credentials");
  }
  if (proxy.protocol !== "http:") {
    throw new Error(`EXECUTION_EGRESS_PROXY_URL ${raw} must be an http:// URL`);
  }
  if (proxy.pathname !== "/" || proxy.search !== "" || proxy.hash !== "") {
    throw new Error(
      `EXECUTION_EGRESS_PROXY_URL ${raw} must name only a host and port`,
    );
  }
  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
  if (isIP(proxyHost) !== 0 || proxyHost === "localhost") {
    throw new Error(`EXECUTION_EGRESS_PROXY_URL ${raw} must name ${hostHint}`);
  }
  return proxy;
}
