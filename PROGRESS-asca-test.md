# 아스카웍스 테스트 계정 검증

## 목표와 완료 조건

- 제공된 사업자등록증으로 테스트 계정을 만들고, 문서로 확인되는 회사 사실만 입력한다.
- 로그인 → 회사 저장 → 매칭 목록 → 공고 상세를 실제 브라우저에서 확인한다.
- discovery source evidence가 들어간 현재 작업 브랜치를 브라우저에서 확인한다. 현재 서버 실행은 사용자 소유다.
- 미확인 기업·공고 조건을 충족으로 판정하지 않는다.

## 2026-09-27 실행 기록

- [x] PDF 1쪽 렌더·육안 확인: 법인, 서울, 2026-08-27 개업, 광고 대행·응용 소프트웨어 개발 및 공급·미디어콘텐츠창작 업종. 사업자번호·주소 원문은 이 문서에 기록하지 않는다.
- [x] `asca-works-20260927@example.test` 테스트 계정 등록 HTTP 201; 비밀번호는 macOS Keychain `cunote-asca-test-20260927`에만 저장. 로그인 세션 확인.
- [x] 4010의 사용자 실행 서버에서 사업자 조회와 기본정보 입력. 조회 단계는 서울을 표시했으나 업력과 소프트웨어·미디어 업종을 누락했다. PDF 확인값으로 업력 1개월, 업종 3개, 법인 형태를 입력했다.
- [x] 회사 저장 후 대시보드와 공고 상세를 브라우저로 열었다. 대시보드에는 전체 46건, `답하면 확정` 2건, `지금 가능` 0건이 표시됐다. 원주권 커뮤니티 데이 상세는 `충족 확인 0 · 미충족 0 · 미확인 1`과 `공고 조건 확인`으로 표시됐다.
- [x] 회사 재조회 시 업종·업력·법인 형태는 유지됐으나 서울 소재지는 화면에서 `미입력`으로 바뀌었다. 재입력은 공식 API 값 수정 금지 오류로 거부됐다. 4010은 메인 checkout의 구버전 서버다.
- [x] read-only `/api/web/companies`에서 회사 프로필의 서울 값과 Popbill shared authoritative evidence가 실제 저장된 것을 확인했다. 작업 브랜치의 `resolveProductCompanyProfileWithoutCorrections(owned_read)` read-only 호출에서는 서울이 `applied`, `popbill_cache consumed`로 확인됐다. 따라서 현재 4010 UI의 결손은 저장 실패가 아니라 구버전 읽기 경로의 누락이다. 작업 브랜치의 브라우저 표시는 별도 검증이 필요하다.
- [x] 작업 브랜치의 read-only `loadOwnedCompanyMatching`에서 서울은 `known`, 화면 후보 8건, `recommendable` 0건. 인도 BTS는 `verified` 후보에 포함됐고, `discovery` 후보인 2026 글로컬 Angelwave IR Camp는 `needs_core_review/conditional`이었다. 후보와 추천 가능 건수를 혼동하지 않는다.
- [x] Angelwave의 source revision 결속 원문은 신청 대상을 호남권 창업기업으로 표시했다. 서울 소재 회사에는 중요한 지역 조건인데 기존 discovery 상세 회사 사실에 소재지가 빠져 있었다. 작업 브랜치의 상세 표시·계약에 소재지와 지역 확인 항목을 추가했다. 변경 후 같은 회사의 원문 상세 read-only 검증에서 `companyRegion=서울`, `회사 소재지와 공고의 지역 조건`, 호남권 대상 발췌가 함께 반환됐다. 이 변경은 자동 자격 탈락 판정이 아니다.
- [x] 변경 검증: source evidence test, SSR render test, `pnpm build:web`(패키지 build·web TypeScript·Next build 포함), `pnpm verify:openapi`(28 paths), `pnpm verify:service-usecases`, `git diff --check` PASS. Next build의 기존 NFT 추적 경고 2건은 종료 코드 0으로 완료됐다.
- [ ] 작업 브랜치 4012 서버의 실제 후보 목록과 source evidence 상세 브라우저 검증. 마지막 확인 시 4012 listener 없음. 프로젝트 규칙상 사용자가 서버를 시작하며, 시작 명령은 이미 요청했다.

## 위험과 경계

- 4010은 작업 브랜치가 아니므로 새 discovery evidence UI 검증 결과로 인정하지 않는다.
- `답하면 확정`은 질문을 채우면 검토가 진전된다는 제품 표기다. 원주권 공고를 지원 가능으로 확인한 증거가 아니다.
- Angelwave는 현재 서울 회사에 지역 조건이 맞지 않을 가능성이 높으나, 원문 해석·예외 확인 전에는 `미충족 확정`으로 자동 변경하지 않았다. 현 단계의 개선은 조건을 드러내는 데 한정한다.
- 결격, 수혜 이력, 규모, 매출, 직원 수 등 PDF에 없는 사실은 입력하지 않았다.
- 테스트 계정과 회사 정보는 현재 공유 원격 DB에 남아 있다. 계정 정리나 실제 운영 쓰기는 별도 범위에서 판단한다.
- 진단 중 로컬 환경변수 파일의 일부 비밀값이 일회성 도구 출력에 노출됐다. 이 문서·Git에는 기록하지 않았다. 출력 보존 범위를 확인해 해당 값의 교체 필요성을 판단해야 한다.
