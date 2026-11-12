# @werft-ai/ui

웹 콘솔(I1)·받은편지함(I2)·연결(I3)·기억(I4) 화면이 공유하는 표현 계층이다.

## 경계

이 패키지는 **서버가 준 상태를 그리는 일만 한다**.

- fetch·권한 판정·상태 전이 정책을 넣지 않는다. URL도 만들지 않는다(`href`는 화면이 준다).
- API 계약 패키지를 모른다. 계약 타입을 받는 조각은 `@werft-ai/react/components`에 있다.
- `react`·`react-dom`은 쓰는 쪽 앱의 것을 쓴다(peerDependencies). 두 벌이 되면 hook이 깨진다.
- 런타임 의존성은 shadcn/ui가 쓰는
  `@radix-ui/react-checkbox`·`@radix-ui/react-dialog`·`@radix-ui/react-radio-group`·`@radix-ui/react-slot`·`@radix-ui/react-tabs`·`class-variance-authority`·`clsx`·`tailwind-merge`,
  아이콘 `lucide-react`뿐이다. 런타임에 import하는 패키지는 devDependencies가 아니라 여기에 둔다.
  예외는 `fonts.css`가 `@import`하는 `pretendard`다. 배포물에는 폰트를 싣지 않으므로(아래 "배포 산출물") devDependencies에 둔다.
- Radix는 `src/primitives/` 안에서만 import한다. Dialog 구현이 둘이 되지 않게 하려는 것이다.
- `src/package.test.ts`가 이 경계를 검사한다. 새 의존성을 넣으려면 그 테스트를 먼저 고쳐야 한다.
  control-host 이미지가 싣는 웹 콘솔 번들에 이 패키지의 dependencies가 들어가므로, 새 의존성은 `bun scripts/third-party-notices.ts`로
  `THIRD_PARTY_NOTICES.md`도 다시 만든다.

## shadcn/ui

`src/primitives/`는 shadcn/ui(new-york, Radix 판, Tailwind 4) 항목을 복사해 들인 것이다. 설정은 `components.json`에 있다.
새 항목을 들일 때는 이 디렉터리에서 `bunx shadcn@<버전> add <이름>`으로 받은 뒤, 이 저장소 규칙에 맞게
import를 상대 경로(`../foundations/cn.ts`)로 바꾸고 `src/primitives/index.ts`로 내보낸다.
upstream과 다른 점은 각 파일 머리 주석에 적었다. 공통으로 `dark:` variant를 쓰지 않는다. 다크는 토큰이 바꾸고,
Tailwind의 `dark:`는 수동 전환(`data-theme`)을 보지 못하기 때문이다.

- **색.** shadcn 의미 이름(`primary`·`border`·`ring`…)은 런타임 변수로 두지 않는다. `theme.css`의 Tailwind 키
  (`--color-primary` 등)가 `--werft-*` 토큰을 바로 가리킨다. 그래서 키트는 접두사 없는 `--primary`·`--border`를 선언하지
  않고, 같은 이름을 쓰는 앱(shadcn을 쓰는 앱 등)의 변수와 부딪치지 않는다. shadcn의 `accent`는 hover용 조용한 바탕이고, 우리 브랜드 색은
  `primary`(= `--werft-color-accent`)다. 상태 색처럼 도메인 전용 색은 `--werft-tone-*`을 직접 쓴다.
- **Tailwind 연결.** `src/foundations/theme.css`가 토큰을 유틸리티에 잇는 유일한 곳이다. 색(`bg-primary`·`bg-sidebar`…),
  글자 크기(`text-control`·`text-description`·`text-title` 등), `font-sans`·`font-mono`, `rounded-control|card`, `shadow-pop`이
  여기서 나온다. 쓰는 쪽 CSS는
  `tailwindcss`·`styles.css`·`theme.css` 순으로 import하고 `@source`로 이 패키지의 `src`를 스캔해야 한다
  (`apps/web/src/styles.css`가 예다). Tailwind 없이 쓰면 primitive는 모양 없이 그려진다.
