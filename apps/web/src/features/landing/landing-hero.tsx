import Link from "next/link";
import { Check, Clock, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { HeaderUser } from "@/lib/server/auth/session";
import { BizLookupForm } from "./biz-lookup-form";

/**
 * 히어로 = Brand zone. 블루+민트 라이트 메시 + grain + 입력창 뒤 글로우.
 * 유일한 주연은 비로그인 방문자의 사업자번호 즉시 조회다. 셸(서버) 안에 폼 리프(클라)만 심는다.
 */
export function LandingHero({ activeCount, user }: { activeCount: string; user: HeaderUser | null }) {
  return (
    <section className="texture-grain bg-mesh relative overflow-hidden" data-zone="brand">
      <div className="mx-auto flex max-w-3xl flex-col items-center px-4 py-20 text-center sm:px-6 sm:py-28">
        <Badge variant="outline" className="gap-2 bg-card/70 px-3 py-1 backdrop-blur">
          <span className="size-2 rounded-full bg-success" aria-hidden />
          지금 신청 가능한 지원사업 {activeCount}건
        </Badge>

        <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-balance text-foreground sm:text-5xl sm:leading-[1.15]">
          사업자번호만 넣으면,
          <br />
          <span className="bg-[image:var(--grad-text-brand)] bg-clip-text text-transparent">
            받을 수 있는 지원사업
          </span>
          이 보여요
        </h1>

        <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
          복잡한 공고를 뒤질 필요 없어요. 사업자번호 하나로 우리 회사에 맞는 지원사업을 찾아 매칭하고, 신청 준비까지
          도와드려요.
        </p>

        <div className="mt-9 w-full">
          <BizLookupForm inputId="hero-biz" attachRef />
        </div>

        {user ? (
          <Link href="/dashboard" className="mt-4 text-sm font-medium text-primary hover:underline">
            이미 시작하셨나요? 기회 맵으로 이동 →
          </Link>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Check className="size-4 text-success" /> 회원가입 없이 바로 조회
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-4" /> 입력 정보는 안전하게 암호화
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-4 text-success" /> 30초면 끝
          </span>
        </div>
      </div>
    </section>
  );
}
