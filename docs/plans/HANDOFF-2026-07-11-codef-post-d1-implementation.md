# HANDOFF 2026-07-11 — CODEF post-D1 구현 가이드 (새 세션 진입점)

> **이 문서는** CODEF 간편인증 트랙의 **D1(사용자 동반 라이브 런) 부분 성공 이후** 남은 구현을 새 세션이 이어받는 진입점이다. 스파이크(코어+CLI)는 완주됐고, D1이 **사업자등록증명으로 전 인증 플로우를 실증**했다. 남은 것은 ①D1 완주(부가세 상품 신청 후 재실행) ②Phase B(오케스트레이션+마이그레이션) ③Phase C(dev UI)다.
>
> **선행 문서(계보):**
> - 상세 플랜(단일 원천): `docs/plans/2026-07-11-codef-l1-demo.md` (Phase A~D 표·DB·오픈결정·리스크)
> - spike-first 경로 핸드오프: `docs/plans/HANDOFF-2026-07-11-codef-and-residual.md` (상단 🟢 blockquote + D1 가이드)
> - 관문 대조: `docs/research/2026-07-11-CODEF-착수전-외부대조.md`
> - 소싱 시나리오(14축 매핑·공통 스펙): `docs/research/2026-07-11-codef-field-sourcing-scenario.md`
> - 소싱 아키텍처 원천: `docs/plans/2026-07-11-matching-data-sourcing.md` (§6 CODEF, §6′-E 계약)

---

## 0. TL;DR (새 세션이 30초에 알아야 할 것)

- **동작 확인됨(실측)**: `pnpm verify:codef` → 사업자등록증명 `CF-00000` 성공. 토큰·2-way(CF-03002)·카카오 승인·is2Way 재요청·국세청 데이터 수신·정규화 전부 OK. **주민번호 없이 사업자번호(`identity`)만으로 발급** — 프라이버시 설계 성립.
- **블로커(사용자 처리 중)**: 부가세과세표준 `CF-00003`(상품 미신청). 사용자가 CODEF 콘솔에서 "부가가치세 과세표준증명" 신청 중. 승인되면 D1 완주.
- **코어·CLI 완성**: `packages/core/src/codef/`(10모듈, build 0·test 20/20), `scripts/verify-codef.ts`(`pnpm verify:codef`). 커밋 `82beb6e`·`d5e377b`·`3524a8c`·`475621d`·`15cd9cc`·`d414141`.
- **✅ Phase B·C 완주(2026-07-12 세션4, Fallback 경로)**: D1 세션모델 미확정이지만 런북대로 **양쪽 SSO 경로·방어 VAT 필드탐색**을 구현해 D1 대기 없이 완주. 마이그레이션 `0042_lumpy_epoch`(운영 Supabase apply 성공) + `session-store`/`orchestrator` + dev API 2본 + `CodefSimpleAuthPanel`/`runCodefConnector`(국세청 7축 병합·codef 최우선). 게이트: core build 0·web typecheck 0·web build 0·드리프트 신규 0. 커밋 `2a6fb16`(B1)·`0636211`(B2-B5)·`c32b510`(C). 상세 상태·D1 튜닝 훅: `docs/research/2026-07-12-codef-D1-fallback-상태.md`.
- **남은 것**: 사용자 동반 D1 3종 실측(①SSO ③개인매출 ②단가) + dev 서버 E2E 시각검수 → 결과로 `CODEF_VAT_SSO_MODE`·`TAX_BASE_*_KEYS` 튜닝. 프로덕션 `serviceData.ts` 오버레이는 §6′-E 계약 전까지 미접촉.
- **§2의 CODEF 필드 계약은 D1 실측으로 확정된 값 — 재조사 금지, 그대로 신뢰.**

---

## 1. 지금까지 (검증된 사실 + 커밋)

