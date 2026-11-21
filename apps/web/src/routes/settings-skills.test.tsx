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
  json,
  me,
  memberMe,
  RECEIPT_ID,
  USER_ID,
} from "../test-support/fake-api.ts";
import { appHarness } from "../test-support/render-app.tsx";

const { renderAt, screen, waitFor, within } = await appHarness();

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
                trigger: { kind: "resume", delivery_id: null, user_id: USER_ID },
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
    renderAt(`/settings/workspace/skills/release-notes/versions/${pending.id}`, {
      "GET /v1/auth/me": () => json(200, me()),
      [`GET /v1/workspace/skills/versions/${pending.id}/files`]: () =>
        json(200, files),
    });
    const list = await screen.findByRole("list", { name: "파일 2개" });
    const [first, second] = within(list).getAllByRole("listitem");
    expect(
      within(first as HTMLElement).getByRole("heading").textContent,
    ).toBe("scripts/collect.sh");
    expect(
      within(second as HTMLElement).getByRole("heading").textContent,
    ).toBe("SKILL.md");
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
  });
});

describe("에이전트 접근 탭의 스킬", () => {
  test("워크스페이스가 준 스킬은 바꿀 수 없고, 승인된 버전을 골라 이 에이전트에 지정한다", async () => {
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
          ],
        }),
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
    // The pending v2 cannot be attached.
    expect(
      [...(versions as HTMLSelectElement).options].map((o) => o.value),
    ).toEqual([versionId(1)]);
    await user.click(within(section).getByRole("button", { name: "지정" }));
    expect(
      await within(section).findByText("release-notes을 지정했습니다."),
    ).toBeDefined();
    expect(
      api.calls.find((call) => call.method === "PUT")?.body,
    ).toEqual({ version_id: versionId(1), mode: "optional" });
  });
});
