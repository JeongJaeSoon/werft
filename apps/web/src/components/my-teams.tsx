import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isApiError } from "@werft-ai/client";
import { useWerft } from "@werft-ai/react";
import {
  Badge,
  EmptyState,
  RowList,
  RowListItem,
  Section,
  Text,
  Link as TextLink,
} from "@werft-ai/ui";
import type { ReactNode } from "react";
import { myTeamsQuery } from "../api/queries.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { LoadFailure } from "./load-failure.tsx";
import { OPENS_ROW, ROW_LINK } from "./row-link.ts";
import { SECTION_BODY } from "./section-body.ts";

/**
 * The teams the viewer is in, each linking to its page: a team's members
 * read it, and only managers change it (D23, 94S-719).
 */
export function MyTeams({
  showEmpty,
  action,
}: {
  /** Off where an empty section would only be noise (home). */
  readonly showEmpty: boolean;
  /** Beside the title, e.g. home's link to the teams list. */
  readonly action?: ReactNode;
}) {
  const { t } = useI18n();
  const { client } = useWerft();
  const teams = useQuery(myTeamsQuery(client));
  if (teams.isPending) return null;
  // An API key session belongs to no team; that is not an error to show.
  if (isApiError(teams.error, "FORBIDDEN")) return null;
  const items = teams.data?.items ?? [];
  if (!teams.error && items.length === 0 && !showEmpty) return null;

  return (
    <Section title={t("teams.mine.title")} actions={action}>
      <div className={SECTION_BODY}>
        {teams.error ? (
          <LoadFailure
            error={teams.error}
            onRetry={() => void teams.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState title={t("teams.mine.empty")} />
        ) : (
          <>
            <Text variant="sub">{t("teams.mine.intro")}</Text>
            <RowList>
              {items.map((team) => (
                <RowListItem key={team.id} className={OPENS_ROW}>
                  <TextLink
                    asChild
                    className={`${ROW_LINK} [overflow-wrap:anywhere]`}
                  >
                    <Link
                      to="/members/teams/$teamId"
                      params={{ teamId: team.id }}
                    >
                      {team.name}
                    </Link>
                  </TextLink>
                  <Badge
                    variant={team.role === "lead" ? "blue" : "gray"}
                    className="ml-auto shrink-0"
                  >
                    {t(`teams.role.${team.role}`)}
                  </Badge>
                </RowListItem>
              ))}
            </RowList>
          </>
        )}
      </div>
    </Section>
  );
}
