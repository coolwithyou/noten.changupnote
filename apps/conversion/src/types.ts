// Phase 2 문서 변환 서버 — 공용 타입.
// 계획: docs/phase2-conversion-server-implementation-plan.md (5장 파이프라인, 6장 quality)

/** 변환기 버전. 캐시 키의 일부 (sha256 + converterVersion). */
export const CONVERTER_VERSION = "conv-2026.07-lo26.2-h2o0.7.13";

/** 변환 대상으로 인식하는 포맷. */
export type DocumentFormat = "hwp" | "hwpx" | "pdf" | "docx";

/** quality status 전이. 계획 6장. */
export type ConversionQualityStatus =
  | "usable"
  | "usable_with_review"
  | "manual_required"
  | "failed";

/** 렌더 엔진 식별. */
export type RenderEngine = "libreoffice-h2orestart" | "pdf-passthrough";

/**
 * Phase 2 결정론적 변환 품질 지표. 마스터 13장 DocumentQualityGate 필드 정합.
 * vision/reconciliation 전이므로 관련 필드는 null (Phase 4에서 채움).
 */
export interface Phase2ConversionQuality {
  pdfRendered: boolean; // 2단계 성공 여부
  pageImagesRendered: boolean; // 3단계 성공 여부
  textExtracted: boolean; // 4단계 성공 여부
  renderEngine: RenderEngine | null; // 렌더 실패 시 null
  pageCount: number;
  pageImageDpi: 220 | 300;
  textCoverage: number; // 마크다운 글자수 기반 추정 (아래 정의)
  extractedCharCount: number;
  warnings: string[];
  status: ConversionQualityStatus;
  // Phase 4에서 채우는 필드 (지금은 null 고정)
  visualTextAgreement: number | null;
  requiredFieldCoverage: number | null;
  fieldCandidateCount: number | null;
}

/** 생성된 페이지 이미지 1건. */
export interface PageImageArtifact {
  page: number; // 1-based
  path: string; // 로컬 파일 경로 (업로드는 T4에서)
  width: number;
  height: number;
  dpi: 220 | 300;
  bytes: number;
}

/** 마크다운/텍스트 추출 결과. */
export interface MarkdownArtifact {
  path: string;
  text: string;
  charCount: number;
  converter: string; // "pyhwp-hwp5html" | "hwpx-xml-unzip-v1" | "pdftotext-layout" | "soffice-txt"
}

/** PDF artifact. */
export interface PdfArtifact {
  path: string;
  pageCount: number;
  bytes: number;
  renderEngine: RenderEngine;
}

/**
 * hwp2hwpx 변환 결과 분류 (hwp2hwpx 트랙 Phase 1).
 *  - converted            : .hwp(바이너리) → .hwpx 변환 + STORE 재포장 정규화 성공.
 *  - skipped_already_hwpx : 입력이 이미 hwpx(PK 매직) — 변환 불필요.
 *  - skipped_not_hwp_binary : 입력이 hwp 바이너리도 hwpx 도 아님(매직 바이트 기준).
 *  - converter_unavailable : jar/java 미탑재·spawn 실패(인프라) — 비치명 스킵.
 *  - hwp_v3x              : hwplib 이 HWP 5 아님으로 거부(3.x 등) — 커버리지 경계, 정직 스킵.
 *  - encrypted            : 암호/DRM 문서 — 정직 스킵.
 *  - distribution         : 배포용 문서 — 정직 스킵.
 *  - timeout              : java 프로세스 타임아웃.
 *  - conversion_error     : 그 외 변환 예외(분류 미상).
 *  - repack_failed        : 변환은 됐으나 STORE 재포장 정규화 실패.
 */
export type HwpxConversionOutcome =
  | "converted"
  | "skipped_already_hwpx"
  | "skipped_not_hwp_binary"
  | "converter_unavailable"
  | "hwp_v3x"
  | "encrypted"
  | "distribution"
  | "timeout"
  | "conversion_error"
  | "repack_failed";

/** 변환 성공 시 산출된 hwpx artifact (STORE 재포장 정규화 완료, 로컬 경로). */
export interface HwpxArtifact {
  path: string;
  bytes: number;
}

/** hwp→hwpx 변환 1건 결과(진단 포함). */
export interface HwpxConversionResult {
  outcome: HwpxConversionOutcome;
  /** outcome === "converted" 일 때만 non-null. */
  artifact: HwpxArtifact | null;
  /** 분류 근거(java stderr·예외 메시지 등). 성공/스킵 시 null 가능. */
  reason: string | null;
}

/** convertDocument 입력. */
export interface ConvertDocumentInput {
  /** 원본 파일 버퍼. */
  body: Buffer;
  /** 원본 파일명 (확장자 판정에 사용). */
  filename: string;
  /** 캐시/무결성 확인용 기대 sha256 (선택). 주어지면 재계산 후 대조. */
  expectedSha256?: string;
  /** page image DPI (기본 220). */
  pageImageDpi?: 220 | 300;
  /** 작업 디렉토리 (미지정 시 tmp에 생성). */
  workDir?: string;
  /** 임시 파일 보존 (디버그). */
  keepTmp?: boolean;
  /** soffice 타임아웃 ms (기본 120000). */
  sofficeTimeoutMs?: number;
  /** 파일 크기 상한 바이트 (기본 50MB). */
  maxBytes?: number;
  /** page image 페이지 수 상한 (기본 100). */
  maxPages?: number;
  /**
   * 요청된 artifact 종류. "hwpx" 포함 + 입력이 hwp 바이너리(매직 D0CF11E0)일 때만
   * hwp→hwpx 변환을 시도한다. 미포함이면 변환 스텝을 건너뛴다(기존 동작 불변).
   */
  requestedArtifacts?: string[];
}

/** convertDocument 출력. */
export interface ConvertDocumentResult {
  sha256: string; // 원본 파일 sha256 (재계산값)
  format: DocumentFormat | null; // 인식 실패 시 null
  converterVersion: string;
  pdf: PdfArtifact | null;
  pageImages: PageImageArtifact[];
  markdown: MarkdownArtifact | null;
  /** hwp→hwpx 변환 산출(요청·조건 충족 시). 미요청/미해당 시 null. */
  hwpx: HwpxArtifact | null;
  /** hwp→hwpx 변환 진단(분류). 미요청 시 null. */
  hwpxConversion: HwpxConversionResult | null;
  quality: Phase2ConversionQuality;
  /** 최상위 job 상태 (quality.status와 별개인 job 관점 상태). */
  jobStatus: "succeeded" | "partial" | "failed";
  error: string | null;
}
