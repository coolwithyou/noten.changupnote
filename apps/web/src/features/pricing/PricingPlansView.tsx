"use client";

import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// /pricing 공개 요금제 화면 — 디자인 정본 프레임 5a(화면 9)·5b(비교표 펼침) 재현.
// docs/design/2026-07-15-changupnote-frames.dc.html 483~559행. 카피·구조·CTA 문구를 그대로 따른다.
// 결제는 아직 새 모델(멤버십·이용권)로 준비되지 않았으므로, 로그인 상태에서는
// CTA를 비활성화하고 "결제 오픈 준비 중이에요" 캡션으로 정직하게 안내한다(가짜 결제 플로우 금지).

const LOGIN_HREF = `/login?callbackUrl=${encodeURIComponent("/pricing")}`;

const FREE_FEATURES = [
  "사업자번호 매칭·판정 전부 무료",
  "새 공고 주 1회 이메일 요약",
  "'확인 필요' 질문 월 3회",
  "신청서 도우미 가입 축하 2회",
];

type CompareCell =
  | { kind: "check" }
  | { kind: "none" }
  | { kind: "text"; value: string; strong?: boolean };

const CHECK: CompareCell = { kind: "check" };
const NONE: CompareCell = { kind: "none" };
const text = (value: string, strong = false): CompareCell => ({ kind: "text", value, strong });

const COMPARISON_SECTIONS: {
  title: string;
  rows: { label: string; free: CompareCell; member: CompareCell }[];
}[] = [
  {
    title: "공고 찾기 — 전부 무료",
    rows: [
      { label: "매칭·판정", free: CHECK, member: CHECK },
      { label: "근거·상세 보기", free: CHECK, member: CHECK },
    ],
  },
  {
    title: "놓치지 않기",
    rows: [
      { label: "새 공고 알림", free: text("주 1회 이메일"), member: text("실시간", true) },
      { label: "마감 리마인더", free: NONE, member: CHECK },
      { label: "새로 열린 공고 감지", free: NONE, member: CHECK },
    ],
  },
  {
    title: "확인하기",
    rows: [{ label: "'확인 필요' 질문", free: text("월 3회"), member: text("무제한", true) }],
  },
  {
    title: "신청하기",
    rows: [
      {
        label: "신청서 도우미",
        free: text("가입 축하 2회"),
        member: text("매달 12회 (60일 이월)", true),
      },
      {
        label: "이용권 팩 구매",
        free: text("가능"),
        member: text("가능 (회당 단가는 멤버십이 유리)"),
      },
    ],
  },
  {
    title: "계정",
    rows: [
      { label: "회사 수", free: text("1"), member: text("1") },
      { label: "세금계산서", free: NONE, member: CHECK },
    ],
  },
];

const FAQ_ITEMS = [
  {
    q: "남은 횟수는 어떻게 이월되나요?",
    a: "멤버십으로 받는 매달 12회 중 이번 달에 다 못 쓴 횟수는 60일까지 이월돼요. 이용권으로 구매한 횟수는 유효기간이 5년이라 충분히 천천히 쓰셔도 됩니다.",
  },
  {
    q: "해지와 환불은 어떻게 되나요?",
    a: "해지는 언제든 할 수 있고, 다음 결제 전에 미리 알림을 드려요. 결제 후 7일 이내 미사용분은 청약철회로 환불받을 수 있습니다.",
  },
  {
    q: "세금계산서를 받을 수 있나요?",
    a: "네, 멤버십 결제분에 대해 세금계산서를 발행해 드려요.",
  },
  {
    q: "무료로는 어디까지 쓸 수 있나요?",
    a: "사업자번호 매칭과 판정, 근거·상세 확인은 전부 무료예요. 새 공고는 주 1회 이메일로 요약해 드리고, '확인 필요' 질문은 월 3회, 신청서 도우미는 가입 축하로 2회 드립니다.",
  },
];

