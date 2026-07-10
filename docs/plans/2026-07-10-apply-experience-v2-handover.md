# Apply Experience v2 구현 핸드오버 — 오케스트레이션 가이드

> **🟡 진행 상황 (매 세션 종료 시 이 블록만 갱신하고 커밋하라)**
> - 설계 문서: `docs/plans/2026-07-09-apply-experience-v2.md` (레드팀 v2 반영 완료) — **단일 진실(Single Source of Truth)**
> - 구현: **P0~P4 전 Phase 완료 (2026-07-10 단일 세션)** — P0(`a92c3d2`) · P1(`5b0afcc`) · P2a(`bb4c2d9`) · P2b(`aa964fa`) · P2c(`4767389`) · P3(`ae3c226`) · Gate3 재대조(`5981d40`) · P4(`42fdda2`). **P5·P6은 착수 금지 게이트 유지**(§3 — 채팅 v1 안정화 + trust gate 데이터 + 크레딧 matching_chat 등재 + 사용자 승인).
> - 검수 요약: 전 Phase 메인 직접 실측 검수(A~G). 발견·수정 결함 — P2b D2(suggested Unfilled 미보고)·D1(파일명↔스토리지키 매칭). 설계 정정 — v2.1(P2-9 교차참조)·v2.3(절단 고지·fieldContext 배치)·v2.4(manual류 제안 금지·basis 실재 검증, Gate3 재대조). 마이그레이션 0038·0039 적용, 백필 완료.
> - **잔여(다음 세션·사용자)**: ⓐ 브라우저 시각 확인 — P1 상세 / workspace (b)(c) / HWPX 미채움 안내 / P3 채팅(자동 오픈·인용 뱃지·프리필·generalNotice) / P4 제안 받기 (dev 서버는 사용자 소유) ⓑ 사다리 (a) 시각 확인은 리뷰팀 필드 승인 데이터 축적 후 ⓒ **배포는 사용자 합의 후**(P1~P4 한 묶음, CLAUDE.md Vercel CLI 절차 — 배포 전 Vercel 3환경에 신규 env 불요: 4종 전부 기본값 내장) ⓓ 알려진 한계 — basis 검증 v1(profile-basis 우회 가능, span 정렬 이월), 제안 usage가 채팅 세션 KPI에 소폭 혼입(P6-3에서 분리), 모바일 탭 전환 시 편집 상태 리셋(minor)
> - P2 검수 이력: P2b 검수 D에서 결함 2건 발견·수정(D2 suggested Unfilled 미보고 / D1 파일명↔스토리지키 불일치로 사다리 전부 (c) 강등 — surface `source_attachment` 표현이 공고별 혼재해 이중 후보 매칭으로 흡수). P2c에서 구 컴포넌트 5파일 삭제(대조표 29항목 전수 처분, 코드 참조 잔재 0), /preview 리다이렉트(?document= 보존·?surface= 드롭), 구 뷰어(DocumentPreviewView·FieldInspectorPanel)는 import 0 확인 후 메인이 직접 삭제
> - 잔여(비차단): ⓐ 사다리 (a) 시각 확인은 필드 검수 데이터 축적 후(DB에 fields_ready+연결필드 실데이터 0) ⓑ 모바일 탭 전환 시 편집 상태 리셋(minor) ⓒ P2-10 브라우저 검증(P1 상세·workspace (b)/(c)·HWPX 왕복)은 사용자 dev 서버 확인 대기
> - P2a 비고: core `normalizeLabel` export 승인. representative_name·biz_no는 CompanyProfile에 소스 부재로 시드 제외
> - P0 판정(검수 A 통과, 메인 재실행 검증): **ADR-4 = AI SDK 채택**(실측 `ai@7.0.19`, `sendSources:true` 필수, `providerMetadata.anthropic` 얕은 매핑 필요). ADR-2에 전처리 규약 추기(frontmatter 절단·본문성 archive 우선, PDF 재주입 불필요, 캐싱 실증). P0-3: **함초롬 폰트 미탑재 발견** → poc-execution 이슈 등재(별도 트랙, 라이선스 확인 필요)
> - 오픈 퀘스천(설계 §12) 사용자 답변: **확인 완료(2026-07-10) — 전건 제안 기본값 채택, 설계 §12에 결정 blockquote 추기.** P1-4 임시 페이지는 생략(P1·P2 한 배포 묶음)
> - 설계 문서 정정: ADR-5 처분 표의 이식 교차 참조 P2-7→P2-9 (v1 번호 잔재, §14 v2.1)
> - **병합 준비 완료(2026-07-10 후속 세션)**: 마이그레이션 번호 충돌 해소 — 이 브랜치 0038·0039를 **0039·0040으로 재부여**(`851ed93`, SQL·journal when 불변 → 공유 DB 재적용 없음, DB 이력 41행 그대로 확인) → **main(크레딧 P1~P7) 병합**(`40c234e`, 충돌 3건 해소: journal 수퍼셋·schema.ts 양 트랙 테이블 합류·HANDOFF-2026-07-10.md를 -apply-v2/-ai-credit로 분리) → 0040 스냅샷에 크레딧 스키마 폴딩(`a2a1870`). 검증: `pnpm db:generate` 빈 diff · `db:migrate` no-op · typecheck · 테스트 3종(5·4·8) · `build:web` 전부 통과
> - 작업 위치: worktree `/Users/ffgg/orca/workspaces/cunote/minimal` (브랜치 `coolwithyou/minimal`, env·빌드 독립 구성 완료 — 위임 프롬프트의 저장소 경로는 이 worktree를 쓸 것)
> - 마지막 갱신: 2026-07-10 (병합 준비 완료 세션 — 잔여: 브라우저 QA·배포 합의)

