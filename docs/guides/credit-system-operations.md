# 크레딧 시스템 운영 절차

> 대상: 운영자·개발자. 크레딧/결제 시스템의 상시 운영(cron·대사·검증·테스트·E2E)을 한 곳에 모은다.
> 설계 원본: `docs/plans/2026-07-09-ai-credit-system.md`. 시크릿 회전은 `docs/runbooks/credit-secrets-rotation.md`.
> DB 역할 분리·pgaudit 계획: `docs/plans/2026-07-10-db-role-separation-pgaudit.md`.

## 1. 크론 목록 (Vercel Cron — apps/web/vercel.json)

모든 크론은 `CRON_SECRET` Bearer 로 보호된다(미설정 시 503). 시간은 UTC 스케줄이며 KST 는 +9h.

| 경로 | 스케줄(UTC) | KST | 역할 |
|---|---|---|---|
| `/api/cron/credits-expire-holds` | `*/5 * * * *` | 5분마다 | hold TTL 만료 스윕(5.3). 뒤늦은 capture 는 정산이 이김 |
| `/api/cron/credits-expire-orders` | `*/10 * * * *` | 10분마다 | 주문 만료·지연 완료 구제(7.2) |
| `/api/cron/credits-plan-renewals` | `0 * * * *` | 매시 | 갱신 안전망 + 실패 웹훅 inbox 48h 재처리(8.3/7.3) |
| `/api/cron/credits-expire-lots` | `0 19 * * *` | **04:00** | lot 만료 소멸(5.4). targetLotIds 분개, pending hold 지갑 스킵 |
| `/api/cron/credits-reconcile` | `0 20 * * *` | **05:00** | 일일 대사 5 scope(14.1) |

수동 트리거(로컬/운영 점검):
```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" "$WEB_BASE/api/cron/credits-reconcile"
curl -sS -H "Authorization: Bearer $CRON_SECRET" "$WEB_BASE/api/cron/credits-expire-lots"
```

## 2. 일일 대사 (5 scope)

`/api/cron/credits-reconcile` 이 매일 05:00 KST 에 아래 5 scope 를 실행해 `credit_reconciliation_runs` 에 scope 별로
기록하고, mismatch 시 `credit_audit_logs(action='recon.mismatch')` 를 남긴다. **읽기 + recon_runs/audit INSERT 만 — 원장 변이 없음.**

| scope | 검증 내용 |
|---|---|
| `ledger_wallet` | I1(Σledger=balance) + chainHash 체인 재계산(I9/I10 — 삭제·수정·중간 삽입 변조 탐지) |
| `lot_ledger` | I2(Σactive lot=balance) + I5(lot 소비 = 참조 음수 분개 배분) |
| `holds` | TTL 누락 pending, captured-미정산, ★ released/expired 인데 선기록 토큰 있고 미정산(B3 수동 정산 큐) |
| `portone_orders` | 최근 48h 주문 ↔ 포트원 대조. ★ 고아 결제(주문 없는 PAID) 최우선 경보. 키 미설정 시 이 scope 만 error |
| `admin_activity` | admin_grant 총량 임계 경보 + capture_after_expiry 빈도 + 동일 companyId 신규 멤버 급증(13.1) |

- **조회**: admin `/credits/reconciliation` 페이지(일자 필터, scope별 상태, mismatch 상세 summary).
- **수동 재실행**: 같은 페이지의 "수동 재실행" 버튼(admin+). `POST /api/admin/credits/reconciliation` → 웹 내부 `POST /api/internal/credits/reconcile`(scope 선택 가능) → 동일 로직 즉시 실행.
- **mismatch 정정**: 반드시 reversal 분개 + reason(14.3). UPDATE 금지(트리거가 막고 chainHash 재검증에 걸린다).

## 3. verify 스크립트

CI/수동 회귀 가드. 대사 cron 과 **동일한 chainHash 검증 코어**(`@cunote/core` `recomputeWalletChain`)를 공유한다(14.2).

