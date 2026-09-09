"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, CircleDashed, CircleDot, Plus, X } from "lucide-react";
import type {
  CriterionDimension,
  MatchingProfileAnswerRequest,
  ProductTeaserResult,
} from "@cunote/contracts";
import { Progress } from "@/components/ui/progress";
import { profileSourceHelp } from "./profileSourceHelp";
import { BASIC_PROFILE_DIMENSIONS, buildProfileCompletion, profileInputState, PROFILE_INPUT_STATE_LABELS, type ProfileInputState } from "./profileCompletion";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { DisqualificationSheet } from "./DisqualificationSheet";
import { PriorAwardSheet } from "./PriorAwardSheet";
import { PremisesInputPanel } from "./PremisesInputPanel";
import {
  DISQUALIFICATION_AXES,
  REVENUE_UNIT_OPTIONS,
  buildProfileFields,
  buildProfileAnswer,
  decimalNumberText,
  digitsOnly,
  disqualificationAllKnown,
  initialProfileInputDraft,
  profileFieldDisplayLabel,
  profileRowStatus,
  profileSheetValueState,
  profileInputDescription,
  profileInputMode,
  profileInputPlaceholder,
  profileInputSuggestions,
  profileInputText,
  revenueUnitLabel,
  matchingProfileCoverage,
  toRevenueUnit,
  type AnswerImpactSummary,
  type ProfileFieldView,
  type ProfileInputDraft,
  type ProfileSheetValueState,
} from "./logic";

type ProfileSheetView = "profile" | "disqualification" | "prior_award";

export const PROFILE_SHEET_DIMENSIONS = [
  { key: "region", label: "소재지" },
  { key: "industry", label: "업종" },
  { key: "biz_age", label: "업력" },
  { key: "business_status", label: "영업상태" },
  { key: "target_type", label: "사업자 유형" },
  { key: "size", label: "기업규모" },
  { key: "revenue", label: "연 매출" },
  { key: "employees", label: "상시근로자" },
  { key: "founder_age", label: "대표자 연령" },
  { key: "certification", label: "보유 인증" },
  { key: "premises", label: "등록 사업장" },
] as const satisfies ReadonlyArray<{ key: CriterionDimension; label: string }>;

export interface ProfileSheetRow {
  key: CriterionDimension | "corp_name";
  label: string;
  value: string;
  sourceLabel: string | null;
  state: ProfileSheetValueState;
  inputState: ProfileInputState;
  field: ProfileFieldView | null;
}

interface SavedFieldFeedback {
  key: CriterionDimension;
  label: string;
  beforeKnown: number;
}

