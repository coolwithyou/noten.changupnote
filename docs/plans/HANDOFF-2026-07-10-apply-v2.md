# HANDOFF — 2026-07-10 · Apply Experience v2 구현 완주 세션

> 새 세션 재개 프롬프트: `docs/plans/HANDOFF-2026-07-10-apply-v2.md 읽고 남은 작업 이어서 진행해줘`
> 트랙 자체의 오케스트레이션 재개는 `docs/plans/2026-07-10-apply-experience-v2-handover.md`의 트리거 문장(§8) 사용 — 상단 진행 상황 블록이 정본.

## 목표

공고 상세를 미니멀 "읽는 페이지"로 바꾸고, `/grants/[id]/workspace`에 HWP 프리뷰 + 필드 컨펌 채움 + 그라운딩 채팅 + 생성형 필드 제안을 구축하는 **Apply Experience v2** 트랙의 구현 오케스트레이션.
설계(단일 진실): `docs/plans/2026-07-09-apply-experience-v2.md` (v2.4까지 개정) · 절차: `docs/plans/2026-07-10-apply-experience-v2-handover.md`

## 작업 환경 (중요)

- **worktree**: `/Users/ffgg/orca/workspaces/cunote/minimal`, 브랜치 **`coolwithyou/minimal`** (메인 저장소 `/Users/ffgg/noten.works/cunote`와 별개 체크아웃)
- env 독립 구성 완료: 루트 `.env`(DB·ANTHROPIC_API_KEY·R2)·`.env.local`(Popbill·변환서버·OAuth)을 메인 저장소에서 복사해 둠. **`ANTHROPIC_API_KEY`는 `.env.local`이 아니라 `.env`에 있음** (tsx·dev 서버 모두 .env.local→.env 순 로드라 동작)
- DB는 메인 저장소와 **같은 원격 Supabase(`changupnote`)를 공유** — 격리 아님

## 완료된 것 (전부 커밋됨 · 워킹트리 클린)

P0~P4 전 Phase 완료. 모든 Phase는 opus/sonnet 서브에이전트 구현 + 메인 직접 검수(핸드오버 §5 체크리스트 A~G, 테스트·실측 전부 메인이 재실행) 후 커밋.

| 커밋 | 내용 | 검증 증거 |
|---|---|---|
| `d87ee8d` | §12 오픈 퀘스천 5건 확정(전건 기본값: 한 배포 묶음·예산 300k·requireCompanyAccess 유지·preview 리다이렉트·P5 게이트 동의) | 사용자 확인 |
| `a92c3d2` | P0 스파이크: AI SDK v7 citations 실측 → **ADR-4=AI SDK 채택**(`ai@7.0.19` 핀, `sendSources:true` 필수, `providerMetadata.anthropic` 매핑), ADR-2 추기(frontmatter 절단·본문성 archive 우선). 부수 발견: 변환서버 함초롬 폰트 미탑재(poc-execution에 이슈 등재) | 스파이크 재실행 3경로 확인 |
| `5b0afcc` | P1 미니멀 상세(`features/grant-overview/`, 5섹션·주 CTA 1) | 입력요소 0 grep·build |
| `bb4c2d9` | P2a `field_answers` 상태 모델 + 컨펌 게이트 서버 집행(기록 경로 4곳 처분). **0038 마이그레이션 적용 + 백필 10/10 완료(DB 반영됨)** | 단위 8종·DB 실측 |
| `aa964fa` | P2b workspace UI(3영역·사다리·FieldCard·하단 바). **검수 결함 2건 수정**: suggested가 Unfilled 헤더에 미보고 / 문서 파일명↔surface 스토리지키 불일치로 사다리 전부 (c) 강등 | D1~D3 실데이터 왕복 실측 |
| `4767389` | P2c 구 기능 이식(대조표 29항목)·`/preview`→workspace 리다이렉트·구 컴포넌트 5파일 삭제(-1,288줄) | 참조 잔재 0 grep |
| `ae3c226` | P3 채팅 코어: `POST /api/web/chat`(스트리밍·인용·리퓨절·인젝션 방어·예산 429·소유권 404), **0039 마이그레이션 적용됨**, ChatPanel·필드 프리필 | 실공고 실호출: 인용 응답·리퓨절·인젝션 무시·2턴째 cache_read=4805·타사 404·429 |
| `5981d40` | Gate 3 재대조(`docs/research/2026-07-10-gate3-field-suggestions-calibration.md`): manual류 제안 금지·basis 실재 검증 → 설계 v2.4 | 판정표 |
| `42fdda2` | P4 생성형 필드 제안(`field-suggestions` 라우트·FieldCard 제안 액션) | E2E: 제안→suggested→accepted→HWPX 실채움→교정률, 부정 케이스 2건, 원상 복구 |
| `6561580` | 진행 상황 최종 갱신 | — |

