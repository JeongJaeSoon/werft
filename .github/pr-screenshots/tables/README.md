# PR #1752 표 통일 · 변경 전후

PC는 1280px 라이트, 모바일은 390px 라이트입니다. 모바일 "변경 후"의 두 번째 이미지는 표를 오른쪽 끝까지 가로 스크롤한 모습입니다. 다크 모드는 화면마다 접힘 칸에 있습니다. 데모 모드와 목 데이터로 찍었습니다.

## 에이전트 목록 (/agents)

카드 뷰와 보기 전환을 지우고 표만 남겼습니다. 열: 이름(로봇 아이콘) · 엔진(Claude 주황, Codex 청록) · 상태(색 점) · 연결 채널(Slack·GitHub 로고) · 실행 중인 세션 수.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="agents-cards-before-1280-light.png" width="420"><br>카드 뷰<br><img src="agents-table-before-1280-light.png" width="420"><br>표 뷰 | <img src="agents-table-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="agents-cards-before-390-light.png" width="200"> <img src="agents-table-before-390-light.png" width="200"> | <img src="agents-table-after-390-light.png" width="200"> <img src="agents-table-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="agents-table-before-1280-dark.png" width="420"> | <img src="agents-table-after-1280-dark.png" width="420"> |

</details>

## 세션 목록 (/sessions)

열: 제목 · 에이전트 · 채널(Web·Slack·API 아이콘) · 상태(색 배지) · 시작 시각(절대 시각) · 소요 시간(끝난 턴 실행 시간의 합, 일하는 중이면 "진행 중"). 위쪽 상태 필터는 #1750의 새 세그먼트입니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="sessions-before-1280-light.png" width="420"> | <img src="sessions-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="sessions-before-390-light.png" width="200"> | <img src="sessions-after-390-light.png" width="200"> <img src="sessions-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="sessions-before-1280-dark.png" width="420"> | <img src="sessions-after-1280-dark.png" width="420"> |

</details>

## 구성원 (/members)

열: 이름(이니셜 아바타) · 이메일 · 역할(소유자 보라, 관리자 파랑, 구성원 회색) · 상태(● 활성 / ● 정지됨) · ⋯ 메뉴(편집·비활성화·다시 활성화).

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="members-before-1280-light.png" width="420"> | <img src="members-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="members-before-390-light.png" width="200"> | <img src="members-after-390-light.png" width="200"> <img src="members-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="members-before-1280-dark.png" width="420"> | <img src="members-after-1280-dark.png" width="420"> |

</details>

## 팀 (/members/teams)

같은 평평한 표와 역할 배지, 추가 시각은 절대 시각입니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="teams-before-1280-light.png" width="420"> | <img src="teams-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="teams-before-390-light.png" width="200"> | <img src="teams-after-390-light.png" width="200"> <img src="teams-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="teams-before-1280-dark.png" width="420"> | <img src="teams-after-1280-dark.png" width="420"> |

</details>

## 팀 상세

구성원 표와 같은 모양입니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="team-detail-before-1280-light.png" width="420"> | <img src="team-detail-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="team-detail-before-390-light.png" width="200"> | <img src="team-detail-after-390-light.png" width="200"> <img src="team-detail-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="team-detail-before-1280-dark.png" width="420"> | <img src="team-detail-after-1280-dark.png" width="420"> |

</details>

## 운영 › 사용량

카드 틀이 사라졌고 좁은 폭에서 열을 숨기지 않습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="ops-usage-before-1280-light.png" width="420"> | <img src="ops-usage-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="ops-usage-before-390-light.png" width="200"> | <img src="ops-usage-after-390-light.png" width="200"> <img src="ops-usage-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="ops-usage-before-1280-dark.png" width="420"> | <img src="ops-usage-after-1280-dark.png" width="420"> |

</details>

## 운영 › 도구

390px에서 긴 도구 이름이 페이지를 밀어내던 문제(579px)가 사라지고, 표만 스크롤합니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="ops-tools-before-1280-light.png" width="420"> | <img src="ops-tools-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="ops-tools-before-390-light.png" width="200"> | <img src="ops-tools-after-390-light.png" width="200"> <img src="ops-tools-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="ops-tools-before-1280-dark.png" width="420"> | <img src="ops-tools-after-1280-dark.png" width="420"> |

</details>

## 운영 › 한도

한도 표의 카드 틀이 사라졌습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="ops-limits-before-1280-light.png" width="420"> | <img src="ops-limits-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="ops-limits-before-390-light.png" width="200"> | <img src="ops-limits-after-390-light.png" width="200"> <img src="ops-limits-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="ops-limits-before-1280-dark.png" width="420"> | <img src="ops-limits-after-1280-dark.png" width="420"> |

</details>

## 에이전트 상세 › 개요