```bash
pnpm verify:credit-invariants   # I1~I10 SQL 검증(위반 행 출력, SUMMARY 라인으로 판정)
pnpm verify:rls-policy          # 크레딧 테이블·정책·트리거·CHECK·partial index 등재 검증
pnpm verify:route-policy        # cron/내부 라우트 분류(SYSTEM_CRON_ROUTES) 검증
```

> 주의(프로젝트 메모리): verify 스크립트가 프로세스 미종료할 수 있다 — **SUMMARY 출력 완주로 판정**한다.

## 4. 테스트 실행법

### 단위 (DB 불필요)
```bash
pnpm test:credits-unit   # 요율·멱등키·lot배분·환불계산·reversal·웹훅서명
```

### 통합 (일회용 docker postgres 필요 — 공용 DB 금지)
공용 DB 스키마를 pg_dump 로 떠서 일회용 컨테이너(포트 54340)에 복원한 뒤 실행한다. `DATABASE_URL` 호스트가
`pooler.supabase.com`/`supabase.co` 면 각 테스트가 즉시 abort 한다(실서비스 보호).

```bash
# 1) 스키마 덤프 → 2) 컨테이너 기동 → 3) 복원
pg_dump "$PROD_DIRECT_URL" --schema-only --no-owner --no-privileges > /tmp/schema.sql
docker run --rm -d --name cunote-pay-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:17
until docker exec cunote-pay-test pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
psql "postgres://postgres:test@127.0.0.1:54340/cunote" -f /tmp/schema.sql

# 4) 통합 테스트(각각)
export DATABASE_URL="postgres://postgres:test@127.0.0.1:54340/cunote"
pnpm test:credits-integration               # 원장 코어(applyLedgerEntry, hold/capture, 동시성)
pnpm test:credits-payment-integration       # 충전 결제·웹훅 멱등
pnpm test:credits-subscription-integration  # 구독 시작·갱신·해지
pnpm test:credits-refund-integration        # 환불(청약철회/임의/불가)
pnpm test:credits-reconcile-integration     # ★ 대사 5 scope + 변조 검출 + lot 만료 cron
```

> `fresh db:migrate` 로 스키마를 재생하지 말 것(조용히 실패). 반드시 공용 DB 덤프 복원 방식을 쓴다.

## 5. E2E (수동 + 토스 테스트 채널)

결제 실호출은 포트원 토스 테스트 채널로만 수행하고, 체크리스트는 PR 본문에 기록한다(16.3).

- **충전(P3)**: 결제 → 지급 → 웹훅 멱등(수동 재전송) → 환불(포트원 콘솔 취소 → 웹훅 회수) 1회 통과.
- **구독(P4)**: 구독 시작 → (timeToPay 를 5분 뒤로 당긴 예약) 갱신 1회 → 해지.
- **부족(P5)**: LLM 기능 402 → 부족 모달 → 충전 → 복귀.

## 6. 시크릿 · env

크레딧 시스템 신규 env 는 `.env.example` 의 "AI 크레딧 시스템" 섹션에 주석과 함께 정리돼 있다:
`CRON_SECRET`, `INTERNAL_API_SECRET`, `WEB_INTERNAL_BASE_URL`, `CREDIT_BIZNO_HMAC_PEPPER`,
`PORTONE_*`(STORE_ID·API_SECRET·CHANNEL_KEY_*·WEBHOOK_SECRET·WEBHOOK_SECRET_PREVIOUS), `NEXT_PUBLIC_PORTONE_*`.

시크릿 회전(정기·유출 대응)·웹훅 24h 병행 검증 창은 `docs/runbooks/credit-secrets-rotation.md` 참조.

## 7. 운영 수칙 (금지 사항)

- 포트원 콘솔에서 결제를 **직접 취소하지 않는다** — 반드시 admin 11.5 환불 경로 경유(shortfall 사고 방지).
- 크레딧 테이블 직접 UPDATE/DELETE 금지(트리거가 막고, 트리거 무력화는 chainHash 재검증·pgaudit 대상).
- mismatch 정정은 reversal 분개로만(UPDATE 금지).
