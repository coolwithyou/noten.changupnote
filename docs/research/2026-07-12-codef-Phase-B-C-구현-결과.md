# CODEF 간편인증 연동 — Phase B·C 구현 결과 (2026-07-12 · 세션4)

> **한 줄 요약**: 사업자번호 → 간편인증(카카오톡 등 승인) → 국세청 확정값 **7축**이
> `dev/service-data` 필드 테이블에 `국세청(CODEF)` 원천·캐시 뱃지로 병합 표시되는
> 파이프라인을 **코어·마이그레이션·서버 오케스트레이션·dev UI까지 완주**했다.
> D1(사용자 실계정 승인)은 미실행이나, 런북 설계대로 **Fallback**(양쪽 SSO 경로 +
> 방어적 VAT 필드탐색)으로 D1 대기 없이 완주했다.

- **선행 계보**: `docs/plans/2026-07-11-codef-l1-demo.md`(플랜) · `docs/plans/HANDOFF-2026-07-11-codef-post-d1-implementation.md`(필드계약·가이드) · `docs/plans/2026-07-11-codef-execution-to-completion.md`(실행 런북) · `docs/research/2026-07-12-codef-D1-fallback-상태.md`(D1 재개 체크리스트)
- **원천 계약(재조사 금지)**: post-d1 핸드오프 §2 = D1 실측으로 확정된 CODEF 필드 계약.

---

## 1. 구현 목록

### Phase A — 코어(선행 세션 완료, 이번 세션은 소비만)
`packages/core/src/codef/` 10모듈, `@cunote/core` 배럴 재export, dist 빌드됨. `codef.test.ts` **20/20**(오프라인 fixture). 이번 세션 미변경.

### Phase B — 서버 오케스트레이션 + 마이그레이션 (신규)

| 파일 | 역할 |
|---|---|
| `apps/web/src/lib/server/db/schema.ts` | `codefTwoWayStateEnum` + `codefTwoWaySessions` + `codefTokens` 추가(additive) |
| `db/migrations/0042_lumpy_epoch.sql` (+meta) | 위 스키마의 drizzle 생성 마이그레이션. **운영 Supabase apply 완료** |
| `apps/web/src/lib/server/codef/session-store.ts` | 세션 CRUD(전이는 코어 `assertTwoWayTransition` 가드) · 토큰 DB 캐시 · `company_enrichment_cache` upsert · best-effort `company_profiles` upsert. 종결·lazy만료 즉시 `request_snapshot` NULL |
| `apps/web/src/lib/server/codef/orchestrator.ts` | `startSimpleAuth`/`completeSimpleAuth`. 사업자등록증명 2-way 완료 → 같은 `id`로 VAT 연속 호출. **양쪽 SSO 경로** + CF-00003 관용 |
| `apps/web/src/app/api/dev/codef/simple-auth/route.ts` | POST 시작(1차 요청 → CF-03002면 세션 저장) |
| `apps/web/src/app/api/dev/codef/simple-auth/complete/route.ts` | POST 완료(승인 후 1회 호출). dev 가드 · 재시도 ≤2 |

### Phase C — dev UI + 필드 병합 배선 (신규)

| 파일 | 역할 |
|---|---|
| `apps/web/src/features/dev/CodefSimpleAuthPanel.tsx` | 입력폼(이름·생년월일·휴대폰·통신사·인증앱11종·성별) + 승인대기 상태머신(폴링 아님, [승인 완료] 버튼·4분30초 카운트다운). shadcn primitive만(드리프트 0) |
| `apps/web/src/features/dev/ServiceDataMonitor.tsx` | "CODEF 간편인증" 섹션 삽입(새 페이지 없음) + `sourceRefLabel`에 `codef→"국세청(CODEF)"` |
| `apps/web/src/lib/server/devServiceDataMonitor.ts` | `FieldSourceRef`에 `codef` · `runCodefConnector`(passive 캐시 판독) · `buildFieldCoverage`에서 codef 최우선 override(캐시 뱃지) |
| `apps/web/src/lib/server/codef/orchestrator.ts` | `finalizeDone`에 identity 캐시 persist(founder_age 파생정수·성별만, 생년월일 원본 무저장) |

---

## 2. 마이그레이션 0042 (운영 Supabase apply 완료)

```sql
CREATE TYPE "codef_two_way_state" AS ENUM('pending_approval','completing','done','failed','expired');
CREATE TABLE "codef_tokens" (id text pk, access_token, token_type, obtained_at_ms bigint, expires_in_sec int, updated_at);
CREATE TABLE "codef_two_way_sessions" (
  id uuid pk, biz_no, user_id(fk users), product_scope('l1_bundle'),
  state codef_two_way_state, request_snapshot jsonb(종결 즉시 NULL), two_way_info jsonb,
  error_code, retry_count int, created_at, expires_at);  -- +biz_no·expires_at 인덱스
```
- 신규 enum 1 + 테이블 2만(기존 객체 재생성 없음 — 메인이 SQL 리뷰 후 직접 `db:migrate`).
- `companyProfileSourceEnum`에 `codef`는 이미 존재 → source enum 불필요.

---

## 3. 데이터 흐름

