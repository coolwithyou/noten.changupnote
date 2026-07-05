/**
 * 문서 좌표계 공용 유틸 (마스터 설계 §8.4 — 0~1 정규화 · top-left 원점).
 *
 * 클라이언트 안전한 순수 함수만 둔다 (DB/R2/서버 의존 없음). 내부 리뷰어 뷰어의
 * `bbox: [x, y, w, h]` 라벨과 P4 Vision 후보의 `{ x, y, width, height }` 를 하나의
 * 정규화 타입(`NormalizedBox`)으로 수렴시킨다. 사용자용 Preview Viewer 오버레이가
 * 이 타입으로 CSS `%` 포지셔닝을 만든다.
 */

/** 0~1 정규화 박스. 원점은 좌상단(top-left). §8.4 좌표계 규칙. */
export interface NormalizedBox {
  /** 좌상단 x (0~1). */
  x: number;
  /** 좌상단 y (0~1). */
  y: number;
  /** 너비 (0~1). */
  width: number;
  /** 높이 (0~1). */
  height: number;
}

/** 값을 [0, 1] 로 자른다. 비유한값은 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// 좌표 검증 허용 오차. 렌더/파싱 반올림으로 1.0 을 아주 살짝 넘는 경우를 통과시킨다.
const BOUND_EPSILON = 1e-3;

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 원시 튜플/객체 → NormalizedBox. 유효 범위를 벗어나면 null.
 * 허용 입력:
 *   - 배열 `[x, y, w, h]` (리뷰어 라벨 형태)
 *   - 객체 `{ x, y, width, height }` (Vision 후보 형태)
 *   - 객체 `{ x, y, w, h }` (약식)
 */
export function parseBbox(value: unknown): NormalizedBox | null {
  let x: unknown;
  let y: unknown;
  let width: unknown;
  let height: unknown;

  if (Array.isArray(value)) {
    if (value.length < 4) return null;
    [x, y, width, height] = value;
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    x = record.x;
    y = record.y;
    width = record.width ?? record.w;
    height = record.height ?? record.h;
  } else {
    return null;
  }

  if (!isUnit(x) || !isUnit(y) || !isUnit(width) || !isUnit(height)) return null;

  // 범위 검증: 좌상단은 [0,1], 크기는 (0,1], 우하단은 1+eps 이내.
  if (x < -BOUND_EPSILON || x > 1 + BOUND_EPSILON) return null;
  if (y < -BOUND_EPSILON || y > 1 + BOUND_EPSILON) return null;
  if (width <= 0 || height <= 0) return null;
  if (width > 1 + BOUND_EPSILON || height > 1 + BOUND_EPSILON) return null;
  if (x + width > 1 + BOUND_EPSILON) return null;
  if (y + height > 1 + BOUND_EPSILON) return null;

  return {
    x: clamp01(x),
    y: clamp01(y),
    width: clamp01(width),
    height: clamp01(height),
  };
}

/**
 * `grant_document_fields.position` jsonb → NormalizedBox.
 * position 은 `{ page, bbox, ... }` 형태이며 bbox 는 배열/객체 모두 수용한다.
 * position 자체가 곧 bbox(배열/객체)인 경우도 받아준다.
 */
export function parsePositionBbox(position: unknown): NormalizedBox | null {
  if (position == null) return null;
  if (Array.isArray(position)) return parseBbox(position);
  if (typeof position === "object") {
    const record = position as Record<string, unknown>;
    if ("bbox" in record) return parseBbox(record.bbox);
    // page 만 있고 bbox 가 없는 위치정보는 좌표 없음으로 취급.
    if ("x" in record || "width" in record || "w" in record) return parseBbox(record);
    return null;
  }
  return null;
}

/** `position.page` (1-based) 를 추출한다. 없거나 비정상이면 null. */
export function parsePositionPage(position: unknown): number | null {
  if (position && typeof position === "object" && !Array.isArray(position)) {
    const page = (position as Record<string, unknown>).page;
    if (typeof page === "number" && Number.isInteger(page) && page >= 1) return page;
  }
  return null;
}

/** CSS 인라인 `%` 스타일. absolute 오버레이 요소에 그대로 적용한다. */
export function boxToPercentStyle(box: NormalizedBox): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  };
}
