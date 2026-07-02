# @cunote/conversion — Phase 2 문서 변환 서버 (T1~T6)

HWP/HWPX/PDF/DOCX 원본을 **결정론적으로** PDF · 페이지 이미지 · markdown · quality score 로 변환한다. LLM 호출 없음.

- 계획: `docs/phase2-conversion-server-implementation-plan.md`
- 전제(Gate 0 확정): LibreOffice 26.x + H2Orestart 0.7.13 (HWP/HWPX 60/60 렌더 성공)

## 현재 범위 (구현 완료: T1~T6)

| 태스크 | 산출물 |
|---|---|
| **T1** | `apps/conversion` 스캐폴드 + `Dockerfile` (ubuntu 24.04 + libreoffice + H2Orestart oxt + pyhwp + poppler + node 22) |
| **T2** | `convertDocument()` — 무결성확인 → soffice PDF → pdftoppm(220dpi) → 텍스트추출(HWPX zip/XML, HWP hwp5html, PDF fallback) |
| **T3** | `computeQuality()` 순수 함수 + status 판정 (usable / usable_with_review / manual_required / failed) |
| **T4** | `uploadArtifacts()` + `createR2ObjectStorage()` — R2 업로드 + storage key 규칙 (계획 7장) |
| **T5** | `ConversionQueue` — in-process 순차 큐 + 워커 풀 (동시성 기본 2, job 상태 인메모리, 문서당 soffice 격리) |
| **T6** | HTTP API 3종 (`POST/GET/GET`) + sha256 캐시 히트 + shared secret 인증. 엔트리 `src/main.ts` → `dist/main.js` |

미구현(후속): T7~T10 웹앱 연동(아카이브 후크·surface upsert·폴링) / Cloud Run 배포.

## 소스 구조

```
src/
  types.ts               공용 타입 (ConvertDocumentInput/Result, Phase2ConversionQuality)
  integrity.ts           1단계: sha256·포맷·암호화·크기 무결성 확인
  render.ts              2~4단계: soffice PDF·pdftoppm·텍스트추출 (스파이크 승격)
  quality.ts             T3: computeQuality / decideStatus / estimateTextCoverage (순수 함수)
  convert-document.ts    오케스트레이터 (부분 성공 규칙)
  storage.ts             T4: R2 클라이언트 + buildStorageKey + uploadArtifacts (계획 7장)
  queue.ts               T5: ConversionQueue (동시성 2, 인메모리 job 상태, sha256+converterVersion 캐시)
  server.ts              T6: node http API 3종 + shared secret 인증 + 캐시 히트 응답
  main.ts                T6: 서버 프로세스 엔트리 (Dockerfile CMD → dist/main.js)
  hwp-markdown-adapter.ts @cunote/core 의 convertHwpBufferToMarkdown 주입 어댑터
  index.ts               배럴 export
scripts/
  convert-lib.mjs        의존성 없는 병렬 구현 (샌드박스 검증용, src/*.ts 미러). T4·T5 미러 포함.
  server-lib.mjs         src/server.ts 의 plain-node 미러 (검증용)
  verify-convert.mjs     T2 단일 파일 검증 → pdf+pages+markdown+quality.json
  batch-convert.mjs      T2 디렉토리 배치 → 성공률/품질 분포 리포트
  quality-test.mjs       T3 순수함수 단위 테스트 (node assert)
  verify-storage.mjs     T4 검증: 변환→R2 업로드→인증 GetObject 확인→동일 sha256 캐시 스킵
  verify-queue.mjs       T5 검증: 동시 5건 등록 → 동시성 2 유지 · 전건 완료
  verify-api.mjs         T6 검증: 서버 기동→POST→폴링→artifacts→재등록 cached:true→종료, 잘못된 secret 401
```

### AWS SDK 의존성 (T4)

`storage.ts` 는 `@aws-sdk/client-s3` 를 정식 import 하고 `package.json` dependencies 에 추가돼 있다
(pnpm install 로 설치). 검증 `.mjs` (`convert-lib.mjs` 의 R2 헬퍼)는 SDK 를 lazy `require` 로 로드하며,
검증 스크립트가 `--sdk <node_modules>` 로 로드 경로를 주입한다 (샌드박스는 `/tmp/dk/node_modules`).

### `scripts/*.mjs` 와 `src/*.ts` 의 관계

`src/*.ts` 가 **정본**이다. `scripts/convert-lib.mjs` 는 pnpm/빌드 없이(plain node) 파이프라인을
실행·검증하기 위한 1:1 병렬 구현이다. 로직을 바꾸면 **두 곳을 함께** 갱신해야 한다.
(샌드박스에 pnpm 이 없어 TS 를 빌드할 수 없으므로 검증 엔트리를 .mjs 로 둔다.)

## 로컬 검증 (pnpm 불필요, node 22 + soffice + poppler 만 있으면 됨)

