"use client";

import { useState } from "react";
import { FileSearch, RotateCcw, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import type { DocumentAgentUiState } from "./documentAgentState";
import { DocumentAgentDiff } from "./DocumentAgentDiff";

export function DocumentAgentSheet(props: {
  state: DocumentAgentUiState;
  pageCount: number;
  onOpenChange(open: boolean): void;
  onSelectPage(page: number): void;
  onScan(): void;
  onSelectCandidate(candidateId: string): void;
  onRequest(): void;
  onApply(suggestionId: string): void;
  onDismiss(suggestionId: string): void;
  onUndo(suggestionId: string): void;
  onRetry(): void;
  canUndoSuggestion(suggestionId: string): boolean;
}) {
  const [undoSuggestionId, setUndoSuggestionId] = useState<string | null>(null);
  const busy = ["scanning", "checkpointing", "generating", "applying", "undoing"].includes(props.state.phase);
  const run = props.state.run;
  const selectedCandidate = props.state.candidates.find(
    (candidate) => candidate.candidateId === props.state.selectedCandidateId,
  ) ?? null;
  const undoSuggestion = run?.suggestions.find((suggestion) => suggestion.id === undoSuggestionId) ?? null;

  return (
    <>
      <Sheet
        open={props.state.phase !== "closed"}
        onOpenChange={(open) => {
          if (!busy) props.onOpenChange(open);
        }}
      >
        <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-4 text-left">
            <SheetTitle>AI 작성 제안</SheetTitle>
            <SheetDescription>
              쪽과 작성 위치를 직접 고른 뒤에만 제안을 만듭니다. 승인 전에는 문서를 변경하지 않습니다.
            </SheetDescription>
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="grid gap-4 p-5" aria-live="polite">
              <div className="grid gap-2">
                <span className="text-sm font-medium">대상 쪽</span>
                <div className="flex gap-2">
                  <Select
                    value={String(props.state.selectedPage)}
                    onValueChange={(value) => props.onSelectPage(Number(value))}
                    disabled={busy}
                  >
                    <SelectTrigger aria-label="AI 제안 대상 쪽" className="flex-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: props.pageCount }, (_, index) => index + 1).map((page) => (
                        <SelectItem key={page} value={String(page)}>{page}쪽</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="outline" onClick={props.onScan} disabled={busy}>
                    {props.state.phase === "scanning" ? <Spinner data-icon="inline-start" /> : <FileSearch data-icon="inline-start" />}
                    이 쪽의 작성 위치 찾기
                  </Button>
                </div>
              </div>

              {props.state.candidates.length > 0 ? (
                <div className="grid gap-2">
                  <span className="text-sm font-medium">작성 위치</span>
                  {props.state.candidates.map((candidate) => (
                    <button
                      key={candidate.candidateId}
                      type="button"
                      className="rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
                      data-selected={candidate.candidateId === props.state.selectedCandidateId}
                      aria-pressed={candidate.candidateId === props.state.selectedCandidateId}
                      onClick={() => props.onSelectCandidate(candidate.candidateId)}
                      disabled={busy}
                    >
                      <span className="block text-sm font-medium">{candidate.location.page}쪽 · {candidate.location.label}</span>
                      <span className="mt-1 line-clamp-3 block text-xs text-muted-foreground">{candidate.beforeText}</span>
                    </button>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    제안이 실패하거나 비어 있어도 현재 문서를 저장한 checkpoint 이력은 남습니다.
                  </p>
                  <Button type="button" onClick={props.onRequest} disabled={!selectedCandidate || busy}>
                    {props.state.phase === "checkpointing" || props.state.phase === "generating"
                      ? <Spinner data-icon="inline-start" />
                      : <Sparkles data-icon="inline-start" />}
                    현재 문서를 저장하고 제안 받기
                  </Button>
                </div>
              ) : null}

              {props.state.error ? (
                <Alert variant="destructive">
                  <AlertTitle>제안을 처리하지 못했습니다</AlertTitle>
                  <AlertDescription>{props.state.error}</AlertDescription>
                  <div className="mt-3">
                    <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
                      다시 시도
                    </Button>
                  </div>
                </Alert>
              ) : null}

              {run ? (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">작성 대안</span>
                    <Badge variant="outline">{run.status}</Badge>
                  </div>
                  {run.status === "empty" ? (
                    <Alert><AlertTitle>안전한 대안이 없습니다</AlertTitle><AlertDescription>근거가 충분한 문안만 표시합니다.</AlertDescription></Alert>
                  ) : null}
                  {run.suggestions.map((suggestion) => (
                    <Card key={suggestion.id}>
                      <CardHeader>
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <CardTitle className="text-base">
                              {String(suggestion.location.page ?? props.state.selectedPage)}쪽 · {String(suggestion.location.label ?? "선택한 본문")}
                            </CardTitle>
                            <CardDescription>{suggestion.rationale}</CardDescription>
                          </div>
                          <Badge variant="secondary">{suggestion.status}</Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="grid gap-3">
                        <DocumentAgentDiff before={suggestion.beforeText} after={suggestion.afterText} />
                        <div className="grid gap-2">
                          {suggestion.evidence.map((evidence, index) => (
                            <div key={`${suggestion.id}:evidence:${index}`} className="rounded-lg bg-muted/60 p-3 text-xs">
                              <Badge variant="outline">{String(evidence.sourceTitle ?? evidence.sourceKind ?? "근거")}</Badge>
                              <blockquote className="mt-2 whitespace-pre-wrap">“{String(evidence.quote ?? "")}”</blockquote>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                      <CardFooter className="justify-end gap-2">
                        {suggestion.status === "pending" ? (
                          <>
                            <Button type="button" variant="ghost" onClick={() => props.onDismiss(suggestion.id)} disabled={busy}>건너뛰기</Button>
                            <Button type="button" onClick={() => props.onApply(suggestion.id)} disabled={busy}>이 제안 반영</Button>
                          </>
                        ) : null}
                        {suggestion.status === "applied" && props.canUndoSuggestion(suggestion.id) ? (
                          <Button type="button" variant="outline" onClick={() => setUndoSuggestionId(suggestion.id)} disabled={busy}>
                            <RotateCcw data-icon="inline-start" />최근 AI 변경 되돌리기
                          </Button>
                        ) : null}
                      </CardFooter>
                    </Card>
                  ))}
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <AlertDialog open={undoSuggestion !== null} onOpenChange={(open) => !open && setUndoSuggestionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>최근 AI 변경을 되돌릴까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {undoSuggestion ? `${String(undoSuggestion.location.page ?? "현재")}쪽의 “${undoSuggestion.beforeText.slice(0, 120)}” 상태로 새 revision을 만듭니다.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (undoSuggestion) props.onUndo(undoSuggestion.id);
              setUndoSuggestionId(null);
            }}>되돌리기</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