| 단계 | 산출 | 검증 | 커밋 |
|---|---|---|---|
| 관문 의례 | `docs/research/2026-07-11-CODEF-착수전-외부대조.md` | SDK 실측 교차검증, 재설계 불필요 | `82beb6e` |
| Phase A 코어 | `packages/core/src/codef/` 10모듈 | `@cunote/core` build 0, `codef.test.ts` 20/20(오프라인) | `82beb6e` |
| CLI 스파이크 | `scripts/verify-codef.ts` + `pnpm verify:codef` | dry-run·no-args·PASS 분기 스모크 | `d5e377b`·`3524a8c` |
| decode 픽스 | 응답 form-decode(+→공백) | D1에서 발견, build 0·20/20 | `475621d` |
| 필드 계약 교정 | loginIdentity/identity·VAT 기간·앱코드 | D1 CF-12850 후, 개발가이드 실측 | `15cd9cc` |
| VAT 실패 격리 | 부분성공 리포트 보존 | D1 CF-00003 후 | `d414141` |

**D1 라이브 런 이력:**
- 1차(`한송욱`/`7465400870`/카카오): `CF-12850`(주민번호/사업자번호 미입력) → 필드 매핑 버그 발견·수정.
- 2차(교정 후): 사업자등록증명 **`CF-00000` 성공**(카카오 승인 완료). 부가세과세표준 **`CF-00003`**(상품 미신청) → 사용자 신청 중.

---

## 2. CODEF 필드 계약 (D1 실측 확정 — 이게 이 트랙의 핵심 자산)

> 개발가이드가 Vue SPA라 정적 대조 불가였고, **D1 라이브 런과 사용자가 붙여준 요청항목 표로 아래를 확정**했다. 새 세션은 이 표를 그대로 신뢰하고 다시 조사하지 말 것. 코드 위치: `packages/core/src/codef/request-params.ts`, `products/*.ts`, `client.ts`.

### 2.1 인증·전송 (client.ts, token.ts)
- 토큰: `POST https://oauth.codef.io/oauth/token`, `Authorization: Basic base64(clientId:clientSecret)`, body `grant_type=client_credentials&scope=read`, 응답 `access_token`·`expires_in≈604799`(7일). DB 캐시 대상.
- base URL: demo `https://development.codef.io` / prod `https://api.codef.io` (`CODEF_ENVIRONMENT`).
- **양방향 URL 인코딩(로드베어링)**: 요청 body = `encodeURIComponent(JSON.stringify(body))`. 응답 = `JSON.parse(decodeURIComponent(raw.replace(/\+/g,"%20")))`. CODEF 백엔드는 Java URLEncoder(공백=`+`)라 `+`→공백 치환 필수(`475621d`에서 확정).
- 헤더: `Content-Type: application/json`, `Authorization: Bearer <token>`.

### 2.2 간편인증 요청 파라미터 (loginType="5") — **D1 확정**
| 필드 | 값 | 비고 |
|---|---|---|
| `organization` | `"0001"` | 국세청 홈택스 고정값(확정) |
| `loginType` | `"5"` | 회원 간편인증 |
| `loginTypeLevel` | 앱코드 | **1:카카오톡 3:삼성패스 4:KB모바일 5:통신사(PASS) 6:네이버 7:신한 8:toss 9:뱅크샐러드 10:NH 11:우리**. ⚠️ **"2"(페이코)는 없음** |
| `userName` | 이름 | |
| `phoneNo` | 휴대폰(숫자) | |
| **`loginIdentity`** | **생년월일 8자리 yyyyMMdd** | ⚠️ **여기가 생년월일**(loginType=5). 초기 버그: identity에 넣어 CF-12850 |
| **`identity`** | **사업자번호 10자리** | ⚠️ **여기가 사업자번호**. 특정 사업장 조회, **미입력시 홈택스 전체조회**. 주민번호 대신 이걸로 → 프라이버시 성립 |
| `telecom` | 통신사코드 | loginTypeLevel="5"(PASS)일 때만. 0:SKT 1:KT 2:LGU+ |
| `isIdentityViewYN` | `"0"` | 주민 뒷자리 비공개 |
| `usePurposes` | `"99"` | 필수(O), 기타 |
| `submitTargets` | `"99"` | 필수(O), 기타 |
| `id` | 세션 SSO 키 | 사용자별 고유값. 있으면 1회 인증으로 다건 순차 처리 |
| `birthDate` | (미사용) | identityEncYn="Y"(주민 뒷자리 암호화)일 때만 yymmdd. 우리 경로 불필요 |

