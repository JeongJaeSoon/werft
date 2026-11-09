import {
  Field,
  FieldContent,
  FieldLabel,
  Page,
  RadioGroup,
  RadioGroupItem,
  SettingsSection,
  Text,
} from "@werft-ai/ui";
import { type ReactNode, useId } from "react";
import { roleLabel, useMe, useRole } from "../auth/guard.tsx";
import { chooseTheme, type Theme, useTheme } from "../components/theme.ts";
import {
  LOCALE_NAMES,
  LOCALES,
  type Locale,
  type MessageKey,
  useI18n,
} from "../i18n/i18n.tsx";

const THEME_ORDER: readonly Theme[] = ["light", "dark", "system"];

/**
 * How the console looks to the caller. The theme stays in this browser; the
 * language is also saved on the server (useSavedLocale), for Slack.
 */
export function PreferencesScreen() {
  const { t, locale, setLocale } = useI18n();
  const theme = useTheme();
  return (
    <Page title={t("nav.preferences")} description={t("preferences.lead")}>
      <div className="flex flex-col gap-[var(--werft-space-section)]">
        <ChoiceCard
          title={t("common.language")}
          hint={t("preferences.languageHint")}
          value={locale}
          onChange={(value) => setLocale(value as Locale)}
          options={LOCALES.map((value) => ({
            value,
            // Each language in its own words, whatever the page shows now.
            label: <span lang={value}>{LOCALE_NAMES[value]}</span>,
            note: t(`preferences.languageNote.${value}`),
          }))}
        />
        <ChoiceCard
          title={t("shell.theme")}
          hint={t("preferences.themeHint")}
          value={theme}
          onChange={(value) => chooseTheme(value as Theme)}
          options={THEME_ORDER.map((value) => ({
            value,
            label: t(`shell.theme.${value}`),
            note: t(`preferences.themeNote.${value}`),
          }))}
        />
        <AccountCard />
      </div>
    </Page>
  );
}

function ChoiceCard({
  title,
  hint,
  value,
  onChange,
  options,
}: {
  readonly title: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly {
    readonly value: string;
    readonly label: ReactNode;
    readonly note: string;
  }[];
}) {
  const hintId = useId();
  return (
    <SettingsSection title={title} description={hint} descriptionId={hintId}>
      <div className="@container">
        <RadioGroup
          aria-label={title}
          aria-describedby={hintId}
          value={value}
          onValueChange={onChange}
          className="gap-2 @[560px]:grid-cols-3"
        >
          {options.map((option) => (
            <FieldLabel key={option.value}>
              <Field orientation="horizontal" className="items-start">
                <RadioGroupItem value={option.value} />
                <FieldContent className="gap-1">
                  <span>{option.label}</span>
                  <Text as="span" variant="meta">
                    {option.note}
                  </Text>
                </FieldContent>
              </Field>
            </FieldLabel>
          ))}
        </RadioGroup>
      </div>
    </SettingsSection>
  );
}

function AccountCard() {
  const { t } = useI18n();
  const me = useMe();
  const role = useRole();
  const rows: readonly [MessageKey, string | undefined][] = [
    ["preferences.name", me?.user?.display_name],
    ["preferences.email", me?.user?.email],
    ["preferences.role", role ? roleLabel(t, role) : undefined],
    ["preferences.workspace", me?.workspace?.name],
  ];
  return (
    <SettingsSection title={t("preferences.account")} box>
      <dl className="m-0 grid grid-cols-[minmax(0,8.75rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{t(label)}</dt>
            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
              {value ?? t("sessions.none")}
            </dd>
          </div>
        ))}
      </dl>
    </SettingsSection>
  );
}
