# HANDOFF — 공모 딥분석 실험실 (2026-07-18)

> 🟡 **진행 상황**: 실험실 구현·강화·검수 시트·집계 CLI(f4c542a) + **검수 UX 전면 개선(83de765)**까지 커밋 완료.
> 현재 블로커는 단 하나 — **사용자(창업자)의 검수 데이터가 아직 0건**이라 통과 판정을 못 내린 상태.
> 검수가 저장되는 즉시 `pnpm lab:aggregate` 한 방으로 집계·판정이 나온다.
> UI가 친절해졌다: 공고 카드의 **"최신 런 검수하기"** 버튼 하나로 검수 탭까지 바로 이동하며,
> 판정 기준·통과 기준(GATES)·검수 요령이 검수 탭 상단 안내에 전부 있다.

## 목표

기존 코어 방향("공모는 가볍게 수집, 사용자 데이터를 깊게 수집해 매칭")을 뒤집어,
**공고문 전문(구조화 필드 + 첨부 HWP markdown)을 Opus로 딥분석해 22축 자격요건과 정성적
방향성을 채우면 매칭이 좋아진다**는 가설을 검증한다. 근거가 된 진단은
`docs/research/2026-07-13-매칭시스템-현황평가.md`(공고 측 기계판정 가능률 ~40%가 병목).
검증 도구는 dev 전용 실험실 페이지 `/dev/analysis-lab` (production 404, DB read-only).

## 완료된 것 (전부 main 커밋, push 안 됨)

| 커밋 | 내용 |
|---|---|
| 255e996 | 실험실 본체 — 서버 `apps/web/src/lib/server/analysis-lab/`(cohort/input/extractor/diff/run-store/analyze/smoke) + API `apps/web/src/app/api/dev/analysis-lab/{cohort,analyze,run}` + UI `apps/web/src/app/dev/analysis-lab/` · `apps/web/src/features/dev/analysis-lab/`(공유 계약 contract.ts 포함). react-markdown/remark-gfm은 이 dev 페이지 전용 |
| 8c97163 | 강화 — Anthropic stop_reason 판별(max_tokens/refusal)·429/500/529 1회 재시도, 입력 캡·첨부 로드실패의 모델 고지, diff false 화이트리스트(nationwide만), span 검증 "같은 줄" 폴백, runId 랜덤 접미, 런 목록 promptVersion 표기. 자체 리뷰 3건 + Codex(gpt-5.5 xhigh) 리뷰 5건 반영 |
| 9ff7ce7 | 검수 시트 — 런 상세 "검수" 탭: criterion별 4판정(정확/수정/오류/판단불가)+사유, 제안 없는 축 확인(없음/누락+서술), 사람 이메일 강제(AI 라벨러 식별자 서버 400). 저장은 런 옆 `<runId>.review.json`(덮어쓰기 허용·createdAt 보존), 런 목록 "검수됨" 표시 |
| f4c542a | 집계 CLI — `pnpm lab:aggregate`: 검수 파일 전수 스캔 → 정밀도·재현율·커버리지·비용 집계 + 통과 기준 5종 자동 판정 |
| 83de765 | 검수 UX 전면 개선 — 사용 순서 가이드·검수 진행 보드(n/3)·원클릭 "최신 런 검수하기"(검수된 런 우선)·검수 탭 안내(판정 기준 6종+GATES 5종, contract.ts 로 단일화)·고정 저장 바(진행률·다음 미판정)·누락 사유 필수 검증·keepMounted·beforeunload. 멀티에이전트 리뷰 확정 결함 6종 수정: 분석 완료 시 미저장 초안 파괴 차단, aggregate 공고당 최신 1건 dedupe(이중 계상 방지), 실패 런 검수 3중 차단(UI·서버 400·집계), runLoading 잔류, maxLength 선차단, sticky-overflow |

**실측 검증 완료** (6개 공고 8런, `spike-out/analysis-lab/`에 JSON — gitignore 대상):
- 식품 해외인증(본문 61KB): 현행 DB 0건 → **16건**, 근거 인용 검증 16/16, $0.37/103초
- 원스톱 지원센터(13KB): 1건 → 10건(9/10), $0.19/66초
- 통합공고(209KB, 508개 사업): 모델이 "정보성 카탈로그·하위 위임"으로 정확 판별(오염 없음), $0.64
- 얇은 공고(포스터뿐, v1): 4~5건 수준 → **본문 두께가 곧 수확량**
- 신규 축 제안 반복 수집: team_size(2회), support_amount_cap류(2회), 사회적경제조직 유형 등
- 인프라 검증: typecheck·드리프트 스캔 0건, 검수 API 실동작(PUT 저장/GET 회수/사람 이메일 강제 400/제안 있는 축 400)

**통과 기준(aggregate.ts의 GATES 상수로 확정)**: 엄격 정밀도(correct) ≥80% · 치명 오류율(wrong)
≤10% · 공고당 누락 ≤1건 · 커버리지(사람 확정 B ÷ 현행 A) ≥1.5x · 공고당 비용 ≤$1.

