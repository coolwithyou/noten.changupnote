"use client";

import { useState } from "react";
import { Download, FileSearch, RotateCcw, Save, Sparkles } from "lucide-react";
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
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import type { DocumentAgentUiState } from "./documentAgentState";
import { DocumentAgentDiff } from "./DocumentAgentDiff";
import type { RhwpStudioDocumentActionState } from "./RhwpStudioSurface";
import { StudioSaveIndicator } from "./StudioSaveIndicator";

interface DocumentAgentActions {
  state: DocumentAgentUiState;
  pageCount: number;
  onSelectPage(page: number): void;
  onScan(): void;
  onSelectCandidate(candidateId: string): void;
  onRequest(): void;
  onApply(suggestionId: string): void;
  onDismiss(suggestionId: string): void;
  onUndo(suggestionId: string): void;
  onRetry(): void;
  canUndoSuggestion(suggestionId: string): boolean;
}

export interface DocumentAgentPanelProps extends DocumentAgentActions {
  available: boolean;
  unavailableMessage?: string;
  documentActions?: RhwpStudioDocumentActionState & {
    onSave(): void;
    onDownload(): void;
    saveLabel?: string;
  };
}

/** RHWP 옆에 상시 노출되는 문단·셀 기반 작성 가이드. 모델 호출은 available일 때만 열린다. */
export function DocumentAgentPanel(props: DocumentAgentPanelProps) {
  const [undoSuggestionId, setUndoSuggestionId] = useState<string | null>(null);
  const busy = documentAgentBusy(props.state);
  const run = props.state.run;
  const selectedCandidate = props.state.candidates.find(
    (candidate) => candidate.candidateId === props.state.selectedCandidateId,
  ) ?? null;
  const undoSuggestion = run?.suggestions.find((suggestion) => suggestion.id === undoSuggestionId) ?? null;

  return (
    <>
      <aside className="flex h-full min-h-0 max-h-full flex-col overflow-hidden" aria-label="AI 작성 가이드">
        <Card variant="workspace" className="h-full min-h-0 max-h-full overflow-hidden">
          <CardHeader className="shrink-0 border-b">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>AI 작성 가이드</CardTitle>
              <Badge variant="outline">
                <Sparkles aria-hidden />
                승인 후 반영
              </Badge>
            </div>
            <CardDescription>
              공고 근거와 현재 문서 문맥으로 문안을 제안합니다. 승인 전에는 문서를 변경하지 않습니다.
            </CardDescription>
            {props.documentActions ? (
              <div className="flex flex-col gap-2 pt-1">
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={props.documentActions.onSave}
                    disabled={!props.documentActions.canSave}
                  >
                    {props.documentActions.saving
                      ? <Spinner data-icon="inline-start" />
                      : <Save data-icon="inline-start" aria-hidden />}
                    {props.documentActions.saving
                      ? "저장 중…"
                      : props.documentActions.saveLabel ?? "지금 저장"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={props.documentActions.onDownload}
                    disabled={!props.documentActions.canDownload}
                  >
                    {props.documentActions.downloading
                      ? <Spinner data-icon="inline-start" />
                      : <Download data-icon="inline-start" aria-hidden />}
                    {props.documentActions.downloading ? "내보내는 중…" : "편집본 다운로드"}
                  </Button>
                </div>
                <StudioSaveIndicator state={props.documentActions.saveState} />
              </div>
            ) : null}
          </CardHeader>

          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <ScrollArea className="h-full min-h-0 overscroll-contain">
              <div className="flex flex-col gap-4 pr-3 pb-2" aria-live="polite">
                {!props.available ? (
                  <Alert>
                    <AlertTitle>작성 가이드 미리보기</AlertTitle>
                    <AlertDescription>
                      {props.unavailableMessage ?? "현재 문서에서는 AI 작성 제안을 사용할 수 없습니다."}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <div className="flex flex-col gap-2">
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
                            <SelectGroup>
                              {Array.from({ length: props.pageCount }, (_, index) => index + 1).map((page) => (
                                <SelectItem key={page} value={String(page)}>{page}쪽</SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        <Button type="button" variant="outline" onClick={props.onScan} disabled={busy}>
                          {props.state.phase === "scanning"
                            ? <Spinner data-icon="inline-start" />
                            : <FileSearch data-icon="inline-start" />}
                          작성 위치 찾기
                        </Button>
                      </div>
                    </div>

                    {props.state.candidates.length > 0 ? (
                      <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">작성 위치</span>
                        {props.state.candidates.map((candidate) => (
                          <Button
                            key={candidate.candidateId}
                            type="button"
                            variant="outline"
                            className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                            data-selected={candidate.candidateId === props.state.selectedCandidateId}
                            aria-pressed={candidate.candidateId === props.state.selectedCandidateId}
                            onClick={() => props.onSelectCandidate(candidate.candidateId)}
                            disabled={busy}
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">
                                {candidate.location.page}쪽 · {candidate.location.label}
                              </span>
                              <span className="mt-1 line-clamp-3 block text-xs font-normal text-muted-foreground">
                                {candidate.beforeText}
                              </span>
                            </span>
                          </Button>
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
                    ) : props.state.phase === "idle" ? (
                      <p className="text-sm leading-6 text-muted-foreground">
                        먼저 작성할 쪽을 고르고 안전하게 바꿀 수 있는 문단이나 셀을 찾으세요.
                      </p>
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
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">작성 대안</span>
                          <Badge variant="outline">{run.status}</Badge>
                        </div>
                        {run.status === "empty" ? (
                          <Alert>
                            <AlertTitle>안전한 대안이 없습니다</AlertTitle>
                            <AlertDescription>근거가 충분한 문안만 표시합니다.</AlertDescription>
                          </Alert>
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
                            <CardContent className="flex flex-col gap-3">
                              <DocumentAgentDiff before={suggestion.beforeText} after={suggestion.afterText} />
                              <div className="flex flex-col gap-2">
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
                                  <Button type="button" variant="ghost" onClick={() => props.onDismiss(suggestion.id)} disabled={busy}>
                                    건너뛰기
                                  </Button>
                                  <Button type="button" onClick={() => props.onApply(suggestion.id)} disabled={busy}>
                                    이 제안 반영
                                  </Button>
                                </>
                              ) : null}
                              {suggestion.status === "applied" && props.canUndoSuggestion(suggestion.id) ? (
                                <Button type="button" variant="outline" onClick={() => setUndoSuggestionId(suggestion.id)} disabled={busy}>
                                  <RotateCcw data-icon="inline-start" />
                                  최근 AI 변경 되돌리기
                                </Button>
                              ) : null}
                            </CardFooter>
                          </Card>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </ScrollArea>
          </CardContent>

          <CardFooter className="shrink-0 text-xs text-muted-foreground">
            공고 작성 가이드는 방향을 위한 조언이며 회사 사실은 확인된 정보만 사용합니다.
          </CardFooter>
        </Card>
      </aside>

      <AlertDialog open={undoSuggestion !== null} onOpenChange={(open) => !open && setUndoSuggestionId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>최근 AI 변경을 되돌릴까요?</AlertDialogTitle>
            <AlertDialogDescription>
              {undoSuggestion
                ? `${String(undoSuggestion.location.page ?? "현재")}쪽의 “${undoSuggestion.beforeText.slice(0, 120)}” 상태로 새 revision을 만듭니다.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (undoSuggestion) props.onUndo(undoSuggestion.id);
              setUndoSuggestionId(null);
            }}>
              되돌리기
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function DocumentAgentSheet(props: DocumentAgentActions & {
  open: boolean;
  onOpenChange(open: boolean): void;
  available?: boolean;
  unavailableMessage?: string;
  documentActions?: DocumentAgentPanelProps["documentActions"];
}) {
  const busy = documentAgentBusy(props.state);
  const {
    open,
    onOpenChange,
    available = true,
    unavailableMessage,
    documentActions,
    ...actions
  } = props;

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 p-3 sm:max-w-xl">
        <SheetHeader className="sr-only">
          <SheetTitle>AI 작성 가이드</SheetTitle>
          <SheetDescription>
            공고 근거와 현재 문서 문맥으로 문안을 제안하고 승인한 변경만 반영합니다.
          </SheetDescription>
        </SheetHeader>
        <DocumentAgentPanel
          {...actions}
          available={available}
          {...(unavailableMessage !== undefined ? { unavailableMessage } : {})}
          {...(documentActions !== undefined ? { documentActions } : {})}
        />
      </SheetContent>
    </Sheet>
  );
}

function documentAgentBusy(state: DocumentAgentUiState): boolean {
  return ["scanning", "checkpointing", "generating", "applying", "undoing"].includes(state.phase);
}
