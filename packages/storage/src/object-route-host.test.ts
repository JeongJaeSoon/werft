import { expect, test } from "bun:test";
import { objectRouteHost } from "./object-route.ts";

test("the object route's host is the endpoint's, or with none the bucket's own name at AWS", () => {
  const region = "ap-northeast-1";
  expect(
    objectRouteHost({
      bucket: "sessions",
      endpoint: "http://LocalStack:4566/base",
      region,
    }),
  ).toBe("localstack");
  expect(objectRouteHost({ bucket: "sessions", region })).toBe(
    "sessions.s3.ap-northeast-1.amazonaws.com",
  );
  // A dotted bucket is addressed by path: the wildcard certificate does not
  // cover it.
  expect(objectRouteHost({ bucket: "corp.sessions", region })).toBe(
    "s3.ap-northeast-1.amazonaws.com",
  );
});