- **cascade layer.** `tokens.css`와 `styles.css`의 규칙은 모두 `@layer werft` 안에 있다. `tokens.css`가
  `@layer theme, base, components, utilities, werft;`로 순서를 정하므로, 이 파일과 Tailwind 중 무엇을 먼저 import하든 `werft-*`
  규칙은 Tailwind 유틸리티를 이기고 쓰는 쪽 앱의 layer 밖 규칙에는 진다. 쓰는 쪽 앱이 이 파일보다 먼저 layer 순서를
  선언하면 그 순서가 이긴다. 그때도 `werft`는 `utilities` 뒤에 두어야 한다. `ConfirmDialog`는 앞의 성질로 shadcn Dialog 위에서 기존 모양과
  reduced-motion 규칙을 유지한다. 그래서 `werft-*` 클래스를 그리는 컴포넌트(`ConfirmDialog`·`DestructiveActionDialog`·
  `EmptyState`·`ErrorState`·`Skeleton`, 그리고 `@werft-ai/react/components`의 `StatusLabel`·`ReceiptSummary`·`ReceiptLink`)에 `className`으로 넘긴 유틸리티는
  BEM 규칙과 같은 속성이면 적용되지 않는다. 바꾸려면 쓰는 쪽 앱의 layer 밖 CSS로 덮는다. BEM 클래스는 화면을 옮기면서
  (W11·W17) 지운다.
- **box-sizing.** `styles.css`가 키트 요소(`werft-*` 클래스와 `data-slot`)에만 `border-box`를 건다. Tailwind preflight가 없는
  앱에서도 `Input` 높이가 콘솔과 같다.

## 공개 API

`package.json`의 `exports`가 경계다. 여기 없는 경로(`src/primitives/button.tsx` 같은 파일 경로)는 import하지 않는다.

| 진입점 | 내용 |
|---|---|
| `@werft-ai/ui` | 세 층 전부. 지금 import는 대부분 이것이다 |
| `@werft-ai/ui/primitives` | primitives 층만 |
| `@werft-ai/ui/patterns` | patterns 층만 |
| `@werft-ai/ui/styles.css` | 워크스페이스에서는 소스 그대로 폰트·토큰·`werft-*` 규칙. 배포물에서는 미리 빌드한 CSS(폰트 없음, 전역 `border-color` 포함. 아래 "배포 산출물") |
| `@werft-ai/ui/theme.css` | Tailwind v4가 토큰을 유틸리티로 쓰게 잇는 `@theme inline` |
| `@werft-ai/ui/tokens.css` | `--werft-*` 변수만 |

- 층 index에 없는 이름은 내부다. shadcn 파일이 export해도(`badgeVariants`·`DialogPortal` 등) index에 올리지 않았으면 공개 API가 아니다.
  쓰는 곳이 생기면 그때 index에 올린다.
- `"sideEffects": ["*.css"]`: JS 모듈은 import만으로 하는 일이 없어 번들러가 쓰지 않는 것을 버린다. CSS는 import 자체가 일이라 남긴다.
  모듈 최상위에서 무언가를 등록하는 코드를 넣으면 이 선언이 그 모듈을 버리게 하니 넣지 않는다.
- `./test-support/dom`·`./test-support/html`은 이 저장소의 테스트(`apps/*`·`packages/*`)만 쓰는 도우미다. 공개 API가 아니고,
  배포용 package.json에서는 뺀다.
- 패키지는 아직 `private`다. exports가 `src`를 가리켜 워크스페이스는 빌드 없이 소스를 읽는다.

## 배포 산출물

```bash
bun run --cwd packages/ui build:package   # → packages/ui/dist
npm pack --dry-run ./packages/ui/dist     # tarball에 들어갈 파일
bun scripts/ui-pack-smoke.ts              # 빈 Vite+React 앱에 설치해 렌더 (node·npm·Chrome 필요)
```

`scripts/build-package.ts`가 `dist/`를 처음부터 다시 만든다. 게시는 하지 않는다. 레지스트리 설정이 없고, 게시는 사람이 정한다.

- JS·d.ts: tsdown(unbundle)이 소스 파일마다 `.js`·`.d.ts` 하나씩 만든다. `__fixtures__`·`test-support`·테스트는 빠진다.
- `styles.css`: Tailwind CLI로 미리 빌드한 CSS. 토큰·`werft-*` 규칙·키트가 쓰는 유틸리티가 들어 있어 Tailwind 없는 앱도
  `import "@werft-ai/ui/styles.css"` 한 줄로 그려진다. preflight는 넣지 않는다. 다만 함께 빌드되는 `theme.css`의
  `@layer base` 규칙이 모든 요소(`*`·`::before`·`::after`)의 `border-color`를 `--werft-color-border`로 정한다. 쓰는 쪽 앱의
  전역 스타일 중 이것 하나는 바뀌며, 앱의 layer 밖 CSS는 이 규칙을 이긴다.
  대신 키트가 기대하는 preflight 규칙(box-sizing·border 너비와 모양·margin·padding, 링크·목록·제목·미디어, 폼 요소의
  font·color·배경·radius)을 키트 요소(`werft-*` 클래스와 `[data-slot]`)와 그 안쪽에만 specificity 0으로 건다. 이게 없으면
  브라우저 기본 스타일이 `<button>`에 2px outset 테두리나 회색 배경을, `asChild` 링크에 밑줄을 그린다. 키트 안에 넣은
  앱 마크업도 브라우저 기본 margin·밑줄이 빠지지만, 앱 CSS는 레이어 밖이라 항상 이긴다. 테두리 색은 `theme.css` 기본값을 쓴다.
