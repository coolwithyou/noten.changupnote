import type { WorkspaceData } from "@/lib/server/documents/workspaceData";

/** 서버에서 관측한 기능만 설명한다. 매칭 적격·입력 완료·제출 완료를 추정하지 않는다. */
export function workspaceReadiness(data: Pick<WorkspaceData,
  "execution" | "ladder" | "draftId" | "headRevision" | "documentAgentAvailable" | "fieldEditorAgentAvailable"
>) {
  const persistent = data.execution.mode === "persistent";
  return {
    editing: data.ladder === "c" ? "초안 편집 지원 · 원본 양식 편집 미지원" : "원본 양식 편집 지원",
    suggestions: data.fieldEditorAgentAvailable || data.documentAgentAvailable
      ? "작성 제안 사용 가능 · 선택 후 반영" : "문서 편집 제안 미제공 · 직접 편집 가능",
    saving: !persistent ? "미리보기 · 계정 저장 안 됨"
      : !data.draftId ? "아직 저장할 초안 없음"
      : data.headRevision ? "서버 저장본으로 재개 · 이후 변경은 저장 상태 확인"
      : "초안 연결됨 · 편집본 서버 저장은 아직 확인되지 않음",
    finalReview: "다운로드는 제출 완료가 아닙니다. 서명·증빙·공고의 제출 방법을 직접 확인해주세요.",
  };
}
