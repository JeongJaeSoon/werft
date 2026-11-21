import { describe, expect, test } from "bun:test";
import type {
  Skill,
  SkillGitSource,
  SkillSyncCheck,
  SkillVersion,
  SkillVersionFiles,
} from "@werft-ai/contracts";
import { setupUser } from "@werft-ai/ui/test-support/dom";
import { AGENT_ID, agentServer } from "../test-support/fake-agents.ts";
import {
  apiError,
  json,
  me,
  memberMe,
  RECEIPT_ID,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();
// After the harness: the route module pulls in the UI, which needs the DOM.
const { uploadFilesOf } = await import("./settings-skills.tsx");

const SKILLS = "GET /v1/workspace/skills";
const AT = "2026-11-21T03:00:00.000Z";
const hex = (char: string, length: number) => char.repeat(length);
const versionId = (n: number) => `9a8b7c6d-0000-4000-8000-00000000000${n}`;

function version(n: number, over: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id: versionId(n),
    name: "release-notes",
    version: n,
    digest: hex(String(n), 64),
    source: "upload",
    git: null,
    size_bytes: 512,
    has_scripts: true,
    review: "approved",
    registered_by: USER_ID,
    registered_at: AT,
    reviewed_by: null,
    reviewed_at: null,
    archived_at: null,
    current: false,
    ...over,
  };
}

function check(over: Partial<SkillSyncCheck> = {}): SkillSyncCheck {
  return {
    at: AT,
    trigger: { kind: "webhook", delivery_id: "d-1", user_id: null },
    commit: hex("a", 40),
    result: "unchanged",
    version_id: versionId(1),
    issues: [],
    auto_approval: null,
    ...over,
  };
}

function gitSource(over: Partial<SkillGitSource> = {}): SkillGitSource {
  return {
    connection_id: "1a2b3c4d-0000-4000-8000-00000000000a",
    installation_id: 42,
    repository_id: 7,
    repository: "acme/skills",
    path: "skills/triage",
    ref: "main",
    sync_enabled: true,
    webhook: "ready",
    auto_approve: { state: "off", requested_by: null, consented_by: null },
    last_check: check(),
    ...over,
  };
}

function skill(over: Partial<Skill> = {}): Skill {
  return {
    name: "release-notes",
    source: "upload",
    git: null,
    pending_count: 0,
    versions: [version(1)],
    workspace_attachment: null,
    ...over,
  };
}

const gitSkill = (git: Partial<SkillGitSource> = {}) =>
  skill({
    name: "triage",
    source: "github",
    git: gitSource(git),
    versions: [
      version(1, {
        name: "triage",
        source: "github",
        git: {
          repository_id: 7,
          path: "skills/triage",
          ref: "main",
          commit: hex("a", 40),
          trigger: { kind: "register", delivery_id: null, user_id: USER_ID },
        },
      }),
    ],
  });

const listed = (...items: Skill[]) => ({
  [SKILLS]: () => json(200, { items }),
});

describe("스킬 라이브러리 목록", () => {
  test("Git 스킬과 업로드 스킬은 다른 아이콘과 접근 이름으로 보인다", async () => {
    renderAt("/settings/workspace/skills", {
      "GET /v1/auth/me": () => json(200, me()),
      ...listed(skill(), gitSkill()),
    });
    const table = await screen.findByRole("table", { name: "스킬 라이브러리" });
    const github = await within(table).findByRole("img", {
      name: "GitHub에서 가져옴",
    });
    const upload = within(table).getByRole("img", { name: "웹에서 업로드" });
    expect(github.getAttribute("data-source")).toBe("github");
    expect(upload.getAttribute("data-source")).toBe("upload");
    // Different marks, not one mark under two names.
    expect(github.innerHTML === upload.innerHTML).toBe(false);
    const rowOf = (icon: HTMLElement) =>
      icon.closest("[role=row]") as HTMLElement;
    expect(within(rowOf(github)).getByRole("link").textContent).toBe("triage");
    expect(within(rowOf(upload)).getByRole("link").textContent).toBe(
      "release-notes",
    );
  });
});