```
[UI CodefSimpleAuthPanel]
  → POST /api/dev/codef/simple-auth {bizNo,name,birth8,phone,authApp,telecom?,gender?}
      → orchestrator.startSimpleAuth: 토큰 확보 → 사업자등록증명 1차 → CF-03002
        → codef_two_way_sessions(pending_approval) 저장 → {sessionId, guide}
  [사용자 카카오톡 승인] → [승인 완료] 버튼
  → POST /api/dev/codef/simple-auth/complete {sessionId}
      → orchestrator.completeSimpleAuth:
          사업자등록증명 2-way 완료(성공) → company_enrichment_cache(scope=corporate-registration)
          → 같은 id로 VAT 1차(CODEF_VAT_SSO_MODE=true):
              CF-00000 → normalizeVatBase → cache(scope=vat-base)
              CF-03002 → 2차 승인 유도(second_approval_needed)   ← SSO 미성립 폴백
              CF-00003(상품 미신청) → 관용, 사업자등록증명만으로 완성
          → finalizeDone: buildCompanyProfileFromCodef → cache(scope=identity: founder_age·gender)
          → 세션 done(snapshot NULL) → {state:"done", fields}

[재조회 / 필드 테이블]
  → devServiceDataMonitor.runExternalConnectors → runCodefConnector(passive)
      → company_enrichment_cache provider=codef 3 scope 판독
      → 7축(region·biz_age·industry·target_type·revenue·founder_age·founder_trait)
        을 buildFieldCoverage에서 codef 최우선 override(status=cache, source="codef")
      → UI: "캐시 · 국세청(CODEF)" 뱃지
```

**국세청 확정 7축 근거**: region/biz_age/industry/target_type ← 사업자등록증명, revenue ← 부가세과세표준, founder_age ← 간편인증 입력 생년월일 파생(원본 무저장), founder_trait ← 성별 1탭 입력.

---

## 4. 검증 결과 (전 게이트 통과 · 독립 재현)

| 게이트 | 결과 |
|---|---|
| `pnpm -F @cunote/core build` | EXIT 0 (코어 미변경) |
| `pnpm exec tsx packages/core/src/codef/codef.test.ts` | **20/20** |
| `pnpm -F @cunote/web typecheck` | EXIT 0 |
| `pnpm -F @cunote/web build` | EXIT 0 (dev codef 라우트 2본 컴파일 확인) |
| `pnpm db:migrate` (운영 Supabase) | `[✓] migrations applied successfully` |
| 드리프트 스캔 | **신규 0** — `archive/GrantArchivePageView.tsx`·`ArchiveAgencyFilter.tsx`(기존 부채) 2파일만 |

---

## 5. 커밋 (세션4)

| 해시 | 내용 |
|---|---|
| `2a6fb16` | Phase B1: 2-way 세션·토큰 캐시 마이그레이션(0042) |
| `0636211` | Phase B2-B5: 오케스트레이터·세션 스토어·dev API 라우트 |
| `c32b510` | Phase C: dev 간편인증 패널 + 국세청 7축 병합 배선 |
| `e48ee6b` | Phase C 후속: codef 커넥터 행 캐시 뱃지 정확화(live→cache) |
| `11af2a0` | 문서 갱신: 런북 blockquote·핸드오프·D1 Fallback 노트 |

---

## 6. 격리·마스킹 보증

- **프로덕션 격리**: 변경은 `api/dev/codef/*`·`lib/server/codef/*`·dev 하네스에만. 프로덕션 `serviceData.ts` 오버레이 **미접촉**(§6′-E known_flags 계약 전까지).
- **dev 라우트 가드**: `isProduction()→404` + `runtime=nodejs`·`dynamic=force-dynamic`.
- **마스킹(B5)**: 생년월일·전화·주민번호·access_token을 로그/에러메시지에 미출력(transactionId만). `request_snapshot`(민감 로그인 입력)은 세션 종결·lazy만료 즉시 NULL. identity 캐시는 **생년월일 파생 연령·성별만** 저장(원본 무저장).
- **병렬 세션 무접촉**: `apps/admin/*`·`scripts/spikes/*` 등 무관 dirty 파일 미접촉.

---

## 7. 잔여 (사용자 몫 + 후속)

1. **D1 실측(사용자)**: 3종 계정(법인·일반과세 개인·간이/면세 개인) `pnpm verify:codef` — ①세션 SSO ③개인 매출 커버리지 + 부가세 응답 원문 필드명. 체크리스트: `docs/research/2026-07-12-codef-D1-fallback-상태.md`.
2. **dev 서버 E2E 시각검수(사용자 기동)**: `/dev/service-data` → 조회 → "CODEF 간편인증" 카드 전 플로우.
3. **D1 결과 튜닝(코드 2곳)**: ①SSO → `orchestrator.ts` `CODEF_VAT_SSO_MODE`, ③필드명 → `vat-base-certificate.ts` `TAX_BASE_*_KEYS`.
4. **프로덕션 승격**: §6′-E known_flags 계약(매칭팀) 후 `serviceData.ts` 오버레이 반영.
5. **L2/L3 상품**: 중소기업확인서·4대보험 가입자명부(size·certification·employees).
