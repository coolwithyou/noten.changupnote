# HANDOFF 2026-07-11 — CODEF 간편인증 + 데이터 소싱 잔여

> 데이터 소싱 트랙의 **다음 세션 진입점**. 앞선 ①(공유키 단일화)·②(NICE 커넥터)는 완료·커밋(`c5a71fb`)됐고, 남은 것은 **③ CODEF 간편인증**(미착수·사용자 동반)과 소소한 잔여 항목이다.
>
> - 직전 트랙 핸드오프(①②의 배경·검증): `docs/plans/HANDOFF-2026-07-11-data-sourcing.md`
> - **CODEF 상세 계획(단일 원천, 이 핸드오프는 이걸 대체하지 않음)**: `docs/plans/2026-07-11-codef-l1-demo.md` (Phase A~D·아키텍처·DB·오픈 결정·리스크)
> - CODEF 근거 시나리오(공통 스펙 실측·14축 매핑): `docs/research/2026-07-11-codef-field-sourcing-scenario.md`
> - 소싱 설계 원천: `docs/plans/2026-07-11-matching-data-sourcing.md` (§6 CODEF 트랙, §6′-E 계약)

---

## 0. 지금 상태 (fresh 세션이 알아야 할 현실)

- **dev 검증 하네스는 이미 살아있다**: `apps/web/src/app/dev/service-data`(ServiceDataMonitor). 22축 커버리지 대시보드 + 5상태 모델(self-declared/pending/live·cache/failed/n-a) + known_flags Q&A. 외부 커넥터는 `apps/web/src/lib/server/devServiceDataMonitor.ts`의 `runExternalConnectors`(dev 전용)에만 배선. **프로덕션 오버레이 `serviceData.ts`는 §6′-E 계약 전까지 미접촉 원칙**.
- **이미 배선된 커넥터**: 팝빌·NTS·SMPP·Apick(라이브/캐시), kcomwel(15059256), 금융위 기업재무(15043459), **NICE OpenGate**(`packages/core/src/nicebiz/`, OCOV06·OCCD03/06). CODEF는 여기에 **같은 패턴으로 한 소스 더 추가**하는 것.
- **env 준비 완료(중요·핸드오프 원문 정정)**: CODEF 4종이 **루트 `.env`에 이미 있음** — `CODEF_CLIENT_ID`/`CODEF_CLIENT_SECRET`/`CODEF_PUBLIC_KEY`/`CODEF_ENVIRONMENT=demo`. `.env.local` 등록 불필요. 하네스·tsx 스크립트는 `loadMonorepoEnv()`가 `.env.local`+`.env` 양쪽을 로드하므로 그대로 보인다. (codef-l1-demo.md의 "선행 조건: .env.local 등록"은 완료된 것으로 간주)
- **`companyProfileSourceEnum`에 `codef` 이미 존재** → source enum 마이그레이션 불필요(단, `codef_two_way_sessions` 테이블 신설 마이그레이션은 필요).
- **참고 실측(NICE 교훈)**: NICE 데모앱이 "고정응답"일 거란 가정은 라이브 프로브로 반증됐다(실데이터 반환). CODEF도 데모 키(일 100건)로 **실제 국세청 증명 데이터**가 나온다 — 다만 CODEF는 홈택스 **간편인증 2-way**라 대표자 휴대폰 승인이 매 호출에 필요.

## 1. ③ CODEF — 무엇을·어떤 순서로

목표(스파이크 관점): **간편인증 1회로 사업자등록증명 + 부가세과세표준을 연속 호출**해 revenue·region·biz_age·industry·target_type·founder_age를 국세청 확정값으로 채우는 걸 실측하고, 아래 **3대 가정 go/no-go**를 기록한다.

- (1) **세션 SSO**: `id` 파라미터로 **1회 인증에 2~3개 상품 순차 처리**가 실제 되는가 (안 되면 상품마다 승인 2회 폴백).
- (2) **정식 단가**: 상품별 과금 견적(사람 작업 · CODEF 상담).
- (3) **개인 매출 커버리지**: 부가세과세표준이 **간이/면세 개인사업자**도 매출을 반환하는가.
- **GO = ①∧③ 성립 ∧ ② 수용 가능**.

### 권장 실행 경로 (spike-first, 최소 비용)

3대 가정을 검증하려면 CODEF 클라이언트·토큰·2-way·상품 빌더 2종이 **최소한 있어야** 호출이 된다. 그래서 "스파이크"라도 Phase A + 최소 B는 선행이다. 순서:

