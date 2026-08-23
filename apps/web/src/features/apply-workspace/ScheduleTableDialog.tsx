"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarRange, CheckCircle2, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { ScheduleTableInspection, ScheduleTableTarget } from "@/lib/rhwp/scheduleTable";
import { requestScheduleSuggestion } from "@/lib/rhwp/scheduleTableApi";
import type { SchedulePhase, ScheduleTablePlan } from "@/lib/rhwp/scheduleTableContract";

export interface ScheduleTableDialogProps {
  draftId: string;
  disabled?: boolean;
  inspectTable: () => Promise<ScheduleTableInspection>;
  applyPlan: (target: ScheduleTableTarget, plan: ScheduleTablePlan) => Promise<{ afterDocumentSha256: string }>;
  undoLatest: () => Promise<void>;
  canUndoLatest: () => boolean;
}

export function ScheduleTableDialog({
  draftId,
  disabled = false,
  inspectTable,
  applyPlan,
  undoLatest,
  canUndoLatest,
}: ScheduleTableDialogProps) {
  const [open, setOpen] = useState(false);
  const [inspection, setInspection] = useState<ScheduleTableInspection | null>(null);
  const [constraints, setConstraints] = useState("");
  const [plan, setPlan] = useState<ScheduleTablePlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [applied, setApplied] = useState(false);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setLoading(true);
    setError(null);
    setPlan(null);
    setApplied(false);
    setUndoAvailable(canUndoLatest());
    void inspectTable().then((result) => {
      if (!disposed) setInspection(result);
    }).catch((caught) => {
      if (!disposed) setError(errorMessage(caught, "현재 문서의 일정표를 확인하지 못했습니다."));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [canUndoLatest, inspectTable, open]);

  const target = inspection?.status === "unique" ? inspection.target : null;
  const months = target?.months ?? [];
  const planError = useMemo(() => validateEditablePlan(plan, target), [plan, target]);

  const generate = async () => {
    if (!target || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const response = await requestScheduleSuggestion(draftId, {
        months: target.months,
        maxPhases: target.rows.length,
        currentRows: target.rows.map((row) => row.title),
        ...(constraints.trim() ? { userConstraints: constraints.trim() } : {}),
      });
      setPlan(response.plan);
      setApplied(false);
    } catch (caught) {
      setError(errorMessage(caught, "일정안을 만들지 못했습니다."));
    } finally {
      setGenerating(false);
    }
  };

  const apply = async () => {
    if (!target || !plan || planError || applying) return;
    setApplying(true);
    setError(null);
    try {
      await applyPlan(target, plan);
      setApplied(true);
      setUndoAvailable(true);
      toast.success("승인한 일정안을 현재 문서 표에 반영하고 저장했습니다.");
    } catch (caught) {
      setError(errorMessage(caught, "일정안을 문서에 반영하지 못했습니다."));
    } finally {
      setApplying(false);
    }
  };

  const undo = async () => {
    if (!undoAvailable || undoing) return;
    setUndoing(true);
    setError(null);
    try {
      await undoLatest();
      setUndoAvailable(false);
      setApplied(false);
      setPlan(null);
      const result = await inspectTable();
      setInspection(result);
      toast.success("최근 일정표 자동 입력을 되돌렸습니다.");
    } catch (caught) {
      setError(errorMessage(caught, "최근 일정표 입력을 되돌리지 못했습니다."));
    } finally {
      setUndoing(false);
    }
  };

  const updatePhase = (index: number, patch: Partial<SchedulePhase>) => {
    setPlan((current) => current ? {
      ...current,
      phases: current.phases.map((phase, phaseIndex) => phaseIndex === index ? { ...phase, ...patch } : phase),
    } : current);
    setApplied(false);
  };

  const busy = loading || generating || applying || undoing;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="w-full"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <CalendarRange data-icon="inline-start" aria-hidden />
        일정표 자동 구성
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent className="flex max-h-[min(92dvh,920px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
          <DialogHeader className="shrink-0 border-b px-6 py-5">
            <DialogTitle>사업추진 일정 자동 구성</DialogTitle>
            <DialogDescription>
              공고와 확인된 작성 내용을 바탕으로 일정을 제안합니다. 미리보기에서 직접 고친 뒤 승인해야 문서가 바뀝니다.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {loading ? (
              <div className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner /> 현재 문서에서 월별 일정표를 확인하고 있어요.
              </div>
            ) : target ? (
              <div className="flex flex-col gap-5">
                <Alert>
                  <CheckCircle2 aria-hidden />
                  <AlertTitle>문서 {target.page ? `${target.page}쪽의 ` : "안의 "}일정표를 하나로 확인했습니다</AlertTitle>
                  <AlertDescription>
                    {target.months[0]}월~{target.months.at(-1)}월, 본문 {target.rows.length}행입니다. 현재 문서와 표 구조가 바뀌면 반영을 자동으로 차단합니다.
                  </AlertDescription>
                </Alert>

                <div className="flex flex-col gap-2">
                  <label htmlFor="schedule-constraints" className="text-sm font-medium">추가 일정 조건 <span className="font-normal text-muted-foreground">(선택)</span></label>
                  <Textarea
                    id="schedule-constraints"
                    value={constraints}
                    onChange={(event) => setConstraints(event.target.value)}
                    maxLength={2_000}
                    rows={3}
                    placeholder="예: 7월 말 시제품 완료, 9월 테스트 마켓 시작"
                    disabled={busy || applied}
                  />
                  <p className="text-xs text-muted-foreground">확정된 조건만 적어 주세요. 적지 않은 기간은 제안의 가정으로 표시됩니다.</p>
                </div>

                <Button type="button" onClick={generate} disabled={busy || applied} className="self-start">
                  {generating ? <Spinner data-icon="inline-start" /> : <Sparkles data-icon="inline-start" aria-hidden />}
                  {generating ? "일정안 만드는 중…" : plan ? "일정안 다시 만들기" : "일정안 만들기"}
                </Button>

                {plan ? (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">반영 전 미리보기</h3>
                      <Badge variant="outline">{plan.phases.length}개 단계</Badge>
                      <Badge variant="secondary">아직 문서 변경 없음</Badge>
                    </div>
                    <ScheduleGrid months={months} phases={plan.phases} />
                    <div className="flex flex-col gap-3">
                      {plan.phases.map((phase, index) => (
                        <div key={`${index}-${phase.title}`} className="rounded-lg border p-3">
                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px_110px]">
                            <Input
                              value={phase.title}
                              onChange={(event) => updatePhase(index, { title: event.target.value })}
                              maxLength={80}
                              aria-label={`${index + 1}단계 제목`}
                              disabled={busy || applied}
                            />
                            <MonthSelect
                              label={`${index + 1}단계 시작 월`}
                              value={phase.startMonth}
                              months={months}
                              disabled={busy || applied}
                              onChange={(startMonth) => updatePhase(index, {
                                startMonth,
                                ...(months.indexOf(startMonth) > months.indexOf(phase.endMonth) ? { endMonth: startMonth } : {}),
                              })}
                            />
                            <MonthSelect
                              label={`${index + 1}단계 종료 월`}
                              value={phase.endMonth}
                              months={months.filter((month) => months.indexOf(month) >= months.indexOf(phase.startMonth))}
                              disabled={busy || applied}
                              onChange={(endMonth) => updatePhase(index, { endMonth })}
                            />
                          </div>
                          <p className="mt-2 text-xs leading-5 text-muted-foreground">근거: {phase.basis}</p>
                          {phase.assumptions.length > 0 ? (
                            <p className="mt-1 text-xs leading-5 text-amber-700 dark:text-amber-300">가정: {phase.assumptions.join(" · ")}</p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {planError ? <p className="text-sm text-destructive">{planError}</p> : null}
                    {applied ? (
                      <Alert>
                        <CheckCircle2 aria-hidden />
                        <AlertTitle>문서에 반영하고 서버 작업본으로 저장했습니다</AlertTitle>
                        <AlertDescription>이 대화상자에서 가장 최근 자동 입력 한 건만 되돌릴 수 있습니다.</AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                ) : null}

                {error ? (
                  <Alert variant="destructive">
                    <TriangleAlert aria-hidden />
                    <AlertTitle>일정표 작업을 계속할 수 없습니다</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            ) : (
              <Alert variant="destructive">
                <TriangleAlert aria-hidden />
                <AlertTitle>자동 입력할 일정표를 확정하지 못했습니다</AlertTitle>
                <AlertDescription>{
                  inspection && inspection.status !== "unique"
                    ? inspection.message
                    : error ?? "현재 문서를 다시 열고 시도해 주세요."
                }</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t px-6 py-4">
            {undoAvailable ? (
              <Button type="button" variant="outline" onClick={undo} disabled={busy}>
                {undoing ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" aria-hidden />}
                {undoing ? "되돌리는 중…" : "최근 일정표 입력 되돌리기"}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>닫기</Button>
            <Button type="button" onClick={apply} disabled={!target || !plan || Boolean(planError) || busy || applied}>
              {applying ? <Spinner data-icon="inline-start" /> : <CheckCircle2 data-icon="inline-start" aria-hidden />}
              {applying ? "검증·저장 중…" : "표에 반영"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScheduleGrid({ months, phases }: { months: readonly number[]; phases: readonly SchedulePhase[] }) {
  const columns = `minmax(160px, 2fr) repeat(${months.length}, minmax(34px, 1fr))`;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <div className="grid min-w-[680px] text-xs" style={{ gridTemplateColumns: columns }}>
        <div className="border-r border-b bg-muted px-3 py-2 font-semibold">추진내용</div>
        {months.map((month) => <div key={month} className="border-r border-b bg-muted px-1 py-2 text-center font-semibold last:border-r-0">{month}월</div>)}
        {phases.map((phase, rowIndex) => (
          <div key={`${rowIndex}-${phase.title}`} className="contents">
            <div className="border-r border-b px-3 py-2 font-medium last:border-b-0">{phase.title}</div>
            {months.map((month) => {
              const active = month >= phase.startMonth && month <= phase.endMonth;
              return <div key={month} className={`border-r border-b last:border-r-0 ${active ? "bg-amber-200 dark:bg-amber-700/60" : "bg-background"}`} aria-label={`${phase.title} ${month}월 ${active ? "추진" : "미추진"}`} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthSelect({
  label,
  value,
  months,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  months: readonly number[];
  disabled: boolean;
  onChange: (month: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))} disabled={disabled}>
      <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {months.map((month) => <SelectItem key={month} value={String(month)}>{month}월</SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function validateEditablePlan(plan: ScheduleTablePlan | null, target: ScheduleTableTarget | null): string | null {
  if (!plan || !target) return null;
  if (plan.phases.length > target.rows.length) return `이 표에는 최대 ${target.rows.length}개 단계만 넣을 수 있습니다.`;
  const titles = new Set<string>();
  let previousStart = -1;
  for (const phase of plan.phases) {
    const title = phase.title.trim();
    if (title.length < 2) return "모든 단계 제목을 두 글자 이상 입력해 주세요.";
    const key = title.toLocaleLowerCase("ko-KR");
    if (titles.has(key)) return "같은 단계 제목이 두 번 있습니다.";
    titles.add(key);
    const start = target.months.indexOf(phase.startMonth);
    const end = target.months.indexOf(phase.endMonth);
    if (start < 0 || end < start || start < previousStart) return "단계는 시작 월이 빠른 순서로 정렬해 주세요.";
    previousStart = start;
  }
  return null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
