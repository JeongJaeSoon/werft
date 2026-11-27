import { describe, expect, test } from "bun:test";
import { proxyUrlWithReportToken } from "./egress-report.ts";

describe("proxyUrlWithReportToken", () => {
  test("puts the token in as the proxy URL's password", () => {
    expect(proxyUrlWithReportToken("http://egress-proxy:3128", "wed_a")).toBe(
      "http://werft:wed_a@egress-proxy:3128/",
    );
  });

  test("leaves a value alone without a token, a URL, or room for one", () => {
    expect(proxyUrlWithReportToken("http://egress-proxy:3128", undefined)).toBe(
      "http://egress-proxy:3128",
    );
    expect(proxyUrlWithReportToken("egress-proxy:3128", "wed_a")).toBe(
      "egress-proxy:3128",
    );
    expect(proxyUrlWithReportToken("http://user:pw@proxy:3128", "wed_a")).toBe(
      "http://user:pw@proxy:3128",
    );
  });
});
