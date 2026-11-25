import { afterEach, describe, expect, test } from "bun:test";
import {
  flowEn,
  flowJa,
  flowKo,
  formsEn,
  formsJa,
  formsKo,
  sessionsEn,
  sessionsJa,
  sessionsKo,
} from "@werft-ai/react";
import {
  ERROR_GUIDANCE,
  RECEIPT_OPERATION_LABEL,
  STATUS_VOCABULARY,
} from "@werft-ai/react/components";
import { OPERATIONS_MESSAGES } from "../../../../packages/react/src/components/operations/messages.ts";
import {
  achievementRulesEn,
  achievementRulesJa,
  achievementRulesKo,
} from "./achievement-rules.ts";
import {
  achievementsEn,
  achievementsJa,
  achievementsKo,
} from "./achievements.ts";
import { agentAccessEn, agentAccessJa, agentAccessKo } from "./agent-access.ts";
import {
  agentConversationsEn,
  agentConversationsJa,
  agentConversationsKo,
} from "./agent-conversations.ts";
import { agentGitHubEn, agentGitHubJa, agentGitHubKo } from "./agent-github.ts";
import { agentsEn, agentsJa, agentsKo } from "./agents.ts";
import { apiKeysEn, apiKeysJa, apiKeysKo } from "./api-keys.ts";
import { auditLogEn, auditLogJa, auditLogKo } from "./audit-log.ts";
import { authEn, authJa, authKo } from "./auth.ts";
import { commonEn, commonJa, commonKo } from "./common.ts";
import { en, slackEn } from "./en.ts";
import { errorsEn, errorsJa, errorsKo } from "./errors.ts";
import {
  executionLimitsEn,
  executionLimitsJa,
  executionLimitsKo,
} from "./execution-limits.ts";
import { githubEn, githubJa, githubKo } from "./github.ts";
import {
  githubUserLinkEn,
  githubUserLinkJa,
  githubUserLinkKo,
} from "./github-user-link.ts";
import { homeEn, homeJa, homeKo } from "./home.ts";
import {
  errorKey,
  initialLocale,
  LOCALE_NAMES,
  LOCALE_STORAGE_KEY,
  LOCALES,
  translate,
} from "./i18n.tsx";
import { ja, slackJa } from "./ja.ts";
import { ko, slackKo } from "./ko.ts";
import { linkedEn, linkedJa, linkedKo } from "./linked.ts";
import {
  loginMethodsEn,
  loginMethodsJa,
  loginMethodsKo,
} from "./login-methods.ts";
import {
  loginProvidersEn,
  loginProvidersJa,
  loginProvidersKo,
} from "./login-providers.ts";
import { membersEn, membersJa, membersKo } from "./members.ts";
import { modelsEn, modelsJa, modelsKo } from "./models.ts";
import { outputsEn, outputsJa, outputsKo } from "./outputs.ts";
import { preferencesEn, preferencesJa, preferencesKo } from "./preferences.ts";
import { sessionListEn, sessionListJa, sessionListKo } from "./session-list.ts";
import { settingsEn, settingsJa, settingsKo } from "./settings.ts";
import { shellEn, shellJa, shellKo } from "./shell.ts";
import { skillsEn, skillsJa, skillsKo } from "./skills.ts";
import { teamsEn, teamsJa, teamsKo } from "./teams.ts";
import { usageEn, usageJa, usageKo } from "./usage.ts";
import { workspaceEn, workspaceJa, workspaceKo } from "./workspace.ts";
import {
  workspaceMcpEn,
  workspaceMcpJa,
  workspaceMcpKo,
} from "./workspace-mcp.ts";