- 검증 스크립트(재실행 가능): `pnpm test:field-answers`(5) · `pnpm test:seed-profile-answers`(4) · `pnpm test:chat-grounding`(8) · `pnpm measure:chat-phase3`(+`CHAT_MEASURE_WITH_DB=1`, 실 haiku 호출) · `pnpm measure:field-suggest`(+`FIELD_SUGGEST_MEASURE_WITH_API=1`, 실 sonnet 호출)
- 워킹트리의 `apps/web/next-env.d.ts` 수정분은 dev/build가 오가며 자동 재작성되는 무해한 churn — 커밋 금지, 방치

## 남은 작업 (순서대로)

### 1. 브라우저 QA (사용자 동반 — dev 서버는 사용자 소유, 세션이 띄우지 말 것)

```bash
# 사용자가 실행
pnpm dev:web        # 127.0.0.1:4010 (+cloudflared 터널 자동)
```
확인 흐름: `/grants/24a1a417-b5ae-4814-82f2-d86b6d0359a2`(사다리 b: 프리뷰 15p+질문 카드) → 주 CTA → workspace → 채팅 자동 오픈·인용 뱃지·"이 항목이 뭐예요?" 프리필·일반 안내 스타일 → 서술형 필드 "제안 받기"(실 sonnet 과금) → HWPX 다운로드(미채움 안내에 "제안 미확정" 사유) / `/grants/66af6561-…`(사다리 c: 정직 고지+초안 편집기 폴백) / `/grants/[id]/preview` 리다이렉트. 수정 필요분은 핸드오버 §5 규약대로 해당 Phase 에이전트 재위임 또는 직접 소수정.

### 2. 브랜치 병합 준비 — ✅ 완료 (2026-07-10 후속 세션)

- 이 브랜치 0038·0039 → **0039·0040 재부여** (`851ed93`) — SQL·journal `when` 불변이라 공유 DB 재적용 없음(이력 41행 그대로 실측 확인)
- **main(크레딧 P1~P7 22커밋) 병합** (`40c234e`) — journal 수퍼셋(38y→39d→40l, when 단조 유지)·schema.ts 양 트랙 테이블 합류·이름 겹친 HANDOFF-2026-07-10.md는 `-apply-v2`/`-ai-credit`로 분리(원 경로는 안내 스텁)
- 0040 스냅샷에 크레딧 스키마 폴딩 (`a2a1870`) — drizzle generate가 산출한 합류 스냅샷(71테이블)을 0040 자리에 id/prevId 보존해 폴딩, 0039 스냅샷 prevId는 0038y로 재연결
- 검증: `db:generate` 빈 diff · `db:migrate` no-op · typecheck · 테스트 3종(5·4·8) · `build:web` 통과

### 3. 배포 (사용자 합의 후, P1~P4 한 묶음)

- 신규 env 불요(4종 전부 기본값 내장, `.env.example`에만 등재). 단 Vercel 프로덕션에 `ANTHROPIC_API_KEY` 존재 여부는 배포 전 확인 필요(채팅·제안이 사용)
- CLAUDE.md 절차: `VERCEL_CLI_TOKEN_FULL` 토큰 + HEAD 커밋 클린 worktree에서 `vercel deploy --prod --scope noten`