1. **Phase A (코어, 네트워크 없이 fixture)** — `packages/core/src/codef/`(env/token/rsa/client/two-way/products 2종/normalize/test). codef-l1-demo.md §3 Phase A 표 그대로. **Opus 서브에이전트 위임**(≈600줄), 메인은 설계 검수.
2. **Phase B 최소분(오케스트레이션 + 마이그레이션)** — `codef_two_way_sessions` 마이그레이션(`db:generate`→`db:migrate`, `db:push` 금지), `session-store.ts`, `orchestrator.ts`(startSimpleAuth/completeSimpleAuth), 민감정보 마스킹. **Opus 위임**.
3. **CLI 스파이크 하네스(Phase C UI보다 먼저)** — `scripts/verify-codef.ts`: 인자로 name/birth8/phone/telecom/authApp/bizNo 받아 1차 POST → `CF-03002` 뜨면 "앱에서 승인 후 Enter" 프롬프트 → 2차 POST(is2Way) → 같은 `id`로 부가세과세표준 연속 호출 → 3대 가정 결과 출력. **이게 UI 없이 go/no-go를 돌리는 최소 무대**.
4. **사용자 동반 라이브 런(D1)** — 사용자가 실계정 **3종(법인 1·일반과세 개인 1·간이/면세 개인 1)** + 대표자 휴대폰으로 3번 CLI 실행. 세션이 각 실행의 3대 가정을 기록. **여기서만 사용자가 필요**.
5. **GO면 Phase C(데모 UI)·D 잔여로 확장** — ServiceDataMonitor에 CODEF 섹션(shadcn 스킬 우선, 드리프트 0). NO-GO면 폴백(상품 축소/승인 2회) 확정 후 재판단.

> 대안: Phase C UI를 B와 함께 만들어 사용자가 브라우저로 D1을 돌리게 할 수도 있으나, 승인 대기·2-way UX가 커서 **CLI 스파이크로 가정부터 깨는 걸 권장**. UI는 GO 확인 후.

### CODEF 공통 스펙 요약 (재리서치 방지 · 상세는 시나리오 문서 §0)

- 토큰: `POST https://oauth.codef.io/oauth/token` Basic 인증, `grant_type=client_credentials`, **accessToken 7일** → DB 캐시.
- 엔드포인트 베이스: demo `https://development.codef.io` / prod `https://api.codef.io` (`CODEF_ENVIRONMENT`로 분기).
- 상품: 사업자등록증명 `/v1/kr/public/nt/proof-issue/corporate-registration`, 부가세과세표준 `/v1/kr/public/nt/proof-issue/additional-taxstandard`, (선택)재무제표 `/v1/kr/public/nt/proof-issue/standard-financial-statements`(08~22시만·IP 차단 경고).
- 응답: `{result:{code,message,transactionId}, data:{…}}`, 성공 `CF-00000`, **전문 URL-encoded JSON(decode 필수)**. 2-way: 1차 → `CF-03002`+`continue2Way` → `jobIndex/threadIndex/jti/twoWayTimestamp` 보관 → 승인 후 1차 파라미터+`is2Way=true`+twoWayInfo 재요청. 제한시간 간편인증 4분30초, **제한시간 내 동일계정 재요청 차단**.
- RSA: `CODEF_PUBLIC_KEY`(Base64 DER)로 `crypto.publicEncrypt`(PKCS1) — 인증서 비번용(간편인증 경로는 사실상 불필요하나 유틸은 A2에서 구현).
- 개인정보 최소화: 주민번호 뒷자리 `isIdentityViewYN="0"`, 생년월일·전화는 무저장(세션 완료/만료 시 snapshot NULL), 성별은 UI 1탭 입력(founder_trait), 로그 마스킹.
- **오픈 결정(구현 중 확정)**: `usePurposes`/`submitTargets` 값(99:기타로 시작), founder_age/trait source enum(`codef` vs `self_declared`) — codef-l1-demo.md §5 참조.

## 2. 잔여 항목 (CODEF 외)