---

## 0. 이 문서의 사용법

- **대상**: 신규 세션의 메인 에이전트 (Fable 5). 이 문서는 사람이 아니라 너를 위해 쓰였다.
- **너의 역할**: 오케스트레이터. **직접 구현하지 않는다.** Phase별로 서브에이전트(Agent 도구)에 위임하고, 산출물을 설계 문서와 대조 검수하고, 커밋하고, 진행 상황 블록을 갱신한다. 직접 손대도 되는 것: 검수 중 발견한 사소한 수정(오타·import 누락 수준), 설계 문서·이 문서의 갱신(특히 P0 판정의 ADR-4/ADR-2 추기), 커밋.
- **읽기 순서**: ① 이 문서 전체 → ② 설계 문서 상단 blockquote + §2.1(재사용 모듈) + §10(제약) → ③ 현재 Phase가 참조하는 절(§3 표의 "설계 참조 절").
- **설계 문서가 규범이다**: 서브에이전트가 설계와 다르게 구현했으면 고치게 하라. 설계 자체가 틀렸음이 드러나면 **네가 설계 문서를 먼저 수정·커밋한 뒤** 구현을 다시 위임하라(구현이 설계를 조용히 앞서가는 것 금지). 레드팀이 검증한 규약(설계 §14의 B/M 항목)을 건드리는 변경은 §14에 사유를 추가.
- 유사 선례: `docs/plans/2026-07-10-ai-credit-implementation-handover.md` (크레딧 트랙 — 같은 오케스트레이션 체계). 두 트랙이 병렬 진행될 수 있으니 **schema.ts·contracts를 만지는 Phase는 상대 트랙과 절대 병행하지 말 것.**

## 1. 역할 분담

| 주체 | Agent 도구 파라미터 | 담당 |
|---|---|---|
| 메인 (Fable 5, 너) | – | 위임 프롬프트 작성, 산출물 검수(diff 리뷰 + 검증 명령 실행), 설계 정합 판정, P0 판정 확정과 설계 문서 추기, 마이그레이션 SQL 검토·`db:migrate` 실행, 커밋, 진행 상황 갱신, 사용자 소통 |
| Opus 서브에이전트 | `model: "opus"` | **P0 · P2a · P2c · P3 · P4** — 컨펌 게이트 불변식·상태 모델·스트리밍·보안 등 정합성 민감 구현 |
| Sonnet 서브에이전트 | `model: "sonnet"` | **P1 · P2b** — UI 컴포넌트·레이아웃 등 패턴 구현. 탐색·스팟 검증 보조 |

