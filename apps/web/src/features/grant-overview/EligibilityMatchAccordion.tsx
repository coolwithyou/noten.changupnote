import type { RuleTraceChip } from "@cunote/contracts";
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { StatusBadge } from "@/components/app/status-badge";
import { buttonVariants } from "@/components/ui/button";

/**
 * 아코디언 ① 자격 요건과 내 회사 매칭 (계획 §4.2, §8 P1-2).
 * 구 ApplySheetView 의 "이미 충족"/"확인 필요" 체크리스트(비공개 내부 함수)를
 * 접힌 아코디언 1개로 이관한다. 원본 데이터(sheet.satisfied/needsCheck)는 그대로 재사용하고
 * 로더는 건드리지 않는다.
 */
export function EligibilityMatchAccordion({
  satisfied,
  needsCheck,
}: {
  satisfied: RuleTraceChip[];
  needsCheck: RuleTraceChip[];
}) {
  const summary = `충족 ${satisfied.length.toLocaleString("ko-KR")}건 · 확인 필요 ${needsCheck.length.toLocaleString("ko-KR")}건`;

  return (
    <AccordionItem value="eligibility">
      <AccordionTrigger>
        <span className="flex flex-col items-start gap-0.5 text-left">
          <span>자격 요건과 내 회사 매칭</span>
          <span className="text-xs font-normal text-muted-foreground">{summary}</span>
        </span>
      </AccordionTrigger>
      <AccordionContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <TraceGroup
            title="이미 충족"
            items={satisfied}
            emptyText="자동 충족으로 확인된 조건이 없습니다."
          />
          <TraceGroup
            title="확인 필요"
            items={needsCheck}
            emptyText="추가 입력이 필요한 조건이 없습니다."
          />
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

function TraceGroup({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: RuleTraceChip[];
  emptyText: string;
}) {
  return (
    <section className="grid gap-2">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {items.map((item) => (
        <TraceItem key={`${item.dimension}-${item.kind}-${item.label}`} item={item} />
      ))}
      {items.length === 0 ? (
        <Empty className="panel-empty">
          <EmptyDescription>{emptyText}</EmptyDescription>
        </Empty>
      ) : null}
    </section>
  );
}

function TraceItem({ item }: { item: RuleTraceChip }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <StatusBadge tone={traceTone(item.result)}>{traceResultLabel(item.result)}</StatusBadge>
          <h3 className="flex-1 text-sm font-semibold">{item.label}</h3>
        </div>
        {item.companyValue || item.sourceSpan ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {item.companyValue ? `회사값 ${item.companyValue}` : item.sourceSpan}
          </p>
        ) : null}
        {item.unlock ? (
          <p className="text-sm leading-6 text-muted-foreground">
            {item.unlock.detail}
            {item.unlock.etaDate ? ` · ${formatEtaDate(item.unlock.etaDate)}` : ""}
          </p>
        ) : null}
        {item.action ? <TraceActionLink action={item.action} /> : null}
      </CardContent>
    </Card>
  );
}

function TraceActionLink({ action }: { action: NonNullable<RuleTraceChip["action"]> }) {
  const isHttp = /^https?:\/\//.test(action.target);
  const href =
    action.target.startsWith("#") || action.target.startsWith("/") || isHttp
      ? action.target
      : "/dashboard#next-question";
  const external = isHttp && action.type === "external_link";
  return (
    <a
      className={buttonVariants({ variant: "outline", size: "sm", className: "justify-self-start" })}
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {action.label}
    </a>
  );
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}

function traceResultLabel(result: RuleTraceChip["result"]): string {
  if (result === "pass") return "충족";
  if (result === "unknown") return "확인";
  if (result === "text_only") return "원문";
  return "미충족";
}

function traceTone(result: RuleTraceChip["result"]) {
  if (result === "pass") return "success";
  if (result === "fail") return "danger";
  if (result === "text_only") return "brand";
  return "warning";
}
