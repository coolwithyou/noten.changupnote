import type { HeaderUser } from "@/lib/server/auth/session";
import { ServiceHeader } from "@/components/app/service-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface LegalSection {
  title: string;
  body: string[];
}

export interface LegalSummaryItem {
  label: string;
  value: string;
}

export function LegalPage({
  user,
  eyebrow,
  title,
  description,
  effectiveDate,
  version,
  summary,
  sections,
}: {
  user: HeaderUser | null;
  eyebrow: string;
  title: string;
  description: string;
  effectiveDate: string;
  version: string;
  summary: LegalSummaryItem[];
  sections: LegalSection[];
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader
        user={user}
        links={[
          { href: "/support", label: "고객지원" },
          { href: "/terms", label: "이용약관" },
          { href: "/privacy", label: "개인정보" },
        ]}
      />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">{eyebrow}</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">{title}</h1>
            <p className="text-base leading-7 text-muted-foreground">{description}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a className={buttonVariants({ variant: "outline" })} href="/support">문의하기</a>
            <a className={buttonVariants()} href={user ? "/dashboard" : "/login"}>{user ? "대시보드" : "로그인"}</a>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-4" aria-label="문서 요약">
          <Card>
            <CardHeader>
              <CardTitle>시행일</CardTitle>
              <CardDescription>{version} 정책 문서입니다.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <strong className="text-lg font-semibold text-foreground">{effectiveDate}</strong>
              <p className="text-sm leading-6 text-muted-foreground">운영 정보와 문의처는 서비스 환경 설정을 기준으로 표시됩니다.</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="grid gap-3">
              {summary.map((item) => (
                <div className="rounded-[var(--radius-lg)] border bg-muted/20 p-3" key={item.label}>
                  <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
                  <strong className="mt-1 block text-sm font-semibold text-foreground">{item.value}</strong>
                </div>
              ))}
            </CardContent>
          </Card>
          <nav className="flex flex-col gap-1 rounded-[var(--radius-xl)] border bg-card p-3 text-sm shadow-[var(--shadow-subtle)]">
            {sections.map((section) => (
              <a className={buttonVariants({ variant: "ghost", size: "sm", className: "justify-start" })} key={section.title} href={`#${slug(section.title)}`}>{section.title}</a>
            ))}
          </nav>
        </aside>
        <article className="rounded-[var(--radius-xl)] border bg-card p-5 shadow-[var(--shadow-subtle)] sm:p-8">
          {sections.map((section) => (
            <section className="border-b py-6 first:pt-0 last:border-b-0 last:pb-0" id={slug(section.title)} key={section.title}>
              <h2 className="text-xl font-semibold tracking-normal text-foreground">{section.title}</h2>
              <div className="mt-4 grid gap-3">
                {section.body.map((paragraph) => (
                  <p className="text-sm leading-7 text-muted-foreground" key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </article>
      </section>
      </div>
    </main>
  );
}

function slug(value: string): string {
  return value
    .replace(/\s+/g, "-")
    .replace(/[^\w가-힣-]/g, "")
    .toLowerCase();
}
