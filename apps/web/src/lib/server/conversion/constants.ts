// Phase 2 변환 연동 공용 상수.
// apps/conversion/src/types.ts 의 CONVERTER_VERSION 과 동일 값을 유지한다
// (surface.extractionVersion / 캐시 키의 일부). 변환 서버 버전업 시 함께 올린다.

export const CONVERSION_CONVERTER_VERSION = "conv-2026.07-lo26.2-h2o0.7.13";

/**
 * 변환 job 에 요청하는 artifact 종류 (Phase 2).
 * "hwpx" 는 hwp2hwpx 트랙(docs/plans/2026-07-08-hwp2hwpx-track.md Phase 2): 입력이 hwp 바이너리일 때
 * 변환 서버가 STORE 정규화 hwpx sibling artifact(kind="hwpx")를 R2 에 올린다. hwpx 입력은 no-op.
 * 이후 등록되는 job 부터 적용되며(기존 캐시 히트분엔 없음 — 정상), 프로덕션 생성은 Cloud Run 재배포 이후.
 */
export const CONVERSION_REQUESTED_ARTIFACTS = ["pdf", "page_images", "markdown", "hwpx"] as const;