- 검수 보조: P1·P2b 완료 후 필요하면 `steve` 에이전트(React/Next.js 검증가)를 추가 투입할 수 있다. 디자인 검수에 `omd-designer-review`는 쓰지 말 것(부적합 판정 이력).
- 한 Phase에 구현 에이전트는 1개만. 병행은 **P1 ∥ P2a**만 허용(파일 집합이 겹치지 않음: `features/grant-overview/` vs `lib/server/documents/`+schema). 그 외 직렬.

## 2. 착수 전 사용자 확인 (첫 세션 시작 시 1회)

설계 §12 오픈 퀘스천을 아래 **제안 기본값**과 함께 AskUserQuestion으로 확인하라. 답을 받으면 설계 §12에 결정을 추기하고 진행. 사용자가 자리에 없으면 기본값으로 진행하되 진행 상황 블록에 "기본값 가정" 명시.

| # | 질문 | 제안 기본값 |
|---|---|---|
| 1 | Phase 1·2 배포 묶음 | **한 배포로 묶음** (P1-4 임시 페이지 생략 — 어색한 중간 상태 회피) |
| 2 | `CHAT_DAILY_TOKEN_BUDGET` | **300,000 토큰/일/회사** (Haiku 기준 최대 ~160원/일) |
| 3 | 미인증 회사의 workspace 접근 | **`requireCompanyAccess` 전제 유지** (프리뷰 공개는 후속 판단) |
| 4 | `/preview` 라우트 처분 | **workspace로 리다이렉트** |
| 5 | Phase 5(매칭 채팅) 착수 게이트 | **동의 — 채팅 v1 안정화 후 별도 착수** |

기타 전제 점검: ⓐ `.env.local`에 `ANTHROPIC_API_KEY` 존재(기존 사용 중) ⓑ 실공고 surface 4건(s-*)이 사다리 (a)/(b) 실측의 기반 — 리뷰팀 검수·backfill 확대는 이 트랙과 병행되는 기존 임계경로이므로 여기서 기다리지 않는다.

## 3. Phase → 위임 계획

실행 순서: **P0 → P1 → P2a → P2b → P2c → P3 → P4** (P1 ∥ P2a 병행 허용). P5·P6은 **착수 금지 게이트**(설계 §8 Phase 5 게이트 3조건 + 사용자 승인). 작업 내용·수용 기준은 설계 §8이 규범이고 아래는 위임 요약.

| Phase | 모델 | 설계 참조 절 | 핵심 산출물 | 검수 (§5) |
|---|---|---|---|---|
| P0 스파이크 | opus | §8-P0, ADR-2/3/4 | citations 표면화 판정 근거, markdown 인용 품질 실측, (선택)폰트 점검. **프로덕션 코드 무변경** | A |
| P1 미니멀 상세 | sonnet | §4.2, §8-P1 | `features/grant-overview/` + page.tsx 교체. 구 컴포넌트 보존 | B |
| P2a 상태 모델·서버 | opus | ADR-5(전체), §6.2, §6.3, §7.1, §8 P2-1~4·P2-7 | `field_answers` 마이그레이션+백필, `fieldAnswers.ts` 도메인+단위 테스트 4종, **기록 경로 4곳 처분**, PATCH 라우트, 프로필 시드 | C |
| P2b 워크스페이스 UI | sonnet | §4.3, §4.4, §8 P2-5·6·8 | workspace 라우트+3영역, 필드 패널·카드(컨펌 규약·undo·label 경고·position null), 하단 바+HWPX 합류 | D |
| P2c 구 기능 이식 | opus | §8 P2-9 | 기능 대조표 → DocumentDraftWorkspace 이식, `/preview` 리다이렉트, 구 파일 정리 | E |
| P3 채팅 코어 | opus | §6.1, §7.2, §7.3, ADR-6/7, §8-P3 | chat 테이블, 그라운딩 빌더(3분리 배치), 예산 집행, 스트리밍 라우트, ChatPanel, 필드 프리필 | F |
| P4 필드 제안 LLM | opus | §7.4, ADR-8, §8-P4 | field-suggestions 라우트+FieldCard 액션. **착수 전 메인이 CALIBRATION Gate 3 등재 항목 재대조**(설계 상단 blockquote) | G |

