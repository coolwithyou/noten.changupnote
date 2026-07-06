# Desktop Codex Handoff

이 문서는 브라우저 접근이 가능한 데스크탑 Codex에서 창업노트 SaaS UX QA를 이어가기 위한 인수인계다.

## 현재 상태

- 작업 루트: `/Users/ffgg/noten.works/cunote`
- QA 문서: `docs/ux-audits/2026-07-01-saas-product-qa/README.md`
- 스크린샷 저장 폴더: `docs/ux-audits/2026-07-01-saas-product-qa/screenshots/`
- 로컬 서버는 사용자가 직접 띄운다. Codex는 명시 요청 없이 `pnpm dev:web`, `pnpm dev`, `next dev`를 시작하지 않는다.
- 직전 세션에서는 `127.0.0.1:4010` 서버가 이미 떠 있었다.
- Popbill 유료 조회는 QA 중 0회 실행했다.

## 이미 완료한 코드/UX 개선

- 인증: mock이 아닌 환경에서 NextAuth demo provider가 노출되지 않게 정리.
- 계정: 프로필/비밀번호/삭제 요청 오류를 입력 필드와 연결.
- 설정: 동의/알림 스위치 접근성 이름, status live region, 사업자번호 10자리 정규화, 캐시 우선 조회 카피 보강.
- 랜딩: 티저 성공 후 결과 영역 스크롤/포커스, 카드 상세 링크, 비식별 funnel event API 추가.
- 매칭: 근거가 약한 eligible 카드는 `추정 적격`으로 표시.
- 신청/초안: 상태 이동, 저장, 검토, 다운로드 시작 후 `role="status"` 메시지 추가.
- 성능: 앱 DB pool 기본값을 4로 조정하고 `CUNOTE_DB_MAX_CONNECTIONS` 추가.
- 과금/보안: Popbill 직접 조회 가능한 `/internal/live-match`와 `/api/matches/live`를 관리자 전용으로 제한.

## 이미 통과한 검증

- `pnpm test`
- `git diff --check`
- `CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http`
- `pnpm verify:route-policy`
- `pnpm verify:admin-routes`
- `pnpm verify:runtime-repositories`
- `pnpm verify:company-enrichment`
- `pnpm verify:saas-readiness`
- `pnpm verify:app-auth`

## 데스크탑 Codex에서 이어갈 작업

1. 현재 서버 확인:
   - `lsof -nP -iTCP:4010 -sTCP:LISTEN`
   - 서버가 없으면 사용자에게 실행을 요청한다.

2. 브라우저 캡처 QA:
   - Product Design `audit` 스킬 지침대로 Browser 또는 Chrome으로 캡처한다.
   - 캡처 대상:
     - `/`
     - `/login`
     - `/dashboard`
     - `/account`
     - `/settings`
     - `/team`
     - `/billing`
     - `/applications`
     - `/grants/fd6c5a46-0e36-4628-bdbf-675f42015895`
   - desktop과 mobile viewport를 모두 확인한다.
   - 저장 파일 예:
     - `screenshots/01-home-desktop.png`
     - `screenshots/01-home-mobile.png`
     - `screenshots/02-login-desktop.png`

3. 실제 플로우에서 확인할 것:
   - 랜딩 티저 결과 영역으로 스크롤/포커스가 이동하는지.
   - 로그인 화면에서 demo provider가 보이지 않는지.
   - `/account` 필드 오류가 해당 입력 옆에서 보이는지.
   - `/settings` 회사정보 보강 카피가 캐시 우선 흐름으로 이해되는지.
   - `/dashboard` 기회 맵의 필터/카드 밀도가 모바일에서 과하지 않은지.
   - 공고 상세에서 신청 준비, AI 초안, 다운로드 상태 메시지가 충분히 보이는지.
   - `/applications`에서 상태 이동과 저장 완료 메시지가 사용자가 놓치지 않을 위치에 있는지.

4. Popbill 주의:
   - 일반 화면 QA 중 Popbill 유료 조회를 실행하지 않는다.
   - 사업자번호 보강을 실제로 눌러야 하면 운영 캐시가 있는 테스트 사업자번호로 1회만 실행하고, 재조회는 캐시 hit를 확인한다.
   - `/api/matches/live`는 관리자 전용 경계 확인만 하고 실행하지 않는다.

5. 문서 갱신:
   - 캡처를 저장한 뒤 `README.md`의 `캡처와 실행 한계`, `요구사항별 완료 증거`, `남은 QA 항목`을 갱신한다.
   - 캡처 기반 발견 사항은 단계 번호와 스크린샷 파일명을 함께 남긴다.

6. 최종 검증:
   - `pnpm test`
   - `git diff --check`
   - 필요 시 `CUNOTE_HTTP_VERIFY_BASE_URL=http://127.0.0.1:4010 pnpm verify:web-http`

## 완료 기준

- desktop/mobile 스크린샷이 `screenshots/`에 저장되어 있다.
- 각 핵심 화면/플로우의 UX, 디자인, 접근성 리스크가 스크린샷 증거와 연결되어 있다.
- `README.md`에서 `실제 브라우저 화면 QA`와 `desktop/mobile 시각 QA` 판정이 `충족` 또는 구체적 잔여 리스크로 갱신되어 있다.
- Popbill 유료 조회가 0회 또는 명시된 1회 이내로 유지되었다.
- 검증 명령이 통과했다.
