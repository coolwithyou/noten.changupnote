import { companyProfileRevision } from "../repositories/companyProfileConcurrency";

/** 동일 사용자 + 동일 저장 의도 + 동일 입력의 재시도만 같은 회사를 가리킨다. */
export function companyCreationIdentity(userId: string, intent: string | null, request: unknown): string | undefined {
  if (intent === null) return undefined; // 기존 호출자는 호환. 신규 제품 경로는 반드시 의도를 전달한다.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent)) {
    throw Object.assign(new Error("저장 요청 식별자가 올바르지 않습니다."), { status: 400, code: "invalid_company_create_intent" });
  }
  const hex = companyProfileRevision({ version: "company-create-v1", userId, intent: intent.toLowerCase(), request }).slice(0, 32).split("");
  hex[12] = "8";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
