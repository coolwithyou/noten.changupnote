import type { HeaderUser } from "@/lib/server/auth/session";
import { ServiceHeader } from "@/components/app/service-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

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
    <main className="saas-shell legal-shell">
      <ServiceHeader
        user={user}
        variant="landing"
        links={[
          { href: "/support", label: "고객지원" },
          { href: "/terms", label: "이용약관" },
          { href: "/privacy", label: "개인정보" },
        ]}
      />

      <section className="saas-hero compact">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="saas-hero-actions">
          <a className={buttonVariants({ variant: "outline" })} href="/support">문의하기</a>
          <a className={buttonVariants()} href={user ? "/dashboard" : "/login"}>{user ? "대시보드" : "로그인"}</a>
        </div>
      </section>

      <section className="legal-layout">
        <aside className="legal-rail" aria-label="문서 요약">
          <Card>
            <CardContent className="p-0">
              <span>시행일</span>
              <strong>{effectiveDate}</strong>
              <p>{version} 정책 문서입니다. 운영 정보와 문의처는 서비스 환경 설정을 기준으로 표시됩니다.</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-0 legal-summary-list">
              {summary.map((item) => (
                <div key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </CardContent>
          </Card>
          <nav>
            {sections.map((section) => (
              <a key={section.title} href={`#${slug(section.title)}`}>{section.title}</a>
            ))}
          </nav>
        </aside>
        <article className="legal-document">
          {sections.map((section) => (
            <section id={slug(section.title)} key={section.title}>
              <h2>{section.title}</h2>
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </section>
          ))}
        </article>
      </section>
    </main>
  );
}

function slug(value: string): string {
  return value
    .replace(/\s+/g, "-")
    .replace(/[^\w가-힣-]/g, "")
    .toLowerCase();
}
