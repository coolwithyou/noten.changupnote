/**
 * Gate 2 layout 엔진 어댑터 공용 타입.
 *
 * 단일 원천:
 *   - docs/plans/2026-07-04-gate2-layout-adapters.md §3 (아키텍처)
 *   - docs/research/2026-07-04-gate2-layout-adapters-calibration.md §2~§5 (통합 사실)
 *   - docs/public-support-application-guide-master-architecture.md §8.4 (좌표계·VisionFieldCandidate)
 *
 * 설계 요지:
 *   - 어댑터는 "네트워크 호출(fetch*)"과 "순수 정규화(normalize*)"를 분리한다.
 *     · fetch* 는 캐시 미스에서만 호출 → 원시 응답을 반환한다.
 *     · normalize* 는 원시 응답(캐시 히트/미스 무관)을 NormalizedFieldCandidate[] 로 변환하는 순수 함수다.
 *       (정규화 로직은 normalize.ts 에 모으고 어댑터는 그것을 위임 호출한다 — 픽스처 단위 테스트 대상)
 *   - 이 분리 덕분에 per-page 캐시 멱등(2회차 API 0건)과 합성 픽스처 테스트가 동시에 가능하다.
 *
 * 스펙 참고: 위임 스펙(§5)의 "extract(input) → { candidates, rawResponse, engineVersion, estimatedCostUsd }"
 *   결과 묶음은 러너가 fetch()/normalize()/costPerPageUsd 를 조합해 산출한다(§ run-layout-eval.ts).
 */

/** 0~1 정규화 축정렬 경계상자 [x, y, w, h]. 골든 라벨 bbox 와 동일 포맷. */
export type BBox = [number, number, number, number];

/** 후보 종류 — 마스터 §8.4 VisionFieldCandidate.kind 어휘 + unknown 폴백. */
export type CandidateKind =
  | "text_input"
  | "long_text"
  | "checkbox"
  | "table_cell"
  | "signature"
  | "stamp"
  | "file_attach"
  | "instruction"
  | "unknown";

/** 후보 계층. layout 엔진(bbox 소유자) vs text parser(§8.5, kordoc — bbox 없음). */
export type CandidateLayer = "layout" | "text_parser";

/**
 * 정규화 후보 — 골든 라벨 필드와 직접 비교 가능한 형태.
 * 위임 스펙: `{ page, bbox: [x,y,w,h] | null, kind, label, text, raw }` 를 확장한다.
 *   - bboxSource / rotationDeg 는 §8.4 좌표계 규칙(회전각 메타 보존, viewer snap)용.
 *   - layer 는 kordoc(text_parser)을 layout 측정표와 분리하기 위한 표식(대조 §5-7).
 *   - confidence 는 소스 per-element 신뢰도(§13 합성 confidence 입력) — 없으면 null.
 *   exactOptionalPropertyTypes 준수를 위해 부가 필드는 optional 대신 `| null` 로 항상 존재시킨다.
 */
export interface NormalizedFieldCandidate {
  /** 1-기준 페이지 번호. bbox 없는 text parser 후보는 null. */
  page: number | null;
  /** 0~1 [x,y,w,h]. layout 엔진은 값, text parser(kordoc)는 null. */
  bbox: BBox | null;
  bboxSource: "layout" | "text_parser" | null;
  layer: CandidateLayer;
  kind: CandidateKind;
  label: string;
  text: string;
  confidence: number | null;
  /** 회전각(도) 메타. Azure page.angle / Upstage 회전 개선 등. 없으면 null. */
  rotationDeg: number | null;
  /** 원시 요소(디버그·추적용). */
  raw: Record<string, unknown>;
}

/** 어댑터 실행 단위. page = 페이지 이미지 1장, document = 원본 파일 전체(kordoc). */
export type AdapterMode = "page" | "document";

/** 페이지 이미지 입력(layout 엔진). */
export interface PageInput {
  docId: string;
  /** 1-기준 문서 페이지 번호. */
  page: number;
  /** 로컬 페이지 PNG 절대경로 (spike-labels/pages/docNN-PP.png). */
  pngPath: string;
}

/** 원본 파일 입력(kordoc). */
export interface DocumentInput {
  docId: string;
  docRef: string;
  /** 매칭된 원본 파일 절대경로 (spike-samplesN/files). */
  sourceFilePath: string;
}

/**
 * layout 엔진 어댑터 인터페이스.
 *   - fetch* : 네트워크 호출(캐시 미스 전용). 미지원 모드는 명시적 throw.
 *   - normalize* : 순수 변환(캐시 히트/미스 공통). normalize.ts 위임.
 */
export interface LayoutEngineAdapter {
  /** 러너/캐시 키에 쓰는 안정 식별자 (예: "upstage"). */
  readonly name: string;
  readonly layer: CandidateLayer;
  readonly mode: AdapterMode;
  /** 미설정 스킵 사유 메시지에 쓰는 요구 힌트 (예: "UPSTAGE_API_KEY"). */
  readonly requires: string;
  /** 페이지당 비용 추정 USD. 0 이면 무료(로컬). >0 이면 유료 → 러너 paid-guard 대상. */
  readonly costPerPageUsd: number;
  /** 필요한 env/자원이 설정됐는지. false 면 러너가 "미설정 — 스킵". */
  isConfigured(): boolean;
  /** 캐시 키에 쓰는 엔진 버전 문자열(모델/프로세서/라이브러리 버전). */
  engineVersion(): string;
  /** 페이지 이미지 1장 → 원시 응답. document 모드 어댑터는 throw. */
  fetchPage(input: PageInput): Promise<unknown>;
  /** 원본 파일 전체 → 원시 응답. page 모드 어댑터는 throw. */
  fetchDocument(input: DocumentInput): Promise<unknown>;
  /** 원시 응답 → 정규화 후보 (page 모드). */
  normalizePage(raw: unknown, ctx: PageInput): NormalizedFieldCandidate[];
  /** 원시 응답 → 정규화 후보 (document 모드). */
  normalizeDocument(raw: unknown, ctx: DocumentInput): NormalizedFieldCandidate[];
}

/** page 모드 어댑터에서 fetchDocument 호출 시. */
export function unsupportedDocumentMode(engine: string): never {
  throw new Error(`${engine}: page 모드 어댑터입니다. fetchDocument 를 지원하지 않습니다.`);
}

/** document 모드 어댑터에서 fetchPage 호출 시. */
export function unsupportedPageMode(engine: string): never {
  throw new Error(`${engine}: document 모드 어댑터입니다. fetchPage 를 지원하지 않습니다.`);
}