## 4. 위임 프롬프트 템플릿

서브에이전트 프롬프트는 아래 골격을 채워서 쓴다. **[공통 규칙 블록]은 매 위임마다 그대로 포함**하라 — 서브에이전트는 CLAUDE.md를 읽지만 세션 메모리는 없다.

```
cunote 저장소(/Users/ffgg/noten.works/cunote)에서 Apply Experience v2의 Phase {N}을 구현하라.

## 규범 문서 (구현 전 정독 필수)
- docs/plans/2026-07-09-apply-experience-v2.md 의 §2.1(재사용 모듈)·§10(제약) + {설계 참조 절 목록}.
- 이 문서가 유일한 규범이다. 문서와 다르게 구현하고 싶으면 구현하지 말고 사유를 보고하라.
- 신규 작성 전 §2.1의 재사용 모듈을 반드시 확인하라 — 이미 있는 것을 다시 만들면 반려된다.
- 특히 다음 규약은 레드팀 검증을 거친 것이라 임의 변경 절대 금지:
  {Phase별 핵심 규약 — 아래 채움값}

## 작업 범위
{설계 §8 해당 Phase 태스크 표 복사 + 이번 위임에서 제외할 것 명시}

## 완료 기준
{해당 태스크들의 수용 기준 복사}

## 공통 규칙 블록 (그대로 준수)
- 마이그레이션: schema.ts 수정 → pnpm db:generate → 생성 SQL 검토(기존 객체 재생성이 섞이면 SQL에서 제거하고 스냅샷만 유지)까지만. **db:migrate 실행은 메인 세션이 한다.** db:push 금지.
- packages/core 수정 후 반드시 `pnpm build:packages` (안 하면 dev 서버에 미반영, tsx 검증은 착시 발생).
- dev 서버를 직접 띄우지 마라 (사용자 소유). 실행 확인이 필요하면 보고서에 "사용자 확인 필요"로 남겨라.
- git 커밋 금지 — 커밋은 메인 세션이 한다. git add 절대 실행 금지. 작업 트리에 변경만 남겨라.
- 앱은 .env가 아니라 .env.local을 읽는다. 시크릿 값 출력 금지.
- API 라우트: runtime="nodejs", dynamic="force-dynamic", requireCompanyAccess(변이는 { permission: "write" }), 응답 ActionResult<T> + webActionError, 리소스 소유권 불일치는 404.
- Tailwind v4 + Turbopack에서 콤마 포함 arbitrary 클래스는 dev에서 미생성 — CSS 변수로 우회 (UI Phase 해당).
- 완료 선언 전 pnpm typecheck 통과 증거 필수. 증거 없는 "완료" 금지.

## 보고 형식
1) 변경 파일 전체 목록(생성/수정 구분), 2) 설계 문서 절 ↔ 구현 파일 매핑,
3) 실행한 검증 명령과 출력 요약(통과 증거 없이 완료 선언 금지),
4) 설계와 충돌했거나 판단이 필요했던 지점, 5) 사용자/메인 확인 필요 항목.
```

**Phase별 "임의 변경 금지 규약" 채움값**:

