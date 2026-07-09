# AI 크레딧 시스템 구현 핸드오버 — 오케스트레이션 가이드

> **🟡 진행 상황 (매 세션 종료 시 이 블록만 갱신하고 커밋하라)**
> - 설계 문서: `docs/plans/2026-07-09-ai-credit-system.md` (레드팀 반영 완료, 커밋 b3a1b5f) — **단일 진실(Single Source of Truth)**
> - 구현: **미착수. 다음 작업 = P1 (원장 코어)**
> - 사용자 준비물 상태: 포트원 계정·채널 키 미확보 (P3 착수 전 필요 — §5)
> - 마지막 갱신: 2026-07-10 (핸드오버 문서 작성 세션)

---

## 0. 이 문서의 사용법

- **대상**: 신규 세션의 메인 에이전트 (Fable 5). 이 문서는 사람이 아니라 너를 위해 쓰였다.
- **너의 역할**: 오케스트레이터. **직접 구현하지 않는다.** Phase별로 서브에이전트(Agent 도구)에 위임하고, 산출물을 설계 문서와 대조 검수하고, 커밋하고, 진행 상황 블록을 갱신한다. 직접 손대도 되는 것: 검수 중 발견한 사소한 수정(오타·import 누락 수준), 설계 문서·이 문서의 갱신, 커밋.
- **읽기 순서**: ① 이 문서 전체 → ② 설계 문서의 0장(문서 사용법)·15장(Phase 분할) → ③ 현재 Phase가 참조하는 장(§2 표의 "참조 장").
- **설계 문서가 규범이다**: 서브에이전트가 설계와 다르게 구현했으면 고치게 하라. 설계 자체가 틀렸음이 드러나면 **네가 설계 문서를 먼저 수정·커밋한 뒤** 구현을 다시 위임하라 (구현이 설계를 조용히 앞서가는 것 금지). 설계 변경이 레드팀이 검증한 규약(17장)을 건드리면 변경 사유를 17.4에 추가.

## 1. 역할 분담

| 주체 | Agent 도구 파라미터 | 담당 |
|---|---|---|
| 메인 (Fable 5, 너) | – | 위임 프롬프트 작성, 산출물 검수(diff 리뷰 + 검증 명령 실행), 설계 정합 판정, 커밋, 진행 상황 갱신, 사용자 소통 |
| Opus 서브에이전트 | `model: "opus"` | **P1·P2·P3·P4·P7** — 원장 트랜잭션·결제·동시성·보안 등 정합성 민감 구현 |
| Sonnet 서브에이전트 | `model: "sonnet"` | **P5·P6** — UI 페이지·ops 페이지 등 패턴 반복 구현. 탐색·스팟 검증 보조 |

- 검수 보조: P5·P6 완료 후 필요하면 `steve` 에이전트(React/Next.js 검증가)를 추가 투입할 수 있다. 디자인 검수에 `omd-designer-review`는 쓰지 말 것(부적합 판정 이력).
- 한 Phase에 구현 에이전트는 1개만. 병렬 투입은 P6(P1 완료 후 P2~P4와 병행 가능)에만 허용 — 단, 같은 파일(schema.ts, contracts)을 만지는 Phase는 절대 병행하지 않는다.

## 2. Phase → 위임 계획

실행 순서와 의존성: **P1 → P2 → P3 → P4 → P5 → P7** (직렬). P6은 P1 완료 후 병행 가능하되 §1의 파일 충돌 주의. 각 Phase의 작업 내용·DoD는 설계 문서 15장이 규범이고, 아래 표는 위임 요약이다.

