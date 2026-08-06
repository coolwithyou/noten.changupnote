"use client";

import { AlertTriangle, ChevronDown } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export function AnalysisLabErrorAlert({ title, message }: { title: string; message: string }) {
  const databaseError = message.includes("Failed query:") || message.includes("PostgresError");

  return (
    <Alert variant="destructive">
      <AlertTriangle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {databaseError
          ? "로컬 데이터베이스 연결 또는 스키마 상태를 확인한 뒤 다시 시도해 주세요."
          : message}
      </AlertDescription>
      {databaseError ? (
        <Collapsible className="col-start-2 mt-2">
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="w-full justify-between" />}>
            기술 오류 상세
            <ChevronDown data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs text-foreground">
              {message}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </Alert>
  );
}