- **P0**: 스파이크 전용 — `scripts/spikes/` 밖의 프로덕션 코드·package.json 변경 금지(의존성 설치는 보고 후 메인 승인). 판정은 내리지 말고 근거만 수집(판정은 메인이 ADR-4에 추기).
- **P1**: §4.2 금지 조항(입력 요소 0·CTA 상한·편집기 금지) / 구 컴포넌트 삭제 금지(P2c에서 처분) / 로더 최적화 금지(순수 뷰 교체).
- **P2a**: ADR-5 기록 경로 4곳 처분 표(구 PATCH·create upsert·regenerate·download `answers` 폐기) / "suggested 절대 미포함" 불변식과 병합 규약(accepted·edited·dismissed 불변) / label 정규화 충돌 정책 / 백필·미백필 PATCH 정합 / §6.3 draft ensure(신규 빈 draft 경로 발명 금지 — `createGrantDocumentDraft` 재사용).
- **P2b**: §4.3 컨펌 규약(제안은 시각 구분, 확정 없이 문서 반영 금지, 필드 단위 undo) / 진행률 정의 / §4.4 사다리 (a)(b)(c) 전부 렌더 / 신뢰도 숫자 표시 금지(라벨만).
- **P2c**: 기능 대조표 작성·전 항목 이식 확인 전 구 파일 삭제 금지.
- **P3**: §7.3 배치 규약(system=정적만, documents=캐시 prefix, 가변은 dynamicContext — 캐시 적중 필수) / 원칙 P9 인젝션 방어 규칙 / ADR-6 예산 집행(당일 합산 SQL·어보트 시 업스트림 완주) / §7.2 세션 소유권(불일치 404)·matching 컨텍스트 400 / 리퓨절 규칙·인용 강제 / lesson은 approved만.
- **P4**: `basis` 없는 제안 미반환·미저장 / 결과는 `suggested`로만 저장(클라이언트 직접 쓰기 경로 금지) / citations와 structured output 분리(ADR-3) / labels ≤ 10 / 모델은 `CHAT_DRAFT_MODEL`.

## 5. Phase별 검수 체크리스트 (메인이 직접 수행)

매 Phase: 서브에이전트 보고 접수 → `git diff` 훑기 → 아래 확인 → 통과 시 **명시 스테이징으로 커밋** → 진행 상황 블록 갱신. 실패 항목은 동일 에이전트에 SendMessage로 수정 지시(새 에이전트 생성보다 컨텍스트 유지가 낫다).

**P0 (A)**: A1 스파이크 실행 출력에서 citations 파트 존재 여부를 직접 확인 A2 판정을 설계 ADR-4(필요시 ADR-2)에 추기·커밋 A3 프로덕션 코드 무변경 확인(`git status`).

**P1 (B)**: B1 `GrantOverviewView`에 input/textarea/편집기 없음(`grep -rn "input\|textarea" features/grant-overview/` 스팟) B2 주 CTA 1개·변환 상태별 라벨 분기 B3 `pnpm typecheck`·`pnpm build:web` B4 사용자 브라우저 확인 요청(dev 서버는 사용자 소유).

**P2a (C)**: C1 단위 테스트 4종 통과 실행(① suggested 미포함 ② **재생성 후 accepted 보존·suggested 미유출** ③ 미백필 PATCH 무유실 ④ label 중복 감지) C2 download route에서 `answers` body 수용 코드 제거 확인(grep) C3 `createGrantDocumentDraft`가 filledFields를 직접 덮지 않고 병합 경유하는지 diff 확인 C4 마이그레이션 SQL 직접 검토 후 메인이 `pnpm db:migrate` 실행 C5 백필 dry-run 출력 확인 후 --write.

**P2b (D)**: D1 사다리 (a)(b)(c) 각 상태 렌더(실공고 s-* + 미변환 공고로) D2 suggested 상태 값으로 HWPX 다운로드 → 해당 label이 `X-Cunote-Hwpx-Unfilled`에 있는지 실측 D3 undo 왕복이 PATCH 저장·복원되는지 D4 typecheck·build + 사용자 브라우저 확인.

**P2c (E)**: E1 기능 대조표의 전 항목(초안 편집·DOCX/MD/HTML·재생성·피드백)에 이식 확인 표기 E2 `/preview` 리다이렉트 동작 E3 구 파일 정리 후 참조 잔재 없음(`grep -rn "DocumentDraftWorkspace\|ApplySheetView" apps/web/src`).

