import { and, eq, inArray } from "drizzle-orm";
import { getOptionalWebSession } from "./auth/session";
import { getCunoteDb } from "./db/client";
import * as schema from "./db/schema";
import {
  isGrantSimulationNavigationAllowed,
  isGrantSimulationNavigationHost,
} from "../grantSimulationNavigation";
export {
  buildGrantSimulationCompanyProfile,
  GRANT_SIMULATION_BUSINESS_NUMBER,
} from "./adminGrantSimulationProfile";

export interface GrantSimulationAdminIdentity {
  adminUserId: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "reviewer";
}

/** 웹 세션 이메일이 활성화된 관리·검수 계정과 일치할 때만 읽기 전용 지원서 시뮬레이션을 연다. */
export async function getGrantSimulationAdminIdentity(): Promise<GrantSimulationAdminIdentity | null> {
  const session = await getOptionalWebSession();
  return getGrantSimulationAdminIdentityForEmail(
    session?.user.email,
    session?.user.name,
  );
}

/** 이미 서버에서 확인한 헤더 사용자 이메일로 동일한 관리 계정 계약을 조회한다. */
export async function getGrantSimulationAdminIdentityForEmail(
  rawEmail: string | null | undefined,
  fallbackName?: string | null,
): Promise<GrantSimulationAdminIdentity | null> {
  const email = rawEmail?.trim().toLowerCase();
  if (!email) return null;

  const [admin] = await getCunoteDb()
    .select({
      id: schema.adminUsers.id,
      email: schema.adminUsers.email,
      name: schema.adminUsers.name,
      role: schema.adminUsers.role,
    })
    .from(schema.adminUsers)
    .where(and(
      eq(schema.adminUsers.email, email),
      eq(schema.adminUsers.status, "active"),
      inArray(schema.adminUsers.role, ["owner", "admin", "reviewer"]),
    ))
    .limit(1);
  if (
    !admin
    || (admin.role !== "owner" && admin.role !== "admin" && admin.role !== "reviewer")
  ) return null;
  return {
    adminUserId: admin.id,
    email: admin.email,
    name: admin.name ?? fallbackName ?? null,
    role: admin.role,
  };
}

/** 일반 사용자 요청과 운영 호스트에서는 DB 조회 없이 빠르게 false로 끝낸다. */
export async function shouldShowGrantSimulationNavigation(input: {
  email: string | null | undefined;
  name?: string | null;
  host: string | null | undefined;
}): Promise<boolean> {
  if (!input.email?.trim() || !isGrantSimulationNavigationHost(input.host)) return false;

  try {
    const identity = await getGrantSimulationAdminIdentityForEmail(input.email, input.name);
    return isGrantSimulationNavigationAllowed(input.host, identity?.role);
  } catch (error) {
    console.warn(`Grant simulation navigation lookup failed: ${errorMessage(error)}`);
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
