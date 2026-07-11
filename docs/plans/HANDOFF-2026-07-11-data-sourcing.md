# HANDOFF 2026-07-11 — 매칭 데이터 소싱 / dev 검증 하네스

> 같은 날짜의 `HANDOFF-2026-07-11.md`는 **다른 트랙(매칭 차원 확장)** 핸드오프다. 이 파일은 **데이터 소싱** 트랙 전용.

## 목표
사업자등록번호로 매칭 22개 차원을 채우는 소싱 전략을, 프로덕션 반영 전에 `dev/service-data` 페이지(검증 하네스)에서 소스별로 검증한다. 키가 들어오는 대로 커넥터를 붙여 "실제 데이터가 들어오는지 / 키 없으면 대기 / 데이터 어긋나면 실패"를 확인한 뒤 프로덕션 로직에 승격.
- 설계 원천: `docs/plans/2026-07-11-matching-data-sourcing.md` (22축↔소스, 트랙, §6′-E 계약)
- 키 가이드: `docs/plans/2026-07-11-sourcing-keys-acquisition-guide.md` / 레퍼런스: `docs/plans/2026-07-11-sourcing-keys-manifest.md`
- 차원 정의(매칭팀 소유, 이미 머지됨 22축): `docs/plans/2026-07-11-matching-dimension-expansion.md`

## 완료된 것 (전부 **워킹트리에만 있음 — 커밋 안 됨**)
- **설계 문서 3종 신규**: 위 sourcing/manifest/guide. data.go.kr 실검증·Phase 2 실측 반영 완료.
- **Phase 1 하네스** (`apps/web/src/lib/server/devServiceDataMonitor.ts`, `apps/web/src/features/dev/ServiceDataMonitor.tsx`, `apps/web/src/app/dev/service-data/page.tsx`): 22축+하위 30행 커버리지 대시보드 + 5상태 모델(self-declared/pending/live·cache/failed/n-a) + 결격 known_flags 자가신고 Q&A. 검증: typecheck·build 통과, 드리프트 0.
- **Phase 2 data.go.kr 커넥터**(신규 core, **dev 하네스에서만 호출·프로덕션 `serviceData.ts` 미접촉**):
  - `packages/core/src/kcomwel/check-employment.ts` (15059256) — 사업자번호→상시인원. **라이브 실측: 게이트웨이 502(근로복지공단 백엔드 장애 추정). 파서는 fixture 검증됨. 재스모크 필요.**
  - `packages/core/src/fsc/check-corp-finance.ts` (15043459) — **✅ 라이브 성공**(삼성전자 실데이터: 매출 238조·부채비율 41.12%·자본금 반환). 조회키=법인등록번호.
  - `packages/core/src/fsc/check-personal-finance.ts` (15108171) — **실측 반증: 익명 집계 통계셋, 사업자번호 조회 불가 → schemaMismatch(failed).** 개인 재무·매출은 CODEF 경로.
  - `packages/core/src/index.ts`(export 3줄), `scripts/verify-datago-connectors.ts`(재사용 스모크).
  - 공유키 헬퍼 `resolveDataGoKrServiceKey`(devServiceDataMonitor.ts:890): `CUNOTE_DATA_GO_KR_SERVICE_KEY` → 소스별 변수 폴백.
- **검증 증거**: `pnpm -F web typecheck` ✓, `pnpm -F web build` EXIT 0, 커넥터 유닛 16 케이스 ✓, `pnpm verify:service-data` ok, 드리프트 0.
- **사용자 `.env.local` 보유 키**: data.go.kr(`CUNOTE_SMPP/KCOMWEL/FSC_FINANCE_SERVICE_KEY`, 전부 동일 개인 인증키), CODEF(`CODEF_CLIENT_ID/CLIENT_SECRET/PUBLIC_KEY`), NICE(`NICE_BIZ_CLIENT_APP_KEY`/`NICE_BIZ_CLIENT_SECRET`). ⚠️ `CUNOTE_NTS_SERVICE_KEY` 세팅 여부 미확인.

## 남은 작업 (순서대로)

### ① data.go.kr 공유키 단일화
NTS·SMPP(및 ingestion K-Startup/BizInfo)도 `CUNOTE_DATA_GO_KR_SERVICE_KEY` 우선 → 소스별 변수 폴백으로 통일(키 하나만 관리).
- 대상: `apps/web/src/lib/server/serviceData.ts` NTS/SMPP env read(NTS ~:573,:656 / SMPP ~:751, 상수 :49,:54). `resolveDataGoKrServiceKey`를 공유 util로 승격해 재사용.
- **동시에**: 하네스 NICE 키 감지 상수 `ENV_NICE`(devServiceDataMonitor.ts:550)를 `["NICE_BIZ_CLIENT_APP_KEY","NICE_BIZ_CLIENT_SECRET"]`로 교정(현재 `NICE_CLIENT_ID`라 사용자 키를 "키 없음"으로 오판).
- 주의: env **읽기 방식만** 변경. 오버레이 판정 로직 미접촉.
- 검증: `pnpm -F web typecheck && pnpm verify:service-data`(ok 유지).