- `tokens.css`·`theme.css`: 소스 그대로. Tailwind v4 앱은 `styles.css` 뒤에 `theme.css`를 import하면 같은 유틸리티 이름을 쓸 수 있다.
- 폰트는 싣지 않는다. `styles.css`의 `fonts.css` import를 빼고 빌드하므로 `--werft-font-sans`·`--werft-font-mono`는 쓰는 쪽 앱이
  Geist·Pretendard를 로드하지 않으면 시스템 폰트로 떨어진다. `pretendard`도 배포 package.json의 의존성이 아니다.
  `--werft-font-sans`는 `werft-*` 요소에만 걸리고 버튼 같은 컨트롤은 앱 글꼴을 물려받으므로, 앱이 `body`(또는 `:root`)에
  글꼴을 주지 않으면 브라우저 기본 serif로 그려진다. 앱 CSS에 `body { font-family: var(--werft-font-sans); }` 한 줄을 둔다.
- `package.json`: 저장소 것에서 만든다. exports는 `dist` 파일을 가리키고 `./test-support/*`는 뺀다. `react`·`react-dom`은 peer 그대로다.
- `LICENSE`: 저장소 루트 것을 복사한다.

키트 요소에 거는 preflight 대체 규칙은 `src/foundations/scoped-preflight.css` 한 곳에 있다. 빌드가 배포 `styles.css`에 넣는다.
워크스페이스 `styles.css`는 import하지 않는다(콘솔은 Tailwind preflight를 쓴다).

저장소 밖 앱에서 tarball을 설치해 쓰는 법은 문서 사이트의 [저장소 밖 앱에 설치](../../apps/docs/content/docs/ui/package.mdx)에 있다.

### 릴리스 절차

`.github/workflows/ui-release.yml`이 태그 push·수동 실행에서 빌드·smoke·pack을 하고 tarball을 artifact `ui-package`로 남긴다. PR consumer 검사는 ci.yml의 `ui-pack`이 담당한다.
수동 실행은 pack에서 멈춘다. 이것이 dry run이다. 게시(`publish` job)는 `ui-v*` 태그의 **push**이고 그 커밋이
main에 있을 때만 돌고, `release` environment의 필수 승인자가 승인해야 시작한다. 그 job만 `packages: write`를 받고, 인증은 자동
`GITHUB_TOKEN`이다.

아직 게시하지 않는다. 첫 게시 전에 사람이 정할 것:

1. **D-7a 라이선스.** 정했다: PolyForm Small Business 1.0.0. 배포 package.json의 `license`는 저장소 것을 그대로 쓰고, `LICENSE` 사본이 전문과 `Required Notice:` 줄을 싣는다.
2. **D-7b 게시 위치와 토큰.** 스코프 `@werft-ai`는 GitHub 조직 `Werft-ai`의 것이고 저장소는 사용자 소유다. 이 저장소의
   `GITHUB_TOKEN`이 조직 패키지에 쓸 수 있는지 확인하고, 안 되면 저장소를 조직으로 옮기거나 조직 범위 PAT를 등록한다.
   PAT를 쓰면 `publish` job의 `NODE_AUTH_TOKEN` 한 줄만 바꾼다.
3. **게시 승인.** 1·2가 끝난 뒤 소유자가 게시를 승인한다.

그 뒤 한 번 게시하는 순서:

