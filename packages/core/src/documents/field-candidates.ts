/**
 * 필드 후보 정본 타입 (Phase 4 [F] · 마스터 설계 §8.4~§8.6).
 *
 * 단일 원천 이동:
 *   - 이전에는 `apps/web/src/lib/server/layout-eval/types.ts` 가 이 타입들을 소유했으나,
 *     이는 Gate 2 eval 전용 디렉터리라 프로덕션 정본이 아니었다. Phase 4 에서
 *     `BBox`/`CandidateKind`/`CandidateLayer`/`NormalizedFieldCandidate` 를 core 로 승격하고
 *     `+ CandidateSet` 을 추가한다. layout-eval/types.ts 는 이제 여기서 re-export 한다
 *     (기존 import 경로 무파괴 — `pnpm eval:layout` 인프라 계속 동작).
 *
 * 좌표계: §8.4 — 0~1 정규화, 원점은 좌상단(top-left). bbox 는 [x, y, w, h].
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
  /** 원시 요소(디버그·추적·textEvidence 소스). */
  raw: Record<string, unknown>;
}

/**
 * 한 엔진(또는 text parser)의 후보 묶음. 저장 계층(F3)의 직렬화 단위이자
 * reconciliation(F4)의 입력 단위. 하나의 surface 는 여러 CandidateSet 을 가질 수 있다
 * (layout 엔진 1 + text parser 1 등).
 */
export interface CandidateSet {
  /** 후보를 생성한 엔진/파서 식별자 (예: "upstage", "kordoc", "text-parser"). */
  engine: string;
  /** 엔진/파서 버전 문자열 (캐시·재현성). */
  engineVersion: string;
  /** 이 묶음의 계층. */
  layer: CandidateLayer;
  /** 생성 시각 ISO8601. */
  extractedAt: string;
  candidates: NormalizedFieldCandidate[];
}
