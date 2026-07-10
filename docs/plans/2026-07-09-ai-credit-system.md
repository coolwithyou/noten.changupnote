# cunote AI 크레딧 시스템 — 상세 설계 문서

> **문서 상태**: 레드팀 검증 완료 (17장 반영 로그 참조)
> **작성일**: 2026-07-09
> **대상 독자**: 이 문서만으로 구현을 수행할 LLM 세션. 사람이 아닌 LLM이 읽는다는 전제로 파일 경로·심볼·의사코드를 명시적으로 기술한다.

---

## 0. 문서 사용법 · 참조 파일 맵

### 0.1 구현 세션이 지켜야 할 순서

1. 이 문서의 **15장 Phase 분할**을 따라 Phase 단위로 구현한다. Phase를 건너뛰지 않는다.
2. 각 Phase 시작 전에 해당 Phase가 참조하는 장(章)을 다시 읽는다.
3. 스키마 변경은 반드시 `apps/web/src/lib/server/db/schema.ts` 수정 → `pnpm db:generate` → 생성 SQL 검토(기존 객체 재생성 섞이면 SQL에서 제거) → `pnpm db:migrate`. **`db:push` 단독 사용 금지** (프로젝트 CLAUDE.md 규칙).
4. 완료 선언 전 검증: 14장의 verify 스크립트와 16장의 테스트가 통과해야 한다.

### 0.2 기존 코드 참조 맵 (구현 시 반드시 열어볼 파일)

| 목적 | 파일 | 참고할 것 |
|---|---|---|
| DB 스키마 컨벤션 | `apps/web/src/lib/server/db/schema.ts` | uuid PK, `timestamp(..., { withTimezone: true })`, pgEnum, jsonb `$type` 패턴, 인덱스 네이밍 `{table}_{col}_idx` |
| 세션/인증 | `apps/web/src/lib/server/auth/session.ts` | `requireWebSession()`, `getOptionalWebSession()` |
| 회사 접근 | (기존 라우트에서 사용 중) | `requireCompanyAccess()` → `{ userId, companyId, role, mode }` |
| API 응답 봉투 | `packages/contracts/src/dto.ts` | `ActionResult<T>`, 라우트의 `webActionError` 헬퍼 |
| API 라우트 예시 | `apps/web/src/app/api/web/matches/route.ts` | `runtime="nodejs"`, `dynamic="force-dynamic"`, try/catch 구조 |
| 리포지토리 포트 | `packages/core/src/repositories/ports.ts` | `ServiceRepositories` 인터페이스에 추가하는 방식 |
| Drizzle 리포지토리 구현 | `apps/web/src/lib/server/repositories/drizzle.ts` | `createDrizzleRepositories(db)` |
| Runtime(mock) 리포지토리 | `apps/web/src/lib/server/repositories/runtime.ts` | 데모/인메모리 구현 |
| 리포지토리 싱글턴 | `apps/web/src/lib/server/serviceData.ts` | `getServiceRepositories()` |
| RLS 패턴 | `db/migrations/0003_rls_company_scope.sql` | `app_private.current_user_id()`, ENABLE/FORCE RLS, 정책 네이밍 |
| RLS 검증 | `packages/contracts/scripts/verify-rls-policy.ts` | 보호 테이블·정책 목록 (신규 테이블 등재 필요) |
| 기존 billing (구독형) | `apps/web/src/lib/server/billing/*.ts` | `billing_subscriptions` 등 company 스코프 구독. **크레딧과 별개 시스템** — 8.6절에서 관계 정의 |
| 팝빌 조회 | `packages/core/src/popbill/check-biz-info.ts`, `apps/web/src/lib/server/serviceData.ts`의 `loadPopbillCompanyProfile()` | 30일 캐시 + in-flight dedup, `evidence.cacheStatus`로 실호출 판별 |
| LLM 호출 (기존, 운영 배치) | `packages/core/src/bizinfo/llm-criteria.ts`, `apps/web/src/lib/server/knowledge/extraction.ts` | raw fetch로 Anthropic API 직접 호출. `payload.usage` 반환 구조 |
| 지원서 드래프트 (미구현 훅) | `grant_document_drafts.llm_cost` jsonb 컬럼 (schema.ts) | 사용자 트리거 LLM의 예약된 자리 |
| admin DB 접근 | `apps/admin/src/lib/server/db/client.ts` | `getAdminSql()` — postgres.js raw SQL |
| admin 인증 | `apps/admin/src/lib/server/auth/adminUsers.ts` | `requireAdminSession()`, `AdminRole = owner\|admin\|support\|viewer` |
| admin 응답 봉투 | `apps/admin/src/lib/server/http/envelope.ts` | `adminData()` / `adminError()` |
| admin UI | `apps/admin/src/app/globals.css` | `ops-*` CSS 클래스 체계 (외부 UI 라이브러리 없음) |

### 0.3 용어 표기 규칙

- **크레딧(credit)**: 사용자에게 표시되는 잔액 단위. 정수.
- **밀리크레딧(millicredit)**: 요율 계산용 내부 정밀 단위. 1 크레딧 = 1,000 밀리크레딧. **요율 정의에만 사용**하고 원장·잔액은 정수 크레딧.
- **lot**: 크레딧 지급 묶음(가입 보너스 1건, 충전 1건, 플랜 월지급 1건 = 각 1 lot). 만료·환불 회계의 단위.
- **분개(ledger entry)**: 원장의 불변 기록 1건.
- **hold**: LLM 호출 전 잔액을 선점하는 임시 예약. 원장 분개가 아니다.

---

## 1. 목표 · 비목표

### 1.1 목표

cunote를 **AI 크레딧 기반 과금 서비스**로 전환한다.

1. 모든 가입 사용자에게 무료 1,000 크레딧 지급 (→ 2.1, 13.1)
2. LLM 모델/에이전트를 실제로 사용할 때(지원서·사업계획서 작성, 가이드) 크레딧 차감 (→ 6장)
3. 포트원(PortOne) V2 + 토스페이먼츠로 크레딧 충전 결제 (→ 7장)
4. 크레딧 환율·작업별 소모량·토큰 요율을 ops에서 런타임 조정 (→ 5.5, 11.2, 11.3)
5. 마이페이지에서 사용량 상시 확인 (→ 10.3)
6. plus / pro / flex 플랜 = 월간 지급 크레딧 차이 (→ 8장)
7. 플랜 페이지·충전 페이지·사용량 상세 트래킹 페이지 (→ 10장)
8. ops에서 회원별 크레딧 수동 지급/차감 (→ 11.4)
9. ISMS 준하는 보안 수준 + 모든 행위(충전·사용·환불·결제)의 감사 로그와 조회 (→ 12장)
10. 팝빌 조회는 과금 대상 아님 — 단 미터링은 한다 (→ 6.5)
11. 크레딧 운영에 필요한 전체 페이지·기능 (→ 10, 11, 14장)

### 1.2 비목표 (이번 설계에서 제외)

- **크레딧의 타 서비스 사용·양도·현금화**: 자사 서비스 전용. (전자금융거래법상 선불전자지급수단 등록 요건을 피하는 핵심 전제 — 12.6)
- **B2B 시트 과금과의 통합**: 기존 `billing_subscriptions`(company 스코프 구독)는 유지하되 이번 크레딧 시스템과 분리. 관계는 8.6절.
- **모바일 앱 내 결제(IAP)**: 웹 결제만. 앱은 웹뷰/외부 브라우저로 충전 페이지 연결 (앱스토어 정책 검토는 오픈 퀘스천 18.4).
- **세금계산서 자동 발행**: 기존 `billing_tax_*` 인프라 활용은 후속. 현금영수증·매출전표는 포트원/토스가 제공하는 것을 링크.
- **다중 통화**: KRW 전용.

---

## 2. 핵심 결정과 근거

### 2.1 환율: 1 크레딧 = 1 KRW 앵커 (결정)

**결정**: 크레딧의 표시 가치를 **1 크레딧 = 1원**으로 앵커한다. 가입 보너스 1,000 크레딧 = 1,000원 상당.

**근거**:
- 한국 사용자에게 "크레딧이 얼마짜리인지" 환산 부담이 없다. 가격 신뢰(요율이 원 단위로 직관 검증 가능).
- 마진은 환율이 아니라 **작업별 크레딧 요율**(5.5)에 넣는다. LLM 원가(USD) 변동·환율 변동은 ops에서 요율만 조정하면 흡수된다.
- 충전 상품에 보너스 크레딧(예: 50,000원 충전 시 +5% 보너스)을 붙이는 방식으로 볼륨 할인을 표현할 수 있어, 환율 자체를 흔들 필요가 없다.

**검토한 대안과 기각 사유**:

| 대안 | 장점 | 기각 사유 |
|---|---|---|
| 추상 크레딧 (10 크레딧 = 1원 등) | 심리적 풍부함, 요율 소수점 여유 | 환산 계산 강요 → 가격 불신. 밀리크레딧 내부 단위로 정밀도 문제는 이미 해결 |
| USD 연동 크레딧 | LLM 원가와 자연 정렬 | 국내 결제 UX에 이질적. 환율 노출 리스크를 사용자에게 전가 |
| 크레딧 없이 토큰 직접 과금 | 정산 단순 | 모델별 단가 차이가 그대로 노출되어 상품화 불가, ops 유연성 상실 |

**주의**: 앵커는 **초기 정책값**이다. `credit_settings.krw_per_credit`(5.5)로 저장하며 ops에서 변경 가능하지만, 변경 시 기존 충전 크레딧의 가치가 흔들리므로 **사실상 변경 불가 값**으로 취급한다 (변경 시 반드시 신규 판매분에만 적용 — 주문 테이블에 환율 스냅샷 저장으로 보장, 4.8).

### 2.2 지갑 스코프: user 단위 (결정)

**결정**: 크레딧 지갑은 **사용자(user) 1인당 1개**. 사용 이벤트에는 회사(companyId) 컨텍스트를 기록만 한다.

**근거**: 요구사항 1("모든 가입 사용자에게 지급")과 8("회원별 수동 충전")이 모두 user 단위. 기존 시트 구독(`billing_subscriptions`)은 company 단위지만 크레딧은 "내가 산 내 자산"이라는 멘탈 모델이 맞다. 한 사용자가 여러 회사를 오가며 작업해도 잔액은 하나.

**결과**: 팀 공유 크레딧(회사 지갑)은 만들지 않는다. 필요해지면 `credit_wallets.ownerType` 확장으로 대응 (18.2).

### 2.3 원장 구조: append-only ledger + lot 회계 (결정)

**결정**: 3층 구조.
- `credit_ledger` — 불변 분개(append-only). 진실의 원천.
- `credit_lots` — 지급 묶음. 만료일·출처(무료/충전/플랜)·잔여량 보유. 환불·만료의 회계 단위.
- `credit_wallets.balanceCredits` — 파생 캐시. 매 분개 트랜잭션에서 동기 갱신, 일일 대사(14장)로 검증.

**근거**: 환불("유료 크레딧 미사용분만"), 만료("플랜 크레딧은 갱신일 소멸"), 감사("이 차감은 어느 지급분에서 나갔나")가 모두 lot 없이는 불가능하다. 단순 잔액 컬럼 증감 방식은 감사 로그 요구(요구 9)를 충족할 수 없다.

### 2.4 차감 방식: hold → settle (결정)

**결정**: LLM 호출 전 예상 상한을 hold하고, 호출 완료 후 실제 토큰 사용량으로 정산(capture)한다. 원장 분개는 capture 시점에 1건만 발생한다.

**근거**: 스트리밍 LLM은 완료 전까지 비용을 모른다. 사전 차감(과대)도 사후 차감(잔액 0에서 무한 사용)도 결함이 있다. hold는 동시 다발 호출로 잔액을 초과 사용하는 경로를 차단한다 (5.3).

### 2.5 소진 순서: 만료 임박 우선 (결정)

**결정**: 차감 시 lot 소진 순서는 `expiresAt ASC NULLS LAST, createdAt ASC`. 실질적으로 **무료(만료 짧음) → 플랜(월 만료) → 충전(5년)** 순.

**근거**: 사용자에게 유리(만료로 날리는 크레딧 최소화)하고, 충전 크레딧이 마지막에 남아 환불 요구 시 "미사용 유료분" 계산이 깨끗하다.

### 2.6 잔액 최소 단위: 정수 크레딧, 호출당 ceil (결정)

**결정**: 원장·잔액·hold는 모두 **정수(bigint) 크레딧**. 토큰→크레딧 계산은 밀리크레딧으로 하되 분개 시 `ceil`로 올림.

**근거**: 지원서·사업계획서 작성 호출은 입력 수천~수만 토큰 규모라 호출당 ceil 오차(<1크레딧)는 무시 가능. 정수 원장은 대사·표시·환불 계산을 단순하게 만든다. 소액 호출(짧은 가이드)이 많아져 ceil 누적이 문제되면 요율에서 조정한다.

### 2.7 결제 게이트웨이: 포트원 V2 경유 토스페이먼츠 (요구사항 확정)

포트원 V2 REST API + `@portone/browser-sdk` + `@portone/server-sdk`. 검증은 **사후검증 패턴**(결제 후 `GET /payments/{paymentId}`로 금액 대조). 상세는 7장.

### 2.8 기존 billing 시스템과의 관계 (결정)

기존 `billing_*` 테이블(company 스코프 구독, 시트 기반)은 **건드리지 않는다**. 신규 크레딧 플랜은 별도 테이블(`credit_plan_subscriptions`, user 스코프)로 만든다. 기존 `/billing` 페이지는 유지하고, 크레딧 관련 UI는 신규 라우트에 만든 뒤 `/billing`에서 링크한다. 두 시스템의 장기 통합은 오픈 퀘스천(18.1).

---

## 3. 도메인 모델 · 용어

```
User (기존)
 └─ 1:1 CreditWallet            지갑. 잔액 캐시.
     ├─ 1:N CreditLot           지급 묶음 (출처·만료·잔여)
     ├─ 1:N CreditLedgerEntry   불변 분개 (진실의 원천)
     ├─ 1:N CreditHold          LLM 호출 중 임시 선점
     └─ 1:N UsageEvent          미터링 (과금+무과금 모두)

CreditPlan (plus/pro/flex 정의)
 └─ 1:N CreditPlanSubscription  user별 구독 (빌링키, 주기, 상태)

CreditProduct                    충전 상품 (금액→크레딧 매핑)
 └─ 1:N CreditPaymentOrder      주문 (포트원 paymentId의 주인)

CreditPricingRule                요율 (모델 토큰당 / 기능당)
CreditSetting                    전역 설정 KV (환율, 보너스량 등)
PortoneWebhookEvent              웹훅 inbox (멱등 처리)
CreditAuditLog                   감사 로그 (append-only)
CreditReconciliationRun          일일 대사 결과
```

### 3.1 상태 머신

**CreditPaymentOrder.status** (내부 상태, 포트원 상태와 구분):
```
created ──(SDK 결제창)──▶ pending ──(검증 PAID)──▶ paid ──(환불)──▶ refunded / partial_refunded
   │                        │
   └──(만료 90분)──▶ expired └──(검증 FAILED)──▶ failed
```

**CreditHold.status**:
```
pending ──(정산)──▶ captured
   ├──(실패/취소)──▶ released
   └──(타임아웃 cron)──▶ expired(=released로 처리, 사유만 구분)
```

**CreditPlanSubscription.status**:
```
incomplete ──(첫 결제 PAID 확인)──▶ active     // 결제 성공 전에는 절대 active가 되지 않는다 (레드팀 M6)
   └──(결제 실패/이탈)──▶ (재시도 시 동일 행 재사용)

active ──(갱신 결제 실패)──▶ past_due ──(재시도 성공)──▶ active
  │                             └─(재시도 소진)──▶ expired
  ├──(해지 예약)──▶ active(cancelAtPeriodEnd=true) ──(주기 종료)──▶ canceled
  └──(즉시 업그레이드)──▶ active(새 plan)

⚠ 불변 규칙: 모든 상태 전이(업그레이드·다운그레이드 확정·past_due 진입·해지·강제 해지·동결 연동)의
  첫 단계는 "이 구독의 미소진 포트원 예약 전부 취소(cancelSchedules)"다 (레드팀 B2 — 8.5 참조).
```

**CreditLot.status**: `active → exhausted(잔여 0) | expired(만료 cron) | revoked(환불 회수)`

### 3.2 featureCode 사전 (초기값 — ops에서 추가 가능해야 함)

| featureCode | 설명 | 과금 |
|---|---|---|
| `application_draft` | 지원서 초안 생성 (LLM 대량 생성) | 토큰 요율 |
| `application_review` | 지원서 첨삭/리뷰 | 토큰 요율 |
| `business_plan_section` | 사업계획서 섹션 작성 | 토큰 요율 |
| `writing_guide_chat` | 작성 가이드 대화 (멀티턴) | 토큰 요율 |
| `expert_field_answer` | 전문가 필드 답변 생성 | 토큰 요율 |
| `popbill_lookup` | 팝빌 사업자 조회 | **0 (무과금, 미터링만)** |
| `ops_batch_*` | 운영 배치 (bizinfo 추출 등) | 0 (원가 추적용 미터링만, 지갑 없음) |

---

## 4. DB 스키마

`apps/web/src/lib/server/db/schema.ts`에 추가한다. 아래 Drizzle 코드는 컨벤션(uuid PK, withTimezone, jsonb $type)을 기존 파일과 동일하게 맞춘 **구현 기준 코드**다. 컬럼 추가·삭제는 자유지만 삭제 시 이 문서의 해당 절을 갱신할 것.

### 4.0 enum 정의

```ts
export const creditLotSourceEnum = pgEnum("credit_lot_source", [
  "signup_bonus", "purchase", "plan_grant", "admin_grant", "promo",
]);
export const creditLotStatusEnum = pgEnum("credit_lot_status", [
  "active", "exhausted", "expired", "revoked",
]);
export const creditLedgerEntryTypeEnum = pgEnum("credit_ledger_entry_type", [
  "signup_bonus_grant", "purchase_grant", "plan_grant", "admin_grant", "promo_grant",
  "usage_capture",        // hold 정산 차감 (음수)
  "refund_deduct",        // 환불로 크레딧 회수 (음수)
  "expiry",               // 만료 소멸 (음수)
  "admin_deduct",         // 운영자 수동 차감 (음수)
  "reversal",             // 오류 정정 (양/음, 반드시 원분개 참조)
]);
export const creditHoldStatusEnum = pgEnum("credit_hold_status", [
  "pending", "captured", "released", "expired",
]);
export const usageEventStatusEnum = pgEnum("usage_event_status", [
  "pending", "settled", "failed", "free",
]);
export const creditOrderStatusEnum = pgEnum("credit_order_status", [
  "created", "pending", "paid", "failed", "expired", "refunded", "partial_refunded",
]);
export const creditPlanSubStatusEnum = pgEnum("credit_plan_sub_status", [
  "incomplete", "active", "past_due", "canceled", "expired",
]);
export const creditActorTypeEnum = pgEnum("credit_actor_type", ["user", "admin", "system"]);
```