1. `packages/ui/package.json`의 `version`을 올리는 PR을 land한다(`private: true`는 그대로다. 배포용 package.json은 빌드가 만든다).
2. main의 그 커밋에 `ui-vX.Y.Z` 태그를 push한다. 태그 이름과 `version`이 다르면 build job이 실패한다.
3. 오너가 태그 게시를 결정한 경우에만 `release` environment의 deployment 정책에 `ui-v*`를 더한다. 현재 정책은 `main` 브랜치와 `v*` 태그만 허용하므로 그 전에는 `publish` job이 거부된다. required reviewer는 유지하고, tag ruleset으로 태그 생성자를 제한하는 것을 권장한다.
4. 승인자는 이벤트가 `push`인지, 태그가 패키지 버전과 일치하는지 직접 확인한다. 신뢰할 수 있는 checkout에서 `git fetch origin main` 뒤 `git merge-base --is-ancestor <태그의 커밋 SHA> origin/main` 또는 GitHub compare로 main 소속을 독립 확인한다. 태그의 workflow를 고치면 smoke 로그도 임의로 만들 수 있으므로 로그만 승인 근거로 삼지 않는다. 태그 패턴을 허용한 environment는 해당 태그 ref의 workflow를 고친 수동 실행도 통과시킬 수 있으므로 이벤트·ref·커밋을 별도로 확인한다.

`ui-v*` 태그는 `images.yml`(`v*` 태그)을 시작하지 않는다. `tests/ui-release.test.ts`가 이 게이트를 검사한다.

이 게이트는 워크플로 파일 안의 조건이다. 이 저장소의 브랜치는 PR에서 워크플로를 고쳐 job에 `packages: write`를 직접 요청할 수
있으므로(`images.yml`도 같다), 파일만으로는 머지 전 게시를 막지 못한다. 막는 것은 저장소 설정이다. 브랜치를 push할 수 있는
사람(저장소 write 권한)을 좁게 두고 PR은 리뷰 뒤에 머지한다. 첫 게시 뒤에는 패키지 설정의 Manage Actions access를 이 저장소로
한정한다. 모두 사람이 하는 설정이다.

## 토큰

색·간격·타이포·radius·shadow·모션은 `src/foundations/tokens.css` **한 곳**에만 있다. 라이트가 기본이고,
다크는 시스템 설정(`prefers-color-scheme`)과 수동 전환(`:root[data-theme="dark"]`) 양쪽으로 온다.

값은 콘솔 디자인 캔버스 v35 규칙표를 따른다. 간격은 4·8·12·16·24·32, 글자는 12·13·14·20·24, 반경은 컨트롤 6·카드 8·pill,
그림자는 떠 있는 요소용 `--werft-shadow-pop` 하나다. 바탕은 사이드바 `--werft-color-sidebar`와 메인·카드 `--werft-color-surface` 둘이다. 사이드바 nav 행은 hover에 `bg-sidebar-hover`, 현재 페이지에 `bg-sidebar-accent`를 쓴다.
`--werft-color-canvas`는 `--werft-color-surface`의 옛 이름으로, apps/docs가 읽어서 남겨 두었다. 새 코드에서 쓰지 않는다.

Tailwind 4의 `@theme` 블록 대신 `--werft-` 접두사를 붙인 평범한 커스텀 프로퍼티를 쓴다.
`@theme`는 Tailwind 컴파일러를 거쳐야만 살아남는데, 이 패키지는 Tailwind 없이도 렌더돼야 하기 때문이다.
Tailwind에는 `theme.css`가 이어 붙인다(`--color-surface: var(--werft-color-surface)` 식). 접두사가 없으면
`--color-surface: var(--color-surface)`가 되어 순환한다. 접두사는 그것을 막는다.

## 화면 구성 원칙

화면은 정보를 위에서 아래로 한 줄씩 쌓아 만들지 않는다. 값은 위 v35 규칙표를 따른다.

- 같은 대상에 대한 정보는 한 덩어리로 묶는다. 제목·개수·링크·카드를 각각 한 줄씩 쌓지 않는다.
- 개수·상태는 제목 옆 배지로, 대상 이름·기한은 카드 첫 줄 한 줄로 둔다.
- 짧은 항목이 여러 개면 가로로 놓는다(한 줄 메타, 2~3열 그리드, 오른쪽 정렬 버튼). 세로로 나열하는 것은 순서에 의미가 있을 때뿐이다.
- 같은 정보를 한 화면에 두 번 보이지 않는다.
- 버튼은 내용 폭이고 높이는 `--werft-control-height`(32px)다. 폭을 채우는 버튼은 390px 폭 화면의 주 동작에만 쓴다.
- 섹션 사이는 `--werft-space-section`(32px), 같은 섹션 안 블록 사이는 `--werft-space-block`(16px)이다. 한 섹션 안에 블록이 셋을 넘으면 묶을 수 있는지 먼저 본다.
- PR마다 1440px 스크린샷에서 위에서 아래로 나열만 된 곳이 있는지 보고, PR의 검증 sticky comment에 적는다.

