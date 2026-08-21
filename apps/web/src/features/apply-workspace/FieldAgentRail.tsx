"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CheckCircle2, Circle, CircleDot, List, MapPinCheck, MessageSquare, RotateCcw, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Input } from "@/components/ui/input";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import type { FieldAgentRunDto, FieldAgentSuggestionDto } from "@/lib/server/documents/fieldAgentRuns";
import type { FieldAwareDocumentSessionView, FieldAwareSessionItem } from "./fieldAwareDocumentSession";

export function FieldAgentRail({
  session,
  connectedFields,
  run,
  onSelectField,
  onRequestSuggestion,
  onStartConversation,
  onApplySuggestion,
  onUndoSuggestion,
  onDismissSuggestion,
}: {
  session: FieldAwareDocumentSessionView;
  connectedFields: readonly ConnectedDocumentField[];
  run: FieldAgentRunDto | null;
  onSelectField: (fieldId: string) => void;
  onRequestSuggestion: (field: ConnectedDocumentField, sourceText: string) => void;
  onStartConversation: (field: ConnectedDocumentField) => void;
  onApplySuggestion: (run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto) => void;
  onUndoSuggestion: (run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto) => void;
  onDismissSuggestion: (run: FieldAgentRunDto, suggestion: FieldAgentSuggestionDto) => void;
}) {
  const [sourceText, setSourceText] = useState("");
  const [fieldQuery, setFieldQuery] = useState("");
  const [fieldFilter, setFieldFilter] = useState<"all" | "incomplete" | "attention">("all");
  const [activeSection, setActiveSection] = useState<"assist" | "index">("assist");
  const selectedSource = session.selected
    ? connectedFields.find((field) => field.fieldId === session.selected?.fieldId) ?? null
    : null;
  const suggestions = run?.suggestions
    .filter((suggestion) => suggestion.status !== "dismissed" && suggestion.status !== "stale")
    .slice(0, 2) ?? [];
  const visibleFields = useMemo(() => {
    const query = fieldQuery.trim().toLocaleLowerCase("ko-KR");
    return session.fields.filter((field) => {
      if (query && !`${field.label} ${field.section ?? ""}`.toLocaleLowerCase("ko-KR").includes(query)) {
        return false;
      }
      if (fieldFilter === "incomplete") return field.state !== "filled";
      if (fieldFilter === "attention") {
        return field.bindingStatus === "missing" || field.bindingStatus === "ambiguous";
      }
      return true;
    });
  }, [fieldFilter, fieldQuery, session.fields]);
  const nextActionable = nextActionableField(session.fields, session.selected?.fieldId ?? null);

  useEffect(() => {
    setSourceText("");
    setActiveSection("assist");
  }, [session.selected?.fieldId]);

  const selectIndexedField = (fieldId: string) => {
    onSelectField(fieldId);
    setActiveSection("assist");
  };

  return (
    <aside className="flex h-full min-h-0 max-h-full flex-col overflow-hidden" aria-label="AI 필드 도우미">
      <Card className="h-full min-h-0 max-h-full overflow-hidden">
        <CardHeader className="shrink-0 border-b">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>AI 필드 도우미</CardTitle>
            <Badge variant="outline">
              <MapPinCheck aria-hidden />
              {session.boundCount}/{session.totalCount} 위치 확인
            </Badge>
          </div>
          <CardDescription>
            문서의 실제 입력 칸을 기준으로 값을 확인하고 제안합니다.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Tabs
            value={activeSection}
            onValueChange={(value) => setActiveSection(value as "assist" | "index")}
            className="min-h-0 flex-1 overflow-hidden"
          >
            <TabsList className="grid w-full shrink-0 grid-cols-2" aria-label="AI 필드 도우미 메뉴">
              <TabsTrigger value="assist">
                <Sparkles data-icon="inline-start" aria-hidden />
                작성 도우미
              </TabsTrigger>
              <TabsTrigger value="index">
                <List data-icon="inline-start" aria-hidden />
                필드 목록
              </TabsTrigger>
            </TabsList>

            <TabsContent value="assist" className="min-h-0 overflow-hidden">
              {session.selected ? (
                <ScrollArea className="h-full min-h-0 overscroll-contain">
                <div className="flex flex-col gap-3 pr-3 pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{session.selected.label}</h2>
                  {session.selected.required ? <Badge variant="secondary">필수</Badge> : null}
                  <BindingBadge status={session.selected.bindingStatus} />
                </div>
                {session.selected.value ? (
                  <div className="rounded-lg bg-muted p-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {session.selected.state === "reviewing" ? "AI 제안" : "현재 확인값"}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{session.selected.value}</p>
                    {session.selected.basis ? (
                      <p className="mt-2 text-xs text-muted-foreground">근거: {session.selected.basis}</p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">아직 확인된 값이나 제안이 없습니다.</p>
                )}
                <p className="text-xs leading-5 text-muted-foreground">
                  {assistDescription(session.selected.assistAvailability)}
                </p>
                {session.selected.assistAvailability === "ready" ? (
                  <Textarea
                    value={sourceText}
                    onChange={(event) => setSourceText(event.target.value)}
                    maxLength={4_000}
                    rows={3}
                    placeholder="선택 사항: 이 칸에 반영할 사실이나 강조점을 적어 주세요. 비워 두면 회사 정보와 공고 근거만 사용합니다."
                    aria-label={`${session.selected.label} 제안에 추가할 사실`}
                  />
                ) : null}
                {run?.status === "failed" ? (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    제안 생성에 실패했습니다. 현재 문서를 저장한 뒤 다시 시도해 주세요.
                  </p>
                ) : null}
                {run?.status === "empty" ? (
                  <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                    확인 가능한 근거로 안전한 값을 만들지 못했습니다. 필요한 사실을 적고 다시 요청할 수 있습니다.
                  </p>
                ) : null}
                {suggestions.map((suggestion, index) => (
                  <div key={suggestion.id} className="rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-semibold text-primary">
                        {suggestions.length > 1 ? `문서 입력 대안 ${index + 1}` : "문서 입력 제안"}
                      </p>
                      <Badge variant={suggestion.status === "applied" ? "default" : "outline"}>
                        {suggestion.status === "applied" ? "문서 반영됨" : suggestion.status === "undone" ? "되돌림" : "검토 필요"}
                      </Badge>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm font-medium leading-6">{suggestion.value}</p>
                    <p className="mt-2 text-xs leading-5 text-muted-foreground">근거: {suggestion.rationale}</p>
                    {suggestion.operationState === "idle" && suggestion.status === "pending" ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button type="button" size="sm" onClick={() => onApplySuggestion(run!, suggestion)}>
                          <CheckCircle2 data-icon="inline-start" aria-hidden />
                          이 값으로 채우기
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => onDismissSuggestion(run!, suggestion)}>
                          <X data-icon="inline-start" aria-hidden />
                          이 대안 제외
                        </Button>
                      </div>
                    ) : suggestion.operationState === "idle" && suggestion.status === "applied" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-3"
                        onClick={() => onUndoSuggestion(run!, suggestion)}
                      >
                        <RotateCcw data-icon="inline-start" aria-hidden />
                        최근 입력 되돌리기
                      </Button>
                    ) : null}
                  </div>
                ))}
                {session.selected.canRequestSuggestion && selectedSource ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={suggestions.some((suggestion) => suggestion.status === "pending") ? "outline" : "default"}
                      onClick={() => onRequestSuggestion(selectedSource, sourceText)}
                    >
                      <Sparkles data-icon="inline-start" aria-hidden />
                      {suggestions.length > 0 ? "새 제안받기" : "제안받기"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onStartConversation(selectedSource)}
                    >
                      <MessageSquare data-icon="inline-start" aria-hidden />
                      대화로 작성
                    </Button>
                  </div>
                ) : session.selected.isSuggesting ? (
                  <Button type="button" size="sm" disabled>
                    <Spinner data-icon="inline-start" />
                    필드 제안 생성 중…
                  </Button>
                ) : null}
                </div>
                </ScrollArea>
              ) : (
                <p className="py-6 text-center text-sm text-muted-foreground">작성할 필드를 선택해 주세요.</p>
              )}
            </TabsContent>

            <TabsContent value="index" className="min-h-0 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col gap-3">
                <div className="flex shrink-0 flex-col gap-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      value={fieldQuery}
                      onChange={(event) => setFieldQuery(event.target.value)}
                      className="pl-9"
                      placeholder="필드 검색"
                      aria-label="필드 검색"
                    />
                  </div>
                  <ToggleGroup
                    value={[fieldFilter]}
                    onValueChange={(value) => {
                      const nextFilter = value[0];
                      if (nextFilter) setFieldFilter(nextFilter as typeof fieldFilter);
                    }}
                    size="sm"
                    aria-label="필드 상태 필터"
                  >
                    {([
                      ["all", "전체"],
                      ["incomplete", "미완료"],
                      ["attention", "확인 필요"],
                    ] as const).map(([value, label]) => (
                      <ToggleGroupItem
                        key={value}
                        value={value}
                        aria-label={label}
                      >
                        {label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
                <ScrollArea className="min-h-0 flex-1 overscroll-contain">
                  <div className="flex flex-col gap-1 pr-3">
                    {visibleFields.length > 0 ? visibleFields.map((field) => (
                      <Button
                        key={field.fieldId}
                        type="button"
                        data-field-item
                        variant={field.isSelected ? "secondary" : "ghost"}
                        className="h-auto min-w-0 justify-start gap-2 px-3 py-2.5 text-left"
                        onClick={() => selectIndexedField(field.fieldId)}
                        onKeyDown={handleFieldListKeyDown}
                        aria-pressed={field.isSelected}
                      >
                        <FieldStateIcon field={field} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">{field.label}</span>
                          <span className="block truncate text-xs font-normal text-muted-foreground">
                            {field.section ?? "신청서"} · {bindingLabel(field.bindingStatus)}
                          </span>
                        </span>
                      </Button>
                    )) : (
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        {session.fields.length > 0 ? "조건에 맞는 필드가 없습니다." : "연결된 작성 항목이 없습니다."}
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>

        <CardFooter className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>현재 선택한 문서 입력 칸에만 값을 적용합니다.</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!nextActionable}
            onClick={() => nextActionable && onSelectField(nextActionable.fieldId)}
          >
            다음 미완료
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Button>
        </CardFooter>
      </Card>
    </aside>
  );
}

function nextActionableField(
  fields: readonly FieldAwareSessionItem[],
  selectedFieldId: string | null,
): FieldAwareSessionItem | null {
  if (fields.length === 0) return null;
  const selectedIndex = fields.findIndex((field) => field.fieldId === selectedFieldId);
  const ordered = selectedIndex >= 0
    ? fields.slice(selectedIndex + 1).concat(fields.slice(0, selectedIndex + 1))
    : [...fields];
  return ordered.find((field) => field.state !== "filled" && field.bindingStatus === "unique") ?? null;
}

function handleFieldListKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
    "button[data-field-item]",
  ) ?? [])];
  if (items.length === 0) return;
  const current = items.indexOf(event.currentTarget);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
  event.preventDefault();
  items[nextIndex]?.focus();
}

