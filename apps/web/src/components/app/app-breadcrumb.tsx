"use client";

import { usePathname } from "next/navigation";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";

/** 셸 상단바의 현재 위치 표시. 단일 세그먼트 라벨(계층 확장은 후속 Phase). */
const EXACT_LABELS: Record<string, string> = {
  "/dashboard": "기회 맵",
  "/applications": "신청 관리",
  "/roadmap": "로드맵",
  "/team": "팀",
  "/billing": "플랜",
  "/credits": "크레딧",
  "/credits/complete": "결제 완료",
  "/settings": "설정",
  "/account": "내 계정",
  "/account/usage": "사용량",
  "/onboarding": "온보딩",
};

const PREFIX_LABELS: Array<{ prefix: string; label: string }> = [
  { prefix: "/grants", label: "지원사업" },
];

function resolveLabel(pathname: string): string {
  if (EXACT_LABELS[pathname]) return EXACT_LABELS[pathname];
  for (const { prefix, label } of PREFIX_LABELS) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return label;
  }
  return "창업노트";
}

export function AppBreadcrumb() {
  const pathname = usePathname();
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbPage>{resolveLabel(pathname)}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
