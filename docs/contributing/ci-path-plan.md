# PR 문서 변경의 CI 경로 계획

CI는 PR 전체의 변경 경로를 한 번 분류한다. main push와 수동 실행은 기존 전체 계획을 사용한다. 마지막 push의 diff만 보지 않으므로 앞선 코드 변경이 뒤의 문서 커밋으로 가려지지 않는다.

## 경로와 검증

main을 대상으로 다음 경로로만 이뤄진 PR이 문서 전용 후보이다. 다른 branch 위에 쌓은 PR과 base를 확인할 수 없는 PR은 전체 검증이다. 하나라도 다른 경로가 섞이거나 diff가 비어 있어도 전체 검증이다.

- 루트의 `.md` 파일(`README.md`, `CHANGELOG.md`, `AGENTS.md` 등). 라이선스 고지 `THIRD_PARTY_NOTICES.md`는 lockfile에서 생성되므로 제외한다
- `docs/` 아래 `.md`
- `apps/docs/content/` 아래 `.mdx`
- `.claude/` 아래 모든 파일 (스킬 스크립트·설정 포함. 워크플로와 이미지가 읽지 않고, 이를 검증하는 시험은 `tests/`에 있어 `docs-checks`가 덮는다)
- `.github/ISSUE_TEMPLATE/` 아래 파일과 `.github/` 바로 아래 `.md`

소스·workflow·lockfile·사이트 설정·의존성·배포 파일은 이 목록에 없다. 새 경로도 기본적으로 전체 검증이다. 대소문자가 다른 확장자도 자동으로 허용하지 않는다.

## 영역별 계획

문서 전용이 아니어도, 바뀐 경로가 모두 웹 콘솔(`apps/web/`, `apps/storybook/`)이거나 문서 경로면 닿지 않는 job을 건너뛴다. 다른 곳이 가져다 쓰지 않고, 이 파일을 읽는 테스트도 서비스 없이 `check`에서 돌기 때문이다. 그 밖의 경로가 하나라도 있으면(공용 `packages/`, `apps/control-host/`, `apps/worker/`, `apps/egress-proxy/`, lockfile, workflow, `tests/`, `scripts/`, `deploy/` 등) 전체 검증이다. `apps/egress-proxy/`는 말단처럼 보이지만 LocalStack·Docker가 필요한 `tests/`가 직접 가져다 쓰므로 좁히지 않는다.

| 바뀐 영역 | integration 도메인 | `helm-chart` | `k8s-smoke` | `quickstart` | `workspace-quota` |
| --- | --- | --- | --- | --- | --- |
| `apps/web/`, `apps/storybook/` | `surface` | 생략 | 생략 | 가이드 경로가 바뀔 때만 | 생략 |

control-host 이미지가 `apps/web`을 번들하므로 `e2e`는 이 경로에서도 그대로 돈다. 닿지 않는 도메인도 job은 시작해 몇 초 안에 성공으로 끝난다. job 단위 `if`는 matrix 값을 읽지 못하고, 도메인 선언은 `integration-jobs.ts`가 읽는 한 곳(ci.yml)에 두기 때문이다. 계획 스크립트의 `domains` 목록은 그 matrix와 같아야 하며 `tests/ci-plan.test.ts`가 비교한다.

| 변경 | 정적 검사 | 문서·저장소 정책 | 일반 unit·integration·제품 E2E | 실행 가이드 | 사이트 조립 |
| --- | --- | --- | --- | --- | --- |
| README·일반 Markdown만 | 실행 | 실행 | 생략 | 생략 | 생략 |
| 사이트 MDX만 | 실행 | 실행 | 생략 | 아래 두 경로만 실행 | docs·storybook·pages 모두 실행 |
| 실행 가이드 | 실행 | 실행 | 생략 | 두 가이드 모두 실행 | 사이트 경로가 있으면 실행 |
| 코드·설정·혼합·unknown | 실행 | 전체 suite에 포함 | 실행 | 실행 | 실행 |
| main push·수동 실행 | 기존 only 선택에 따름 | 전체 suite에 포함 | 기존 only 선택에 따름 | 기존 only 선택에 따름 | 기존 only 선택에 따름 |

실행 가이드는 `docs/quickstart.md`와 `apps/docs/content/docs/reference/api-guide.mdx`다. 이 경로를 고치면 `quickstart`가 두 가이드의 셸 블록을 그대로 실행한다. 번역된 가이드의 코드 동등성은 문서 검사에서 계속 확인한다.

사이트 content가 바뀌면 docs·storybook 두 artifact를 현재 run에서 만들고 pages가 함께 조립한다. 이전 커밋이나 다른 PR의 artifact를 가져와 검증을 대체하지 않는다. main의 실제 Pages 배포 경로는 그대로다.