### 4.1 credit_wallets

```ts
export const creditWallets = pgTable("credit_wallets", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  // onDelete restrict: 지갑이 있는 사용자는 하드삭제 불가. 탈퇴 시 12.5의 가명화 절차를 따른다.
  balanceCredits: bigint("balance_credits", { mode: "number" }).default(0).notNull(),
  status: text("status").default("active").notNull(), // active | frozen (frozen: 어뷰징 조사 중 차감·충전 차단)
  frozenReason: text("frozen_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: uniqueIndex("credit_wallets_user_idx").on(table.userId),
}));
```

- `balanceCredits >= 0` CHECK 제약을 마이그레이션 SQL에 수동 추가한다: `ALTER TABLE credit_wallets ADD CONSTRAINT credit_wallets_balance_nonneg CHECK (balance_credits >= 0);`
  - 예외: 5.3의 초과 정산(shortfall) 케이스는 잔액을 0으로 클램프하고 부족분을 usage_event 메타에 기록한다(음수 잔액을 만들지 않는다).
- **frozen 의미론 (레드팀 반영)**: freeze는 **신규 hold·신규 checkout·신규 지급을 차단**한다. 이미 pending인 hold의 정산(usage_capture), 환불 회수(refund_deduct), admin_grant/admin_deduct, reversal은 **허용** — 진행 중이던 LLM 호출의 과금 누락과 조사 정리 작업을 막지 않기 위함. 활성 플랜 구독이 있는 지갑을 동결할 때는 다음 예약결제 취소 여부를 운영자가 함께 선택한다(11.4 UI). 취소하지 않으면 예약결제가 성공했을 때 plan_grant가 지급되는데, 이는 freeze 예외 목록에 없으므로 **동결 시 예약 취소를 기본값**으로 한다.

### 4.2 credit_lots

```ts
export const creditLots = pgTable("credit_lots", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletId: uuid("wallet_id").notNull().references(() => creditWallets.id, { onDelete: "restrict" }),
  source: creditLotSourceEnum("source").notNull(),
  initialCredits: bigint("initial_credits", { mode: "number" }).notNull(),
  remainingCredits: bigint("remaining_credits", { mode: "number" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }), // null = 무기한 아님! 4.2.1 참조. 충전분도 5년 만료 설정
  status: creditLotStatusEnum("status").default("active").notNull(),
  paymentOrderId: uuid("payment_order_id").references(() => creditPaymentOrders.id, { onDelete: "set null" }),
  planSubscriptionId: uuid("plan_subscription_id").references(() => creditPlanSubscriptions.id, { onDelete: "set null" }),
  grantedByAdminId: text("granted_by_admin_id"), // admin_grant일 때 admin_users.id
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  walletIdx: index("credit_lots_wallet_idx").on(table.walletId),
  walletActiveIdx: index("credit_lots_wallet_active_idx").on(table.walletId, table.status, table.expiresAt),
  orderIdx: index("credit_lots_order_idx").on(table.paymentOrderId),
}));
```

**4.2.1 만료 정책 (초기값, `credit_settings`로 조정 가능)**

| source | expiresAt |
|---|---|
| signup_bonus | 지급 + 90일 |
| promo / admin_grant | 지급 시 운영자가 지정 (기본 90일) |
| plan_grant | **지급 + 2주기(60일)** — 실질 1주기 이월 허용. flex 플랜은 + 3주기(90일) 우대. 근거·차익 방어는 8.1 |
| purchase | 지급 + 5년 (상법상 상사채권 소멸시효 준용. 12.6) |

- CHECK 제약 수동 추가: `remaining_credits >= 0 AND remaining_credits <= initial_credits`

### 4.3 credit_ledger (append-only)

```ts
export const creditLedger = pgTable("credit_ledger", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletId: uuid("wallet_id").notNull().references(() => creditWallets.id, { onDelete: "restrict" }),
  entryType: creditLedgerEntryTypeEnum("entry_type").notNull(),
  amountCredits: bigint("amount_credits", { mode: "number" }).notNull(), // 양수=지급, 음수=차감. 0 금지
  balanceAfter: bigint("balance_after", { mode: "number" }).notNull(),   // 분개 직후 잔액 스냅샷
  lotBreakdown: jsonb("lot_breakdown").$type<Array<{ lotId: string; amount: number }>>()
    .default(sql`'[]'::jsonb`).notNull(), // 차감·회수 분개에서 lot별 배분. 지급 분개는 [{생성된 lotId, initial}]
  usageEventId: uuid("usage_event_id").references(() => usageEvents.id, { onDelete: "restrict" }),
  paymentOrderId: uuid("payment_order_id").references(() => creditPaymentOrders.id, { onDelete: "restrict" }),
  reversalOfEntryId: uuid("reversal_of_entry_id"), // entryType=reversal일 때 원분개 id (자기참조 FK는 마이그레이션에서)
  pricingSnapshot: jsonb("pricing_snapshot").$type<Record<string, unknown>>(), // usage_capture 시 적용 요율 사본
  actorType: creditActorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id"), // user면 users.id, admin이면 admin_users.id, system이면 프로세스 식별자
  reason: text("reason"),    // admin_grant/admin_deduct/reversal은 NOT NULL을 앱 레벨에서 강제
  idempotencyKey: text("idempotency_key").notNull(),
  chainHash: text("chain_hash").notNull(), // 무결성 체인 — sha256(직전 분개 chainHash ‖ id ‖ walletId ‖ entryType ‖ amount ‖ balanceAfter ‖ idempotencyKey ‖ createdAt). 지갑별 체인, 첫 분개의 prev는 `genesis:{walletId}`. 14.2에서 재검증
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  // updatedAt 없음 — append-only
}, (table) => ({
  walletCreatedIdx: index("credit_ledger_wallet_created_idx").on(table.walletId, table.createdAt),
  idempotencyIdx: uniqueIndex("credit_ledger_idempotency_idx").on(table.idempotencyKey),
  entryTypeIdx: index("credit_ledger_entry_type_idx").on(table.entryType, table.createdAt),
}));
```

**idempotencyKey 규약** (중복 분개 차단의 핵심):

| 분개 | 키 형식 |
|---|---|
| 가입 보너스 | `signup:{userId}` |
| 충전 지급 | `purchase:{orderId}` |
| 플랜 지급 | `plan:{orderId}` — **주문과 1:1**. 초안의 `plan:{subId}:{periodStart}`는 같은 날 업그레이드·재시도 결제에서 키가 충돌해 지급이 무음 소실됨(레드팀 B1). plan_initial/plan_renewal/업그레이드 모두 주문 행이 존재하므로 orderId가 유일 키 |
| 사용 정산 | `usage:{usageEventId}` |
| 환불 회수 | `refund:{orderId}:{cancellationId}` — cancellationId를 아직 모르는 비동기(REQUESTED) 단계에서는 분개하지 않고, SUCCEEDED 확정(웹훅 or 조회) 시점에 분개 |
| 만료 | `expiry:{lotId}` |
| 수동 조정 | `admin:{nonce}` — **ops 폼이 최초 렌더 시 생성한 uuid nonce**. 더블클릭·재제출·네트워크 재시도에도 동일 nonce가 유지되어야 멱등이 성립(레드팀 M4 — `admin:{auditLogId}`는 시도마다 새 id가 생겨 멱등 무효) |
| 정정 | `reversal:{원분개 entryId}` + `reversal_of_entry_id`에 partial unique index(원분개당 reversal 1회) 마이그레이션 수동 추가 |

**append-only 강제 (마이그레이션 SQL에 수동 추가)**:
```sql
CREATE OR REPLACE FUNCTION app_private.reject_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'credit_ledger is append-only'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_ledger_no_update BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION app_private.reject_mutation();
```
(동일 트리거를 `credit_audit_logs`에도 건다. 오류 정정은 UPDATE가 아니라 `reversal` 분개로 한다.)

**트리거의 한계와 보강 (레드팀 반영)**: 앱 접속 DB 역할이 owner/BYPASSRLS 계열이면 `ALTER TABLE … DISABLE TRIGGER` 또는 `session_replication_role=replica` 한 줄로 트리거를 우회할 수 있다. 트리거는 "코드 실수 방지"용 1선이지 위변조 방지의 최종 근거가 아니다. 보강:
1. `chainHash` 체인(위 스키마)을 일일 대사(14.2)가 지갑별로 재계산해 **삭제·수정·삽입 변조를 실제 탐지**한다.
2. P7에서 pgaudit 등 DB 감사로 `DISABLE TRIGGER`·`session_replication_role` 변경을 알람 대상에 등재한다.

**reversal 분개의 lot 처리 규약 (레드팀 M5 — 이 규약 없이 잔액만 ±하면 I2가 깨진다)**:
- 음수 분개의 reversal(양수): **원분개 `lotBreakdown`의 lot들에 remaining을 복원**한다(exhausted→active 되돌림). 대상 lot이 이미 expired/revoked면 동일 source·만료 조건의 대체 lot을 신규 생성하고 그 사실을 reason에 기록.
- 양수 분개의 reversal(음수): 해당 lot을 **지정 차감**(5.2의 `lotSelection.targetLotIds`)한다.

### 4.4 credit_holds

```ts
export const creditHolds = pgTable("credit_holds", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletId: uuid("wallet_id").notNull().references(() => creditWallets.id, { onDelete: "restrict" }),
  usageEventId: uuid("usage_event_id").notNull().references(() => usageEvents.id, { onDelete: "restrict" }),
  heldCredits: bigint("held_credits", { mode: "number" }).notNull(),
  capturedCredits: bigint("captured_credits", { mode: "number" }),
  status: creditHoldStatusEnum("status").default("pending").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // 생성 + credit_settings.hold_ttl_seconds (기본 600초)
  releasedReason: text("released_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  walletPendingIdx: index("credit_holds_wallet_pending_idx").on(table.walletId, table.status),
  expiresIdx: index("credit_holds_expires_idx").on(table.status, table.expiresAt),
  usageEventIdx: uniqueIndex("credit_holds_usage_event_idx").on(table.usageEventId),
}));
```

### 4.5 usage_events (미터링 — 과금·무과금 공통)

```ts
export const usageEvents = pgTable("usage_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletId: uuid("wallet_id").references(() => creditWallets.id, { onDelete: "restrict" }), // 익명(랜딩 팝빌)·운영 배치는 null
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  featureCode: text("feature_code").notNull(), // 3.2 사전. enum 아닌 text — ops에서 신규 기능 추가 가능해야 함
  provider: text("provider"),                  // "anthropic" 등. 팝빌은 "popbill"
  model: text("model"),
  inputTokens: bigint("input_tokens", { mode: "number" }).default(0).notNull(),
  outputTokens: bigint("output_tokens", { mode: "number" }).default(0).notNull(),
  cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).default(0).notNull(),
  cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).default(0).notNull(),
  providerCostUsdMicros: bigint("provider_cost_usd_micros", { mode: "number" }), // 원가 추적 (USD × 1e6 정수)
  creditsCharged: bigint("credits_charged", { mode: "number" }).default(0).notNull(),
  pricingRuleId: uuid("pricing_rule_id").references(() => creditPricingRules.id, { onDelete: "set null" }),
  status: usageEventStatusEnum("status").default("pending").notNull(),
  requestId: text("request_id"), // 앱 요청 추적 id (감사 로그와 연결)
  contextRef: jsonb("context_ref").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  // 예: { grantId, draftId, sessionId } — 어떤 문서 작업에서 발생했는지. PII 넣지 말 것 (12.4)
  errorCode: text("error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  walletCreatedIdx: index("usage_events_wallet_created_idx").on(table.walletId, table.createdAt),
  featureIdx: index("usage_events_feature_idx").on(table.featureCode, table.createdAt),
  statusIdx: index("usage_events_status_idx").on(table.status),
}));
```

### 4.6 credit_pricing_rules (요율 — ops 편집, 버전 관리)

```ts
export const creditPricingRules = pgTable("credit_pricing_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  ruleType: text("rule_type").notNull(), // "model_token" | "feature_flat" | "feature_free"
  featureCode: text("feature_code"),     // feature_* 룰에서 사용. model_token 룰은 null이면 모델 기본값
  model: text("model"),                  // model_token 룰: "claude-sonnet-5" 등. null = 전 모델 기본값
  inputMillicreditsPer1k: bigint("input_millicredits_per_1k", { mode: "number" }),
  outputMillicreditsPer1k: bigint("output_millicredits_per_1k", { mode: "number" }),
  cacheReadMillicreditsPer1k: bigint("cache_read_millicredits_per_1k", { mode: "number" }),
  cacheWriteMillicreditsPer1k: bigint("cache_write_millicredits_per_1k", { mode: "number" }),
  flatCredits: bigint("flat_credits", { mode: "number" }), // feature_flat 룰
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveUntil: timestamp("effective_until", { withTimezone: true }), // null = 현행. 새 버전 생성 시 이전 버전 마감
  createdByAdminId: text("created_by_admin_id").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  lookupIdx: index("credit_pricing_rules_lookup_idx").on(table.ruleType, table.featureCode, table.model, table.effectiveFrom),
}));
```

**요율 해석 순서 (6.3의 resolver가 구현)**: `feature_free(featureCode)` > `feature_flat(featureCode)` > `model_token(model 정확 일치)` > `model_token(model=null 기본값)`. 해당 시점(`effectiveFrom <= now < effectiveUntil`)의 룰만. 룰이 하나도 없으면 **호출 거부**(요율 미정의 모델로 과금 0이 되는 사고 방지).

**요율은 UPDATE하지 않는다** — 새 행 insert + 이전 행 `effectiveUntil` 마감. 분개의 `pricingSnapshot`과 함께 "그때 왜 그 값이었나"를 재구성 가능하게 한다.

### 4.7 credit_settings (전역 설정 KV)