### 2.3 상품 엔드포인트·CF 코드
| 상품 | API 경로 | 상태 |
|---|---|---|
| 사업자등록증명 | `/v1/kr/public/nt/proof-issue/corporate-registration` | ✅ 신청·동작 확인 |
| 부가세과세표준 | `/v1/kr/public/nt/proof-issue/additional-taxstandard` | ⏳ 신청 대기(CF-00003) |
| 표준재무제표(선택) | `/v1/kr/public/nt/proof-issue/standard-financial-statements` | 미신청·08~22시·IP차단 주의 |

- **부가세과세표준 추가 필수 파라미터**: `startDate`/`endDate` = `yyyyMM`(O). MM은 `"01"`(1기)/`"07"`(2기). **간이과세자는 1기("01")** — `defaultVatBaseDateRange()`가 넓게 커버(최근 ~3사업연도). 응답은 범위 내 전 과세기간 반환 → `normalizeVatBase`가 합산·최신연도 채택.
- **관측한 CF 코드**: `CF-00000`(성공) · `CF-03002`(추가인증 필요, +continue2Way) · `CF-12850`(주민/사업자번호 미입력=필드 매핑 오류) · `CF-00003`(상품 미신청/미존재). 미승인 재요청 한도 초과는 `CF-12872`(문서), 세션 타임아웃 4분30초.
- 2-way: 1차 → CF-03002의 data에서 `jobIndex/threadIndex/jti/twoWayTimestamp` 보관 → 승인 후 1차 body + `is2Way:true` + `twoWayInfo{4필드}` + `simpleAuth:"1"` 재요청.

### 2.4 사업자등록증명 응답 필드(정규화 원천, `normalizeCorporateRegistration`)
`resUserNm`(상호) · `resUserAddr`(주소→region) · `resOpenDate`(개업일 yyyyMMdd→biz_age) · `resBusinessTypes`(업태) · `resBusinessItems`(종목)→industry · `resBusinessmanType`(법인/개인→target_type) · `resUserIdentiyNo`(**철자 그대로**, 앞6자리만 남기고 마스킹) · `resJointRepresentativeNm`(공동대표). 부가세: 필드명 미확정(후보키 넓게 탐색 중) — **D1 완주 시 실제 필드명 확정해 `vat-base-certificate.ts`의 `TAX_BASE_*_KEYS` 고정**.

---

## 3. 남은 작업 ① — D1 완주 (사용자 + 새 세션, 최우선)

부가세과세표준 상품 신청 승인 후:

1. `pnpm verify:codef -- --name "한송욱" --birth 19840615 --phone 01043010615 --app kakaotalk --bizno 7465400870` 재실행(카카오 승인).
2. 확인·기록할 것:
   - **① 세션 SSO**: 부가세과세표준이 **2번째 승인 없이** 처리되나(CLI가 "미측정/GO/NO" 자동 판정). NO면 상품마다 승인 2회 폴백 확정.
   - **③ 개인 매출 커버리지**: 과세표준(taxBaseWon) 반환되나. **간이/면세 개인**이 핵심 대상.
   - **부가세 응답 원문 필드명**: 성공 응답의 실제 과세표준 필드명을 확인해 `vat-base-certificate.ts`의 후보키를 실제값으로 고정(현재는 방어적 넓은 탐색).
3. **3종 계정**으로 각각 실행(법인 1·일반과세 개인 1·간이/면세 개인 1) → ③ 커버리지 계층별 기록.
4. **② 단가**는 CODEF 상담(사람 작업) — CLI 대상 아님.
5. **GO 판정** = ①(세션 SSO) ∧ ③(개인 매출) 성립 ∧ ②(단가) 수용 가능. 결과를 `docs/research/2026-07-11-codef-field-sourcing-scenario.md` 또는 신규 D1 측정 문서에 기록.