### 4. 후속 게이트 (착수 금지 유지)

- **P5 매칭 채팅**: 게이트 3조건(채팅 v1 프로덕션 안정화·trust gate needs_* 실데이터·크레딧 문서에 `matching_chat` 등재) + 사용자 승인
- **P6**: 크레딧 결합(P6-3 — usage 계량을 `withCreditMetering`으로 재배선) 등. AI 크레딧 트랙은 병렬 세션에서 P1~P7 구현 완료 상태(메모리 참조)
- 사다리 (a) 시각 확인: 리뷰팀이 실공고 4건(s-*) 필드 승인 후 가능(현재 DB에 fields_ready+연결필드 0건)

## 검증 체크리스트 (완료 판정)

- [ ] 브라우저 QA 흐름 전체 통과 (위 1)
- [x] 마이그레이션 번호 충돌 해소 후 `pnpm db:generate`가 빈 diff (2026-07-10 후속 세션)
- [x] 병합 후 `pnpm typecheck` · `pnpm build:web` · 테스트 3종 통과 (동일 세션)
- [ ] 프로덕션 배포 + 실공고 1건에서 채팅 인용 응답 확인
- [x] `docs/plans/2026-07-10-apply-experience-v2-handover.md` 진행 상황 블록 갱신·커밋 (동일 세션)

## 주의 / 함정

1. ~~⚠️ 마이그레이션 0038 번호 충돌~~ → **해소 완료** (위 "남은 작업 2" 참조). 실측으로 정정된 사실: 크레딧 0038도 DB 적용 완료였고(`when=1783625364223`, 이 브랜치 0038보다 먼저 생성이라 재부여 후에도 when 단조 유지), drizzle-kit migrate의 실제 판정은 해시가 아니라 **journal `when` 타임스탬프 기준**(DB의 마지막 `created_at`보다 새 것만 적용) — 어느 쪽이든 SQL·when 불변이면 재적용되지 않는다.
2. **DB 공유**: 이 worktree의 마이그레이션·백필은 이미 공유 DB에 반영됨. 병렬 세션(크레딧 트랙)도 같은 DB에 적용했을 수 있음 — 이변 시 병렬 세션 소행 의심(메모리 규칙).
3. **surface `source_attachment` 표현 혼재**(실측): 공고에 따라 R2 스토리지 키 또는 원본 파일명. workspace 매칭은 이중 후보로 흡수했지만, 신규 코드가 이 컬럼을 쓸 때 같은 함정 주의. 정본 매핑은 `grant_attachment_archives`(filename→storage_key).
4. **세션 리밋으로 서브에이전트 사망 시**: `git status`로 부분 변경 확인(P2c 사례에선 무변경) 후 동일 프롬프트 재위임하면 됨.
5. **실측 스크립트는 실 API 과금**: measure 2종은 haiku/sonnet 실호출(각 1회 실행에 수십 원 미만). `CHAT_DAILY_TOKEN_BUDGET` 기본 300k/일/회사라 반복 실행 시 당일 예산을 소모함(테스트 후 스크립트가 usage 원상 복구하긴 함).
6. **알려진 한계(후속 후보)**: basis 실재 검증은 announcement 유래만(모델이 profile-basis로 우회 가능 — span 정렬 validator는 Gate 3에서 명시적 이월) / 제안 usage가 당일 채팅 세션 행에 합산되어 세션 KPI에 소폭 혼입(P6-3에서 분리) / 모바일 탭 전환 시 편집 상태 리셋(minor).
7. **함초롬 폰트 미탑재**(변환서버 Docker — P0-3 발견): 레이아웃 밀림 리스크, `docs/plans/2026-07-02-poc-execution.md`에 이슈 등재됨. HCR 라이선스 확인 필요한 별도 트랙.

## 실행 중 백그라운드 작업

없음 — 모든 서브에이전트 완료, 워킹트리 클린(위 next-env.d.ts churn 제외).
