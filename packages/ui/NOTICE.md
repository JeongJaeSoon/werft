# NOTICE — @werft-ai/ui

## 라이선스 구분

- 이 패키지의 나머지 모든 파일은 PolyForm-Small-Business-1.0.0이다(`../../LICENSE`, 배포본에서는 `LICENSE`).
- 아래 "복사한 파일" 표에 이름이 있는 파일만 Apache-2.0이다. 이 파일들은 Adobe의 소스를 werft에 맞게 고친 것이고, 원래 라이선스를 유지한다. 라이선스 전문은 `LICENSE-APACHE-2.0`이다.
- npm 패키지로 들어오는 `react-aria-components`와 `@internationalized/date`(둘 다 Apache-2.0)는 이 표의 대상이 아니다. 루트 `THIRD_PARTY_NOTICES.md`가 다룬다.

## 출처

| 항목 | 값 |
|---|---|
| 저장소 | https://github.com/adobe/react-spectrum |
| 경로 | `starters/tailwind/src` (React Aria Components Tailwind starter) |
| 불변 commit | `d1b6f73fe1841c6ff160926018f751650a19efa9` (이 경로를 마지막으로 바꾼 commit, 2026-11-05) |
| 라이선스 | Apache-2.0, `Copyright 2019 Adobe` (저장소 루트 `LICENSE`) |
| `LICENSE` sha256 | `7dfe6526888bac51759c99f9a51262ba2711a8c12a067f2181609dd9a4066b84` (`LICENSE-APACHE-2.0`은 이 파일과 바이트 단위로 같다) |
| 원본 `NOTICE.txt` | 저장소 루트, sha256 `378e1af1aac41d8383e9da1b2acbd2adca2ff8a4c4ad5fdecc8fbffff831eaf7` |

원본 `NOTICE.txt`는 react-spectrum 라이브러리 안쪽이 쓴 외부 코드(react-window, tabster, react-interactions, ICU 등)의 출처 목록이다. starter 소스는 `react`, `react-aria-components`, `lucide-react`, `tailwind-merge`, `tailwind-variants`만 import하고 그 코드를 담지 않아서, Apache-2.0 §4(d)의 "Derivative Works에 해당하지 않는 고지"로 보고 옮기지 않았다. 복사하는 PR은 자기 파일이 그 목록의 코드를 담게 되는지 다시 확인한다.

## 복사한 파일

복사하는 PR이 한 줄씩 더한다. 원본 sha256은 위 commit에서 그 경로의 파일을 `shasum -a 256`한 값이다. 복사한 파일 맨 위에는 변경 고지("Copied from … Changed by werft: …")를 단다.

| 이 저장소의 파일 | 원본 경로 (위 commit 기준) | 원본 sha256 | 복사한 날 |
|---|---|---|---|
| (아직 없음) | | | |

## 갱신

복사본은 패키지 버전을 올려도 갱신되지 않는다. 원본 경로에 변경이 생기면 접근성·보안 수정이 있는지 읽고 복사본에 옮길지 정한 뒤, 이 표의 commit과 sha256을 고친다. `react-aria-components`를 올리는 일과 따로 한다.