| Phase | 모델 | 설계 참조 장 | 핵심 산출물 | 검수 포인트 (§4) |
|---|---|---|---|---|
| P1 원장 코어 | opus | 0, 2, 3, 4(전체), 5(전체), 14.2, 15-P1 | 스키마 13테이블+마이그레이션(수동 SQL 포함), core credits 도메인, 리포지토리 4단계, 가입 보너스 훅, 시드, verify 스크립트 | A1~A6 |
| P2 과금 파이프라인 | opus | 5.3, 6(전체), 9.1(조회 API), 15-P2 | withCreditMetering, hold cron, 팝빌 미터링, 운영 배치 LLM 3곳 래핑, balance/ledger/usage API+DTO | B1~B4 |
| P3 충전 결제 | opus | 7(전체), 9.1(결제 API), 10.2, 15-P3 | portone.ts, checkout/complete/webhook/주문 cron, /credits 페이지, 잔액 위젯 | C1~C4 |
| P4 플랜 정기결제 | opus | 3.1, 8(전체), 9.1(플랜 API), 10.1, 15-P4 | 구독 시퀀스, 갱신 웹훅+안전망 cron, 재시도, /pricing, /billing 크레딧 섹션 | D1~D4 |
| P5 사용량 UI | sonnet | 9.1, 10(전체), 15-P5 | /account/usage 3탭+CSV, 사전 견적 UI, 부족 모달, 차감 토스트 | E1~E3 |
| P6 Ops | sonnet | 9.3, 11(전체), 12.2~12.3, 15-P6 | admin 페이지 8종+API, requireAdminRole, member.viewed 감사 | F1~F3 |
| P7 보안·대사 마감 | opus | 12(전체), 14(전체), 15-P7 | 대사 cron 5 scope+리포트, chainHash 검증, 시크릿 런북, 역할 분리 계획 | G1~G3 |

## 3. 위임 프롬프트 템플릿

서브에이전트 프롬프트는 아래 골격을 채워서 쓴다. **[공통 규칙 블록]은 매 위임마다 그대로 포함**하라 — 서브에이전트는 CLAUDE.md를 읽지만 세션 메모리는 없다.

```
cunote 저장소(/Users/ffgg/noten.works/cunote)에서 AI 크레딧 시스템의 Phase {N}을 구현하라.

## 규범 문서 (구현 전 정독 필수)
- docs/plans/2026-07-09-ai-credit-system.md 의 0장 + {참조 장 목록}장 + 15장의 P{N} 절.
- 이 문서가 유일한 규범이다. 문서와 다르게 구현하고 싶으면 구현하지 말고 사유를 보고하라.
- 특히 다음 규약은 레드팀 검증을 거친 것이라 임의 변경 절대 금지:
  {Phase별 핵심 규약 — §2 표의 검수 포인트에 대응하는 설계 절 나열}

## 작업 범위
{15장 P{N}의 작업 목록 복사 + 이번 위임에서 제외할 것 명시}

## 완료 기준 (DoD)
{15장 P{N}의 DoD 복사}

## 공통 규칙 블록 (그대로 준수)
- 마이그레이션: schema.ts 수정 → pnpm db:generate → 생성 SQL 검토(기존 객체 재생성이 섞이면 SQL에서 제거하고 스냅샷만 유지) → pnpm db:migrate. db:push 단독 사용 금지.
- CHECK 제약·트리거·partial unique index는 drizzle이 못 만드니 생성된 마이그레이션 SQL에 수동 추가 (설계 4장의 각 절 참조).
- packages/core 수정 후 반드시 `pnpm --filter @cunote/core build` (안 하면 dev 서버에 미반영, verify는 tsx라 착시 발생).
- dev 서버를 직접 띄우지 마라 (사용자 소유). 실행 확인이 필요하면 보고서에 "사용자 확인 필요"로 남겨라.
- git 커밋 금지 — 커밋은 메인 세션이 한다. 작업 트리에 변경만 남겨라. git add 절대 실행 금지.
- 앱은 .env가 아니라 .env.local을 읽는다.
- API 응답은 ActionResult<T> + webActionError, DTO는 packages/contracts/src/dto.ts에 추가하고 openapi.ts 동기화.
- 리포지토리 추가는 4단계: core ports → drizzle 구현 → runtime mock → serviceData 등록.
- Tailwind v4 + Turbopack에서 콤마 포함 arbitrary 클래스는 dev에서 미생성 — CSS 변수로 우회 (UI Phase 해당).

## 보고 형식
1) 변경 파일 전체 목록(생성/수정 구분), 2) 설계 문서 절 ↔ 구현 파일 매핑,
3) 실행한 검증 명령과 출력 요약(테스트·verify — 통과 증거 없이 완료 선언 금지),
4) 설계와 충돌했거나 판단이 필요했던 지점, 5) 사용자/메인 확인 필요 항목.
```

