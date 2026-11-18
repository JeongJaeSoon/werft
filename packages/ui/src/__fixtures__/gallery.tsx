import {
  Archive,
  ArrowUpRight,
  Ellipsis,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type { JSX } from "react";

import { Combobox, type ComboboxOption } from "../patterns/combobox.tsx";
import { ConfirmDialog } from "../patterns/confirm-dialog.tsx";
import { DestructiveActionDialog } from "../patterns/destructive-action-dialog.tsx";
import { EmptyState } from "../patterns/empty-state.tsx";
import { ErrorState } from "../patterns/error-state.tsx";
import { StatCard } from "../patterns/stat-card.tsx";
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
import { Checkbox } from "../primitives/checkbox.tsx";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../primitives/field.tsx";
import { Input } from "../primitives/input.tsx";
import { MenuItem } from "../primitives/menu-item.tsx";
import {
  NativeSelect,
  NativeSelectOption,
} from "../primitives/native-select.tsx";
import { RadioGroup, RadioGroupItem } from "../primitives/radio-group.tsx";
import { RemoveButton } from "../primitives/remove-button.tsx";
import { Skeleton } from "../primitives/skeleton.tsx";
import { Switch } from "../primitives/switch.tsx";
import { Tabs, TabsList, TabsTrigger } from "../primitives/tabs.tsx";
import { Textarea } from "../primitives/textarea.tsx";

/*
 * One render that touches every token and every component state, so a
 * snapshot catches drift. Everything in it is fixed — no clocks, no ids, no randomness — or the
 * snapshot would be noise. The contracts-typed pieces have their own gallery
 * in packages/react/src/components.
 */

function noop(): void {}

const BUTTON_VARIANTS = [
  ["default", "기본"],
  ["outline", "테두리"],
  ["secondary", "보조"],
  ["ghost", "조용히"],
  ["destructive", "삭제"],
  ["danger", "위험"],
  ["link", "링크"],
] as const;

const CHECKBOX_STATES: readonly (readonly [
  string,
  boolean | "indeterminate",
  boolean,
])[] = [
  ["알림 받기", false, false],
  ["기록 보관", true, false],
  ["일부 선택", "indeterminate", false],
  ["관리자만", false, true],
  ["잠긴 선택", true, true],
];

const RADIO_STATES = [
  ["keep", "보관", false],
  ["delete", "삭제", false],
  ["export", "내보내기 (준비 중)", true],
] as const;

const SWITCH_STATES = [
  ["게스트 허용", true, "enabled"],
  ["알림", false, "enabled"],
  ["잠긴 켜짐", true, "disabled"],
  ["잠긴 꺼짐", false, "disabled"],
  ["저장 중", true, "busy"],
] as const;

const COMBOBOX_OPTIONS: readonly ComboboxOption[] = [
  { value: "acme/werft-agent", label: "acme/werft-agent" },
  {
    value: "acme/billing",
    label: "acme/billing",
    description: "청구서와 환불을 처리합니다",
  },
  { value: "acme/archive", label: "acme/archive", disabled: true },
];

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
      <Skeleton lines={3} label="불러오는 중" />
      <Skeleton shape="circle" label="불러오는 중" />
      <Skeleton shape="block" height="6rem" label="불러오는 중" />

      <h2>Button · Badge · Card</h2>
      {/* Each variant at rest, disabled and aria-disabled (busy): one 0.5 fade. */}
      {BUTTON_VARIANTS.map(([variant, label]) => (
        <div key={variant} className="gallery__row">
          <Button type="button" variant={variant}>
            {label}
          </Button>
          <Button type="button" variant={variant} disabled={true}>
            {label} 비활성
          </Button>
          <Button type="button" variant={variant} aria-disabled={true}>
            {label} 저장 중
          </Button>
        </div>
      ))}
      <div className="gallery__row">
        <Button type="button" size="sm">
          작게
        </Button>
        <Button type="button" size="icon" aria-label="더 보기">
          <Ellipsis aria-hidden="true" />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="닫기">
          <X aria-hidden="true" />
        </Button>
        <Button type="button" size="icon" disabled={true} aria-label="잠김">
          <Ellipsis aria-hidden="true" />
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
        <Badge variant="mono">claude-sonnet</Badge>
      </div>

      <h2>Input · Textarea · NativeSelect</h2>
      <FieldGroup>
        <Field>
          <FieldLabel>에이전트 이름</FieldLabel>
          <Input defaultValue="결제 담당" />
        </Field>
        <Field>
          <FieldLabel>브랜치</FieldLabel>
          <Input defaultValue="main main" aria-invalid={true} />
          <FieldError>브랜치 이름에 공백을 쓸 수 없습니다.</FieldError>
        </Field>
        <Field>
          <FieldLabel>저장소</FieldLabel>
          <Input defaultValue="acme/werft-agent" disabled={true} />
        </Field>
        <Field>
          <FieldLabel>지시</FieldLabel>
          <Textarea defaultValue="청구서 문의에 답합니다." />
        </Field>
        <Field>
          <FieldLabel>빈 지시</FieldLabel>
          <Textarea aria-invalid={true} />
        </Field>
        <Field>
          <FieldLabel>잠긴 지시</FieldLabel>
          <Textarea defaultValue="보관된 에이전트입니다." disabled={true} />
        </Field>
        {(["default", "invalid", "disabled"] as const).map((state) => (
          <Field key={state}>
            <FieldLabel>모델 ({state})</FieldLabel>
            <NativeSelect
              defaultValue="sonnet"
              aria-invalid={state === "invalid" || undefined}
              disabled={state === "disabled"}
            >
              <NativeSelectOption value="sonnet">
                claude-sonnet
              </NativeSelectOption>
              <NativeSelectOption value="haiku">
                claude-haiku
              </NativeSelectOption>
            </NativeSelect>
          </Field>
        ))}
      </FieldGroup>

      <h2>Checkbox · Radio · Switch</h2>
      <div className="gallery__row">
        {CHECKBOX_STATES.map(([label, checked, disabled]) => (
          <Field key={label} orientation="horizontal" className="w-fit">
            <Checkbox defaultChecked={checked} disabled={disabled} />
            <FieldLabel>{label}</FieldLabel>
          </Field>
        ))}
      </div>
      <RadioGroup aria-label="세션 기록" defaultValue="keep">
        {RADIO_STATES.map(([value, label, disabled]) => (
          <Field key={value} orientation="horizontal" className="w-fit">
            <RadioGroupItem value={value} disabled={disabled} />
            <FieldLabel>{label}</FieldLabel>
          </Field>
        ))}
      </RadioGroup>
      <div className="gallery__row">
        {SWITCH_STATES.map(([label, checked, state]) => (
          <Field key={label} orientation="horizontal" className="w-fit">
            <Switch
              defaultChecked={checked}
              disabled={state === "disabled"}
              aria-disabled={state === "busy" || undefined}
            />
            <FieldLabel>{label}</FieldLabel>
          </Field>
        ))}
      </div>

      <h2>Tabs</h2>
      {(["default", "line"] as const).map((variant) => (
        <Tabs key={variant} defaultValue="sessions">
          <TabsList variant={variant} aria-label={`탭 (${variant})`}>
            <TabsTrigger value="sessions" count={3}>
              세션
            </TabsTrigger>
            <TabsTrigger value="keys">키</TabsTrigger>
            <TabsTrigger value="audit" disabled={true}>
              감사 기록
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ))}

      <h2>MenuItem · RemoveButton · Combobox</h2>
      <div className="w-56 rounded-card border bg-popover p-1 shadow-pop">
        <MenuItem>
          <Pencil aria-hidden="true" />
          이름 바꾸기
        </MenuItem>
        <MenuItem asChild={true}>
          <a href="/agents/agt_01">
            <ArrowUpRight aria-hidden="true" />
            에이전트 열기
          </a>
        </MenuItem>
        <MenuItem aria-disabled={true}>
          <Archive aria-hidden="true" />
          보관 (권한 없음)
        </MenuItem>
        <MenuItem tone="danger">
          <Trash2 aria-hidden="true" />
          삭제
        </MenuItem>
      </div>
      <ul className="gallery__row m-0 list-none p-0">
        {["김민지", "owner@example.com"].map((name, index) => (
          <li
            key={name}
            className="inline-flex items-center gap-1 rounded-full border bg-surface-sunken py-0.5 ps-2.5 pe-0.5 text-caption"
          >
            {name}
            <RemoveButton aria-label={`${name} 빼기`} disabled={index === 1} />
          </li>
        ))}
      </ul>
      <Field className="max-w-80">
        <FieldLabel>저장소 고르기</FieldLabel>
        <Combobox
          options={COMBOBOX_OPTIONS}
          emptyMessage="맞는 저장소가 없습니다"
          placeholder="acme/…"
        />
      </Field>

      <h2>StatCard</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] gap-3">
        <StatCard
          label="이번 주 세션"
          value="128"
          description="지난주보다 12 많음"
        />
        <StatCard label="연결된 저장소" value="7" outOf="10" />
        <StatCard label="실패한 턴" value="—" muted={true} />
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
        title="세션을 일시 정지할까요?"
        consequence="실행 중인 턴은 마무리하고, 대기 중인 지시는 그대로 남습니다."
        confirmLabel="일시 정지"
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
