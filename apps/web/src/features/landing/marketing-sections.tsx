import Link from "next/link";
import { BellRing, Check, ClipboardCheck, Target } from "lucide-react";
import type { LandingGrantBanner } from "@cunote/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { formatSupportAmount } from "./biz-lookup-utils";

const AGENCIES = [
  "중소벤처기업부",
  "소상공인시장진흥공단",
  "창업진흥원",
  "KOTRA",
  "한국콘텐츠진흥원",
  "중소벤처기업진흥공단",
];

const STEPS: Array<{ n: number; title: string; body: string }> = [
  { n: 1, title: "사업자번호 입력", body: "번호 하나만 넣으면 사업자 정보를 자동으로 불러와요. 따로 작성할 게 없어요." },
  { n: 2, title: "맞춤 매칭", body: "표준화된 지원사업과 우리 회사를 대조해 지원 가능성이 높은 사업과 확인이 필요한 사업을 나눠 보여줘요." },
  { n: 3, title: "신청 코칭", body: "필요한 서류와 데이터를 회사에 맞춰 채워주고, 빠진 것만 알려드려요." },
];

const FEATURES: Array<{ icon: typeof Target; tag: string; title: string; body: string; bullets: string[] }> = [
  {
    icon: Target,
    tag: "표준화 매칭 엔진",
    title: "지원 가능성과 확인할 조건을 한눈에",
    body: "업종·업력·지역·매출을 공고의 자격요건과 대조해, 받을 수 있는 사업만 점수와 함께 정렬해요.",
    bullets: ["필수·제외조건 자동 대조와 확인도 표시", "지원금 규모·마감일까지 한눈에"],
  },
  {
    icon: ClipboardCheck,
    tag: "회사 맞춤 신청 코칭",
    title: "서류의 80%는 이미 채워져 있어요",
    body: "회사 정보로 채울 수 있는 건 미리 채워두고, 직접 준비할 것만 콕 집어 알려드려요.",
    bullets: ["사업계획서 초안 자동 생성", "부족한 서류만 콕 집어 안내"],
  },
  {
    icon: BellRing,
    tag: "마감 알림",
    title: "받을 수 있는 돈을 마감으로 놓치지 않게",
    body: "자격이 되는 공고의 마감이 다가오면 미리 알려드리고, 새로 열린 맞춤 공고도 매주 챙겨요.",
    bullets: ["마감 임박 D-day 알림", "신규 맞춤 공고 주간 요약"],
  },
];

