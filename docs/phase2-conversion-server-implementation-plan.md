# Phase 2: 문서 변환 서버 구현 계획

작성일: 2026-07-02
상위 설계: `docs/public-support-application-guide-master-architecture.md` (8.3, 10, 12, 13장)
관련: `docs/hwp-visual-conversion-pipeline-design.md`, `docs/gate0-hwp-render-spike-plan.md`

## 0. 전제 (Gate 0에서 확정, 변경 금지)

- 1차 렌더러: **LibreOffice headless 26.x + H2Orestart 0.7.13** 확장. 기업마당 HWP/HWPX 60/60 (100%) 렌더링 성공, 문서당 약 0.3초. pyhwp가 파싱 실패한 파일도 렌더링됨.
- pyhwp `hwp5html`은 **markdown/텍스트 추출 보조**로만 유지 (시각 렌더링 아님). 기존 `packages/core/src/bizinfo/hwp-markdown.ts` 재사용.
- 변환 서버는 **LLM을 호출하지 않는다**. 결정론적 artifact만 생성한다.
- 결정론적 변환은 **첨부 아카이브 시점에 전량 실행**한다. 캐시 키는 `sha256 + converter version`.
- page image DPI: 기본 220 / 고밀도 300. 좌표는 0~1 상대좌표 (마스터 8.4).
- 저장: R2 (기존 `R2ObjectStorage` 재사용). 메타: `document_artifacts` 테이블 (Phase 1에서 추가됨).

## 1. 목표와 비범위

### 목표

HWP/HWPX/PDF/DOCX 원본을 아래 artifact로 결정론적으로 변환하고 `document_artifacts`에 기록한다.

| artifact kind | 내용 | Phase 2 |
|---|---|---|
| `pdf` | 원본 시각 렌더링 PDF | ✅ |
| `page_image` | 페이지별 PNG (220/300 dpi) | ✅ |
| `markdown` | 텍스트/구조 추출 (HWP=pyhwp, PDF=pdftotext, DOCX=soffice) | ✅ |
| quality score | `document_artifacts.metadata` + surface 상태 전이 | ✅ |
| `layout_json` | 블록/표/셀 bbox | ⬜ 스키마만 정의, Phase 4에서 채움 |

### 비범위 (Phase 2에서 하지 않음)

- vision pass, field reconciliation, LLM draft, annotated_pdf/pptx_guide export
- filled HWPX/DOCX export
- 웹폼 캡처
- Document AI 연동 (Phase 4 layout 단계에서 판단)
- `layout_json` 실제 생성 (스키마와 빈 자리만 확보)

## 2. 배포 형태 결정

### 비교

| 안 | 구성 | 장점 | 단점 |
|---|---|---|---|
| A. Cloud Run **service + 내부 큐** | 단일 컨테이너가 API + 워커 겸함, 요청 시 메모리 큐에 적재해 순차 처리 | 배포 1개, 인프라 단순, 로컬 docker와 동형 | 인스턴스 재시작 시 큐 유실, 요청 60분 상한 |
| B. Cloud Run service(API) + **Cloud Run Jobs**(워커) + Pub/Sub | API는 job 등록만, 무거운 변환은 Jobs가 처리 (task timeout 최대 7일) | 긴 배치/대량 재처리에 강함, 워커 스케일 독립 | 배포 2개 + Pub/Sub + job 상태 동기화. 하루 수백 건에는 과함 |

### 결정: **안 A — 단일 컨테이너 Cloud Run service (내부 순차 큐)**

근거:

