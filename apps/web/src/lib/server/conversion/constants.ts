// Phase 2 변환 연동 공용 상수.
// apps/conversion/src/types.ts 의 CONVERTER_VERSION 과 동일 값을 유지한다
// (surface.extractionVersion / 캐시 키의 일부). 변환 서버 버전업 시 함께 올린다.

export const CONVERSION_CONVERTER_VERSION = "conv-2026.07-lo26.2-h2o0.7.13";

/** 변환 job 에 요청하는 artifact 종류 (Phase 2). */
export const CONVERSION_REQUESTED_ARTIFACTS = ["pdf", "page_images", "markdown"] as const;