### ② NICE BizAPI 커넥터 배선
신규 `packages/core/src/nice/`(OpenGate 클라이언트 + OCCD01/03/06 + OCOV06). `runExternalConnectors`(devServiceDataMonitor.ts:928)에만 연결.
- env: `NICE_BIZ_CLIENT_APP_KEY`/`NICE_BIZ_CLIENT_SECRET`. 게이트웨이 `https://api.nicebizline.com/api/opengate`. **정확한 인증 헤더명은 NICE OpenGate 문서 확인**(App Key→헤더 매핑).
- 조회키=사업자번호(companyKey 자동판별) — **법인번호 브리지 불필요**(금융위와 다름).
- 필드: tax_compliance(법인 체납 OCCD03), credit_status(법인 채무불이행·부도·법정관리 OCCD03/06/01), revenue/financial 폴백(OCOV06). 스펙: `docs/research/nicebiz-api-specs/`.
- **함정: 데모 테스트앱=고정 샘플 응답** → live로 뜨지만 값이 실기업 아님. 화면에 "데모 고정응답" 표식. 실데이터는 계약 후.

### ③ CODEF 간편인증 스파이크 (Track 2)
`docs/plans/2026-07-11-codef-l1-demo.md`를 3대 가정 검증으로 축소한 스파이크. 상세: `docs/plans/2026-07-11-matching-data-sourcing.md` §6.
- env: `CODEF_CLIENT_ID/CLIENT_SECRET/PUBLIC_KEY`, `CODEF_ENVIRONMENT=demo`(없으면 추가).
- **단순 조회 아님 — 홈택스 간편인증 2-way**(사용자가 카카오/네이버 승인). 실계정 3종(법인1·일반과세 개인1·**간이/면세 개인1**) + 대표자 본인 휴대폰 필요.
- 3대 가정: (1) 세션 SSO 다상품 1회 인증 (2) 정식 단가(견적) (3) 개인 부가세과세표준 매출 커버리지. GO = ①∧③ ∧ ② 성립.
- 필드: revenue(개인 확정), founder_age(입력), tax_compliance(개인 납세증명).

## 검증 체크리스트
- [ ] ① 공유키 하나로 NTS·SMPP·kcomwel·FSC 전부 조회 + `verify:service-data` ok
- [ ] ① `ENV_NICE` 교정 → dev 페이지 NICE 필드 "키 있음" 감지
- [ ] ② NICE: 실사업자번호로 OCCD/OCOV 파싱 성공(데모 고정응답), 화면 데모 표식
- [ ] ③ CODEF: 실계정 간편인증 승인 → 부가세과세표준 매출 반환(간이/면세 커버리지), 3대 가정 go/no-go 기록
- [ ] kcomwel 백엔드 복구 후 재스모크 → employees live 전환
- [ ] (프로덕션 승격 전) 매칭팀과 §6′-E 계약: known_flags "소스→커버 플래그 맵" + positive-only 예외 합의

## 주의 / 함정
- **프로덕션 격리**: 신규 커넥터는 `runExternalConnectors`에서만. `serviceData.ts` 오버레이 체인은 §6′-E 계약 전까지 손대지 말 것.
- **kcomwel 502**: 우리 코드 아님(근로복지공단 게이트웨이). 재스모크로 확인.
- **15108171 쓰지 말 것**: 익명 집계셋(사업자번호 무관 동일 응답). 개인 재무=CODEF.
- **법인재무 브리지=apick만**: 팝빌은 법인등록번호 미제공 → 금융위 법인재무는 apick provider 경로에서만 live. 넓게 켜려면 무료 법인번호 소스 별도 과제(설계 §9).
- **NICE 데모=고정응답**: 구조 검증까지만, 실값 아님.
- **dev 서버는 사용자 소유**: 세션이 `pnpm dev` 백그라운드 기동 금지. 필요 시 사용자에게 요청.
- **병렬 세션**: `apps/admin/*`, `_p5_*`, `HANDOFF-2026-07-11.md`(차원 확장 트랙) 등 무관 modified 파일 다수 — 건드리지 말 것. **`git add -A` 금지, 명시 스테이징**, add·commit은 한 호출에.
- **커밋 전 stale-lock**: `mkdir -p .git/stale-locks && mv .git/*.lock .git/stale-locks/ 2>/dev/null || true`. author `git -c user.name="coolwithyou" -c user.email="sw@ba-ton.kr"`. **아직 아무것도 커밋 안 됨.**
- **`verify:service-data` 미종료**: 통과해도 프로세스 안 죽음 → 출력 완주로 판정.
- 정리 위임: `scripts/spikes/datago-finance-probe*.ts`(발굴용 임시, 공개 기업번호만) 사용자 삭제 가능.

## 실행 중 백그라운드 작업
없음 (Phase 1·2 빌드 서브에이전트 모두 완료).

## 자주 쓰는 커맨드
```bash
pnpm -F @cunote/core build && pnpm -F web typecheck && pnpm -F web build   # 코어 dist + 타입/빌드
pnpm verify:service-data                                                    # 프로덕션 회귀(ok, 미종료라 출력 완주로 판정)
rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'  # 드리프트 0
# dev 확인(사용자 직접): pnpm -F web dev → http://localhost:3000/dev/service-data (apick provider·법인 조회 시 금융위 법인재무 live)
```