describe("승인 대기 표시", () => {
  const pendingList = listed(skill({ pending_count: 2 }));

  test("관리자에게는 설정 메뉴와 사이드바에 승인 대기 수가 보인다", async () => {
    renderAt("/settings/workspace/achievement-rules", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      ...pendingList,
    });
    const settings = await screen.findByRole("navigation", {
      name: "워크스페이스 설정",
    });
    expect(
      await within(settings).findByRole("link", {
        name: "스킬 라이브러리 승인 대기 2개",
      }),
    ).toBeDefined();
    const rail = screen.getByRole("navigation", { name: "주요 메뉴" });
    expect(
      await within(rail).findByRole("link", {
        name: "워크스페이스 설정 승인 대기 2개",
      }),
    ).toBeDefined();
  });

  test("관리자의 홈 지금 할 일에 승인 대기가 보이고 라이브러리로 간다", async () => {
    renderAt("/", {
      "GET /v1/auth/me": () => json(200, me(undefined, "admin")),
      ...pendingList,
    });
    const todo = await screen.findByRole("region", { name: "지금 할 일" });
    expect(within(todo).getByText("스킬 승인 대기 2개")).toBeDefined();
    expect(
      within(todo)
        .getByRole("link", { name: "스킬 승인 대기 검토" })
        .getAttribute("href"),
    ).toBe("/settings/workspace/skills");
  });

  test("구성원에게는 홈에도 메뉴에도 표시가 없고 목록을 묻지도 않는다", async () => {
    const { api } = renderAt("/", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...pendingList,
    });
    const rail = await screen.findByRole("navigation", { name: "주요 메뉴" });
    await within(rail).findByRole("link", { name: "에이전트" });
    await screen.findByRole("heading", { name: "최근 세션" });
    expect(screen.queryByText(/스킬 승인 대기/)).toBe(null);
    expect(screen.queryByText(/승인 대기 2개/)).toBe(null);
    expect(
      api.calls.some(
        (call) => call.method === "GET" && call.path === "/v1/workspace/skills",
      ),
    ).toBe(false);
  });
});