function FieldStateIcon({ field }: { field: FieldAwareSessionItem }) {
  if (field.bindingStatus === "missing" || field.bindingStatus === "ambiguous") {
    return <TriangleAlert className="shrink-0 text-destructive" aria-hidden />;
  }
  if (field.state === "filled") return <CheckCircle2 className="shrink-0 text-primary" aria-hidden />;
  if (field.state === "reviewing") return <CircleDot className="shrink-0 text-primary" aria-hidden />;
  return <Circle className="shrink-0 text-muted-foreground" aria-hidden />;
}

function BindingBadge({ status }: { status: FieldAwareSessionItem["bindingStatus"] }) {
  if (status === "unique") return <Badge variant="secondary">위치 확인됨</Badge>;
  if (status === "resolving") return <Badge variant="outline">위치 확인 중</Badge>;
  return <Badge variant="destructive">{status === "ambiguous" ? "위치 여러 곳" : "위치 미확인"}</Badge>;
}

function bindingLabel(status: FieldAwareSessionItem["bindingStatus"]): string {
  if (status === "unique") return "위치 확인됨";
  if (status === "ambiguous") return "후보 여러 곳";
  if (status === "missing") return "위치 미확인";
  return "위치 확인 중";
}

function assistDescription(status: FieldAwareSessionItem["assistAvailability"]): string {
  switch (status) {
    case "ready":
      return "현재 선택한 입력 칸을 확인했어요. AI 제안을 요청할 수 있으며, 선택형은 원래 보기 중 하나만 제안합니다.";
    case "rollout_off":
      return "AI 필드 제안은 현재 내부 rollout 범위에서만 사용할 수 있습니다. 문서 직접 편집은 계속 가능합니다.";
    case "binding_resolving":
      return "현재 문서에서 정확한 입력 칸을 확인하고 있습니다.";
    case "binding_missing":
      return "현재 문서에서 한 개의 입력 칸을 확정하지 못해 자동 제안을 열지 않았습니다.";
    case "binding_ambiguous":
      return "같은 항목 후보가 여러 곳이라 임의로 고르지 않았습니다. 문서에서 직접 작성해 주세요.";
    case "unsupported_kind":
      return "반복 표·서명·첨부 항목은 현재 단계에서 직접 편집 대상으로 유지합니다.";
    case "not_suggestable":
      return "이 값은 회사 정보 등 결정 가능한 출처를 먼저 확인합니다. 문서에서 직접 수정할 수 있습니다.";
  }
}