- 처리량이 **하루 수백 건** 규모다. 문서당 약 0.3~2초이므로 단일 컨테이너 순차 처리로 충분하다 (수백 건 = 수 분~십수 분/일).
- Phase 2는 결정론적 변환만 한다. 문서당 처리가 짧아 request timeout(최대 60분) 안에 개별 job이 여유 있게 끝난다. 긴 배치가 필요해지는 것은 vision pass가 붙는 Phase 4다.
- 큐 유실은 재변환이 저렴하고 멱등(캐시 키 = sha256)이므로 치명적이지 않다. 아카이브 파이프라인이 실패 job을 재요청하면 그만이다.
- 단, 유실을 **감지하는 주체**가 필요하다: 아카이브 사이클(`run-grant-archive-cycle`) 말미에 `grant_application_surfaces.extraction_status = 'pending'`이고 `updated_at`이 1시간 이상 지난 surface를 재큐잉하는 재조정 스윕을 포함한다. 큐 유실·인스턴스 재시작·후크 누락 모두 이 스윕 하나로 회복된다.
- 대량 재처리(converter version 업)는 지금 필요 없다. 필요해지면 안 B의 Jobs를 **추가**로 붙이면 된다 (같은 컨테이너 이미지 재사용).

**과설계 금지 원칙**: Pub/Sub·별도 Jobs·워커 오토스케일은 vision 비용/처리량이 실제로 문제가 된 뒤에 도입한다.

### 처리 모델

- API 컨테이너 안에 in-process 동시성 제한(기본 2)을 둔 워커 풀. LibreOffice 프로세스는 문서 1건당 새로 띄우고 종료한다 (soffice 인스턴스 재사용 시 hang 리스크).
- `POST /v1/conversion-jobs`는 job을 큐에 넣고 즉시 `queued`로 응답한다 (비동기). 상태는 `GET`으로 폴링.
- 웹앱은 아카이브 시점에 job을 등록하고, 사용자 진입 시 캐시된 artifact를 조회한다 (동기 변환 금지 — 마스터 성능 설계).

## 3. Dockerfile 스케치

```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# LibreOffice + poppler(pdftoppm/pdftotext) + 폰트 + python(pyhwp) + node 22
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-core libreoffice-writer libreoffice-calc \
      poppler-utils \
      python3 python3-pip \
      fonts-nanum fonts-nanum-coding fonts-noto-cjk fonts-noto-cjk-extra \
      curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*

# node 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# pyhwp (markdown 보조 경로)
RUN pip3 install --break-system-packages pyhwp

# H2Orestart 확장 — 버전 고정 다운로드 후 shared 설치
ARG H2O_VERSION=0.7.13
RUN curl -fsSL -o /tmp/H2Orestart.oxt \
      "https://github.com/ebandal/H2Orestart/releases/download/v${H2O_VERSION}/H2Orestart.oxt" \
 && unopkg add --shared /tmp/H2Orestart.oxt \
 && rm /tmp/H2Orestart.oxt

# soffice 프로필 워밍업(첫 변환 지연 제거) — 빌드 시 1회 헤드리스 기동
RUN soffice --headless --terminate_after_init || true

WORKDIR /app
COPY . .
RUN npm ci && npm run build

EXPOSE 8080
CMD ["node", "dist/server.js"]
```

주의:

- H2Orestart 릴리스 URL/자산명은 배포 전 실제 릴리스에서 확인해 고정한다 (`unopkg list --shared`로 설치 검증).
- 폰트 미설치는 렌더링 깨짐의 최대 원인이다. 나눔/노토 CJK를 반드시 포함하고, 빌드 후 대표 HWP 1건을 렌더해 폰트 substitution 경고를 확인한다.
- LibreOffice 프로필(`$HOME/.config/libreoffice`)이 쓰기 가능하도록 Cloud Run에서 `HOME`을 쓰기 가능 경로로 지정한다.

## 4. API 계약 (마스터 12장 + pipeline-design 입출력 기준)

베이스: 변환 서버 내부 API. 웹앱은 서버-투-서버로만 호출한다 (공개 노출 안 함, 공유 시크릿 헤더).

### 4.1 `POST /v1/conversion-jobs`

요청:

