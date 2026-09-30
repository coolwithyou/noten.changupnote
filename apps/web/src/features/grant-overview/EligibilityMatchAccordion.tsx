import type { RuleTraceChip } from "@cunote/contracts";
import { explainCondition } from "@cunote/core";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { withCompanyContext } from "@/lib/navigation/companyContext";
import { countHardConditions, formatEligibilitySummary } from "./logic";

type ExplainedCondition = ReturnType<typeof explainCondition>;

/** 판정에 사용한 필수·제외 조건을 원문, 회사값, 이유, 행동 순서로 모두 보여준다. */
export function EligibilityMatchAccordion({
  grantId,
  companyId,
  virtualBizNo,
  satisfied,
  needsCheck,
  sourceUrl,
}: {
  grantId: string;
  companyId: string | null;
  virtualBizNo: string | null;
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
  sourceUrl: string | null;
}) {
  const all = [...satisfied, ...needsCheck];
  const hardConditions = all
    .filter((trace) => trace.kind === "required" || trace.kind === "exclusion")
    .map(explainCondition)
    .sort((left, right) => conditionOrder(left) - conditionOrder(right));
  const preferredConditions = all
    .filter((trace) => trace.kind === "preferred")
    .map(explainCondition);
  // 지표 카드("지원 대상")와 같은 집계 함수를 써서 어휘가 갈리지 않게 한다(결정 D1).
  const counts = countHardConditions({ satisfied, needsCheck });
  const summary = formatEligibilitySummary(counts.passed, counts.unknown, counts.failed);

  return (
    <AccordionItem value="eligibility" className="border-b border-border-subtle">
      <AccordionTrigger className="px-1 py-[18px] text-[15.5px] font-semibold hover:no-underline">
        <span>자격 조건</span>
        <span className="ml-auto pr-2 text-right text-xs font-medium text-muted-foreground tabular-nums">
          {summary}
        </span>
      </AccordionTrigger>
      <AccordionContent className="px-1 pb-5">
        <p className="text-xs text-muted-foreground">
          확인된 조건은 회사 정보와 비교한 결과이고, 남은 쟁점은 답하거나 원문을 봐야 해요. 작성 시작 여부와는 별개예요.
        </p>
        <h4 className="mt-4 text-xs font-extrabold text-muted-foreground">필수 · 제외</h4>
        {hardConditions.length > 0 ? (
          <div className="mt-2 grid gap-3">
            {hardConditions.map((condition, index) => (
              <ConditionItem
                key={`${condition.trace.criterionId ?? condition.trace.dimension}-${condition.trace.kind}-${index}`}
                condition={condition}
                grantId={grantId}
                companyId={companyId}
                virtualBizNo={virtualBizNo}
                sourceUrl={sourceUrl}
              />
            ))}
          </div>
        ) : (
          <Empty className="panel-empty mt-2">
            <EmptyDescription>비교할 필수·제외 조건이 아직 정리되지 않았어요. 공고 원문을 확인해 주세요.</EmptyDescription>
          </Empty>
        )}
        {preferredConditions.length > 0 ? (
          <section className="mt-5 border-t border-border-subtle pt-4">
            <h4 className="text-xs font-extrabold text-muted-foreground">우대 · 집계에 넣지 않아요</h4>
            <div className="mt-2 grid gap-3">
              {preferredConditions.map((condition, index) => (
                <ConditionItem
                  key={`${condition.trace.criterionId ?? condition.trace.dimension}-preferred-${index}`}
                  condition={condition}
                  grantId={grantId}
                  companyId={companyId}
                  virtualBizNo={virtualBizNo}
                  sourceUrl={sourceUrl}
                />
              ))}
            </div>
          </section>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

function ConditionItem({
  condition,
  grantId,
  companyId,
  virtualBizNo,
  sourceUrl,
}: {
  condition: ExplainedCondition;
  grantId: string;
  companyId: string | null;
  virtualBizNo: string | null;
  sourceUrl: string | null;
}) {
  const action = conditionAction(condition, grantId, companyId, virtualBizNo, sourceUrl);

  return (
    <Card size="sm">
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={traceTone(condition.trace.result)}>{condition.statusLabel}</StatusBadge>
          <span className="text-xs font-semibold text-muted-foreground">
            {condition.trace.kind === "required"
              ? "필수 조건"
              : condition.trace.kind === "exclusion"
                ? "제외 조건"
                : "우대·평가"}
          </span>
        </div>
        {condition.trace.label && condition.trace.label !== condition.reason ? (
          <p className="text-sm leading-6 text-foreground">{condition.trace.label}</p>
        ) : null}
        <dl className="grid gap-3 text-sm leading-6 sm:grid-cols-2">
          <ConditionFact label="공고 조건" value={condition.requirement} />
          <ConditionFact label="회사 정보" value={condition.companyValue} />
          <ConditionFact label="현재 판단" value={condition.reason} />
          <div className="min-w-0">
            <dt className="text-xs font-semibold text-muted-foreground">다음 행동</dt>
            <dd className="break-words text-foreground">{conditionActionText(condition)}</dd>
            {action ? (
              <a
                className={buttonVariants({ variant: "outline", size: "sm", className: "mt-2 justify-self-start" })}
                href={action.href}
                {...(action.external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {action.label}
              </a>
            ) : null}
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function ConditionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
      <dd className="break-words text-foreground">{value}</dd>
    </div>
  );
}

function conditionOrder(condition: ExplainedCondition): number {
  if (condition.trace.result === "fail") return 0;
  if (condition.action === "company_profile" || condition.action === "user_confirmation") return 1;
  if (condition.pending) return 2;
  return 3;
}

function conditionActionText(condition: ExplainedCondition): string {
  if (condition.trace.result === "pass") return "추가로 할 일이 없어요.";
  if (condition.trace.result === "fail") return "공고 원문에서 불일치 근거와 예외 조건을 확인해 주세요.";
  if (condition.action === "company_profile") return "이 조건과 비교할 회사 정보를 입력해 주세요.";
  if (condition.action === "user_confirmation") return "이 공고에 검수된 확인 질문이 있으면 답해 주세요.";
  return "공고 원문에서 조건의 문맥과 예외를 확인해 주세요.";
}

function conditionAction(
  condition: ExplainedCondition,
  grantId: string,
  companyId: string | null,
  virtualBizNo: string | null,
  sourceUrl: string | null,
): { href: string; label: string; external: boolean } | null {
  if (condition.trace.result === "pass") return null;
  const context = new URLSearchParams();
  if (virtualBizNo) context.set("biz", virtualBizNo);
  if (condition.action === "company_profile") {
    context.set("profile", condition.trace.dimension);
    const href = `/matches?${context.toString()}#profile`;
    return {
      href: companyId ? withCompanyContext(href, companyId) : href,
      label: "이 회사 정보 확인하기",
      external: false,
    };
  }
  if (condition.action === "user_confirmation") {
    context.set("confirm", grantId);
    const href = `/matches?${context.toString()}`;
    return {
      href: companyId ? withCompanyContext(href, companyId) : href,
      label: "이 공고 질문 확인하기",
      external: false,
    };
  }
  if (!sourceUrl) return null;
  return { href: sourceUrl, label: "공고 원문 근거 보기", external: true };
}

function traceTone(result: RuleTraceChip["result"]) {
  if (result === "pass") return "success";
  if (result === "fail") return "danger";
  if (result === "text_only") return "brand";
  return "warning";
}