- [ ] **kcomwel 502 재스모크** — 근로복지공단 게이트웨이 장애(우리 코드 아님)였음. 복구 후 `scripts/verify-datago-connectors.ts` 재실행 → `employees`·`insured_workforce.*` live 전환 확인.
- [ ] **FSC↔NICE revenue/financial 소스 우선순위 확정** — 법인등록번호 브리지(apick 경로)일 때 두 커넥터가 같은 키에 경합(팝빌 경로는 NICE 결정적 승리). in-code 주석에 명기됨. **§6′-E 계약 때 소스 우선순위 규칙으로 정리**.
- [ ] **§6′-E known_flags 계약(매칭팀)** — "소스→커버 플래그 맵" + positive-only 예외 합의. **프로덕션 오버레이 승격 전제**(이 계약 전까지 `serviceData.ts` 미접촉).
- [ ] (선택) **ingestion K-Startup/BizInfo 공유키 통일** — ①에서 checklist 밖이라 보류. `CUNOTE_DATA_GO_KR_SERVICE_KEY`로 통일 가능.
- [ ] (정리) `scripts/spikes/datago-finance-probe*.ts` — 발굴용 임시(공개 기업번호만). 미커밋 untracked. 사용자가 삭제 가능.

## 3. 가드레일 (반복 · CLAUDE.md + 트랙 규칙)

- **프로덕션 격리**: CODEF는 `api/dev/codef/*`·dev 하네스에만. `serviceData.ts` 오버레이 체인은 §6′-E 전까지 손대지 말 것.
- **dev 서버는 사용자 소유**: 세션이 `pnpm dev` 백그라운드 기동 금지. 화면 확인 필요 시 사용자에게 요청.
- **마이그레이션**: `pnpm db:generate` → `pnpm db:migrate` 순서. `db:push` 금지. generate에 기존 객체 재생성 섞이면 SQL에서 제거(0018~0025 전례).
- **UI(Phase C)**: `.claude/skills/shadcn` 스킬 최우선, primitive는 `npx shadcn@latest add`, 토큰만 사용, 드리프트 스캔 0 유지(`rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'`).
- **민감정보**: 생년월일·전화·주민번호·certPassword·토큰은 로그 금지. `request_snapshot`은 완료/실패/만료 즉시 NULL. 동의는 `consents.hometax`.
- **위임**: Phase A·B 구현은 Opus 서브에이전트, 메인(Fable)은 설계·검수. 장기 리뷰는 Codex.
- **병렬 세션**: `apps/admin/*`, `_p5_*`, `HANDOFF-2026-07-11.md`(차원 확장 트랙)는 무관 — 건드리지 말 것. **`git add -A` 금지, 명시 스테이징**, add·commit은 한 호출에.
- **git 쓰기 전**: `mkdir -p .git/stale-locks && mv .git/*.lock .git/stale-locks/ 2>/dev/null || true`. author `git -c user.name="coolwithyou" -c user.email="sw@ba-ton.kr"`. **Co-Authored-By 금지**(전역 규칙).
- **착수 전 관문 의례**: `docs/research/CALIBRATION-TEMPLATE.md`(마스터 설계 17장) — CODEF 착수 전 외부 SOTA 대조.

## 4. 검증 체크리스트 (CODEF)

- [ ] Phase A: `pnpm -F @cunote/core build` EXIT 0 + codef 유닛(fixture 기반 정규화·2-way 전이) 통과
- [ ] Phase B: 마이그레이션 적용 + `pnpm -F web typecheck`/`build` EXIT 0 + `verify:codef` 토큰 발급 스모크 ok
- [ ] CLI 스파이크: 사업자등록증명 2-way 승인 → `CF-00000` 정규화 성공(개인정보 마스킹 확인)
- [ ] **D1 사용자 런**: 실계정 3종 간편인증 → 3대 가정 go/no-go 기록(세션 SSO 실동작·간이/면세 매출 커버리지·단가)
- [ ] GO 시 Phase C: dev 페이지 CODEF 섹션에서 `source=codef`·라이브/캐시 뱃지로 7축 병합 표시, 드리프트 0

## 자주 쓰는 커맨드
```bash
pnpm -F @cunote/core build && pnpm -F web typecheck && pnpm -F web build   # 코어 dist + 타입/빌드
pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/verify-nice-connectors.ts   # NICE 라이브 스모크(참조 패턴)
# (신설 예정) pnpm exec tsx --tsconfig apps/web/tsconfig.json scripts/verify-codef.ts <name> <birth8> <phone> <telecom> <authApp> <bizNo>
pnpm verify:service-data   # 프로덕션 회귀(ok, 미종료라 출력 완주로 판정)
rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'   # 드리프트 0
```
