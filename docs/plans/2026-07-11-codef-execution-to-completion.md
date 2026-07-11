# CODEF 완주 실행 런북 (D1 → Phase B → Phase C)

> **목적**: 새 세션이 이 문서를 위에서부터 순서대로 실행해 **동작하는 dev 데모**(사업자번호 입력 → 간편인증 → 국세청 확정값이 `dev/service-data`에 병합 표시)까지 완주한다. IR 대비 빠른 완성이 우선.
>
> **전제(2026-07-11 기준 가정)**: CODEF 데모 전 상품 승인 완료 — 사업자등록증명 · **부가가치세 과세표준증명** · (선택)표준재무제표증명. 사업자등록증명은 D1에서 이미 `CF-00000` 실증됨.
>
> **반드시 먼저 읽기**:
> - `docs/plans/HANDOFF-2026-07-11-codef-post-d1-implementation.md` — **§2 CODEF 필드 계약(D1 실측 확정)**·§4 Phase B·§5 Phase C·§7 가드레일. 이 런북은 그 문서의 실행 순서판이며, 상세 계약/스키마는 그쪽이 원천.
> - `docs/plans/2026-07-11-codef-l1-demo.md` — Phase 표 원천.
> - 메모리 `matching-data-sourcing-architecture`.

---

## 진행 원칙 (전 단계 공통)

- **순서 직렬**: STEP 1(D1) → STEP 2(Phase B) → STEP 3(Phase C) → STEP 4(E2E). 각 STEP의 **acceptance gate 통과 후** 다음.
- **위임**: 구현(B·C)은 Opus 서브에이전트, 메인(Fable)은 설계·검수·커밋. 장기 리뷰는 Codex.
- **prod 마이그레이션은 메인이 통제**: `db:generate`는 서브에이전트 가능(오프라인), **`db:migrate`(운영 Supabase apply)는 메인이 생성 SQL 리뷰 후 직접**. `db:push` 금지.
- **D1 미확정 2개가 구현을 막지 않게**: (a) 부가세 응답 실제 필드명, (b) 세션 SSO 성립 여부 — **양쪽 경로 모두 구현**하고 D1 결과로 스위치/튜닝만. 아래 각 STEP에 반영됨.
- **프로덕션 `serviceData.ts` 오버레이 미접촉**(§6′-E 계약 전). CODEF는 `api/dev/codef/*`·dev 하네스에만.
- git 쓰기 전 stale-lock 처리 + author `coolwithyou <sw@ba-ton.kr>`, **Co-Authored-By 금지**, `git add -A` 금지(명시 스테이징).

---

## STEP 0 — 재개 컨텍스트 로드 (5분)

- [ ] post-d1 핸드오프 §2(필드계약)·§4·§5·§7 읽기. 메모리 확인.
- [ ] 상태 확인: `pnpm -F @cunote/core build && pnpm exec tsx packages/core/src/codef/codef.test.ts`(20/20) + `pnpm verify:codef -- --dry-run` 없이 인자 주고 `--dry-run`으로 body 확인.
- [ ] 커밋 계보: `82beb6e`(A) `d5e377b`·`3524a8c`(CLI) `475621d`(decode) `15cd9cc`(필드) `d414141`(VAT격리).

---

## STEP 1 — D1 완주 (user-in-loop, 짧게)

D1은 **실계정 휴대폰 승인**이라 세션이 대신 못 함 → 사용자에게 실행을 요청하고 결과만 받는다.

- [ ] 사용자에게 3종 계정으로 재실행 요청(승인 후 Enter):
  ```
  pnpm verify:codef -- --name <이름> --birth <yyyyMMdd> --phone <숫자> --app kakaotalk --bizno <10자리>
  ```
  대상: **법인 1 · 일반과세 개인 1 · 간이/면세 개인 1**.
- [ ] 리포트에서 3개 기록:
  1. **① 세션 SSO** — 부가세과세표준이 2번째 승인 없이 처리됐나(CLI가 GO/NO/미측정 자동 출력).
  2. **③ 개인 매출 커버리지** — 간이/면세 개인도 `taxBaseWon` 반환됐나.
  3. **부가세 응답 실제 필드명** — 성공 응답의 과세표준/연도 필드명(성공한 사용자에게 원문 키 확인 요청). → `packages/core/src/codef/products/vat-base-certificate.ts`의 `TAX_BASE_*_KEYS`를 실제값으로 고정(현재 방어적 넓은 탐색).
