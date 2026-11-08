import { describe, expect, test } from "bun:test";
import {
  githubConnection,
  githubInstallation,
} from "../test-support/fake-api.ts";
import {
  appShortfalls,
  featureMark,
  neededFor,
  permissionsUrl,
  unapproved,
} from "./github-permission-table.ts";

const OFF = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
  merge: false,
};

describe("GitHub 기능별 권한 판정", () => {
  test("같은 App에 모자란 기능 둘은 필요 권한 한 묶음이 된다", () => {
    const short = appShortfalls(githubConnection(), {
      ...OFF,
      actions: true,
      workflows: true,
    });
    expect(short.map((item) => item.feature)).toEqual(["actions", "workflows"]);
    expect(neededFor(short)).toEqual({ actions: "write", workflows: "write" });
  });

  test("머지는 계약이 묻는 권한(Contents 쓰기, Pull requests 읽기)만 요구한다", () => {
    const held = githubConnection({
      permissions: { contents: "write", pull_requests: "read" },
    });
    expect(featureMark("merge", [held], { ...OFF, merge: true })).toBeNull();
    const short = githubConnection({
      permissions: { contents: "read", pull_requests: "read" },
    });
    expect(featureMark("merge", [short], { ...OFF, merge: true })).toBe(
      "appShort",
    );
  });

  test("아직 읽지 못한 App은 모자라다고 하지 않는다", () => {
    expect(
      appShortfalls(githubConnection({ permissions: null }), {
        ...OFF,
        actions: true,
      }),
    ).toEqual([]);
  });

  test("리뷰 기능은 리뷰 승인용 App에서만 본다", () => {
    const ceiling = { ...OFF, review: true };
    expect(appShortfalls(githubConnection(), ceiling)).toEqual([]);
    expect(
      appShortfalls(
        githubConnection({
          role: "reviewer",
          permissions: { metadata: "read" },
        }),
        ceiling,
      ),
    ).toEqual([{ feature: "review", missing: ["contents", "pull_requests"] }]);
  });

  test("확인 못 한 설치는 승인 대기로 세지 않는다", () => {
    const installation = githubInstallation({
      status: "unknown",
      detail: { permissions: { metadata: "read" } },
    });
    expect(unapproved(installation, { actions: "write" })).toEqual([]);
  });

  test("기능과 상관없는 권한의 승인 대기는 기능에 표시하지 않는다", () => {
    const connection = githubConnection({
      permissions: { actions: "write", issues: "write", metadata: "read" },
      installations: [
        githubInstallation({
          status: "approval_pending",
          detail: { permissions: { actions: "write", metadata: "read" } },
        }),
      ],
    });
    const ceiling = { ...OFF, actions: true };
    expect(featureMark("actions", [connection], ceiling)).toBeNull();
  });

  test("기능이 쓰는 권한의 승인 대기는 그 기능에 표시한다", () => {
    const connection = githubConnection({
      permissions: { ...githubConnection().permissions, actions: "write" },
      installations: [githubInstallation({ status: "approval_pending" })],
    });
    expect(
      featureMark("actions", [connection], { ...OFF, actions: true }),
    ).toBe("pending");
    expect(featureMark("actions", [connection], OFF)).toBeNull();
  });

  test("App 권한이 모자라면 승인 대기보다 먼저 권한 필요를 표시한다", () => {
    expect(
      featureMark("workflows", [githubConnection()], {
        ...OFF,
        workflows: true,
      }),
    ).toBe("appShort");
  });

  test("권한 설정 주소는 App 소유 계정 아래에 있다", () => {
    expect(permissionsUrl(githubConnection())).toBe(
      "https://github.com/organizations/acme/settings/apps/werft-agent/permissions",
    );
    expect(
      permissionsUrl(
        githubConnection({ owner: { login: "jae", type: "user" } }),
      ),
    ).toBe("https://github.com/settings/apps/werft-agent/permissions");
    expect(permissionsUrl(githubConnection({ owner: null }))).toBeNull();
  });
});
