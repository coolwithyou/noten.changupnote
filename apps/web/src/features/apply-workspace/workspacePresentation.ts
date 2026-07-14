import type { DraftFieldAnswer } from "@/lib/server/documents/fieldAnswers";

export type WorkspaceFieldState = "filled" | "reviewing" | "empty";

export interface InstitutionContact {
  name: string;
  phone: string | null;
  email: string | null;
  sourceUrl: string | null;
}

/** 지원서 셀은 완료·확인 중·미입력 세 상태만 화면에 노출한다. */
export function workspaceFieldState(answer: DraftFieldAnswer | undefined): WorkspaceFieldState {
  if (answer?.status === "accepted" || answer?.status === "edited") return "filled";
  if (answer?.status === "suggested") return "reviewing";
  return "empty";
}

/** 공고 데이터에 실제로 들어 있는 연락처만 추출한다. 임의 기관 연락처는 만들지 않는다. */
export function buildInstitutionContact(input: {
  agency: string | null;
  applyMethod: string | null;
  deepLink: string | null;
}): InstitutionContact | null {
  const source = input.applyMethod ?? "";
  const phone = source.match(/(?:1\d{3}[-\s]?\d{4}|0\d{1,2}[-.)\s]?\d{3,4}[-\s]?\d{4})/)?.[0]?.trim() ?? null;
  const email = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? null;
  const sourceUrl = safeHttpUrl(input.deepLink);

  if (!phone && !email && !sourceUrl) return null;
  return {
    name: input.agency?.trim() || "공고 담당 기관",
    phone,
    email,
    sourceUrl,
  };
}

export function contactPhoneHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
