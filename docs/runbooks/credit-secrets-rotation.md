# 크레딧 시스템 시크릿 회전 런북

> 설계 근거: `docs/plans/2026-07-09-ai-credit-system.md` 12.7 "시크릿 회전 런북" / 12.4 / 4.13.
> 대상: 크레딧·결제 도메인이 의존하는 5개 시크릿. 정기 회전과 유출 대응 절차를 규정한다.
> ⚠ **값은 이 문서·커밋·로그·채팅 어디에도 출력하지 않는다.** 값은 Vercel 환경변수(또는 시크릿 매니저)에만 존재한다.

## 0. 회전 대상 시크릿 · 폭발 반경 요약

| 시크릿 | 폭발 반경(유출 시 가능한 공격) | 정기 회전 주기 | 병행 검증 창 |
|---|---|---|---|
| `PORTONE_API_SECRET` | **자금 유출** — 임의 결제 취소(환불), 빌링키 즉시결제 실행, 결제 조회 | 분기 1회 + 유출 의심 시 즉시 | 없음(즉시 전환, 아래 절차) |
| `PORTONE_WEBHOOK_SECRET` | 위조 웹훅 주입 → 가짜 결제/환불 이벤트로 지급·회수 유발 | 분기 1회 + 유출 의심 시 즉시 | **24h**(신·구 병행, 코드 지원) |
| `INTERNAL_API_SECRET` | admin→웹 내부 실행 경로 위장 → 환불·강제해지·주문동기화·대사 재실행·동결 예약취소 무단 호출 | 분기 1회 + 유출 의심 시 즉시 | 없음(양쪽 앱 동시 교체) |
| `CRON_SECRET` | 크론 무단 트리거 → hold/lot 만료·주문만료·갱신·대사를 임의 시점에 실행(대량 상태 전이) | 반기 1회 + 유출 의심 시 즉시 | 없음(즉시 전환) |
| `CREDIT_BIZNO_HMAC_PEPPER` | 팝빌 미터링 가명 키(bizNoRef) 역산 촉진(단, bizNo 는 이미 companies 에 평문 — 6.5 각주) | 회전 지양(과거 usage_events 의 bizNoRef 가 새 pepper 와 불일치) | 해당 없음 |

- 폭발 반경 최댓값은 `PORTONE_API_SECRET`(직접 자금 이동). 유출 최우선 대응 대상.
- `CREDIT_BIZNO_HMAC_PEPPER` 는 **회전하면 과거 가명 키와의 join 이 깨지므로 원칙적으로 고정**한다. 유출되어도 자금·인증 영향이 없고, bizNo 는 companies 에 이미 평문 저장(6.5, 별도 개인정보 검토 과제)이라 pepper 유출의 한계 손해가 작다. 교체가 불가피하면 신규 pepper 로 넘어가되 과거 usage_events.bizNoRef 는 구 pepper 기준임을 문서로 남긴다.

## 1. 정기 회전 절차(분기)

각 시크릿은 아래 공통 순서를 따른다. **웹훅 시크릿만 병행 검증 창을 쓴다(2절).**

1. 새 값을 발급(포트원 콘솔 재발급 / 무작위 32바이트 생성 등).
2. Vercel 환경변수(운영·프리뷰 양쪽)에 새 값을 설정.
   - `INTERNAL_API_SECRET` 은 **web·admin 두 프로젝트에 동일 값**으로 동시 반영해야 한다(불일치 시 admin 내부 호출이 401).
3. 재배포(환경변수 반영). 배포 직후 스모크: 결제 조회·환불 프리뷰·대사 재실행 각 1회로 정상 확인.
4. `.env.example` 상단 "시크릿 회전 이력" 주석에 `YYYY-MM-DD 시크릿명 사유` 한 줄 추가(값 금지).
5. 회전 이력을 팀 로그(정약용 서고 등)에 기록.

### CRON_SECRET / INTERNAL_API_SECRET / PORTONE_API_SECRET 즉시 전환 주의