**Phase별 "임의 변경 금지 규약" 채움값** (템플릿의 중괄호에 넣을 것):

- **P1**: 5.2 잔액 변이 단일 진입점 + lotSelection 모드 / 4.3 멱등 키 표·chainHash·append-only 트리거 / 4.13 RLS 실측 의무와 분기표 / 4.1·4.2의 CHECK 제약
- **P2**: 5.3 capture는 hold 상태 비의존(B3) + lot 만료 유예(M8) / 6.2 d-2 토큰 선기록 + max_tokens 바인딩 / 6.3 요율 없으면 호출 거부 / 6.5 팝빌 무과금·HMAC / 13.1 회사 스코프 보너스 상한
- **P3**: 7.2 verifyAndGrant 상태 가드 + 소유권 검증 분리 / 7.3 웹훅 raw body 검증·inbox 멱등·payloadDigest만 저장 / 7.4 환불 이원 정책 + targetLotIds
- **P4**: 3.1·8.5 "상태 전이 첫 단계 = 예약 전부 취소" / 8.2 incomplete 선생성 + 예약 등록 시 주문 선생성 / 4.3 plan:{orderId} 키 / 8.3 안전망 cron 분기(SUCCEEDED면 즉시결제 금지) / 8.4 재시도 한 번에 하나
- **P5**: 10.5 사전 견적 의무 + available 표시 통일 / 10.3 토큰 기본 숨김·원화 환산
- **P6**: 12.3 role 매트릭스 / 9.3 nonce 멱등·자기 지급 차단·owner 승인 큐·goodwill 한도 / member.viewed 감사
- **P7**: 14.1 대사 5 scope / I1~I10 전체 / 12.7 런북·운영 수칙

## 4. Phase별 검수 체크리스트 (메인이 직접 수행)

매 Phase: 서브에이전트 보고 접수 → `git diff` 훑기 → 아래 항목 확인 → 통과 시 **명시 스테이징으로 커밋** → 진행 상황 블록 갱신. 하나라도 실패하면 동일 에이전트에 SendMessage로 수정 지시 (새 에이전트 생성보다 컨텍스트 유지가 낫다).

**P1 (A)**: A1 `pg_roles` 실측 결과가 보고·기록됐는가 A2 마이그레이션 SQL에 CHECK·트리거·partial index 수동 추가분이 실제로 있는가 A3 `pnpm vitest run packages/core/src/credits` 통과 A4 verify-credit-invariants 출력 완주(프로세스 미종료는 기존 현상 — 출력으로 판정) A5 wallet/lot/ledger를 직접 UPDATE/INSERT하는 코드가 단일 진입점 밖에 없는가(`grep -rn "creditWallets\|creditLots\|creditLedger" apps/web/src --include="*.ts" | grep -v repositories` 등으로 스팟 확인) A6 RLS 검증 3종(4.13) 결과 확인

**P2 (B)**: B1 동시성 테스트(16.2 — hold 5개 병렬 1개 성공, 동일 키 병렬 1건) 통과 B2 팝빌 실호출 시 usage_events 적재 + creditsCharged=0 B3 core build 후 웹에서 심볼 해석되는가 B4 TTL 후 capture 테스트(B3 시나리오) 통과

