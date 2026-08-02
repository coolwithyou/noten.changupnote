import { eq } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  isVirtualCompanyServerEnabled,
  resolveVirtualCompanyScenario,
  type VirtualCompanyScenario,
} from "./catalog";

/**
 * 가상 기업이 읽을 수 있는 공고를 판정하는 단일 서버 경계.
 *
 * 사업자번호가 등록된 개발 시나리오이고, 요청한 DB 공고가 그 시나리오의 정확한
 * source/sourceId 대상일 때만 시나리오를 반환한다. 페이지 이미지와 원본 문서 모두 이 경계를
 * 공유해 어느 한쪽만 더 넓게 열리는 일을 막는다.
 */
export async function resolveVirtualCompanyGrantAccess(input: {
  grantId: string;
  bizNo: string | null;
}): Promise<VirtualCompanyScenario | null> {
  if (!input.bizNo || !isVirtualCompanyServerEnabled()) return null;
  const scenario = resolveVirtualCompanyScenario(input.bizNo);
  if (!scenario) return null;

  const db = getCunoteDb();
  const [grant] = await db
    .select({ source: schema.grants.source, sourceId: schema.grants.sourceId })
    .from(schema.grants)
    .where(eq(schema.grants.id, input.grantId))
    .limit(1);
  if (!grant) return null;

  return scenario.targets.some(
    (target) => target.source === grant.source && target.sourceId === grant.sourceId,
  )
    ? scenario
    : null;
}
