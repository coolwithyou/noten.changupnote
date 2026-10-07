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

## 2026-10-07 통합 검증
- 통합 커밋 `ef6f7a2`. 제품 소스(apps/web, packages, db, lockfile)는 이전 운영 source `582792f`와 동일하다.
- 고정 의존성 설치 및 package build/runtime freshness PASS. Node 24.20.0으로 web production build PASS(기존 NFT 추적 경고 3개).
- 디자인·작성 workspace·writing-context·document-agent·profile-autofill suites PASS.
- 실제 컴포넌트 합성 브라우저 31 checks/21 captures PASS(360/390/1440). 새 영수증 `docs/evidence/design-main-release-20261007/fixture-report.json`, 이미지 `/tmp/cunote-design-release-fixture-captures`. 기존 10월 1일 증거는 덮어쓰지 않고 보존했다.
- DB migration/공개 OpenAPI 검증 PASS. 격리 PostgreSQL 99 migrations, RLS/회사 격리/CAS/자료 철회/문안 저장/자동채움 PASS. `CUNOTE_REQUIRE_WRITING_FLOW_FIXTURES=1` 추가 검증에서 실제 HWPX 3문항·5 revisions·재열기 PASS. 실제 모델/R2/고객 데이터 쓰기 없음. 전체 기관 양식 strict suite는 이번 범위 밖이다.
- 운영 DB의 0094~0098 다섯 migration SHA가 통합본 SQL과 모두 일치함을 read-only transaction으로 확인. 신규 운영 migration 불필요.
- 발견/보완: 회사 자료 API 6개와 회사 자료 페이지를 session route 정책 목록에 추가. 각 API의 기존 requireCompanyAccess/read-write guard 유지. 정책 재검증 171 API/10 cron/7 protected pages PASS.
- 발견/보완: build-dashboard 질문 노출 테스트의 7월 공고가 현재 날짜에 마감되므로 기준일을 7월 15일로 명시. matcher/마감 정책은 변경하지 않음.
- 기존 실패 분리: `evaluate-profile-update-impact.test.ts:130`의 complete industry 기대값(1)과 실제값(0)이 불일치. 원격 main `0a9a141`의 packages/core를 별도 /tmp에 추출해 같은 실패를 재현했다. 해당 테스트/업종 판정 코드는 디자인 브랜치 변경이 아니므로 변경하지 않는다. 나머지 matching-unit 파일은 모두 실행하여 통과를 확인했다.
