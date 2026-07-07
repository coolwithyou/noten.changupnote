# PoC 실행 플랜 — 작성 가이드 (Gate 0~2 · Phase 1~2)

> **🟡 진행 상황 (2026-07-07 · 세션 10 종료 — HWPX 원본 양식 채움 트랙 Phase 0~2 완료)**
>
> 완료 (커밋 SHA):
>
> - ✅ `c2ef18f` 마스터 설계 보강 — PoC 관문화(17장), 지식 루프 질문-응답-전파(18장), 리뷰어 워크스페이스(9.8/9.9)
> - ✅ `c00c146` Phase 1 스키마 — `form_templates`/`grant_application_surfaces`/`document_artifacts` + fields/drafts 확장. **0025 마이그레이션 Supabase 적용 완료.** 스냅샷 드리프트(0018~0024) 청산
> - ✅ `72f9861` **Gate 0 통과** — LO 26.2+H2Orestart 0.7.13, 누적 60/60 렌더링 (작성형 30 + 변환실패10·무작위20). 채점 table 2.0/2, layout 1.6/2. 1차 렌더러 확정
> - ✅ `01cd85d` Phase 2 구현 계획 + Gate 1 파일럿 라벨 + CLAUDE.md(샌드박스 git 규칙)
> - ✅ `e3a296e` Phase 2 T1~T3 (`apps/conversion`: Dockerfile·convertDocument·quality) + 배치2 라벨
> - ✅ `b414264` Phase 2 T4~T6 (R2 업로드·큐·API — 실HWP 전구간 왕복 검증) + 배치3 라벨
> - ✅ `692683e` Phase 2 T7~T8 (웹앱 후크·폴링, 실DB 검증 후 정리) + 배치4 라벨 (PDF 10·DOCX 4)
> - ✅ Gate 1 사전 라벨 **45문서 1,579필드** 완료 (`spike-labels/doc*.json`, 기준서 규칙 1~10 확정)
> - ✅ `5ef6185` golden 적재 스크립트(`apps/web/src/lib/server/db/load-golden-field-maps.ts`, `pnpm load:golden:field-maps`) + 0026 `field_map` enum 마이그레이션 **Supabase 적용 완료**. 순환성 가드(AI 라벨러 거부 + 검수자 이메일 요구), 기본 dry-run, upsert 멱등. 현재 45문서 전부 미검수라 0건 적재가 정상
> - ✅ `a7a73f4` Phase 2 T9 (세션 2) — 실패 경로 3계층 테스트 49 assertion 실DB·실R2 통과 (`pnpm test:t9`). **큐 결함 수정**: sofficeTimeoutMs/maxBytes/maxPages가 convertDocument로 전달 안 되던 것 수정(src+미러). 상세는 `apps/conversion/README.md`
>
> - ✅ **리뷰어 워크스페이스 v1** (세션 3) — `/internal/review` 필드맵 검수 GUI (마스터 9.8 첫 슬라이스, 상시 운영). 0027 마이그레이션 적용, 라벨 45문서+이미지 343장 DB/R2 임포트 완료. 검수 확정=golden 승격. 스펙: `docs/plans/2026-07-03-reviewer-workspace-v1.md`. **정본이 DB로 전환됨** — spike-labels/ 파일은 임포트 소스
>
> - ✅ **배포 전 검증 완료** (세션 3 후반) — 리눅스 클린 빌드에서 `next build` 통과(선존 타입에러 2건 수정 포함), 프로덕션 서버 스모크로 게이트 404·mock 인증 검수 왕복(save→approve→unapprove) HTTP 레벨 통과, bbox 오버레이 규약 시각 검증. '확인 필요만' 필터 추가. 검수팀 가이드 `docs/review-team-guide.md`
> - ✅ `758c5b3` **v1.1 — 리뷰팀 첫 피드백 5건 반영** (세션 4): bbox 드래그 재작도·인앱 가이드(/internal/review/guide)·용어 한국어화·오버레이 클릭 선택·보류 토글+리뷰어 코멘트(0028 적용). **bbox 정교화 로드맵**은 v1 plan doc v1.1 섹션에 등재 (Gate 2 layout 엔진 → 골든 bbox 자동 스냅 + 확인 UI — Gate 2 이후 작업)
> - ✅ `f76ceca` **v2 — 질문 기반 검수 모드** (세션 4): "직관적이지 않다" 피드백에 검수 UX를 질문 카드 흐름으로 전환. 0029 질문 테이블(적용됨), LLM 사전 배치 생성 완료(45문서 1,965문항: question 150/quick_confirm 1,472/missing_sweep 343), applyMap 화이트리스트 검증, 질문 모드 기본+전문 모드 토글. **재생성 커맨드**: `pnpm generate:review-questions -- --regenerate --write` (라벨 대폭 수정 시)
>
> - ✅ **세션 5 (2026-07-03~04, 로컬 맥 첫 세션)** — ① 로컬 전환 체크리스트 완료: 34커밋 push·install·typecheck·build (conversion 선존 타입에러 수정 `97925d3`, lockfile 정비 `aa952aa`) ② `f879793` **Phase 2 T10 Cloud Run 배포 + 스모크 5/5** — `https://cunote-conversion-644631753751.asia-northeast3.run.app` (2Gi/2cpu, max-instances 1). 첫 실빌드 결함 3건 수정(빌드체인·JVM 탐지·**UTF-8 로케일=한글 파일명 HWP 렌더 불가**). 조직 DRS → `--no-invoker-iam-check`(앱 shared secret 인증), **run.app `/healthz`는 Google이 가로챔**(도달성은 `GET /`→앱 401). 상세: phase2 계획 12장 ③ `87da45a`+`f36081b` **[C] Gate 2 layout 어댑터 실행 인프라** — 외부 대조 델타(전제 4건 유지, kordoc→text parser 재분류) 후 어댑터 5종·0~1 정규화·러너/eval-cache·메트릭·0030(적용됨). kordoc 실측 31/45(후보 1,944건), Google Form Parser 실호출 검증(us 프로세서 프로비저닝, `.env.local`의 `GOOGLE_DOCAI_PROCESSOR`). 사용: `pnpm eval:layout -- --engine <name|all> --docs <ids|all> [--allow-paid] [--write]`. 상세·한계(kordoc batch4 14건 no_source): `docs/plans/2026-07-04-gate2-layout-adapters.md`
>
> - ✅ **세션 6 (2026-07-05)** — **[E] Phase 3 Viewer v1** (`docs/plans/2026-07-05-phase3-viewer.md`): 사용자용 `/grants/[grantId]/preview` + 이미지 프록시(`/api/web/grants/[grantId]/page-image/[...key]`, DB 소유검증) + §8.4 좌표계 공용 유틸(`lib/documents/bbox.ts`) + `features/document-viewer/` (오버레이·클릭 선택·inspector·줌·페이지 내비). 시드 스크립트 `pnpm --filter @cunote/web seed:preview-demo`(dry-run 기본, --write/--cleanup). typecheck·build·스모크·브라우저 시각 검증 후 시드 정리 완료. 병렬 세션 dirty 파일 0개 수정. **부수 수정**: `grantDocumentFields.ts`·`applicationPackageExport.ts`의 isUuid 정규식 버그(표준 UUID 전면 거부 — 실데이터 유입 시 formFields 빈 배열이 될 뻔) 수정. 진입 링크(ApplySheetView)는 병렬 세션 머지 후 소과제
>
> - ✅ **세션 7 (2026-07-05)** — **[F] Phase 4 후보 스키마·저장 계층·reconciliation 골격** (`docs/plans/2026-07-05-phase4-field-candidates.md`): NormalizedFieldCandidate를 packages/core로 정본화(layout-eval은 re-export, 회귀 12/12 무파괴), text parser 후보화, field_candidates 저장 계층(R2+document_artifacts 멱등), §8.6 reconciliation 순수 골격(11케이스, RECONCILE_THRESHOLDS 잠정), grant_document_fields 반영 경로(reconcile-v0)+fields_ready 전이. verify 실DB·실R2 왕복에서 **P3 뷰어 로더까지 assert** 후 cleanup 0건. 마이그레이션 없음. 잔여(엔진 종속부)는 Gate 2 측정 후: 어댑터 프로덕션 배선·pollConversions 연동·임계값 캘리브레이션·Vision LLM pass
>
> - ✅ **세션 8 (2026-07-05)** — **운영 지식 인제스천 v1** (`docs/plans/2026-07-05-ops-knowledge-ingestion.md` — 평가·계획 + Step 0~2 구현): 0031 마이그레이션(`knowledge_sources`·`review_lessons`, 적용됨), `pnpm ingest:knowledge` CLI(LLM 추출 + quote 실재 검증, dry-run 기본), lesson 인박스 `/internal/review/lessons`(승인·수정 후 승인·기각·철회, 충돌 409→force, 기존 검수 인증 가드 재사용). 파일럿: 립스1,2 PDF → lesson 23건 proposed(quote 100%)+비lesson 5건 적재, 승인 왕복 1건 검증. 주입 경로(Step 3)는 Phase 5/8과 정렬 예정
>
> - ✅ **세션 9 (2026-07-06)** — **지식 대시보드 v1** (`/internal/knowledge`): 축적 현황 시각화(지표·12주 추이·분포·재검토 임박) + GUI 인제스천(업로드→추출 실행→인박스, sha256 멱등·이중 클릭 방지·상태 전이 가드). 추출 코어를 `extraction.ts`로 공용화(CLI 회귀 확인), 집계 계층 `knowledgeDashboardData.ts`. 마이그레이션 없음
> - ✅ **세션 9 후반 (2026-07-06)** — **lesson 파일럿 검수 완료**(운영팀, 23건 전량 approved) + **Step 3 첫 슬라이스**: `lessonContext.ts` 매칭 모듈(+`buildLessonPromptBlock` Phase 5 선행) → `/grants/[grantId]` "작성 유의사항" 패널. 실측: LIPS/TIPS 공고 307건 대상, 포스트팁스 22/23(보수적 스코핑 검증)·negative 0. 한계·후속은 계획 문서 blockquote
> - ✅ **세션 9 말 (2026-07-06)** — **Step 3 둘째 슬라이스: 작성 시점 필드 레벨 팁**. `matchFieldLessonTips`(fieldPattern 토큰 매칭, 게이트 공유) → 작성 워크스페이스 "입력 필요" 항목·서식 필드 테이블에 인라인 `FieldLessonTips`. 매출액·사업비 등 매칭/negative/게이트 실측 + 공고 레벨 회귀 23/23. 한계(2자 토큰 과매칭 코너·grant_document_fields 0건)는 계획 문서에
>
> - ✅ **세션 10 (2026-07-07)** — **HWPX 원본 양식 채움 트랙 Phase 0~2** (`docs/plans/2026-07-07-hwpx-fill-export.md`, 커밋 `ef02bba`→`2bf43ec`→`490a789`): 사용자 답변을 원본 정부 양식(.hwpx)에 채워 다운로드하는 신규 트랙을 설계→검증→구현 완주. ① Phase 0 스파이크 — 바이트 보존 스플라이스+재압축 라운드트립 11/11, Docker 렌더 11/11, 한컴오피스 수동 오픈 확인(사용자), 외부 대조(python-hwpx 선례로 방식 강화) ② Phase 1 — `packages/core/documents/hwpx-fill.ts`(zero-dep, 셀 스캔·라벨 매칭·스플라이스 채움·부분 채움 정직 보고), 단위 15/15+실샘플 렌더 게이트 전건 통과 ③ Phase 2 — download route POST(`format=hwpx`, answers 동봉·병합), `hwpxTemplateAvailable` 플래그, 워크스페이스 HWPX 버튼+미채움 안내. **핵심 발견**: `.hwpx` 위장 HWP 바이너리 실재(3/14) → 형식 판별은 매직 바이트 필수(`detectHwpFormat`); 최근 3개월 공고 한글 첨부의 78%가 여전히 `.hwp`(DB 실측) → hwp2hwpx(Java, JRE는 변환 서버에 기설치) 후속 트랙 우선순위 높음. 잔여는 Phase 3 브라우저 실측 QA
>
> 남음 (우선순위순):
>
> - ✅ ~~[HWPX 트랙 Phase 3] 브라우저 실측 QA~~ (2026-07-08 통과, `6926b8b` — 버튼 노출 양방향·다운로드 왕복·미채움 8건 정직 안내·한컴 셀 안착 사용자 확인). 같은 날 후속: ✅ 설계 6번 잔여 매직 바이트 보강(`fda7452`) 완료
- 🔄 **[HWPX 후속] hwp2hwpx 변환 트랙** (2026-07-08 착수) — 외부 대조(`docs/research/2026-07-08-hwp2hwpx-calibration.md`, 유지 3·보강 3·kordoc 병행 측정 등재) → 설계 확정(**정본: `docs/plans/2026-07-08-hwp2hwpx-track.md`**) 완료, Phase 0 스파이크(uber jar 빌드·전수 변환·구조 단정·채움 왕복·렌더 게이트) 진행 중. 잔여 소과제: answers 동봉 경로 실측(추가 입력 문항 있는 공고, dev 서버 사용자 기동)
>
> - 🔶 **[임계경로·사용자] 리뷰팀 45문서 검수 개시** — ① ⬜ `docs/infra-setup-guide.md` B1(Vercel env R2_* 확인)·B2(리뷰어 admin_users 등록) ② ⬜ dev.changupnote.com/internal/review 브라우저 왕복 확인 후 리뷰팀에 `docs/review-team-guide.md` 전달. Gate 1 golden·Gate 2 측정의 유일한 블로커
> - ⬜ **[사용자] A7**: Vercel(dev)에 `CONVERSION_SERVER_URL`(위 Cloud Run URL) + `CONVERSION_SHARED_SECRET`(`gcloud secrets versions access latest --secret=CONVERSION_SHARED_SECRET`) 등록 → **완료 확인되면 세션이 웹앱→Cloud Run E2E 검증** (아카이브 후크→job→artifact 왕복, `conversion-dev/` 프리픽스·검증 행 삭제 관례)
> - ⬜ **[사용자·선택]** `UPSTAGE_API_KEY`·`AZURE_DI_ENDPOINT`/`AZURE_DI_KEY`를 `.env.local`에 — 없으면 해당 엔진 스킵(Google·kordoc은 이미 가동)
> - ⬜ **[D] 부분 golden 조기 측정** — 검수 승격 15~20건 시점: `pnpm load:golden:field-maps -- --write` → `pnpm eval:layout -- --engine all --docs all --allow-paid --write` (PaddleOCR는 이때 로컬 docker 기동)
> - ✅ ~~[E] Phase 3 Viewer v1~~ (세션 6 완료 — 위 완료 목록). 후속 소과제: ⬜ 진입 링크(ApplySheetView — **병렬 세션 머지 후**) ⬜ A7 완료 시 실 conversion artifact로 재검증
> - ✅ ~~[F] Phase 4 엔진 비종속부~~ (세션 7 완료 — 위 완료 목록). 잔여 **[F2] 엔진 종속부**는 Gate 2 측정([D]) 후: 선정 어댑터 프로덕션 배선 → pollConversions 연동 → 임계값 캘리브레이션 → Vision LLM pass(§8.4 의미 해석)
> - ⬜ 웹폼 샘플 5건 라벨 (브라우저 캡처, 검수 후 별도 배치) — **착수 문서: `docs/plans/2026-07-06-webform-labeling-kickoff.md`** (트리거 문장 포함. §9.7 제약: 로그인 폼 제외·캡처만)
> - ✅ ~~kordoc batch4 원본 매핑~~ (세션 6 완료 — `spike-labels/source-map.json` + pdfjs-dist@4.10.38. kordoc 44/45, 잔여 doc54는 `.doc` 미지원 엔진 한계)
> - ⬜ 운영자 인박스 (9.8 후속 슬라이스) — 검수 진행 중 보류·리뷰어 코멘트가 쌓이면 착수
> - ⬜ kordoc `fillHwpx()` 스파이크 — filled export 가속 후보. 검증 없이 채택 금지 (Gate 3 이후 실험)
> - ⬜ confidence 합성 산출 구현 설계 (마스터 13장 정의됨 — 구현은 Gate 3 전)
> - ⬜ Tier 0 검색(Phase 8)에 contextual retrieval + BM25 하이브리드 반영 (`docs/research/2026-07-02-hitl-loop-sota.md`)
> - ⬜ **지식 루프 다음 슬라이스 (K1~K4)** — 세션 9 말 한계 평가에서 도출된 작업 큐: K1 노출 텔레메트리(최우선·Step 4 분모) → K2 fieldKey 어휘 정규화(Gate 1 표준 key 사전 재사용) → K3 프로그램 사전 미매칭 경고 → K4 후순위 모음. **착수 문서: `docs/plans/2026-07-06-knowledge-loop-next-session.md`** (트리거 문장 포함). 운영 루틴: 새 보고서 → `/internal/knowledge` 업로드→추출 또는 `pnpm ingest:knowledge` → 인박스 검수. 트랙 정본: `docs/plans/2026-07-05-ops-knowledge-ingestion.md`
>
> **다음 세션 진입 가이드 (세션 6~) — 로컬 맥 Claude Code**
>
> 현재 좌표: Gate 0 통과 · Gate 1 검수 대기(golden 0건) · Gate 2 인프라 완비(측정 대기) · Phase 0~2 완료 · Phase 3 Viewer v1 완료 · Phase 4 엔진 비종속부 완료(엔진 배선·Vision pass는 Gate 2 후), Phase 5~8 미착수. 전체 구현/미구현 인벤토리는 세션 5 대화 기록 또는 위 남음 목록 기준.
>
> - **진입 절차 (순서대로)**:
>   1. `git pull --ff-only` + `git status` — **병렬 세션 주의**: 사용자가 다른 세션에서 apps/web UI 파일들을 수정 중일 수 있음. 미커밋 web 변경분은 건드리지 말고, 커밋 시 반드시 경로 명시 스테이징 (`git add -A` 금지)
>   2. 사용자 액션 상태 점검: ⓐ B2 리뷰어 등록 여부(admin_users에 support 행) ⓑ 검수 진행률(field_map_review_docs의 review_status=approved 수) ⓒ A7(Vercel env — 사용자에게 확인) ⓓ `.env.local`에 UPSTAGE/AZURE 키 유무
>   3. 분기: A7 완료 → **웹앱→Cloud Run E2E 검증** 먼저 / approved ≥15 → golden 적재 + **[D] 조기 측정** → 이어서 [F2] 엔진 배선 / 둘 다 아니면 → 남음 소과제(웹폼 샘플 5건 라벨·운영자 인박스는 검수 진행 후·진입 링크는 병렬 머지 후) — 대형 트랙은 대부분 검수/A7에 수렴했으므로 사용자 액션이 최우선 병목
> - 작업 체계 (사용자 확정): 구현·대량 작업은 **Opus 서브에이전트(Agent 도구)** 위임, 메인 세션(Fable)은 계획·검증·통합·커밋. 위임 스펙은 plan doc 섹션으로 (v1/v1.1/v2·Gate2 어댑터 §5 선례). **리서치도 Opus 위임** (외부 대조 등)
> - 관문 의례: **Gate 3 착수 전 외부 대조 필수** (CALIBRATION-TEMPLATE 사전 등재: fill strategy 5종·evidence 정렬 validator·적합도 라벨 UX). Phase 3 Viewer는 관문 아님 — 의무 없음
> - GCP: 프로젝트 `changupnote-com`(gcloud 인증 완료 상태였음 — 만료 시 사용자에게 `! gcloud auth login` 요청). 변환 서버 재배포는 `cloudbuild.yaml`(`--substitutions _TAG=...`) → `gcloud run services update`. **조직 DRS로 allUsers 불가 — `--no-invoker-iam-check` 유지.** run.app `/healthz`는 컨테이너 미도달(Google 가로챔) — 도달성은 `GET /`→앱 401로. 원격 스모크: `apps/conversion/scripts/smoke-remote.mjs`
> - 변환 서버 회귀는 `node apps/conversion/scripts/quality-test.mjs`(10/10, 로컬 동작). `test:t9`는 LibreOffice 필요 — 맥에 없으면 스킵
> - 수동 E2E 주의: R2 키 프리픽스 `conversion-dev/`, DB 검증 행·계정은 검증 후 삭제 (`sim-reviewer@ba-ton.kr` 패턴)
> - 리뷰 도구 운영 메모: 라벨 정본은 **DB**(field_map_review_docs), spike-labels/는 임포트 소스. 라벨 대폭 수정 시 질문 재생성 `pnpm generate:review-questions -- --regenerate --write`. 검수 확정=golden 승격(취소 가능). AI 라벨을 검수 없이 golden 승격 금지(순환성). 보류·코멘트가 쌓이면 운영자 인박스가 차기 우선
> - env 정본은 `.env.local`(앱이 읽는 파일). 시크릿 값은 출력 금지 — Secret Manager/`.env`에서 파이프로만

