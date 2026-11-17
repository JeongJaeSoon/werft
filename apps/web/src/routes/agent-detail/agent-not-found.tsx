import { Link } from "@tanstack/react-router";
import { buttonVariants, Page } from "@werft-ai/ui";
import { useI18n } from "../../i18n/i18n.tsx";

/** Also what a member outside the agent's managing team gets: to them it does not exist. */
export function AgentNotFound() {
  const { t } = useI18n();
  return (
    <Page
      title={t("agent.notFound.title")}
      description={t("agent.notFound.body")}
    >
      <Link
        className={buttonVariants({
          variant: "outline",
          className: "self-start",
        })}
        to="/agents"
      >
        {t("agent.notFound.back")}
      </Link>
    </Page>
  );
}