- 병행 검증 창이 없다 → 새 값 배포 순간 구 값은 무효. 배포 전후 짧은 창에 in-flight 요청이 401 날 수 있으나 크론·내부 호출은 재시도로 흡수된다.
- `PORTONE_API_SECRET` 회전 시 포트원 콘솔에서 구 시크릿을 폐기하기 전에 신 시크릿 배포 완료를 먼저 확인한다(결제 경로 공백 방지).

## 2. 웹훅 시크릿 무중단 전환(24h 병행 검증 창)

코드가 신·구 두 시크릿 병행 검증을 지원한다(`apps/web/src/lib/server/payments/portoneWebhook.ts` — `PORTONE_WEBHOOK_SECRET` → `PORTONE_WEBHOOK_SECRET_PREVIOUS` 순으로 시도, 하나라도 통과하면 인정).

1. **T0**: 포트원 콘솔에서 웹훅 시크릿을 새 값으로 재발급.
   - `PORTONE_WEBHOOK_SECRET_PREVIOUS` = (구 값)
   - `PORTONE_WEBHOOK_SECRET` = (신 값)
   - 재배포. 이 시점부터 신 값 서명은 물론, 포트원이 아직 구 값으로 서명해 재전송하는 이벤트(최대 24h 재시도)도 계속 검증된다.
2. **T0 ~ T0+24h**: 포트원 재전송 주기(24h)가 소진될 때까지 병행 유지. 웹훅 inbox(11.5)에 서명 실패(401)가 없는지 관찰.
3. **T0+24h 이후**: `PORTONE_WEBHOOK_SECRET_PREVIOUS` 를 **비우고** 재배포. 구 시크릿 검증 창을 닫는다.

## 3. 유출 대응 절차(의심 즉시)

우선순위는 폭발 반경 순서(`PORTONE_API_SECRET` > 웹훅/내부 > 크론).

1. **즉시 회전**: 유출 의심 시크릿을 1절(웹훅은 2절) 절차로 즉시 새 값으로 교체. 포트원 콘솔에서 구 API 시크릿 폐기.
2. **전수 대조(PORTONE_API_SECRET 유출 시 필수)**: 포트원 콘솔에서 유출 의심 기간의 **모든 cancel(환불)·billing-key 결제 호출을 전수 조회**해 우리 원장·`credit_reconciliation_runs`(portone_orders scope)·`credit_audit_logs`(refund.executed 등)와 대조한다.
   - 우리 주문 테이블에 없는 결제/취소 = **고아**. 대사 scope 4 가 이미 최우선 경보로 리포트한다.
   - 불일치 건은 `credit_audit_logs` 에 조사 기록을 남기고, 부정 지급은 reversal 분개로만 정정한다(UPDATE 금지 — 14.3).
3. **대사 즉시 재실행**: admin 11.8 "수동 재실행" 또는 `POST /api/internal/credits/reconcile` 로 5 scope 즉시 실행해 현 정합 상태를 확정.
4. **동결 조치**: 부정 사용이 특정 지갑에 걸리면 11.4 에서 해당 지갑 freeze(예약결제 취소 연동).
5. **사후**: 유출 경로 분석, 회전 이력 기록, 필요 시 `INTERNAL_API_SECRET`·`CRON_SECRET` 동반 회전(연쇄 노출 차단).

## 4. 회전 시 절대 금지

- 시크릿 **값**을 커밋 메시지·PR·이슈·로그·이 문서에 출력하는 것.
- 포트원 콘솔에서 결제를 **직접** 취소하는 것(반드시 11.5 환불 경로 경유 — 7.4 shortfall 사고 방지, 12.7 운영 수칙).
- 크레딧 테이블 직접 UPDATE(트리거가 막고, `DISABLE TRIGGER`·`session_replication_role` 변경은 chainHash 재검증(14.2)에 걸리며 P7 pgaudit 알람 대상 — `docs/plans/2026-07-10-db-role-separation-pgaudit.md`).
