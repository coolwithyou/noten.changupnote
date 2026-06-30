import { Clock, LifeBuoy, Mail, ShieldCheck } from "lucide-react";
import { ServiceHeader } from "@/components/app/service-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { getLegalConfig } from "@/lib/server/legal/legalConfig";
import { SupportTicketForm } from "@/features/support/SupportTicketForm";

const SUPPORT_ITEMS = [
  {
    icon: <LifeBuoy />,
    title: "제품 문의",
    description: "도입, 요금제, 팀 사용, 지원사업 데이터 커버리지에 대한 문의를 받습니다.",
  },
  {
    icon: <ShieldCheck />,
    title: "개인정보와 권한",
    description: "회사 접근 권한, 동의 철회, 데이터 삭제 요청은 우선 처리합니다.",
  },
  {
    icon: <Clock />,
    title: "운영 시간",
    description: "평일 10:00-18:00 기준으로 확인하며, 긴급 보안 이슈는 우선 대응합니다.",
  },
];
const ACCOUNT_SUPPORT_CALLBACK = "/account#account-support-tickets";
const ACCOUNT_SUPPORT_LOGIN_HREF = `/login?${new URLSearchParams({ callbackUrl: ACCOUNT_SUPPORT_CALLBACK }).toString()}`;

export const dynamic = "force-dynamic";

export default async function SupportPage() {
  const user = await getOptionalHeaderUser();
  const config = getLegalConfig();
  return (
    <main className="saas-shell support-shell">
      <ServiceHeader
        user={user}
        variant="landing"
        links={[
          { href: "/terms", label: "이용약관" },
          { href: "/privacy", label: "개인정보" },
          ...(user ? [{ href: "/dashboard", label: "대시보드" }] : []),
        ]}
        loginCallbackUrl="/support"
      />

      <section className="saas-hero compact">
        <div>
          <p className="eyebrow">고객지원</p>
          <h1>지원사업 신청 흐름이 막히면 여기서 시작하세요</h1>
          <p>계정, 회사 인증, 매칭 결과, 신청서류 초안, 개인정보 요청까지 제품 운영팀이 확인할 수 있는 진입점입니다.</p>
        </div>
        <div className="saas-hero-actions">
          <a className={buttonVariants()} href={`mailto:${config.supportEmail}`}>
            <Mail data-icon="inline-start" />
            {config.supportEmail}
          </a>
          <a className={buttonVariants({ variant: "outline" })} href={user ? ACCOUNT_SUPPORT_CALLBACK : ACCOUNT_SUPPORT_LOGIN_HREF}>
            {user ? "내 문의 보기" : "로그인 후 문의 보기"}
          </a>
        </div>
      </section>

      <section className="saas-grid three">
        {SUPPORT_ITEMS.map((item) => (
          <Card className="saas-info-card" key={item.title}>
            <CardContent className="p-0">
              <span aria-hidden>{item.icon}</span>
              <strong>{item.title}</strong>
              <p>{item.description}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="support-flow">
        <SupportTicketForm
          defaultEmail={user?.email ?? null}
          defaultName={user?.name ?? null}
          accountSupportHref={user ? ACCOUNT_SUPPORT_CALLBACK : ACCOUNT_SUPPORT_LOGIN_HREF}
          accountSupportLabel={user ? "내 문의 보기" : "로그인 후 문의 보기"}
        />

        <Card className="saas-panel">
          <CardContent className="p-0">
            <span className="eyebrow">빠른 해결</span>
            <h2>문의 전에 확인할 것</h2>
            <ol>
              <li>회사 설정에서 기본정보 동의와 사업자번호 검증 상태를 확인합니다.</li>
              <li>공고 상세의 신청 링크와 첨부 양식 원문을 함께 확인합니다.</li>
              <li>AI 초안은 제출용 문서가 아니라 작성 재료이므로 제출 전 직접 검토합니다.</li>
              <li>개인정보 삭제나 동의 철회는 설정 페이지 또는 이메일로 요청합니다.</li>
            </ol>
          </CardContent>
        </Card>

        <Card className="saas-panel support-policy-panel">
          <CardContent className="p-0">
            <span className="eyebrow">운영 기준</span>
            <h2>접수 후 처리 방식</h2>
            <div className="support-policy-list">
              <p><strong>접수 확인</strong><span>문의가 저장되면 접수번호가 발급되고, 로그인 사용자는 계정 화면에서 공개 답변을 이어서 확인합니다.</span></p>
              <p><strong>우선 처리</strong><span>개인정보 삭제, 권한 오류, 보안 이슈, 신청 마감 임박 오류를 우선 검토합니다.</span></p>
              <p><strong>운영 문의처</strong><span>{config.operatorName} · {config.supportEmail}</span></p>
            </div>
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