describe("Git 스킬 상세의 동기화", () => {
  test("멈추면 멈춤으로 보이고, 다시 켜면 마지막 확인이 바뀐다", async () => {
    let git = gitSource();
    const { api } = renderAt("/settings/workspace/skills/triage", {
      "GET /v1/auth/me": () => json(200, me()),
      [SKILLS]: () =>
        json(200, { items: [{ ...gitSkill(), git }] satisfies Skill[] }),
      "PUT /v1/workspace/skills/triage/sync": async (request) => {
        const { enabled } = (await request.json()) as { enabled: boolean };
        git = enabled
          ? {
              ...git,
              sync_enabled: true,
              last_check: check({
                at: "2026-11-21T04:00:00.000Z",
                trigger: {
                  kind: "resume",
                  delivery_id: null,
                  user_id: USER_ID,
                },
                commit: hex("b", 40),
                result: "created",
                version_id: versionId(2),
              }),
            }
          : { ...git, sync_enabled: false };
        return json(200, { name: "triage", git, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const sync = (
      await screen.findByRole("heading", { name: "GitHub 동기화" })
    ).closest("section") as HTMLElement;
    await within(sync).findByText(/push · 바뀐 내용 없음/);
    expect(within(sync).getByText("켜짐")).toBeDefined();

    await user.click(within(sync).getByRole("button", { name: "멈춤" }));
    expect(await within(sync).findByText("동기화를 멈췄습니다.")).toBeDefined();
    await waitFor(() =>
      expect(
        within(sync).getByRole("button", { name: "다시 켬" }),
      ).toBeDefined(),
    );
    expect(
      within(sync).getByText(
        "멈춘 동안 push와 하루 한 번 확인이 이 스킬을 건너뜁니다. 지금 확인은 됩니다.",
      ),
    ).toBeDefined();
    const before = within(sync).getByText(/push · 바뀐 내용 없음/).textContent;

    await user.click(within(sync).getByRole("button", { name: "다시 켬" }));
    await within(sync).findByText(/다시 켬 · 새 버전을 승인 대기로 만듦/);
    expect(
      within(sync).getByText(/다시 켬 · 새 버전을 승인 대기로 만듦/)
        .textContent === before,
    ).toBe(false);
    expect(within(sync).getByText("켜짐")).toBeDefined();
    expect(
      api.calls
        .filter((call) => call.method === "PUT")
        .map((call) => call.body),
    ).toEqual([{ enabled: false }, { enabled: true }]);
  });

  test("다시 켠 확인이 앞 확인 뒤로 밀리면 끝날 때까지 다시 읽는다", async () => {
    let git = gitSource({ sync_enabled: false });
    let readsAfterResume: number | null = null;
    renderAt("/settings/workspace/skills/triage", {
      "GET /v1/auth/me": () => json(200, me()),
      [SKILLS]: () => {
        if (readsAfterResume !== null && ++readsAfterResume >= 2)
          git = {
            ...git,
            last_check: check({
              at: "2026-11-21T04:00:00.000Z",
              trigger: { kind: "resume", delivery_id: null, user_id: USER_ID },
              result: "created",
              version_id: versionId(2),
            }),
          };
        return json(200, { items: [{ ...gitSkill(), git }] satisfies Skill[] });
      },
      // The check resuming starts waits behind a running one.
      "PUT /v1/workspace/skills/triage/sync": () => {
        git = { ...git, sync_enabled: true };
        readsAfterResume = 0;
        return json(200, { name: "triage", git, receipt_id: RECEIPT_ID });
      },
    });
    const user = await setupUser();
    const sync = (
      await screen.findByRole("heading", { name: "GitHub 동기화" })
    ).closest("section") as HTMLElement;
    await user.click(
      await within(sync).findByRole("button", { name: "다시 켬" }),
    );
    expect(
      await within(sync).findByText(
        /다시 켬 · 새 버전을 승인 대기로 만듦/,
        {},
        { timeout: 8000 },
      ),
    ).toBeDefined();
  }, 15000);

  test("webhook을 받지 못하는 설치에는 그 안내가 보인다", async () => {
    renderAt("/settings/workspace/skills/triage", {
      "GET /v1/auth/me": () => json(200, me()),
      ...listed(gitSkill({ webhook: "no_public_url" })),
    });
    expect(
      await screen.findByText(
        /GitHub가 닿는 공개 주소가 없어 push webhook을 받지 못합니다/,
      ),
    ).toBeDefined();
  });

  test("관리자는 워크스페이스에 지정하고 해제한다", async () => {
    // The list answers what the writes left, so a missed refetch shows.
    let attachment: Skill["workspace_attachment"] = {
      version_id: versionId(1),
      follows: false,
      mode: "optional",
    };
    const attachedTo = (next: Skill["workspace_attachment"]) => {
      attachment = next;
      return json(200, {
        name: "release-notes",
        scope: "workspace",
        agent_id: null,
        attachment,
        receipt_id: RECEIPT_ID,
      });
    };
    const { api } = renderAt("/settings/workspace/skills/release-notes", {
      "GET /v1/auth/me": () => json(200, me()),
      [SKILLS]: () =>
        json(200, {
          items: [
            skill({
              versions: [
                version(1),
                version(2),
                version(3, { review: "pending" }),
              ],
              workspace_attachment: attachment,
            }),
          ],
        }),
      "PUT /v1/workspace/skills/release-notes/attachment": () =>
        attachedTo({
          version_id: versionId(1),
          follows: false,
          mode: "required",
        }),
      "DELETE /v1/workspace/skills/release-notes/attachment": () =>
        attachedTo(null),
    });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "워크스페이스 지정" })
    ).closest("section") as HTMLElement;
    const versions = within(section).getByLabelText("버전", {
      selector: "select",
    }) as HTMLSelectElement;
    const mode = within(section).getByLabelText("모드", { selector: "select" });
    // It starts on the attached v1, not the newer approved v2, so changing
    // only the mode keeps the version.
    expect(versions.value).toBe(versionId(1));
    // The pending v3 is offered only to keep the name out.
    await user.selectOptions(mode, "forbidden");
    expect([...versions.options].map((o) => o.value)).toEqual([
      versionId(3),
      versionId(2),
      versionId(1),
    ]);
    await user.selectOptions(mode, "required");
    await user.click(within(section).getByRole("button", { name: "지정" }));
    expect(
      await within(section).findByText("release-notes을(를) 지정했습니다."),
    ).toBeDefined();
    expect(await within(section).findByText(/^필수 · v1/)).toBeDefined();
    await user.click(within(section).getByRole("button", { name: "빼기" }));
    expect(
      await within(section).findByText("release-notes을(를) 뺐습니다."),
    ).toBeDefined();
    expect(
      await within(section).findByText(
        "워크스페이스 범위에는 지정하지 않았습니다.",
      ),
    ).toBeDefined();
    expect(within(section).queryByRole("button", { name: "빼기" })).toBe(null);
    const writes = api.calls.filter((call) => call.method !== "GET");
    expect(writes.map((call) => [call.method, call.body])).toEqual([
      ["PUT", { version_id: versionId(1), mode: "required" }],
      ["DELETE", null],
    ]);
  });

  test("현재 버전을 따라가는 지정은 모드만 바꿔도 계속 따라간다", async () => {
    const { api } = renderAt("/settings/workspace/skills/release-notes", {
      "GET /v1/auth/me": () => json(200, me()),
      ...listed(
        skill({
          workspace_attachment: {
            version_id: versionId(1),
            follows: true,
            mode: "optional",
          },
        }),
      ),
      "PUT /v1/workspace/skills/release-notes/attachment": () =>
        json(200, {
          name: "release-notes",
          scope: "workspace",
          agent_id: null,
          attachment: {
            version_id: versionId(1),
            follows: true,
            mode: "required",
          },
          receipt_id: RECEIPT_ID,
        }),
    });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "워크스페이스 지정" })
    ).closest("section") as HTMLElement;
    const versions = within(section).getByLabelText("버전", {
      selector: "select",
    }) as HTMLSelectElement;
    expect(versions.selectedOptions[0]?.textContent).toBe("현재 버전 따라감");
    await user.selectOptions(
      within(section).getByLabelText("모드", { selector: "select" }),
      "required",
    );
    await user.click(within(section).getByRole("button", { name: "지정" }));
    await within(section).findByText("release-notes을(를) 지정했습니다.");
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      follow: true,
      mode: "required",
    });
  });

  test("다른 스킬로 옮기면 지정 폼이 그 스킬의 것으로 새로 시작한다", async () => {
    const { history } = renderAt("/settings/workspace/skills/release-notes", {
      "GET /v1/auth/me": () => json(200, me()),
      ...listed(
        skill({
          workspace_attachment: {
            version_id: versionId(1),
            follows: false,
            mode: "forbidden",
          },
        }),
        skill({ name: "triage", versions: [version(1, { name: "triage" })] }),
      ),
    });
    await screen.findByRole("heading", { level: 1, name: "release-notes" });
    const section = (
      await screen.findByRole("heading", { name: "워크스페이스 지정" })
    ).closest("section") as HTMLElement;
    expect(
      (
        within(section).getByLabelText("모드", {
          selector: "select",
        }) as HTMLSelectElement
      ).value,
    ).toBe("forbidden");
    history.push("/settings/workspace/skills/triage");
    await screen.findByRole("heading", { level: 1, name: "triage" });
    const next = (
      await screen.findByRole("heading", { name: "워크스페이스 지정" })
    ).closest("section") as HTMLElement;
    expect(
      (
        within(next).getByLabelText("모드", {
          selector: "select",
        }) as HTMLSelectElement
      ).value,
    ).toBe("required");
  });

  test("버전의 파일 보기는 관리자에게만 보인다", async () => {
    renderAt("/settings/workspace/skills/triage", {
      "GET /v1/auth/me": () => json(200, memberMe()),
      ...listed(gitSkill()),
    });
    const table = await screen.findByRole("table", { name: "버전 기록" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).queryByRole("link")).toBe(null);
  });

  test("webhook을 받는 설치에는 그 안내가 없다", async () => {
    renderAt("/settings/workspace/skills/triage", {
      "GET /v1/auth/me": () => json(200, me()),
      ...listed(gitSkill()),
    });
    await screen.findByRole("heading", { name: "GitHub 동기화" });
    expect(screen.queryByText(/push webhook을 받지 못합니다/)).toBe(null);
  });
});