예를 들어 제목, "N건" 줄, 대상 ID 줄, 반폭 카드, 표를 차례로 쌓고 같은 대상을 표에 또 보이는 영역은 첫째·둘째·넷째 원칙을 어긴다.
개수는 제목 옆 배지로, ID는 카드 첫 줄로 옮기고, 표에서는 그 대상을 뺀다.

### 세로 리듬과 좌측선

설정 화면은 섹션을 둥근 테두리 카드로 감싸지 않는다. 섹션은 제목·설명·얇은 아래 구분선으로 시작하고, 섹션 사이에는 `--werft-space-section`, 안쪽 블록에는 `--werft-space-block`을 쓴다. 가능하면 `SettingsSection`을 재사용한다.

테두리는 입력칸·버튼·칩/배지·라디오 선택 카드 같은 조작 대상에만 둔다. 계정·키·App·기능·규칙 목록과 표는 외곽 프레임 없이 행 사이 선으로 구분한다(`RowList`·`GridTable`의 `framed={false}`). 안내 문단과 요약·검토 구역도 별도 테두리로 감싸지 않는다. 오류·위험 안내는 글자·아이콘·의미 있는 배경색을 유지하며 장식 테두리만 뺀다. 대화상자·시트의 경계와 내부 입력 컨트롤은 유지한다.

간격은 상자 경계에서 잰다. 4·8·12·16·24·32만 쓰고 6·10은 쓰지 않는다.

| 사이 | 값 |
|---|---|
| topbar 아래 → 페이지 제목, 마지막 섹션 → 페이지 끝 | `--werft-space-page-top` 24px. 768px 미만은 상하좌우 모두 16px |
| 페이지 머리(제목·설명) → 첫 섹션 | `--werft-space-page-head` 24px |
| 섹션 ↔ 섹션 | `--werft-space-section` 32px. 상세 화면의 패널과 본문이 위아래로 쌓여도 두 섹션으로 본다 |
| 섹션 안 블록 ↔ 블록, 섹션 제목 → 내용 | `--werft-space-block` 16px |
| 폼 필드 ↔ 필드 | 16px. 라디오·체크박스 묶음 안은 12px |
| 카드 안 | padding 16px, 목록 행 padding 12px 16px |

- 페이지 틀은 하나다(`PageFrame`, V4-PAGE-FRAME). 목록·설정·폼·상세 모두 좌우 여백 16px(768px부터 24px) 안에서 `--werft-w-page`(1620px)까지 넓어진 뒤 가운데에 놓인다. 화면마다 폭이나 여백을 따로 적지 않는다. 설정 내비 안의 화면(설정 탭 전부와 key 만들기)도 내비를 뺀 나머지를 틀 끝까지 써서, 구획 선·카드·표의 오른쪽 끝이 다른 화면과 같은 선에 놓인다. 입력칸과 설명 문단처럼 길어지면 읽기 어려운 요소만 각자 최대 폭(`max-w-80`, `--werft-layout-reading-width` 등)을 둔다. 세션 상세는 오른쪽 레일 때문에 `DetailLayout`이 본문만 같은 틀에 넣는다.
- 화면마다 콘텐츠 왼쪽 선은 하나다. 제목, 설명, 탭 글자, 표 첫 열 글자, 카드 테두리가 같은 x에 선다. line 탭은 좌우 padding 없이 `gap-6`으로 띄워 첫 탭 글자가 선 위에 온다.
- 목록으로 돌아가는 링크는 제목 위 줄이 아니라 `PageHeader`의 `actions`(outline sm 버튼, 왼쪽 화살표)에 둔다. 그래야 제목 y가 화면마다 같다.
- 사이드바 머리는 topbar와 높이(`--werft-topbar-h`)와 아래 경계선이 같아 한 줄로 이어진다.
- 실측은 verify 스킬의 `browser.mjs measure`와 `layout-report.mjs`로 한다([web-console.md](../../.claude/skills/verify-werft/features/web-console.md)).

## 들어 있는 것

`src`는 아는 것에 따라 층으로 나뉜다. 층마다 `index.ts`가 있고, 루트 `src/index.ts`가 층 index를 다시 내보낸다.
층 안의 파일끼리는 index를 거치지 않고 파일 경로로 import한다.

