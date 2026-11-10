import type { JSX } from "react";

import { ConfirmDialog } from "../patterns/confirm-dialog.tsx";
import { DestructiveActionDialog } from "../patterns/destructive-action-dialog.tsx";
import { EmptyState } from "../patterns/empty-state.tsx";
import { ErrorState } from "../patterns/error-state.tsx";
import { Badge } from "../primitives/badge.tsx";
import { Button } from "../primitives/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../primitives/card.tsx";
import { Skeleton } from "../primitives/skeleton.tsx";

/*
 * One render that touches every token and every component state, so a
 * snapshot catches drift. Everything in it is fixed — no clocks, no ids, no randomness — or the
 * snapshot would be noise. The contracts-typed pieces have their own gallery
 * in packages/react/src/components.
 */

function noop(): void {}

export interface GalleryProps {
  /** Rendered open so the snapshot covers dialog layout at every width. */
  readonly openDialog?: "confirm" | "destructive" | undefined;
}

export function Gallery({ openDialog }: GalleryProps = {}): JSX.Element {
  return (
    <div className="gallery">
      <h2>Empty · Error · Skeleton</h2>
      <EmptyState
        title="아직 세션이 없습니다"
        description="에이전트에게 첫 지시를 보내면 여기에 쌓입니다."
        action={<Button type="button">새 세션</Button>}
        secondaryAction={
          <Button type="button" variant="ghost">
            에이전트 보기
          </Button>
        }
      />
      <ErrorState
        guidance="보관된 세션입니다 — 새 세션으로 이어가세요."
        message="session is closed"
        code="SESSION_CLOSED"
        retry={noop}
        evidenceLink={{ href: "/sessions/01J8Z5/journal" }}
      />
      <Skeleton lines={3} />
      <Skeleton shape="circle" />
      <Skeleton shape="block" height="6rem" />

      <h2>Button · Badge · Card</h2>
      <div className="gallery__row">
        <Button type="button">기본</Button>
        <Button type="button" variant="outline">
          테두리
        </Button>
        <Button type="button" variant="secondary">
          보조
        </Button>
        <Button type="button" variant="ghost">
          조용히
        </Button>
        <Button type="button" variant="destructive">
          삭제
        </Button>
        <Button type="button" variant="link">
          링크
        </Button>
        <Button type="button" size="sm">
          작게
        </Button>
        <Button type="button" disabled={true}>
          잠김
        </Button>
        <Button asChild={true} variant="outline">
          <a href="/agents">링크를 버튼처럼</a>
        </Button>
      </div>
      <div className="gallery__row">
        <Badge variant="gray">초안</Badge>
        <Badge variant="blue">진행 중</Badge>
        <Badge variant="green">연결됨</Badge>
        <Badge variant="amber">확인 필요</Badge>
        <Badge variant="red">실패</Badge>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>결제 담당</CardTitle>
          <CardDescription>
            청구서 문의에 답하고 환불을 접수합니다.
          </CardDescription>
          <CardAction>
            <Badge variant="gray">초안</Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          {/* An unbreakable identifier, as in the StatusLabel row above. */}
          <p className="break-all font-mono text-sm">{`agt_${"0".repeat(60)}`}</p>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="button">이어서 설정</Button>
          <Button type="button" variant="ghost">
            나중에
          </Button>
        </CardFooter>
      </Card>

      <h2>Dialog</h2>
      <ConfirmDialog
        open={openDialog === "confirm"}
        onOpenChange={noop}
        title="세션을 일시정지할까요?"
        consequence="실행 중인 턴은 마무리하고, 대기 중인 지시는 그대로 남습니다."
        confirmLabel="일시정지"
        onConfirm={noop}
      />
      <DestructiveActionDialog
        open={openDialog === "destructive"}
        onOpenChange={noop}
        title="에이전트를 보관할까요?"
        consequence="카드와 release가 비활성화되고, 진행 중인 세션은 종료됩니다."
        resourceName="결제 담당"
        confirmLabel="보관"
        onConfirm={noop}
      />
    </div>
  );
}