const catalogs = { ko, ja, en } as const;
const variables = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe("i18n", () => {
  test("session states have the same names on every console surface", () => {
    const states = [
      "queued",
      "running",
      "needs_input",
      "idle",
      "failed",
      "stopped",
    ] as const;
    for (const locale of LOCALES) {
      for (const state of states) {
        const label = catalogs[locale][`sessions.status.${state}`];
        expect(OPERATIONS_MESSAGES[locale].sessionCounts.status(state)).toBe(
          label,
        );
      }
    }
  });

  // A danger zone button shows the verb and is named after its row, so the
  // verb has to appear unbroken in the row title (label in name).
  test("every danger zone button's word is inside its row title", () => {
    const rows = [
      ["teams.delete", "workspace.delete"],
      ["agent.delete", "workspace.delete"],
      ["workspace.tokenDelete", "workspace.delete"],
      ["github.apps.removeRow", "github.apps.remove"],
      ["agentGitHub.disableRow", "agentGitHub.disableConfirm"],
      ["slack.deleteTitle", "workspace.delete"],
      ["slack.revokeTitle", "slack.revoke"],
      ["loginProviders.disableRow", "loginProviders.disable"],
      ["loginProviders.deleteRow", "loginProviders.delete"],
    ] as const;
    for (const locale of LOCALES) {
      for (const [title, button] of rows) {
        const name = catalogs[locale][title].replace("{name}", "werft-review");
        expect(name.toLocaleLowerCase(locale), `${locale} ${title}`).toContain(
          catalogs[locale][button].toLocaleLowerCase(locale),
        );
      }
    }
  });

  test("every model connection credential button's word is inside its accessible name", () => {
    for (const locale of LOCALES) {
      const catalog = catalogs[locale];
      for (const authKind of ["api_key", "bearer"] as const) {
        const kind = catalog[`settings.connections.authKind.${authKind}`];
        const label = catalog["settings.connections.changeCredentialFor"]
          .replace("{id}", "console-key")
          .replace("{kind}", kind);
        expect(label, `${locale} ${authKind}`).toContain(
          catalog["settings.connections.changeCredential"].replace(
            "{kind}",
            kind,
          ),
        );
      }
    }
  });

  // No engine gets the agent's name or description any more (see
  // apps/worker/src/legacy-platform-prompt.ts), and there is no setting that
  // turns it back on.
  test("name and description hints say the model does not see them", () => {
    const platformGuidance = {
      ko: "플랫폼 안내",
      ja: "プラットフォーム案内",
      en: "platform guidance",
    } as const;
    const notSeen = {
      ko: "모델에게는 전해지지 않습니다",
      ja: "モデルには渡されません",
      en: "the model does not see",
    } as const;
    for (const locale of LOCALES) {
      const catalog = catalogs[locale];
      for (const key of [
        "agent.card.identityHint",
        "agents.descriptionHint",
      ] as const) {
        expect(catalog[key]).not.toContain(platformGuidance[locale]);
        expect(catalog[key]).toContain(notSeen[locale]);
      }
      expect(catalog["agent.card.identityHint"]).toContain("CLAUDE.md");
    }
  });

  test("every locale has exactly the Korean keys", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(
        Object.keys(ko).sort(),
      );
    }
  });

  test("the agent connections group and the guidance that names it read the same in each locale", () => {
    // A key-set comparison passes when every locale drops or misspells a
    // value together, so the words themselves are pinned.
    const group = {
      ko: "에이전트 연결",
      en: "Agent connections",
      ja: "エージェント接続",
    };
    const guidance = {
      ko: "설정 > 에이전트 연결 > 모델 연결",
      en: "Settings > Agent connections > Model connections",
      ja: "設定 > エージェント接続 > モデル接続",
    };
    for (const locale of LOCALES) {
      const catalog = catalogs[locale];
      expect(catalog["shell.group.agentConnections"]).toBe(group[locale]);
      expect(catalog["agentCard.connectionNone"]).toContain(guidance[locale]);
    }
  });

  test("the link-required error sends people to an owner, never to a settings page or a password", () => {
    // People do not link a provider to their own account in the console,
    // and the existing account may have no password, or password sign-in
    // may be closed to it.
    const settings = { ko: /설정 >/, en: /Settings >/, ja: /設定 >/ };
    const password = { ko: /비밀번호/, en: /password/i, ja: /パスワード/ };
    for (const locale of LOCALES) {
      const catalog = catalogs[locale];
      const text = catalog["error.LOGIN_LINK_REQUIRED"];
      expect([locale, settings[locale].test(text)]).toEqual([locale, false]);
      expect([locale, password[locale].test(text)]).toEqual([locale, false]);
      // Someone who cannot sign in any way they had is told whom to ask.
      expect(text.toLowerCase()).toContain(catalog["role.owner"].toLowerCase());
    }
  });

  test("menu paths use one separator, '>', in every locale", () => {
    // The public docs write menu paths with ">"; a "›" here reads as a
    // different menu.
    const withChevron = LOCALES.flatMap((locale) =>
      Object.entries(catalogs[locale])
        .filter(([, value]) => String(value).includes("›"))
        .map(([key]) => `${locale}:${key}`),
    );
    expect(withChevron).toEqual([]);
  });

  test("Korean copy spells pause one way, 일시 정지, as the glossary does", () => {
    const statusLabels = Object.values(STATUS_VOCABULARY).flatMap((axis) =>
      Object.values(axis).map((state) => state.label),
    );
    const korean = [
      ...Object.values(ko),
      ...statusLabels,
      ...Object.values(RECEIPT_OPERATION_LABEL),
      ...Object.values(ERROR_GUIDANCE),
    ].map(String);
    // 일시중지 and 일시 중지 are other words for the same pause; only one
    // plain space between 일시 and 정지 is the glossary's.
    const otherSpelling = /일시(?! 정지)\s*[정중]지/;
    expect(
      ["일시정지", "일시중지", "일시 중지", "일시  정지", "일시 정지"].filter(
        (text) => !otherSpelling.test(text),
      ),
    ).toEqual([]);
    expect(
      ["일시 정지", "일시 정지됨", "일시적", "정지"].filter((text) =>
        otherSpelling.test(text),
      ),
    ).toEqual([]);
    expect(korean.filter((text) => otherSpelling.test(text))).toEqual([]);
  });

  test("no message sends people to the Release tab to make or turn on a release", () => {
    // A save makes the release now; the tab only lists them and rolls back.
    const pointsAtTab: Record<(typeof LOCALES)[number], RegExp> = {
      ko: /릴리스 탭에서/,
      en: /(on|in) the Release tab/i,
      ja: /リリースタブ|「リリース」タブ/,
    };
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(catalogs[locale])) {
        if (key === "agent.tabs.toRelease") continue;
        expect([locale, key, pointsAtTab[locale].test(text)]).toEqual([
          locale,
          key,
          false,
        ]);
      }
    }
  });

  test("release changes are written in every locale", () => {
    const keys = [
      "agent.releases.changesFirst",
      "agent.releases.changesNone",
      "agent.releases.changesSummary",
      "agent.releases.changesTitle",
      "agent.releases.changesAgainst",
      "agent.releases.byUnknown",
      ...["repositories", "model", "tools", "settings", "secrets"].map(
        (area) => `agent.releases.area.${area}`,
      ),
      "agent.releases.absent.workspaceRepositories",
      "agent.releases.changed",
      "agent.releases.secretsHidden",
    ];
    for (const locale of LOCALES) {
      const catalog = catalogs[locale] as Record<string, string | undefined>;
      for (const key of keys)
        expect([key, catalog[key]?.trim()]).toEqual([
          key,
          expect.stringMatching(/./),
        ]);
    }
  });

  test("every message is written and keeps the Korean variables", () => {
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(ko)) {
        const translated = catalogs[locale][key as keyof typeof ko];
        expect(translated.trim()).not.toBe("");
        expect(variables(translated)).toEqual(variables(text));
      }
    }
  });

  test("each language is named in its own words", () => {
    expect(LOCALE_NAMES).toEqual({ ko: "한국어", ja: "日本語", en: "English" });
  });

  // A key in two area files would silently win by spread order.
  test("no key is defined in two area files", () => {
    const count = (areas: object[]) =>
      areas.reduce((sum, area) => sum + Object.keys(area).length, 0);
    const areas = {
      ko: [
        slackKo,
        commonKo,
        shellKo,
        authKo,
        homeKo,
        membersKo,
        teamsKo,
        agentsKo,
        modelsKo,
        sessionsKo,
        sessionListKo,
        flowKo,
        linkedKo,
        loginMethodsKo,
        loginProvidersKo,
        executionLimitsKo,
        auditLogKo,
        outputsKo,
        apiKeysKo,
        workspaceKo,
        workspaceMcpKo,
        skillsKo,
        githubKo,
        githubUserLinkKo,
        agentGitHubKo,
        agentAccessKo,
        agentConversationsKo,
        usageKo,
        achievementsKo,
        achievementRulesKo,
        preferencesKo,
        errorsKo,
        formsKo,
        settingsKo,
      ],
      ja: [
        slackJa,
        commonJa,
        shellJa,
        authJa,
        homeJa,
        membersJa,
        teamsJa,
        agentsJa,
        modelsJa,
        sessionsJa,
        sessionListJa,
        flowJa,
        linkedJa,
        loginMethodsJa,
        loginProvidersJa,
        executionLimitsJa,
        auditLogJa,
        outputsJa,
        apiKeysJa,
        workspaceJa,
        workspaceMcpJa,
        skillsJa,
        githubJa,
        githubUserLinkJa,
        agentGitHubJa,
        agentAccessJa,
        agentConversationsJa,
        usageJa,
        achievementsJa,
        achievementRulesJa,
        preferencesJa,
        errorsJa,
        formsJa,
        settingsJa,
      ],
      en: [
        slackEn,
        commonEn,
        shellEn,
        authEn,
        homeEn,
        membersEn,
        teamsEn,
        agentsEn,
        modelsEn,
        sessionsEn,
        sessionListEn,
        flowEn,
        linkedEn,
        loginMethodsEn,
        loginProvidersEn,
        executionLimitsEn,
        auditLogEn,
        outputsEn,
        apiKeysEn,
        workspaceEn,
        workspaceMcpEn,
        skillsEn,
        githubEn,
        githubUserLinkEn,
        agentGitHubEn,
        agentAccessEn,
        agentConversationsEn,
        usageEn,
        achievementsEn,
        achievementRulesEn,
        preferencesEn,
        errorsEn,
        formsEn,
        settingsEn,
      ],
    };
    for (const locale of LOCALES) {
      expect(count(areas[locale])).toBe(Object.keys(catalogs[locale]).length);
    }
  });

  test("keys follow <area>.<element>", () => {
    for (const key of Object.keys(ko)) {
      expect(key).toMatch(/^[a-z][A-Za-z]*(\.[a-zA-Z_][A-Za-z_]*)+$/);
    }
  });

  test("variables are filled; an unknown one is left as written", () => {
    expect(translate("ko", "bootstrap.passwordHint", { min: 12 })).toBe(
      "12자 이상",
    );
    expect(translate("ja", "bootstrap.passwordHint", { min: 12 })).toBe(
      "12文字以上",
    );
    expect(translate("en", "bootstrap.passwordHint")).toBe(
      "At least {min} characters",
    );
  });

  test("an error code without its own words falls back to the neutral one", () => {
    expect(errorKey("RATE_LIMITED")).toBe("error.RATE_LIMITED");
    expect(errorKey("SESSION_CLOSED")).toBe("error.UNKNOWN");
    expect(errorKey("__proto__")).toBe("error.UNKNOWN");
  });

  describe("initial locale", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const storage = new Map<string, string>();
    const setEnvironment = (
      languages: readonly string[],
      stored?: string,
      storageThrows = false,
    ) => {
      storage.clear();
      if (stored) storage.set(LOCALE_STORAGE_KEY, stored);
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { language: languages[0] ?? "", languages },
      });
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => {
            if (storageThrows) throw new Error("SecurityError");
            return storage.get(key) ?? null;
          },
        },
      });
    };
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "navigator", original);
      Reflect.deleteProperty(globalThis, "localStorage");
    });

    test("the first browser language the console speaks", () => {
      setEnvironment(["ko-KR"]);
      expect(initialLocale()).toBe("ko");
      setEnvironment(["ja-JP"]);
      expect(initialLocale()).toBe("ja");
      setEnvironment(["en-US"]);
      expect(initialLocale()).toBe("en");
      setEnvironment(["fr-FR", "ja", "en-US"]);
      expect(initialLocale()).toBe("ja");
    });

    test("English when no browser language is spoken here", () => {
      setEnvironment(["fr-FR", "de"]);
      expect(initialLocale()).toBe("en");
      setEnvironment([]);
      expect(initialLocale()).toBe("en");
    });

    test("a stored choice wins over the browser", () => {
      setEnvironment(["en-US"], "ja");
      expect(initialLocale()).toBe("ja");
      setEnvironment(["ko-KR"], "fr");
      expect(initialLocale()).toBe("ko");
    });

    test("blocked storage still falls back to the browser", () => {
      setEnvironment(["ja-JP"], "ko", true);
      expect(initialLocale()).toBe("ja");
    });
  });
});