## 남기는 검사

`check (static)`은 typecheck·lint·라이선스 고지 검사를 계속 실행한다. 문서 전용 PR의 `docs-checks`는 `bun test ./tests`로 저장소 정책 검사를 서비스 없이 실행한다. 문서 링크·anchor·문서 내 ticket 링크 금지, 다국어 코드 동등성, 이미지·로컬 실행 문서의 정책 등을 일부 파일 이름으로 고르지 않고 기존 `tests/` 집합에서 검증한다. 서비스와 D2 스택이 필요한 테스트의 skip은 이 경로에서 의도적이다. 제품 변경 PR에서는 기존 전체 unit·integration 경로가 돈다.

Images workflow와 required `supply-chain`은 이 변경의 경계 밖이므로 문서 전용 PR에서도 기존대로 실행한다. 이 경로 계획이 공급망 검사나 배포 검사를 생략하지 않는다. `demo`, `ui-pack`, `workspace-quota`, `helm-chart`, `k8s-smoke`는 문서 전용 PR에서 실행하지 않는다.

## required 결과와 실패 처리

branch protection의 이름 `check`, `integration`, `e2e`, `quickstart`, `supply-chain`은 그대로다. 의도한 생략은 required job 자체의 skip에 기대지 않고 다음처럼 명시적으로 success를 낸다.

- `check`: 계획 성공·정적 검사 성공이 필수다. 제품 계획이면 unit matrix 성공과 docs-checks skip, 문서 계획이면 unit skip과 docs-checks 성공을 요구한다.
- `integration`: 계획 성공 뒤 전체 도메인 성공, 또는 문서 계획에 따른 명시적 생략만 허용한다. E2E·quickstart 결과도 기다려 둘 다 성공해야 통과한다. 수동 `only=integration`에 한해 두 job의 의도한 skip을 허용한다.
- `e2e`, `quickstart`: `!cancelled()`로 취소 가능한 상태를 유지하며, 계획 결과·출력 조합을 먼저 검사한다. 생략한 이유를 로그에 남기고, 계획이 실행을 요구하면 기존 무거운 step을 실행한다. 마지막 판정은 실제 시나리오·두 가이드 step의 outcome을 확인한다. 취소·예상 밖 skip은 두 job을 기다리는 required `integration`도 실패시켜 오인 통과를 막는다.
- 계획 실패·출력 누락·예상하지 못한 skip·실패·취소는 위 required 판정에서 실패한다. 누락된 계획을 문서 전용으로 해석하지 않는다.

계획 스크립트는 PR base SHA를 40자리 hex로 제한하고 해당 commit을 가져온 뒤 checkout된 merge 결과와 비교한다. 이벤트의 base와 checkout의 첫 부모가 다르거나 부모를 확인할 수 없으면 전체 검증을 유지한다. `--no-renames`로 rename의 이전·이후 경로를 모두 검사하고 NUL 구분으로 공백·따옴표·개행을 경로 데이터로 처리한다. git fetch나 diff 실패는 출력 계획을 쓰기 전에 실패한다. 경로는 셸 코드로 실행하지 않으며 로그에는 경로 값 대신 수와 계획만 남긴다.

## 검증과 비용

```sh
bash -n .github/scripts/ci-plan.sh
bun test tests/ci-plan.test.ts
bun test tests/ci-static-checks.test.ts
bun test tests/unit-part.test.ts
bun test tests/integration-jobs.test.ts
```

경로 검사는 실제 Git fixture로 혼합 변경, 앞선 코드 뒤의 문서 커밋, 삭제·rename, 특수문자, 비어 있는 diff, main·수동, 실행 가이드, 사이트, 잘못된 SHA·fetch 실패를 확인한다. workflow 검사는 실제 required 셸을 success/failure/cancelled/skipped와 누락 출력으로 실행하며, 모든 소비자의 plan 배선도 확인한다.

새 `changes` job 때문에 전체 코드 PR에는 가벼운 runner 하나와 큐 단계 하나가 추가된다. Git·Bash만 사용하는 계획은 `ubuntu-24.04-arm`에서 실행한다. 이 저장소 Images의 실제 arm64 job들이 사용하는 label이며, 기존 제품·정적 검사 runner의 아키텍처를 옮기지는 않는다. 문서 경로의 별도 `docs-checks`도 남으므로 모든 검사를 없애는 최적화는 아니다. `check (static)`의 캐시는 writer 하나만 유지하며 나머지는 restore만 한다.

문서 경로를 운영할 때는 계획 출력, 생략 job, required 성공 로그, 가이드·사이트 예외, 그대로 도는 공급망 검사를 함께 관찰한다. PR base와 merge checkout의 첫 부모가 일치하는지도 확인한다.
