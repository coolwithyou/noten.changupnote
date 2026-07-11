# HANDOFF 2026-07-11 — 매칭 데이터 소싱 / dev 검증 하네스

> 같은 날짜의 `HANDOFF-2026-07-11.md`는 **다른 트랙(매칭 차원 확장)** 핸드오프다. 이 파일은 **데이터 소싱** 트랙 전용.

> **🟢 진행 상황 (2026-07-11 · 세션2)**
> - Phase 1 하네스 + Phase 2 data.go.kr 커넥터: 커밋됨(`f89fe4e`).
> - **① data.go.kr 공유키 단일화 + ENV_NICE 교정: 완료·커밋(`c5a71fb`)**.
> - **② NICE BizAPI 커넥터: 완료·커밋(`c5a71fb`)**. 실측 결과 데모앱이 **고정응답이 아니라 실데이터**를 반환(삼성전자 매출 238조 확인). 사업자번호 직결(법인번호 브리지 불필요), 금액 천원→원. OCCD01만 403(미프로비저닝).
> - **③ CODEF 간편인증 스파이크: 미착수(사용자 동반 필수)**. env 4종은 `.env`에 준비됨. 아래 "③ 사용자 수행 절차" 참조.

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

### ① data.go.kr 공유키 단일화 — ✅ 완료(`c5a71fb`)
`resolveDataGoKrServiceKey`를 `apps/web/src/lib/server/dataGoKrServiceKey.ts` 공유 util로 승격. `serviceData.ts` NTS(2곳)·SMPP(1곳) env read를 util로 전환 → kcomwel·FSC와 함께 공용 `CUNOTE_DATA_GO_KR_SERVICE_KEY` 우선 → 소스별 폴백. `ENV_NICE`를 `["NICE_BIZ_CLIENT_APP_KEY","NICE_BIZ_CLIENT_SECRET"]`로 교정. 오버레이 판정 로직 미접촉. 검증: typecheck EXIT 0, `verify:service-data` ok.
- 잔여(선택): ingestion K-Startup/BizInfo 스크립트도 공유키로 통일(이번엔 checklist 범위 밖이라 보류).

### ② NICE BizAPI 커넥터 배선 — ✅ 완료(`c5a71fb`)
`packages/core/src/nicebiz/`(opengate-client + check-corp-indicator[OCOV06] + check-corp-credit[OCCD03/06/01]) 신설, `runNiceConnector`를 `runExternalConnectors`(dev 전용)에만 배선. `FieldSourceRef`에 `"nice"`, `ConnectorResult.note` 추가.
- **실측 갱신(핸드오프 원래 가정과 다름)**: 게이트웨이 버전 세그먼트 `**v1**`(`.../api/opengate/v1/…`), 헤더 `client-id`/`client-secret`. 데모 테스트앱은 **고정응답이 아니라 실데이터** 반환(삼성 OCOV06 매출 238조·부채비율 41.1%). 금액 단위 **천원**(×1000). **OCCD01만 403**(테스트앱 미프로비저닝) → `bond_default` pending. live 행에 `"NICE 데모앱(무계약)"` 표식(고정응답 아님을 감안한 무계약 표식).
- 매핑: OCOV06→revenue·financial_health.*(법인만), OCCD03 pbCnt→국세/지방세 체납(미분리 집계), bbCnt→credit_delinquency/loan_default, fdCnt→financial_misconduct, OCCD06→rehabilitation/court_receivership. `bankruptcy_filed`는 OCCD06 법정관리와 별개축이라 pending.
- **잔여 리스크(프로덕션 승격 시 정리)**: FSC 기업재무(0.85·원단위)와 NICE OCOV06(0.75·천원)가 법인등록번호 브리지(apick 경로)일 때 같은 revenue/financial 키에 경합(Promise.all 완료 순서 의존). 팝빌 경로(브리지 없음)는 NICE가 결정적으로 승리. in-code 주석에 명기. §6′-E 계약에서 소스 우선순위 확정.

### ③ CODEF 간편인증 스파이크 (Track 2) — ⏳ 사용자 동반 필수(미착수)

