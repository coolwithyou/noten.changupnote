"use client";

import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MatchFeedbackControls } from "@/features/opportunity-map/MatchFeedbackControls";

/**
 * 카드 우상단 ⋯ 메뉴("이 공고 정리": 저장·제외·오류·신청함). 디자인 01에는 없지만 목록에서 공고를 정리하는
 * 기존 피드백 경로(explicit_relevant/irrelevant)를 잃지 않기 위해 로그인 회사 결과에만 붙인다.
 */
export function GrantCardMenu({ grantId, title }: { grantId: string; title: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`${title} 메뉴`} />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64 p-3">
        <DropdownMenuLabel>이 공고 정리</DropdownMenuLabel>
        <MatchFeedbackControls grantId={grantId} title={title} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