**P3 (F)**: F1 그라운딩 배치 테스트(가변 정보가 캐시 prefix에 없음 assert) 통과 F2 실측: 2턴째 `cache_read_input_tokens > 0` F3 인젝션 스모크(공고 markdown에 지시문 심기 → 무시) F4 예산 초과 429 + 어보트 후 usage 기록 F5 타사 sessionId 404·matching 400 F6 "마감일" 질문에 인용 포함 응답 / 없는 정보에 리퓨절.

**P4 (G)**: G1 착수 전 CALIBRATION-TEMPLATE Gate 3 등재 항목(fill strategy 5종·evidence 정렬 validator·적합도 라벨 UX) 대조를 메인이 수행·기록 G2 제안→수정→반영→HWPX 반영 E2E G3 basis 없는 제안이 저장 안 됨(테스트 or 코드 확인) G4 suggestions 응답 값이 fieldAnswers 재조회와 일치(클라이언트 직접 쓰기 없음).

## 6. 사용자 준비물·액션 (해당 시점에 요청)

| 시점 | 필요한 것 |
|---|---|
| 첫 세션 시작 | §2 오픈 퀘스천 답변 (부재 시 기본값 진행) |
| P1·P2b·P2c·P3 검수 | dev 서버 기동 + 브라우저 확인 동행 (dev 서버는 사용자 소유) |
| P3 착수 전 | 없음 — `ANTHROPIC_API_KEY`는 기존 보유. 신규 env(`CHAT_MODEL`·`CHAT_DRAFT_MODEL`·`CHAT_DAILY_TOKEN_BUDGET`·`CHAT_GROUNDING_TOKEN_CAP`)는 기본값 내장으로 설계, `.env.example`에만 등재 |
| 배포 | Vercel CLI 배포는 CLAUDE.md 절차(VERCEL_CLI_TOKEN_FULL, 클린 worktree). 배포 시점은 사용자와 합의(§2-1 묶음 여부에 따름) |

## 7. 커밋·세션 규칙 (메인 전용)

- 커밋 단위: Phase당 1~3개(마이그레이션 / 서버 / UI 분리 권장). 메시지는 한국어, 본문에 변경 이유. **Co-Authored-By 금지.**
- **git add -A 절대 금지** — 병렬 세션(크레딧 트랙 등)의 미커밋 변경이 작업 트리에 섞여 있을 수 있다. 변경 파일을 명시 나열해 add하고, add와 commit은 한 Bash 호출에 붙인다.
- 컨텍스트가 길어지면 진행 상황 블록을 갱신·커밋한 뒤 세션을 끊어도 된다 — 다음 세션이 이 문서로 재개한다.
- Phase 완료 시 진행 상황 블록에: 완료 Phase, 커밋 해시, P0 판정 결과(ADR-4 채택안), 다음 작업, 미해결 이슈를 기록. `docs/plans/2026-07-02-poc-execution.md`의 본 트랙 항목도 상태 갱신.

## 8. 신규 세션 트리거 문장 (사용자용)

아래를 새 세션에 붙여넣으면 시작/재개된다:

```
docs/plans/2026-07-10-apply-experience-v2-handover.md를 읽고 절차대로 Apply Experience v2 구현 오케스트레이션을 시작해줘.
너는 메인 오케스트레이터(Fable)로서 직접 구현하지 말고, 핸드오버 §3의 Phase→모델 매핑대로 opus/sonnet 서브에이전트에 위임하고 §5 체크리스트로 검수·커밋해.
상단 진행 상황 블록에서 다음 Phase를 확인해서 이어가고(첫 세션이면 §2 오픈 퀘스천을 나에게 먼저 확인), Phase 완료마다 진행 상황 블록을 갱신·커밋해.
브라우저 확인이 필요한 시점에는 dev 서버 기동을 나에게 요청하고, 그 외에는 멈추지 말고 진행해.
```
