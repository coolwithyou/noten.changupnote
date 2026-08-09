/**
 * 사람 검수 우선순위는 공고 디렉터리가 아니라 불변 run 단위다.
 * 같은 공고의 과거 run에 사람 검수가 있어도 새 prompt/model run의 AI 검수·감사를 막지 않는다.
 */
export function hasHumanReviewForRun(files: readonly string[], runId: string): boolean {
  return files.includes(`${runId}.review.json`);
}
