import type { CompanyProfile } from "@cunote/contracts";

/** 실제 체크섬을 통과하지 않는 관리자 전용 비영속 지원서 시뮬레이션 번호. */
export const GRANT_SIMULATION_BUSINESS_NUMBER = "0000000099";

/** 매칭 판정이 아니라 빠른 작성 필드 연결만 확인하기 위한 비영속 최소 프로필. */
export function buildGrantSimulationCompanyProfile(): CompanyProfile {
  const asOf = new Date().toISOString();
  return {
    name: "관리자 지원서 시뮬레이션 기업",
    target_types: ["기업", "중소기업"],
    business_status: { active: true, label: "계속사업자" },
    list_completeness: { target_type: "complete" },
    confidence: { target_type: 1, business_status: 1 },
    profile_evidence: {
      target_type: {
        sourceKind: "self_declared",
        provider: "cunote_admin_simulation",
        asOf,
        axisCompleteness: "complete",
        confidence: 1,
      },
      business_status: {
        sourceKind: "self_declared",
        provider: "cunote_admin_simulation",
        asOf,
        axisCompleteness: "complete",
        confidence: 1,
      },
    },
  };
}