```ts
export const creditSettings = pgTable("credit_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedByAdminId: text("updated_by_admin_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

**초기 키 목록** (시드로 삽입):

| key | 초기 value | 의미 |
|---|---|---|
| `krw_per_credit` | `{ "value": 1 }` | 환율 앵커 (2.1 — 사실상 고정) |
| `signup_bonus_credits` | `{ "value": 1000 }` | 가입 보너스량 |
| `signup_bonus_expiry_days` | `{ "value": 90 }` | 보너스 만료 |
| `purchase_expiry_days` | `{ "value": 1825 }` | 충전분 만료 (5년) |
| `hold_ttl_seconds` | `{ "value": 600 }` | hold 타임아웃 |
| `hold_buffer_ratio` | `{ "value": 1.2 }` | 예상치 대비 hold 배수 |
| `low_balance_warn_credits` | `{ "value": 200 }` | 잔액 경고 임계값 |
| `payment_order_ttl_minutes` | `{ "value": 90 }` | 주문 유효시간 |
| `plan_retry_schedule_days` | `{ "value": [1, 3] }` | 갱신 실패 재시도 (D+1, D+3 — 한 번에 하나만 등록, 8.4) |
| `plan_grant_expiry_cycles` | `{ "value": 2, "flexValue": 3 }` | 플랜 lot 만료 주기 수 (8.1) |
| `admin_grant_review_threshold` | `{ "value": 50000 }` | 초과 시 owner 2인 결재 (11.4) |
| `support_grant_ticket_cap` | `{ "value": 1000 }` | support 보상 건당 한도 (9.3) |
| `support_grant_daily_cap` | `{ "value": 2000 }` | support 보상 1인 1일 한도 |
| `company_bonus_consumption_cap` | `{ "value": 3000 }` | 회사당 가입 보너스 소모 상한 (13.1) |

설정 변경은 반드시 감사 로그(12.2)를 남긴다. 값 캐싱은 프로세스 내 60초 TTL (결제·정산 경로에서는 캐시 무시하고 직독).

### 4.8 credit_products / credit_payment_orders

```ts
export const creditProducts = pgTable("credit_products", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull(),          // "topup_10k" 등
  name: text("name").notNull(),          // "10,000 크레딧"
  amountKrw: integer("amount_krw").notNull(),
  credits: bigint("credits", { mode: "number" }).notNull(),
  bonusCredits: bigint("bonus_credits", { mode: "number" }).default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  codeIdx: uniqueIndex("credit_products_code_idx").on(table.code),
}));
```

**초기 상품** (시드): 5,000원=5,000cr / 10,000원=10,000cr / 30,000원=30,000+900(3%) / 50,000원=50,000+2,500(5%) / 100,000원=100,000+8,000(8%).

```ts
export const creditPaymentOrders = pgTable("credit_payment_orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  paymentId: text("payment_id").notNull(),  // 포트원 전달값. 서버 생성: `cnord_${id의 hex}` (7.2). 6~64자 [a-zA-Z0-9-_]
  walletId: uuid("wallet_id").notNull().references(() => creditWallets.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  orderType: text("order_type").notNull(),  // "credit_topup" | "plan_initial" | "plan_renewal"
  productId: uuid("product_id").references(() => creditProducts.id, { onDelete: "restrict" }),
  planSubscriptionId: uuid("plan_subscription_id"),
  amountKrw: integer("amount_krw").notNull(),
  creditsToGrant: bigint("credits_to_grant", { mode: "number" }).notNull(), // 보너스 포함. 주문 시점 스냅샷
  krwPerCreditSnapshot: integer("krw_per_credit_snapshot").notNull(),
  status: creditOrderStatusEnum("status").default("created").notNull(),
  portoneStatus: text("portone_status"),   // 포트원 원본 상태 기록용
  portoneTxId: text("portone_tx_id"),
  payMethod: text("pay_method"),           // CARD 등 (검증 응답에서 저장)
  paidAt: timestamp("paid_at", { withTimezone: true }),
  failReason: text("fail_reason"),
  refundedAmountKrw: integer("refunded_amount_krw").default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // 생성 + payment_order_ttl
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  paymentIdIdx: uniqueIndex("credit_payment_orders_payment_id_idx").on(table.paymentId),
  walletIdx: index("credit_payment_orders_wallet_idx").on(table.walletId, table.createdAt),
  statusIdx: index("credit_payment_orders_status_idx").on(table.status, table.createdAt),
}));
```

### 4.9 credit_plans / credit_plan_subscriptions

```ts
export const creditPlans = pgTable("credit_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull(),           // "plus" | "pro" | "flex"
  name: text("name").notNull(),
  monthlyPriceKrw: integer("monthly_price_krw").notNull(),
  monthlyCredits: bigint("monthly_credits", { mode: "number" }).notNull(),
  features: jsonb("features").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  displayOrder: integer("display_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  codeIdx: uniqueIndex("credit_plans_code_idx").on(table.code),
}));
```

**초기 플랜** (시드 — 8.1에서 근거):

| code | 월 가격 | 월 크레딧 | 보너스율 |
|---|---|---|---|
| plus | 9,900원 | 11,000 | +11% |
| pro | 29,900원 | 35,000 | +17% |
| flex | 79,900원 | 100,000 | +25% |

```ts
export const creditPlanSubscriptions = pgTable("credit_plan_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  walletId: uuid("wallet_id").notNull().references(() => creditWallets.id, { onDelete: "restrict" }),
  planId: uuid("plan_id").notNull().references(() => creditPlans.id, { onDelete: "restrict" }),
  status: creditPlanSubStatusEnum("status").default("active").notNull(),
  billingKey: text("billing_key").notNull(),          // 포트원 빌링키 (카드정보 아님 — 12.4)
  billingKeyIssuedAt: timestamp("billing_key_issued_at", { withTimezone: true }),
  cardSummary: jsonb("card_summary").$type<{ brand?: string; last4?: string }>(), // 표시용 최소 정보
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").default(false).notNull(),
  nextScheduleId: text("next_schedule_id"),           // 포트원 예약결제 scheduleId
  nextSchedulePaymentId: text("next_schedule_payment_id"), // 예약에 쓴 paymentId (주문 매칭용)
  retryCount: integer("retry_count").default(0).notNull(),
  pendingPlanId: uuid("pending_plan_id"),             // 다운그레이드 예약 (다음 주기부터 적용)
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userActiveIdx: index("credit_plan_subs_user_idx").on(table.userId, table.status),
  scheduleIdx: index("credit_plan_subs_schedule_idx").on(table.nextSchedulePaymentId),
}));
```

- 앱 레벨 제약: user당 `status IN (active, past_due)` 구독 최대 1개. (partial unique index를 마이그레이션에 수동 추가: `CREATE UNIQUE INDEX credit_plan_subs_one_active ON credit_plan_subscriptions (user_id) WHERE status IN ('active','past_due');` — `incomplete`는 의도적으로 제외: 결제 미완 행은 재시도 시 같은 행을 재사용(upsert)하며 active를 막지 않는다. 레드팀 M6)

### 4.10 portone_webhook_events (inbox)

```ts
export const portoneWebhookEvents = pgTable("portone_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  webhookId: text("webhook_id").notNull(),  // Standard Webhooks `webhook-id` 헤더 — 멱등 키
  eventType: text("event_type").notNull(),  // "Transaction.Paid" 등
  paymentId: text("payment_id"),
  billingKey: text("billing_key"),
  payloadDigest: jsonb("payload_digest").$type<Record<string, unknown>>().notNull(), // 화이트리스트 발췌만 — 원문은 저장하지 않는다 (아래 규약)
  processingStatus: text("processing_status").default("received").notNull(), // received | processed | skipped | failed
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  webhookIdIdx: uniqueIndex("portone_webhook_events_webhook_id_idx").on(table.webhookId),
  paymentIdx: index("portone_webhook_events_payment_idx").on(table.paymentId),
  statusIdx: index("portone_webhook_events_status_idx").on(table.processingStatus, table.createdAt),
}));
```

**payload 원문 비저장 규약 (레드팀 M5 — PII 최소화)**: 서명 검증은 rawBody로 수행한 뒤 원문은 **버린다**. 저장은 `{ type, paymentId, billingKey, status, amountTotal, timestamp }` 화이트리스트 발췌(`payloadDigest`)만. 웹훅에 포함될 수 있는 고객 이름·연락처 등은 저장하지 않는다. 분쟁·재처리 시 원문이 필요하면 `GET /payments/{id}` 재조회로 항상 재구성 가능하다(웹훅은 트리거일 뿐 진실이 아니라는 7.3 원칙과 정합).

### 4.11 credit_audit_logs (append-only — 12장에서 규약)

```ts
export const creditAuditLogs = pgTable("credit_audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: text("action").notNull(),            // 12.2의 액션 사전
  actorType: creditActorTypeEnum("actor_type").notNull(),
  actorId: text("actor_id"),                   // admin_users.id | users.id | "system:{프로세스명}"
  actorEmail: text("actor_email"),             // 비정규화. 감사 목적의 법정 보존이 처리 근거 — 12.5에 명시 (append-only라 사후 마스킹 불가하므로 근거 명시 필수)
  actorRole: text("actor_role"),               // admin일 때 owner|admin|support|viewer
  targetType: text("target_type").notNull(),   // "wallet" | "ledger" | "pricing_rule" | "setting" | "order" | "subscription" | "product" | "plan"
  targetId: text("target_id").notNull(),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  reason: text("reason"),                      // admin 변이는 앱 레벨 NOT NULL 강제
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  requestId: text("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  targetIdx: index("credit_audit_logs_target_idx").on(table.targetType, table.targetId, table.createdAt),
  actorIdx: index("credit_audit_logs_actor_idx").on(table.actorType, table.actorId, table.createdAt),
  actionIdx: index("credit_audit_logs_action_idx").on(table.action, table.createdAt),
}));
```

append-only 트리거는 4.3과 동일하게 적용.

### 4.12 credit_reconciliation_runs

```ts
export const creditReconciliationRuns = pgTable("credit_reconciliation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  runDate: timestamp("run_date", { withTimezone: true }).notNull(),
  scope: text("scope").notNull(),     // "ledger_wallet" | "lot_ledger" | "portone_orders" | "holds"
  status: text("status").notNull(),   // "ok" | "mismatch" | "error"
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  dateIdx: index("credit_recon_runs_date_idx").on(table.runDate, table.scope),
}));
```

### 4.13 RLS 정책

기존 패턴(`db/migrations/0003_rls_company_scope.sql`의 `app_private.current_user_id()`)을 따른다. **레드팀 검증으로 초안의 전제("FORCE를 걸면 admin이 차단된다")가 오진으로 판정됐다.** 코드 대조 결과:

- 웹앱과 admin은 **동일한 `DATABASE_URL`(동일 DB 역할)** 로 접속하고, admin은 `app.current_user_id`를 어디서도 세팅하지 않는다.
- 그럼에도 admin은 `FORCE ROW LEVEL SECURITY`가 걸린 기존 테이블(`companies`, `billing_tax_documents`(0021에서 FORCE) 등)을 정상적으로 읽고 쓴다. user 컨텍스트 없이 FORCE 테이블이 읽힌다는 것은 **접속 역할이 BYPASSRLS(또는 superuser) 속성일 가능성이 높다**는 뜻이다. 그렇다면 ENABLE/FORCE 구분은 admin에게 무의미하며, RLS는 "정책 평가를 받는 역할"에게만 작동한다.
- 웹앱에는 user 컨텍스트를 세팅하지 않는 트랜잭션 경로(`transactionWithOptionalUser(userId=undefined)`, `apps/web/src/lib/server/repositories/drizzle.ts`)가 존재한다 — 이 경로에서 크레딧 테이블을 만지면 RLS 유무와 무관하게(BYPASSRLS라면) 통째로 우회된다.

**P1 착수 시 실측 의무 (구현 세션 필수 절차)** — 가정하지 말고 측정한다:

```sql
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user;
```

| 실측 결과 | 방침 |
|---|---|
| BYPASSRLS 또는 superuser (유력) | 크레딧 전 테이블에 ENABLE + **FORCE** 적용. admin은 어차피 통과하므로 접근성을 잃지 않고, 향후 non-BYPASSRLS 역할 도입 시 즉시 방어가 산다. 단 이 구조에서 RLS는 2선 방어일 뿐 — 아래 "코드 레벨 통제"가 1선 |
| 일반 역할 | FORCE 적용 시 admin이 차단됨 → admin 전용 DB 역할(BYPASSRLS 부여 또는 정책 예외 함수)을 먼저 분리한 뒤 FORCE 적용 |

실측 결과와 선택한 분기를 마이그레이션 커밋 메시지에 기록한다.

**코드 레벨 통제 (RLS와 무관하게 필수 — 실질 1선 방어)**:
- 크레딧 리포지토리의 모든 메서드는 **`withCunoteDbUser(userId)` 경유만 허용**한다. user 컨텍스트 없는 경로(`transactionWithOptionalUser` 등)에서 크레딧 테이블에 접근하면 런타임 예외를 던지는 가드를 리포지토리 계층에 넣는다. 예외: 익명 팝빌 미터링의 usage_events INSERT(walletId=null)와 웹훅·cron의 시스템 경로는 **명시적 별도 함수**로 분리해 감사 가능하게 한다.
- 웹앱/admin의 **DB 역할 분리**(웹앱은 non-BYPASSRLS 최소 권한 역할, admin·배치는 별도 역할)를 P7 과제로 등재한다. 단일 BYPASSRLS 역할 구조에서 RLS는 장식이라는 사실을 문서로 인정하고, 그때까지는 코드 레벨 가드가 방어선이다.

**테이블별 정책** (정책 네이밍 `credit_wallets_self_select` 형식):

| 테이블 | 정책 |
|---|---|
| credit_wallets, credit_lots, credit_ledger, credit_holds, usage_events, credit_payment_orders, credit_plan_subscriptions | SELECT: 본인 소유 행만(`credit_wallets.user_id = app_private.current_user_id()` 직접 또는 wallet_id 조인). INSERT/UPDATE 정책 없음 → 정책 평가 대상 역할 기준 서버 신뢰 경로만 변이 가능 |
| credit_audit_logs, portone_webhook_events, credit_reconciliation_runs, credit_settings, credit_pricing_rules | **웹 사용자용 정책 없음** (전부 차단) |
| credit_products, credit_plans | SELECT: `is_active = true` 행 전원 허용 (비로그인 /pricing 노출용) |

**요율·설정의 클라이언트 노출 규약 (레드팀 지적 — "전부 차단"과 /pricing 요율 표시의 모순 해소)**: `credit_pricing_rules`·`credit_settings`는 RLS로 차단이 맞다. /pricing·/credits의 "예상 소모량" 표시는 **서버 라우트(`GET /api/web/plans`, `/api/web/credits/products`, `/api/web/credits/estimate`)가 서버 신뢰 경로로 읽어 가공한 결과만** DTO로 내려준다. `input_millicredits_per_1k` 같은 원시 요율은 마진 역산이 가능하므로 클라이언트에 그대로 노출하지 않는다 — "지원서 초안 1회 약 ○○○ 크레딧" 형태의 파생값만.

`packages/contracts/scripts/verify-rls-policy.ts`의 보호 테이블·정책 목록에 위 테이블·정책 이름을 추가한다.

**구현 시 검증 의무**: 마이그레이션 적용 후 (1) admin 커넥션으로 `SELECT count(*) FROM credit_ledger` 동작, (2) 웹 커넥션(user 세팅)으로 타인 지갑 조회 0행, (3) user 컨텍스트 없는 웹 커넥션으로 크레딧 테이블 조회가 코드 가드에 걸리는지 — 셋 다 확인하고 결과를 커밋 메시지에 남긴다.

---

## 5. 원장 회계 규칙

### 5.1 불변식 (Invariants) — 14장의 verify 스크립트가 기계 검증

| # | 불변식 |
|---|---|
| I1 | `credit_wallets.balance_credits` = Σ `credit_ledger.amount_credits` (지갑별) |
| I2 | `credit_wallets.balance_credits` = Σ `credit_lots.remaining_credits` (status=active) |
| I3 | 모든 음수 분개: Σ `lot_breakdown[].amount` = `-amount_credits` |
| I4 | 모든 양수 분개(지급): 정확히 1개 lot 생성, `lot_breakdown` = `[{lotId, initialCredits}]` |
| I5 | lot별: `initial - remaining` = Σ (해당 lot을 참조하는 음수 분개의 배분량) |
| I6 | `usage_events(status=settled).credits_charged` = 대응 `usage_capture` 분개의 `-amount` (usage_event_id로 조인, 1:1). **shortfall 발생 시(5.3) `credits_charged`는 실차감액**이고 부족분은 `context_ref.shortfall`에 기록 — `credits_charged + shortfall`이 요율 계산값과 일치해야 한다 (레드팀 m1: shortfall을 예외로 명시하지 않으면 verify가 오탐) |
| I7 | `paid` 주문마다 `purchase_grant`(또는 `plan_grant`) 분개 정확히 1건 (idempotencyKey가 보장) |
| I8 | available(= balance − Σ pending holds) ≥ 0 이 모든 hold 생성 트랜잭션 직후 성립 |
| I9 | `balance_after`는 해당 지갑 분개를 createdAt·id 순으로 누적한 값과 일치 |
| I10 | ledger·audit_logs에 UPDATE/DELETE 없음 — 트리거(1선) + **chainHash 체인 재검증**(14.2, 2선)으로 보장. 체인 검증은 행 삭제·수정·중간 삽입을 실제 탐지한다 (초안의 "트리거 신뢰"는 앱 역할이 트리거를 끌 수 있어 근거 부족 — 레드팀 M4) |

### 5.2 차감(정산) 알고리즘 — 단일 진입점

모든 잔액 변이는 `packages/core/src/credits/`의 도메인 서비스가 발행하고, Drizzle 리포지토리(트랜잭션)가 집행한다. **이 함수들 외의 경로로 wallet/lot/ledger를 만지는 코드를 절대 만들지 않는다.**

```
applyLedgerEntry(tx, {
  walletId, entryType, amountCredits, idempotencyKey,
  lotSelection,   // "consume_order"(기본: 소진 순서 배분) | { targetLotIds: string[] }(지정 lot만)
  ...
}):
  1. SELECT * FROM credit_wallets WHERE id = walletId FOR UPDATE   -- 지갑 row lock이 직렬화 지점
  2. 멱등 체크: SELECT 1 FROM credit_ledger WHERE idempotency_key = key
     → 존재하면 기존 분개 반환 (no-op, 성공 취급)
  3-a. 지급(양수): credit_lots INSERT (만료일은 4.2.1) → lotBreakdown 구성
  3-b. 차감(음수), lotSelection = "consume_order":
       lots = SELECT * FROM credit_lots
              WHERE wallet_id = walletId AND status = 'active' AND remaining_credits > 0
                AND (expires_at IS NULL OR expires_at > now())
              ORDER BY expires_at ASC NULLS LAST, created_at ASC
              FOR UPDATE
       필요량을 앞에서부터 배분. 총 잔여 < 필요량이면 InsufficientCreditsError (호출측 규약: HTTP 402)
       각 lot UPDATE remaining -= 배분량 (0되면 status=exhausted)
  3-c. 차감(음수), lotSelection = { targetLotIds }:
       지정 lot만 FOR UPDATE — 만료·상태 필터를 적용하지 않는다.
       ★ expiry(5.4)·refund_deduct(7.4)·reversal(4.3)은 반드시 이 모드를 쓴다.
         consume_order로 흘리면 만료 대상이 아닌 다른 lot을 깎아 I2·I5가 붕괴한다 (레드팀 M1).
  4. INSERT credit_ledger (balance_after = 잔액 ± amount, chainHash 계산 포함)
  5. UPDATE credit_wallets SET balance_credits = balance_after, updated_at = now()
  6. (호출측 필요 시) 같은 tx에서 usage_events/holds/orders 갱신
```

- unique 제약(idempotencyKey) 충돌 시에도 no-op 성공으로 처리한다 (동시 중복 요청 경쟁 안전). 단 **"충돌=성공" 규약은 키가 진짜 같은 작업일 때만 안전**하다 — 키 설계가 4.3 표를 벗어나면 이 규약이 지급 소실을 은폐하므로(레드팀 B1), 새 분개 유형을 추가할 때는 반드시 4.3 표를 갱신한다.
- `wallet.status = frozen`이면 신규 hold·checkout 경로의 지급·차감은 `WalletFrozenError`. **예외 허용 목록**: usage_capture(진행 중이던 hold의 정산), refund_deduct, admin_grant/admin_deduct, reversal (4.1 frozen 의미론).
- raw SQL로 이 알고리즘을 재현하는 admin 경로(9.3) 주의: postgres.js는 `SUM(...)` 집계를 **문자열로 반환**한다. `available = balance - Number(pendingHolds)` 캐스팅을 누락하면 문자열 연산으로 hold 게이트가 무너진다 (레드팀 m5. 이 코드베이스에 bigint 사용 전례가 없음).

### 5.3 hold 알고리즘

```
acquireHold(tx, { walletId, usageEventId, estimatedCredits }):
  1. 지갑 FOR UPDATE
  2. pendingHolds = SELECT COALESCE(SUM(held_credits),0) FROM credit_holds
                    WHERE wallet_id = walletId AND status = 'pending'
  3. available = balance_credits - pendingHolds
  4. held = ceil(estimatedCredits × hold_buffer_ratio)
  5. available < held → InsufficientCreditsError(402) + 부족량 포함 응답
  6. INSERT credit_holds (expiresAt = now + hold_ttl_seconds)

captureHold(holdId, actualCredits):
  단일 tx:
  1. hold FOR UPDATE
     - status = 'captured' → 멱등 no-op (이미 정산됨)
     - status = 'released' | 'expired' → ★ 그래도 2번으로 진행한다 (아래 원칙)
  2. applyLedgerEntry(usage_capture, -actualCredits, key=`usage:{usageEventId}`)
     ⚠ actualCredits > heldCredits 허용 (이미 서비스 제공됨). 단 lot 총잔여 부족 시:
        차감 가능한 만큼만 차감(잔액 0), usage_events.context_ref.shortfall에 부족량 기록,
        creditsCharged = 실차감액 (I6의 shortfall 예외),
        audit_log(action="usage.shortfall") 기록. 음수 잔액은 만들지 않는다 (4.1).
     ⚠ lot 만료 유예: 이 차감의 lot 필터는 `expires_at > hold.createdAt`을 쓴다 —
        hold 시점에 살아있던 lot은 capture 시점에 만료됐어도 소진 가능 (레드팀 M8:
        plan lot 만료 직전 대형 작업으로 무과금을 반복하는 공격 차단).
  3. hold UPDATE status=captured (TTL 경과 후 정산이면 releasedReason="captured_late" 유지 기록),
     capturedCredits=actual
  4. usage_events UPDATE status=settled, creditsCharged=실차감액
     (만료 cron이 먼저 failed로 바꿨더라도 capture가 settled로 되돌린다)

