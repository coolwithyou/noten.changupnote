import type { CriterionKind, MatchingEvidence, RuleTraceChip } from "@cunote/contracts";
import { explainCondition } from "@cunote/core";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { withCompanyContext } from "@/lib/navigation/companyContext";
import { cn } from "@/lib/utils";
import {
  CONDITION_ROW_STATUS_LABEL,
  CONDITION_TRUST_LABEL,
  conditionRowEvidence,
  conditionRowSource,
  conditionRowStatus,
  conditionTrust,
  countHardConditions,
  formatEligibilitySummary,
  type ConditionRowStatus,
  type ConditionTrust,
  type ExplainedCondition,
} from "./logic";

type EvidenceLevel = MatchingEvidence["level"] | null;

interface ConditionRowContext {
  grantId: string;
  companyId: string | null;
  virtualBizNo: string | null;
  sourceUrl: string | null;
  evidenceLevel: EvidenceLevel;
}

/**
 * 자격 조건 아코디언(디자인 03 `.acc`). 조건마다 3열 행(종류·검수 칩 / 조건 문장·출처 / 6상태·근거·행동 링크)으로
 * 보여준다. 집계는 지표 카드("지원 대상")와 같은 함수를 써서 어휘가 갈리지 않게 한다(결정 D1).
 */