```json
{
  "jobId": "uuid",
  "source": "bizinfo",
  "sourceId": "PBLN000000000012345",
  "surfaceId": "uuid",
  "filename": "사업계획서.hwp",
  "sourceObjectUrl": "https://.../grant-archive/.../파일.hwp",
  "sha256": "abc123...",
  "requestedArtifacts": ["pdf", "page_images", "markdown"],
  "options": { "pageImageDpi": 220 }
}
```

- `sourceObjectUrl`: R2 공개 URL 또는 presigned GET. 변환 서버가 직접 내려받는다.
- `sha256`: 캐시 키의 일부이자 무결성 확인 기준. 서버가 다운로드 후 재계산해 대조한다.
- `requestedArtifacts`: `layout_json`은 Phase 2에서 요청받아도 무시하거나 빈 자리표시만 남긴다.

응답 (202):

```json
{ "jobId": "uuid", "status": "queued", "cached": false }
```

- 동일 `sha256 + converterVersion` 결과가 이미 있으면 `{ "status": "succeeded", "cached": true, "artifacts": [...] }`를 즉시 반환한다.

### 4.2 `GET /v1/conversion-jobs/:jobId`

```json
{
  "jobId": "uuid",
  "status": "queued | running | succeeded | partial | failed",
  "converterVersion": "conv-2026.07-lo26.2-h2o0.7.13",
  "quality": {
    "renderEngine": "libreoffice-h2orestart",
    "pdfRendered": true,
    "pageCount": 8,
    "pageImageDpi": 220,
    "textCoverage": 0.92,
    "warnings": [],
    "status": "usable"
  },
  "error": null,
  "startedAt": "...",
  "finishedAt": "..."
}
```

`status` 정의:

- `succeeded`: 요청 artifact 전부 생성
- `partial`: PDF는 됐으나 일부 단계 실패 (예: markdown 추출 실패) — 부분 결과 사용 가능
- `failed`: PDF 렌더링 자체 실패 (원본 다운로드 fallback)

### 4.3 `GET /v1/conversion-jobs/:jobId/artifacts`

```json
{
  "jobId": "uuid",
  "artifacts": [
    { "kind": "pdf", "storageKey": "grant-convert/bizinfo/PBLN.../abc1234567890abc-사업계획서.pdf",
      "url": "https://.../...", "sha256": "...", "contentType": "application/pdf",
      "metadata": { "pageCount": 8 } },
    { "kind": "page_image", "page": 1, "storageKey": "...", "url": "...", "sha256": "...",
      "contentType": "image/png", "metadata": { "width": 1700, "height": 2400, "dpi": 220 } },
    { "kind": "markdown", "storageKey": "...", "url": "...", "sha256": "...",
      "contentType": "text/markdown; charset=utf-8",
      "metadata": { "charCount": 4210, "converter": "pyhwp-hwp5html" } }
  ]
}
```

- 각 artifact는 `document_artifacts` 행 1개에 대응한다. 웹앱은 이 응답을 그대로 upsert한다.
- URL은 R2 공개 URL. metadata 스키마는 kind별로 다르며 `document_artifacts.metadata` jsonb에 저장된다.

## 5. 변환 파이프라인 단계

문서 1건 처리 순서. 각 단계는 실패해도 이전 단계 결과를 버리지 않는다 (부분 성공).

