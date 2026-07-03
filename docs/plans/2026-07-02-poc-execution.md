# PoC 실행 플랜 — 작성 가이드 (Gate 0~2 · Phase 1~2)

> **🟡 진행 상황 (2026-07-03 · 세션 4 종료 — Cowork에서 로컬 Claude Code로 전환)**
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
> 남음:
>
> - ✅ **배포 전 검증 완료** (세션 3 후반) — 리눅스 클린 빌드에서 `next build` 통과(선존 타입에러 2건 수정 포함), 프로덕션 서버 스모크로 게이트 404·mock 인증 검수 왕복(save→approve→unapprove) HTTP 레벨 통과, bbox 오버레이 규약 시각 검증. '확인 필요만' 필터 추가. 검수팀 가이드 `docs/review-team-guide.md`
> - ✅ `758c5b3` **v1.1 — 리뷰팀 첫 피드백 5건 반영** (세션 4): bbox 드래그 재작도·인앱 가이드(/internal/review/guide)·용어 한국어화·오버레이 클릭 선택·보류 토글+리뷰어 코멘트(0028 적용). **bbox 정교화 로드맵**은 v1 plan doc v1.1 섹션에 등재 (Gate 2 layout 엔진 → 골든 bbox 자동 스냅 + 확인 UI — Gate 2 이후 작업)
> - ✅ `f76ceca` **v2 — 질문 기반 검수 모드** (세션 4): "직관적이지 않다" 피드백에 검수 UX를 질문 카드 흐름으로 전환. 0029 질문 테이블(적용됨), LLM 사전 배치 생성 완료(45문서 1,965문항: question 150/quick_confirm 1,472/missing_sweep 343), applyMap 화이트리스트 검증, 질문 모드 기본+전문 모드 토글. **재생성 커맨드**: `pnpm generate:review-questions -- --regenerate --write` (라벨 대폭 수정 시)
>
> - 🔶 **[임계경로] 배포 + 리뷰팀 45문서 검수 개시** — ① ✅ origin push 완료(2026-07-03, 로컬 전환 체크리스트 1~3 통과 — conversion 선존 타입에러 수정 `97925d3`) ② ⬜ `docs/infra-setup-guide.md` B1(Vercel env에 R2_* 확인)·B2(리뷰어 admin_users 등록) — 사용자 진행 중 ③ ⬜ 브라우저 1회 확인 후 리뷰팀에 `docs/review-team-guide.md` 전달
> - ✅ **Phase 2 T10 Cloud Run 배포 완료** (2026-07-04 새벽) — `https://cunote-conversion-644631753751.asia-northeast3.run.app` (asia-northeast3, 2Gi/2cpu, max-instances 1). **스모크 5/5 PASS** (HWP2·HWPX1·PDF1·DOCX1 왕복 + R2 실재 + 캐시 + 401). 이미지 첫 실빌드에서 결함 3건 수정: 빌드체인·JVM 탐지·**UTF-8 로케일(한글 파일명 HWP 렌더 불가)**. 조직 DRS로 `--no-invoker-iam-check` 채택(앱 shared secret 인증), run.app `/healthz`는 Google이 가로챔(도달성은 `GET /`→앱 401로 확인). 상세: phase2 계획 12장 실행 결과. **남은 사용자 액션 A7**: Vercel(dev)에 `CONVERSION_SERVER_URL`+`CONVERSION_SHARED_SECRET` 등록
> - ⬜ **개발 트랙 (검수와 병렬, 측정 비의존부터)**: Gate 2 layout 엔진 어댑터 5종 구현·배선(Upstage/kordoc/Google/Azure/PaddleOCR — 실행 인프라까지, **통과 판정·캘리브레이션은 golden 쌓인 후**, 착수 전 CALIBRATION-TEMPLATE 외부 대조) → 검수 15~20건 시점에 부분 golden으로 조기 측정 시작 (2026-07-03 사용자 합의: 순차 아닌 병렬)
> - ⬜ 웹폼 샘플 5건 라벨 (브라우저 캡처 필요 — 검수 후 별도 배치)
> - ⬜ Gate 2 준비: layout 엔진 후보 스파이크 — **후보에 Upstage Document Parse(한국어 특화·$0.01/p)와 kordoc `extractFormFields()` 추가** (Google/Azure/PaddleOCR와 함께, `docs/research/2026-07-02-document-ai-sota.md` 대조표 기준)
> - ⬜ kordoc `fillHwpx()` 스파이크 — HWPX filled export(마스터 3.2 후속 단계)를 앞당길 후보. 검증 없이 채택 금지
> - ⬜ confidence 합성 산출 구현 설계 (마스터 13장 신규 정의 — self-consistency + evidence 정렬 + 소스 합의. Gate 3 전 필요)
> - ⬜ Tier 0 검색(Phase 8)에 contextual retrieval + BM25 하이브리드 반영 (`docs/research/2026-07-02-hitl-loop-sota.md`)
>
> **다음 세션 진입 가이드 — 로컬 Claude Code (맥) 기준**
>
> 2026-07-03부터 작업 환경이 Cowork 샌드박스 → **로컬 맥 Claude Code 터미널**로 전환됨.
>
> - 브랜치: `main` (worktree 없음). **미push 커밋 다수 — 첫 작업 전에 `git push origin main`**
> - 작업 체계 (사용자 확정): 구현·대량 작업은 **Opus 4.8 서브에이전트(Task 도구)** 위임, 메인 세션은 계획·검증·통합·커밋. 위임 스펙은 plan doc에 섹션으로 남긴다 (v1/v1.1/v2 섹션 참조)
> - **샌드박스 전용 규칙은 로컬에서 전부 해당 없음**: stale-locks 의례 불필요(정상 git), `/tmp/dk*` 불필요(레포에서 직접 `pnpm` 사용), unlink 차단 없음, bash 45초 제한 없음. `.git/stale-locks/`·`.git/objects/*/tmp_obj_*` 잔재는 한 번 `rm -rf`로 정리 권장
> - **로컬 전환 직후 체크리스트** (순서대로):
>   1. `git push origin main` (백업 + Vercel dev 배포 트리거)
>   2. `pnpm install` → `pnpm -r typecheck` 또는 `tsc --noEmit -p apps/web/tsconfig.json` (리눅스 클린 빌드는 통과 상태 — 맥 네이티브 최초 확인)
>   3. `pnpm --filter @cunote/web build` 통과 확인
>   4. infra-setup-guide B1·B2 (Vercel env, 리뷰어 등록) → dev.changupnote.com/internal/review 브라우저 확인 → 리뷰팀에 검수 가이드 전달
> - 변환 서버 회귀(`node apps/conversion/scripts/quality-test.mjs` 10/10)는 로컬에서도 동작. `verify-convert.mjs`·`test:t9`는 LibreOffice+H2Orestart 필요 — 맥에 없으면 스킵하고 Docker/배포 환경에서 확인 (Gate 0 확정 환경은 리눅스)
> - 이후 트랙 (병렬): [A] 리뷰팀 검수 진행 지원·질문 품질 관찰 [B] T10 Cloud Run 배포 (infra-setup-guide A절) [C] Gate 2 layout 엔진 어댑터 실행 인프라 (**착수 전 외부 대조**: `docs/research/CALIBRATION-TEMPLATE.md` 절차, 2026-07-02 대조 이후 변화분만) [D] 검수 15~20건 시점 부분 golden 조기 측정 (`pnpm load:golden:field-maps -- --write` → eval)
> - 수동 E2E 주의: 변환 서버 API 검증 시 R2 키 프리픽스 `conversion-dev/`, DB 검증 행·계정은 검증 후 삭제 (이번 세션 관례: `sim-reviewer@ba-ton.kr` 패턴)
> - 리뷰 도구 운영 메모: 라벨 정본은 **DB**(field_map_review_docs), spike-labels/는 임포트 소스. 라벨 대폭 수정 시 질문 재생성 `pnpm generate:review-questions -- --regenerate --write`. 검수 확정=golden 승격(취소 가능). 보류·리뷰어 코멘트가 쌓이면 운영자 인박스 화면(9.8 후속 슬라이스)이 다음 우선 후보

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
