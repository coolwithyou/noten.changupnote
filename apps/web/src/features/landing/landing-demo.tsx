import { CheckIcon } from "lucide-react";
import { NoticeCard, type NoticeCardSupportSummary } from "@/components/app/notice-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const INITIAL_PACKAGE_SUMMARY = {
  text: "최대 1억 원",
  accessibleText: "지원 금액: 최대 1억 원",
} satisfies NoticeCardSupportSummary;

const SCALE_UP_SUMMARY = {
  text: "최대 5,000만 원",
  accessibleText: "지원 금액: 최대 5,000만 원",
} satisfies NoticeCardSupportSummary;

/** 랜딩 히어로의 16초 제품 예시. 전역 공고 비교 수만 실제 랜딩 집계를 사용한다. */
export function LandingDemo({ comparisonCount }: { comparisonCount: number }) {
  const comparisonLabel =
    comparisonCount > 0
      ? `공고 ${comparisonCount.toLocaleString("ko-KR")}건 대조 중`
      : "공고 조건 대조 중";

  return (
    <figure
      className="relative mx-auto w-full max-w-[480px] pb-[72px] text-left"
      aria-label="사업자번호 확인부터 지원서 자동 완성까지 이어지는 창업노트 사용 예시"
    >
      <div
        aria-hidden
        className="relative overflow-hidden rounded-[20px] border border-border-demo bg-card p-[22px] shadow-[var(--shadow-landing-demo)]"
      >
        <div className="landing-demo-k1 flex items-center gap-2.5 rounded-[12px] border border-border-brand-soft bg-surface-brand px-4 py-[13px]">
          <span className="text-base font-bold tracking-[0.5px] text-ink-strong tabular-nums">123-45-***90</span>
          <span className="landing-demo-caret h-[18px] w-0.5 bg-brand" />
        </div>

        <div
          className="landing-demo-skeleton pointer-events-none absolute inset-x-[22px] top-[88px] space-y-3"
          aria-hidden
        >
          <div className="space-y-2.5">
            <Skeleton className="h-3.5 w-[82%] bg-border-subtle/80" />
            <Skeleton className="h-3.5 w-[68%] bg-border-subtle/70" />
            <Skeleton className="h-3.5 w-[74%] bg-border-subtle/60" />
          </div>
          <Skeleton className="h-[7px] w-full rounded-full bg-border-subtle/70" />
          <div className="space-y-2">
            <Skeleton className="h-[54px] w-full rounded-[12px] bg-surface-muted" />
            <Skeleton className="h-[54px] w-full rounded-[12px] bg-surface-muted/80" />
          </div>
        </div>

        <div className="mt-3.5 flex flex-col gap-[7px]">
          <DemoFact animationClass="landing-demo-k2" label="상호 확인 — 주식회사 바다상회" source="국세청" />
          <DemoFact animationClass="landing-demo-k3" label="소재지 — 부산 · 음식료품 도소매" source="국세청" />
          <DemoFact animationClass="landing-demo-k4" label="업력 2년 · 소상공인" source="중기부" />
        </div>

        <div className="landing-demo-k4 mt-4">
          <div className="flex justify-between gap-4 text-[12.5px] text-text-tertiary tabular-nums">
            <span className="font-bold text-ink-strong">매칭 정밀도</span>
            <span>{comparisonLabel}</span>
          </div>
          <div className="mt-2 h-[7px] overflow-hidden rounded-full bg-border-subtle">
            <div className="landing-demo-gauge h-full rounded-full bg-grad-gauge" />
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <div className="landing-demo-k5">
            <NoticeCard title="초기창업패키지" dday="D-12" supportSummary={INITIAL_PACKAGE_SUMMARY} status="open" />
          </div>
          <div className="landing-demo-k6">
            <NoticeCard
              title="부산 청년기업 스케일업"
              dday="D-9"
              supportSummary={SCALE_UP_SUMMARY}
              status="open"
            />
          </div>
        </div>

        <Badge className="landing-demo-k7 mt-4 h-auto rounded-full bg-brand-mint-soft px-4 py-2 text-sm font-extrabold whitespace-normal text-brand-mint-ink">
          지금 신청 가능 3건
          <span className="font-semibold text-text-secondary">· 답하면 확정 11건</span>
        </Badge>

        <div className="landing-demo-application-layer pointer-events-none absolute inset-[22px]">
          <div className="landing-demo-n1">
            <Badge className="h-auto rounded-full bg-brand-tint px-[13px] py-1.5 text-[12.5px] font-extrabold text-brand-hover">
              지원서 작성 도우미
            </Badge>
            <div className="mt-3.5 border-[1.5px] border-ink-document bg-card font-document text-[12.5px] text-ink-document-text">
              <DemoDocumentRow label="상호명" value="주식회사 바다상회" state="done" />
              <DemoDocumentRow label="최근 연 매출" value="확인 중" state="checking" />
              <DemoDocumentRow label="상시근로자 수" value="—" state="empty" />
            </div>
          </div>

          <Card className="landing-demo-n2 mt-3.5 gap-0 rounded-[14px] border border-border-brand-soft py-3.5 shadow-[var(--shadow-landing-coach)] ring-0">
            <CardHeader className="gap-1 px-4">
              <CardTitle className="text-[13.5px] font-extrabold text-ink">최근 연 매출</CardTitle>
              <CardDescription className="text-[12.5px] text-text-secondary">
                제안 <strong className="text-brand-hover">3억 2,000만 원</strong> · 국세청 신고 데이터 기준
              </CardDescription>
            </CardHeader>
            <CardContent className="mt-2.5 px-4">
              <Button
                type="button"
                size="sm"
                tabIndex={-1}
                className="h-auto rounded-[9px] px-3.5 py-2 text-[12.5px] font-bold"
              >
                이 값으로 채우기
              </Button>
            </CardContent>
          </Card>

          <Alert className="landing-demo-n3 mt-3 rounded-[12px] border-border-mint-soft bg-surface-mint px-3.5 py-[11px] text-brand-mint-ink">
            <CheckIcon />
            <AlertDescription className="text-[12.5px] font-bold text-brand-mint-ink">
              신청서에 넣었어요 — 최근 연 매출 3억 2,000만 원
            </AlertDescription>
          </Alert>

          <Badge className="landing-demo-n4 mt-3.5 h-auto rounded-full bg-brand-mint-soft px-4 py-2 text-sm font-extrabold whitespace-normal text-brand-mint-ink">
            HWP 신청서 12칸 자동 완성
            <span className="font-semibold text-text-secondary">· 내려받기만 하면 끝</span>
          </Badge>
        </div>
      </div>
    </figure>
  );
}