- [ ] 결과를 `docs/research/`에 D1 측정 노트로 기록(간단). **GO 판정** = ①∧③ 성립 ∧ ②(단가·상담) 수용 가능.

**Fallback(사용자가 지금 D1을 못 돌리면)**: STEP 2·3를 **먼저 진행**한다. 오케스트레이터는 SSO 양쪽 경로를 구현하고, 부가세 필드명은 방어 탐색을 유지 → D1 결과가 나오면 (a)필드명 상수 1곳, (b)SSO 기본 모드 플래그 1곳만 튜닝. **구현은 D1을 기다리지 않는다.**

**Acceptance**: D1 리포트 3항목 기록됐거나, Fallback 결정 명시.

---

## STEP 2 — Phase B: 마이그레이션 + 오케스트레이션 (Opus 위임)

상세 스키마·시그니처는 post-d1 핸드오프 §4. 이 STEP은 실행 순서.

### B1. 스키마 + 마이그레이션
- [ ] `apps/web/src/lib/server/db/schema.ts`에 추가:
  - `codefTwoWayStateEnum` = `two-way.ts`의 `CodefTwoWayState`(pending_approval|completing|done|failed|expired)와 동일.
  - `codef_two_way_sessions`: id(pk) · biz_no · user_id?(nullable, dev) · product_scope(text, "l1_bundle") · state(enum) · request_snapshot(jsonb, **종결 즉시 NULL**) · two_way_info(jsonb) · error_code(text?) · created_at · expires_at(now+270초).
  - `codef_tokens`: single-row 캐시(access_token · token_type · expires_at). (또는 기존 kv 있으면 재사용 — 없으면 신설.)
- [ ] `pnpm db:generate` (서브에이전트 가능) → **생성 SQL을 메인이 리뷰**: 신규 enum/2테이블만 있어야. 기존 객체 재생성 섞이면 SQL에서 제거(0018~0025 전례).
- [ ] **메인이 `pnpm db:migrate`** 로 운영 Supabase apply(전제: 클린 SQL). DATABASE_URL은 `.env`(운영 Supabase).
- **Acceptance**: 마이그레이션 파일 1건, apply 성공, `companyProfileSourceEnum`에 codef 이미 존재(변경 없음).

### B2. 세션 스토어 + 토큰 캐시
- [ ] `apps/web/src/lib/server/codef/session-store.ts`: `codef_two_way_sessions` CRUD, lazy 만료 정리, request_snapshot 종결 즉시 NULL. 토큰 DB 캐시 get/set + `isCodefTokenExpired`로 재발급.

### B3. 오케스트레이터 (SSO 양쪽 경로)
- [ ] `apps/web/src/lib/server/codef/orchestrator.ts`:
  - `startSimpleAuth(bizNo, {name, birth8, phone, telecom, authApp, gender})`: 토큰 확보 → 사업자등록증명 1차 → CF-03002면 세션 저장 후 `{sessionId, guide}`.
  - `completeSimpleAuth(sessionId)`: is2Way 재요청 → 성공 → **부가세과세표준을 같은 id로 연속 호출**. **양쪽 경로**:
    - SSO 성립(D1 ① GO): 2번째 상품 1차가 바로 성공.
    - SSO 미성립: 2번째 상품이 다시 CF-03002 → 세션을 재-대기 상태로 돌려 UI가 2차 승인 유도(폴백 모드 플래그).
  - 성공분 → `company_enrichment_cache`(provider='codef', scope='corporate-registration'|'vat-base') upsert + `companyProfiles`(source='codef', confidence 0.9~0.95) upsert(`buildCompanyProfileFromCodef` 사용).
- [ ] 코어 재사용: `requestCodefToken`·`requestCodefProduct`·`extractTwoWayInfo`·`buildTwoWayRequestBody`·`buildCorporateRegistrationRequest`·`buildVatBaseRequest`+`defaultVatBaseDateRange`·`normalize*`·`buildCompanyProfileFromCodef`(전부 `@cunote/core`/코드 준비됨).

### B4. API 라우트 (dev)
- [ ] `apps/web/src/app/api/dev/codef/simple-auth/route.ts`(POST 시작) + `.../complete/route.ts`(POST 완료). `runtime="nodejs"`, `dynamic="force-dynamic"`, 기존 `api/dev/service-data` dev 가드 재사용. 미승인 complete 재시도 ≤2(CF-12872 대비).