export function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-sm font-bold tracking-wide text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-balance text-foreground sm:text-3xl">
        {title}
      </h2>
      {description ? <p className="mt-3 text-base text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/** 소셜프루프 — 실제 열린 공고가 있으면 카드로, 없으면 기관 배지로 폴백. */
export function SocialProof({ banners, sourceCount }: { banners: LandingGrantBanner[]; sourceCount: number }) {
  const openBanners = banners.filter((banner) => banner.title).slice(0, 3);
  const sourceLabel = sourceCount > 0 ? sourceCount.toLocaleString("ko-KR") : "40";

  return (
    <section className="border-y bg-card">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <p className="text-center text-sm font-medium text-muted-foreground">
          매주 {sourceLabel}여 개 기관의 공고를 수집해 표준화해요
        </p>

        {openBanners.length > 0 ? (
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {openBanners.map((banner) => (
              <GrantPreviewCard key={banner.grantId} banner={banner} />
            ))}
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {AGENCIES.map((agency) => (
              <Badge key={agency} variant="outline" className="px-3 py-1 text-sm">
                {agency}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function GrantPreviewCard({ banner }: { banner: LandingGrantBanner }) {
  const amount = formatSupportAmount(banner.supportAmountMax);
  const href = banner.url ?? "/matches";
  const external = banner.url != null;
  const deadline =
    banner.dDay != null ? (banner.dDay <= 0 ? "마감" : `D-${banner.dDay}`) : null;

  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      className="group/grant block focus-visible:outline-none"
    >
      <Card
        size="sm"
        className="h-full transition-shadow group-hover/grant:shadow-[var(--shadow-standard)] group-focus-visible/grant:ring-2 group-focus-visible/grant:ring-ring"
      >
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary">{banner.category ?? banner.agency ?? "지원사업"}</Badge>
            {deadline ? (
              <Badge variant={banner.dDay != null && banner.dDay <= 7 ? "destructive" : "outline"}>
                {deadline}
              </Badge>
            ) : null}
          </div>
          <CardTitle className="line-clamp-2 text-sm leading-snug">{banner.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-muted-foreground">{banner.agency ?? "공공기관"}</span>
          {amount ? (
            <span className="shrink-0 text-xs font-semibold text-foreground tabular-nums">{amount}</span>
          ) : null}
        </CardContent>
      </Card>
    </a>
  );
}

/** 작동 방식 — Work zone(낮은 강도 grain). */
export function HowItWorks() {
  return (
    <section id="how" className="texture-grain relative overflow-hidden">
      <div className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
        <SectionIntro eyebrow="작동 방식" title="공부 없이, 세 단계면 충분해요" description="입력부터 신청 준비까지 평균 30초." />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {STEPS.map((step) => (
            <Card key={step.n} className="bg-card">
              <CardHeader>
                <span
                  className="grid size-10 place-items-center rounded-[var(--radius-md)] bg-brand-tint text-base font-extrabold text-primary tabular-nums"
                  aria-hidden
                >
                  {step.n}
                </span>
                <CardTitle className="mt-4 text-lg">{step.title}</CardTitle>
                <CardDescription className="mt-2 text-[15px] leading-relaxed">{step.body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/** 핵심 기능 — Work zone(무지). */
export function Features() {
  return (
    <section id="features" className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
      <SectionIntro eyebrow="핵심 기능" title="찾고, 판단하고, 준비하는 일을 대신해요" />
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <Card key={feature.tag} className="h-full">
              <CardHeader>
                <span
                  className="grid size-11 place-items-center rounded-[var(--radius-md)] bg-brand-tint text-primary"
                  aria-hidden
                >
                  <Icon className="size-5" />
                </span>
                <Badge variant="secondary" className="mt-4 w-fit">
                  {feature.tag}
                </Badge>
                <CardTitle className="mt-2 text-lg text-balance">{feature.title}</CardTitle>
                <CardDescription className="mt-2 text-[15px] leading-relaxed">{feature.body}</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2.5">
                  {feature.bullets.map((bullet) => (
                    <li key={bullet} className="flex items-start gap-2 text-sm text-foreground">
                      <span
                        className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-success/12 text-success"
                        aria-hidden
                      >
                        <Check className="size-3" />
                      </span>
                      {bullet}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

/** 신뢰 지표 — 데이터 기반 3개 숫자. */
export function TrustStats({ activeCount, sourceCount }: { activeCount: string; sourceCount: number }) {
  const stats: Array<{ value: string; unit: string; label: string }> = [
    { value: activeCount, unit: "건", label: "지금 신청 가능한 지원사업" },
    { value: sourceCount > 0 ? sourceCount.toLocaleString("ko-KR") : "40", unit: "여 기관", label: "매주 수집·표준화하는 공고 출처" },
    { value: "30", unit: "초", label: "사업자번호 입력부터 결과까지" },
  ];

  return (
    <section className="border-y bg-card">
      <div className="mx-auto grid max-w-4xl gap-8 px-4 py-14 text-center sm:grid-cols-3 sm:px-6">
        {stats.map((stat) => (
          <div key={stat.label}>
            <p className="text-4xl font-extrabold tracking-tight text-foreground tabular-nums sm:text-5xl">
              {stat.value}
              <span className="ml-1 text-lg font-bold text-muted-foreground">{stat.unit}</span>
            </p>
            <p className="mt-2 text-sm text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const FOOTER_COLUMNS: Array<{ title: string; links: Array<[string, string]> }> = [
  { title: "제품", links: [["지원사업 찾기", "/"], ["신청 코칭", "/dashboard"], ["마감 알림", "/dashboard"]] },
  { title: "회사", links: [["도입 문의", "/support"], ["개인정보처리방침", "/privacy"], ["이용약관", "/terms"]] },
];

export function LandingFooter() {
  return (
    <footer className="border-t bg-card">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <div className="flex flex-wrap justify-between gap-8">
          <div className="max-w-xs">
            <div className="flex items-center gap-2">
              <span
                className="grid size-7 place-items-center rounded-[var(--radius-md)] bg-primary text-xs font-extrabold text-primary-foreground"
                aria-hidden
              >
                C
              </span>
              <span className="font-extrabold text-foreground">창업노트</span>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              사업자번호 하나로 받을 수 있는 지원사업을 찾고 신청까지 코칭해요.
            </p>
          </div>
          <div className="flex gap-12">
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.title} className="flex flex-col gap-2.5">
                <p className="text-xs font-bold text-muted-foreground">{column.title}</p>
                {column.links.map(([label, href]) => (
                  <Link
                    key={label}
                    href={href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>
        <Separator className="my-6" />
        <p className="text-sm text-muted-foreground">© 2026 바톤 (Baton)</p>
      </div>
    </footer>
  );
}