```txt
1. 무결성 확인
   - sourceObjectUrl 다운로드 -> sha256 재계산해 요청값과 대조 (불일치 시 즉시 failed)
   - MIME/확장자 판정 (hwp/hwpx/pdf/docx)
   - 암호화 여부 탐지 (HWP FileHeader 암호 플래그 / PDF /Encrypt) -> 암호화면 failed + warning
   - 파일 크기 상한 확인 (기본 50MB 초과 시 failed)

2. PDF 렌더링 (핵심 단계)
   - hwp/hwpx/docx: soffice --headless --convert-to pdf (H2Orestart 필터)
   - pdf: 원본을 pdf artifact로 그대로 채택 (재렌더 안 함)
   - 실패 시: status=failed, 이후 단계 중단, 원본 다운로드 fallback만 남김

3. page image 생성
   - pdftoppm -png -r <dpi> (기본 220, 옵션 300)
   - 페이지별 PNG -> page_image artifact
   - 실패 시: status=partial, warning 추가, pdf는 유지

4. 텍스트/markdown 추출
   - hwp/hwpx: convertHwpBufferToMarkdown() (pyhwp hwp5html / hwpx-xml-unzip) 재사용
   - pdf: pdftotext -layout
   - docx: soffice --convert-to txt:Text (또는 markdown 필터)
   - 실패 시: status=partial, textCoverage=0, warning 추가

5. quality score 산출 (6장)

6. R2 업로드
   - pdf / page_image[] / markdown 을 각각 putObject (7장 키 규칙)

7. document_artifacts insert (웹앱이 artifacts 응답으로 수행)
```

**부분 성공 규칙 요약**:

- PDF 실패 = 문서 `failed`. 나머지 단계 시도 안 함.
- PDF 성공 + (page_image 또는 markdown) 실패 = `partial`. 성공한 artifact는 저장하고 warning 기록.
- 전부 성공 = `succeeded`.

## 6. Quality Score 정의

마스터 13장 `DocumentQualityGate`와 필드 정합. Phase 2는 vision/reconciliation 전이므로 `visualTextAgreement`·`requiredFieldCoverage`·`fieldCandidateCount`는 아직 채우지 않고 `null`로 남긴다 (Phase 4에서 채움).

```ts
interface Phase2ConversionQuality {
  pdfRendered: boolean;        // 2단계 성공 여부
  pageImagesRendered: boolean; // 3단계 성공 여부
  textExtracted: boolean;      // 4단계 성공 여부
  renderEngine: "libreoffice-h2orestart" | "pdf-passthrough";
  pageCount: number;
  pageImageDpi: 220 | 300;
  textCoverage: number;        // 아래 정의
  warnings: string[];
  status: "usable" | "usable_with_review" | "manual_required" | "failed";
}
```

- **textCoverage** (추정): 마크다운 글자수 기반. `min(1, extractedCharCount / (pageCount * EXPECTED_CHARS_PER_PAGE))`. `EXPECTED_CHARS_PER_PAGE` 기본 800 (양식류 밀도), Gate 2 분포로 보정. 텍스트 추출 실패 시 0.
- **warnings** 예: `font_substitution`, `page_image_partial`, `text_extraction_failed`, `encrypted_source`, `oversize_source`, `sha256_mismatch`.
- **status 판정 (Phase 2 잠정)**:
  - `failed`: pdfRendered=false
  - `manual_required`: pdfRendered=true, textExtracted=false (이미지만 있음)
  - `usable_with_review`: textCoverage < 0.7 또는 warnings에 심각 항목
  - `usable`: pdfRendered && pageImagesRendered && textCoverage >= 0.7

임계값 0.7은 마스터 13장과 동일한 잠정치. Gate 2에서 캘리브레이션.

## 7. R2 Storage Key 규칙

기존 `grantAttachmentArchive.ts`의 `objectKey()` 스타일을 따른다 (sha256 앞 16자 프리픽스, `sanitizeKeyPart`).

```txt
grant-convert/<source>/<sourceId>/<kind>/<sha256[0:16]>-<sanitizedName>

예:
grant-convert/bizinfo/PBLN.../pdf/abc1234567890abc-사업계획서.pdf
grant-convert/bizinfo/PBLN.../page_image/abc1234567890abc-사업계획서-p001.png
grant-convert/bizinfo/PBLN.../markdown/abc1234567890abc-사업계획서.md
```

- `sha256`는 **원본 파일**의 sha256이다 (변환 결과가 아니라 입력). 같은 원본 = 같은 프리픽스 = 캐시 재사용.
- page_image는 `-p{page:3d}` suffix로 페이지를 구분한다.
- `document_artifacts.sha256`에는 **artifact 자체**의 sha256을 저장하고 (무결성/dedup), storage key 프리픽스에는 원본 sha256을 쓴다. 캐시 조회는 `grant_attachment_archives.sha256 + converterVersion`으로 한다.

