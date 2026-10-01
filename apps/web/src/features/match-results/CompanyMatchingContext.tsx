import type { MatchingProfileView, MatchingProfileViewRow } from "@cunote/contracts";
import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PROFILE_DIMENSION_LABELS } from "./logic";

const CORE_DIMENSIONS = ["region", "industry", "biz_age", "target_type", "size", "business_status"];

export function companyFactState(row: MatchingProfileViewRow): string {
  if (row.sourceDisputed) return "출처 충돌 · 확인 필요";
  if (row.status === "partial" || row.completeness === "partial") return "일부 확인";
  if (row.status !== "known" || !row.displayValue?.trim()) return "미확인";
  return "확인된 값";
}

export function matchingBasisDate(value: string | null | undefined): string {
  if (!value) return "기준일 미확인";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "기준일 미확인" : new Intl.DateTimeFormat("ko-KR", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Seoul",
  }).format(date);
}

/** 현재 응답의 회사 사실만 표시한다. 업종/지역을 추측하거나 미확인 값을 충족으로 바꾸지 않는다. */
export function CompanyMatchingContext({ profileView, companyName, temporary = false, onOpenProfile, profileHref, compact = false }: {
  profileView: MatchingProfileView;
  companyName?: string | null;
  temporary?: boolean;
  onOpenProfile?: () => void;
  profileHref?: string;
  compact?: boolean;
}) {
  const core = CORE_DIMENSIONS.map((dimension) => profileView.rows.find((row) => row.dimension === dimension));
  const remaining = profileView.rows.filter((row) => !CORE_DIMENSIONS.includes(row.dimension));
  const facts = <>
      <dl className={`grid grid-cols-2 gap-x-5 gap-y-4 px-5 py-5 ${compact ? "" : "sm:grid-cols-3"}`}>
        {core.map((row, index) => <CompanyFact key={CORE_DIMENSIONS[index]} row={row} dimension={CORE_DIMENSIONS[index]!} />)}
      </dl>
      {remaining.length ? <details className="border-t border-border-subtle px-5 py-3">
        <summary className="cursor-pointer text-xs font-semibold text-text-secondary">인증·수혜 이력 등 나머지 정보 {remaining.length}개</summary>
        <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-4 sm:grid-cols-3">{remaining.map((row) => <CompanyFact key={row.dimension} row={row} dimension={row.dimension} />)}</dl>
      </details> : null}
      <p className="border-t border-border-subtle bg-surface-soft px-5 py-3 text-xs leading-5 text-text-secondary">{temporary ? "아직 회사에 저장되지 않은 임시 정보예요. 로그인 후 이 정보를 이어서 저장할 수 있어요." : "직접 입력한 개인 매칭 답변과 원천 조회 정보를 함께 사용해요."} 미확인·일부 확인·출처 충돌은 조건 충족을 뜻하지 않아요.</p>
  </>;
  return (
    <Card className="mt-5 gap-0 overflow-hidden rounded-2xl border-border-subtle bg-card p-0 ring-0 shadow-none" aria-label="공고 대조에 사용하는 내 사업자 정보">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-xs font-semibold text-text-secondary"><Building2 className="size-4 shrink-0 text-brand" aria-hidden />{temporary ? "이 탭의 사업자 정보" : "현재 선택한 회사"}</p>
          <h2 className="mt-1 break-keep text-lg font-extrabold text-ink-strong">{companyName?.trim() || (temporary ? "조회한 사업자" : "내 회사")}</h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">이 정보와 각 공고의 조건을 대조해요 · {matchingBasisDate(profileView.asOf)}</p>
        </div>
        {onOpenProfile ? <Button variant="outline" size="sm" onClick={onOpenProfile}>정보 확인·보완</Button> : profileHref ? <a href={profileHref} className={buttonVariants({ variant: "outline", size: "sm" })}>정보 확인·보완</a> : null}
      </div>
      {compact ? (
        <details>
          <summary className="cursor-pointer px-5 py-3 text-xs font-semibold text-text-secondary">대조에 사용한 사업자 정보·출처 보기</summary>
          {facts}
        </details>
      ) : facts}
    </Card>
  );
}

function CompanyFact({ row, dimension }: { row?: MatchingProfileViewRow | undefined; dimension: string }) {
  const state = row ? companyFactState(row) : "미확인";
  const value = row?.status === "unknown" ? "아직 확인하지 못했어요" : row?.displayValue?.trim() || "아직 확인하지 못했어요";
  return <div className="min-w-0">
    <dt className="text-xs text-text-tertiary">{PROFILE_DIMENSION_LABELS[dimension as MatchingProfileViewRow["dimension"]] ?? dimension}</dt>
    <dd className="mt-1 break-keep text-sm font-bold leading-6 text-ink">{value}</dd>
    <dd className="mt-1"><Badge variant="outline" className="h-auto max-w-full whitespace-normal text-[10px] leading-4">{state}</Badge></dd>
    <dd className="mt-1 break-keep text-[11px] leading-4 text-text-tertiary">{row?.sourceLabel?.trim() || "출처 미확인"} · {matchingBasisDate(row?.asOf)}</dd>
  </div>;
}