### B5. 마스킹
- [ ] 생년월일·전화·주민번호·토큰 로그 금지. transactionId만. request_snapshot 종결 즉시 NULL.

**STEP 2 Acceptance**: `pnpm -F @cunote/core build && pnpm -F web typecheck && pnpm -F web build` EXIT 0. (선택)오케스트레이터 유닛/스모크. 마이그레이션 apply 확인.

---

## STEP 3 — Phase C: dev UI (Opus 위임, **shadcn 스킬 최우선**)

착수 전 `.claude/skills/shadcn` 로드. primitive는 `npx shadcn@latest add`, `globals.css` 토큰만, 드리프트 0.

- [ ] **C1** `apps/web/src/features/dev/` 하위 `CodefSimpleAuthPanel.tsx` 신설, ServiceDataMonitor에 "CODEF 간편인증" 섹션으로 삽입(새 페이지 금지). 입력 폼: 이름·생년월일·휴대폰·통신사·인증앱(post-d1 §2.2 코드맵 select)·성별. hometax 동의 체크 → 시작 버튼.
- [ ] **C2** 승인 대기 UX: "카카오톡에서 승인해주세요" + [승인 완료] 버튼(폴링 아님), 남은 시간 4분30초, 만료·실패 재시작. SSO 미성립 폴백이면 2차 승인 유도 상태 렌더.
- [ ] **C3** 필드 병합 표시: `FieldSourceLabel`에 "codef"(라벨 "국세청(CODEF)"), 우선순위 codef > popbill/apick > qna, 라이브/캐시 뱃지. `apps/web/src/lib/server/devServiceDataMonitor.ts` `runExternalConnectors`에 CODEF 커넥터 배선(현재 plannedSource 등재만, `ENV_CODEF` 상수 존재).
- [ ] founder_age는 생년월일 파생값만, founder_trait는 성별 입력.

**STEP 3 Acceptance**: `rg -n "<button|<input|<select|<label|<table" apps/web/src/features apps/web/src/app --glob '!**/api/**'` = 0. typecheck/build 0. **시각 검수는 사용자에게 dev 서버 기동 요청**(세션이 띄우지 않음).

---

## STEP 4 — E2E 검수 + 커밋 + 문서 갱신

- [ ] (사용자 동반) dev 서버에서 실계정 1건 전 플로우: 입력 → 승인 → 국세청 7축(region·biz_age·industry·target_type·revenue·founder_age·founder_trait) 병합 표시 + 재조회 캐시 뱃지.
- [ ] 커밋 단위: B1(마이그레이션 단독) / B2-B5 / C / D1측정노트. 한국어 메시지.
- [ ] 문서 갱신: 이 런북 체크박스, post-d1 핸드오프 상태, 메모리 `matching-data-sourcing-architecture`. §6′-E 계약 후속 태스크 등재.

---

## DONE 정의

1. `dev/service-data`에서 사업자번호+간편인증 1회로 국세청 확정값 7축이 `source=codef`·라이브/캐시 뱃지로 병합 표시.
2. 2-way 세션 DB 영속(serverless 대응), 재조회 캐시 재사용.
3. build/typecheck/드리프트 0. 프로덕션 오버레이 미접촉.
4. D1 3대 가정 기록(또는 Fallback 경로 명시) + 부가세 필드명 확정.

이후(범위 밖): §6′-E known_flags 계약 → 프로덕션 승격, L2/L3(중소기업확인서·4대보험) 상품 연동.

---

## 트리거 문장 (새 세션에 붙여넣기)

```
docs/plans/2026-07-11-codef-execution-to-completion.md 실행 런북과 메모리(matching-data-sourcing-architecture)를 읽고, CODEF 전 상품 승인 전제로 STEP 0부터 순서대로 완주해줘.
- STEP 1(D1)의 실계정 휴대폰 승인은 나에게 실행을 요청하고, 내가 지금 못 돌리면 Fallback 경로로 STEP 2(Phase B)·STEP 3(Phase C)를 먼저 진행해.
- 구현은 Opus 서브에이전트에 위임하고 너(메인)는 설계·검수·커밋. db:migrate(운영 Supabase apply)는 네가 생성 SQL 리뷰 후 직접 실행.
- 각 STEP acceptance gate를 통과 증거(build/test/드리프트 0)와 함께 확인하고 커밋해. 시각 검수용 dev 서버는 나에게 기동을 요청해.
```
