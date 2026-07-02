# PoC 실행 플랜 — 작성 가이드 (Gate 0~2 · Phase 1~2)

> **🟡 진행 상황 (2026-07-02 · 세션 1 종료 시점)**
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
> 남음:
>
> - ⬜ **[사람·임계경로] REVIEW-QUEUE 45문서 검수** (`spike-labels/REVIEW-QUEUE.md` — 소급 교정 4건 우선). Gate 2 착수의 유일한 블로커. 검수 후 `pnpm load:golden:field-maps -- --write`로 적재
> - ⬜ Phase 2 T10 Cloud Run 배포 (사용자 GCP 자격증명 필요)
> - ⬜ [사람] 로컬 `pnpm install` 후 `@cunote/conversion`·`@cunote/web` typecheck (T1~T8 타입 정합 최종 확인)
> - ⬜ [사람] origin push (main이 origin보다 다수 커밋 앞섬)
> - ⬜ 웹폼 샘플 5건 라벨 (브라우저 캡처 필요 — 검수 후 별도 배치)
> - ⬜ Gate 2 준비: layout 엔진 후보 스파이크 — **후보에 Upstage Document Parse(한국어 특화·$0.01/p)와 kordoc `extractFormFields()` 추가** (Google/Azure/PaddleOCR와 함께, `docs/research/2026-07-02-document-ai-sota.md` 대조표 기준)
> - ⬜ kordoc `fillHwpx()` 스파이크 — HWPX filled export(마스터 3.2 후속 단계)를 앞당길 후보. 검증 없이 채택 금지
> - ⬜ confidence 합성 산출 구현 설계 (마스터 13장 신규 정의 — self-consistency + evidence 정렬 + 소스 합의. Gate 3 전 필요)
> - ⬜ Tier 0 검색(Phase 8)에 contextual retrieval + BM25 하이브리드 반영 (`docs/research/2026-07-02-hitl-loop-sota.md`)
>
> **다음 세션 진입 가이드**
>
> - 브랜치: `main` (worktree 없음)
> - 작업 체계: 구현·대량 작업은 **Opus 서브에이전트** 위임, 메인은 계획·검수·피드백 (CLAUDE.md "작업 체계")
> - git: 마운트에서 unlink 차단 — **모든 git 명령 직전** `mkdir -p .git/stale-locks && mv .git/*.lock .git/stale-locks/ 2>/dev/null` (CLAUDE.md 참조)
> - **새 샌드박스에서 소멸되는 것 (재설치 필요)**:
>   - H2Orestart: `curl -sL -o /tmp/H2O.oxt "https://github.com/ebandal/H2Orestart/releases/latest/download/H2Orestart.oxt" && unopkg add /tmp/H2O.oxt` (soffice/pdftoppm은 기본 설치됨)
>   - DB/R2 접근용: `mkdir /tmp/dk && cd /tmp/dk && npm init -y && npm i postgres @aws-sdk/client-s3 drizzle-kit@0.31.10` (자격증명은 저장소 `.env` 재사용, 스크립트 패턴은 이 문서 하단 부록)
>   - 주의: 이전 세션의 `/tmp/dk`·`/tmp/vc` 등이 nobody 소유 읽기전용으로 남아있을 수 있음 — 그 경우 새 이름(`/tmp/dk2` 등)으로 생성. 마운트 node_modules는 macOS 바이너리라 리눅스에서 실행 불가(esbuild 불일치) — 반드시 /tmp 클린 설치 사용
> - **유지되는 것**: 마운트 저장소 전체 (`spike-samples*/`, `spike-out*/`, `spike-labels/` 포함), Supabase DB(0025 적용됨), R2 아티팩트
> - 회귀 검증 커맨드 (재개 직후 실행):
>   - `node apps/conversion/scripts/quality-test.mjs` → 10/10 통과
>   - `node apps/conversion/scripts/verify-convert.mjs spike-samples/files/10_*.hwp /tmp/vc` → pdf+pages+markdown 생성 (H2Orestart 설치 후)
> - 서브태스크 순서 (①② 세션 2 완료): ③ T10 배포 (사용자 협업) → ④ 웹폼 5건 → ⑤ **Gate 2 착수 전 외부 대조** (`docs/research/CALIBRATION-TEMPLATE.md` 절차, Gate 2 행의 전제 목록 사용 — 직전 대조 2026-07-02 이후 변화분만) → ⑥ Gate 2 layout 엔진 스파이크. 검수 완료분 생기면 언제든 `pnpm load:golden:field-maps -- --write`
> - 수동 E2E 주의: 변환 서버 API 검증 시 R2 키 프리픽스 `conversion-dev/` 사용, DB 검증 행은 검증 후 SQL로 삭제 (파일과 달리 DB 행은 삭제 가능)

## 문서 지도

| 주제 | 문서 |
|---|---|
| 단일 설계 원천 | `docs/public-support-application-guide-master-architecture.md` |
| Gate 0 결과 | `docs/gate0-hwp-render-spike-plan.md` (상단 결과 blockquote) |
| Gate 1 기준서 (규칙 1~10) | `docs/gate1-field-map-labeling-guide.md` |
| 검수 큐 | `spike-labels/REVIEW-QUEUE.md` |
| Phase 2 계획 (T1~T10) | `docs/phase2-conversion-server-implementation-plan.md` |
| 환경/작업 규칙 | `CLAUDE.md` |

## 부록: 샌드박스 DB/R2 스크립트 패턴

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
