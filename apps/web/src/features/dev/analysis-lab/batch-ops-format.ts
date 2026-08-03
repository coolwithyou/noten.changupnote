// 배치 운영 탭 전용 표시 포맷터 — BatchOpsTab/FunnelBoard/Console/ProgressStream 이 공유한다.
// 서버 계약(contract.ts)과 무관한 순수 표시 유틸이며 다른 화면에서 가져다 쓰지 않는다.

/**
 * 명목 비용(USD) 표시 — 구독(claude-cli) transport 에서는 실지출이 아니라
 * 게이트 잣대용 명목 수치다(계획 §3-3 모드 카드 문구와 짝).
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$—";
  // 공고당 비용($0.03대)이 반올림으로 0 이 되지 않도록 1달러 미만은 세 자리.
  return `$${value.toFixed(Math.abs(value) < 1 ? 3 : 2)}`;
}

/** 소요 시간 — 90초 미만은 초, 이상은 분·초(진행 스트림·종료 요약 공용). */
export function formatDurationMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 90) return `${totalSec}초`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}분 ${sec}초` : `${min}분`;
}

/** ISO 시각 → "M. D. HH:mm" (ko-KR, 기기 로컬 = 실사용 KST). 파싱 불가면 원문 그대로. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
