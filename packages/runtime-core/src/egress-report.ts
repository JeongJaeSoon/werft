/**
 * A proxy variable's value with the attempt's egress report token as its
 * userinfo, which HTTP clients send to the proxy as
 * `Proxy-Authorization: Basic`. The forward proxy reads it only off a
 * request it refused, to say which attempt it turned away; the token opens
 * nothing. A value that is not a URL, or already names a user, is kept.
 */
export function proxyUrlWithReportToken(
  value: string,
  token: string | undefined,
): string {
  if (token === undefined) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.username !== "" || url.password !== "") return value;
  url.username = "werft";
  url.password = token;
  return url.toString();
}