releaseHold(holdId, reason): status=released. 원장 분개 없음 (hold는 분개가 아니므로).
  단, 이미 captured면 no-op — release가 정산을 되돌리지 않는다.
```

**capture는 hold 상태에 의존하지 않는다 (레드팀 B3 — BLOCKER 수정)**: hold는 입장 통제(admission control)일 뿐이고, 과금의 멱등성은 `usage:{usageEventId}` 키가 보장한다. 초안처럼 "released/expired면 no-op"으로 하면, LLM 호출이 TTL(10분)을 넘긴 뒤 정상 완료했을 때 **서비스는 제공되고 과금은 무음 소실**되며, usage_event가 failed로 남아 진짜 실패와 구분 불가능해 대사로도 잡을 수 없다. TTL 경과 후 정산은 `usage.capture_after_expiry` audit_log로 기록해 빈도를 관찰한다(빈발 시 hold_ttl 상향).

- **만료 cron** (`/api/cron/credits-expire-holds`, 매 5분): `status=pending AND expires_at < now()` → released(reason="ttl_expired") + usage_events.status=failed(errorCode="hold_expired"). 이 전환은 **잠정적**이다 — 뒤늦은 capture가 도착하면 위 규칙대로 정산이 이긴다. LLM 호출이 10분을 넘는 설계가 생기면 hold_ttl을 feature별로 오버라이드(18.5).

### 5.4 만료(expiry) 처리

일일 cron (`/api/cron/credits-expire-lots`, KST 04:00): `status=active AND expires_at < now() AND remaining > 0`인 lot마다 `applyLedgerEntry(expiry, -remaining, key=expiry:{lotId}, lotSelection={targetLotIds:[lotId]})` → lot status=expired.

- **반드시 `targetLotIds` 모드** — consume_order로 흘리면 만료 lot은 필터에서 빠지고 그 금액이 살아있는 다른 lot에서 깎여 장부가 붕괴한다 (레드팀 M1).
- **pending hold가 있는 지갑은 이번 회차 스킵**한다 — 5.3의 capture 만료 유예와 경합하지 않기 위함. 다음 회차(24h 뒤)에 hold가 정리된 뒤 만료 처리해도 손해가 없다.
- 만료 7일 전 사용자 알림(10.3의 만료 예정 표시 + 알림은 18.6).

### 5.5 요율 계산 공식

```
creditsFor(usage, rule) = ceil(
  ( usage.inputTokens      × rule.inputMillicreditsPer1k
  + usage.outputTokens     × rule.outputMillicreditsPer1k
  + usage.cacheReadTokens  × rule.cacheReadMillicreditsPer1k
  + usage.cacheWriteTokens × rule.cacheWriteMillicreditsPer1k
  ) / 1000 / 1000            -- per1k 나눗셈 + 밀리크레딧→크레딧
)
```

**ops 요율 산정 가이드 공식** (11.3 화면에 계산기로 제공):
```
millicredits_per_1k = ceil( usd_per_1M_tokens / 1000   -- USD per 1k tokens
                            × fx_krw_usd                 -- 예: 1400
                            × (1 + margin)               -- 예: 1.0 = 마진 100%
                            / krw_per_credit             -- 1
                            × 1000 )                     -- 밀리크레딧
```

**예시** (구현 시점의 실제 Anthropic 단가로 갱신할 것 — 이 수치는 산정 방법 예시):
- output $15/1M, 환율 1,400, 마진 100% → 15/1000×1400×2 = 42 KRW/1k tokens → `output_millicredits_per_1k = 42,000`
- input $3/1M → 8.4 KRW/1k → `input_millicredits_per_1k = 8,400`
- 지원서 초안 1회(input 20k + output 8k) ≈ 168 + 336 = **약 504 크레딧** → 무료 1,000 크레딧으로 약 2회 체험 가능. 이 체감 규모가 온보딩 목표와 맞는지 시드 값 결정 시 재확인한다.
- **캐시 토큰 요율 주의 (레드팀 m2)**: cache read의 실원가는 input의 ~10%다. 캐시 요율을 원가 비례로만 잡으면 캐시 히트가 많은 워크로드에서 마진이 샌다. 캐시 read/write 요율에도 동일 마진율을 적용하되, 사용자 표시는 "기능당 예상 크레딧"으로 단순화하므로 요율 구조가 노출되지 않는다.
- **명목 마진 ≠ 실효 마진**: 실패 호출 무료 처리, shortfall 미수, 무료 보너스 소모 원가, 팝빌 무과금 원가가 실효 마진을 깎는다. 11.1 대시보드가 두 마진을 분리 표시한다.

---

## 6. 과금 파이프라인

### 6.1 아키텍처 배치

- **도메인 로직**: `packages/core/src/credits/` — 순수 함수 + 포트 인터페이스. LLM·DB 미의존.
  - `pricing.ts` (요율 resolver·계산), `ledger.ts` (분개 규칙·멱등 키 빌더), `metering.ts` (withCreditMetering 래퍼), `errors.ts` (InsufficientCreditsError 등), `ports.ts` (CreditRepository 포트)
- **리포지토리 포트**: `packages/core/src/repositories/ports.ts`의 `ServiceRepositories`에 `credits: CreditRepository` 추가 (기존 4단계 등록 절차: ports → drizzle → runtime → serviceData).
- **Drizzle 구현**: `apps/web/src/lib/server/repositories/drizzle.ts`에 5.2/5.3 트랜잭션 구현.
- **주의 (프로젝트 메모리)**: `packages/core` 수정 후 `pnpm --filter @cunote/core build` 없이는 dev 서버에 반영되지 않는다.

### 6.2 LLM 호출 래퍼 — `withCreditMetering`

사용자 트리거 LLM 호출(지원서 드래프트 등, 현재 미구현)은 **반드시 이 래퍼를 통해서만** 구현한다. 기존 운영 배치 LLM(bizinfo/knowledge/prelabel)도 P2에서 이 래퍼(무과금 모드)로 감싸 원가를 수집한다.

```ts
// packages/core/src/credits/metering.ts — 시그니처 (의사코드)
async function withCreditMetering<T>(
  deps: { credits: CreditRepository; now: () => Date },
  ctx: {
    userId: string | null;        // 운영 배치는 null
    companyId: string | null;
    featureCode: string;          // 3.2 사전
    model: string;
    estimate: { inputTokens: number; maxOutputTokens: number }; // hold 산정용
    requestId: string;
    contextRef?: Record<string, unknown>;
  },
  run: (report: (usage: TokenUsage) => void) => Promise<T>,
): Promise<{ result: T; usageEvent: UsageEvent }>

흐름:
  1. rule = resolvePricingRule(featureCode, model, now)   // 없으면 PricingRuleMissingError — 호출 자체 거부
  2. rule이 feature_free → usage_events INSERT(status=free, creditsCharged=0) → run() → usage만 기록. hold 없음
  3. 과금 룰:
     a. usage_events INSERT (status=pending)
     b. estimatedCredits = creditsFor(estimate를 토큰 상한으로 환산, rule)
     c. acquireHold(...)                    // 402 여기서 발생
     d. try { result = await run(report) }  // report()로 스트리밍 종료 시 실제 usage 전달
        catch → releaseHold(reason=llm_error) + usage_events.status=failed → rethrow
     d-2. report(usage) 수신 즉시 usage_events에 토큰량을 UPDATE (★ capture 전 선기록 —
          이후 프로세스가 죽어도 실측 토큰이 DB에 남아 수동 정산의 산정 근거가 된다. 레드팀 m2)
     e. actualCredits = creditsFor(실제 usage, rule)
     f. captureHold(holdId, actualCredits)  // 분개 발생, pricingSnapshot 저장
  4. 반환. 호출측은 usageEvent.creditsCharged를 응답에 포함(UI 표시용)
```

- **estimate와 실제 호출의 결속 (레드팀 M8)**: `ctx.estimate.maxOutputTokens`는 hold 산정용 입력이면서 **실제 LLM API 호출의 `max_tokens` 파라미터에 그대로 바인딩해야 한다**. 결속하지 않으면 과소 estimate 기능 하나가 hold를 뚫고 다른 정상 hold의 예약분까지 잠식한다(shortfall 증폭). 래퍼가 run 콜백에 `maxTokens`를 주입하는 형태로 구조적으로 강제한다.
- **부분 실패 복구**: run()은 성공했는데 captureHold 전에 프로세스가 죽으면 → hold가 TTL로 release되고 usage_event가 pending으로 남는다. 일일 대사(14.2)가 `pending인데 hold가 released/expired`인 이벤트를 리포트한다. **d-2의 선기록 덕분에 토큰량이 남아 있으면** 운영자가 그 값으로 수동 정산(admin_deduct 또는 뒤늦은 captureHold 재호출 — usage 키 멱등이라 안전)하고, 선기록조차 없으면(스트리밍 도중 사망) 무료 처리 + 발생률 메트릭으로 관찰한다. 자동 재차감은 하지 않는다.
- **Anthropic 응답의 usage**: 기존 코드가 raw fetch를 쓰므로 응답 JSON의 `usage.input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens`를 `report()`로 넘긴다. 스트리밍이면 `message_delta` 이벤트의 누적 usage를 사용.

### 6.3 요율 resolver

`resolvePricingRule(featureCode, model, at)`:
1. `feature_free` 룰 (featureCode 일치, 유효기간 내) → 무과금
2. `feature_flat` 룰 → flatCredits 고정 차감 (estimate 무시, hold=flatCredits)
3. `model_token` 룰 (model 정확 일치) → 토큰 요율
4. `model_token` 룰 (model IS NULL 기본값) → 토큰 요율
5. 없음 → `PricingRuleMissingError` (호출 거부 + 운영 알림 로그). **"요율 없으면 공짜"가 아니라 "요율 없으면 불가"** — 신규 모델 도입 시 요율 등록을 강제하는 안전장치.

### 6.4 API 오류 규약

| 상황 | HTTP | ActionResult.error.code |
|---|---|---|
| 잔액 부족 (hold 실패) | 402 | `insufficient_credits` — `error.meta`에 `{ required, available, shortfall }` |
| 지갑 동결 | 403 | `wallet_frozen` |
| 요율 미정의 | 503 | `pricing_unavailable` |
| 결제 검증 불일치 | 409 | `payment_mismatch` |

`packages/contracts/src/dto.ts`의 `ActionResult` error 객체에 `meta?: Record<string, unknown>` 필드를 추가한다 (기존 필드는 불변).

### 6.5 팝빌 조회 미터링 (무과금 — 요구 10)

- 위치: `apps/web/src/lib/server/serviceData.ts`의 `loadPopbillCompanyProfile()` 반환 직전.
- `evidence.cacheStatus`가 실호출(live)일 때만 `usage_events` INSERT: `featureCode="popbill_lookup"`, `provider="popbill"`, `creditsCharged=0`, `status="free"`, walletId는 세션 있으면 연결·비로그인 랜딩이면 null, `contextRef={ bizNoRef }`. `bizNoRef`는 **서버 보관 pepper를 쓴 HMAC-SHA256** — 사업자번호는 10자리라 무염 SHA-256은 전수 계산으로 즉시 역산된다(레드팀 m1). 이 값은 익명화가 아니라 join 회피용 가명 키(pseudonymous key)임을 오해 없이 표기한다.
- 캐시 히트는 기록하지 않는다 (외부 원가 없음). 목적: 팝빌 원가 추적 + 향후 과금 전환 시 데이터 근거.
- 요율 테이블에 `feature_free` 룰로도 등재해 두어 "popbill_lookup은 의도된 무과금"임을 시스템에 명시한다.

### 6.6 가입 보너스 지급 훅 — lazy grant (레드팀 m3 반영)

- 지급 시점: **가입 즉시가 아니라 "이메일 인증 완료" 시점** (OAuth 가입은 provider가 이메일을 검증하므로 최초 로그인 즉시). 봇 대량 가입이 지갑·lot·만료 분개를 양산해 부채 지표와 만료 cron을 오염시키는 것을 지급 이연으로 차단한다. 요구 1("모든 가입 사용자에게 지급")은 유지된다 — 정상 사용자는 인증 직후 받는다.
- 구현: 공통 함수 `ensureWalletWithSignupBonus(userId)`를 (1) 이메일 인증 완료 핸들러, (2) OAuth 최초 로그인, (3) 크레딧 잔액 첫 조회 시(안전망) 세 곳에서 호출. 지갑 없으면 생성 + `signup_bonus_grant` 분개 (key=`signup:{userId}` — 재호출·경쟁 안전).
- 소모 조건: **보너스를 포함한 모든 크레딧의 LLM 소모는 회사 연결을 요구**하되, 이 게이트의 어뷰징 방어 강도 평가와 회사 스코프 소모 상한은 13.1 참조 (초안의 "인증 게이트로 파밍 차단" 주장은 레드팀에서 반박됨).

---

## 7. 포트원 V2 연동

### 7.1 환경변수 (.env.example에 추가)

```
PORTONE_STORE_ID=store-...
PORTONE_API_SECRET=...            # 서버 전용. 클라이언트 노출 금지
PORTONE_CHANNEL_KEY_TOSS=channel-key-...          # 단건결제 채널
PORTONE_CHANNEL_KEY_TOSS_BILLING=channel-key-...  # 빌링키(정기) 채널 — 토스 정기결제 MID 별도
PORTONE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_PORTONE_STORE_ID=store-...            # 브라우저 SDK용
NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSS=channel-key-...
NEXT_PUBLIC_PORTONE_CHANNEL_KEY_TOSS_BILLING=channel-key-...
```

의존성: `apps/web`에 `@portone/browser-sdk`, `@portone/server-sdk`(Node 20+ 필요 — 현재 프로젝트 Node 버전 확인) 추가.

### 7.2 충전(단건결제) 시퀀스

```
[클라] /credits에서 상품 선택
  → POST /api/web/credits/checkout { productCode }
[서버] requireWebSession → 지갑 조회(frozen이면 403)
       product 조회(is_active) → credit_payment_orders INSERT
         paymentId = `cnord_` + orderId(uuid)에서 하이픈 제거   // 6~64자 [a-zA-Z0-9-_] 제약 충족
         creditsToGrant = product.credits + product.bonusCredits (스냅샷)
       ← { paymentId, storeId, channelKey, orderName, totalAmount: amountKrw }
[클라] PortOne.requestPayment({
         storeId, channelKey, paymentId, orderName,
         totalAmount, currency: "CURRENCY_KRW",    // 브라우저 SDK는 CURRENCY_ 접두
         payMethod: "CARD",
         redirectUrl: `${origin}/credits/complete?paymentId=...`  // 모바일 리다이렉트 대비 필수
       })
  → (PC: iframe 완료 콜백 / 모바일: redirectUrl 복귀)
  → POST /api/web/credits/checkout/complete { paymentId }
[서버] API 래퍼: 주문 조회 → ★ order.userId === session.userId 검증 (불일치 시 404 —
       주문 존재를 은닉. 타인 주문 상태 조작·잔액 열람 차단. 레드팀 M2/m4)
       → verifyAndGrant(paymentId) → 응답에 balance 포함 (세션 검증을 통과한 경로만)

verifyAndGrant(paymentId):   // ★ 웹훅과 공유하는 내부 함수 (세션 없음 — balance 반환하지 않음)
  0. ★ 주문 상태 가드 (레드팀 M2 — 이 가드 없이는 paid 주문이 failed로 덮인다):
     - order.status ∈ {paid, refunded, partial_refunded} → 현재 상태 반환 (no-op)
     - order.status ∈ {created, pending, expired} → 검증 진행 (expired→paid 전이는
       지연 완료 구제로 명시 허용 — 아래 만료 cron과 정합)
  1. 주문 조회 (없으면 404 unknown_order — "우리가 모르는 결제"로 경보 대상)
  2. GET https://api.portone.io/payments/{paymentId}  (Authorization: PortOne {API_SECRET})
  3. 포트원 상태별 분기:
     - PAID → 대조: payment.amount.total === order.amountKrw && payment.currency === "KRW"
              (서버 API는 접두 없는 "KRW")
              금액·통화 불일치 → order.status=failed + audit_log("payment.mismatch") + 409
     - READY | PENDING | VIRTUAL_ACCOUNT_ISSUED → "결제 대기" 반환 (failed로 만들지 않는다)
     - FAILED (터미널) → order.status=failed(fail_reason)
     - CANCELLED | PARTIAL_CANCELLED → 7.4의 환불 동기화로 위임
  4. PAID 확정 시 트랜잭션:
     applyLedgerEntry(purchase_grant, +creditsToGrant, key=`purchase:{orderId}`)  // 멱등
     order UPDATE status=paid, paidAt, portoneTxId, payMethod
  5. audit_log(action="payment.paid")
```

- **주문 만료 cron** (`/api/cron/credits-expire-orders`, 매 10분): `status IN (created,pending) AND expires_at < now()` → 포트원 능동 조회 1회 → PAID면 verifyAndGrant(지연 완료 구제), 미결제 확정이면 expired. **조회가 에러(네트워크·5xx)면 expired로 확정하지 말고 보류** — 다음 회차에 재시도 (레드팀 m7: 조회 실패를 미결제로 오판하면 결제된 주문이 expired로 방치된다).
- **주문 생성 남용 방어**: checkout(주문 생성)은 user당 분당 10회 제한 + 동시 미결제(created/pending) 주문 5개 초과 시 신규 생성 거부(오래된 것부터 만료 처리). 전역 레이트리밋 인프라가 없는 현 상태의 최소 방어다.

### 7.3 웹훅 처리 — `/api/webhooks/portone`

```
export const runtime = "nodejs";
POST:
  1. rawBody = await request.text()          // ★ JSON 파싱 전 원문 필요 (서명 검증)
  2. Webhook.verify(PORTONE_WEBHOOK_SECRET, rawBody, headers)  // @portone/server-sdk. 실패 → 401 (본문 무시)
  3. portone_webhook_events INSERT (webhookId unique) — 충돌 시 200 반환 (이미 처리, 멱등)
  4. eventType 분기:
     - Transaction.Paid              → verifyAndGrant(paymentId)  (7.2와 동일 함수 — 어느 쪽이 먼저 와도 멱등)
     - Transaction.Failed            → 주문 failed / 구독 갱신이면 8.4 실패 처리
     - Transaction.Cancelled / PartialCancelled → 7.4 환불 동기화 (관리자 콘솔에서 직접 취소한 경우 대비)
     - BillingKey.Deleted            → ★ payload의 billingKey가 구독의 "현재" billingKey와 일치할 때만
                                       past_due 전환 + 사용자 알림 (8.5 키 교체가 스스로 발생시키는
                                       구 키 Deleted 이벤트에 정상 구독이 강등되는 것 방지 — 레드팀 m6)
     - 그 외 → processingStatus=skipped
  5. 처리 결과를 webhook_events UPDATE (processed/failed + error)
  6. 항상 200 (재시도 폭주 방지; 4xx/5xx는 포트원이 최대 5회 재시도 — 0/1/4/16/64/256분)
     단, 서명 실패만 401.
