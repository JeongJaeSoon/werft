import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Alert,
  AlertDescription,
  Avatar,
  avatarInitials,
  avatarTone,
  Badge,
  Button,
  buttonVariants,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Heading,
  Input,
  NativeSelect,
  NativeSelectOption,
  Page,
  Section,
  Text,
  Textarea,
} from "@werft-ai/ui";
import { ArrowLeft } from "lucide-react";
import { useId } from "react";
import { expect } from "storybook/test";

import {
  AgentPage,
  CardSummary,
  type DetailFixture,
  INHERIT,
  RELEASED,
} from "./agent-detail-parts.tsx";
import { MOBILE, type Role, ScreenShell } from "./screen-kit.tsx";

/*
 * apps/web components/managing-team.tsx (the admins tab's first section),
 * routes/agent-detail.tsx (the read-only notice and the outsider page) and
 * components/new-agent-flow.tsx (the name step's managing team). Words are
 * apps/web's Korean catalog.
 */

const SECTION_BODY = "flex flex-col gap-[var(--werft-space-block)]";
const TITLE = "font-semibold text-foreground text-title leading-7";

const TEAM_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const ASSIGNED: DetailFixture = {
  ...RELEASED,
  agent: {
    ...RELEASED.agent,
    managing_team_id: TEAM_ID,
    managing_team_name: "재무",
  },
};
const TEAMS = ["재무", "영업", "고객지원"] as const;

type View =
  | "assigned"
  | "no-lead"
  | "team-member"
  | "outsider"
  | "wizard"
  | "wizard-required"
  | "wizard-no-team";

function TeamName({ detail }: { readonly detail: DetailFixture }) {
  return (
    <Text as="span" className="[overflow-wrap:anywhere]">
      {detail.agent.managing_team_name}
    </Text>
  );
}

