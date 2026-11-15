# PR #1750 스크린샷: 세그먼트 통일 (D안)

변경 전은 최신 main, 변경 후는 이 브랜치입니다. 데모 모드 + 목 fixture(T1).

## 툴바 확대 (라이트, DPR 2)

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| 세션 목록 `/#/sessions` | ![](toolbar-sessions-light-before.png) | ![](toolbar-sessions-light-after.png) |
| 에이전트 목록 `/#/agents` | ![](toolbar-agents-light-before.png) | ![](toolbar-agents-light-after.png) |
| 사용량·한도 > 도구 활동 `/#/operations/tools` | ![](toolbar-tools-light-before.png) | ![](toolbar-tools-light-after.png) |

## 세션 목록 `/#/sessions`

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | ![](sessions-1280-light-before.png) | ![](sessions-1280-light-after.png) |
| 모바일 390 | <img src="sessions-390-light-before.png" width="300"> | <img src="sessions-390-light-after.png" width="300"> |

상태 세그먼트가 회색 트랙 + 흰 알약으로 바뀌었습니다. 답변 대기(주황)·실패(빨강)는 1 이상일 때 배지, 나머지는 흐린 숫자입니다.

## 에이전트 목록 `/#/agents`

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | ![](agents-1280-light-before.png) | ![](agents-1280-light-after.png) |
| 모바일 390 | <img src="agents-390-light-before.png" width="300"> | <img src="agents-390-light-after.png" width="300"> |

전체/관리하는 에이전트 세그먼트가 같은 모양입니다. 카드/표 전환도 같은 컴포넌트라 함께 바뀝니다.

## 사용량·한도 > 도구 활동 `/#/operations/tools`

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| PC 1280 | ![](operations-tools-1280-light-before.png) | ![](operations-tools-1280-light-after.png) |
| 모바일 390 | <img src="operations-tools-390-light-before.png" width="300"> | <img src="operations-tools-390-light-after.png" width="300"> |

정렬 세그먼트가 34px → 32px로 검색창과 높이가 같아졌습니다. 범위·기간 선택도 같은 모양입니다.

<details>
<summary>다크 모드</summary>

| 화면 | 변경 전 | 변경 후 |
|---|---|---|
| 세션 목록 `/#/sessions` 툴바 | ![](toolbar-sessions-dark-before.png) | ![](toolbar-sessions-dark-after.png) |
| 에이전트 목록 `/#/agents` 툴바 | ![](toolbar-agents-dark-before.png) | ![](toolbar-agents-dark-after.png) |
| 사용량·한도 > 도구 활동 `/#/operations/tools` 툴바 | ![](toolbar-tools-dark-before.png) | ![](toolbar-tools-dark-after.png) |
| 세션 목록 `/#/sessions` PC 1280 | ![](sessions-1280-dark-before.png) | ![](sessions-1280-dark-after.png) |
| 에이전트 목록 `/#/agents` PC 1280 | ![](agents-1280-dark-before.png) | ![](agents-1280-dark-after.png) |
| 사용량·한도 > 도구 활동 `/#/operations/tools` PC 1280 | ![](operations-tools-1280-dark-before.png) | ![](operations-tools-1280-dark-after.png) |

</details>
