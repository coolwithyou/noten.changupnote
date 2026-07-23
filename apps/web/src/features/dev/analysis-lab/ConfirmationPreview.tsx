"use client";

import type { LabCriterionConfirmation } from "./contract";
import { Badge } from "@/components/ui/badge";

// ─────────────────────────────────────────────────────────────────────────────
// 자가신고 확인 질문(v3) 읽기 전용 표시 — 검수(ReviewSheet)·감사(AuditSheet) 공용.
// 딥분석이 판정 불가 결격에 사전 생성한 객관식 질문을 검수·감사 화면에서 함께 보게 한다
// (질문도 감사 범위 — 근거 문서 §4.5). 입력 컨트롤 없음: 답변 수집은 프로덕션 착지(B) 몫.
// ─────────────────────────────────────────────────────────────────────────────

export function ConfirmationPreview({
  confirmation,
}: {
  confirmation: LabCriterionConfirmation;
}) {
  const companyFact = confirmation.reusable === "company_fact";
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border bg-muted/20 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">확인 질문</span>
        <Badge variant={companyFact ? "secondary" : "outline"}>
          {companyFact ? "기업 사실" : "공고 한정"}
        </Badge>
        {confirmation.answerType === "multi" ? <Badge variant="outline">복수 선택</Badge> : null}
        {companyFact && confirmation.conditionKey ? (
          <span className="font-mono text-[11px] text-muted-foreground break-all">
            {confirmation.conditionKey}
          </span>
        ) : null}
      </div>
      <p className="text-xs break-words">{confirmation.prompt}</p>
      <div className="flex min-w-0 flex-col gap-0.5">
        {confirmation.options.map((option) => (
          <div
            key={option.value}
            className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <span className="min-w-0 break-words">{option.label}</span>
            <span className="font-mono text-[10px]">{option.value}</span>
            {option.disqualifies ? <Badge variant="destructive">결격</Badge> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
