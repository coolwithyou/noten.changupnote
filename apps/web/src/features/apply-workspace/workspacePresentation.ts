import { parsePositionPage } from "@/lib/documents/bbox";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { DraftFieldAnswer, DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { FieldLessonTip } from "@/lib/server/knowledge/lessonContext";
import { answerKey } from "./fieldAnswerState";

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

// ── 상단 바 진행 표시(단일 축: confirmed/total). 필수/전체 이중 표기는 폐기(재정의 §2-①). ──

export interface WorkspaceProgress {
  total: number;
  confirmed: number;
}

/**
 * 확인 완료(accepted/edited) 필드 수를 센다. 패치 진행 중(pendingLabels)인 필드는
 * 아직 확정으로 보지 않는다(상단 바가 낙관적 반영을 앞질러 튀지 않도록).
 */
export function computeWorkspaceProgress(
  fields: ConnectedDocumentField[],
  answers: DraftFieldAnswers,
  pendingLabels: ReadonlySet<string>,
): WorkspaceProgress {
  let confirmed = 0;
  for (const field of fields) {
    const key = answerKey(field.label);
    if (pendingLabels.has(key)) continue;
    if (workspaceFieldState(answers[key]) === "filled") confirmed += 1;
  }
  return { total: fields.length, confirmed };
}

/** 아직 확인이 필요한(미완료) 필드 수. 카드 상단 라벨 "N개 중 M번째"의 N. */
export function countUnconfirmedFields(
  fields: ConnectedDocumentField[],
  answers: DraftFieldAnswers,
): number {
  return fields.reduce(
    (sum, field) => (workspaceFieldState(answers[answerKey(field.label)]) === "filled" ? sum : sum + 1),
    0,
  );
}

/** 확인 완료된 필드의 원문 label 을 순서대로. 카드 아래 축약 리스트(✓ …) 용. */
export function confirmedFieldLabels(
  fields: ConnectedDocumentField[],
  answers: DraftFieldAnswers,
): string[] {
  return fields
    .filter((field) => workspaceFieldState(answers[answerKey(field.label)]) === "filled")
    .map((field) => field.label);
}

/**
 * 위치 캡션 문자열 `신청서 {page}쪽 · '{section}' 표`. page 를 특정할 수 없으면 null(캡션 생략 — 뱃지 아님).
 * section 이 없으면 `신청서 {page}쪽` 까지만.
 */
export function fieldPositionCaption(position: unknown, section: string | null): string | null {
  const page = parsePositionPage(position);
  if (page === null) return null;
  const base = `신청서 ${page.toLocaleString("ko-KR")}쪽`;
  const sectionName = section?.trim();
  return sectionName ? `${base} · '${sectionName}' 표` : base;
}

/** mappedCompanyField → 이 칸이 무엇을 적는 칸인지 알려주는 결정론 한 줄(새 API·LLM 없이). */
const MAPPED_FIELD_DESCRIPTION: Record<string, string> = {
  name: "사업자등록증에 적힌 상호(회사 이름)를 적는 칸이에요.",
  representative_name: "대표자 성명을 적는 칸이에요.",
  biz_no: "사업자등록번호를 적는 칸이에요.",
  region: "사업장 소재지(주소)를 적는 칸이에요.",
  industries: "회사의 업종·사업 분야를 적는 칸이에요.",
  size: "기업 규모(중소기업·소상공인 등)를 적는 칸이에요.",
  revenue: "직전 회계연도 매출액을 적는 칸이에요.",
  employees: "상시근로자 수(직원 수)를 적는 칸이에요.",
  certifications: "보유한 인증·지식재산권을 적는 칸이에요.",
  target_types: "해당하는 기업 유형(대상 구분)을 적는 칸이에요.",
};

/** 문자열의 첫 문장만(문장 부호·줄바꿈까지). 없으면 원문 전체. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const idx = trimmed.search(/[.!?。\n]/);
  if (idx === -1) return trimmed;
  return trimmed.slice(0, idx + 1).trim();
}

/**
 * 카드 설명 한 줄(재정의 §2-② ⑶). 우선순위:
 *   ⑴ lesson tip 첫 문장 → ⑵ mappedCompanyField 결정론 문구 → ⑶ 없으면 null(슬롯 생략).
 * 새 API·LLM 을 만들지 않고 이미 로드된 데이터만 쓴다.
 */
export function fieldDescriptionLine(
  field: Pick<ConnectedDocumentField, "mappedCompanyField">,
  tips: FieldLessonTip[],
): string | null {
  const tip = tips[0]?.instruction?.trim();
  if (tip) return firstSentence(tip);
  const mapped = field.mappedCompanyField?.trim();
  if (mapped && MAPPED_FIELD_DESCRIPTION[mapped]) return MAPPED_FIELD_DESCRIPTION[mapped];
  return null;
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