export function ProfileSection({
  teaser,
  onAnswer,
  submitting,
  open,
  onOpenChange,
  answerImpact = null,
  answers = [],
  draftNotice = "회사 저장 전 입력은 현재 결과에만 반영됩니다.",
  onSaveCompany,
  savingCompany = false,
  savedCompany = false,
  companyId,
  profileWriteAllowed = false,
}: {
  teaser: ProductTeaserResult;
  onAnswer: (answer: MatchingProfileAnswerRequest) => Promise<void>;
  submitting: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 마지막 답변 반영 요약 — 저장 직후 새 확정 건수·정밀도 델타 피드백에 사용. */
  answerImpact?: AnswerImpactSummary | null;
  answers?: readonly MatchingProfileAnswerRequest[];
  draftNotice?: string;
  onSaveCompany?: () => void;
  savingCompany?: boolean;
  savedCompany?: boolean;
  companyId?: string | null;
  profileWriteAllowed?: boolean;
}) {
  const fields = useMemo(() => buildProfileFields(teaser), [teaser]);
  const coverage = matchingProfileCoverage(teaser);
  const canEditProfile = !companyId || profileWriteAllowed;
  const completion = buildProfileCompletion(teaser.profileView);
  const rows = useMemo(() => buildProfileSheetRows(teaser, fields, answers), [fields, teaser, answers]);
  const groupedRows = useMemo(() => {
    const basic: ProfileSheetRow[] = [];
    const additional: ProfileSheetRow[] = [];
    for (const row of rows) {
      if (row.key === "corp_name" || BASIC_PROFILE_DIMENSIONS.some((dimension) => dimension === row.key)) basic.push(row);
      else additional.push(row);
    }
    return { basic, additional };
  }, [rows]);
  const [activeFieldKey, setActiveFieldKey] = useState<CriterionDimension | null>(null);
  const [savedFeedback, setSavedFeedback] = useState<SavedFieldFeedback | null>(null);
  const [view, setView] = useState<ProfileSheetView>("profile");
  const savedDelta = savedFeedback ? coverage.known - savedFeedback.beforeKnown : 0;
  // 시트 내 저장 완료(savedFeedback) 직후에만 마지막 반영 요약의 새 확정 건수를 노출한다.
  const savedNewlyOpen = savedFeedback ? answerImpact?.newlyOpen ?? 0 : 0;

  useEffect(() => {
    if (!activeFieldKey) return;
    const next = rows.find((row) => row.field?.key === activeFieldKey);
    if (!next) setActiveFieldKey(null);
  }, [activeFieldKey, rows]);

  useEffect(() => {
    if (open) return;
    setActiveFieldKey(null);
    setSavedFeedback(null);
    setView("profile");
  }, [open]);

  useEffect(() => {
    setActiveFieldKey(null);
    setSavedFeedback(null);
    setView("profile");
  }, [companyId]);

  useEffect(() => {
    if (!companyId || profileWriteAllowed) return;
    setActiveFieldKey((current) => current === "premises" ? current : null);
    setSavedFeedback(null);
    setView("profile");
  }, [companyId, profileWriteAllowed]);

  async function submitProfileField(
    row: ProfileSheetRow,
    answer: MatchingProfileAnswerRequest,
  ) {
    if (!row.field) return;
    const beforeKnown = coverage.known;
    await onAnswer(answer);
    setSavedFeedback({ key: row.field.key, label: row.label, beforeKnown });
    setActiveFieldKey(null);
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!submitting && !savingCompany) onOpenChange(next); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-[420px] gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[420px]"
      >
        {view === "disqualification" ? (
          <DisqualificationSheet
            teaser={teaser}
            onAnswer={onAnswer}
            submitting={submitting}
            onBack={() => setView("profile")}
            onClose={() => onOpenChange(false)}
          />
        ) : view === "prior_award" ? (
          <PriorAwardSheet
            teaser={teaser}
            onAnswer={onAnswer}
            submitting={submitting}
            onBack={() => setView("profile")}
          />
        ) : (
          <>
            <SheetHeader className="flex-row items-center justify-between px-6 pt-6 pb-0">
              <div>
                <SheetTitle className="text-lg font-extrabold">내 사업자 정보</SheetTitle>
                <SheetDescription className="sr-only">
                  매칭에 사용하는 사업자 정보를 확인하고 빈 항목을 채웁니다.
                </SheetDescription>
              </div>
              <SheetClose
                render={<Button type="button" variant="ghost" size="icon-sm" aria-label="내 사업자 정보 닫기" />}
              >
                <X aria-hidden />
              </SheetClose>
            </SheetHeader>

            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 pb-6">
                {savedFeedback ? (
                  <Alert className="mt-4 border-brand-mint/30 bg-brand-mint-soft text-brand-mint-ink">
                    <Check aria-hidden />
                    <AlertDescription className="font-semibold text-brand-mint-ink">
                      {savedNewlyOpen > 0
                        ? `공고 ${savedNewlyOpen.toLocaleString("ko-KR")}건이 새로 확정됐어요`
                        : savedDelta > 0
                          ? `확인된 기업정보가 ${savedDelta}개 늘었어요`
                          : `${savedFeedback.label} 정보를 매칭 결과에 반영했어요`}
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="mt-5 flex flex-col gap-3" aria-label="기본정보 준비 상태">
                  <h3 className="text-base font-semibold">기본정보 {completion.completed}/{completion.total}개 준비</h3>
                  <Progress value={completion.percent} aria-label={`기본정보 준비 ${completion.percent}%`} />
                  <p className="text-sm leading-6 text-muted-foreground">
                    소재지·업종·업력·사업자 유형을 먼저 확인하세요. 정보 준비율은 지원 자격 충족률이 아닙니다.
                    공고 원문 분석이나 추가 조건 확인은 별도로 진행합니다.
                  </p>
                  <p className="text-xs leading-5 text-muted-foreground" role="status">{draftNotice}</p>
                  {companyId ? <a className="text-sm underline underline-offset-2" href={`/support/source-corrections?companyId=${encodeURIComponent(companyId)}`}>공식 원천 정정 요청·처리 내역</a> : null}
                </div>

                <ProfileSheetGroup
                  title="1. 먼저 확인할 기본정보"
                  tone="direct"
                  rows={groupedRows.basic}
                  activeFieldKey={activeFieldKey}
                  recentlySavedKey={savedFeedback?.key ?? null}
                  submitting={submitting}
                  teaser={teaser}
                  companyId={companyId}
                  profileWriteAllowed={profileWriteAllowed}
                  canEditProfile={canEditProfile}
                  onEdit={setActiveFieldKey}
                  onCancel={() => setActiveFieldKey(null)}
                  onSubmit={submitProfileField}
                />

                <ProfileSheetGroup
                  title="2. 공고 조건에 따라 필요한 추가정보"
                  tone="direct"
                  rows={groupedRows.additional}
                  activeFieldKey={activeFieldKey}
                  recentlySavedKey={savedFeedback?.key ?? null}
                  submitting={submitting}
                  teaser={teaser}
                  companyId={companyId}
                  profileWriteAllowed={profileWriteAllowed}
                  canEditProfile={canEditProfile}
                  onEdit={setActiveFieldKey}
                  onCancel={() => setActiveFieldKey(null)}
                  onSubmit={submitProfileField}
                />

                <ProfileVerificationGroup
                  teaser={teaser}
                  canEditProfile={canEditProfile}
                  onOpenDisqualification={() => setView("disqualification")}
                  onOpenPriorAward={() => setView("prior_award")}
                />
              </div>
            </ScrollArea>

            <SheetFooter className="border-t border-border-subtle px-6 py-3.5">
              {onSaveCompany && canEditProfile ? (
                <Button type="button" disabled={submitting || savingCompany} onClick={onSaveCompany}>
                  {savingCompany ? "처리 중" : savedCompany ? "저장된 정보로 이어가기" : "회사에 저장하고 이어가기"}
                </Button>
              ) : null}
              <SheetClose render={<Button type="button" variant="secondary" className="w-full" />}>
                현재 정보로 결과 보기
              </SheetClose>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ProfileSheetGroup({
  title,
  tone,
  rows,
  activeFieldKey,
  recentlySavedKey,
  submitting,
  teaser,
  companyId,
  profileWriteAllowed,
  canEditProfile,
  onEdit,
  onCancel,
  onSubmit,
}: {
  title: string;
  tone: "automatic" | "direct";
  rows: ProfileSheetRow[];
  activeFieldKey: CriterionDimension | null;
  recentlySavedKey: CriterionDimension | null;
  submitting: boolean;
  teaser: ProductTeaserResult;
  companyId: string | null | undefined;
  profileWriteAllowed: boolean;
  canEditProfile: boolean;
  onEdit: (key: CriterionDimension) => void;
  onCancel: () => void;
  onSubmit: (row: ProfileSheetRow, answer: MatchingProfileAnswerRequest) => Promise<void>;
}) {
  return (
    <section className="mt-6">
      <h3
        className={cn(
          "text-[13.5px] font-extrabold",
          tone === "automatic" ? "text-brand-mint-ink" : "text-brand",
        )}
      >
        {title}
      </h3>
      <div
        className={cn(
          "mt-2.5 rounded-2xl px-4 py-1",
          tone === "automatic" ? "bg-brand-mint-soft/45" : "border border-border-subtle",
        )}
      >
        {rows.length > 0 ? (
          rows.map((row, index) => (
            <Fragment key={row.key}>
              <ProfileSheetRowView
                row={row}
                active={row.field?.key === activeFieldKey}
                recentlySaved={row.field?.key === recentlySavedKey}
                submitting={submitting}
                teaser={teaser}
                companyId={companyId}
                profileWriteAllowed={profileWriteAllowed}
                canEditProfile={canEditProfile}
                onEdit={onEdit}
                onCancel={onCancel}
                onSubmit={(answer) => onSubmit(row, answer)}
              />
              {index < rows.length - 1 ? (
                <Separator className={tone === "automatic" ? "bg-brand-mint/15" : "bg-border-subtle"} />
              ) : null}
            </Fragment>
          ))
        ) : (
          <p className="py-3 text-sm text-muted-foreground">
            {tone === "automatic" ? "자동으로 확인된 정보가 아직 없어요." : "직접 채울 정보가 없어요."}
          </p>
        )}
      </div>
    </section>
  );
}

function ProfileSheetRowView({
  row,
  active,
  recentlySaved,
  submitting,
  teaser,
  companyId,
  profileWriteAllowed,
  canEditProfile,
  onEdit,
  onCancel,
  onSubmit,
}: {
  row: ProfileSheetRow;
  active: boolean;
  recentlySaved: boolean;
  submitting: boolean;
  teaser: ProductTeaserResult;
  companyId: string | null | undefined;
  profileWriteAllowed: boolean;
  canEditProfile: boolean;
  onEdit: (key: CriterionDimension) => void;
  onCancel: () => void;
  onSubmit: (answer: MatchingProfileAnswerRequest) => Promise<void>;
}) {
  const field = row.field;

  if (row.state === "automatic" && !active) {
    return (
      <div className="flex min-h-11 items-center gap-2.5 py-2.5">
        <Check className="size-3.5 shrink-0 text-brand-mint" strokeWidth={3} aria-hidden />
        <span className="w-[82px] shrink-0 text-[13px] text-text-secondary">{row.label}</span>
        <span className="min-w-0 flex-1 text-sm font-semibold text-ink break-words">{row.value}</span>
        {row.sourceLabel || row.field?.status === "partial" ? (
          <span className="max-w-20 shrink-0 truncate text-[11px] text-text-tertiary">
            {row.field?.status === "partial" ? `${row.sourceLabel ?? "저장된 정보"} · 일부 확인` : row.sourceLabel}
          </span>
        ) : null}
        {field?.editMode === "direct" && (canEditProfile || field.key === "premises") ? (
          <Button type="button" size="xs" variant="ghost" disabled={submitting} onClick={() => onEdit(field.key)}>
            {canEditProfile ? "확인·수정" : "보기"}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "py-3",
        active && "-mx-4 bg-brand-tint/35 px-4",
        recentlySaved && !active && "-mx-4 bg-brand-mint-soft px-4",
      )}
    >
      <div className="flex items-center gap-2.5">
        {row.state !== "missing" ? (
          <CircleDot className="size-3 shrink-0 text-brand" aria-label="직접 입력됨" />
        ) : (
          <CircleDashed className="size-3 shrink-0 text-text-tertiary" aria-label="미입력" />
        )}
        <span className="w-[82px] shrink-0 text-[13px] text-text-secondary">{row.label}</span>

        {row.state !== "missing" ? (
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-ink break-words">{row.value}</div>
            <div className={cn("text-[11px]", recentlySaved ? "font-bold text-brand-mint-ink" : "text-text-tertiary")}>
              {recentlySaved ? "방금 반영됨" : row.sourceLabel ?? "직접 입력"}
            </div>
          </div>
        ) : field?.editMode === "direct" && (canEditProfile || field.key === "premises") ? (
          <Button
            type="button"
            size="xs"
            variant="link"
            className="h-auto px-0"
            disabled={submitting}
            onClick={() => onEdit(field.key)}
          >
            <Plus data-icon="inline-start" strokeWidth={3} />
            {canEditProfile ? "채우기" : "보기"}
          </Button>
        ) : (
          <span className="text-xs font-medium text-muted-foreground">{field?.action.label ?? "확인 필요"}</span>
        )}

        {row.state === "direct" && field?.editMode === "direct" && !active && (canEditProfile || field.key === "premises") ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={submitting}
            onClick={() => onEdit(field.key)}
          >
            {canEditProfile ? "수정" : "보기"}
          </Button>
        ) : null}
      </div>

      {field ? <p className="mt-1 pl-[22px] text-xs text-muted-foreground">{PROFILE_INPUT_STATE_LABELS[row.inputState]}</p> : null}

      {active && field ? (
        <div className="mt-2 pl-[22px]">
          {field.key === "premises" ? (
            <PremisesInputPanel
              key={companyId ?? "anonymous"}
              initialValue={field.premisesValue ?? null}
              readOnly={!profileWriteAllowed}
              {...(!companyId ? { readOnlyMessage: "로그인해 회사를 저장하거나 선택한 뒤 등록 사업장 정보를 입력할 수 있습니다." } : {})}
              submitting={submitting}
              onCancel={onCancel}
              onSubmit={onSubmit}
            />
          ) : (
            <ProfileInputPanel
              field={field}
              submitting={submitting}
              onCancel={onCancel}
              onSubmit={onSubmit}
            />
          )}
        </div>
      ) : row.state === "missing" ? (
        <p className="mt-1 pl-[22px] text-xs leading-5 text-text-tertiary">
          {profileFieldImpactCopy(row, teaser)}
        </p>
      ) : null}
    </div>
  );
}

function ProfileVerificationGroup({
  teaser,
  canEditProfile,
  onOpenDisqualification,
  onOpenPriorAward,
}: {
  teaser: ProductTeaserResult;
  canEditProfile: boolean;
  onOpenDisqualification: () => void;
  onOpenPriorAward: () => void;
}) {
  const disqConfirmed = disqualificationAllKnown(teaser);
  const priorConfirmed = profileRowStatus(teaser, "prior_award") === "known";
  const unverified = (disqConfirmed ? 0 : 1) + (priorConfirmed ? 0 : 1);

  return (
    <section className="mt-6">
      <h3 className="text-[13.5px] font-extrabold text-text-nav">직접 확인해주세요 ({unverified})</h3>
      <div className="mt-2.5 flex flex-col gap-2">
        <VerificationRow
          label="결격 여부"
          confirmed={disqConfirmed}
          confirmedLabel="답변 확인됨 ✓"
          subtitle={disqualificationImpactCopy(teaser)}
          disabled={!canEditProfile}
          onClick={onOpenDisqualification}
        />
        <VerificationRow
          label="지원사업 수혜 이력"
          confirmed={priorConfirmed}
          confirmedLabel="확인됨 ✓"
          subtitle={priorAwardImpactCopy(teaser)}
          disabled={!canEditProfile}
          onClick={onOpenPriorAward}
        />
      </div>
    </section>
  );
}

function VerificationRow({
  label,
  confirmed,
  confirmedLabel,
  subtitle,
  disabled,
  onClick,
}: {
  label: string;
  confirmed: boolean;
  confirmedLabel: string;
  subtitle: string;
  disabled: boolean;
  onClick: () => void;
}) {
  if (confirmed) {
    return (
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        onClick={onClick}
        className="flex h-auto w-full items-center gap-2.5 rounded-[14px] bg-brand-mint-soft px-4 py-3 hover:bg-brand-mint-soft"
      >
        <Check className="size-3.5 shrink-0 text-brand-mint" strokeWidth={3} aria-hidden />
        <span className="flex-1 text-left text-[13.5px] font-bold text-ink">{label}</span>
        <span className="text-[12.5px] font-bold text-brand-mint-ink">{confirmedLabel}</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      className="flex h-auto w-full flex-col items-stretch gap-1 rounded-[14px] border border-border-card bg-card px-4 py-3 whitespace-normal hover:bg-surface-soft"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex-1 text-left text-sm font-semibold text-ink">{label}</span>
        <Badge className="bg-surface-muted text-[11.5px] font-bold text-text-secondary">확인 전</Badge>
        <ChevronRight className="size-4 shrink-0 text-text-quaternary" aria-hidden />
      </div>
      <span className="text-left text-[12px] leading-5 text-text-tertiary">{subtitle}</span>
    </Button>
  );
}

/** 결격 행 부제 — 실제 필수·배제 미확인 공고가 있을 때만 자격 판정 영향을 약속한다. */
function disqualificationImpactCopy(teaser: ProductTeaserResult): string {
  const affected = hardUnknownGrantCount(teaser, DISQUALIFICATION_AXES);
  return affected > 0
    ? `공고 ${affected.toLocaleString("ko-KR")}건의 필수 결격조건 판정에 필요한 정보예요`
    : "새 공고의 결격조건 확인에 활용할 수 있어요";
}

function priorAwardImpactCopy(teaser: ProductTeaserResult): string {
  const hardAffected = hardUnknownGrantCount(teaser, ["prior_award"]);
  if (hardAffected > 0) {
    return `공고 ${hardAffected.toLocaleString("ko-KR")}건의 신청 자격 판정에 필요한 정보예요`;
  }
  const preferredAffected = new Set(teaser.matches
    .filter((match) => match.ruleTrace.some((trace) =>
      trace.dimension === "prior_award"
      && trace.kind === "preferred"
      && (trace.result === "unknown" || trace.result === "text_only")))
    .map((match) => match.grantId)).size;
  return preferredAffected > 0
    ? `공고 ${preferredAffected.toLocaleString("ko-KR")}건의 우대점수 확인에 활용할 수 있어요`
    : "새 공고의 수혜 이력 조건 확인에 활용할 수 있어요";
}

function hardUnknownGrantCount(
  teaser: ProductTeaserResult,
  dimensions: readonly CriterionDimension[],
): number {
  const dimensionSet = new Set<CriterionDimension>(dimensions);
  return new Set(teaser.matches
    .filter((match) => match.ruleTrace.some((trace) =>
      dimensionSet.has(trace.dimension)
      && (trace.kind === "required" || trace.kind === "exclusion")
      && (trace.result === "unknown" || trace.result === "text_only")))
    .map((match) => match.grantId)).size;
}

export function buildProfileSheetRows(
  teaser: ProductTeaserResult,
  fields: ProfileFieldView[],
  answers: readonly MatchingProfileAnswerRequest[],
): ProfileSheetRow[] {
  const fieldMap = new Map(fields.map((field) => [field.key, field]));
  const rows: ProfileSheetRow[] = [];
  const companyName = teaser.companyEvidence?.fields.find(
    (field) => field.key === "corp_name" && field.available && Boolean(field.value?.trim()),
  );

  if (companyName?.value) {
    const sourceLabel = companyEvidenceSourceLabel(teaser);
    rows.push({
      key: "corp_name",
      label: "상호",
      value: companyName.value,
      sourceLabel,
      state: sourceLabel?.includes("직접") ? "direct" : "automatic",
      inputState: sourceLabel?.includes("직접") ? "entered" : "automatic",
      field: null,
    });
  }

  for (const spec of PROFILE_SHEET_DIMENSIONS) {
    const field = fieldMap.get(spec.key);
    if (!field) continue;
    rows.push({
      key: field.key,
      label: spec.label,
      value: field.value,
      sourceLabel: field.sourceLabel,
      state: profileSheetValueState(field),
      inputState: profileInputState(teaser.profileView.rows.find((row) => row.dimension === field.key), answers),
      field,
    });
  }

  return rows;
}

function companyEvidenceSourceLabel(teaser: ProductTeaserResult): string | null {
  const evidence = teaser.companyEvidence;
  if (!evidence) return null;
  if (evidence.provider === "popbill") return "사업자 기본정보";
  if (evidence.provider === "apick") return "기업 기본정보";
  if (evidence.provider === "manual") return "직접 입력";
  if (evidence.provider === "sample") return "예시 정보";
  return "저장된 정보";
}

function profileFieldImpactCopy(row: ProfileSheetRow, teaser: ProductTeaserResult): string {
  if (
    row.field &&
    teaser.nextQuestion?.dimension === row.field.key &&
    teaser.nextQuestion.affectedGrantCount > 0
  ) {
    return `공고 ${teaser.nextQuestion.affectedGrantCount.toLocaleString("ko-KR")}건 판정에 영향`;
  }
  if (row.key === "revenue") return "매출 기준 공고 판정에 반영돼요";
  if (row.key === "employees") return "고용 인원 기준 공고 판정에 반영돼요";
  if (row.key === "founder_age") return "청년 대상 공고 판정에 반영돼요";
  if (row.key === "certification") return "준비하면 열리는 공고를 확인할 수 있어요";
  if (row.key === "premises") {
    const affected = hardUnknownGrantCount(teaser, ["premises"]);
    return affected > 0
      ? `공고 ${affected.toLocaleString("ko-KR")}건의 등록 사업장 조건 확인에 필요해요`
      : "등록 사업장 조건이 있는 공고 판정에만 반영돼요";
  }
  if (row.key === "region") return "지역 조건이 있는 공고 판정에 반영돼요";
  if (row.key === "industry") return "업종 조건이 있는 공고 판정에 반영돼요";
  if (row.key === "biz_age") return "업력 조건이 있는 공고 판정에 반영돼요";
  return "공고 자격 판정에 반영돼요";
}

function ProfileInputPanel({
  field,
  submitting,
  onCancel,
  onSubmit,
}: {
  field: ProfileFieldView;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (answer: MatchingProfileAnswerRequest) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProfileInputDraft>(() => initialProfileInputDraft(field.key, field.value));
  const [error, setError] = useState<string | null>(null);
  const suggestions = profileInputSuggestions(field.key);
  const sourceHelp = profileSourceHelp(field);
  const usesStructuredNumericInput =
    field.key === "biz_age" ||
    field.key === "founder_age" ||
    field.key === "employees" ||
    field.key === "revenue";

  useEffect(() => {
    setDraft(initialProfileInputDraft(field.key, field.value));
    setError(null);
  }, [field.key, field.value]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = buildProfileAnswer(field.key, draft);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    await submitAnswer(result.answer);
  }

  async function submitAnswer(answer: MatchingProfileAnswerRequest) {
    setError(null);
    try { await onSubmit(answer); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "반영하지 못했어요. 다시 시도해주세요."); }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-2 pt-1">
        <Field data-invalid={Boolean(error)}>
          {usesStructuredNumericInput ? (
            <StructuredNumericProfileInput
              fieldKey={field.key}
              draft={draft}
              error={Boolean(error)}
              onChange={setDraft}
            />
          ) : (
            <Combobox
              items={suggestions}
              value={draft.value}
              onValueChange={(value) => {
                if (typeof value === "string") {
                  setDraft((current) => ({ ...current, value }));
                }
              }}
            >
              <ComboboxInput
                aria-label={profileFieldDisplayLabel(field)}
                aria-invalid={Boolean(error)}
                autoFocus
                className="w-full"
                inputMode={profileInputMode(field.key)}
                placeholder={profileInputPlaceholder(field.key)}
                showClear
                value={draft.value}
                onChange={(event) => {
                  const next = profileInputText(field.key, event.currentTarget.value);
                  setDraft((current) => ({ ...current, value: next }));
                }}
              />
              <ComboboxContent>
                <ComboboxEmpty>직접 입력 후 매칭 결과에 반영</ComboboxEmpty>
                <ComboboxList>
                  {(item) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          )}
          <FieldError>{error}</FieldError>
          <FieldDescription className="text-xs leading-5">
            {profileInputDescription(field.key)}
          </FieldDescription>
          {sourceHelp ? (
            <FieldDescription className="text-xs leading-5">
              {sourceHelp.source} · {sourceHelp.asOf}<br />
              {sourceHelp.message}{" "}
              <a href={sourceHelp.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                정보 정정 문의 (새 탭)
              </a>
            </FieldDescription>
          ) : null}
        </Field>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {field.status === "unknown" ? (
            <Button type="button" size="xs" variant="ghost" disabled={submitting}
              onClick={() => void submitAnswer({ field: field.key, unknown: true })}>모르겠어요</Button>
          ) : null}
          {field.key === "certification" ? (
            <Button type="button" size="xs" variant="outline" disabled={submitting}
              onClick={() => void submitAnswer({ field: field.key, value: [], mode: "replace" })}>보유 인증 없음</Button>
          ) : null}
          <Button type="button" size="xs" variant="ghost" onClick={onCancel} disabled={submitting}>
            취소
          </Button>
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "반영 중" : "답변 반영"}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}

function StructuredNumericProfileInput({
  fieldKey,
  draft,
  error,
  onChange,
}: {
  fieldKey: string;
  draft: ProfileInputDraft;
  error: boolean;
  onChange: React.Dispatch<React.SetStateAction<ProfileInputDraft>>;
}) {
  if (fieldKey === "revenue") {
    return (
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_88px] gap-2">
        <Input
          aria-invalid={error}
          autoFocus
          inputMode="decimal"
          placeholder={profileInputPlaceholder(fieldKey)}
          value={draft.value}
          className="h-8 min-w-0 rounded-lg px-3 py-1 text-sm shadow-none"
          onChange={(event) => {
            const next = decimalNumberText(event.currentTarget.value);
            onChange((current) => ({ ...current, value: next }));
          }}
        />
        <Select
          value={draft.unit}
          onValueChange={(value) =>
            onChange((current) => ({ ...current, unit: toRevenueUnit(value) }))
          }
        >
          <SelectTrigger aria-label="연 매출 단위" size="sm" className="h-8 w-full rounded-lg px-3 text-sm">
            <SelectValue>{(value) => revenueUnitLabel(toRevenueUnit(value))}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {REVENUE_UNIT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (fieldKey === "biz_age" || fieldKey === "bizAge") {
    return (
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <NumericSuffixInput
          ariaInvalid={error}
          autoFocus
          placeholder="8"
          suffix="년"
          value={draft.value}
          onValueChange={(next) => onChange((current) => ({ ...current, value: digitsOnly(next) }))}
        />
        <NumericSuffixInput
          ariaInvalid={error}
          placeholder="4"
          suffix="개월"
          value={draft.secondaryValue}
          onValueChange={(next) => onChange((current) => ({ ...current, secondaryValue: digitsOnly(next) }))}
        />
      </div>
    );
  }

  return (
    <NumericSuffixInput
      ariaInvalid={error}
      autoFocus
      placeholder={profileInputPlaceholder(fieldKey)}
      suffix={fieldKey === "founder_age" ? "년생" : "명"}
      value={draft.value}
      onValueChange={(next) => onChange((current) => ({ ...current, value: profileInputText(fieldKey, next) }))}
    />
  );
}

function NumericSuffixInput({
  ariaInvalid,
  autoFocus,
  placeholder,
  suffix,
  value,
  onValueChange,
}: {
  ariaInvalid: boolean;
  autoFocus?: boolean;
  placeholder: string;
  suffix: string;
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="relative min-w-0">
      <Input
        aria-invalid={ariaInvalid}
        autoFocus={autoFocus}
        inputMode="numeric"
        placeholder={placeholder}
        value={value}
        className={cn("h-8 min-w-0 rounded-lg py-1 pl-3 text-sm shadow-none", suffix.length >= 2 ? "pr-14" : "pr-9")}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      />
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm font-medium text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}
