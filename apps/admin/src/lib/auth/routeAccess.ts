import type { AdminRole } from "@/lib/server/auth/adminUsers";

export const REVIEW_WORKSPACE_ROLES: readonly AdminRole[] = ["reviewer", "admin", "owner"];
export const REVIEW_ADJUDICATION_ROLES: readonly AdminRole[] = ["admin", "owner"];
export const DEEP_PIPELINE_ROLES: readonly AdminRole[] = ["reviewer", "admin", "owner"];
export const NOTICE_PIPELINE_ROLES: readonly AdminRole[] = ["viewer", "support", "admin", "owner"];

export function isReviewWorkspacePath(pathname: string): boolean {
  return pathname === "/review" || pathname.startsWith("/review/");
}

export function isReviewApiPath(pathname: string): boolean {
  return pathname === "/api/admin/review" || pathname.startsWith("/api/admin/review/");
}

export function isDeepPipelinePath(pathname: string): boolean {
  return pathname === "/pipeline" || pathname.startsWith("/pipeline/");
}

export function isDeepPipelineApiPath(pathname: string): boolean {
  return pathname === "/api/admin/pipeline" || pathname.startsWith("/api/admin/pipeline/");
}

export function isNoticePipelinePath(pathname: string): boolean {
  return pathname === "/notice-pipeline" || pathname.startsWith("/notice-pipeline/");
}

export function isNoticePipelineApiPath(pathname: string): boolean {
  return pathname === "/api/admin/notice-pipeline"
    || pathname.startsWith("/api/admin/notice-pipeline/");
}

/**
 * proxy와 서버 페이지가 공유하는 역할→경로 매트릭스.
 * API 자체의 메서드/객체 권한 검사를 대체하지 않는 보조 방어다.
 */
export function canAccessAdminPath(role: AdminRole, pathname: string): boolean {
  if (pathname.startsWith("/api/auth")) return true;

  if (isReviewWorkspacePath(pathname) || isReviewApiPath(pathname)) {
    const adjudication =
      pathname === "/review/adjudicate"
      || pathname.startsWith("/review/adjudicate/")
      || pathname === "/api/admin/review/adjudicate"
      || pathname.startsWith("/api/admin/review/adjudicate/");
    return (adjudication ? REVIEW_ADJUDICATION_ROLES : REVIEW_WORKSPACE_ROLES).includes(role);
  }

  if (isDeepPipelinePath(pathname) || isDeepPipelineApiPath(pathname)) {
    return DEEP_PIPELINE_ROLES.includes(role);
  }

  if (isNoticePipelinePath(pathname) || isNoticePipelineApiPath(pathname)) {
    return NOTICE_PIPELINE_ROLES.includes(role);
  }

  // 검수 전용 역할은 /review/** 밖의 기존 운영·크레딧·지원 데이터에 접근하지 못한다.
  return role !== "reviewer";
}

export function defaultAdminPath(role: AdminRole): string {
  return role === "reviewer" ? "/review" : "/";
}