```bash
# soffice + H2Orestart 가 기본 HOME 프로필에 설치돼 있어야 한다.
# (Docker 이미지는 --shared 설치 + CONVERSION_LO_SHARED_H2O=1 로 프로세스 격리)

# T3 단위 테스트 (외부 의존성 없음)
node apps/conversion/scripts/quality-test.mjs

# 단일 문서 변환
node apps/conversion/scripts/verify-convert.mjs <파일.hwp|hwpx|pdf|docx> <outdir>
#   → <outdir>/document.pdf, pages/pNNN.png, markdown.md, quality.json

# 디렉토리 배치 (성공률·품질 분포)
node apps/conversion/scripts/batch-convert.mjs spike-samples/files <outdir>

# T4 R2 업로드 검증 (실제 버킷 conversion-dev/ 프리픽스, 삭제 불가 환경이므로 1건)
#   루트 .env / .env.local 의 R2_* 자격증명을 자동 로드한다.
node apps/conversion/scripts/verify-storage.mjs <파일.pdf|hwpx> --sdk /tmp/dk/node_modules

# T5 큐/동시성 검증 (R2 불필요, stub storage)
node apps/conversion/scripts/verify-queue.mjs [파일]

# T6 API 왕복 검증 (한 프로세스 안에서 서버 기동→POST→폴링→artifacts→cached→종료)
node apps/conversion/scripts/verify-api.mjs <파일.pdf|hwpx> --sdk /tmp/dk/node_modules

# T9 실패 경로 (계획 11장) — 변환 코어 단위 (R2/DB 불필요)
#   암호화 HWP/HWPX/PDF·손상·타임아웃(주입)·대용량(주입)·sha불일치·미지원·부분성공·page image 상한
node apps/conversion/scripts/failure-path-test.mjs

# T9 실패 경로 — 전 구간 API→큐→변환→R2 (실패 job 은 artifact 0건 · R2 업로드 0건 확인)
node apps/conversion/scripts/verify-failure-api.mjs --sdk /tmp/dk/node_modules

# T9 실패 경로 — 전 구간 …→DB (웹앱 T8 상태 전이: failed→failed, partial→preview_ready, 멱등/강등방지)
#   테스트 surface/artifact 행은 검증 후 자동 삭제(기존 grant 재사용).
node apps/conversion/scripts/verify-failure-e2e-db.mjs --sdk /tmp/dk/node_modules

# 픽스처만 파일로 덤프해 보고 싶을 때 (합성 샘플 확인용)
node apps/conversion/scripts/failure-fixtures.mjs /tmp/t9-fixtures

# npm 스크립트 (apps/conversion 에서)
#   pnpm test:failure  /  test:failure:api  /  test:failure:db  /  test:t9(전체)
```

> **합성 픽스처 (`failure-fixtures.mjs`)**: 암호화 HWP=FileHeader 속성 플래그 bit1(0x02) 세팅,
> 암호화 HWPX=ZIP 로컬헤더 general-purpose bit0(0x0001) 세팅, 암호화 PDF=trailer `/Encrypt` 참조,
> 손상 HWP=CFB/FileHeader 6KB 유지 후 바디 0xFF 덮기(soffice 로드 실패), 부분성공=텍스트 오퍼레이터
> 없는 유효 1p PDF(pdftotext 공백 → markdown 실패). 실HWP 는 `spike-samples/files` 재사용.
>
> **T9 중 발견·수정된 결함**: `ConversionQueue` 가 `options.pageImageDpi` 만 전달하고
> `sofficeTimeoutMs`·`maxBytes`·`maxPages` 를 `convertDocument` 로 전달하지 않았다.
> `ConversionJobRequest.options` 확장 + `runJob` 전달 + API 검증(양의 정수만 통과)으로 수정됨
> (`src/queue.ts`·`src/server.ts` 및 미러 `scripts/convert-lib.mjs`·`scripts/server-lib.mjs`).
> 타임아웃/대용량 실패 경로는 코어 단위(`failure-path-test.mjs`) 직접 주입에 더해
> API 경유 주입 e2e(`verify-failure-api.mjs`)로도 검증한다.

> 샌드박스에는 H2Orestart 가 없어 HWP/HWPX 는 렌더 실패한다. T4·T6 검증은 PDF(passthrough)
> 샘플로 전 구간(변환→업로드→API)을 확인한다. Docker 이미지(H2O 포함)에서는 HWP/HWPX 도 동일 경로로 동작한다.
> `R2_BUCKET_URL` 은 S3 API 엔드포인트라 미인증 public GET 은 400 이므로, 업로드 확인은 저장소 관례대로 인증 `getObjectText` 로 한다.

## 서버 실행 (T6)

```bash
# env: CONVERSION_SHARED_SECRET(필수) · R2_*(필수) · CONVERSION_CONCURRENCY(기본 2) · PORT(기본 8080)
#      CONVERSION_KEY_PREFIX(기본 grant-convert; 검증은 conversion-dev)
node apps/conversion/dist/main.js
```

API (계획 4장, 웹앱이 서버-투-서버로만 호출, `x-shared-secret` 또는 `Authorization: Bearer`):

