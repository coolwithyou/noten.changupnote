# HANDOFF — AI 크레딧 시스템 구현 완료 후 잔여 작업 (2026-07-10)

## 목표

cunote를 AI 크레딧 기반 과금 서비스로 전환하는 구현 오케스트레이션. 설계 규범은 `docs/plans/2026-07-09-ai-credit-system.md`(단일 진실), 오케스트레이션 절차·진행 상황은 `docs/plans/2026-07-10-ai-credit-implementation-handover.md` 상단 블록.

## 완료된 것 (전부 main에 커밋됨)

**P1~P7 전 Phase + admin 결제 실행 배선 + 기존 사용자 소급 지급 완료.**

| 항목 | 커밋 | 검증 증거 |
|---|---|---|
| P1 원장 코어 (스키마 14테이블·마이그레이션 0038·단일 진입점·가입 보너스 훅·시드) | a6d4f62·b7f6fd6·33e0a4a | RLS 실측 rolbypassrls=true→전 테이블 FORCE, verify I1~I10 위반 0 |
| P2 과금 파이프라인 (hold·withCreditMetering·조회 API 5종·팝빌 미터링·운영 배치 래핑) | 1d878aa·6b68cba | 통합 9/9 (동시성·TTL capture·만료 유예) |
| P6 Ops admin (페이지 8종·API 19종·requireAdminRole·승인 큐) | 5d9baf5 | admin typecheck, role·감사 코드 검수 |
| P3 충전 결제 (portone.ts·verifyAndGrant·환불 계산·웹훅·/credits) | eef9093·72e3859 | 결제 통합 10/10 (C1~C3), 환불 단위 10 |
| P4 플랜 정기결제 (구독·갱신·안전망 cron·/pricing·/billing) | 192e9d8·bf92b64 | 구독 통합 12/12 (D1~D4) |
| P5 사용량 UI (/account/usage 3탭·견적 배지·402 모달·토스트) | c1315ab | E3 확인(토큰 상세 토글에만), 프로덕션 빌드 통과 |
| 설계 9.3 보강 + admin 결제 실행 배선 (/api/internal/credits/* 5종·환불 executeRefund·freeze 연동) | 9e65f50·717fd4e | 환불 통합 7/7 |
| P7 대사·보안 마감 (대사 cron 5 scope·lot 만료 cron·chainHash 변조 탐지·런북·운영 문서) | e4b8ed1·449b602 | 대사 통합 7/7 (트리거 DISABLE 후 변조도 chainHash로 검출), 공용 DB 대사 1회 기록 |
| 소급 지급 (기존 사용자 10명 × 1,000cr — 사용자 승인 하에 실행) | (데이터만) | 지갑 10·lot 10·분개 10, verify OK |

최종 테스트 상태: **단위 77 + 통합 45(기본 9·결제 10·구독 12·환불 7·대사 7) 전부 통과.** core/web/admin 빌드·타입체크 통과.

부수: 이 세션에서 statusLine을 claude-dashboard(detailed)로 설정함 (`~/.claude/settings.json`, `~/.claude/claude-dashboard.local.json` — 프로젝트와 무관).

## 남은 작업 (전부 사용자 동반 — 세션 단독 진행 불가)

1. ~~**env 키 세팅**~~ — **완료 (2026-07-10 후속 세션)**:
   - 로컬 루트 `.env.local`에 4종 추가 (CRON_SECRET·INTERNAL_API_SECRET·WEB_INTERNAL_BASE_URL=`http://127.0.0.1:4010`·CREDIT_BIZNO_HMAC_PEPPER)
   - Vercel changupnote(production): INTERNAL_API_SECRET·CREDIT_BIZNO_HMAC_PEPPER 추가 (CRON_SECRET은 기존 존재)
   - Vercel changupnote-ops(production): INTERNAL_API_SECRET(웹과 동일 값)·WEB_INTERNAL_BASE_URL=`https://changupnote.com` 추가 — ops 프로젝트는 CLI 토큰이 아니라 **대화형 로그인 크레덴셜**(`--scope team-coolwithyou`, 토큰은 noten 팀만 접근 가능)
   - pepper는 공용 DB에 가명 키(bizNoRef)가 쌓이므로 **로컬=운영 동일 값**, INTERNAL_API_SECRET은 로컬≠운영 분리
   - env는 **다음 배포부터** 주입됨 → 같은 날 배포 완료(아래 5번)로 주입됨
2. **포트원 단건결제 E2E (검수 C4)** — 포트원 V2 계정·storeId·API Secret·토스 단건 테스트 채널 키·웹훅 시크릿 확보 → `.env.local` 7.1 키 8종 → 포트원 콘솔에 웹훅 URL(`/api/webhooks/portone`) 등록 → 결제→지급→웹훅 수동 재전송(멱등)→콘솔 취소(회수+frozen) 1회 완주. 절차: `docs/guides/credit-system-operations.md`
3. **토스 빌링 E2E (P4 DoD)** — 빌링(정기) 테스트 채널 키(단건과 별도 MID) → 구독 시작→갱신(timeToPay 5분 뒤 예약)→해지
4. **dev 서버 런타임 확인** (dev 서버는 사용자 소유 — `pnpm dev:web`, `pnpm dev:ops`):
   - admin F1~F3: viewer로 adjust → 403 / member 상세 열람 → audit_logs에 member.viewed / 동일 nonce 재제출 → 분개 1건
   - P5 UI: /account/usage 3탭, /credits, /pricing 렌더
   - 팝빌 미터링(B2): 미캐시 사업자번호 1건 실조회 → usage_events 1행(status=free, charged=0)
5. ~~**배포 시**~~ — **완료 (2026-07-10 후속 세션, 병합 main 716012c 한 묶음 — 사용자 승인)**: 웹 changupnote(`changupnote.com`)·admin changupnote-ops(`ops.changupnote.com`) 프로덕션 배포 Ready, 신규 env 주입됨. cron 9종(크레딧 5종, "10종"은 오기) 등록 실측, noten pro 플랜(한도 40) 문제 없음. 검증: /pricing 200 · /credits·/account/usage 307(로그인 리다이렉트) · cron 401 가드 · 웹훅 405(POST 전용) · apply-v2 상세/workspace 200. **함정 발견**: 프로젝트가 GitHub 연동(origin `coolwithyou/noten.changupnote`)된 뒤로는 CLI 배포에 로컬 git author(sw@ba-ton.kr — noten 팀 비멤버)가 붙으면 seat 승인 대기(`BLOCKED`/`TEAM_ACCESS_REQUIRED`)로 빌드가 시작되지 않고 무한 멈춤 → **`.git` 제외 사본에서 배포**로 해결(CLAUDE.md 반영)
6. ~~**로컬 정리(rm은 사용자)**~~ — **완료 (2026-07-10 후속 세션)**: 마커 3개 삭제, `.git/stale-locks/`는 이미 빈 상태였음

## 테스트 재실행 커맨드 (복붙)

```bash
# 단위 (외부 의존 없음)
pnpm test:credits-unit

# 통합 — 일회용 docker + 공용 DB 스키마 덤프 복원 (쓰기는 컨테이너에만)
DB_URL=$(grep -E "^DATABASE_URL=" .env | cut -d= -f2- | tr -d '"' | sed 's/?.*//')
pg_dump --schema-only --no-owner --no-privileges "$DB_URL" > /tmp/cunote-schema.sql
docker run --rm -d --name cunote-credit-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=cunote -p 54340:5432 postgres:17
sleep 5 && psql "postgres://postgres:test@localhost:54340/cunote" -q -f /tmp/cunote-schema.sql
export DATABASE_URL="postgres://postgres:test@localhost:54340/cunote"
pnpm test:credits-integration && pnpm test:credits-payment-integration && \
pnpm test:credits-subscription-integration && pnpm test:credits-refund-integration && \
pnpm test:credits-reconcile-integration
docker stop cunote-credit-test

# 불변식 verify (공용 DB 읽기 전용 — 미종료 현상 있으니 출력 완주로 판정 후 kill)
pnpm exec tsx packages/core/scripts/verify-credit-invariants.ts
```

## 검증 체크리스트 (잔여)

- [x] env 4종 로컬·Vercel 세팅 (INTERNAL_API_SECRET / WEB_INTERNAL_BASE_URL / CRON_SECRET / CREDIT_BIZNO_HMAC_PEPPER) — 2026-07-10 완료, 상세는 "남은 작업" 1번
- [ ] 포트원 단건 E2E 1회 완주 (C4: 결제→지급→웹훅 멱등→콘솔 취소 회수)
- [ ] 실채널 첫 웹훅에서 서명 헤더 형식 확인 (표준 Webhooks 스펙 가정 구현 — 다르면 `portoneWebhook.ts` 조정)
- [ ] 토스 빌링 E2E (구독→갱신→해지)
- [ ] admin F1~F3 런타임 확인
- [ ] 팝빌 실호출 미터링 1건 확인
- [ ] 배포 후 cron 9종 동작 + 대사 5 scope ok (portone scope는 키 세팅 후 ok로 바뀌어야 정상) — cron 등록은 2026-07-10 배포에서 실측 확인, 실행 결과는 다음 스케줄(대사 05:00 KST) 이후 admin /credits/reconciliation에서 확인

## 주의 / 함정

- **fresh DB에 `pnpm db:migrate` 재생은 조용히 실패**(0018~0024 수동 마이그레이션 이력, exit 1인데 에러 미출력) → 통합 테스트 DB는 반드시 위의 pg_dump 복원 방식
- **실효 DATABASE_URL은 루트 `.env`의 Supabase 풀러 = 실서비스 공용 DB.** 쓰기 테스트 절대 금지(테스트 파일에 pooler 호스트 가드 내장). `.env.local`의 DATABASE_URL 오버라이드는 주석 처리 상태
- verify·backfill 등 tsx 스크립트는 통과해도 프로세스가 안 죽는 기존 현상 — 출력 완주로 판정. 백그라운드로 돌리면 stdout 버퍼가 유실될 수 있음(소급 지급 때 실제 발생 — 작업은 완료됐는데 출력만 빈 채 hang)
- **git add -A 금지** — 워킹트리에 무관 병렬 세션 잔재 있음: `scripts/dev-ops.mjs`(M), `detail-325-desktop.png`, `apps/web/scripts/audit-css-classes.mjs`, `skills-lock.json`, `apps/web/next-env.d.ts`(M). 커밋 시 명시 스테이징
- packages/core 수정 후 `pnpm --filter @cunote/core build` 없이는 dev 서버 미반영(verify는 tsx라 착시)
- **신규 LLM 기능 구현 시 의무 규약**: withCreditMetering(설계 6.2) + 사전 견적 UI(10.5의 CreditEstimateBadge) + 402 모달 배선(`parseInsufficientCreditsError`). 마스터 설계 8.8장 작업 시 참조 링크 추가할 것(설계 15장 하단 지시)
- 레드팀 검증 규약(멱등 키 표 4.3, lotSelection 모드, capture-after-expiry, 예약 전부 취소 등)은 임의 변경 금지 — 변경 필요 시 설계 문서 먼저 수정·커밋(핸드오버 §0)

## 백그라운드 작업

없음. 모든 서브에이전트 완료, docker 컨테이너 정리됨(`docker ps`에 cunote-* 없어야 정상).