| 층 · 디렉터리 | 아는 것 | 들어 있는 것 |
|---|---|---|
| foundations · `src/foundations/` | 없음 | `tokens.css`·`styles.css`·`theme.css`·`fonts.css`(+`fonts/`), `cn`, `useReducedMotion`, `useMediaQuery`, `formatTimestamp` |
| primitives · `src/primitives/` | foundations | shadcn 항목 `Button`·`Badge`·`Card*`·`Input`·`Textarea`·`NativeSelect*`·`Checkbox`·`RadioGroup*`·`Tabs*`·`Dialog*`·`Field*`, 그리고 `Skeleton`. 도메인을 모른다. 의미 있는 상태는 `Badge`가 아니라 `StatusLabel`로 |
| patterns · `src/patterns/` | primitives | `ConfirmDialog`·`DestructiveActionDialog`(결과 설명이 필수이고, 파괴적 동작은 이름을 입력해야 열린다), `EmptyState`, `ErrorState`(제목·할 일·원문·재시도·증거 링크. 할 일 문구는 쓰는 쪽이 준다), 페이지 틀 `PageFrame`(여백 + 1620px 가운데 열)과 그 안의 `Page`(머리 + 32px 간격 섹션), 페이지 머리 `PageHeader`(h1 + 설명 + 동작 여러 개), `Stepper`, 상세 화면 두 칸 배치 `useDetailLayout` |

계약 타입을 받는 도메인 조각은 `packages/react/src/components`(`@werft-ai/react/components`)에 있다: `StatusLabel`(admission·turn·receipt·execution **네 축**을 따로 그린다), `ReceiptSummary`·`ReceiptLink`(`unknown`은 성공으로 그리지 않는다), `ApiErrorState`(`error.code`별 "할 일"을 채운 `ErrorState`), `Session*`·`Timeline`·`Message`·`Composer`·`ApprovalCard`·`ApprovalRow`·`QuestionCard`·`StageIndicator`.

### 시안은 실제 부품으로만 만든다

- 시안은 실제 `@werft-ai/ui`·`@werft-ai/react` 부품을 조립하고 데모 데이터를 넣어 만든다.
- 따로 그린 HTML 캔버스 시안은 만들지 않는다.
- 시안에서 고른 모양은 먼저 부품에 넣고(ui-kit), 화면은 그 부품으로 조립한다(web-ui).
- 시안에 필요한 모양이 부품에 없으면 부품 추가 요청이다. 시안 안에서 따로 그리지 않는다.

## 테스트

`bun test packages/ui` — happy-dom + Testing Library. 두 가지 규칙이 있다.

1. **DOM은 파일마다 붙였다 뗀다.** `bun test`는 저장소 전체를 한 프로세스에서 돌리는데,
   happy-dom 등록은 DOM뿐 아니라 `fetch`·`Request`·`setTimeout`까지 바꾼다. 그대로 두면
   뒤따라 도는 API·worker 스위트가 가짜 네트워크를 받는다.
2. **DOM을 건드리는 모듈은 `setupDom()` 뒤에 import한다.** Radix는 import 시점에 DOM 유무를 보고
   `useLayoutEffect`를 no-op으로 바꾼다(그러면 포털이 영영 안 붙는다). Testing Library도 `document`를
   그때 캡처한다. 그래서 `setupDom()`이 Testing Library를 직접 돌려주고, Radix를 쓰는 컴포넌트는
   `await import(...)`로 가져온다. 자세한 사정은 `src/test-support/dom.ts`에 적어 뒀다.

레이아웃 엔진이 없는 환경이라 "360px에서 가로 스크롤 없음"과 "`prefers-reduced-motion` 존중"은
렌더로 관측할 수 없다. 둘 다 `src/foundations/styles.test.ts`가 스타일시트의 성질로 검사한다.

## 눈으로 보기

```bash
bun run --cwd packages/ui demo   # http://localhost:5173/demo.html
```

shadcn primitive가 Tailwind를 거쳐야 그려지므로 데모는 apps/web과 같은 Vite + `@tailwindcss/vite`로 띄운다.

`?theme=dark`·`?theme=light`로 테마를, `?dialog=confirm`·`?dialog=destructive`로 다이얼로그를 연다.
스타일시트 검사가 못 보는 것(실제 폭에서의 넘침, 대비, 모션)은 여기서 본다 —
실제로 이 미리보기가 360px에서 다이얼로그가 18px 넘치던 `box-sizing` 문제를 잡았다.