/** components/managing-team.tsx ManagingTeam. */
function ManagingTeamSection({
  detail,
  manages,
  noLead = false,
}: {
  readonly detail: DetailFixture;
  readonly manages: boolean;
  readonly noLead?: boolean;
}) {
  const selectId = useId();
  const others = TEAMS.filter(
    (team) => team !== detail.agent.managing_team_name,
  );
  return (
    <Section
      title="담당 팀"
      description="이 팀의 팀 관리자는 이 에이전트를 관리하고, 구성원은 설정을 보고 사용합니다."
    >
      <div className={SECTION_BODY}>
        <div className="flex flex-wrap items-center gap-2">
          <TeamName detail={detail} />
        </div>
        {noLead ? (
          <Alert variant="amber">
            <AlertDescription>
              이 담당 팀에는 팀 관리자가 없습니다.
            </AlertDescription>
          </Alert>
        ) : null}
        {manages ? (
          <div className="flex flex-col gap-3">
            <form className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={selectId}>
                담당 팀으로 정할 팀
              </label>
              <NativeSelect
                id={selectId}
                className="w-auto max-w-full"
                defaultValue=""
              >
                <NativeSelectOption value="" disabled>
                  팀 고르기
                </NativeSelectOption>
                {others.map((team) => (
                  <NativeSelectOption key={team} value={team}>
                    {team}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button type="submit" variant="outline" disabled>
                바꾸기
              </Button>
            </form>
            <Text variant="meta">
              담당 팀을 정하면 팀 밖 사람은 이 에이전트의 세션 가운데 자기
              세션과 공유받은 것만 봅니다(워크스페이스 설정).
            </Text>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** components/agent-admins.tsx, below the managing team; its list only. */
function AdminsSection() {
  return (
    <Section title="관리자">
      <Text>Owner · owner@example.com</Text>
    </Section>
  );
}

/** routes/agent-detail.tsx OutsideAgent: what a 403 leaves an outsider. */
function OutsideAgent({ detail }: { readonly detail: DetailFixture }) {
  const { agent } = detail;
  return (
    <Page
      title={
        <Text
          as="span"
          className={cn("flex min-w-0 items-center gap-3", TITLE)}
        >
          <Avatar
            size="lg"
            shape="square"
            tone={avatarTone(agent.name)}
            initials={avatarInitials(agent.name)}
          />
          <Text
            as="span"
            className={cn("min-w-0 [overflow-wrap:anywhere]", TITLE)}
          >
            {agent.name}
          </Text>
        </Text>
      }
      titleAside={<Badge variant="green">릴리스</Badge>}
      description={
        agent.description ? (
          <Text as="span" className={cn(INHERIT, "[overflow-wrap:anywhere]")}>
            {agent.description}
          </Text>
        ) : undefined
      }
      actions={
        <a href="#agents" className={buttonVariants({ variant: "outline" })}>
          <ArrowLeft strokeWidth={1.5} aria-hidden="true" />
          에이전트 목록
        </a>
      }
    >
      <Section title="담당 팀">
        <div className={SECTION_BODY}>
          <div>
            <TeamName detail={detail} />
          </div>
          <Alert>
            <AlertDescription>
              이 에이전트의 설정은 담당 팀 구성원과 관리자만 봅니다.
            </AlertDescription>
          </Alert>
        </div>
      </Section>
    </Page>
  );
}

/** components/new-agent-flow.tsx NameStep. */
function NameStep({ view }: { readonly view: View }) {
  const teamId = useId();
  const required = view === "wizard-required";
  return (
    <Page title="새 에이전트">
      {view === "wizard-no-team" ? (
        <section className="flex max-w-2xl flex-col gap-6">
          <Heading>이름</Heading>
          <Alert variant="amber">
            <AlertDescription>
              속한 팀이 없어 에이전트를 만들 수 없습니다. 워크스페이스
              관리자에게 팀에 넣어 달라고 요청하세요.
            </AlertDescription>
          </Alert>
        </section>
      ) : (
        <form className="flex max-w-2xl flex-col gap-6" noValidate>
          <Heading>이름</Heading>
          <Field>
            <FieldLabel>이름</FieldLabel>
            <Input defaultValue="결제 담당" />
          </Field>
          <Field>
            <FieldLabel>식별자</FieldLabel>
            <Input defaultValue="billing" />
          </Field>
          <Field>
            <FieldLabel>설명 (선택)</FieldLabel>
            <Textarea rows={3} defaultValue="결제 문의 담당" />
          </Field>
          <Field>
            <FieldLabel htmlFor={teamId}>담당 팀</FieldLabel>
            <NativeSelect
              id={teamId}
              required
              aria-invalid={required}
              defaultValue={required ? "" : "재무"}
            >
              <NativeSelectOption value="" disabled>
                팀 고르기
              </NativeSelectOption>
              {TEAMS.map((team) => (
                <NativeSelectOption key={team} value={team}>
                  {team}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              이 팀의 팀 관리자가 에이전트를 관리하고, 구성원은 설정을 보고
              사용합니다.
            </FieldDescription>
            <FieldError>{required ? "담당 팀을 고르세요." : null}</FieldError>
          </Field>
          <div>
            <Button type="submit">다음</Button>
          </div>
        </form>
      )}
    </Page>
  );
}

function ManagingTeamScreen({ view }: { readonly view: View }) {
  const role: Role =
    view === "team-member" || view === "outsider" || view.startsWith("wizard")
      ? "member"
      : "owner";
  if (view.startsWith("wizard"))
    return (
      <ScreenShell
        current="agents"
        crumb={["에이전트", "새 에이전트"]}
        role={role}
      >
        <NameStep view={view} />
      </ScreenShell>
    );
  const detail = ASSIGNED;
  return (
    <ScreenShell
      current="agents"
      crumb={["에이전트", detail.agent.name]}
      role={role}
    >
      {view === "outsider" ? (
        <OutsideAgent detail={detail} />
      ) : view === "team-member" ? (
        <AgentPage
          detail={detail}
          tab="card"
          notice={
            <Alert>
              <AlertDescription>
                담당 팀 구성원은 이 에이전트의 설정을 볼 수만 있습니다. 바꾸는
                것은 팀 관리자와 에이전트 관리자입니다.
              </AlertDescription>
            </Alert>
          }
        >
          <CardSummary detail={detail} manages={false} />
        </AgentPage>
      ) : (
        <AgentPage detail={detail} tab="admins">
          <ManagingTeamSection
            detail={detail}
            manages={true}
            noLead={view === "no-lead"}
          />
          <AdminsSection />
        </AgentPage>
      )}
    </ScreenShell>
  );
}

const meta = {
  title: "Screens/Agent managing team",
  component: ManagingTeamScreen,
  parameters: { layout: "fullscreen" },
  args: { view: "assigned" },
  argTypes: {
    view: {
      control: "inline-radio",
      options: [
        "assigned",
        "no-lead",
        "team-member",
        "outsider",
        "wizard",
        "wizard-required",
        "wizard-no-team",
      ],
    },
  },
} satisfies Meta<typeof ManagingTeamScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Assigned: Story = {
  name: "Admins tab (managing team set)",
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(
        "이 팀의 팀 관리자는 이 에이전트를 관리하고, 구성원은 설정을 보고 사용합니다.",
      ),
    ).toBeVisible();
    const select = canvas.getByLabelText("담당 팀으로 정할 팀");
    await expect(
      [...(select as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(["팀 고르기", "영업", "고객지원"]);
  },
};
export const NoLead: Story = {
  name: "Admins tab (team without a lead)",
  args: { view: "no-lead" },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText("이 담당 팀에는 팀 관리자가 없습니다."),
    ).toBeVisible();
  },
};
export const TeamMember: Story = {
  name: "Settings, read only (managing team member)",
  args: { view: "team-member" },
  play: async ({ canvas }) => {
    await expect(
      canvas.queryByRole("button", { name: "상세 설정 편집" }),
    ).toBeNull();
  },
};
export const Outsider: Story = {
  name: "Outside member",
  args: { view: "outsider" },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole("tab")).toBeNull();
    await expect(
      canvas.getByText(
        "이 에이전트의 설정은 담당 팀 구성원과 관리자만 봅니다.",
      ),
    ).toBeVisible();
  },
};
export const Wizard: Story = {
  name: "New agent, managing team",
  args: { view: "wizard" },
};
export const WizardRequired: Story = {
  name: "New agent, managing team missing",
  args: { view: "wizard-required" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("담당 팀을 고르세요.")).toBeVisible();
  },
};
export const WizardNoTeam: Story = {
  name: "New agent, member in no team",
  args: { view: "wizard-no-team" },
  play: async ({ canvas }) => {
    await expect(canvas.queryByLabelText("이름")).toBeNull();
  },
};
export const OutsiderMobileDark: Story = {
  name: "Outside member (390px, dark)",
  args: { view: "outsider" },
  globals: { ...MOBILE, theme: "dark" },
};
export const WizardMobile: Story = {
  name: "New agent, managing team (390px)",
  args: { view: "wizard" },
  globals: MOBILE,
};