**GO면 Phase B·C 착수. NO-GO면** 폴백(상품 축소/승인 2회) 확정 후 Phase B 설계 조정.

---

## 4. 남은 작업 ② — Phase B: 오케스트레이션 + 마이그레이션 (GO 후, Opus 위임)

> 목적: serverless(Vercel)에서 2-way 세션을 **DB로 영속화**해 UI(Phase C)가 승인 대기→완료를 두 HTTP 요청으로 처리. 상세 설계는 `codef-l1-demo.md` §2·§3 Phase B. **프로덕션 `serviceData.ts` 오버레이는 미접촉**, `api/dev/codef/*`·dev 하네스에만.

### 4.1 마이그레이션 (`pnpm db:generate` → `pnpm db:migrate`, `db:push` 금지)
스키마: `apps/web/src/lib/server/db/schema.ts` (마이그레이션 out: `db/migrations`, 현재 0041+). `companyProfileSourceEnum`에 `codef` 이미 존재 → source enum 불필요.
- 신설 `codef_two_way_sessions`: `id`(pk) · `biz_no` · `user_id?` · `product_scope`(예 "l1_bundle") · `state` pgEnum(`pending_approval|completing|done|failed|expired`, `two-way.ts`의 `CodefTwoWayState`와 일치) · `request_snapshot` jsonb(**완료/실패/만료 즉시 NULL**) · `two_way_info` jsonb(jobIndex/threadIndex/jti/twoWayTimestamp) · `error_code` · `created_at` · `expires_at`(now+4분30초).
- 신설 `codef_tokens`(또는 kv 재사용): `access_token` · `token_type` · `expires_at`. `isCodefTokenExpired`로 만료 시에만 재발급.
- ⚠️ generate 결과에 **기존 객체 재생성이 섞이면 SQL에서 제거**(0018~0025 전례). **프로덕션 Supabase에 apply하므로 SQL 리뷰 후 apply**(메인이 통제, 서브에이전트가 prod에 migrate 금지).

### 4.2 서버 오케스트레이션 (`apps/web/src/lib/server/codef/`)
- `session-store.ts`: `codef_two_way_sessions` CRUD + 토큰 DB 캐시. 만료 세션 lazy 정리. `request_snapshot`은 종결 즉시 NULL.
- `orchestrator.ts`:
  - `startSimpleAuth(bizNo, {name, birth8, phone, telecom, authApp, gender})`: 토큰 확보 → 사업자등록증명 1차 요청 → CF-03002면 세션 저장 후 `{sessionId, guide}` 반환.
  - `completeSimpleAuth(sessionId)`: is2Way 재요청 → 성공 시 **같은 id로 부가세과세표준 연속 호출**(D1의 SSO 결과대로; NO면 2번째도 2-way 폴백) → `company_enrichment_cache`(provider='codef', scope별) upsert → `companyProfiles`(source='codef', confidence 0.9~0.95) upsert.
  - 코어 시그니처는 이미 준비됨(§2, `codef-and-residual.md` 참조). `buildCompanyProfileFromCodef`로 프로필 병합.
- 민감정보 마스킹(B5): 생년월일·전화·주민번호·토큰 로그 금지. `transactionId`만 기록.

### 4.3 API 라우트 (`apps/web/src/app/api/dev/codef/`)
- `simple-auth/route.ts`(POST 시작) · `simple-auth/complete/route.ts`(POST 완료). `runtime="nodejs"`, `dynamic="force-dynamic"`, 기존 dev 가드(`api/dev/service-data`와 동일). 미승인 complete 재시도 카운트 제한(≤2, CF-12872 대비).

---

## 5. 남은 작업 ③ — Phase C: dev UI (GO 후)

> **UI 규칙 최우선**: `.claude/skills/shadcn` 스킬 로드, primitive는 `npx shadcn@latest add`, `globals.css` 토큰만, 드리프트 스캔 0(`rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'`). 상세: `codef-l1-demo.md` §3 Phase C.

