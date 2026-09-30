import { Badge } from "@/components/ui/badge";
import { writingParagraphKindLabels } from "@/lib/documents/writingComposition";
import { cn } from "@/lib/utils";

/** 디자인 2라운드 05 랜딩 히어로 우측 목업 — 문항별 검토용 초안 카드(정적, 장식용). */
export const LANDING_DRAFT_MOCK = {
  title: "1. 사업 개요 · 검토용 초안",
  basis: "회사 자료 2건 기준",
  requirement: "공고 요구: 사업 배경·목표·차별성 포함 · 1,000자 이내",
  paragraphs: [
    { kind: "company_fact", text: "주식회사 바다상회는 2023년 4월 부산 해운대구에 설립된 음식료품 도소매 기업으로, 2025년 매출은 3.2억 원입니다." },
    { kind: "plan", text: "자사몰 개편과 라이브커머스 정기 배송을 결합해 지역 수산 가공품의 온라인 직거래 판로를 넓히고자 합니다." },
    { kind: "proposal", text: "첫 3개월 재구매율 [목표 재구매율 필요]를 핵심 지표로 제안합니다." },
  ],
  footer: ["인용 근거 3건", "보완할 내용 3", "문안 저장본 2"],
} as const;

const KIND_PILL_CLASS: Record<keyof typeof writingParagraphKindLabels, string> = {
  company_fact: "bg-brand-mint-soft text-brand-mint-ink",
  plan: "bg-brand-tint text-brand",
  proposal: "bg-[var(--warning-strong-soft)] text-[var(--warning-strong)]",
};

export function LandingDraftMock({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex flex-col gap-2.5 rounded-[20px] border border-border-card bg-card px-5 py-[18px] shadow-[var(--shadow-landing-demo)]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-extrabold text-ink-strong">{LANDING_DRAFT_MOCK.title}</span>
        <Badge variant="outline" className="shrink-0 rounded-full bg-card text-[11.5px] font-bold text-text-secondary">
          {LANDING_DRAFT_MOCK.basis}
        </Badge>
      </div>
      <p className="text-[12.5px] text-text-secondary">{LANDING_DRAFT_MOCK.requirement}</p>
      {LANDING_DRAFT_MOCK.paragraphs.map((paragraph) => (
        <div
          key={paragraph.kind}
          className="flex flex-col gap-1.5 rounded-xl border border-border-card px-3 py-2.5 text-[12.5px] leading-[1.55] text-ink"
        >
          <span
            className={cn(
              "inline-flex self-start rounded-md px-[7px] py-0.5 text-[11px] font-extrabold",
              KIND_PILL_CLASS[paragraph.kind],
            )}
          >
            {writingParagraphKindLabels[paragraph.kind]}
          </span>
          <span className="break-keep">{paragraph.text}</span>
        </div>
      ))}
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
        {LANDING_DRAFT_MOCK.footer.map((item, index) => (
          <span key={item} className="contents">
            {index > 0 ? <span>·</span> : null}
            <span className={index === LANDING_DRAFT_MOCK.footer.length - 1 ? "font-semibold text-brand-mint-ink" : undefined}>
              {item}
            </span>
          </span>
        ))}
      </p>
    </div>
  );
}
