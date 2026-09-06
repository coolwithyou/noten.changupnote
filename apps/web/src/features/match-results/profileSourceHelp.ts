import type { MatchingProfileViewRow } from "@cunote/contracts";

export function profileSourceHelp(field: Pick<MatchingProfileViewRow, "sourceKind" | "sourceLabel" | "asOf" | "completeness">) {
  if (field.sourceKind !== "authoritative_api" && field.sourceKind !== "public_registry") return null;
  const date = field.asOf ? new Date(field.asOf) : null;
  const asOf = date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
    : "기준일 확인 필요";
  return {
    source: field.sourceLabel ?? (field.sourceKind === "authoritative_api" ? "공식 API" : "공개명단"),
    asOf,
    message: field.completeness === "complete"
      ? "원천 확인값은 직접 덮어쓸 수 없습니다. 실제 정보와 다르면 정정을 문의해주세요."
      : "원천에서 일부만 확인된 정보입니다. 보완하거나 원천값의 정정을 문의할 수 있습니다.",
    // 회사 ID·사업자번호·수정하려는 값은 URL/방문 기록에 넣지 않는다.
    href: "/support?category=bug#support-ticket-form",
  };
}