export function EligibilityMatchAccordion({
  grantId,
  companyId,
  virtualBizNo,
  satisfied,
  needsCheck,
  sourceUrl,
  evidenceLevel = null,
}: {
  grantId: string;
  companyId: string | null;
  virtualBizNo: string | null;
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
  sourceUrl: string | null;
  /** 시트의 matchingEvidence 수준. 검수 칩("검수됨"/"AI가 읽음")의 기본값이며 없으면 칩을 생략한다. */
  evidenceLevel?: EvidenceLevel;
}) {
  const all = [...satisfied, ...needsCheck];
  const hardConditions = all
    .filter((trace) => trace.kind === "required" || trace.kind === "exclusion")
    .map(explainCondition)
    .sort((left, right) => conditionOrder(left) - conditionOrder(right));
  const preferredConditions = all
    .filter((trace) => trace.kind === "preferred")
    .map(explainCondition);
  const counts = countHardConditions({ satisfied, needsCheck });
  const summary = formatEligibilitySummary(counts.passed, counts.unknown, counts.failed);
  const context: ConditionRowContext = { grantId, companyId, virtualBizNo, sourceUrl, evidenceLevel };

  return (
    <AccordionItem value="eligibility" className="border-b border-border-subtle">
      <AccordionTrigger className="px-1 py-[18px] text-[15.5px] font-semibold hover:no-underline">
        <span>내 사업자 정보와 공고 조건 대조</span>
        <span className="ml-auto pr-2 text-right text-xs font-medium text-muted-foreground tabular-nums">
          {summary}
        </span>
      </AccordionTrigger>
      {/* 행동 링크는 디자인 `.lnk`처럼 밑줄 없이(hover 시만) 보이도록 패널 기본 링크 스타일을 끈다. */}
      <AccordionContent className="px-1 pb-[18px] [&_a]:no-underline [&_a]:hover:text-brand-hover">
        <div className="mb-2 text-[13px] leading-relaxed text-text-secondary">
          확인된 조건은 회사 정보와 비교한 결과이고, 남은 쟁점은 답하거나 원문을 봐야 해요. 작성 시작 여부와는 별개예요.
        </div>
        <ConditionGroupLabel>필수 · 제외</ConditionGroupLabel>
        {hardConditions.length > 0 ? (
          <div className="flex flex-col">
            {hardConditions.map((condition, index) => (
              <ConditionRow
                key={`${condition.trace.criterionId ?? condition.trace.dimension}-${condition.trace.kind}-${index}`}
                condition={condition}
                context={context}
                emphasizeAsk
              />
            ))}
          </div>
        ) : (
          <Empty className="panel-empty mt-2">
            <EmptyDescription>비교할 필수·제외 조건이 아직 정리되지 않았어요. 공고 원문을 확인해 주세요.</EmptyDescription>
          </Empty>
        )}
        {preferredConditions.length > 0 ? (
          <>
            <ConditionGroupLabel className="mt-2">우대 · 집계에 넣지 않아요</ConditionGroupLabel>
            <div className="flex flex-col">
              {preferredConditions.map((condition, index) => (
                <ConditionRow
                  key={`${condition.trace.criterionId ?? condition.trace.dimension}-preferred-${index}`}
                  condition={condition}
                  context={context}
                  emphasizeAsk={false}
                />
              ))}
            </div>
          </>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

/** 디자인 `.tg2` 그룹 라벨. */
function ConditionGroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h4 className={cn("pt-2.5 pb-1 text-xs font-extrabold text-text-tertiary", className)}>{children}</h4>
  );
}

/**
 * 조건 행(디자인 `.ct`): 데스크톱 3열 그리드, 모바일 세로 스택. 내 답이 필요한 필수·제외 행만
 * 디자인 `.ct.ask`처럼 연한 브랜드 배경으로 강조한다(우대 조건은 집계 밖이라 강조하지 않는다).
 */
function ConditionRow({
  condition,
  context,
  emphasizeAsk,
}: {
  condition: ExplainedCondition;
  context: ConditionRowContext;
  emphasizeAsk: boolean;
}) {
  const status = conditionRowStatus(condition);
  const trust = conditionTrust(condition, context.evidenceLevel);
  const action = conditionAction(status, condition, context);
  const emphasized = emphasizeAsk && status === "ask";

  return (
    <div
      data-condition-status={status}
      className={cn(
        // 1.5fr/1.4fr 트랙에 셀 min-w-0 을 더해 minmax(0, ·)와 같게 만든다(콤마 arbitrary 회피).
        "grid grid-cols-1 gap-1.5 border-t border-border-subtle py-3 first:border-t-0 sm:grid-cols-[76px_1.5fr_1.4fr] sm:items-start sm:gap-3.5",
        emphasized && "rounded-xl border-t-0 bg-surface-brand px-3 sm:-mx-3",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <ConditionKindBadge kind={condition.trace.kind} />
        {trust ? <ConditionTrustBadge trust={trust} /> : null}
      </div>
      <div className="min-w-0">
        <p className="mb-1 text-[11px] text-text-tertiary">공고 조건</p>
        <div className="text-sm leading-[1.45] font-semibold text-ink">{condition.requirement}</div>
        <div className="mt-0.5 text-[11.5px] text-text-source">{conditionRowSource(condition, trust)}</div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <p className="text-[11px] text-text-tertiary">내 사업자 정보</p>
        <p className="text-sm font-semibold text-ink">{condition.trace.companyValue?.trim() || "비교할 회사 정보 미확인"}</p>
        <ConditionStatus status={status} />
        <span className="text-[13px] leading-[1.45] text-text-secondary">{conditionRowEvidence(condition, status)}</span>
        {action ? (
          <a
            className="text-[13px] font-semibold text-brand-hover hover:underline"
            href={action.href}
            {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
          >
            {action.label}
          </a>
        ) : null}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<CriterionKind, string> = {
  required: "필수",
  exclusion: "제외",
  preferred: "우대",
};

/** 디자인 workbench.css `.kind-req / .kind-exc / .kind-pref` 색 대응. */
const KIND_CLASS: Record<CriterionKind, string> = {
  required: "bg-surface-muted text-text-nav",
  exclusion: "bg-danger-soft text-danger",
  preferred: "bg-brand-tint text-brand-hover",
};

function ConditionKindBadge({ kind }: { kind: CriterionKind }) {
  return (
    <Badge className={cn("rounded-md px-[7px] py-0.5 text-[11.5px] font-extrabold", KIND_CLASS[kind])}>
      {KIND_LABEL[kind]}
    </Badge>
  );
}

/** 디자인 `.trust-rev / .trust-ai`. warn-ink 전용 토큰이 없어 warning-strong 계열로 근사한다. */
const TRUST_CLASS: Record<ConditionTrust, string> = {
  reviewed: "border-border-muted bg-background text-text-tertiary",
  ai: "border-warning/40 bg-warning-soft text-warning-strong",
};

function ConditionTrustBadge({ trust }: { trust: ConditionTrust }) {
  return (
    <Badge className={cn("rounded-md px-1.5 py-px text-[11px] font-bold", TRUST_CLASS[trust])}>
      {CONDITION_TRUST_LABEL[trust]}
    </Badge>
  );
}

/** 디자인 `.st-*`: 18px 아이콘(원/사각) + 13.5px 굵은 라벨. */
const STATUS_CLASS: Record<ConditionRowStatus, { root: string; icon: string }> = {
  met: { root: "text-brand-mint-ink", icon: "rounded-full bg-brand-mint-soft text-brand-mint-ink" },
  unmet: { root: "text-danger", icon: "rounded-full bg-danger-soft text-danger" },
  ask: {
    root: "text-brand-hover",
    icon: "rounded-full bg-brand after:size-2 after:rounded-full after:bg-background after:content-['']",
  },
  per: { root: "text-brand-hover", icon: "rounded-full border-2 border-brand bg-background" },
  src: { root: "text-text-secondary", icon: "rounded-[4px] border-2 border-text-quaternary bg-background" },
  wait: { root: "text-text-tertiary", icon: "rounded-full bg-surface-muted" },
};

function ConditionStatus({ status }: { status: ConditionRowStatus }) {
  const style = STATUS_CLASS[status];
  return (
    <span className={cn("inline-flex items-center gap-[7px] text-[13.5px] font-bold whitespace-nowrap", style.root)}>
      <span aria-hidden="true" className={cn("inline-flex size-[18px] shrink-0 items-center justify-center", style.icon)}>
        {status === "met" ? <Check className="size-[11px]" strokeWidth={3} /> : null}
        {status === "unmet" ? <X className="size-[11px]" strokeWidth={3} /> : null}
      </span>
      {CONDITION_ROW_STATUS_LABEL[status]}
    </span>
  );
}

function conditionOrder(condition: ExplainedCondition): number {
  if (condition.trace.result === "fail") return 0;
  if (condition.action === "company_profile" || condition.action === "user_confirmation") return 1;
  if (condition.pending) return 2;
  return 3;
}

/**
 * 행동 링크(디자인 `.lnk`). 내 답 필요 → 회사 정보 편집, 공고별 확인 → 이 공고의 확인 질문, 그 밖의 미해소·불일치는
 * 검증된 공고 원문 URL. 충족 행은 링크가 없다. 디자인의 인라인 답변(버튼·연도 입력)은 이 화면에 API 배선이 없어
 * 링크로 대신한다.
 */
function conditionAction(
  status: ConditionRowStatus,
  condition: ExplainedCondition,
  context: ConditionRowContext,
): { href: string; label: string; external: boolean } | null {
  if (status === "met") return null;
  const query = new URLSearchParams();
  if (context.virtualBizNo) query.set("biz", context.virtualBizNo);
  if (status === "ask") {
    query.set("profile", condition.trace.dimension);
    const href = `/matches?${query.toString()}#profile`;
    return {
      href: context.companyId ? withCompanyContext(href, context.companyId) : href,
      label: "이 회사 정보 확인하기",
      external: false,
    };
  }
  if (status === "per") {
    query.set("confirm", context.grantId);
    const href = `/matches?${query.toString()}`;
    return {
      href: context.companyId ? withCompanyContext(href, context.companyId) : href,
      label: "이 공고 질문 확인하기",
      external: false,
    };
  }
  if (!context.sourceUrl) return null;
  return { href: context.sourceUrl, label: "원문에서 해당 문장 보기", external: true };
}