## 8. 웹앱 연동

### 8.1 아카이브 후크

`archiveOneAttachment()` (grantAttachmentArchive.ts)에서 R2 업로드·markdown 변환이 끝난 뒤, 변환 대상 포맷이면 surface 생성 + 변환 job 등록을 이어붙인다.

```txt
attachment 아카이브 완료 (기존)
  -> 변환 대상 포맷인가? (hwp/hwpx/pdf/docx)
     -> grant_application_surfaces upsert (type=file_template, format=..., extraction_status=pending)
     -> POST /v1/conversion-jobs (sourceObjectUrl=archive_url, sha256=원본 sha256, surfaceId)
```

- 후크는 아카이브 트랜잭션을 막지 않는다 (fire-and-forget + 재시도 큐). 변환 실패가 아카이브를 롤백하지 않는다.
- 캐시 히트(`cached:true`)면 job 없이 artifact upsert만 수행한다.

### 8.2 surface 레코드 생성/갱신

- surface upsert 키: `(source, sourceId, type, sourceAttachment, sourceUrl)` (기존 unique index `grant_application_surfaces_source_attachment_idx`).
- `sourceAttachment` = 아카이브의 `storage_key` (또는 filename). `format`은 확장자에서 판정.
- job 등록 시 `extraction_status=pending`, `extraction_version=<converterVersion>`.

### 8.3 extraction_status 전이

```txt
pending          (surface 생성 / job 등록 직후)
  -> preview_ready  (job succeeded/partial: pdf + page_image artifact 저장 완료)
  -> failed         (job failed: pdf 렌더링 실패)

(fields_ready 는 Phase 4 reconciliation 이후. Phase 2는 preview_ready 까지만.)
```

- 웹앱은 job 상태를 폴링하거나, 변환 서버가 완료 콜백(선택)을 보낸다. Phase 2는 **웹앱 폴링**으로 단순화 (콜백은 나중에).
- artifact upsert는 `GET /:jobId/artifacts` 결과를 `document_artifacts`에 `surfaceKindIdx`(surface_id, kind, page) 기준 upsert.

## 9. 로컬 개발 / 테스트

### 9.1 시드 재사용

Gate 0 산출물을 그대로 시드로 쓴다.

- `scripts/spike/hwp-render-spike.mjs`의 `convertWithLo` / `thumbnails` 로직을 변환 서버 core 모듈로 승격한다 (soffice 호출 인자, pdftoppm 호출이 이미 검증됨).
- `spike-samples/` · `spike-samples2/`의 60개 HWP/HWPX를 통합 테스트 픽스처로 사용한다. 기대치: 렌더링 60/60.

### 9.2 docker compose

```yaml
services:
  conversion:
    build: ./apps/conversion   # 3장 Dockerfile
    ports: ["8080:8080"]
    environment:
      - CONVERSION_SHARED_SECRET=dev-secret
      - R2_ACCOUNT_ID=...
      - R2_ACCESS_KEY_ID=...
      - R2_SECRET_ACCESS_KEY=...
      - R2_BUCKET=...
      - R2_BUCKET_URL=...
      - HOME=/tmp/loprofile
    volumes:
      - ./spike-samples:/samples:ro   # 로컬 검증용 시드
```

로컬 검증:

```bash
# 컨테이너 안에서 시드 60건 배치 렌더 (soffice 정상 확인)
docker compose run conversion node dist/tools/render-batch.js /samples

# API 왕복 스모크
curl -X POST localhost:8080/v1/conversion-jobs -H "x-shared-secret: dev-secret" \
  -d @fixtures/job.json
curl localhost:8080/v1/conversion-jobs/<jobId>
```

## 10. 구현 태스크 분해