| 메서드·경로 | 동작 |
|---|---|
| `POST /v1/conversion-jobs` | job 등록. 신규면 `202 {status:queued, cached:false}`. 동일 sha256+converterVersion 이 캐시에 있으면 `200 {status:succeeded, cached:true, artifacts:[...]}` |
| `GET /v1/conversion-jobs/:jobId` | 상태·quality 폴링 (`queued/running/succeeded/partial/failed`) |
| `GET /v1/conversion-jobs/:jobId/artifacts` | artifact 목록 (kind·storageKey·url·sha256·metadata) |
| `GET /healthz` | 헬스체크 (인증 불필요) |

### 환경변수

| 변수 | 기본값 | 용도 |
|---|---|---|
| `SOFFICE_BIN` | `soffice` | LibreOffice 바이너리 경로 |
| `PDFTOPPM_BIN` / `PDFTOTEXT_BIN` / `PDFINFO_BIN` | poppler 기본 | poppler 도구 경로 |
| `CONVERSION_LO_SHARED_H2O` | (미설정) | `1` 이면 워커별 임시 `-env:UserInstallation` 로 프로세스 격리. **H2Orestart 가 `--shared` 설치돼 있어야** 함 (Docker). 샌드박스처럼 사용자 프로필에만 H2O 가 있으면 설정하지 말 것. |

## 파이프라인 (계획 5장)

```
1. 무결성 확인   sha256 재계산·대조 / 확장자 포맷 / 암호화(HWP FileHeader·HWPX zip flag·PDF /Encrypt) / 50MB 상한
2. PDF 렌더링    hwp/hwpx/docx → soffice --convert-to pdf (H2Orestart), pdf → passthrough
3. page image    pdftoppm -png -r 220 (최대 100p, 초과 시 partial)
4. 텍스트 추출   hwpx → zip/XML 직접, hwp → hwp5html(pyhwp), 실패 시 PDF 텍스트 fallback / pdf → pdftotext -layout / docx → soffice txt
5. quality score 6장 산출
```

부분 성공 규칙: PDF 실패 = `failed`(이후 중단). PDF 성공 + (page image 또는 markdown 실패) = `partial`. 전부 성공 = `succeeded`.

## quality status 판정 (계획 6장)

- `failed`: pdfRendered=false
- `manual_required`: pdfRendered=true, textExtracted=false (이미지만)
- `usable_with_review`: textCoverage < 0.7 또는 심각 warning(font_substitution/page_image_partial)
- `usable`: pdfRendered && pageImagesRendered && textCoverage ≥ 0.7

`textCoverage = min(1, extractedCharCount / (pageCount × 800))`. 임계값 0.7·기대 800자/p 는 잠정치(Gate 2 캘리브레이션).
`visualTextAgreement` · `requiredFieldCoverage` · `fieldCandidateCount` 는 Phase 4 필드로 지금은 `null`.

## Docker 빌드 검증 (샌드박스에서 빌드 불가 — 절차만 기록)

샌드박스에는 Docker 데몬이 없어 이미지 빌드를 수행하지 못한다. 로컬/CI 에서 아래로 검증한다.

```bash
# 저장소 루트에서 (빌드 컨텍스트 = 루트)
docker build -f apps/conversion/Dockerfile -t cunote-conversion .

# 1) H2Orestart 설치 검증
docker run --rm cunote-conversion unopkg list --shared | grep -i H2Orestart
#   → "ebandal.libreoffice.H2Orestart  Version: 0.7.13" 이 보여야 함

# 2) soffice / poppler / node 버전
docker run --rm cunote-conversion soffice --version
docker run --rm cunote-conversion pdftoppm -v
docker run --rm cunote-conversion node --version   # v22.x

# 3) 대표 HWP 1건 렌더 + 폰트 substitution 경고 확인
docker run --rm -v "$PWD/spike-samples/files:/samples:ro" cunote-conversion \
  node apps/conversion/scripts/batch-convert.mjs /samples /tmp/out
#   → PDF 렌더 30/30, font_substitution warning 유무 확인
```

**폰트 주의**: 나눔/노토 CJK 미설치는 렌더 깨짐의 최대 원인. 빌드 후 대표 HWP 렌더로 substitution 경고를 확인한다.
**H2O 격리**: 컨테이너는 `CONVERSION_LO_SHARED_H2O=1` 로 워커별 프로필을 격리한다(soffice 인스턴스 재사용 hang 방지). 이는 H2O `--shared` 설치를 전제로 한다.

## 검증 결과 (샌드박스, 2026-07-02)

- LibreOffice 26.2.4.2 + H2Orestart 0.7.13, poppler, node 22.22.3
- T3 단위 테스트: 10/10 통과
- 배치 30건(`spike-samples/files`): **PDF 렌더 30/30 (100%)**, jobStatus 전부 `succeeded`
- quality 분포: `usable` 4, `usable_with_review` 26
  (HWP 는 hwp5html 미설치로 PDF 텍스트 fallback → 일부 textCoverage < 0.7 로 review 판정. hwp5html 설치 시 개선)
