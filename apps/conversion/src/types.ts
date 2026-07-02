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
}

/** convertDocument 출력. */
export interface ConvertDocumentResult {
  sha256: string; // 원본 파일 sha256 (재계산값)
  format: DocumentFormat | null; // 인식 실패 시 null
  converterVersion: string;
  pdf: PdfArtifact | null;
  pageImages: PageImageArtifact[];
  markdown: MarkdownArtifact | null;
  quality: Phase2ConversionQuality;
  /** 최상위 job 상태 (quality.status와 별개인 job 관점 상태). */
  jobStatus: "succeeded" | "partial" | "failed";
  error: string | null;
}
