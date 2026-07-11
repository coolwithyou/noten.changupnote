import type { ReactNode } from "react";
import { PublicHeader } from "@/components/app/public-header";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * 마케팅(퍼블릭) 페이지 공용 레이아웃 — 상단 PublicHeader(세션 인지).
 * 랜딩(/)·매칭(/matches)도 이 그룹 안에서 PublicHeader를 공유한다(자체 nav 없음).
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