## 문서 지도

| 주제 | 문서 |
|---|---|
| 단일 설계 원천 | `docs/public-support-application-guide-master-architecture.md` |
| Gate 0 결과 | `docs/gate0-hwp-render-spike-plan.md` (상단 결과 blockquote) |
| Gate 1 기준서 (규칙 1~10) | `docs/gate1-field-map-labeling-guide.md` |
| 검수 큐 | `spike-labels/REVIEW-QUEUE.md` |
| Phase 2 계획 (T1~T10) | `docs/phase2-conversion-server-implementation-plan.md` |
| 환경/작업 규칙 | `CLAUDE.md` |

## 부록: 샌드박스 DB/R2 스크립트 패턴 (Cowork 전용 — 로컬 Claude Code에서는 불필요, 레포에서 직접 pnpm/tsx 사용)

```js
// /tmp/dk/*.mjs 에서 실행 (node /tmp/dk/x.mjs). env는 저장소 .env.local + .env 순으로 읽는다
import postgres from "postgres";
import { readFileSync } from "node:fs";
const repo = "<샌드박스 마운트 경로>/cunote";
const read = (f) => { try { return readFileSync(`${repo}/${f}`, "utf8"); } catch { return ""; } };
const url = (read(".env.local") + "\n" + read(".env")).match(/^DATABASE_URL="?([^"\n]+)"?/m)?.[1];
const sql = postgres(url, { prepare: false, max: 1 }); // Supabase pooler라 prepare:false 필수
```

R2는 `@aws-sdk/client-s3` + `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET` (엔드포인트 `https://<account>.r2.cloudflarestorage.com`, region "auto"). drizzle-kit은 `PATH=/tmp/dk/node_modules/.bin:$PATH NODE_PATH=/tmp/dk/node_modules drizzle-kit generate|migrate`.
