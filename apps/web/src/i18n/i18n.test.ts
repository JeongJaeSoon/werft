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
import { AGENT_MAP_MESSAGES } from "../../../../packages/react/src/components/agent-map/messages.ts";
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
import { agentGitHubEn, agentGitHubJa, agentGitHubKo } from "./agent-github.ts";
import { agentsEn, agentsJa, agentsKo } from "./agents.ts";
import { apiKeysEn, apiKeysJa, apiKeysKo } from "./api-keys.ts";
import { authEn, authJa, authKo } from "./auth.ts";
import { commonEn, commonJa, commonKo } from "./common.ts";
import { en, slackEn } from "./en.ts";
import { errorsEn, errorsJa, errorsKo } from "./errors.ts";
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
import { membersEn, membersJa, membersKo } from "./members.ts";
import { modelsEn, modelsJa, modelsKo } from "./models.ts";
import { outputsEn, outputsJa, outputsKo } from "./outputs.ts";
import { preferencesEn, preferencesJa, preferencesKo } from "./preferences.ts";
import { profilesEn, profilesJa, profilesKo } from "./profiles.ts";
import { sessionListEn, sessionListJa, sessionListKo } from "./session-list.ts";
import { settingsEn, settingsJa, settingsKo } from "./settings.ts";
import { shellEn, shellJa, shellKo } from "./shell.ts";
import { teamsEn, teamsJa, teamsKo } from "./teams.ts";
import { usageEn, usageJa, usageKo } from "./usage.ts";
import { workspaceEn, workspaceJa, workspaceKo } from "./workspace.ts";

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
        expect(AGENT_MAP_MESSAGES[locale].status(state)).toBe(label);
        expect(OPERATIONS_MESSAGES[locale].sessionCounts.status(state)).toBe(
          label,
        );
      }
      expect(AGENT_MAP_MESSAGES[locale].lane("queued")).toBe(
        catalogs[locale]["sessions.status.queued"],
      );
      expect(AGENT_MAP_MESSAGES[locale].run("wait")).toBe(
        catalogs[locale]["sessions.status.needs_input"],
      );
      expect(AGENT_MAP_MESSAGES[locale].run("idle")).not.toBe(
        AGENT_MAP_MESSAGES[locale].run("wait"),
      );
      expect(catalogs[locale]["workspace.danger"]).toBe(
        catalogs[locale]["slack.danger"],
      );
      expect(catalogs[locale]["profiles.title"]).toBe(
        catalogs[locale]["nav.profiles"],
      );
    }
  });

  // The platform paragraph is off by default, so a hint without the condition
  // is wrong on a default installation.
  test("name and description hints say the model reads them only with platform guidance on", () => {
    const condition = {
      ko: "플랫폼 안내",
      ja: "プラットフォーム案内",
      en: "platform guidance",
    } as const;
    for (const locale of LOCALES) {
      const catalog = catalogs[locale];
      expect(catalog["agent.card.identityHint"]).toContain(condition[locale]);
      expect(catalog["agents.descriptionHint"]).toContain(condition[locale]);
      expect(catalog["agent.card.identityHint"]).toContain(
        catalog["agentCard.agentInstructions"],
      );
    }
  });

  test("every locale has exactly the Korean keys", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(
        Object.keys(ko).sort(),
      );
    }
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

  test("release changes and the session's release are written in every locale", () => {
    const keys = [
      "agent.releases.changesFirst",
      "agent.releases.changesNone",
      "agent.releases.changesSummary",
      "agent.releases.changesTitle",
      "agent.releases.changesAgainst",
      "agent.releases.byUnknown",
      ...[
        "repositories",
        "model",
        "tools",
        "prompt",
        "settings",
        "secrets",
      ].map((area) => `agent.releases.area.${area}`),
      "agent.releases.field.credentials",
      "agent.releases.absent.profileRepositories",
      "agent.releases.changed",
      "agent.releases.secretsHidden",
      "session.release.title",
      "session.release.active",
      "session.release.notActive",
      "session.release.notActiveBody",
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
        profilesKo,
        sessionsKo,
        sessionListKo,
        flowKo,
        linkedKo,
        outputsKo,
        apiKeysKo,
        workspaceKo,
        githubKo,
        githubUserLinkKo,
        agentGitHubKo,
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
        profilesJa,
        sessionsJa,
        sessionListJa,
        flowJa,
        linkedJa,
        outputsJa,
        apiKeysJa,
        workspaceJa,
        githubJa,
        githubUserLinkJa,
        agentGitHubJa,
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
        profilesEn,
        sessionsEn,
        sessionListEn,
        flowEn,
        linkedEn,
        outputsEn,
        apiKeysEn,
        workspaceEn,
        githubEn,
        githubUserLinkEn,
        agentGitHubEn,
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
