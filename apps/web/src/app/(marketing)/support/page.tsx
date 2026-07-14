import { Clock, LifeBuoy, Mail, ShieldCheck } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
const ACCOUNT_SUPPORT_CALLBACK = "/settings?section=activity";
const ACCOUNT_SUPPORT_LOGIN_HREF = `/login?${new URLSearchParams({ callbackUrl: ACCOUNT_SUPPORT_CALLBACK }).toString()}`;

export const dynamic = "force-dynamic";

/** ?category= 허용값 (SupportTicketForm CATEGORY_ITEMS 와 정렬). */
const PREFILL_CATEGORIES = ["product", "account", "privacy", "billing", "bug", "coaching"] as const;
type PrefillCategory = (typeof PREFILL_CATEGORIES)[number];

export default async function SupportPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getOptionalHeaderUser();
  const config = getLegalConfig();
  // 공고 상세 "도움받기" 진입 prefill (계획 2026-07-08 슬라이스 C): ?category=coaching&topic=<공고명>
  const query = (await searchParams) ?? {};
  const rawCategory = firstParam(query.category);
  const initialCategory: PrefillCategory =
    rawCategory && (PREFILL_CATEGORIES as readonly string[]).includes(rawCategory)
      ? (rawCategory as PrefillCategory)
      : "product";
  const topic = firstParam(query.topic)?.slice(0, 200) ?? null;
  const initialSubject = topic
    ? initialCategory === "coaching"
      ? `[코칭 신청] ${topic}`
      : `[문의] ${topic}`
    : "";
  const initialMessage = topic
    ? initialCategory === "coaching"
      ? `지원사업: ${topic}\n\n코칭 받고 싶은 부분(작성 항목, 자격 요건, 제출 서류 등)을 적어주세요.\n`
      : `지원사업: ${topic}\n\n`
    : "";
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <span className="text-sm font-medium text-muted-foreground">고객지원</span>
            <h1 className="text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
              지원사업 신청 흐름이 막히면 여기서 시작하세요
            </h1>
            <p className="text-base leading-7 text-muted-foreground">
              계정, 회사 인증, 매칭 결과, 신청서류 초안, 개인정보 요청까지 제품 운영팀이 확인할 수 있는 진입점입니다.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a className={buttonVariants()} href={`mailto:${config.supportEmail}`}>
              <Mail data-icon="inline-start" />
              {config.supportEmail}
            </a>
            <a className={buttonVariants({ variant: "outline" })} href={user ? ACCOUNT_SUPPORT_CALLBACK : ACCOUNT_SUPPORT_LOGIN_HREF}>
              {user ? "내 문의 보기" : "로그인 후 문의 보기"}
            </a>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          {SUPPORT_ITEMS.map((item) => (
            <Card key={item.title}>
              <CardContent className="flex min-h-32 flex-col gap-3">
                <span className="flex size-9 items-center justify-center rounded-[var(--radius-lg)] bg-muted text-muted-foreground" aria-hidden>
                  {item.icon}
                </span>
                <div className="flex flex-col gap-1">
                  <strong className="text-sm font-semibold text-foreground">{item.title}</strong>
                  <p className="text-sm leading-6 text-muted-foreground">{item.description}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <SupportTicketForm
            defaultEmail={user?.email ?? null}
            defaultName={user?.name ?? null}
            accountSupportHref={user ? ACCOUNT_SUPPORT_CALLBACK : ACCOUNT_SUPPORT_LOGIN_HREF}
            accountSupportLabel={user ? "내 문의 보기" : "로그인 후 문의 보기"}
            initialCategory={initialCategory}
            initialSubject={initialSubject}
            initialMessage={initialMessage}
          />

          <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>문의 전에 확인할 것</CardTitle>
              <CardDescription>빠른 해결을 위해 먼저 확인할 항목입니다.</CardDescription>
            </CardHeader>
            <CardContent>
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
              <li>회사 설정에서 기본정보 동의와 사업자번호 검증 상태를 확인합니다.</li>
              <li>공고 상세의 신청 링크와 첨부 양식 원문을 함께 확인합니다.</li>
              <li>AI 초안은 제출용 문서가 아니라 작성 재료이므로 제출 전 직접 검토합니다.</li>
              <li>개인정보 삭제나 동의 철회는 설정 페이지 또는 이메일로 요청합니다.</li>
            </ol>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>접수 후 처리 방식</CardTitle>
            <CardDescription>문의가 접수된 뒤 운영팀이 확인하는 기준입니다.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
              <p className="grid gap-1 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">접수 확인</strong><span>문의가 저장되면 접수번호가 발급되고, 로그인 사용자는 계정 화면에서 공개 답변을 이어서 확인합니다.</span></p>
              <p className="grid gap-1 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">우선 처리</strong><span>개인정보 삭제, 권한 오류, 보안 이슈, 신청 마감 임박 오류를 우선 검토합니다.</span></p>
              <p className="grid gap-1 text-sm leading-6 text-muted-foreground"><strong className="text-foreground">운영 문의처</strong><span>{config.operatorName} · {config.supportEmail}</span></p>
          </CardContent>
        </Card>
          </div>
        </section>
      </div>
    </main>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