- 무대: `apps/web/src/app/dev/service-data`(ServiceDataMonitor)에 **CODEF 간편인증 섹션 추가**(새 페이지 금지). 하위 `CodefSimpleAuthPanel.tsx` 분리 권장.
- 입력 폼: 이름·생년월일·휴대폰·통신사·인증앱(§2.2 코드맵 select)·성별(founder_trait). hometax 동의 체크 → 시작.
- 승인 대기 UX: "카카오톡에서 승인해주세요" + [승인 완료] 버튼(폴링 아님·사용자 탭 후 complete 호출), 남은 시간 4분30초, 만료·실패 재시작.
- 필드 병합 표시: `FieldSourceLabel`에 "codef" 추가, 라벨 "국세청(CODEF)". 우선순위 codef > popbill/apick > qna. 라이브/캐시 뱃지. dev 하네스 배선은 `apps/web/src/lib/server/devServiceDataMonitor.ts`의 `runExternalConnectors`(현재 CODEF는 plannedSource 등재만·미배선, `ENV_CODEF` 상수 존재).
- founder_age는 생년월일 파생값만 저장(원본 무저장), founder_trait는 성별 1탭 입력.

---

## 6. 이후 — 프로덕션 승격·잔여

- **§6′-E known_flags 계약(매칭팀)**: "소스→커버 플래그 맵" + positive-only 예외 합의. **이 계약 전까지 프로덕션 `serviceData.ts` 미접촉**.
- 잔여(CODEF 외): kcomwel 502 재스모크, FSC↔NICE 소스 우선순위(§6′-E), 법인번호 브리지 무료 소스. (상세: `HANDOFF-2026-07-11-codef-and-residual.md` §2)
- L2/L3 상품(중소기업확인서·4대보험 가입자명부)은 프로필 승격 단계에서 신청·연동(size·certification·employees).

---

## 7. 가드레일 (반복 · CLAUDE.md + 트랙 규칙)

- **프로덕션 격리**: CODEF는 `api/dev/codef/*`·dev 하네스에만. `serviceData.ts` 오버레이는 §6′-E 전까지 손대지 말 것.
- **dev 서버는 사용자 소유**: 세션이 `pnpm dev` 백그라운드 기동 금지. 화면 검수는 사용자에게 요청.
- **마이그레이션**: `db:generate`→`db:migrate`(`db:push` 금지). generate에 기존 객체 재생성 섞이면 SQL에서 제거. **prod Supabase apply는 SQL 리뷰 후 메인이 통제**.
- **위임**: Phase B·C 구현은 Opus 서브에이전트, 메인(Fable)은 설계·검수. 장기 리뷰는 Codex.
- **`@cunote/core` 심링크 dangling 주의**: verify 스크립트/tsx는 `@cunote/core` 배럴이 아니라 **codef 상대 소스 경로**로 import(`packages/core/src/codef/*.js`). dev 서버(dist 소비)는 core 수정 후 **build 필요**(`pnpm -F @cunote/core build`).
- **병렬 세션**: `apps/admin/*`·`_p5_*`·매칭 차원확장 커밋(32c0ddc·c578620 류)은 무관 — 건드리지 말 것. **`git add -A` 금지, 명시 스테이징**, add·commit 한 호출에.
- **git 쓰기 전**: `mkdir -p .git/stale-locks && mv .git/*.lock .git/stale-locks/ 2>/dev/null || true`. author `git -c user.name="coolwithyou" -c user.email="sw@ba-ton.kr"`. **Co-Authored-By 금지**.
- **민감정보**: 생년월일·전화·주민번호·certPassword·토큰 로그 금지. `request_snapshot`은 종결 즉시 NULL. 동의 `consents.hometax`.

## 자주 쓰는 커맨드
```bash
pnpm -F @cunote/core build && pnpm exec tsx packages/core/src/codef/codef.test.ts   # 코어 dist + 유닛 20/20
pnpm verify:codef -- --name .. --birth yyyyMMdd --phone .. --app kakaotalk --bizno 10자리 [--telecom SKT] [--start yyyyMM --end yyyyMM] [--dry-run]
rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'   # 드리프트 0 (Phase C)
```