describe("no profile in copy", () => {
  // No screen names a profile.
  const PROFILE = /프로필|profile|プロファイル/i;
  test.each(LOCALES.map((locale) => [locale] as const))(
    "%s copy never names a profile",
    (locale) => {
      const hits = Object.entries(catalogs[locale]).filter(([, text]) =>
        PROFILE.test(String(text)),
      );
      expect(hits.map(([key]) => key)).toEqual([]);
    },
  );

  // Merging is set per workspace, not on the agent; the hint must say where
  // and must not claim there is no merge at all.
  test.each([
    ["ko", agentGitHubKo, /연동 > GitHub/, /머지는 이 에이전트 설정에 없고/],
    ["en", agentGitHubEn, /Integrations > GitHub/, /allows it/],
    ["ja", agentGitHubJa, /連携 > GitHub/, /マージを許可したときだけ/],
  ] as const)(
    "%s agent GitHub hint points merging at the workspace setting",
    (_locale, table, where, allowed) => {
      const hint = table["agentGitHub.permissionsHint"];
      expect(hint).toMatch(where);
      expect(hint).toMatch(allowed);
      expect(hint).not.toMatch(
        /merge 권한은 없습니다|no merge permission|merge の権限はありません/i,
      );
    },
  );

  // The three hints name the workspace menu at one depth in every locale; en
  // once ran the full path while ko and ja ran the short one.
  test.each([
    ["ko", agentGitHubKo, "연동 > GitHub", "설정 >"],
    ["en", agentGitHubEn, "Integrations > GitHub", "Settings >"],
    ["ja", agentGitHubJa, "連携 > GitHub", "設定 >"],
  ] as const)(
    "%s agent GitHub hints name the workspace menu at the same depth",
    (_locale, table, where, fullPathStart) => {
      for (const key of [
        "agentGitHub.permissionsHint",
        "agentGitHub.featureReason.over_workspace_ceiling",
        "agentGitHub.ceilingNote",
      ] as const) {
        expect(table[key]).toContain(where);
        expect(table[key]).not.toContain(fullPathStart);
      }
    },
  );
});