반나절~1일 단위. 순서 = 의존성 순.

| # | 태스크 | 산출물 | 의존 | 검증 |
|---|---|---|---|---|
| T1 | `apps/conversion` 스캐폴드 + Dockerfile (3장) | 빌드되는 컨테이너, soffice+H2O+pyhwp+poppler 설치 검증 | — | `unopkg list --shared`에 H2Orestart, `soffice --version`, 시드 1건 렌더 |
| T2 | core 변환 모듈 (스파이크 승격): 무결성확인·soffice PDF·pdftoppm·텍스트추출 | `convertDocument(buffer, opts) -> {pdf, pages[], markdown, quality}` | T1 | 시드 60건 배치 렌더 60/60, quality 필드 채워짐 |
| T3 | quality score 산출 (6장) + status 판정 | `computeQuality()` 순수 함수 | T2 | 정상/텍스트실패/렌더실패 3케이스 단위 테스트 |
| T4 | R2 업로드 + storage key 규칙 (7장) | `uploadArtifacts()` (R2ObjectStorage 재사용) | T2 | 업로드 후 공개 URL GET 200, 키 프리픽스=원본 sha256 앞 16자 |
| T5 | 내부 순차 큐 + 워커 풀 (동시성 2, 프로세스 1건당 격리) | in-process 큐, job 상태 저장 | T2 | 동시 10건 등록 시 순차 완료, hang 없음 |
| T6 | API 라우트 3종 (4장) + 캐시 히트 처리 + shared secret | `POST/GET/GET` 핸들러 | T4,T5 | 스모크 왕복, 동일 sha256 2회 등록 시 2번째 `cached:true` |
| T7 | 웹앱: 아카이브 후크 + surface upsert + job 등록 (8.1~8.2) | `grantAttachmentArchive.ts` 확장 | T6 | 아카이브 시 surface pending 생성 + job 등록 확인 |
| T8 | 웹앱: job 폴링 + artifact upsert + status 전이 (8.3) | 폴링 워커/라우트, `document_artifacts` upsert | T7 | pending -> preview_ready 전이, artifact 행 생성 |
| T9 | 통합 테스트 + 실패 경로 (11장) | 부분성공/타임아웃/암호화 케이스 | T8 | 부분성공=partial, 타임아웃=failed, 암호화=failed+warning |
| T10 | Cloud Run 배포 + 시크릿 + HOME 쓰기경로 | 배포된 service URL | T9 | 프로덕션 스모크, 시드 5건 왕복 |

`layout_json`은 스키마 자리(`document_artifacts.kind='layout_json'`)만 유지하고 T2에서 생성하지 않는다.

## 11. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| **LibreOffice 프로세스 hang** | soffice 호출에 타임아웃(문서당 120s, 스파이크 검증치). 초과 시 프로세스 kill + job failed. 프로세스는 문서 1건당 새로 띄우고 종료 (인스턴스 재사용 금지). 워커에 연속 실패 감지 시 컨테이너 self-restart. |
| **폰트 누락 (렌더 깨짐)** | 나눔/노토 CJK를 Dockerfile에 포함 (3장). 빌드 후 대표 HWP 렌더해 font substitution 경고 확인. 누락 폰트는 quality warnings에 `font_substitution` 기록. |
| **동시성** | 하루 수백 건 규모이므로 in-process 순차 큐 + 동시성 2로 충분. soffice는 동일 프로필 동시 사용 시 충돌하므로 워커별 `HOME` 격리(임시 프로필 디렉토리). 처리량 부족 시에만 안 B(Jobs)로 확장. |
| **암호화 HWP/PDF** | 무결성 단계에서 탐지(HWP FileHeader 암호 플래그, PDF `/Encrypt`). 복호화 시도 안 함. `failed` + warning `encrypted_source`. 웹앱은 원본 다운로드 fallback UX 노출. |
| **대용량 파일** | 기본 상한 50MB. 초과 시 `failed` + `oversize_source`. page image는 페이지 수 상한(예: 100p) 두어 이미지 폭증 방지. |
| **sha256 불일치** | 다운로드 후 재계산 대조. 불일치면 원본이 바뀐 것이므로 캐시 무효화하고 재변환하거나, 요청 오류로 `failed` + `sha256_mismatch`. |
| **H2Orestart 릴리스 URL 변동** | 버전(0.7.13)과 자산 URL을 Dockerfile ARG로 고정. 설치 후 `unopkg list --shared`로 검증하는 빌드 스텝 추가. |
| **캐시 오염 (converter 버전업)** | 캐시 키에 `converterVersion` 포함. 렌더러/추출기 버전 올리면 키가 바뀌어 자동 재변환. 기존 artifact는 남겨두고 신 버전으로 덮어쓰기(upsert). |