최근 세션 표: 틀 없음, 다섯 열 유지, 절대 시각.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="agent-overview-before-1280-light.png" width="420"> | <img src="agent-overview-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="agent-overview-before-390-light.png" width="200"> | <img src="agent-overview-after-390-light.png" width="200"> <img src="agent-overview-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="agent-overview-before-1280-dark.png" width="420"> | <img src="agent-overview-after-1280-dark.png" width="420"> |

</details>

## 에이전트 상세 › 릴리스

좁은 폭 전용 줄을 지우고 표를 가로 스크롤합니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="agent-release-before-1280-light.png" width="420"> | <img src="agent-release-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="agent-release-before-390-light.png" width="200"> | <img src="agent-release-after-390-light.png" width="200"> <img src="agent-release-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="agent-release-before-1280-dark.png" width="420"> | <img src="agent-release-after-1280-dark.png" width="420"> |

</details>

## 에이전트 상세 › GitHub

활동·허용 workflow 표의 틀이 사라졌습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="agent-github-before-1280-light.png" width="420"> | <img src="agent-github-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="agent-github-before-390-light.png" width="200"> | <img src="agent-github-after-390-light.png" width="200"> <img src="agent-github-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="agent-github-before-1280-dark.png" width="420"> | <img src="agent-github-after-1280-dark.png" width="420"> |

</details>

## 에이전트 상세 › Slack

채널·앱 표의 틀이 사라졌습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="agent-slack-before-1280-light.png" width="420"> | <img src="agent-slack-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="agent-slack-before-390-light.png" width="200"> | <img src="agent-slack-after-390-light.png" width="200"> <img src="agent-slack-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="agent-slack-before-1280-dark.png" width="420"> | <img src="agent-slack-after-1280-dark.png" width="420"> |

</details>

## 설정 › GitHub

App·설치 표의 틀이 사라졌고 날짜는 절대 시각입니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="ws-github-before-1280-light.png" width="420"> | <img src="ws-github-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="ws-github-before-390-light.png" width="200"> | <img src="ws-github-after-390-light.png" width="200"> <img src="ws-github-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="ws-github-before-1280-dark.png" width="420"> | <img src="ws-github-after-1280-dark.png" width="420"> |

</details>

## 설정 › Slack

Slack 앱 표의 틀이 사라졌습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="ws-slack-before-1280-light.png" width="420"> | <img src="ws-slack-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="ws-slack-before-390-light.png" width="200"> | <img src="ws-slack-after-390-light.png" width="200"> <img src="ws-slack-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="ws-slack-before-1280-dark.png" width="420"> | <img src="ws-slack-after-1280-dark.png" width="420"> |

</details>

## 설정 › 모델 연결

여섯 열 표는 52rem 아래에서 스크롤합니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="model-connections-before-1280-light.png" width="420"> | <img src="model-connections-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="model-connections-before-390-light.png" width="200"> | <img src="model-connections-after-390-light.png" width="200"> <img src="model-connections-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="model-connections-before-1280-dark.png" width="420"> | <img src="model-connections-after-1280-dark.png" width="420"> |

</details>

## 설정 › MCP 서버

모델 연결과 같습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="mcp-servers-before-1280-light.png" width="420"> | <img src="mcp-servers-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="mcp-servers-before-390-light.png" width="200"> | <img src="mcp-servers-after-390-light.png" width="200"> <img src="mcp-servers-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="mcp-servers-before-1280-dark.png" width="420"> | <img src="mcp-servers-after-1280-dark.png" width="420"> |

</details>

## 설정 › 로그인

로그인 공급자 표의 틀이 사라졌습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="login-providers-before-1280-light.png" width="420"> | <img src="login-providers-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="login-providers-before-390-light.png" width="200"> | <img src="login-providers-after-390-light.png" width="200"> <img src="login-providers-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="login-providers-before-1280-dark.png" width="420"> | <img src="login-providers-after-1280-dark.png" width="420"> |

</details>

## 성과 (/achievements)

HTML 표 세 개를 공통 표로 옮겼습니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="achievements-before-1280-light.png" width="420"> | <img src="achievements-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="achievements-before-390-light.png" width="200"> | <img src="achievements-after-390-light.png" width="200"> <img src="achievements-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="achievements-before-1280-dark.png" width="420"> | <img src="achievements-after-1280-dark.png" width="420"> |

</details>

## 설정 › 성과 규칙

HTML 표 두 개를 공통 표로 옮겼고, 390px에서 카드처럼 쌓던 행 대신 표를 스크롤합니다.

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | <img src="achievement-rules-before-1280-light.png" width="420"> | <img src="achievement-rules-after-1280-light.png" width="420"> |
| 모바일 390 | <img src="achievement-rules-before-390-light.png" width="200"> | <img src="achievement-rules-after-390-light.png" width="200"> <img src="achievement-rules-after-390-light-scrolled.png" width="200"> |

<details><summary>다크 모드 1280</summary>

| 변경 전 | 변경 후 |
|---|---|
| <img src="achievement-rules-before-1280-dark.png" width="420"> | <img src="achievement-rules-after-1280-dark.png" width="420"> |

</details>
