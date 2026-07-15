import Image from "next/image";
import Link from "next/link";
import type { LandingGrantBanner } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    n: 1,
    title: "사업자번호 입력",
    body: "번호 하나면 회사 정보를 자동으로 불러와요",
    tone: "blue",
  },
  {
    n: 2,
    title: "맞춤 매칭",
    body: "지금 신청 가능한 사업과 답하면 확정되는 사업을 나눠 보여줘요",
    tone: "blue",
  },
  {
    n: 3,
    title: "신청 코칭",
    body: "서류의 80%는 미리 채워드리고, 빠진 것만 물어봐요",
    tone: "mint",
  },
] as const;

/** 실제 랜딩 배너를 두 번 이어 붙인 무한 마퀴. 복제 트랙은 보조기기와 탭 순서에서 제외한다. */
export function GrantMarquee({ banners }: { banners: LandingGrantBanner[] }) {
  const items = banners.filter((banner) => banner.title.trim().length > 0).slice(0, 8);
  if (items.length === 0) return null;

  return (
    <section className="overflow-hidden border-t border-border-subtle bg-card pt-2 pb-[26px]">
      <p className="my-[18px] text-center text-[13.5px] font-semibold text-text-tertiary">
        매주 40여 개 기관의 공고를 수집해요
      </p>
      <div className="landing-marquee-track flex w-max">
        <MarqueeGroup items={items} />
        <MarqueeGroup items={items} duplicate />
      </div>
    </section>
  );
}

function MarqueeGroup({ items, duplicate = false }: { items: LandingGrantBanner[]; duplicate?: boolean }) {
  return (
    <div className="flex gap-3 pr-3" aria-hidden={duplicate || undefined}>
      {items.map((banner) => {
        const deadline = landingDeadline(banner);
        const href = banner.url ?? "/matches";
        const external = banner.url !== null;

        return (
          <a
            key={`${duplicate ? "copy:" : ""}${banner.grantId}`}
            href={href}
            tabIndex={duplicate ? -1 : undefined}
            {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
            className="inline-flex items-center gap-2.5 whitespace-nowrap rounded-full border border-border-subtle bg-surface-soft px-[18px] py-2.5 text-sm font-semibold text-ink no-underline transition-colors hover:border-border-card-hover hover:bg-card focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20"
          >
            <span>{banner.title}</span>
            {deadline ? (
              <span
                className={cn(
                  "text-[12.5px] tabular-nums",
                  banner.dDay !== null && banner.dDay >= 0 && banner.dDay <= 14
                    ? "font-extrabold text-danger"
                    : banner.status === "upcoming" || deadline === "상시"
                      ? "font-bold text-brand-mint-ink"
                      : "font-bold text-text-secondary",
                )}
              >
                {deadline}
              </span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}

function landingDeadline(banner: LandingGrantBanner): string | null {
  if (banner.dDay === null) return banner.status === "open" ? "상시" : null;
  if (banner.dDay < 0) return null;
  if (banner.dDay === 0) return "오늘 마감";
  return `D-${banner.dDay}`;
}

/** 디자인 정본의 블루 2장 + 민트 1장 세 단계 안내. */
export function HowItWorks() {
  return (
    <section className="px-4 py-20 text-center sm:px-10 sm:py-[88px]">
      <h2 className="text-[28px] font-extrabold tracking-[-0.6px] text-ink-strong sm:text-[32px]">
        공부 없이, 세 단계면 충분해요
      </h2>
      <div className="mx-auto mt-10 grid max-w-[1000px] gap-4 text-left lg:grid-cols-3">
        {STEPS.map((step) => (
          <Card
            key={step.n}
            className={cn(
              "rounded-[20px] py-[30px] ring-1",
              step.tone === "mint"
                ? "bg-landing-step-mint shadow-[var(--shadow-landing-step-mint)] ring-brand-mint-soft"
                : "bg-landing-step-blue shadow-[var(--shadow-landing-step)] ring-brand-tint",
            )}
          >
            <CardHeader className="gap-0 px-7">
              <Badge
                className={cn(
                  "grid size-[38px] place-items-center rounded-xl p-0 text-base font-extrabold",
                  step.tone === "mint"
                    ? "bg-brand-mint-soft text-brand-mint-ink"
                    : "bg-brand-tint text-brand",
                )}
              >
                {step.n}
              </Badge>
              <CardTitle className="mt-3.5 text-lg font-extrabold text-ink">{step.title}</CardTitle>
              <CardDescription className="mt-2 text-[14.5px] leading-[1.65] text-text-secondary">
                {step.body}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** 회사(주식회사 노튼) 푸터 — 워드마크 + 법적 링크 / 구분선 / © + 법인 정보. */
export function LandingFooter() {
  return (
    <footer className="border-t border-border-subtle">
      <div className="mx-auto max-w-[1000px] px-4 pt-12 pb-14 sm:px-10">
        <div className="flex flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
          <Image
            src="/brand/noten-logo.svg"
            alt="NOTEN"
            width={123}
            height={14}
            className="opacity-90"
          />
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm font-semibold text-text-nav">
            <Link href="/calendar" className="no-underline transition-colors hover:text-ink">
              마감 캘린더
            </Link>
            <Link href="/terms" className="no-underline transition-colors hover:text-ink">
              이용약관
            </Link>
            <Link href="/privacy" className="no-underline transition-colors hover:text-ink">
              개인정보처리방침
            </Link>
            <Link href="/support" className="no-underline transition-colors hover:text-ink">
              도움받기
            </Link>
          </nav>
        </div>
        <Separator className="mt-9 mb-7 bg-border-subtle" />
        <div className="flex flex-col gap-1.5">
          <span className="text-[15px] font-semibold text-ink">© 2026 NOTEN Inc.</span>
          <span className="text-[13px] text-text-tertiary tabular-nums">
            주식회사 노튼 · 사업자등록번호 : 237-86-03641
          </span>
        </div>
      </div>
    </footer>
  );
}