## 12. T10 배포 실행 스펙 (2026-07-03 위임 — Opus 서브에이전트)

전제 (메인 세션에서 완료): GCP 프로젝트 `changupnote-com`(결제 연결), API 활성화(run·artifactregistry·secretmanager), Artifact Registry repo `cunote`(asia-northeast3, docker), Secret Manager 5종 등록(`CONVERSION_SHARED_SECRET` 신규 생성 + `R2_*` 4종은 `.env` 재사용). gcloud 로컬 인증 완료.

### 결정 사항

- **이미지 빌드는 Cloud Build** (native amd64). 로컬 맥은 arm64라 에뮬레이션 크로스빌드의 리스크(soffice 워밍업 hang 등)를 피한다. `cloudbuild.googleapis.com` 활성화 필요. Cloud Build 기본 타임아웃 10분은 부족 — `timeout: 1800s` + `machineType: E2_HIGHCPU_8` 지정
- **Dockerfile 사전 수정 2건** (샌드박스에 Docker가 없어 이 Dockerfile은 실빌드 이력 없음):
  1. `@cunote/core`가 `@cunote/contracts`에 의존하므로 빌드 체인을 contracts → core → conversion으로 보정
  2. `corepack prepare pnpm@latest` → `pnpm@10.30.1` 고정 (package.json `packageManager`·lockfile과 일치)
- **Cloud Run 배포**: service `cunote-conversion`, region asia-northeast3, `--allow-unauthenticated`(인증은 앱 레벨 shared secret — 4장 설계), `--memory 2Gi --cpu 2`, **`--max-instances 1`**(인메모리 큐·job 상태·캐시가 인스턴스 로컬이므로 폴링 일관성 필수), `--timeout 300`(POST는 즉시 202 응답), `--set-secrets`로 5종 연결. 런타임 SA에 `roles/secretmanager.secretAccessor` 필요 시 부여
- **키 프리픽스 2단계**: 스모크 동안 `CONVERSION_KEY_PREFIX=conversion-dev`로 배포 → 스모크 통과 후 `grant-convert`로 env 갱신 (최종 상태). 검증 산출물이 프로덕션 프리픽스를 오염시키지 않기 위함 (저장소 관례)
- **spike-samples는 gitignore**라 Cloud Build 컨텍스트에서 제외됨 → 인빌드 렌더 검증은 생략하고, H2Orestart 렌더의 프로덕션 첫 검증은 배포 후 스모크가 겸한다

### 스모크 (T10 통과 판정)

시드 5건(HWP 2 · HWPX 1 · PDF 1 · DOCX 1, `spike-samples/files`에서 선정) 왕복: `/healthz` → 잘못된 secret 401 → POST 등록 → 폴링 → artifacts 목록 → R2 인증 GET으로 산출물 실재 확인 → 동일 sha256 재등록 `cached:true`. 스크립트는 `verify-api.mjs` 패턴을 원격 URL 대상으로 옮긴 `smoke-remote.mjs`로 저장 (재사용 가능하게).

### 완료 후 메인 세션 인계

