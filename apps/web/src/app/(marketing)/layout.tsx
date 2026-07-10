import type { ReactNode } from "react";
import { PublicHeader } from "@/components/app/public-header";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * 마케팅(퍼블릭) 페이지 공용 레이아웃 — 상단 PublicHeader(세션 인지).
 * 자체 nav를 렌더하는 랜딩(/)·매칭(/matches)은 그룹 밖에 두어 헤더 중복을 피한다.
 */
export default async function MarketingLayout({ children }: { children: ReactNode }) {
  const user = await getOptionalHeaderUser();
  return (
    <>
      <PublicHeader user={user} />
      {children}
    </>
  );
}