```

- **웹훅은 트리거일 뿐, 진실은 항상 `GET /payments/{id}` 재조회로 확정한다** (포트원 권장 패턴).
- **processingStatus=failed의 자동 복구 (레드팀 M7)**: 처리 실패에도 200을 반환하므로 포트원 재전송이 없고, 동일 webhookId 재전송은 inbox unique에 걸려 삼켜진다. 따라서 `/api/cron/credits-plan-renewals`(9.2)가 매 회차 `processingStatus=failed AND createdAt > now()-48h` 이벤트를 재처리한다(모든 처리 경로가 멱등이므로 안전). 11.5의 수동 재처리 버튼은 그 이후의 보루.
- 웹훅 콜백 주소는 포트원 콘솔에 환경별 등록 (프리뷰 배포는 수동 폴링으로 검증).

### 7.4 환불

**정책** (12.6 약관과 세트). **청약철회(결제 후 7일 이내)와 임의 환불(7일 이후)을 분리**한다 — 전자상거래법 §17 청약철회권은 미사용분 환불을 보장하므로, 보너스 회수 규칙이 철회권을 제약하면 안 된다 (레드팀 M7):

| 구분 | 충전 크레딧 | 플랜 결제 |
|---|---|---|
| **청약철회 (7일 이내)** | 미사용(remaining==initial) 시 전액 환불. 부분 사용 시 **실소진 크레딧의 원화 가치만 차감하고 잔여 원금 환불** — 소진 순서(2.5)상 보너스가 먼저 소모되므로 "보너스만 쓰고 원금 철회"도 원금은 보장된다(철회권 우선). 환불액 = amountKrw − max(0, 소진량 − bonusCredits) × krwPerCreditSnapshot | 해당 주기 plan_grant lot 미사용 시 전액 환불 + 구독 즉시 종료. **직전 72h 내 업그레이드가 있었다면 이전 플랜 lot 소모분을 합산해 미사용 판정** (레드팀: 업그레이드 직후 신규 lot만 미사용인 척하는 구멍 차단) |
| **임의 환불 (7일 이후)** | 잔여 크레딧 × krwPerCreditSnapshot 부분 환불하되 **보너스 크레딧 전액 회수 후** 계산. 보너스 회수로 잔액 부족 시 환불 불가(사용자 안내) | 환불 불가 — 다음 주기 해지(cancelAtPeriodEnd)로 안내 |

- 가입 보너스·admin_grant·promo lot: 환불 대상 아님. **환불 계산은 lot.source를 검사해 purchase(및 plan_grant) 외의 lot을 명시적으로 배제**한다 (admin_grant를 유료로 오인한 현금 유출 차단 — 레드팀 M1-보안).

**실행 경로는 admin 전용** (`/api/admin/credits/refunds` — 11.5). 사용자는 support 티켓으로 요청:
```
executeRefund(orderId, { reason, adminActor }):   // 금액은 서버가 정책으로 계산, admin은 승인만
  1. 주문·lot 검증 (위 정책 계산)
  2. POST https://api.portone.io/payments/{paymentId}/cancel
       { storeId, reason, amount: amountKrw }        // 부분취소 지원. Idempotency-Key 헤더 = `refund:{orderId}:{n차}`
  3. 응답 cancellation.status:
     - SUCCEEDED → 트랜잭션:
         applyLedgerEntry(refund_deduct, -(회수 크레딧), key=`refund:{orderId}:{cancellationId}`,
                          lotSelection={ targetLotIds: 해당 주문의 lot })   // ★ 소진 순서 배분 금지 (레드팀 M1)
         lot UPDATE remaining 차감·status=revoked(전액 회수 시)
         order UPDATE status=refunded|partial_refunded, refundedAmountKrw
     - REQUESTED(비동기) → 대기 표시 (분개 없음 — cancellationId 확정 전), Transaction.Cancelled 웹훅에서 위 트랜잭션 실행
     - FAILED → audit_log + 오류 반환
  4. audit_log(action="refund.executed", before/after, reason 필수)
```

**콘솔 발 취소(Transaction.Cancelled 웹훅) 처리 규약 (레드팀 M3)**: 포트원 콘솔에서 직접 취소하면 위 정책 검사를 우회한 채 돈이 먼저 나간다. 이때 대상 lot의 remaining < 회수 필요량이면: **회수 가능분만 회수**하고 부족분을 audit_log(action="refund.shortfall")로 기록 + **지갑 자동 frozen** + 대시보드 이상 신호. 운영 수칙: **포트원 콘솔에서 직접 취소 금지, 반드시 11.5 경유** (12.7에 등재).

- 가상계좌 결제 환불은 `refundAccount` 파라미터가 필요 — **초기 버전은 카드 결제만 지원**하고 가상계좌는 payMethod에서 제외한다 (18.7).

### 7.5 포트원 클라이언트 모듈

`apps/web/src/lib/server/payments/portone.ts` — API secret 보유, `getPayment / payWithBillingKey / schedulePayment / cancelSchedules / cancelPayment / deleteBillingKey` 래핑. 여기 외에 `api.portone.io`를 직접 호출하는 코드를 만들지 않는다. 모든 호출에 `Idempotency-Key` 헤더(멱등 규약 키 재사용)와 타임아웃(10s)·1회 재시도(GET만)를 건다.

---

## 8. 플랜 체계 (plus / pro / flex)

### 8.1 상품 정의

플랜의 실체는 "월간 크레딧 자동 충전 + 단가 할인"이다 (요구 6). 초기값(4.9 시드) 근거: 충전 상품 보너스율(최대 8%)보다 플랜 보너스율(11~25%)을 높게 → 구독 유인. flex는 헤비유저·대행사용.

**플랜 크레딧 만료: 지급 후 2주기(60일)** — 초안의 "주기 종료 시 전액 소멸"은 레드팀에서 기각됐다(M1-제품): 주 고객(소상공인·스타트업 대표)의 사용 패턴은 지원사업 공고 **시즌성**이라 간헐적이고, "안 쓴 달은 통째로 날림"은 해지의 1차 사유가 된다. 60일 만료는 사실상 1주기 이월을 허용하면서도:
- **차익 방어**: 최대 적립량이 2개월 지급분으로 상한된다 — "장기 적립 후 해지" 차익이 구조적으로 불가능(초안이 이월을 기각한 사유는 cap으로 해소).
- **부채 관리**: lot별 `expiresAt`으로 이미 구현 가능(스키마 변경 없음).
- **flex 우대**: flex 플랜 lot은 3주기(90일) — "flex"라는 이름이 암시하는 유연함에 실체를 부여한다(레드팀 M5-제품: 이름과 실체의 배신감 완화. 네이밍 자체 재검토는 18.11).

만료 정책은 /pricing과 약관에 명시하고, 결제 직전 **명시적 동의 체크박스**(단순 약관 링크가 아니라 "지급 크레딧은 60일 후 소멸됩니다" 문구 체크)를 받는다.

### 8.2 구독 시작

```
[클라] /pricing에서 플랜 선택 → 빌링키 발급
  PortOne.requestIssueBillingKey({ storeId, channelKey(빌링용), billingKeyMethod: "CARD" })
  → POST /api/web/plans/subscribe { planCode, billingKey }
[서버] 1. 기존 active/past_due 구독 있으면 409 (변경은 8.5 경로)
       2. credit_plan_subscriptions INSERT — ★ status=incomplete (레드팀 M6: active로 선생성하면
          결제 실패 시 유령 active 구독이 남아 partial unique index가 재시도를 영구 차단한다.
          기존 incomplete 행이 있으면 재사용/upsert)
       3. 첫 결제: 주문 생성(orderType=plan_initial) →
          POST /payments/{paymentId}/billing-key { billingKey, orderName, amount:{total}, currency:"KRW", customer:{id:userId} }
       4. 응답 PAID 확인(사후검증 동일) → 트랜잭션:
          status=incomplete → active 전이 (period = now ~ now+1개월 확정)
          applyLedgerEntry(plan_grant, +monthlyCredits, key=`plan:{orderId}`)   // 4.3 — 주문과 1:1
          — lot 만료 = 지급 + 2주기 (4.2.1)
          결제 실패 시: incomplete 유지 + 실패 사유 반환. 지급·예약 없음
       5. 다음 주기 예약: 예약용 주문 행을 먼저 생성(orderType=plan_renewal, status=created,
          paymentId=nextPaymentId) → POST /payments/{nextPaymentId}/schedule { timeToPay: periodEnd, payment: {...} }
          → nextScheduleId/nextSchedulePaymentId 저장
          ★ 예약 등록 = 주문 선생성 (레드팀 B2: 웹훅 매칭을 구독의 단일 컬럼이 아니라 주문
          테이블(paymentId unique)로 하기 위함 — 고아 예약이 실행돼도 주문에서 식별·경보된다)
       6. audit_log(action="subscription.started")
```

### 8.3 갱신 (예약결제 실행)

포트원 예약은 1회성 — **자동 반복 없음**. 갱신 루프:
```
periodEnd 도래 → 포트원이 예약 실행 → Transaction.Paid 웹훅
  → paymentId로 주문(plan_renewal, 8.2 step 5에서 선생성) 조회 → 구독 식별 → 트랜잭션:
     - verifyAndGrant 계열 사후검증 (주문 상태 가드 포함)
     - period 갱신 (start=이전 end, end=+1개월)
     - cancelAtPeriodEnd? → 지급·예약 없이 status=canceled (막차 결제가 실행됐다면 환불 정책 적용 검토 — 예약 취소가 정상 경로이므로 이 분기는 방어용)
     - pendingPlanId 있으면 플랜 교체 후 지급
     - plan_grant 지급 (key=`plan:{orderId}`, lot 만료 = 지급+2주기)
     - 다음 회차 예약 재등록 (주문 선생성 포함)
  ※ 주문 테이블에 없는 paymentId의 Paid 웹훅 = "우리가 모르는 결제" → 즉시 경보 (레드팀 B2)