describe("승인 대기 화면", () => {
  const pending = version(2, { review: "pending" });
  const files: SkillVersionFiles = {
    version: pending,
    previous_approved: version(1),
    files: [
      {
        path: "skills/release-notes/SKILL.md",
        executable: false,
        size_bytes: 40,
        sha256: hex("c", 64),
        text: "---\nname: release-notes\n---\nWrite notes.\n",
        change: "unchanged",
        diff: null,
      },
      {
        path: "skills/release-notes/scripts/collect.sh",
        executable: false,
        size_bytes: 60,
        sha256: hex("d", 64),
        text: "#!/bin/sh\ngit log --oneline\ncurl https://example.test/hook\n",
        change: "changed",
        diff: "@@ -1,3 +1,3 @@\n #!/bin/sh\n git log --oneline\n-echo done\n+curl https://example.test/hook\n",
      },
    ],
    removed: [],
  };

  test("scripts/ 파일이 먼저 보이고 그 바뀐 줄이 추가·삭제로 보인다", async () => {
    renderAt(
      `/settings/workspace/skills/release-notes/versions/${pending.id}`,
      {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET /v1/workspace/skills/versions/${pending.id}/files`]: () =>
          json(200, files),
      },
    );
    const list = await screen.findByRole("list", { name: "파일 2개" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first as HTMLElement).getByRole("heading").textContent).toBe(
      "scripts/collect.sh",
    );
    expect(within(second as HTMLElement).getByRole("heading").textContent).toBe(
      "SKILL.md",
    );
    const diff = within(first as HTMLElement).getByRole("figure");
    const added = diff.querySelector('[data-kind="added"]');
    const removed = diff.querySelector('[data-kind="removed"]');
    expect(added?.textContent).toBe("추가: +curl https://example.test/hook\n");
    expect(removed?.textContent).toBe("삭제: -echo done\n");
    expect(within(first as HTMLElement).getByText("바뀜")).toBeDefined();
    // Every file's whole content, not only what changed.
    expect(
      within(second as HTMLElement).getByText(/Write notes\./),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "승인" })).toBeDefined();
    // The capped blocks scroll by keyboard, each named by its file.
    expect(
      screen.getByRole("region", { name: "scripts/collect.sh의 바뀐 줄" })
        .tabIndex,
    ).toBe(0);
    expect(
      screen.getByRole("region", { name: "SKILL.md의 전체 내용" }).tabIndex,
    ).toBe(0);
  });

  test("승인된 버전은 거절로 회수할 수 있고 다시 승인할 버튼은 없다", async () => {
    const approved = version(1);
    renderAt(
      `/settings/workspace/skills/release-notes/versions/${approved.id}`,
      {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET /v1/workspace/skills/versions/${approved.id}/files`]: () =>
          json(200, { ...files, version: approved, previous_approved: null }),
      },
    );
    expect(await screen.findByRole("button", { name: "거절" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "승인" })).toBe(null);
  });

  test("승인하면 승인을 보내고, 다시 읽은 화면에는 승인 버튼 대신 거절만 남는다", async () => {
    let current = pending;
    const { api } = renderAt(
      `/settings/workspace/skills/release-notes/versions/${pending.id}`,
      {
        "GET /v1/auth/me": () => json(200, me()),
        [`GET /v1/workspace/skills/versions/${pending.id}/files`]: () =>
          json(200, { ...files, version: current }),
        [`POST /v1/workspace/skills/versions/${pending.id}/review`]: () => {
          current = { ...pending, review: "approved", reviewed_by: USER_ID };
          return json(200, { version: current, receipt_id: RECEIPT_ID });
        },
      },
    );
    const user = await setupUser();
    await user.click(await screen.findByRole("button", { name: "승인" }));
    expect(await screen.findByText(/을\(를\) 승인했습니다\./)).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "승인" })).toBe(null),
    );
    // The used button is gone; the keyboard lands on the one that stays.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("거절"),
    );
    expect(api.calls.find((call) => call.method === "POST")?.body).toEqual({
      decision: "approved",
    });
  });

  test("주소의 이름이 달라도 그 버전의 스킬 이름으로 보인다", async () => {
    renderAt(`/settings/workspace/skills/triage/versions/${pending.id}`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET /v1/workspace/skills/versions/${pending.id}/files`]: () =>
        json(200, files),
    });
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: /^release-notes v2/,
      }),
    ).toBeDefined();
    expect(screen.queryByRole("link", { name: "triage" })).toBe(null);
  });
});

describe("업로드 파일", () => {
  test("첫 줄이 #!인 파일만 실행 파일로 올린다", async () => {
    const files = await uploadFilesOf([
      new File(["#!/bin/sh\necho hi\n"], "collect.sh"),
      new File(["# Notes\n"], "SKILL.md"),
    ]);
    expect(files.map((file) => [file.path, file.executable])).toEqual([
      ["collect.sh", true],
      ["SKILL.md", undefined],
    ]);
  });
});

describe("에이전트 접근 탭의 스킬 다시 읽기", () => {
  test("고른 버전이 다시 읽은 목록에서 빠지면 보이는 버전을 보낸다", async () => {
    let v2Review: SkillVersion["review"] = "approved";
    const { api, services } = renderAt(`/agents/${AGENT_ID}?tab=access`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [SKILLS]: () =>
        json(200, {
          items: [
            skill({ versions: [version(1), version(2, { review: v2Review })] }),
          ],
        }),
      [`GET /v1/agents/${AGENT_ID}/skills`]: () => json(200, { items: [] }),
      [`PUT /v1/agents/${AGENT_ID}/skills/release-notes`]: () =>
        json(200, {
          name: "release-notes",
          scope: "agent",
          agent_id: AGENT_ID,
          attachment: {
            version_id: versionId(1),
            follows: false,
            mode: "optional",
          },
          receipt_id: RECEIPT_ID,
        }),
    });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "스킬" })
    ).closest("section") as HTMLElement;
    await user.selectOptions(
      await within(section).findByLabelText("스킬", { selector: "select" }),
      "release-notes",
    );
    const versions = within(section).getByLabelText("버전", {
      selector: "select",
    }) as HTMLSelectElement;
    expect(versions.value).toBe(versionId(2));
    v2Review = "rejected";
    await services.queryClient.refetchQueries({ type: "active" });
    await waitFor(() => expect(versions.options).toHaveLength(1));
    expect(versions.value).toBe(versionId(1));
    await user.click(within(section).getByRole("button", { name: "지정" }));
    await within(section).findByText("release-notes을(를) 지정했습니다.");
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      version_id: versionId(1),
      mode: "optional",
    });
  });
});

describe("에이전트 접근 탭의 스킬", () => {
  test("라이브러리를 읽지 못하면 이유와 다시 시도가 보이고, 다시 읽으면 지정 폼이 나온다", async () => {
    let failing = true;
    renderAt(`/agents/${AGENT_ID}?tab=access`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      [SKILLS]: () =>
        failing
          ? apiError(500, "INTERNAL", "boom")
          : json(200, { items: [skill()] }),
      [`GET /v1/agents/${AGENT_ID}/skills`]: () => json(200, { items: [] }),
    });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "스킬" })
    ).closest("section") as HTMLElement;
    const retry = await within(section).findByRole(
      "button",
      { name: "다시 시도" },
      { timeout: 15000 },
    );
    failing = false;
    await user.click(retry);
    expect(
      await within(section).findByLabelText("스킬", { selector: "select" }),
    ).toBeDefined();
  }, 20000);

  test("워크스페이스가 준 스킬은 바꿀 수 없고, 승인된 버전을 골라 이 에이전트에 지정한다", async () => {
    // The attached list answers what the write left.
    let saved = false;
    const { api } = renderAt(`/agents/${AGENT_ID}?tab=access`, {
      ...agentServer().routes,
      "GET /v1/auth/me": () => json(200, me()),
      ...listed(
        skill({
          versions: [version(1), version(2, { review: "pending" })],
        }),
      ),
      [`GET /v1/agents/${AGENT_ID}/skills`]: () =>
        json(200, {
          items: [
            {
              name: "triage",
              scope: "workspace",
              mode: "required",
              follows: false,
              version: version(1, { name: "triage", source: "github" }),
            },
            ...(saved
              ? [
                  {
                    name: "release-notes",
                    scope: "agent" as const,
                    mode: "optional" as const,
                    follows: false,
                    version: version(1),
                  },
                ]
              : []),
          ],
        }),
      [`PUT /v1/agents/${AGENT_ID}/skills/release-notes`]: () => {
        saved = true;
        return json(200, {
          name: "release-notes",
          scope: "agent",
          agent_id: AGENT_ID,
          attachment: {
            version_id: versionId(1),
            follows: false,
            mode: "optional",
          },
          receipt_id: RECEIPT_ID,
        });
      },
    });
    const user = await setupUser();
    const section = (
      await screen.findByRole("heading", { name: "스킬" })
    ).closest("section") as HTMLElement;
    const row = await within(section).findByRole("listitem");
    expect(
      within(row).getByText("워크스페이스가 준 지정이라 바꿀 수 없습니다."),
    ).toBeDefined();
    expect(within(row).queryByRole("button")).toBe(null);
    await user.selectOptions(
      await within(section).findByLabelText("스킬", { selector: "select" }),
      "release-notes",
    );
    const versions = within(section).getByLabelText("버전", {
      selector: "select",
    });
    const values = () =>
      [...(versions as HTMLSelectElement).options].map((o) => o.value);
    // The pending v2 cannot be attached, except to keep the name out.
    expect(values()).toEqual([versionId(1)]);
    const mode = within(section).getByLabelText("모드", { selector: "select" });
    await user.selectOptions(mode, "forbidden");
    expect(values()).toEqual([versionId(2), versionId(1)]);
    await user.selectOptions(versions, versionId(2));
    await user.selectOptions(mode, "optional");
    expect(values()).toEqual([versionId(1)]);
    expect((versions as HTMLSelectElement).value).toBe(versionId(1));
    await user.click(within(section).getByRole("button", { name: "지정" }));
    expect(
      await within(section).findByText("release-notes을(를) 지정했습니다."),
    ).toBeDefined();
    expect(api.calls.find((call) => call.method === "PUT")?.body).toEqual({
      version_id: versionId(1),
      mode: "optional",
    });
    await waitFor(() =>
      expect(within(section).getAllByRole("listitem")).toHaveLength(2),
    );
  });
});