**P3 (C)**: C1 paid 주문에 complete 재호출 → no-op 테스트 C2 웹훅 동일 webhookId 2회 → 1회 처리 C3 checkout 소유권(타 세션 paymentId → 404) C4 **사용자 액션**: 포트원 테스트 채널 E2E(결제→지급→콘솔 취소→회수)는 사용자와 함께 — 요청 목록을 만들어 사용자에게 전달

**P4 (D)**: D1 같은 날 구독→업그레이드 시 지급 2건(키 충돌 없음) 테스트 D2 업그레이드 코드 경로에 cancelSchedules 선행이 있는가(grep) D3 incomplete에서 결제 실패 → 재시도 가능 D4 안전망 cron의 3분기(SUCCEEDED/FAILED/미실행) 구현 확인

**P5 (E)**: E1 크레딧 소모 작업 시작 버튼 옆 견적 렌더 E2 402 → 모달 → /credits 흐름(사용자 수동 확인 요청) E3 사용 내역 기본 뷰에 토큰 컬럼 없음

**P6 (F)**: F1 role별 차단(viewer로 adjust 시도 → 403) F2 member 상세 열람 시 audit_logs에 member.viewed 행 F3 동일 nonce 재제출 → 분개 1건

**P7 (G)**: G1 대사 5 scope ok + 고의 변조(테스트 DB에서 ledger 행 UPDATE 시도→트리거, 트리거 끄고 변조→chainHash 검출) G2 verify 전체 + 16장 스위트 통과 G3 `.env.example`·README 갱신 확인

## 5. 사용자 준비물 (해당 Phase 착수 전에 사용자에게 요청)

| 시점 | 필요한 것 |
|---|---|
| P3 착수 전 | 포트원 V2 계정, storeId, API Secret, 토스페이먼츠 **단건결제** 테스트 채널 키, 웹훅 시크릿 + 웹훅 URL 콘솔 등록. `.env.local`에 7.1의 키 세팅 |
| P4 착수 전 | 토스페이먼츠 **빌링(정기)** 테스트 채널 키 (단건과 별도 MID) |
| P3·P4 검수 | 테스트 카드로 결제 E2E 동행 (C4, D 검수) |
| P5 검수 | dev 서버 기동 (dev 서버는 사용자 소유) |

## 6. 커밋·세션 규칙 (메인 전용)

- 커밋 단위: Phase당 1~3개 (스키마 / 도메인+리포지토리 / UI·API 분리 권장). 메시지는 한국어, 본문에 변경 이유. **Co-Authored-By 금지.**
- **git add -A 절대 금지** — 병렬 세션의 미커밋 변경이 작업 트리에 섞여 있다. 변경 파일을 명시 나열해 add하고, add와 commit은 한 Bash 호출에 붙인다.
- 컨텍스트가 길어지면 진행 상황 블록을 갱신·커밋한 뒤 세션을 끊어도 된다 — 다음 세션이 이 문서로 재개한다.
- Phase 완료 시 진행 상황 블록에: 완료 Phase, 커밋 해시, 다음 작업, 미해결 이슈(있으면)를 기록.

## 7. 신규 세션 트리거 문장 (사용자용)

아래를 새 세션에 붙여넣으면 재개된다:

```
docs/plans/2026-07-10-ai-credit-implementation-handover.md를 읽고 절차대로 AI 크레딧 시스템 구현 오케스트레이션을 시작해줘.
너는 메인 오케스트레이터(Fable)로서 직접 구현하지 말고, 핸드오버 §2의 Phase→모델 매핑대로 opus/sonnet 서브에이전트에 위임하고 §4 체크리스트로 검수·커밋해.
상단 진행 상황 블록에서 다음 Phase를 확인해서 이어가고, Phase 완료마다 진행 상황 블록을 갱신·커밋해.
사용자 준비물(§5)이 필요한 시점에는 멈추지 말고 그 전까지 가능한 Phase를 진행한 뒤 요청 목록을 정리해줘.
```