## 남은 작업 (순서대로)

1. **[사용자만 가능] 검수 수행** — dev 서버는 사용자가 직접 기동(`pnpm dev:web`, 127.0.0.1:4010).
   `/dev/analysis-lab` → 공고 카드의 **"최신 런 검수하기"** 버튼 클릭(83de765부터 런 선택→검수
   탭→자동 스크롤까지 한 번에 됨) → 이메일(sw@ba-ton.kr) 입력 → 항목별 판정(기준은 검수 탭 상단
   "검수 안내" 참조) → 하단 고정 바의 **"검수 저장"** → "마지막 저장" 시각 확인.
   진행 상황은 페이지 상단 "검수 진행" 보드(n/3)로 확인. 탭이 안 보이면 강력 새로고침(⌘⇧R).
   현 코호트 3건(통합공고 1e7f6fd6 / 식품 a9ea9a64 / 원스톱 1bc6af52)만 UI 접근 가능.
2. **집계·판정** (LLM·DB 불필요, 파일만 읽음):
   ```bash
   pnpm lab:aggregate
   ```
   공고별 상세 + 종합 지표 + 게이트 5종 판정(🟢통과/🟡조건부/🔴미달)이 출력된다. 검수 0건이면 exit 1.
3. **판정 문서화** — 결과를 `docs/research/2026-07-18-공모딥분석-검수집계-판정.md`로 작성·커밋
   (연구 문서는 한글 파일명 규칙, CLAUDE.md). 소표본 주의 문구 포함할 것.
4. **통과 시 후속 트랙 착수** (별도 계획 수립 필요):
   - 층화 확대 실험(30~100건) 설계 — 코호트 선정 로직은 이미 본문성 우선(cohort.ts)
   - 검수 결과 → golden_set 승격 트랙(DB 쓰기 — 실험실 밖 설계 필요)
   - 통합공고류 "개별 공고로 분해" 처리 검토(딥분석이 announcement_type 신호를 이미 산출)
   - 신규 축 제안 반복 집계 → 축 승격 판단(복잡도 상한 경고 유의, 현황평가 §128)
5. (선택) 커밋 4개 push 여부 사용자 확인.

## 검증 체크리스트

- [ ] `ls spike-out/analysis-lab/*/*.review.json` ≥ 3건 (현 코호트 3건 검수)
- [ ] `pnpm lab:aggregate` 가 게이트 5종 판정을 출력하고 종합 판정(🟢/🟡/🔴)이 나옴
- [ ] 판정 연구 문서가 docs/research/ 에 한글 파일명으로 커밋됨
- [ ] (후속 착수 시) 확대 실험 계획이 docs/plans/ 에 생성됨

## 주의 / 함정

- **Opus 4.8 파라미터**: temperature/top_p/top_k/thinking 을 보내면 400 — extractor.ts가 의도적으로
  미전송. 수정 시 이 불변식을 깨지 말 것. 모델·한도는 env(ANALYSIS_LAB_MODEL/_MAX_TOKENS/_TIMEOUT_MS/_INPUT_CHAR_CAP) 오버라이드.
- **dev 서버는 사용자 소유** — 세션이 백그라운드로 띄우지 말 것(프로젝트 규칙). API 검증은 사용자가
  띄운 127.0.0.1:4010에 curl.
- **ANTHROPIC_API_KEY는 모노레포 루트 .env**에 있음(.env.local 아님) — Next dev 런타임은
  analyze.ts의 loadMonorepoEnv 보강으로 해석. 키 값 출력 금지.
- **코호트 재선정 주의**: 재선정하면 이전 공고 카드가 사라져 그 런들은 UI에서 접근 불가(런 파일은
  디스크에 남음). 검수 중에는 재선정하지 말 것.
- **spike-out*/ 는 gitignore** — 런·검수·코호트 파일은 커밋되지 않는다. 삭제도 하지 말 것(불변 원칙,
  검수 파일만 덮어쓰기 허용).
- **분석 API는 동기 수 분** — 클라이언트 fetch에 타임아웃 걸지 말 것(AnalysisLab.tsx에 주석).
- **집계 스크립트의 커버리지 게이트**: 현행 A criteria가 0건인 공고만 검수하면 분모 0으로 ∞ 처리됨 —
  3건 이상 섞어 검수하면 자연 해소.
- **검수자 이메일**: AI 라벨러 패턴(prelabel/opus/claude/gpt 등 포함)은 서버가 400으로 거부 —
  Gate 1 순환성 가드와 동일 원칙. 골든 승격 트랙에서도 이 원칙 유지.
- 배경 지식이 더 필요하면: 메모리 `notice-deep-analysis-lab-track`, 마스터 설계 17·18장,
  `docs/research/2026-07-13-매칭시스템-현황평가.md`(피벗 근거), Codex 리뷰는 8c97163 커밋 메시지 참고.

## 백그라운드 작업

없음 — 모든 워크플로우·분석·Codex 리뷰 완료 상태.