export function PricingPlansView({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <div className="mx-auto w-full max-w-[880px] px-5 pt-16 pb-20">
      {/* 헤드라인 */}
      <div className="text-center">
        <h1 className="text-[32px] font-extrabold tracking-[-0.8px] text-foreground sm:text-[36px]">
          요금제는 하나예요
        </h1>
        <p className="mx-auto mt-3.5 max-w-[560px] text-base leading-[1.7] text-text-secondary">
          공고를 찾고 확인하는 건 전부 무료. 돈을 받는 건 두 가지뿐입니다 — 공고를 놓치지 않게
          챙겨드리는 일, 신청서를 대신 써드리는 일.
        </p>
      </div>

      {/* 플랜 카드 2장 */}
      <div className="mt-11 flex flex-col items-stretch gap-5 md:flex-row">
        <FreeCard />
        <MembershipCard isLoggedIn={isLoggedIn} />
      </div>

      {/* 비교표 (접힘/펼침) */}
      <Collapsible>
        <div className="mt-6 text-center">
          <CollapsibleTrigger
            render={
              <Button variant="link" className="text-sm font-bold">
                자세히 비교하기 ▸
              </Button>
            }
          />
        </div>
        <CollapsibleContent>
          <ComparisonTable />
        </CollapsibleContent>
      </Collapsible>

      {/* 이용권 배너 */}
      <PassBanner isLoggedIn={isLoggedIn} />

      <p className="mt-[22px] text-center text-[13.5px] text-text-tertiary">
        공고가 뜸한 달이 있죠. 남은 횟수는 이월되고, 해지는 언제든 됩니다. 다음 결제 전에 알림도
        드려요.
      </p>

      {/* FAQ */}
      <Accordion className="mt-11 border-t border-border">
        {FAQ_ITEMS.map((item) => (
          <AccordionItem key={item.q} value={item.q} className="last:border-b">
            <AccordionTrigger className="px-1 py-[18px] text-[15.5px] font-semibold text-foreground hover:no-underline">
              {item.q}
            </AccordionTrigger>
            <AccordionContent className="px-1 pb-[18px]">
              <p className="text-sm leading-[1.7] text-text-secondary">{item.a}</p>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>

      {/* 대행사·기관 문의 */}
      <div className="mt-9 flex flex-col items-start gap-4 rounded-[20px] bg-surface-soft px-[26px] py-[22px] sm:flex-row sm:items-center">
        <p className="flex-1 text-[14.5px] leading-[1.6] text-text-nav">
          여러 회사를 관리하시나요? 대행사·컨설턴트·기관을 위한 플랜은 문의 주세요.
        </p>
        <Link
          href="/support"
          className={buttonVariants({ variant: "outline", size: "sm", className: "shrink-0" })}
        >
          문의하기
        </Link>
      </div>
    </div>
  );
}

function FeatureItem({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <li className="flex items-start gap-[9px] text-[14.5px] leading-normal text-text-nav">
      <span aria-hidden="true" className="font-extrabold text-brand-mint">
        ✓
      </span>
      <span>
        {children}
        {note ? <span className="mt-[3px] block text-xs text-text-tertiary">{note}</span> : null}
      </span>
    </li>
  );
}

function FreeCard() {
  return (
    <section
      aria-label="Free"
      className="flex-1 rounded-[20px] border border-border-card bg-card px-[30px] py-8 shadow-[var(--shadow-notice)]"
    >
      <div className="text-sm font-extrabold text-text-secondary">Free</div>
      <div className="mt-2 text-[30px] font-extrabold text-foreground tabular-nums">0원</div>
      <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-5 w-full" })}>
        무료로 시작하기
      </Link>
      <ul className="mt-6 flex flex-col gap-[11px]">
        {FREE_FEATURES.map((feature) => (
          <FeatureItem key={feature}>{feature}</FeatureItem>
        ))}
      </ul>
    </section>
  );
}

function MembershipCard({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <section
      aria-label="멤버십"
      className="relative rounded-[20px] border-[1.5px] border-border-mint-strong bg-pricing-featured px-[30px] py-8 shadow-[var(--shadow-pricing-featured)] md:flex-[1.08] md:scale-[1.02]"
    >
      <span className="absolute -top-[13px] left-7 rounded-full bg-grad-gauge px-3.5 py-1.5 text-[12.5px] font-extrabold text-primary-foreground shadow-[var(--shadow-pricing-badge)]">
        기업이라면 일단
      </span>
      <div className="text-sm font-extrabold text-brand-mint-ink">멤버십</div>
      <div className="mt-2 text-[30px] font-extrabold text-foreground tabular-nums">월 9,900원</div>
      <p className="mt-2.5 text-sm leading-[1.65] text-text-nav">
        월 9,900원이면 공고 놓칠 일이 없고, 신청서 도우미가 매달 12회 함께합니다.
      </p>
      <div className="mt-[18px]">
        {isLoggedIn ? (
          <PaymentPendingCta label="멤버십 시작하기" className="w-full" />
        ) : (
          <Link href={LOGIN_HREF} className={buttonVariants({ className: "w-full" })}>
            멤버십 시작하기
          </Link>
        )}
      </div>
      <ul className="mt-6 flex flex-col gap-[11px]">
        <FeatureItem>실시간 맞춤 알림 + 마감 리마인더</FeatureItem>
        <FeatureItem>&apos;확인 필요&apos; 질문 무제한</FeatureItem>
        <FeatureItem note="이번 달에 다 못 쓰면 60일까지 이월돼요">신청서 도우미 매달 12회</FeatureItem>
        <FeatureItem>세금계산서 발행</FeatureItem>
      </ul>
    </section>
  );
}

/** 결제 미오픈 상태의 정직한 CTA — 디자인 문구는 유지하고 비활성 + 준비 중 캡션으로 안내. */
function PaymentPendingCta({
  label,
  variant = "default",
  size = "default",
  className,
}: {
  label: string;
  variant?: "default" | "brand-outline";
  size?: "default" | "sm";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <Button variant={variant} size={size} disabled className="w-full">
        {label}
      </Button>
      <span role="status" className="text-xs text-text-tertiary">
        결제 오픈 준비 중이에요
      </span>
    </div>
  );
}

function PassBanner({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <div className="mt-10 flex flex-col items-start gap-5 rounded-[20px] border border-brand-tint bg-pricing-pass px-7 py-6 sm:flex-row sm:items-center">
      <div className="flex-1">
        <div className="text-base font-extrabold text-foreground">더 필요하면 그때 사세요</div>
        <div className="mt-[5px] text-[13.5px] text-text-secondary">멤버십이 회당 더 저렴해요</div>
      </div>
      <div className="flex items-center gap-3.5 rounded-[14px] border border-border-card bg-card px-5 py-3.5 shadow-[var(--shadow-notice)]">
        <span className="text-[15px] font-extrabold text-foreground tabular-nums">
          이용권 5회 — 3,900원
        </span>
        {isLoggedIn ? (
          <PaymentPendingCta label="구매하기" variant="brand-outline" size="sm" className="shrink-0" />
        ) : (
          <Link
            href={LOGIN_HREF}
            className={buttonVariants({ variant: "brand-outline", size: "sm", className: "shrink-0" })}
          >
            구매하기
          </Link>
        )}
      </div>
    </div>
  );
}

function ComparisonCell({ cell }: { cell: CompareCell }) {
  if (cell.kind === "check") {
    return (
      <span aria-label="제공" className="flex-1 text-center font-extrabold text-brand-mint">
        ✓
      </span>
    );
  }
  if (cell.kind === "none") {
    return (
      <span aria-label="미제공" className="flex-1 text-center text-text-quaternary">
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex-1 text-center",
        cell.strong ? "font-bold text-foreground" : "text-text-secondary",
      )}
    >
      {cell.value}
    </span>
  );
}

function ComparisonTable() {
  const lastSection = COMPARISON_SECTIONS.length - 1;
  return (
    <div className="mt-4 rounded-2xl border border-border-card bg-card px-[30px] py-7 shadow-[var(--shadow-notice)]">
      <div className="flex border-b border-border px-1 pb-2.5 text-[13px] font-extrabold text-text-tertiary">
        <span className="flex-[1.4]" />
        <span className="flex-1 text-center">Free</span>
        <span className="flex-1 text-center text-brand-mint-ink">멤버십</span>
      </div>
      {COMPARISON_SECTIONS.map((section, sectionIndex) => (
        <div key={section.title}>
          <div className="px-1 pt-4 pb-1.5 text-[12.5px] font-extrabold text-brand">
            {section.title}
          </div>
          {section.rows.map((row, rowIndex) => (
            <div
              key={row.label}
              className={cn(
                "flex items-center px-1 py-2.5 text-sm",
                sectionIndex === lastSection && rowIndex === section.rows.length - 1
                  ? null
                  : "border-b border-surface-hard",
              )}
            >
              <span className="flex-[1.4] font-semibold text-foreground">{row.label}</span>
              <ComparisonCell cell={row.free} />
              <ComparisonCell cell={row.member} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