```
**안전망 cron** (`/api/cron/credits-plan-renewals`, 매 시) — 분기를 명확히 한다 (레드팀 M7: "결제는 성공했는데 웹훅만 유실"이 최빈 장애):
1. `currentPeriodEnd < now() - 2h`인 status=active 구독 → `GET /payment-schedules`로 예약 상태 능동 조회:
   - `SUCCEEDED` → **즉시결제를 쏘지 않는다.** 해당 paymentId로 갱신 트랜잭션(위 루프와 동일, 멱등)을 직접 실행 — 웹훅 유실 구제.
   - `FAILED` → 8.4 실패 처리.
   - 미실행(STARTED/SCHEDULED 아님·조회 불가) → 즉시결제 1회 시도 또는 실패 처리.
2. `processingStatus=failed`인 최근 48h 웹훅 inbox 재처리 (7.3).

### 8.4 갱신 실패

`Transaction.Failed` 웹훅(예약 건) → status=past_due, retryCount++:
- 재시도: **한 번에 예약 1개만 등록** — D+1 예약을 등록하고, 그것이 실패하면 그때 D+3을 등록한다. 복수 동시 등록은 D+1 성공 후 D+3이 또 발화하는 이중 청구를 만든다 (레드팀 B2 계열). 재시도 예약도 8.2 step 5의 주문 선생성 규약을 따른다.
- 재시도 소진 → status=expired, 사용자 알림. **past_due 동안**: 기존 크레딧 사용은 허용(이미 지급분), 신규 plan_grant 없음. past_due 진입·이탈 시에도 3.1의 불변 규칙(미소진 예약 전부 취소 후 재등록)을 따른다.

### 8.5 플랜 변경

**불변 규칙 (레드팀 B2 — BLOCKER 수정)**: 아래 모든 전이의 **첫 단계는 이 구독의 미소진 포트원 예약 전부 취소**(`DELETE /payment-schedules` — billingKey 기준 조회 후 scheduleIds 지정)다. 초안은 해지에만 예약 취소가 있어, 업그레이드 후 구(舊) 예약이 살아남아 **이중 청구 + 주문 없는 무기록 결제**가 발생했다. 취소 성공을 확인한 뒤 다음 단계로 진행하고, 선생성해 둔 예약 주문(created)은 expired 처리한다.

- **업그레이드**: [예약 전부 취소] → 새 플랜 즉시결제(전액, 새 주문) + 즉시 plan_grant(key=`plan:{신규 orderId}`, period 리셋) + 새 예약 등록. 기존 주기 잔여 크레딧은 원래 만료일 유지(사용자 손해 없음, 일할 계산 없음 — 단순성 우선. /pricing에 명시). 업그레이드 직후 환불 요청은 7.4의 72h 합산 판정.
- **다운그레이드**: `pendingPlanId`에 저장, 다음 갱신부터 적용 (예약은 유지 — 금액이 바뀌므로 [기존 예약 취소 → 새 금액으로 재예약]).
- **해지**: [예약 전부 취소] + `cancelAtPeriodEnd=true`. 주기 종료 시 canceled. 즉시 해지·환불은 7.4 정책.
- **빌링키 교체**: 새 키 발급 → 구독 UPDATE → [구 키의 예약 취소 → 새 키로 재예약] → 이전 키 `DELETE /billing-keys/{key}` → audit_log. (이때 발생하는 구 키의 BillingKey.Deleted 웹훅은 7.3의 "현재 키 일치" 조건으로 무해)

### 8.6 기존 billing_subscriptions와의 관계

기존 테이블은 company 스코프 "서비스 이용권(early_access 등)" 상태 라벨로 계속 쓴다. 크레딧 플랜 구독과 독립이며 서로 참조하지 않는다. `/billing` 페이지에는 "크레딧 플랜" 섹션을 추가해 `credit_plan_subscriptions`를 보여주고 관리 UI(10.4)로 링크한다. 장기 통합은 18.1.

---

## 9. API 설계

공통: `runtime="nodejs"`, `dynamic="force-dynamic"`, 응답은 `ActionResult<T>`, 오류는 `webActionError` + 6.4 코드. 모든 신규 DTO는 `packages/contracts/src/dto.ts`에 타입 추가, `packages/contracts/src/openapi.ts`에 경로 등재.

### 9.1 웹 API (`apps/web/src/app/api/web/…`)

| 메서드·경로 | 인증 | 요청 | 응답 데이터 |
|---|---|---|---|
| GET `/api/web/credits/balance` | 세션 | – | `{ balance, pendingHolds, available, lowBalance, expiringSoon: [{lotId, remaining, expiresAt}] }` — UI가 표시하는 잔액은 **available**(hold·버퍼 반영)로 통일해 "잔액은 있는데 402" 착시를 없앤다 |
| GET `/api/web/credits/estimate?feature&inputHint` | 세션 | – | `{ estimatedCredits, available, sufficient }` — **작업 시작 버튼 옆 사전 견적용** (레드팀 M2-제품: 402를 사후에 만나기 전에 안다). 요율 원시값이 아니라 계산 결과만 반환 (4.13 노출 규약) |
| GET `/api/web/credits/ledger?cursor&limit&type` | 세션 | – | 분개 목록 (커서 페이지네이션, 최신순). 항목: `{ id, entryType, amount, balanceAfter, createdAt, description }` (description은 서버에서 한국어 조립) |
| GET `/api/web/credits/usage?from&to&feature&cursor` | 세션 | – | usage_events 목록 + 기간 합계 `{ totalCredits, byFeature: [{featureCode, credits, count}] }` |
| GET `/api/web/credits/usage/export?from&to` | 세션 | – | CSV (text/csv) |
| GET `/api/web/credits/products` | 공개 | – | 활성 충전 상품 목록 |
| POST `/api/web/credits/checkout` | 세션 | `{ productCode }` | `{ paymentId, storeId, channelKey, orderName, totalAmount }` |
| POST `/api/web/credits/checkout/complete` | 세션 | `{ paymentId }` | `{ status, grantedCredits, balance }` |
| GET `/api/web/credits/orders?cursor` | 세션 | – | 내 주문·결제 내역 (영수증 URL 포함 가능 시) |
| GET `/api/web/plans` | 공개 | – | 활성 플랜 목록 + 내 구독 상태(세션 있으면) |
| POST `/api/web/plans/subscribe` | 세션 | `{ planCode, billingKey }` | `{ subscription, grantedCredits }` |
| POST `/api/web/plans/change` | 세션 | `{ planCode }` | 업/다운 분기 결과 |
| POST `/api/web/plans/cancel` | 세션 | `{ }` | `{ cancelAtPeriodEnd: true, periodEnd }` |
| POST `/api/web/plans/billing-key` | 세션 | `{ billingKey }` | 교체 결과 |
| POST `/api/webhooks/portone` | 서명 | raw | `{ ok: true }` (7.3) |

레이트리밋: checkout·subscribe 계열은 user당 10req/min + 동시 미결제 주문 5개 상한(7.2). 전역 인프라가 없는 현 상태에선 인메모리 + 지갑 row lock이 실질 방어 — 18.8.

### 9.2 크론 (`apps/web/src/app/api/cron/…`, Vercel Cron + CRON_SECRET 헤더 검증 — 기존 크론 라우트 컨벤션 확인 후 동일하게)

| 경로 | 주기 | 역할 |
|---|---|---|
| `/api/cron/credits-expire-holds` | 5분 | 5.3 hold TTL |
| `/api/cron/credits-expire-orders` | 10분 | 7.2 주문 만료·지연 구제 |
| `/api/cron/credits-expire-lots` | 일 1회 04:00 KST | 5.4 만료 소멸 |
| `/api/cron/credits-plan-renewals` | 1시간 | 8.3 갱신 안전망 + failed 웹훅 inbox 재처리(7.3) |
| `/api/cron/credits-reconcile` | 일 1회 05:00 KST | 14장 대사 |

### 9.3 admin API (`apps/admin/src/app/api/admin/credits/…`)

공통: `requireAdminSession()` + 12.3의 role 매트릭스. 응답 `adminData/adminError`. DB는 `getAdminSql()` raw SQL. **잔액 변이는 admin에서 직접 SQL로 하지 않고**, 웹앱과 동일한 분개 규칙을 raw SQL 트랜잭션으로 재현하되 5.2의 절차(row lock → 멱등 → lot → ledger → wallet)를 그대로 따른다. (admin은 core 패키지를 의존성으로 갖고 있으므로 `@cunote/core`의 순수 계산 함수는 재사용 가능.)

| 메서드·경로 | 최소 role | 역할 |
|---|---|---|
| GET `/api/admin/credits/overview` | viewer | 대시보드 지표 (11.1) |
| GET `/api/admin/credits/members?q&cursor` | viewer | 회원 검색 (email/이름) + 지갑 요약 |
| GET `/api/admin/credits/members/[userId]` | viewer | 지갑 상세: lots, 최근 분개, holds, 주문, 구독. **호출 자체를 audit_log(action="member.viewed")에 기록** (레드팀 M3-보안: 개인정보취급자의 열람 추적 — ISMS 접속기록 요건) |
| POST `/api/admin/credits/members/[userId]/adjust` | admin | `{ direction: grant\|deduct, credits, reason(필수), expiryDays?, nonce(필수 — 멱등 키 `admin:{nonce}`) }` → admin_grant/admin_deduct 분개. **자기 계정(및 연결 계정) 지급 하드 차단** + `admin_grant_review_threshold` 초과 지급은 owner 승인 대기(pending) 상태로만 생성 (11.4, 레드팀 M1-보안) |
| POST `/api/admin/credits/members/[userId]/goodwill` | support | CS 보상 지급 — `{ credits, reason, ticketRef, nonce }`. `credit_settings.support_grant_ticket_cap`(건당)·`support_grant_daily_cap`(1인 1일) 이내만. source=promo 분개 (레드팀 M3-제품: support가 소액 보정을 못 해 전건 에스컬레이션되는 문제) |
| POST `/api/admin/credits/members/[userId]/freeze` | admin | `{ frozen: boolean, reason }` + 활성 구독 예약 취소 여부(기본 취소 — 4.1) |
| GET `/api/admin/credits/pricing-rules` | viewer | 요율 목록 (버전 이력 포함) |
| POST `/api/admin/credits/pricing-rules` | owner | 새 요율 버전 발행 (이전 버전 자동 마감) |
| GET/PUT `/api/admin/credits/settings` | viewer / owner | 4.7 설정 |
| GET/POST/PATCH `/api/admin/credits/products` | viewer / admin | 충전 상품 관리 |
| GET/POST/PATCH `/api/admin/credits/plans` | viewer / owner | 플랜 관리 |
| GET `/api/admin/credits/orders?status&q&cursor` | viewer | 주문·결제 목록 |
| POST `/api/admin/credits/orders/[orderId]/sync` | support | 포트원 능동 조회로 상태 동기화 |
| POST `/api/admin/credits/refunds` | admin | 7.4 환불 실행 (`{ orderId, reason }` — 금액은 서버 계산) |
| GET `/api/admin/credits/subscriptions?status&cursor` | viewer | 구독 목록·상세 |
| POST `/api/admin/credits/subscriptions/[id]/cancel` | admin | 강제 해지 |
| GET `/api/admin/credits/audit-logs?actor&action&target&from&to&cursor` | viewer | 12장 감사 로그 조회 |
| GET `/api/admin/credits/reconciliation?date` | viewer | 대사 결과 |
| GET `/api/admin/credits/usage-stats?from&to&groupBy` | viewer | 기능·모델별 사용 통계 + 원가 대비 마진 |

모든 변이 API는 성공 시 `credit_audit_logs`에 기록한다 (12.2). reason 없는 변이 요청은 400.

**admin 결제 실행 경로 (구현 중 확정 — 7.5 단일화 규범과 9.3 실행 요구의 교차 해소)**: 포트원 호출이 필요한 admin 실행 계열(주문 동기화·환불 실행·강제 해지)과 freeze의 예약 취소 연동은 **admin에서 포트원·원장 로직을 재구현하지 않는다**. verifyAndGrant(7.2)·환불 실행(7.4)·구독 전이(8.5)는 웹앱에 단일 구현으로 존재하고 통합 테스트가 이를 검증하므로, admin 측 중복 구현은 정합성 사고의 근원이 된다. 대신:

- 웹앱에 **시스템 내부 엔드포인트**(`/api/internal/credits/*`)를 두고 서버 간 시크릿 헤더(CRON_SECRET과 동일 체계)로 검증한다. 외부 노출 없음(라우트 정책상 시스템 전용).
- admin 라우트의 책임은 (1) requireAdminRole·reason 검증 (2) `credit_audit_logs` 기록 (3) 내부 엔드포인트 호출·결과 반환까지만.
- admin→웹 기저 URL은 `WEB_INTERNAL_BASE_URL` env (로컬은 dev 서버 주소, 운영은 웹 프로덕션 도메인).
- 7.5의 "portone.ts 밖 `api.portone.io` 직접 호출 금지" 규범은 그대로 유지된다. adjust/goodwill처럼 포트원이 개입하지 않는 단순 지급·차감은 기존대로 admin raw SQL(5.2 재현)로 남는다.

---

## 10. 웹 UI 페이지 명세 (apps/web)

feature 디렉토리 컨벤션(`apps/web/src/features/…`)을 따른다. 신규 feature: `credits`, `pricing`. 스타일은 기존 웹앱 토큰 체계 준수.

### 10.1 `/pricing` — 플랜·가격 페이지 (공개)

- 3플랜 카드 (월 가격, 월 크레딧, 보너스율, 기능 불릿). 현재 구독 중이면 해당 카드에 "이용 중" 배지 + 변경 버튼.
- 하단: 충전 상품 비교 표 + "크레딧이란?" 설명 (1크레딧=1원 가치, 기능별 예상 소모량 표 — `GET /api/web/plans`가 요율 기반 예시 소모량을 내려줌).
- 플랜 크레딧 소멸 정책·환불 정책 요약 및 약관 링크 (12.6).
- 비로그인 CTA → 로그인 후 복귀.

### 10.2 `/credits` — 충전 페이지 (세션)

- 현재 잔액 + 만료 예정 경고.
- 충전 상품 그리드 (보너스 강조) → 선택 → `checkout` API → `PortOne.requestPayment` → 완료 후 `/credits/complete?paymentId=…`.
- `/credits/complete`: `checkout/complete` 호출 → 성공(지급 크레딧·잔액 표시) / 실패(사유 + 재시도) / 대기(웹훅 지연 — "잠시 후 반영됩니다" + 폴링 3회).
- 최근 주문 5건 목록 (전체는 /account/usage의 결제 탭).

### 10.3 `/account/usage` — 사용량·크레딧 상세 (세션, 요구 5·7)

- 상단 요약: 잔액 / 이번 달 사용 / 진행 중 hold / 만료 예정 (lot별 만료일).
- 탭 1 **사용 내역**: usage_events 테이블. **기본 표시는 "기능명(한국어) · 차감 크레딧 · 원화 환산"** — 예: "지원서 초안 생성 · 504 크레딧 (약 504원 상당)". 토큰 in/out·모델명은 "상세" 토글에 숨긴다 (레드팀 M4-제품: 주 고객은 "토큰"을 모른다 — 토큰 숫자를 기본 노출하면 불신만 키운다. 감사용 원본은 DB에 그대로). 관련 문서 링크(contextRef), 필터: 기간·기능, CSV 내보내기.
- 탭 2 **크레딧 원장**: ledger 목록 (지급/차감/만료/환불 구분 배지, 금액, 잔액). "이 차감은 어디서?" → usage 상세로 링크.
- 탭 3 **결제 내역**: 주문 목록 (금액, 상태, 결제수단, 영수증 링크), 구독 갱신 이력.
- 기간별 막대 차트 (일 단위 크레딧 소모 — 기존 차트 라이브러리 유무 확인, 없으면 CSS 막대로 충분).

### 10.4 `/account` · `/billing` 확장

- `/account` 허브에 "크레딧·사용량" 카드 (잔액 + /account/usage 링크).
- `/billing`에 "크레딧 플랜" 섹션: 현재 플랜, 다음 결제일·금액, 카드(brand/last4), 플랜 변경(/pricing)·해지 버튼, 빌링키 교체 버튼 (requestIssueBillingKey 재호출).
- 해지 확인 모달: 주기 종료일까지 유지됨 + 플랜 크레딧 소멸 시점 명시.

### 10.5 전역 컴포넌트

- **잔액 위젯**: 인증 레이아웃 헤더에 현재 잔액 (SWR, `GET /credits/balance`). 표시값은 `available`(9.1). `lowBalance`면 주황 배지.
- **사전 견적 표시 (필수 규약 — 레드팀 M2-제품)**: 크레딧을 소모하는 모든 작업의 시작 버튼 옆에 `GET /credits/estimate` 결과를 렌더한다 — "예상 약 500 크레딧 · 잔액 496 (부족)". 사용자가 402를 만나기 전에 부족을 안다. 신규 LLM 기능 구현 시 withCreditMetering과 함께 이 UI가 의무다.
- **크레딧 부족 모달**: LLM 기능 호출이 402 `insufficient_credits`를 반환하면 전역 모달 — 부족량, 현재 잔액, 추천 충전 상품(부족량 이상 최소 상품), `/credits` 이동 버튼. `error.meta.shortfall` 사용. hold 버퍼(×1.2) 때문에 표시 잔액보다 필요액이 커 보일 수 있음을 "안전 여유분 포함" 문구로 설명.
- **차감 영수증 토스트**: LLM 작업 완료 응답의 `creditsCharged`를 "○○○ 크레딧 사용됨"으로 표시 (투명성 — 신뢰의 핵심 장치).

---

## 11. Ops(admin) 페이지 명세 (apps/admin)

`ops-*` CSS 체계, `requireAdminSession()`, role 매트릭스는 12.3. 네비게이션: 홈에 "크레딧" 섹션 링크 그룹 추가.

### 11.1 `/credits` — 대시보드 (viewer+)

- 오늘/이번 달: 충전액(KRW), 신규 발행 크레딧, 소진 크레딧, 활성 구독 수, 환불액.
- 부채 지표: **미사용 크레딧 총량**(= Σ active lot remaining — 회계상 선수금), 30일 내 만료 예정량.
- 마진 지표 — **명목/실효 분리** (레드팀 m2-제품): 명목 마진 = usage 차감 크레딧(≒KRW) vs `provider_cost_usd_micros` × 환율. **실효 마진**은 원가 측에 `status IN (free, failed)` 이벤트의 원가(무료 보너스 소모분·실패 호출·팝빌)와 shortfall 미수액을 포함해 계산. 명목만 보면 마진이 과대 표시된다.
- 이상 신호: shortfall 발생 건수, capture_after_expiry 건수, pending usage(정산 미확정), 대사 mismatch, past_due 구독 수, **admin_grant 발행 총량 급증**(내부자 통제 — 레드팀 M1-보안), 기간 내 환불 N회 이상 사용자, 동일 companyId 신규 멤버 급증(13.1).

### 11.2 `/credits/settings` — 전역 설정 (조회 viewer / 변경 owner)

4.7 키 목록을 폼으로. 변경 시 reason 입력 필수 → PUT → audit_log. `krw_per_credit`에는 "변경 시 신규 판매분에만 적용됨" 경고 문구.

### 11.3 `/credits/pricing` — 요율 관리 (조회 viewer / 발행 owner)

- 현행 요율 표 (ruleType별 그룹) + 버전 이력 (effective 구간, 발행자, note).
- 새 버전 발행 폼 + **요율 계산기**: USD 단가·환율·마진 입력 → 5.5 공식으로 밀리크레딧 자동 계산 → 대표 시나리오(지원서 초안 1회 등) 예상 차감 미리보기.
- **인상 시 하드 제약 (레드팀 M4-제품)**: 신규 요율이 현행보다 높으면 `effectiveFrom >= now + 7일`을 폼·API 양쪽에서 **차단 수준으로 강제**한다(경고가 아님 — 운영 원칙만으로는 실수 한 번에 소급 인상이 가능). 인하는 즉시 적용 가능. 발행 시 활성 구독·최근 30일 사용자를 대상으로 한 변경 고지 트리거(이메일/공지)를 함께 실행한다 — 고지 의무는 12.6에 등재.
- 직전 버전 대비 10배 이상 변화 시 2차 확인(액션명 타이핑).
- `PricingRuleMissingError` 발생 로그 (요율 없는 모델 호출 시도) 표시.

### 11.4 `/credits/members` — 회원 크레딧 관리 (요구 8)

- 검색(이메일/이름) → 목록 (잔액, 구독, 최근 활동, frozen 여부).
- 상세: 지갑 요약 / lot 목록 / 최근 분개 50건 / 진행 중 hold / 주문·구독 이력 / 이 회원의 감사 로그. 상세 열람은 `member.viewed`로 기록됨(9.3).
- 수동 지급/차감 폼: 방향, 크레딧량, 만료일(지급 시), **reason 필수**, 폼 렌더 시 nonce 생성(멱등 — 더블클릭 이중 지급 차단), 실행 확인 모달("이 작업은 감사 로그에 기록됩니다"). role=admin 이상.
- **내부자 통제 (레드팀 M1-보안)**: (1) 실행 admin 본인과 연결된 사용자 계정으로의 지급은 하드 차단. (2) `admin_grant_review_threshold`(settings, 초기 50,000크레딧) 초과 지급은 즉시 분개가 아니라 **owner 승인 대기(pending) 큐**에 적재 — 2인 결재 후 분개. 감사 로그만으로는 사후 탐지일 뿐 사전 통제가 아니라는 지적 반영.
- **CS 보상 지급 (support 가능)**: 티켓 참조 필수, 건당·일일 한도 내 (9.3 goodwill API). 한도 초과 필요 시 admin 에스컬레이션.
- 지갑 동결/해제 (조사용, 예약 취소 기본 연동). role=admin 이상.

### 11.5 `/credits/payments` — 결제·환불 (viewer+, 실행은 admin)

- 주문 목록 (상태 필터, paymentId 검색). 상태 불일치 의심 건 "포트원 동기화" 버튼 (support+).
- 환불 실행: 주문 선택 → 서버가 7.4 정책(청약철회/임의 환불 자동 분기)으로 환불 가능액·회수 크레딧 계산해 표시 → reason 입력 → 실행 (admin+). 결과와 포트원 cancellation 응답 표시.
- **장애/품질 보상 탭 (레드팀 M3-제품)**: usage_event를 지목해 보상 실행 — errorCode가 있는 이벤트(LLM 오류)는 원클릭 reversal, 품질 불만(정산은 정상)은 goodwill 지급으로 연결. "미완 생성물도 과금"(13.3) 정책의 CS 출구다. 처리 SLA 목표: 장애 보상 1영업일, 미사용 환불 3영업일 — 티켓 템플릿에 명시.
- 웹훅 inbox 뷰어: 최근 이벤트, processingStatus=failed 재처리 버튼 (자동 재처리는 cron이 48h까지 수행 — 7.3).

### 11.6 `/credits/subscriptions` — 구독 관리 (viewer+)

목록 (status 필터) / 상세 (주기, 예약 상태, 결제 이력, 재시도 카운트) / 강제 해지 (admin+, reason 필수).

### 11.7 `/credits/audit` — 감사 로그 조회 (요구 9, viewer+)

- 필터: 기간, actorType/actorId, action(사전 드롭다운), targetType/targetId, requestId.
- 행 확장 시 before/after JSON diff 뷰.
- CSV 내보내기 (감사 대응). **이 화면 접근 자체도 audit_log에 기록** (action="audit.viewed" — 감사 로그 열람 추적, ISMS 요구).

### 11.8 `/credits/reconciliation` — 대사 리포트 (viewer+)

일자별 run 목록 + scope별 상태. mismatch면 summary의 상세(지갑 id, 차액) 표시. 14.3의 수동 재실행 버튼 (admin+).

---

## 12. 보안 · ISMS 대응

### 12.1 원칙

- **최소 보유**: 카드번호·CVC 등 카드정보는 일절 저장하지 않는다. 포트원 빌링키(토큰)와 표시용 `{brand, last4}`만 보유.
- **최소 권한**: 잔액 변이는 서버 코드의 단일 진입점(5.2)만. admin은 role 매트릭스(12.3). RLS는 4.13.
- **부인 방지**: 모든 상태 변이는 append-only 원장 + 감사 로그. 정정도 reversal 분개로만.
- **추적성**: requestId를 웹 요청 → usage_event → ledger → audit_log에 관통시킨다.

### 12.2 감사 로그 액션 사전 (필수 기록 목록)

| action | 발생 지점 |
|---|---|
| `payment.checkout_created` / `payment.paid` / `payment.mismatch` / `payment.failed` | 7.2/7.3 (checkout_created는 결제 사기 조사용 — 반복 실패 패턴 추적) |
| `refund.executed` / `refund.failed` / `refund.shortfall` | 7.4 |
| `member.viewed` | 9.3 — admin이 특정 회원의 지갑·결제·구독 상세를 열람 (개인정보취급자 접속기록, ISMS 요건) |
| `wallet.frozen` / `wallet.unfrozen` | 11.4 |
| `ledger.admin_grant` / `ledger.admin_deduct` | 11.4 (분개 id를 after에) |
| `pricing_rule.published` | 11.3 |
| `setting.updated` | 11.2 |
| `product.created/updated` / `plan.created/updated` | 11.5 관리 |
| `subscription.started/renewed/past_due/canceled/expired/forced_cancel` | 8장 전체 |
| `billing_key.replaced/deleted` | 8.5 |
| `usage.shortfall` / `usage.capture_after_expiry` | 5.3 |
| `ledger.grant_pending` / `ledger.grant_approved` / `ledger.grant_rejected` | 11.4 owner 승인 큐 (2인 결재) |
| `audit.viewed` / `audit.exported` | 11.7 |
| `recon.mismatch` | 14장 |

시스템 발생 건은 `actorType=system, actorId="system:webhook"` 등으로 기록. **사용자 행위(충전·사용·환불 — 요구 9)는 ledger+usage_events 자체가 1차 기록**이고, audit_log는 결제·관리·이상 이벤트를 담는다. **단, 개인정보취급자(admin)의 조회·출력 행위는 이 원칙의 예외로 반드시 별도 audit 기록한다** (`member.viewed`, `audit.viewed/exported` — 레드팀 M3-보안). 조회 시 두 소스를 통합해 보여준다(11.7은 audit, 11.4 상세는 ledger).

### 12.3 admin role 매트릭스

| 작업 | viewer | support | admin | owner |
|---|---|---|---|---|
| 대시보드·목록·감사 로그 조회 | ✅ | ✅ | ✅ | ✅ |
| 주문 포트원 동기화 | – | ✅ | ✅ | ✅ |
| CS 보상 지급 (건당·일일 한도 내, 티켓 참조 필수) | – | ✅ | ✅ | ✅ |
| 수동 지급/차감(임계 이하), 동결, 환불 실행, 강제 해지 | – | – | ✅ | ✅ |
| 임계 초과 지급 승인(2인 결재), 요율 발행, 설정 변경, 플랜 관리 | – | – | – | ✅ |

`requireAdminSession()` 반환의 `session.user.role`로 분기하는 `requireAdminRole(session, "admin")` 헬퍼를 admin에 추가한다. 현재 admin 라우트들이 role 분기 없이 동작하므로 이 헬퍼가 크레딧 라우트의 신규 표준이 된다.

### 12.4 개인정보·데이터 취급

- `usage_events.context_ref`·`credit_ledger.reason`·`audit_logs`에 **PII(사업자번호 원문, 연락처, 문서 본문)를 넣지 않는다**. 식별 필요 시 내부 uuid 참조 또는 해시.
- 팝빌 조회 미터링은 bizNo를 pepper 기반 HMAC-SHA256 가명 키로만 기록 (6.5 — 무염 해시는 10자리 전수 계산으로 역산됨).
- 전송 구간: 전 구간 HTTPS(기존). `PORTONE_API_SECRET`·`PORTONE_WEBHOOK_SECRET`은 서버 환경변수 전용, 로그 출력 금지.
- 웹훅 payload는 **원문을 저장하지 않는다** — 화이트리스트 발췌만 저장 (4.10 규약. 초안의 "1년 보존 후 수동 마스킹"은 개인정보 최소 보유 원칙 위배로 기각 — 레드팀 M5-보안).

### 12.5 보존·파기

| 데이터 | 보존 | 근거 |
|---|---|---|
| 결제·주문·원장·환불 기록 | **5년** | 전자상거래법 시행령 (계약·대금결제 기록 5년) |
| usage_events | 5년 (분쟁 대비, 원장과 연결) | 동상 |
| 감사 로그 | 최소 1년, 권장 3년. **`actorEmail` 등 로그 내 개인정보는 "감사 목적 법정 보존"을 처리 근거로 보존기간 동안 유지** — append-only 특성상 사후 마스킹이 불가하므로 이 근거를 개인정보 처리방침에 명시(레드팀 m2-보안) | ISMS-P 인증 기준 (접속기록 1년 이상) |
| 회원 탈퇴 시 | users 행은 개인정보 파기하되 **지갑·원장·주문은 법정 보존기간 유지** — `credit_wallets.user_id`는 restrict FK이므로 users 행을 삭제 대신 가명화(이메일 등 개인정보 컬럼 무작위화)하는 기존/신규 탈퇴 절차에 통합. 잔여 크레딧은 탈퇴 시 소멸 동의(약관) 후 expiry 분개로 정리 | 개인정보보호법 + 전상법 병행 |

### 12.6 규제 검토 (구현 전 사업 측 확인 필요 — 오픈 퀘스천 아님, 정책 전제)

- **선불전자지급수단 해당 여부**: 크레딧이 (1) 자사 단일 서비스 전용이고 (2) 타인 간 대가 지급 수단이 아니며 (3) 현금 환급을 "미사용 결제취소" 형태로만 제공하면 전자금융거래법상 선불전자지급수단 등록 대상이 아닐 가능성이 높다. **약관에 "cunote 서비스 내 이용권"으로 명시**하고, 크레딧 양도·선물 기능을 만들지 않는다(1.2 비목표). 법률 검토 1회 권장.
- **환불 약관**: 7.4의 이원 정책(청약철회 7일 이내 / 임의 환불 7일 이후)을 이용약관·결제 페이지에 구분 고지. 철회권(7일 내 미사용 원금 환불)은 보너스 회수 규칙보다 우선한다 — 7.4의 표가 규범.
- **미성년자 결제 (레드팀 M6-보안)**: 민법상 미성년자 계약은 법정대리인 동의 없이 취소 가능 — 빌링키 정기결제는 특히 반환 리스크가 크다. (1) 결제 페이지에 "만 19세 미만은 법정대리인 동의 필요" 고지, (2) 미성년자 결제 취소 절차를 약관에 명시, (3) 서비스가 사업자(성인 전제) 대상이라는 논리에 기대려면 그 근거를 약관에 명문화. 포트원/토스 본인인증(연령 확인) 옵션 도입 여부는 법률 검토와 함께 결정.
- **표시 의무**: /pricing·/credits에 공급자 정보, 크레딧 유효기간, 소멸 정책 표시. 플랜 결제 직전 소멸 정책 명시 동의 체크박스(8.1). **요율 인상 시 사전 고지**(7일 전, 11.3의 하드 제약과 세트)도 표시 의무에 포함.

### 12.7 기타 통제

- **웹훅 엔드포인트**: 서명 검증 실패 시 본문 처리 없이 401. 요청 크기 제한(1MB). 
- **admin 접근**: 기존 Google OAuth 도메인 제한(noten.im) 유지. 크레딧 메뉴는 추가 인증 없이 role로만 통제하되, owner 액션(요율·설정)은 confirm 모달에 재입력(액션명 타이핑) 요구.
- **비정상 탐지**: 대시보드(11.1) 이상 신호 + 14장 대사. 단일 사용자 1시간 내 차감 N만 크레딧 초과 시 audit_log(action="usage.anomaly") 기록 (임계값은 settings).
- **시크릿 회전 런북 (레드팀 m3-보안)**: `PORTONE_API_SECRET` 유출 시 폭발 반경 = 임의 결제 취소(자금 유출)·빌링키 결제 실행. (1) 분기 1회 정기 회전 + 유출 의심 시 즉시 회전, (2) 웹훅 시크릿은 구/신 병행 검증 창(24h)을 두어 무중단 전환, (3) 유출 대응: 회전 → 포트원 콘솔에서 최근 cancel/billing-key 결제 호출 전수 대조 → 이상 건 audit. `.env.example`에 회전 이력 주석 칸을 둔다.
- **운영 수칙**: 포트원 콘솔에서 결제를 직접 취소하지 않는다 — 반드시 11.5 환불 경로 경유 (7.4의 shortfall 사고 방지). DB 콘솔에서 크레딧 테이블 직접 UPDATE 금지(트리거가 막지만, 트리거를 끄는 행위 자체가 chainHash 검증(14.2)에 걸린다는 사실을 운영 문서에 명시).

---

## 13. 어뷰징 · 리스크 대응

### 13.1 가입 보너스 파밍 (다계정) — 레드팀 B1으로 전면 재설계

**레드팀이 코드 대조로 확정한 사실** (초안의 방어 논리를 뒤집음):
- `companies.bizNo`에는 **UNIQUE 제약**이 있다 → "동일 사업자번호에 연결된 계정 5개 초과" 탐지는 구조상 발생 불가능한 조건(데드코드)이다.
- 반면 **팀 초대 경로**(`teamInvitations` → `user_company` 다:1)로는 한 회사에 계정을 무한정 붙일 수 있다 — owner가 이메일 계정 N개를 만들어 자기 회사에 초대하면, 각 계정이 보너스 1,000cr을 받고 **전원 인증된 회사 소속으로 게이트를 통과**한다. 이것이 실제 파밍 벡터다.
- 사업자번호 3단 게이트는 **소유권 증명이 아니라 랜딩 조회 UX**다(아무 유효 bizNo나 통과 가능) — "인증 게이트가 파밍을 막는다"는 초안의 1차 방어 강도는 과대평가였다.

**재설계된 방어**:
1. **회사 스코프 보너스 소모 상한**: `withCreditMetering` 진입 시 "이 companyId 컨텍스트에서 signup_bonus lot으로 소모된 누적량"을 검사한다 (`usage_events.companyId` + ledger lotBreakdown으로 계산 가능, 지갑이 user 스코프여도 동작). 상한 초기값: 회사당 3,000cr (= 정상적인 초기 팀 3인분, `credit_settings.company_bonus_consumption_cap`). 초과분은 보너스 lot을 건너뛰고 유료 lot부터 소진하거나 402. 파밍의 실익(보너스로 LLM 사용)을 직접 봉쇄한다.
2. **초대 속도 이상 신호**: 동일 companyId의 `user_company` 신규 멤버가 7일 내 5인 초과 시 audit_log(action="usage.anomaly") + 대시보드 노출 (11.1). bizNo 기준이 아니라 **companyId·초대 수락 속도** 기준.
3. **lazy grant** (6.6): 이메일 인증 완료 시 지급 — 봇 대량 가입의 지갑·lot 양산 차단.
4. `signup:{userId}` 멱등 키로 계정당 1회 (유지).

**잔여 리스크 수용**: 위 상한을 우회하려면 회사(유효 사업자번호)를 계정 수만큼 확보해야 한다 — 위조 비용이 편익(계정당 1,000원 상당)을 초과하므로 수용. 미소모 보너스는 90일 만료로 자연 소멸.

### 13.2 환불 어뷰징

- 보너스·프로모 크레딧은 환불 대상 아님 + 부분 사용 환불 시 보너스 전액 회수(7.4) → "보너스만 쓰고 원금 환불" 차익 차단.
- 소진 순서(2.5)상 무료분이 먼저 소모되므로 "유료 미사용" 판정이 사용자에게 불리하지 않다.
- 환불 이력이 기간 내 N회 이상인 사용자 플래그 (11.1 이상 신호).

### 13.3 동시성·초과 사용

- 지갑 row lock + available(잔액−hold) 검사로 병렬 호출 초과 사용 차단 (5.3, 16.2에서 동시성 테스트 의무).
- 스트리밍 중단(클라이언트 이탈)에도 서버는 run() 완료까지 진행 후 정산 — 미완 생성물도 과금됨을 UI에 고지.

### 13.4 요율 변경 리스크 (사용자 신뢰)

- 요율 **인상**은 `effectiveFrom >= now + 7일`을 **시스템이 하드 강제**한다 (11.3 — 초안의 "운영 원칙 + 경고"는 레드팀에서 기각: 실수 한 번에 소급 인상 가능. 원가 급변 대응은 인하 즉시 적용 + 신규 기능의 신규 요율은 제약 없음으로 충분).
- 인상 발행 시 사용자 고지 트리거 자동 실행 (11.3, 12.6 표시 의무).
- 진행 중 hold는 hold 시점 룰로 정산 (pricingSnapshot 고정) — 사용 중 인상 소급 금지.
- 변경 공지: /pricing 요율 예시 표는 항상 현행 룰에서 파생 렌더 → 자동 최신화.

### 13.5 운영 리스크 · CS 플로우

- **포트원 장애**: checkout 불가 시 명시적 오류 + 재시도 안내. 웹훅 유실은 폴링 cron(7.2, 8.3)이 흡수.
- **요율 실수 (0 하나 더)**: owner 전용 + 발행 전 미리보기(대표 시나리오 차감액) + 직전 버전 대비 10배 이상 변화 시 폼 레벨 2차 확인.
- **cron 미실행**: 대사(14장)가 hold 누적·만료 미처리·주문 방치를 매일 검출.
- **장애/품질 보상 플로우 (레드팀 M3-제품)**: LLM 오류(errorCode 있는 usage_event)는 11.5에서 원클릭 reversal, 품질 불만(정산 정상)은 support의 한도 내 goodwill 지급(9.3). "미완 생성물도 과금"(13.3) 정책은 이 출구와 세트로만 성립한다. SLA: 장애 보상 1영업일, 미사용 환불 3영업일.
- **"차감이 왜 이만큼?" 문의 대응**: support가 11.4 상세(분개→usage→문서 링크)로 설명 + 필요 시 goodwill. 사전 견적 UI(10.5)가 이 문의 자체를 줄이는 1차 장치다.

---

## 14. 정합성 검증 (대사 · verify)

### 14.1 일일 대사 cron (`/api/cron/credits-reconcile`)

scope별로 실행하고 `credit_reconciliation_runs`에 기록. mismatch 시 audit_log(action="recon.mismatch"):

1. **ledger_wallet**: 지갑별 Σledger = balance (I1) + **chainHash 체인 재계산** — 삭제·수정·중간 삽입 변조 탐지 (I10, 레드팀 M4-보안). 전 지갑 스캔 (지갑 수 증가 시 최근 분개 있는 지갑만 + 주 1회 전수).
2. **lot_ledger**: I2, I5 검증.
3. **holds**: pending hold 중 expires 지난 것(cron 누락 검출), captured인데 usage_event가 settled 아닌 것, **released/expired hold인데 usage_event에 선기록 토큰(6.2 d-2)이 있고 분개가 없는 것** — "서비스 제공 후 미정산" 후보로 수동 정산 큐에 리포트 (레드팀 B3의 안전망).
4. **portone_orders**: 최근 48h 주문을 포트원 `GET /payments`(paymentId별)와 대조 — 내부 paid ↔ 포트원 PAID, 내부 지급액 ↔ 검증 금액. `pending usage`(6.2 부분 실패)도 여기서 리포트. **주문 테이블에 없는 결제**(고아 예약 실행 등)는 최우선 경보.
5. **관리 행위**: 기간 내 admin_grant 발행 총량이 임계 초과 시 mismatch급 경보 (레드팀 M1-보안), capture_after_expiry 빈도(hold_ttl 조정 신호).

### 14.2 verify 스크립트 (repo 컨벤션에 맞춤)

`packages/core/scripts/verify-credit-invariants.ts` (tsx 실행, 기존 verify-* 스타일): I1~I9를 SQL로 검증하고 위반 행을 출력. CI/수동 실행용. **주의(프로젝트 메모리)**: verify 스크립트가 프로세스 미종료할 수 있는 기존 현상 — 출력 완주로 판정.

`packages/contracts/scripts/verify-rls-policy.ts`에 4.13 테이블·정책 추가.

### 14.3 수동 도구

11.8 재실행 버튼 → 동일 로직 즉시 실행. mismatch 정정은 반드시 reversal 분개 + reason (UPDATE 금지 — 트리거가 어차피 막는다).

---

## 15. 구현 Phase 분할

각 Phase는 독립 커밋(들)로 완결하고, DoD(완료 기준)를 만족한 뒤 다음으로 넘어간다. 마이그레이션은 Phase당 1개로 묶는 것을 권장.

### P1 — 원장 코어 (스키마 + 도메인 + 리포지토리)

- schema.ts에 4장 전체 테이블·enum 추가 → generate/migrate (CHECK·트리거·partial index는 SQL 수동 추가)
- `packages/core/src/credits/` 도메인 (pricing/ledger/metering/errors/ports) + 단위 테스트 (vitest, 기존 match.test.ts 스타일)
- ServiceRepositories에 credits 포트 + drizzle/runtime 구현 + serviceData 등록
- 가입 보너스 훅 (6.6) + 기존 가입 사용자 소급 지급 스크립트 (`scripts/backfill-signup-bonus.ts` — 멱등 키 덕에 재실행 안전)
- 시드: settings, 초기 요율(운영 배치 모델 포함), products, plans
- verify-credit-invariants.ts
- **DoD**: 마이그레이션 적용, 단위 테스트·verify 통과, **DB 역할 속성 실측(`rolbypassrls` — 4.13) 기록** + admin/웹 커넥션 RLS 확인 3종(4.13)

### P2 — 과금 파이프라인

- withCreditMetering 구현 + hold cron
- 팝빌 미터링 (6.5)
- 기존 운영 배치 LLM 3곳(bizinfo/knowledge/prelabel)을 래퍼(무과금·원가수집 모드)로 감싸기
- balance/ledger/usage API (9.1 조회 계열) + contracts DTO
- **DoD**: 동시성 테스트(16.2) 통과, 팝빌 실호출 시 usage_events 적재 확인

### P3 — 충전 결제 (포트원 단건)

- portone.ts 클라이언트 (7.5), checkout/complete/webhook/주문 cron
- `/credits`·`/credits/complete` 페이지, 잔액 위젯
- **DoD**: 토스 테스트 채널로 결제→지급→웹훅 멱등(수동 재전송)→환불(포트원 콘솔 취소 → 웹훅 회수) 전 과정 1회 통과

### P4 — 플랜 정기결제

- plans API·구독 시퀀스·갱신 웹훅·안전망 cron·실패 재시도
- `/pricing` 페이지, `/billing` 크레딧 플랜 섹션
- **DoD**: 테스트 채널로 구독 시작→ (timeToPay를 5분 뒤로 당긴 예약으로) 갱신 1회→해지 시나리오 통과

### P5 — 사용량 UI

- `/account/usage` 3탭 + CSV, 크레딧 부족 모달, 차감 토스트, `/account` 허브 카드
- **DoD**: 402 플로우가 모달→충전→복귀로 이어짐 (수동 확인)

### P6 — Ops

- admin에 11장 페이지 8개 + 9.3 API + requireAdminRole 헬퍼
- **DoD**: 수동 지급→감사 로그→회원 상세에서 분개 확인 루프. role별 차단 확인

### P7 — 보안·대사 마감

- 대사 cron(5 scope) + 리포트 페이지, 요율 발행 하드 제약·2차 확인, 이상 신호 대시보드, 시크릿 회전 런북(12.7), **웹앱/admin DB 역할 분리 검토 + pgaudit 도입**(4.13·12.7 — 최소한 계획 문서화), `.env.example`·README 갱신
- **DoD**: verify 전체 통과 + 대사 5 scope ok + 16장 테스트 스위트 통과

**의존성**: P1→P2→P3→P5는 직렬. P4는 P3 이후. P6은 P1 이후 병행 가능. P7 마지막.

**LLM 기능 자체(지원서 드래프트 등)가 아직 미구현**이므로, P2 완료 시점부터는 신규 LLM 기능 구현 시 withCreditMetering 사용이 **의무 규약**이 된다 — 해당 기능 설계 문서(마스터 설계 8.8장)에 이 문서 6.2를 참조 링크로 추가할 것.

---

## 16. 테스트 계획

기존 테스트 스타일(vitest, `packages/core/src/matching/match.test.ts` 참조)을 따른다.

### 16.1 단위 (packages/core/src/credits/*.test.ts)

- 요율 계산: 토큰 조합별 ceil 정확성, 밀리크레딧 경계값, 룰 resolver 우선순위(6.3), 룰 부재 시 예외
- 멱등 키 빌더 형식 (plan 키가 orderId 기반인지 포함)
- lot 배분: 만료 임박 우선 정렬, 걸침 배분(한 차감이 여러 lot), 부족 시 예외, **targetLotIds 모드가 지정 lot만 깎는지(expiry가 다른 lot을 잠식하지 않는지 — 레드팀 M1)**
- 환불 계산: 청약철회(7일 내, 보너스 선소진 후 원금 보장) / 임의 환불(보너스 회수) / 환불 불가 / **업그레이드 72h 내 합산 판정** / admin_grant·promo lot 배제 (7.4 표 기반 테스트)
- reversal: 음수 분개 복원 시 lot remaining 원복, 원분개당 1회 제한

### 16.2 통합 (DB 필요 — 로컬 postgres, 기존 통합 테스트 인프라 확인 후 동일 방식)

- **동시성 (필수)**: 잔액 1,000에서 600짜리 hold 5개 병렬 → 정확히 1개 성공. 동일 idempotencyKey 분개 2회 병렬 → 1건만 생성. 동일 nonce의 admin adjust 2회 → 1건
- hold capture 시 actual > held (shortfall 경로 — creditsCharged=실차감액 검증), actual < held (차액 반환)
- **TTL 경과 후 capture (레드팀 B3)**: cron이 released/failed로 만든 뒤 capture 도착 → 분개 발생 + settled 복귀 + captured_late 기록
- **hold 중 lot 만료 (레드팀 M8)**: hold 시점에 살아있던 lot이 capture 시점에 만료 → 만료 유예 필터로 정상 차감
- 웹훅 멱등: 동일 webhookId 2회 → 1회 처리. Transaction.Paid가 complete API보다 먼저/나중 도착 양쪽 시나리오
- verifyAndGrant 상태 가드: paid 주문에 재호출 → no-op (failed로 덮이지 않음), READY 상태 → 대기 반환
- 구독: incomplete에서 결제 실패 → active 없음·재시도 가능. 같은 날 구독 시작→업그레이드 → 두 지급 모두 발생(키 충돌 없음)
- 만료 cron: 만료 lot expiry 분개(targetLotIds) + I1/I2 유지, pending hold 지갑 스킵
- 트리거: ledger UPDATE 시도 → 예외. chainHash: 중간 분개 변조 시 대사 검출

### 16.3 E2E (수동 + 토스 테스트 채널)

P3/P4 DoD의 결제 시나리오. 체크리스트를 `docs/plans/` 하위가 아닌 PR 본문에 기록.

### 16.4 회귀 가드

verify-credit-invariants.ts를 CI(있다면) 또는 P7 완료 기준에 포함. 대사 cron이 운영 중 상시 회귀 가드 역할.

---

## 17. 레드팀 반영 로그

> 2026-07-09, 설계 초안에 대해 3개 관점의 레드팀을 병렬 수행하고 지적을 본문에 반영했다. 레드팀은 문서만이 아니라 **실제 코드베이스를 대조**해 초안의 전제 오류 2건(RLS 인과 오진, bizNo UNIQUE 간과)을 찾아냈다. 아래 표의 "처리"는 최종 본문 기준이다.

### 17.1 원장·결제 정합성 레드팀

| 등급 | 지적 | 처리 |
|---|---|---|
| BLOCKER B1 | 플랜 지급 멱등 키 `plan:{subId}:{periodStart}`가 같은 날 업그레이드·재시도에서 충돌 → "충돌=no-op 성공" 규약과 결합해 결제됐는데 지급이 무음 소실 | **수용**: 키를 `plan:{orderId}`로 변경 — 모든 플랜 결제는 주문과 1:1 (4.3, 8.2, 8.3) |
| BLOCKER B2 | 업그레이드가 기존 포트원 예약을 취소하지 않음 → 구 예약 실행 시 이중 청구 + 주문 미존재로 무기록 결제, 대사도 못 잡음 | **수용**: "모든 구독 상태 전이의 첫 단계 = 미소진 예약 전부 취소" 불변 규칙(3.1, 8.5) + 예약 등록 시 주문 선생성으로 웹훅 매칭을 주문 테이블 기반으로 전환(8.2 step 5, 8.3) + 미지의 paymentId 결제는 즉시 경보(14.1) |
| BLOCKER B3 | hold TTL 경과 후 captureHold가 no-op → LLM이 10분 넘게 걸리면 서비스 제공 후 무과금, usage가 failed로 남아 대사로도 검출 불가 | **수용**: capture는 hold 상태에 의존하지 않음 — 멱등은 usage 키가 보장, released/expired여도 분개 실행 + captured_late 기록(5.3) + 대사에 미정산 후보 리포트(14.1) |
| MAJOR M1 | applyLedgerEntry에 lot 지정 모드가 없어 expiry·refund가 소진 순서 배분으로 흘러 엉뚱한 lot을 잠식 (I2·I5 붕괴) | **수용**: `lotSelection: "consume_order" \| { targetLotIds }` 파라미터 추가, expiry/refund/reversal은 지정 모드 의무(5.2, 5.4, 7.4) + 단위 테스트 추가(16.1) |
| MAJOR M2 | verifyAndGrant에 주문 상태 가드가 없어 paid/refunded 주문이 failed로 덮임 | **수용**: step 0 상태 가드 + 포트원 상태별 분기(READY/PENDING은 대기, 터미널 FAILED만 failed) (7.2) |
| MAJOR M3 | 콘솔 발 Cancelled 웹훅에서 lot 잔여 부족 시 처리 규약 부재 (돈 나가고 크레딧 회수 실패) | **수용**: 회수 가능분만 회수 + refund.shortfall 감사 + 지갑 자동 동결 + "콘솔 직접 취소 금지" 운영 수칙(7.4, 12.7) |
| MAJOR M4 | admin 조정 멱등 키 `admin:{auditLogId}`는 시도마다 새 id → 더블클릭 이중 지급 | **수용**: 폼 렌더 시 생성한 클라이언트 nonce 기반 `admin:{nonce}`(4.3, 9.3, 11.4) |
| MAJOR M5 | reversal의 멱등 키·lot 반영 규약 공백 → 정정할수록 I2가 깨지는 루프 | **수용**: `reversal:{원분개id}` + 원분개당 1회 unique + lot 복원/지정 차감 규약(4.3) |
| MAJOR M6 | 구독을 active로 선생성 → 첫 결제 실패 시 유령 active가 재시도를 영구 차단 | **수용**: `incomplete` 상태 신설, 결제 PAID 확인 후 active 전이(3.1, 4.0, 8.2) |
| MAJOR M7 | 안전망 cron에 "결제 성공·웹훅만 유실" 분기가 없어 이중 청구 또는 방치 | **수용**: SUCCEEDED→멱등 갱신 직접 실행(즉시결제 금지), FAILED→8.4, 미실행만 즉시결제 + failed inbox 48h 자동 재처리(7.3, 8.3) |
| MAJOR M8 | hold가 lot 만료를 고정하지 않음 → plan lot 만료 직전 대형 작업으로 반복 무과금 + estimate 미결속 시 shortfall 증폭 | **수용**: capture의 lot 필터를 `expires_at > hold.createdAt`으로(만료 유예), expiry cron은 pending hold 지갑 스킵(5.3, 5.4) + `maxOutputTokens`를 API `max_tokens`에 구조적 바인딩(6.2) |
| minor m1~m7 | I6-shortfall 모순, 수동 정산 불능, frozen×예약결제, complete 소유권, bigint 문자열 집계, BillingKey.Deleted 오매칭, 만료 cron 조회 에러 오판 | **전부 수용**: I6 예외 명시(5.1), report 선기록(6.2 d-2), freeze 의미론 정의+예약 취소 기본(4.1), 소유권 검증(7.2), Number() 캐스팅 명시(5.2), 현재 키 일치 조건(7.3), 조회 에러 시 보류(7.2) |

### 17.2 보안·ISMS·법무 레드팀

| 등급 | 지적 | 처리 |
|---|---|---|
| BLOCKER B1 | 초안 4.13의 RLS 전제가 오진 — 코드 대조 결과 admin은 FORCE 테이블(`billing_tax_documents` 등)도 읽고 있어 접속 역할이 BYPASSRLS 계열로 추정. FORCE 제외는 얻는 것 없이 `transactionWithOptionalUser` 경로의 전체 노출만 남김 | **수용**: 4.13 전면 재작성 — P1 착수 시 `pg_roles` 실측 의무 + 분기표, FORCE 적용, 크레딧 리포지토리의 user 컨텍스트 강제 가드(코드 레벨 1선), DB 역할 분리 P7 등재 |
| MAJOR | settings/pricing_rules "전부 차단"과 /pricing 요율 표시의 모순 + 원시 요율 노출 시 마진 역산 | **수용**: 서버 라우트 화이트리스트 노출 규약 — 파생값(예상 소모량)만 DTO로(4.13, 9.1 estimate) |
| MAJOR M1 | admin 단독으로 자기 계정에 무제한 지급 → 미사용 환불로 현금 인출 (사전 통제 부재) | **수용**: 자기·연결 계정 지급 하드 차단 + 임계 초과는 owner 2인 결재(pending 큐) + 환불 계산의 lot.source 검사로 admin_grant 현금화 차단 + admin_grant 총량 대사 경보(9.3, 11.4, 7.4, 14.1) |
| MAJOR M2 | checkout/complete가 주문 소유권 미검증 → 타인 주문 상태 조작·잔액 열람 | **수용**: API 래퍼에서 `order.userId === session.userId`(불일치 404), balance는 세션 경로만 반환(7.2) |
| MAJOR M3 | admin의 회원 상세 열람이 감사 기록에 없음 (ISMS 접속기록 요건 미달) + 실패 결제 시도 추적 부재 | **수용**: `member.viewed`·`payment.checkout_created` 액션 추가 + "취급자 열람은 별도 audit 필수" 원칙 명문화(9.3, 12.2) |
| MAJOR M4 | append-only 트리거는 앱 역할이 끌 수 있어 부인 방지 근거 부족 ("트리거 신뢰"는 가정) | **수용**: 분개 chainHash 체인 + 일일 대사 재검증(4.3, 5.1 I10, 14.1) + pgaudit P7 등재(12.7) |
| MAJOR M5 | 웹훅 payload 원문 1년 평문 보존 + 수동 마스킹 = PII 장기 적재 | **수용**: 원문 비저장 — 화이트리스트 발췌(payloadDigest)만, 원문 필요 시 재조회로 재구성(4.10, 12.4) |
| MAJOR M6 | 미성년자 결제·법정대리인 동의 통제 전무 | **수용**: 12.6에 고지·약관·본인인증 검토 항목 추가 |
| MAJOR M7 | 청약철회(7일)와 "보너스 회수 후 부족 시 환불 불가"의 충돌 — 철회권 제약 소지 | **수용**: 청약철회/임의 환불 이원화, 7일 내 원금 미사용분 환불 보장(7.4 표, 12.6) |
| minor m1~m3 | bizNo 무염 해시는 전수 역산 가능(단 원문이 이미 companies에 평문), actorEmail과 파기 원칙 충돌, 시크릿 회전 절차 부재 | **전부 수용**: HMAC+pepper·가명 키로 정직하게 표기(6.5), 감사 목적 법정 보존 근거 명시(4.11, 12.5), 회전 런북(12.7). companies.bizNo 평문 저장 자체는 본 설계 범위 밖 — 별도 검토 각주만 |
| 관찰 | 주문 생성 스팸 방어 없음 | **수용**: user당 분당 상한 + 동시 미결제 5개 상한(7.2, 9.1) |

### 17.3 제품·운영·어뷰징 레드팀

| 등급 | 지적 | 처리 |
|---|---|---|
| BLOCKER B1 | 13.1의 "동일 bizNo 5계정 초과 탐지"는 `companies.bizNo` UNIQUE 제약 때문에 발생 불가능한 데드코드. 실제 파밍 벡터는 **팀 초대 경로**(같은 회사에 계정 N개 초대 → 전원 보너스 + 게이트 통과). 3단 게이트는 소유권 증명이 아니라 조회 UX | **수용**: 13.1 전면 재설계 — 회사 스코프 보너스 소모 상한(company_bonus_consumption_cap), companyId·초대 속도 기준 이상 신호, lazy grant(6.6과 세트) |
| MAJOR M1 | 플랜 크레딧 월말 전액 소멸 × 지원사업 시즌성(간헐 사용) 고객 → 해지의 1차 사유 | **수용**: 만료를 지급+2주기(60일)로 변경 — 실질 1주기 이월, 적립 차익은 2개월분 상한으로 구조 차단(4.2.1, 8.1) |
| MAJOR M2 | 애매한 잔액 데드존 + 402를 사후에만 만남 (사전 견적 UI 부재) | **수용**: `GET /credits/estimate` API + 작업 시작 버튼 옆 사전 견적 의무(9.1, 10.5), 표시 잔액을 available로 통일. 보너스량 상향은 기각 — 요구 1이 1,000으로 명시, settings로 즉시 조정 가능(18.10 유지) |
| MAJOR M3 | support가 조회만 가능해 소액 보정도 전건 에스컬레이션 + 장애 보상 플로우·SLA 부재 | **수용**: support 한도 내 goodwill 지급(9.3, 12.3), 장애/품질 보상 탭 + SLA 수치(11.5, 13.5) |
| MAJOR M4 | "토큰"을 모르는 고객에게 토큰 기반 내역 노출 + 요율 인상 7일 원칙이 비강제·비공개 | **수용**: 토큰 컬럼 기본 숨김·원화 환산 표시(10.3), 인상 시 `effectiveFrom>=+7d` 하드 강제 + 고지 트리거(11.3, 12.6, 13.4) |
| MAJOR M5 | "flex" 네이밍이 실체(최고가·소멸)와 정반대 → 배신감 리스크 | **부분 수용**: flex lot 만료 3주기(90일) 우대로 이름값 부여(8.1). 코드명 자체 변경은 요구 6이 plus/pro/flex를 명시하므로 단독 결정하지 않음 — 18.11 오픈 퀘스천으로 사용자 결정에 회부 |
| minor m1~m4 | 업그레이드 직후 플랜 환불 구멍, 실효 마진 과대 표시, 무료 지갑 즉시 발행의 부채·GC 비용, frozen×진행 중 hold UX | **전부 수용**: 72h 합산 판정(7.4), 명목/실효 마진 분리(5.5, 11.1), lazy grant(6.6), freeze 예외에 usage_capture(4.1, 5.2) |

### 17.4 기각·보류 항목 (사유)

| 지적 | 처리 |
|---|---|
| signup_bonus_credits 상향 (제품 M2 일부) | **보류** — 요구사항이 1,000을 명시. settings 값이라 운영 중 즉시 조정 가능, 18.10에서 체험 가치 검증 후 결정 |
| 플랜 코드명(flex) 변경 (제품 M5 일부) | **보류** — 요구사항 명시 값. 출시 전 확정 필요 사항으로 18.11에 회부 |
| companies.bizNo 평문 저장 재설계 (보안 m1 일부) | **범위 외** — 크레딧 시스템 밖의 기존 스키마. 별도 개인정보 검토 과제로 각주만 (6.5) |
| 전 레드팀이 "방어 확인"으로 판정한 항목 (hold 직렬화, 사후검증, 멱등 지급, 금액 위변조 등) | 변경 없음 — 보고서의 검증 결과만 기록 |

---

## 18. 오픈 퀘스천 (구현 전 결정 불필요, 후속 논의)

1. **기존 billing_subscriptions 통합**: 크레딧 플랜이 자리 잡으면 company 스코프 구독을 크레딧 플랜으로 흡수할지. 현재는 분리(2.8, 8.6).
2. **회사(팀) 공유 지갑**: `credit_wallets`에 ownerType(user|company) 확장 여지만 남김 (2.2).
3. **크레딧 선물·양도**: 전금법 리스크로 비목표 고정 (12.6). 재검토 시 법률 자문 선행.
4. **모바일 앱 결제 정책**: 앱 내 크레딧 구매 노출 시 스토어 IAP 정책 충돌 검토 필요.
5. **feature별 hold TTL 오버라이드**: 장시간 에이전트 작업(>10분) 도입 시. (무과금 리스크 자체는 레드팀 B3 수정 — capture-after-expiry — 로 해소됨. TTL 오버라이드는 failed 오분류·재시도 UX 개선용)
6. **만료 예정 알림 채널**: 이메일/알림톡 — 알림 인프라 정리 후.
7. **가상계좌·간편결제 확대**: 초기 카드 전용(7.4). 가상계좌는 환불 계좌 수집(PII) 설계 필요.
8. **전역 레이트리밋 인프라**: 현재 인메모리 수준. 트래픽 증가 시 Upstash 등.
9. ~~웹훅 payload 마스킹 자동화~~ → **해소**: 원문 비저장(화이트리스트 발췌)으로 설계 변경 (4.10).
10. **1,000 크레딧의 체험 가치 검증**: 5.5 예시 기준 초안 2회 분량 — 온보딩 목표(첫 문서 완성 체험)에 부족하면 signup_bonus_credits 상향 (settings로 즉시 조정 가능).
11. **플랜 네이밍 재검토 (레드팀 M5-제품)**: "flex"가 최고가 티어인 것이 사용자 기대("유연함")와 상충한다는 지적. 90일 만료 우대(8.1)로 일부 해소했지만, 출시 전 코드명·포지셔닝 확정 필요 — plus/pro/flex는 요구사항 명시 값이라 변경은 의사결정자 승인 사항. 출시 후 변경은 URL·약관·결제 이력에 각인되므로 **출시 전이 마지막 기회**.
12. **웹앱/admin DB 역할 분리**: 4.13·P7 참조 — 단일 BYPASSRLS 역할 구조 해소가 크레딧 도메인 접근통제의 근본 과제.

---

## 부록 A. 요구사항 ↔ 설계 매핑

| # | 요구 | 설계 위치 |
|---|---|---|
| 1 | 가입 무료 1,000 크레딧 (1000=1000원 고민 포함) | 2.1(환율 결정), 4.7(signup_bonus_credits), 6.6(지급 훅), 13.1(파밍 방어) |
| 2 | LLM 사용 시 차감 | 2.4, 5.2~5.3, 6.2(withCreditMetering) |
| 3 | 포트원 V2 + 토스 충전 결제 | 7장 전체 |
| 4 | 환율·소모량·토큰 요율 ops 조정 | 4.6(요율 버전), 4.7(설정), 5.5(공식), 11.2~11.3 |
| 5 | 마이페이지 사용량 확인 | 10.3(/account/usage), 9.1(usage API) |
| 6 | plus/pro/flex = 월간 크레딧 차이 | 8장, 4.9 |
| 7 | 플랜·충전·사용량 페이지 | 10.1(/pricing), 10.2(/credits), 10.3(/account/usage) |
| 8 | ops 회원별 수동 충전 | 11.4, 9.3(adjust API) |
| 9 | ISMS 수준 보안 + 전 행위 감사 로그·조회 | 12장, 4.11, 11.7 |
| 10 | 팝빌 조회 무과금 | 6.5 (미터링만, creditsCharged=0) |
| 11 | 운영에 필요한 전체 기능 | 11장(ops 8페이지), 14장(대사), 13장(어뷰징), 15장(Phase) |
