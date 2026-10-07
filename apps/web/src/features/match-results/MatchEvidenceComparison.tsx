import type { MatchCard } from "@cunote/contracts";
import { criterionEvidencePresentation } from "./logic";

const RESULT_LABEL: Record<string, string> = { pass: "충족", fail: "불일치", unknown: "확인 필요", text_only: "원문 확인 필요" };

/** 매처가 반환한 조건과 값의 exact 대조. discovery에는 충족 근거를 꾸며 넣지 않는다. */
export function MatchEvidenceComparison({ match }: { match: MatchCard }) {
  if (match.matchingEvidence?.level === "discovery" || !match.criteriaExtracted) {
    return <p className="mt-2 rounded-lg bg-surface-soft px-3 py-2 text-xs leading-5 text-text-secondary">공고 조건을 아직 대조하지 못했어요. 내 회사의 부적격 판정이 아닌 원문 확인 후보예요.</p>;
  }
  const traces = match.ruleTrace ?? [];
  if (!traces.length) return <p className="mt-2 text-xs text-text-secondary">조건별 대조 근거를 아직 확인하지 못했어요.</p>;
  const preview = traces.find((trace) => trace.companyValue?.trim()) ?? traces[0]!;
  const previewEvidence = criterionEvidencePresentation(preview);
  return <div>
    <p className="mt-2 break-keep text-xs leading-5 text-text-secondary"><span className="font-semibold text-ink">내 사업자 {preview.companyValue?.trim() || "값 미확인"}</span> · {previewEvidence.requirement} · {preview.unresolvedReason === "source_dispute" ? "출처 충돌 · 확인 필요" : RESULT_LABEL[preview.result] ?? "확인 필요"}</p>
    <details className="mt-2 rounded-lg border border-border-subtle bg-surface-soft px-3 py-2">
    <summary className="cursor-pointer text-xs font-semibold text-text-secondary">내 사업자 정보와 조건 대조 · {traces.length}개</summary>
    <dl className="mt-3 space-y-3">
      {traces.map((trace, index) => {
        const evidence = criterionEvidencePresentation(trace);
        const unresolved = trace.unresolvedReason === "source_dispute" ? "출처 충돌 · 확인 필요" : RESULT_LABEL[trace.result] ?? "확인 필요";
        const companyValue = trace.companyValue?.trim() || trace.label.split(/\s+[—-]\s+귀사\s*/u, 2)[1]?.trim();
        return <div key={trace.criterionId ?? `${trace.dimension}:${index}`} className="border-t border-border-subtle pt-2 first:border-0 first:pt-0">
          <dt className="text-xs font-bold text-ink">{evidence.dimensionLabel} · {unresolved}</dt>
          <dd className="mt-1 break-keep text-xs leading-5 text-text-secondary"><span className="font-semibold">공고 조건</span> {evidence.requirement}</dd>
          <dd className="break-keep text-xs leading-5 text-text-secondary"><span className="font-semibold">내 사업자</span> {companyValue || "값 미확인"}</dd>
          {trace.unresolvedReason === "company_profile_missing" ? <dd className="text-[11px] leading-5 text-text-tertiary">회사 정보가 없어 대조를 마치지 못했어요.</dd> : trace.result === "text_only" || trace.unresolvedReason === "criterion_needs_review" || trace.unresolvedReason === "criterion_invalid" ? <dd className="text-[11px] leading-5 text-text-tertiary">공고 조건의 원문·분석 확인이 필요해요.</dd> : null}
        </div>;
      })}
    </dl>
  </details></div>;
}