service URL·리비전·스모크 결과 보고 → 메인 세션이 검증·문서 갱신·커밋. 이후 사용자 액션: Vercel(dev)에 `CONVERSION_SERVER_URL` + `CONVERSION_SHARED_SECRET` 등록 (infra-setup-guide A7).

### 실행 결과 (2026-07-03)

- **service URL**: `https://cunote-conversion-644631753751.asia-northeast3.run.app`
- 이미지: `asia-northeast3-docker.pkg.dev/changupnote-com/cunote/conversion:t10-rc2` (Cloud Build, amd64)
- Dockerfile 결함 3건 수정 (전부 이미지 첫 실빌드·첫 실행에서 발견):
  1. **빌드 체인**: contracts 빌드 누락 보정 + pnpm 10.30.1 고정 (스펙 예고분)
  2. **JVM 탐지**: LibreOffice jvmfwk가 JRE를 못 찾아 unopkg의 H2Orestart 등록 실패 → `libreoffice-java-common` 추가 + `JAVA_HOME` 명시 (Cloud Build 1차 실패에서 발견)
  3. **UTF-8 로케일**: 로케일 미설정 시 JVM 파일명 인코딩(sun.jnu.encoding)이 ASCII → H2Orestart가 **한글 파일명 HWP/HWPX를 열지 못함** (스모크 1차에서 HWP/HWPX 전건 FileNotFoundException). `LANG`/`LC_ALL=C.UTF-8` 고정으로 해결. 샌드박스·Gate 0 검증은 UTF-8 로케일 환경이라 재현되지 않았음
- **인증 구조 변경 (조직 정책 대응)**: 조직 DRS로 `allUsers` invoker 불가 → `--allow-unauthenticated` 대신 **`--no-invoker-iam-check`**. 앱 레벨 shared secret이 유일한 인증(4장 설계 그대로)
- **run.app `/healthz` 가로채기**: Google 프런트엔드가 run.app URL의 `/healthz`를 컨테이너에 전달하지 않고 Google 404를 반환. 원격 도달성 확인은 `GET /` → 앱 401로 대체 (smoke-remote.mjs 반영). 진단 과정에서 이 현상이 "이미지별 라우팅 차단"으로 오인돼 우회 시도가 길어졌음 — 후속 배포 검증 시 참고
- 배포 설정: 2Gi/2cpu, max-instances 1(인메모리 큐 일관성), timeout 300, Secret Manager 5종 연결, `R2_BUCKET_URL`은 일반 env(공개 URL — 스펙의 시크릿 5종에 누락됐던 필수 env, storage.ts가 요구)
- **스모크 5/5 PASS** (t10-rc2, `pnpm`+`node apps/conversion/scripts/smoke-remote.mjs <URL>`): HWP 2건 succeeded/usable_with_review(8p·6p, artifacts 10·8), HWPX succeeded(11p, 13), PDF succeeded/usable(1p, 3), DOCX succeeded/usable(14p, 16). 전 artifact R2 실재 확인, 동일 sha256 재등록 cached:true, 잘못된 secret 401. 최종 리비전 `cunote-conversion-00004-b2t` (`CONVERSION_KEY_PREFIX=grant-convert`)
- **후속 권고**: 큐가 임시 디렉토리에 원본을 **원 파일명 그대로** 쓰는 대신 `source.<ext>`로 정규화하면 로케일 무관하게 견고해짐 (Phase 3 전 소규모 개선 후보)

## 13. 다음 단계 (Phase 3~4로 이관)

- Phase 3: page image viewer + field overlay UI (artifact 소비 측)
- Phase 4: `layout_json` 실제 생성 (Document AI or 자체 layout) + vision pass + reconciliation. 이때 quality의 `visualTextAgreement`·`requiredFieldCoverage`를 채우고 `fields_ready` 전이를 완성한다.
- 대량 재처리(converter 버전업) 수요가 생기면 안 B(Cloud Run Jobs)를 같은 이미지로 추가.