function DemoFact({ animationClass, label, source }: { animationClass: string; label: string; source: string }) {
  return (
    <div className={`${animationClass} flex items-center gap-[9px] text-[13.5px] text-text-nav`}>
      <CheckIcon className="size-4 shrink-0 text-brand-mint" />
      <span>{label}</span>
      <span className="ml-auto text-[11px] text-text-source">{source}</span>
    </div>
  );
}

function DemoDocumentRow({
  label,
  value,
  state,
}: {
  label: string;
  value: string;
  state: "done" | "checking" | "empty";
}) {
  return (
    <div className="flex border-b border-ink-document last:border-b-0">
      <div className="w-[36%] shrink-0 border-r border-ink-document bg-surface-muted px-[11px] py-[9px] font-bold">{label}</div>
      <div
        className={
          state === "checking"
            ? "flex-1 bg-brand-tint px-[11px] py-[9px] font-sans text-[11.5px] text-text-tertiary outline-2 -outline-offset-2 outline-brand"
            : state === "empty"
              ? "flex-1 bg-surface-document-empty px-[11px] py-[9px] text-text-quaternary"
              : "flex flex-1 items-center px-[11px] py-[9px]"
        }
      >
        {value}
        {state === "done" ? <CheckIcon className="ml-auto size-4 text-brand-mint-ink" /> : null}
      </div>
    </div>
  );
}
