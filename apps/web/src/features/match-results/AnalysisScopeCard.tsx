import type { TeaserSearchContext } from "@cunote/contracts";

const ANALYSIS_AXIS_GROUPS = [
  {
    label: "사업 기본",
    detail: "소재지 · 업력 · 업종 · 규모 · 매출 · 고용",
  },
  {
    label: "대표·역량",
    detail: "대표자 조건 · 인증 · 지식재산 · 투자",
  },
  {
    label: "적격·결격",
    detail: "신청주체 · 영업상태 · 세금 · 신용 · 제재 · 재무",
  },
  {
    label: "실적·운영",
    detail: "고용보험 · 사업장 · 수혜이력 · 수출실적 · 공고별 기타",
  },
] as const;

export function AnalysisScopeCard({
  context,
}: {
  context: TeaserSearchContext | undefined;
}) {
  if (!context || context.evaluatedGrantCount <= 0) return null;

  return (
    <section
      aria-labelledby="matching-analysis-scope-title"
      className="mt-4 rounded-2xl border border-border-subtle bg-card px-5 py-[18px] shadow-[var(--shadow-notice-card)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="matching-analysis-scope-title" className="text-sm font-extrabold text-ink">
          이번 결과의 분석 범위
        </h2>
        <p className="text-sm font-bold text-brand">
          공개 공고 {context.evaluatedGrantCount.toLocaleString("ko-KR")}건 대조
        </p>
      </div>
      <p className="mt-2 text-[13px] leading-6 text-text-secondary">
        이 수는 이번 조회에서 대조한 공고 수예요. 위에 표시된 후보 수와 같지 않을 수 있어요.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {ANALYSIS_AXIS_GROUPS.map((group) => (
          <div key={group.label} className="rounded-xl bg-surface-soft px-3.5 py-3">
            <p className="text-xs font-bold text-text-nav">{group.label}</p>
            <p className="mt-1 text-xs leading-5 text-text-tertiary">{group.detail}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-5 text-text-tertiary">
        확인된 조건은 회사 정보와 비교하고, 미확정 조건은 원문 확인 대상으로 남겨요. 자격 확인과 신청서 작성 준비는 별개예요.
      </p>
    </section>
  );
}