**세션 단독 불가**: 홈택스 간편인증은 대표자 휴대폰으로 카카오/네이버 승인을 눌러야 하는 2-way라 자동 실행 불가. env 4종(`CODEF_CLIENT_ID/CLIENT_SECRET/PUBLIC_KEY`, `CODEF_ENVIRONMENT=demo`)은 `.env`에 준비 완료.

**사용자 수행 절차(go/no-go 스파이크)**:
1. 실계정 3종 준비: 법인 1 · 일반과세 개인 1 · **간이/면세 개인 1**(각 대표자 본인 명의 휴대폰).
2. `dev/service-data`에 CODEF 섹션이 아직 없으므로, 먼저 CODEF 코어(`packages/core/src/codef/`) + 2-way 세션 구현이 필요(plan: `docs/plans/2026-07-11-codef-l1-demo.md` Phase A/B). 이 구현은 다음 세션에서 착수하되, 실행 검증만 사용자 동반.
3. 3대 가정 측정·기록:
   - (1) **세션 SSO 다상품 1회 인증**: 한 번 인증으로 사업자등록증명 + 부가세과세표준 + (재무제표) 연속 호출되는가.
   - (2) **정식 단가**: 상품별 과금 견적 확인.
   - (3) **개인 부가세과세표준 매출 커버리지**: 특히 간이/면세 개인사업자도 매출이 반환되는가.
   - **GO 판정 = ①∧③ 성립 ∧ ② 수용 가능**.
4. 필드 산출: revenue(개인 확정), founder_age(간편인증 입력 생년월일, 무저장·연령만 파생), tax_compliance(개인 납세증명).
`docs/plans/2026-07-11-codef-l1-demo.md`를 3대 가정 검증으로 축소한 스파이크. 상세: `docs/plans/2026-07-11-matching-data-sourcing.md` §6.
- env: `CODEF_CLIENT_ID/CLIENT_SECRET/PUBLIC_KEY`, `CODEF_ENVIRONMENT=demo`(없으면 추가).
- **단순 조회 아님 — 홈택스 간편인증 2-way**(사용자가 카카오/네이버 승인). 실계정 3종(법인1·일반과세 개인1·**간이/면세 개인1**) + 대표자 본인 휴대폰 필요.
- 3대 가정: (1) 세션 SSO 다상품 1회 인증 (2) 정식 단가(견적) (3) 개인 부가세과세표준 매출 커버리지. GO = ①∧③ ∧ ② 성립.
- 필드: revenue(개인 확정), founder_age(입력), tax_compliance(개인 납세증명).

## 검증 체크리스트
- [x] ① 공유키 하나로 NTS·SMPP·kcomwel·FSC 전부 조회 + `verify:service-data` ok
- [x] ① `ENV_NICE` 교정 → dev 페이지 NICE 필드 "키 있음" 감지
- [x] ② NICE: 실사업자번호로 OCCD/OCOV 파싱 성공(**실데이터**·삼성 238조), 화면 "NICE 데모앱(무계약)" 표식, 유닛 13/13
- [ ] ③ CODEF: 실계정 간편인증 승인 → 부가세과세표준 매출 반환(간이/면세 커버리지), 3대 가정 go/no-go 기록 — **사용자 동반**
- [ ] kcomwel 백엔드 복구 후 재스모크 → employees live 전환
- [ ] (프로덕션 승격 전) 매칭팀과 §6′-E 계약: known_flags "소스→커버 플래그 맵" + positive-only 예외 합의 + FSC↔NICE revenue/financial 소스 우선순위 확정

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
pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/verify-nice-connectors.ts  # NICE 라이브 스모크(삼성 실데이터)
pnpm exec tsx packages/core/src/nicebiz/check-corp-indicator.test.ts && pnpm exec tsx packages/core/src/nicebiz/check-corp-credit.test.ts  # nicebiz 유닛
rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'  # 드리프트 0
# dev 확인(사용자 직접): pnpm -F web dev → http://localhost:3000/dev/service-data (apick provider·법인 조회 시 금융위 법인재무 live)
```
