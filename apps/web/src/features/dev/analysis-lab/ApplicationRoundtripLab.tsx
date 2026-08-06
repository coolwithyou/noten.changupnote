"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  FileCheck2,
  FileInput,
  FileSearch,
  RefreshCw,
  Save,
} from "lucide-react";
import type {
  ApplicationRoundtripRun,
  RoundtripCohortNotice,
  RoundtripCohortResponse,
  RoundtripDocumentRole,
  RoundtripFieldCandidate,
  RoundtripFillResult,
  RoundtripParsedDocument,
} from "./application-roundtrip-contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { RhwpFieldReviewPanel } from "./RhwpFieldReviewPanel";
import { localAnalysisRequestHeaders } from "./useLocalAnalysisRuntime";
import { AnalysisLabPageHeader, AnalysisMetric } from "./AnalysisLabPageHeader";
import { AnalysisLabErrorAlert } from "./AnalysisLabErrorAlert";

const COHORT_URL = "/api/dev/analysis-lab/application-roundtrip/cohort";
const ANALYZE_URL = "/api/dev/analysis-lab/application-roundtrip/analyze";
const FILL_URL = "/api/dev/analysis-lab/application-roundtrip/fill";

export function ApplicationRoundtripLab({
  analysisAllowed,
  analysisOwnerId,
}: {
  analysisAllowed: boolean;
  analysisOwnerId: string | null;
}) {
  const [cohort, setCohort] = useState<RoundtripCohortResponse | null>(null);
  const [cohortLoading, setCohortLoading] = useState(true);
  const [selectedGrantId, setSelectedGrantId] = useState("");
  const [run, setRun] = useState<ApplicationRoundtripRun | null>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [choiceValues, setChoiceValues] = useState<Record<string, string[]>>({});
  const [fieldChoiceValues, setFieldChoiceValues] = useState<Record<string, string[]>>({});
  const [analyzing, setAnalyzing] = useState(false);
  const [filling, setFilling] = useState(false);
  const [fillResult, setFillResult] = useState<RoundtripFillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const loadCohort = useCallback(async () => {
    setCohortLoading(true);
    setError(null);
    try {
      const response = await fetch(COHORT_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(await readErrorMessage(response, "지원서 후보 공고를 불러오지 못했습니다."));
      const data = (await response.json()) as RoundtripCohortResponse;
      setCohort(data);
      setSelectedGrantId((current) => current && data.notices.some((notice) => notice.grantId === current)
        ? current
        : data.notices[0]?.grantId ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "지원서 후보 공고를 불러오지 못했습니다.");
    } finally {
      setCohortLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCohort();
  }, [loadCohort]);

  const selectedNotice = useMemo(
    () => cohort?.notices.find((notice) => notice.grantId === selectedGrantId) ?? null,
    [cohort, selectedGrantId],
  );
  const selectedDocument = useMemo(
    () => run?.documents.find((document) => document.attachmentId === selectedAttachmentId) ?? null,
    [run, selectedAttachmentId],
  );
  const inputFields = useMemo(
    () => selectedDocument?.fields.filter((field) => field.recommendedInput) ?? [],
    [selectedDocument],
  );
  const choiceGroups = selectedDocument?.choiceGroups ?? [];
  const progress = fillResult ? 100 : selectedDocument ? 75 : run ? 50 : selectedGrantId ? 25 : 0;
  const candidateAttachmentCount = cohort?.notices.reduce((sum, notice) => sum + notice.attachments.length, 0) ?? 0;
  const parsedDocumentCount = run?.documents.length ?? 0;
  const recognizedFieldCount = run?.documents.reduce(
    (sum, document) => sum + document.recommendedInputFieldCount + document.recommendedChoiceGroupCount,
    0,
  ) ?? 0;

  const chooseGrant = (grantId: string) => {
    setSelectedGrantId(grantId);
    setRun(null);
    setSelectedAttachmentId("");
    setValues({});
    setChoiceValues({});
    setFieldChoiceValues({});
    setFillResult(null);
    setError(null);
  };

  const chooseDocument = useCallback((document: RoundtripParsedDocument) => {
    setSelectedAttachmentId(document.attachmentId);
    setValues(defaultSampleValues(document));
    setChoiceValues(defaultSampleChoices(document));
    setFieldChoiceValues(defaultContextualFieldChoices(document));
    setFillResult(null);
    setError(null);
  }, []);

  const analyze = async () => {
    if (!selectedGrantId || inFlightRef.current) return;
    inFlightRef.current = true;
    setAnalyzing(true);
    setError(null);
    setFillResult(null);
    try {
      const response = await fetch(ANALYZE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...localAnalysisRequestHeaders(analysisOwnerId),
        },
        body: JSON.stringify({ grantId: selectedGrantId }),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, "지원서 양식 분석에 실패했습니다."));
      const data = (await response.json()) as { run: ApplicationRoundtripRun };
      setRun(data.run);
      const recommended = data.run.documents.find(
        (document) => document.attachmentId === data.run.recommendedAttachmentId,
      ) ?? data.run.documents.find((document) => document.error === null
        && (document.recommendedInputFieldCount > 0 || document.recommendedChoiceGroupCount > 0)) ?? null;
      if (recommended) chooseDocument(recommended);
      else {
        setSelectedAttachmentId("");
        setValues({});
        setChoiceValues({});
        setFieldChoiceValues({});
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "지원서 양식 분석에 실패했습니다.");
    } finally {
      inFlightRef.current = false;
      setAnalyzing(false);
    }
  };

  const resetSamples = () => {
    if (!selectedDocument) return;
    setValues(defaultSampleValues(selectedDocument));
    setChoiceValues(defaultSampleChoices(selectedDocument));
    setFieldChoiceValues(defaultContextualFieldChoices(selectedDocument));
  };

  const fillAndSave = async () => {
    if (!run || !selectedDocument || inFlightRef.current) return;
    inFlightRef.current = true;
    setFilling(true);
    setError(null);
    setFillResult(null);
    try {
      const response = await fetch(FILL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grantId: run.grantId,
          runId: run.runId,
          attachmentId: selectedDocument.attachmentId,
          values,
          choices: choiceValues,
          fieldChoices: fieldChoiceValues,
        }),
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, "문서 채움·저장에 실패했습니다."));
      const data = (await response.json()) as { fill: RoundtripFillResult };
      setFillResult(data.fill);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "문서 채움·저장에 실패했습니다.");
    } finally {
      inFlightRef.current = false;
      setFilling(false);
    }
  };

  return (
    <main className="flex w-full min-w-0 flex-col gap-6 pb-12">
      <AnalysisLabPageHeader
        icon={FileCheck2}
        eyebrow="QUICK FORM PREPARATION"
        title="빠른 작성 필드 검수"
        description="HWP/HWPX 지원서의 입력칸과 선택지를 미리 찾아, 빠진 항목이 없는지 원본에서 확인합니다."
        badges={cohort ? <Badge variant="secondary">분석 엔진 {cohort.engineVersion}</Badge> : null}
        action={(
          <Button variant="outline" size="sm" onClick={() => void loadCohort()} disabled={cohortLoading || analyzing || filling}>
            <RefreshCw data-icon="inline-start" /> 후보 새로고침
          </Button>
        )}
      />

      <section aria-label="빠른 작성 분석 지표" className={`grid gap-3 sm:grid-cols-2 ${run ? "xl:grid-cols-4" : "xl:grid-cols-2"}`}>
        <AnalysisMetric label="후보 공고" value={cohort?.notices.length ?? "—"} description="HWP/HWPX가 보관된 공고" />
        <AnalysisMetric label="후보 첨부" value={cohort ? candidateAttachmentCount : "—"} description="분석 가능한 바이너리 원본" />
        {run ? <AnalysisMetric label="분석한 문서" value={parsedDocumentCount} description="현재 실행에서 읽은 문서" /> : null}
        {run ? <AnalysisMetric label="찾은 입력 필드" value={recognizedFieldCount} description="텍스트 입력과 객관식 합계" /> : null}
      </section>

      <ProcessProgress value={progress} />

      {error ? (
        <AnalysisLabErrorAlert title="지원서 분석 정보를 불러오지 못했습니다" message={error} />
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>1. 분석할 공고 선택</CardTitle>
          <CardDescription>첨부파일 힌트를 확인하고 먼저 한 공고를 선택하세요.</CardDescription>
        </CardHeader>
        <CardContent>
        {cohortLoading ? (
          <div className="grid gap-3">
            <Skeleton className="h-44" />
            <Skeleton className="h-44" />
          </div>
        ) : cohort && cohort.notices.length > 0 ? (
          <div className="grid items-start gap-3">
            {cohort.notices.map((notice) => (
              <NoticeCandidateCard
                key={notice.grantId}
                notice={notice}
                selected={notice.grantId === selectedGrantId}
                disabled={analyzing || filling}
                onSelect={() => chooseGrant(notice.grantId)}
              />
            ))}
          </div>
        ) : (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>보관된 HWP/HWPX 후보가 없습니다</EmptyTitle>
              <EmptyDescription>현재 open 공고의 첨부 보관 상태를 확인해 주세요.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. 지원서 양식 분석</CardTitle>
          <CardDescription>선택한 공고의 모든 HWP/HWPX를 읽고 지원서와 입력 항목을 찾습니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!analysisAllowed ? (
            <Alert>
              <AlertTitle>구독 분석 모드를 먼저 켜세요</AlertTitle>
              <AlertDescription>왼쪽 분석 모드에서 권한을 열면 선택한 공고의 첨부 분석을 시작할 수 있습니다.</AlertDescription>
            </Alert>
          ) : null}
          <Button className="w-full" onClick={() => void analyze()} disabled={!analysisAllowed || !selectedNotice || analyzing || filling}>
            {analyzing ? <Spinner data-icon="inline-start" /> : <FileSearch data-icon="inline-start" />}
            {analyzing ? "지원서 첨부 분석 중…" : "지원서 양식 분석"}
          </Button>
        {selectedNotice ? (
          <Alert>
            <AlertTitle>{selectedNotice.title}</AlertTitle>
            <AlertDescription>
              HWP/HWPX {selectedNotice.attachments.length}개 · 파일명 기준 지원서 후보 {selectedNotice.likelyApplicationDocumentCount}개
            </AlertDescription>
          </Alert>
        ) : null}
        {run ? <ParsedDocuments run={run} /> : null}
        </CardContent>
      </Card>
      </div>

      {run ? (
        <section className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium">3. 인식 결과를 원본에서 검증</h2>
            <p className="text-sm text-muted-foreground">문서를 선택하면 분석 위치와 rhwp 원본을 함께 보여줍니다. 빠진 필드가 없는지 여기서 확인하세요.</p>
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="roundtrip-document">채울 문서</FieldLabel>
              <Select
                value={selectedAttachmentId}
                onValueChange={(value) => {
                  const document = run.documents.find((item) => item.attachmentId === value);
                  if (document) chooseDocument(document);
                }}
              >
                <SelectTrigger id="roundtrip-document" className="w-full">
                  <SelectValue placeholder="빈 필드가 있는 문서를 선택하세요" />
                </SelectTrigger>
                <SelectContent>
                  {run.documents.filter((document) => document.error === null).map((document) => (
                    <SelectItem key={document.attachmentId} value={document.attachmentId}>
                      {roleLabel(document.role)} · 텍스트 {document.recommendedInputFieldCount} · 객관식 {document.recommendedChoiceGroupCount} · {document.filename}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{run.recommendationReason}</FieldDescription>
            </Field>
          </FieldGroup>

          {selectedDocument ? (
            <RhwpFieldReviewPanel
              key={`original:${selectedDocument.attachmentId}`}
              sourceUrl={`/api/dev/hwp-preview/file?id=${encodeURIComponent(selectedDocument.attachmentId)}`}
              filename={selectedDocument.filename}
              sourceLabel="원본"
              fields={selectedDocument.fields}
              choiceGroups={choiceGroups}
            />
          ) : null}

          {selectedDocument ? (
            inputFields.length > 0 || choiceGroups.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>
                    사용자 입력: 텍스트 {inputFields.length}개 · 객관식 {choiceGroups.length}개
                  </CardTitle>
                  <CardDescription>
                    가상 샘플을 기본 선택했습니다. 단위는 보존하고, 예시·파란 안내문은 해당 위치만 교체하며,
                    객관식은 네이티브 CheckBox 또는 문서의 □ 마커에 저장합니다.
                  </CardDescription>
                  <CardAction>
                    <Button variant="outline" size="sm" onClick={resetSamples} disabled={filling}>
                      샘플값 초기화
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[34rem] pr-3">
                    <FieldGroup>
                      {choiceGroups.map((group) => {
                        const selected = choiceValues[group.groupId] ?? [];
                        return (
                          <FieldSet key={group.groupId} disabled={filling} className="rounded-lg border border-border p-4">
                            <FieldLegend variant="label">{group.label}</FieldLegend>
                            <FieldDescription>
                              {group.selectionMode === "single" ? "하나 선택" : "복수 선택 가능"}
                              {" · "}HWP CheckBox {group.options.length}개
                              {" · "}표 {group.location.tableIndex + 1}, 행 {group.location.row + 1}
                            </FieldDescription>
                            <ToggleGroup
                              variant="outline"
                              className="flex w-full flex-wrap justify-start"
                              multiple={group.selectionMode === "multiple"}
                              value={selected}
                              onValueChange={(nextValue) => {
                                const next = nextValue as string[];
                                if (group.selectionMode === "single" && next.length === 0) return;
                                setChoiceValues((current) => ({ ...current, [group.groupId]: next }));
                              }}
                            >
                              {group.options.map((option) => {
                                const checked = selected.includes(option.optionId);
                                return (
                                  <ToggleGroupItem key={option.optionId} value={option.optionId} aria-label={`${group.label}: ${option.label}`}>
                                    {checked ? <Check data-icon="inline-start" /> : null}
                                    {option.label}
                                  </ToggleGroupItem>
                                );
                              })}
                            </ToggleGroup>
                          </FieldSet>
                        );
                      })}
                      {inputFields.map((field) => (
                        <EditableInputField
                          key={field.fieldInstanceId}
                          field={field}
                          value={values[field.fieldInstanceId] ?? ""}
                          selectedOptionIds={fieldChoiceValues[field.fieldInstanceId] ?? []}
                          disabled={filling}
                          onValueChange={(value) => setValues((current) => ({
                            ...current,
                            [field.fieldInstanceId]: value,
                          }))}
                          onSelectionChange={(optionIds) => setFieldChoiceValues((current) => ({
                            ...current,
                            [field.fieldInstanceId]: optionIds,
                          }))}
                        />
                      ))}
                    </FieldGroup>
                  </ScrollArea>
                </CardContent>
                <CardFooter className="justify-between gap-3">
                  <span className="text-xs text-muted-foreground">원본은 덮어쓰지 않고 별도 실험 산출물로 저장합니다.</span>
                  <Button
                    onClick={() => void fillAndSave()}
                    disabled={filling || (inputFields.length === 0 && choiceGroups.length === 0)}
                  >
                    {filling ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
                    {filling ? "채움·재검증 중…" : "샘플 채우고 저장"}
                  </Button>
                </CardFooter>
              </Card>
            ) : (
              <Alert>
                <AlertTitle>입력 대상을 찾지 못했습니다</AlertTitle>
                <AlertDescription>다른 문서를 선택하거나 문서별 텍스트·객관식 필드 수를 확인해 주세요.</AlertDescription>
              </Alert>
            )
          ) : null}
        </section>
      ) : null}

      {fillResult ? (
        <>
          <FillResultCard result={fillResult} />
          {selectedDocument ? (
            <RhwpFieldReviewPanel
              key={`filled:${fillResult.fillId}`}
              sourceUrl={fillResult.downloadUrl}
              filename={fillResult.outputFilename}
              sourceLabel="빠른 작성 채움본"
              fields={inputFields}
              choiceGroups={choiceGroups}
              diagnosticSource
            />
          ) : null}
        </>
      ) : null}
    </main>
  );
}

function EditableInputField({
  field,
  value,
  selectedOptionIds,
  disabled,
  onValueChange,
  onSelectionChange,
}: {
  field: RoundtripFieldCandidate;
  value: string;
  selectedOptionIds: string[];
  disabled: boolean;
  onValueChange: (value: string) => void;
  onSelectionChange: (optionIds: string[]) => void;
}) {
  const inputId = `roundtrip-field-${field.fieldInstanceId}`;
  const isChoice = field.inputKind === "single_choice" || field.inputKind === "multiple_choice";
  if (isChoice) {
    return (
      <FieldSet disabled={disabled} className="rounded-lg border border-border p-4">
        <FieldLegend variant="label">{field.displayLabel}</FieldLegend>
        <FieldDescription>{field.helperText ?? field.sampleReason}</FieldDescription>
        <ToggleGroup
          variant="outline"
          className="flex w-full flex-wrap justify-start"
          multiple={field.inputKind === "multiple_choice"}
          value={selectedOptionIds}
          onValueChange={(nextValue) => {
            const next = nextValue as string[];
            if (field.inputKind === "single_choice" && next.length === 0) return;
            onSelectionChange(next);
          }}
        >
          {field.options.map((option) => {
            const checked = selectedOptionIds.includes(option.optionId);
            return (
              <ToggleGroupItem
                key={option.optionId}
                value={option.optionId}
                aria-label={`${field.displayLabel}: ${option.label}`}
              >
                {checked ? <Check data-icon="inline-start" /> : null}
                {option.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <FieldDescription>{fieldMetadata(field)}</FieldDescription>
      </FieldSet>
    );
  }

  return (
    <Field>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={inputId}>{field.displayLabel}</FieldLabel>
        {field.required ? <Badge>필수 표시</Badge> : <Badge variant="secondary">선택/미표시</Badge>}
        <Badge variant="outline">{field.inputKind}</Badge>
        <Badge variant="outline">{field.analysisSource === "llm" ? "LLM 판정" : "구조 규칙"}</Badge>
      </div>
      {field.helperText ? <FieldDescription>{field.helperText}</FieldDescription> : null}
      {field.inputKind === "textarea" ? (
        <Textarea
          id={inputId}
          rows={5}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          disabled={disabled}
        />
      ) : field.inputKind === "number" && field.unit ? (
        <InputGroup>
          <InputGroupInput
            id={inputId}
            inputMode="numeric"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            disabled={disabled}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{field.unit}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input
          id={inputId}
          inputMode={field.inputKind === "number" ? "numeric" : undefined}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          disabled={disabled}
        />
      )}
      <FieldDescription>{fieldMetadata(field)}</FieldDescription>
    </Field>
  );
}

function fieldMetadata(field: RoundtripFieldCandidate): string {
  const location = field.location.target?.kind === "block_text"
    ? `문단 블록 ${field.location.blockIndex + 1}`
    : `표 블록 ${field.location.blockIndex + 1}, 행 ${field.location.row + 1}, 열 ${field.location.col + 1}`;
  const confidence = field.llmConfidence === null ? field.inputLikelihood : field.llmConfidence;
  return `${field.sampleReason} · ${field.writeOperation} · 신뢰도 ${confidence.toFixed(2)} · ${location}`;
}

function ProcessProgress({ value }: { value: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>빠른 작성 준비 단계</CardTitle>
        <CardDescription>공고 선택 → 첨부 분석 → 필드 확인 → 채움본 재검증</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Progress value={value} />
        <div className="grid grid-cols-4 gap-2 text-center text-[11px] text-muted-foreground">
          <span className={value >= 25 ? "font-medium text-foreground" : ""}>공고</span>
          <span className={value >= 50 ? "font-medium text-foreground" : ""}>첨부 분석</span>
          <span className={value >= 75 ? "font-medium text-foreground" : ""}>필드 확인</span>
          <span className={value >= 100 ? "font-medium text-foreground" : ""}>재검증</span>
        </div>
      </CardContent>
    </Card>
  );
}

function NoticeCandidateCard({
  notice,
  selected,
  disabled,
  onSelect,
}: {
  notice: RoundtripCohortNotice;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <Card className={selected ? "ring-2 ring-primary" : ""}>
      <CardHeader>
        <CardTitle className="line-clamp-2">{notice.title}</CardTitle>
        <CardDescription>{notice.agency ?? notice.source}</CardDescription>
        <CardAction><Badge variant={notice.likelyApplicationDocumentCount > 0 ? "default" : "secondary"}>후보 {notice.likelyApplicationDocumentCount}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {notice.attachments.slice(0, 4).map((attachment) => (
          <div key={attachment.filename} className="flex min-w-0 items-center gap-2 text-xs">
            <FileInput className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
            <Badge variant="outline">{roleLabel(attachment.roleHint)}</Badge>
          </div>
        ))}
      </CardContent>
      <CardFooter className="justify-between gap-2">
        <span className="text-xs text-muted-foreground">HWP/X {notice.attachments.length}개</span>
        <Button size="sm" variant={selected ? "secondary" : "outline"} onClick={onSelect} disabled={disabled}>
          {selected ? "선택됨" : "이 공고 선택"}
          {!selected ? <ArrowRight data-icon="inline-end" /> : null}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ParsedDocuments({ run }: { run: ApplicationRoundtripRun }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>첨부 분석 결과 {run.documents.length}개</CardTitle>
        <CardDescription>{run.engine} {run.engineVersion} · {formatDuration(run.durationMs)} · 런 {run.runId}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 lg:grid-cols-2">
        {run.documents.map((document) => (
          <div key={document.attachmentId} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 flex-1 break-words font-medium">{document.filename}</span>
              <Badge variant={document.error ? "destructive" : likelyRole(document.role) ? "default" : "secondary"}>
                {document.error ? "분석 실패" : roleLabel(document.role)}
              </Badge>
            </div>
            {document.error ? (
              <p className="break-words text-xs text-destructive">{document.error}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">실제 {document.detectedFormat?.toUpperCase()}</Badge>
                  <Badge variant="outline">표 {document.tableCount}</Badge>
                  <Badge variant="outline">필드 {document.fields.length}</Badge>
                  <Badge variant="outline">raw 빈 필드 {document.emptyFieldCount}</Badge>
                  <Badge variant="outline">입력 후보 {document.recommendedInputFieldCount}</Badge>
                  <Badge variant="outline">객관식 {document.recommendedChoiceGroupCount}</Badge>
                  <Badge variant="outline">양식 {document.formConfidence.toFixed(2)}</Badge>
                  <Badge variant={document.fieldPlanning.status === "llm" ? "default" : "secondary"}>
                    {document.fieldPlanning.status === "llm"
                      ? `LLM ${document.fieldPlanning.acceptedCount}/${document.fieldPlanning.candidateCount}`
                      : "규칙 폴백"}
                  </Badge>
                  <Badge variant={document.fieldCoverage.status === "complete" ? "default" : "secondary"}>
                    {document.fieldCoverage.status === "complete"
                      ? "필드 커버리지 완료"
                      : document.fieldCoverage.status === "partial"
                        ? `부분 커버리지 ${document.fieldCoverage.structuralWarningCount}건`
                        : `검수 필요 ${document.fieldCoverage.unresolvedCandidateCount}건`}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{document.roleSignals.join(" · ") || "뚜렷한 역할 신호 없음"}</p>
                {document.fieldPlanning.warning ? (
                  <p className="text-xs text-muted-foreground">{document.fieldPlanning.warning}</p>
                ) : null}
                {document.fieldCoverage.unresolvedCandidates.length > 0 ? (
                  <div className="rounded-md bg-warning-soft p-2 text-xs ring-1 ring-warning/20">
                    {document.fieldCoverage.unresolvedCandidates.map((issue) => (
                      <p key={issue.fieldInstanceId}>{issue.label} — {issue.reason}</p>
                    ))}
                  </div>
                ) : null}
                {document.fieldCoverage.structuralWarnings.length > 0 ? (
                  <div className="rounded-md border p-2 text-xs text-muted-foreground">
                    {document.fieldCoverage.structuralWarnings.map((issue) => (
                      <p key={issue.fieldInstanceId}>{issue.label} — {issue.reason}</p>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function FillResultCard({ result }: { result: RoundtripFillResult }) {
  const failed = result.fieldVerifications.filter((item) => item.status !== "matched");
  const failedChoices = result.choiceVerifications.filter((item) => item.status !== "matched");
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium">4. 저장본 다시 읽어 검증</h2>
      <Card className={result.allVerified ? "ring-2 ring-primary/40" : "ring-2 ring-destructive/40"}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className={result.allVerified ? "text-primary" : "text-destructive"} />
            {result.allVerified ? "요청한 입력이 저장본에 모두 반영됐습니다" : "일부 입력은 저장본에서 일치하지 않았습니다"}
          </CardTitle>
          <CardDescription>{result.outputFilename} · {result.fillMode} · {formatDuration(result.durationMs)}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="텍스트 요청" value={`${result.requestedFieldCount}개`} />
            <Metric label="자동 채움" value={`${result.kordocFilledCount}개`} />
            <Metric label="텍스트 검증" value={`${result.verifiedFieldCount}개`} />
            <Metric label="객관식 요청" value={`${result.requestedChoiceGroupCount}개`} />
            <Metric label="CheckBox 변경" value={`${result.formControlPatchedCount}개`} />
            <Metric label="객관식 검증" value={`${result.verifiedChoiceGroupCount}개`} />
          </div>
          <p className="text-xs text-muted-foreground">
            문서 diff: 수정 {result.documentDiff.modified}, 추가 {result.documentDiff.added}, 삭제 {result.documentDiff.removed} · 패치 skip {result.patchSkipped.length}
          </p>
          {result.hwpIntegrity ? (
            <p className="text-xs text-muted-foreground">
              HWP 구조 검증: 문단 {result.hwpIntegrity.validatedParagraphs}개 · 줄 배치 보정 {result.hwpIntegrity.repairedLineSegmentParagraphs}개 · 최종 위반 {result.hwpIntegrity.finalIssueCount}개
            </p>
          ) : null}
          {result.warnings.length > 0 ? (
            <Alert variant={result.allVerified ? "default" : "destructive"}>
              <AlertTitle>{result.allVerified ? "저장 방식 안내" : "확인이 필요한 항목"}</AlertTitle>
              <AlertDescription>{result.warnings.join(" · ")}</AlertDescription>
            </Alert>
          ) : null}
          {failed.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3 text-xs">
              {failed.slice(0, 20).map((item) => (
                <p key={item.fieldInstanceId}>
                  <span className="font-medium">{item.label}</span>: 기대 “{item.expectedValue}” / 실제 “{item.actualValue ?? "찾지 못함"}”
                </p>
              ))}
            </div>
          ) : null}
          {failedChoices.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3 text-xs">
              {failedChoices.slice(0, 20).map((item) => (
                <p key={item.groupId}>
                  <span className="font-medium">{item.label}</span>: 객관식 저장 검증 {item.status}
                </p>
              ))}
            </div>
          ) : null}
        </CardContent>
        <CardFooter>
          <span className="text-xs text-muted-foreground">원시 분석 산출물은 아래 rhwp 진단 입력으로만 사용합니다. 에디터의 자기 재로드 검증을 통과하기 전에는 직접 다운로드할 수 없습니다.</span>
        </CardFooter>
      </Card>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function defaultSampleValues(document: RoundtripParsedDocument): Record<string, string> {
  return Object.fromEntries(
    document.fields
      .filter((field) => field.recommendedInput
        && field.inputKind !== "single_choice"
        && field.inputKind !== "multiple_choice")
      .map((field) => [field.fieldInstanceId, field.sampleValue]),
  );
}

function defaultContextualFieldChoices(document: RoundtripParsedDocument): Record<string, string[]> {
  return Object.fromEntries(
    document.fields
      .filter((field) => field.recommendedInput && field.options.length > 0)
      .map((field) => {
        const selected = field.options.filter((option) => option.selected).map((option) => option.optionId);
        const fallback = field.inputKind === "multiple_choice"
          ? field.options.slice(0, Math.min(2, field.options.length)).map((option) => option.optionId)
          : field.options[0] ? [field.options[0].optionId] : [];
        return [field.fieldInstanceId, selected.length > 0 ? selected : fallback];
      }),
  );
}

function defaultSampleChoices(document: RoundtripParsedDocument): Record<string, string[]> {
  return Object.fromEntries(
    (document.choiceGroups ?? []).map((group) => {
      const selected = group.options.filter((option) => option.selected).map((option) => option.optionId);
      return [group.groupId, selected.length > 0 ? selected : group.options[0] ? [group.options[0].optionId] : []];
    }),
  );
}

function likelyRole(role: RoundtripDocumentRole): boolean {
  return role === "application_form" || role === "business_plan" || role === "mixed_form";
}

function roleLabel(role: RoundtripDocumentRole): string {
  if (role === "application_form") return "지원서";
  if (role === "business_plan") return "사업계획서";
  if (role === "mixed_form") return "혼합 양식";
  if (role === "announcement") return "공고문";
  if (role === "evidence") return "증빙/동의";
  return "미분류";
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}초`;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    return data.message ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}
