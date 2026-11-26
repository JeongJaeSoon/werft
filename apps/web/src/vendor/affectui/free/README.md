# AffectUI 무료(MIT) 조각

AffectUI가 MIT로 공개한 조각을 그대로 옮겨 두는 곳이다. 아직 옮겨 온 파일은 없다. Pro 파일, 코드, 마크업은 저장소에 넣지 않는다.

## 첫 조각을 들일 때

1. upstream LICENSE 원문을 저작권 줄까지 그대로 [LICENSE](LICENSE)에 복사한다.
2. `scripts/third-party-notices.ts`의 AffectUI 항목에 저작권 보유자와 출처 URL을 적고, `bun scripts/third-party-notices.ts`로 `THIRD_PARTY_NOTICES.md`를 다시 만든다.

## 머리글

- **그대로 옮긴 파일**은 이 폴더에만 둔다. 파일 머리에 upstream 저작권 줄과 MIT 표시를 `/*! ... */` 주석으로 남긴다. 이 꼴이라야 빌드한 bundle에도 남는다.
- **Radix와 `--werft-*` 토큰으로 다시 짠 파일**은 packages/ui pattern으로 둘 수 있다. 파일 머리에 아래 한 줄을 글자 그대로 둔다.

```ts
// Adapted from AffectUI (MIT): apps/web/src/vendor/affectui/free/LICENSE
```

## CI가 막는 것

- packages/ui는 이 폴더를 import하지 못한다(`packages/ui/src/package.test.ts`).
- 이 폴더 밖의 파일 내용과 경로에 AffectUI의 이름이 보이면 `check (static)`이 실패한다(`bun .github/scripts/vendor-names.ts`). 위의 머리글 한 줄, 이 폴더를 가리키는 import 경로, Markdown 문서는 괜찮다.
  - 기본 접두어는 스크립트의 `PATTERNS`에 있다.
  - 그 밖의 고유 식별자는 owner가 `.github/vendor-identifiers.txt`에 적는다.
