import type { AdminSession } from "./adminSession";
import type { AdminRole } from "./adminUsers";
import { adminError } from "@/lib/server/http/envelope";

const ROLE_ORDER: AdminRole[] = ["viewer", "support", "admin", "owner"];

export class InsufficientRoleError extends Error {
  readonly status = 403;
  readonly code = "insufficient_role";
  constructor(required: AdminRole) {
    super(`이 작업은 ${required} 이상의 권한이 필요합니다.`);
    this.name = "InsufficientRoleError";
  }
}

/**
 * session.user.role이 required 이상인지 확인. 아니면 InsufficientRoleError throw.
 * 사용: const session = await requireAdminSession(); requireAdminRole(session, "admin");
 */
export function requireAdminRole(session: AdminSession, required: AdminRole): void {
  const userLevel = ROLE_ORDER.indexOf(session.user.role);
  const requiredLevel = ROLE_ORDER.indexOf(required);
  if (userLevel < requiredLevel) throw new InsufficientRoleError(required);
}

/** API 라우트의 catch 블록에서 InsufficientRoleError를 adminError로 변환 */
export function handleRoleError(error: unknown): Response | null {
  if (error instanceof InsufficientRoleError) {
    return adminError(error.code, error.message, error.status);
  }
  return null;
}
