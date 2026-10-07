# 디자인 브랜치 main 통합 및 운영 복구

## 목표와 승인
- 사용자 승인: `메인에 통합후 검증한 뒤 배포해줘`.
- 원격 main `0a9a141`에 authoring-first `3d58a8c`를 통합하고 검증한 exact commit을 운영 배포한다.
- 기존 dirty main 체크아웃은 보존한다. 운영 DB 변경, 모델 호출, 고객 데이터 쓰기는 수행하지 않는다.

## 완료 조건과 검증
- [x] 별도 worktree `cunote-design-release`, branch `release/design-main-20261007` 생성, 무충돌 병합.
- [ ] 의존성 고정 설치: `pnpm install --frozen-lockfile`.
- [ ] 화면/작성/매칭 회귀: `pnpm test:design-r2`, `pnpm test:apply-workspace`, `pnpm test:writing-context`, `pnpm test:document-agent`, `pnpm test:profile-autofill`, `pnpm test:matching-unit`.
- [ ] 공유 계약 및 격리 DB: `pnpm verify:db-migrations`, `pnpm verify:route-policy`, `pnpm verify:openapi`, `pnpm test:product-postgres`.
- [ ] 실제 컴포넌트 합성 브라우저: `node tools/design-company-review/run.mjs`.
- [ ] `pnpm build:web`, `git diff --check`.
- [ ] 운영 DB 마이그레이션 0094~0098 hash 읽기 전용 대조.
- [ ] 검증된 커밋 원격 main push 및 운영 READY/소스 SHA/도메인 확인.
- [ ] 운영 데스크톱/모바일 랜딩, 로그인 및 보호 경로 스모크. 배포 태그 기록.
- [ ] 기존 main diff 및 상태 보존 확인.

## 결정 로그
- 이전 운영 디자인 배포: source `582792f`, `dpl_2rrpgF3iwdZqRGQMmpqikkDRfgeF`.
- 10월 5일 Git 자동 배포 `main@0a9a141`이 이전 디자인을 다시 노출했다. main 자체를 통합해 재발을 방지한다.
- main과 디자인 브랜치의 분기는 main 문서 커밋 1개와 디자인/작성 브랜치 101개다. 두 부모를 보존하는 merge를 사용한다.
- 배포용 스크립트 없음(analysis-lab release CLI는 웹 배포와 별개). main push의 기존 Git 연동 배포를 우선 관측하고 동일 SHA 배포를 중복 생성하지 않는다.
- 기존 사용자 개발 서버를 시작하거나 재시작하지 않는다. 브라우저 fixture는 종료되는 합성 검증이며 운영 DB/모델을 사용하지 않는다.

## 막힘
- 없음.
