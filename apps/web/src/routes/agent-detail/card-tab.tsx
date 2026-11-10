import type { AgentDetail } from "@werft-ai/contracts";
import { Button } from "@werft-ai/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Outcome } from "../../components/outcome.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { CardEditor } from "./card-editor.tsx";
import { EffectiveBehavior } from "./effective-behavior.tsx";
import { CardSummary } from "./overview.tsx";
import { type Placed, PlacedOutcome } from "./placement.tsx";
import { VersionHistory } from "./version-history.tsx";
import { shownVersion } from "./versions.tsx";

export function CardTab({
  detail,
  manages,
  placed,
  onOutcome,
  toRelease,
}: {
  readonly detail: AgentDetail;
  readonly manages: boolean;
  readonly placed: Placed | null;
  readonly onOutcome: (outcome: Outcome | null) => void;
  readonly toRelease: ReactNode;
}) {
  const { t } = useI18n();
  const [profileId, setProfileId] = useState<string>();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  // Closing the editor hands the keyboard back to the button that opened it.
  const editReturns = useRef(false);
  useEffect(() => {
    if (!editing && editReturns.current) {
      editReturns.current = false;
      editButton.current?.focus();
    }
  }, [editing]);
  return (
    <>
      <EffectiveBehavior detail={detail} manages={manages} />
      {/* The panel stays mounted, so an open editor keeps its input across tabs. */}
      {editing && manages ? (
        <CardEditor
          detail={detail}
          profileId={profileId}
          onProfileChange={setProfileId}
          result={<PlacedOutcome placed={placed} at="card" />}
          onOutcome={onOutcome}
          onClose={(cancelled) => {
            setEditing(false);
            editReturns.current = cancelled;
          }}
        />
      ) : (
        <>
          <CardSummary
            detail={detail}
            edit={
              manages ? (
                <Button
                  ref={editButton}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  {t("agent.card.edit")}
                </Button>
              ) : null
            }
          />
          {placed?.at === "card" ? (
            <div className="flex flex-col gap-3">
              <PlacedOutcome placed={placed} at="card" />
              {placed.outcome.kind === "notice" || detail.draft?.failure
                ? toRelease
                : null}
            </div>
          ) : null}
        </>
      )}
      <VersionHistory
        key={`${shownVersion(detail)?.id}:${detail.agent.active_release_id}`}
        detail={detail}
      />
    </>
  );
}
