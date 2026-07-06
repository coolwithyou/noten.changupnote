import type {
  ApplicationPrep,
  ApplySheet,
  BenefitBadge,
  DocumentDraft,
  PlanDraftPrompt,
  ProfileCopyField,
  RequiredDocument,
  RuleTraceChip,
  SourceAttachment,
  SupportAmount,
} from "@cunote/contracts";
import { Download, Paperclip } from "lucide-react";
import { appHeaderLinks } from "@/components/app/app-navigation";
import { MetricCard } from "@/components/app/metric-card";
import { ServiceHeader } from "@/components/app/service-header";
import type { HeaderUser } from "@/lib/server/auth/session";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApplyLink } from "./ApplyLink";
import { DocumentDraftWorkspace } from "./DocumentDraftWorkspace";
import { GrantLessonGuide } from "@/features/knowledge/GrantLessonGuide";
import { FieldLessonTips } from "@/features/knowledge/FieldLessonTips";
import type { GrantDocumentFormField } from "@/lib/server/documents/grantDocumentFields";
import type { FieldLessonTipsDto, GrantLessonGuideDto } from "@/lib/server/knowledge/lessonContext";

export function ApplySheetView({
  sheet,
  user = null,
  initialDrafts = [],
  formFields = [],
  lessonGuide = null,
  fieldLessonTips = null,
}: {
  sheet: ApplySheet;
  user?: HeaderUser | null;
  initialDrafts?: DocumentDraft[];
  formFields?: GrantDocumentFormField[];
  lessonGuide?: GrantLessonGuideDto | null;
  fieldLessonTips?: FieldLessonTipsDto | null;
}) {
  const dDayLabel = formatDday(sheet.schedule.dDay);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <ServiceHeader user={user} links={appHeaderLinks()} />

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <section className="grid gap-4 rounded-[var(--radius-xl)] border bg-card p-6 shadow-[var(--shadow-subtle)] lg:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">신청 준비 시트</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal sm:text-3xl">{sheet.grant.title}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{sheet.grant.agency ?? "운영기관 확인 필요"}</p>
        </div>
        <aside className="grid gap-2 rounded-[var(--radius-xl)] border bg-muted/30 p-4">
          <SummaryRow label="상태" value={grantStatusLabel(sheet.grant.status)} />
          <SummaryRow label="마감" value={dDayLabel} emphasis={sheet.schedule.dDay !== null && sheet.schedule.dDay <= 14} />
          <SummaryRow label="지원금" value={formatSupportAmount(sheet.grant.supportAmount)} />
        </aside>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="접수 기간" value={formatDateRange(sheet.schedule.applyStart, sheet.schedule.applyEnd)} />
        <MetricCard label="접수 방법" value={sheet.applyMethod ?? "원문 확인"} />
        <Card size="sm">
          <CardContent className="grid gap-2">
            <span className="text-sm text-muted-foreground">신청 링크</span>
            {sheet.deepLink ? (
              <ApplyLink href={sheet.deepLink} grantId={sheet.grant.id} />
            ) : (
              <strong className="text-lg font-semibold">원문 확인 필요</strong>
            )}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="grid gap-2">
            <span className="text-sm text-muted-foreground">받을 수 있는 것</span>
            <BenefitBadgeList benefits={sheet.grant.benefits} />
          </CardContent>
        </Card>
      </section>

      <ApplicationPrepSection
        grantId={sheet.grant.id}
        prep={sheet.applicationPrep}
        initialDrafts={initialDrafts}
        formFields={formFields}
        fieldLessonTips={fieldLessonTips}
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <ChecklistSection
          title="이미 충족"
          description="회사 정보로 자동 충족된 필수 조건입니다."
          items={sheet.satisfied}
          emptyText="자동 충족으로 확인된 조건이 없습니다."
        />
        <ChecklistSection
          title="확인 필요"
          description="입력하면 확정 또는 제외할 수 있는 조건입니다."
          items={sheet.needsCheck}
          emptyText="추가 입력이 필요한 조건이 없습니다."
        />
        <DocumentSection documents={sheet.documents} sourceAttachments={sheet.sourceAttachments} />
      </section>

      {lessonGuide ? <GrantLessonGuide guide={lessonGuide} /> : null}
      </div>
    </main>
  );
}

function ApplicationPrepSection({
  grantId,
  prep,
  initialDrafts,
  formFields,
  fieldLessonTips,
}: {
  grantId: string;
  prep: ApplicationPrep;
  initialDrafts: DocumentDraft[];
  formFields: GrantDocumentFormField[];
  fieldLessonTips: FieldLessonTipsDto | null;
}) {
  return (
    <Card id="application-prep">
      <CardHeader className="gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <span className="text-xs font-medium uppercase text-muted-foreground">지원서 준비</span>
          <CardTitle className="mt-1 text-lg">필요 서류와 AI 초안</CardTitle>
          <CardDescription className="mt-1">접수는 각 포털에서 진행하고, 아래 초안은 신청서 작성 재료로만 사용합니다.</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/web/grants/${encodeURIComponent(grantId)}/package?format=attachments`}
            title="원문 첨부, R2 보관본, 변환 Markdown manifest 내려받기"
          >
            <Paperclip className="size-3.5" aria-hidden />
            첨부 묶음
          </a>
          <a
            className={buttonVariants({ variant: "outline", size: "sm" })}
            href={`/api/web/grants/${encodeURIComponent(grantId)}/package`}
            title="정규화 서류, 첨부 링크, 저장된 초안을 Markdown으로 내려받기"
          >
            <Download className="size-3.5" aria-hidden />
            패키지 내보내기
          </a>
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        <PreparationGroupSection prep={prep} />
        <DocumentDraftWorkspace
          grantId={grantId}
          prep={prep}
          initialDrafts={initialDrafts}
          fieldLessonTips={fieldLessonTips}
        />
        <FormFieldMappingSection fields={formFields} fieldLessonTips={fieldLessonTips} />
        <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-label="복붙 프로필" size="sm">
          <CardContent className="grid gap-3">
          <h3 className="text-base font-semibold">복붙 프로필</h3>
          <div className="grid gap-2">
            {prep.profileCopyFields.map((field) => (
              <ProfileCopyItem key={`${field.source}:${field.label}`} field={field} />
            ))}
            {prep.profileCopyFields.length === 0 ? (
              <Empty className="panel-empty">
                <EmptyDescription>복사할 회사 프로필 정보가 아직 없습니다.</EmptyDescription>
              </Empty>
            ) : null}
          </div>
          </CardContent>
        </Card>
        <Card aria-label="사업계획서 초안" size="sm">
          <CardContent className="grid gap-3">
          <h3 className="text-base font-semibold">초안 프롬프트</h3>
          <div className="grid gap-2">
            {prep.planDraftPrompts.map((prompt) => (
              <PlanDraftItem key={prompt.title} prompt={prompt} />
            ))}
          </div>
          </CardContent>
        </Card>
        </div>
      </CardContent>
    </Card>
  );
}

function PreparationGroupSection({ prep }: { prep: ApplicationPrep }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2" aria-label="문서 준비 방식">
      {prep.documentGroups.map((group) => (
        <section className="rounded-[var(--radius-xl)] border bg-muted/30 p-4" key={group.preparationType}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <span className="text-xs font-medium uppercase text-muted-foreground">문서 준비 방식</span>
              <h3 className="mt-1 text-base font-semibold">{group.label}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{group.description}</p>
            </div>
            <StatusBadge tone={preparationTypeTone(group.preparationType)}>
              {group.documents.length.toLocaleString("ko-KR")}개
            </StatusBadge>
          </div>
          <div className="mt-4 grid gap-2">
            {group.documents.map((document) => (
              <div
                className="grid gap-2 rounded-[var(--radius-lg)] border bg-card p-3 sm:grid-cols-[auto_minmax(0,1fr)]"
                key={`${group.preparationType}:${document.name}:${document.sourceAttachment ?? document.sourceSpan ?? document.source}`}
              >
                <StatusBadge tone={document.required ? "warning" : "neutral"}>
                  {document.required ? "필수" : "선택"}
                </StatusBadge>
                <div>
                  <strong className="block text-sm font-semibold">{document.canonicalName ?? document.name}</strong>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {documentCategoryLabel(document.category ?? "other")}
                    {" · "}
                    {document.sourceAttachment ?? document.sourceSpan ?? sourceLabel(document.source)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {prep.documentGroups.length === 0 ? (
        <Empty className="panel-empty">
          <EmptyDescription>분류된 준비 서류가 아직 없습니다.</EmptyDescription>
        </Empty>
      ) : null}
    </div>
  );
}

function FormFieldMappingSection({
  fields,
  fieldLessonTips,
}: {
  fields: GrantDocumentFormField[];
  fieldLessonTips: FieldLessonTipsDto | null;
}) {
  const autoFillCount = fields.filter((field) => field.fillStrategy !== "manual").length;
  const requiredCount = fields.filter((field) => field.required).length;
  const tipsByLabel = fieldLessonTips?.byLabel ?? {};

  return (
    <Card aria-label="원문 양식 필드 매핑" size="sm">
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <span className="text-xs font-medium uppercase text-muted-foreground">원문 양식</span>
            <h3 className="mt-1 text-base font-semibold">필드 매핑</h3>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">첨부 양식에서 추출한 항목과 자동채움 전략입니다.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={fields.length > 0 ? "brand" : "neutral"}>
              필드 {fields.length.toLocaleString("ko-KR")}
            </StatusBadge>
            <StatusBadge tone={autoFillCount > 0 ? "success" : "neutral"}>
              자동 {autoFillCount.toLocaleString("ko-KR")}
            </StatusBadge>
            <StatusBadge tone={requiredCount > 0 ? "warning" : "neutral"}>
              필수 {requiredCount.toLocaleString("ko-KR")}
            </StatusBadge>
          </div>
        </div>
        {fields.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>문서</TableHead>
                <TableHead>필드</TableHead>
                <TableHead>자동채움</TableHead>
                <TableHead>근거</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fields.slice(0, 12).map((field) => (
                <TableRow key={`${field.documentName}:${field.fieldKey}:${field.label}`}>
                  <TableCell>
                    <strong>{field.documentName}</strong>
                    <span>{field.sourceAttachment ?? documentCategoryLabel(field.documentCategory)}</span>
                  </TableCell>
                  <TableCell>
                    <div className="grid gap-1">
                      <strong>{field.label}</strong>
                      <span>{field.section ?? fieldTypeLabel(field.fieldType)}</span>
                      {tipsByLabel[field.label]?.length ? (
                        <FieldLessonTips tips={tipsByLabel[field.label]!} />
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={fillStrategyTone(field.fillStrategy)}>
                      {fillStrategyLabel(field)}
                    </StatusBadge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.sourceSpan ?? (field.required ? "필수 항목" : "원문 확인")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty className="panel-empty">
            <EmptyDescription>
              저장된 원문 양식 필드 매핑이 없습니다. 첨부 Markdown 재추출 후 매핑이 표시됩니다.
            </EmptyDescription>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileCopyItem({ field }: { field: ProfileCopyField }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-1">
      <span className="text-xs text-muted-foreground">{field.label}</span>
      <strong className="text-sm font-semibold">{field.value}</strong>
      </CardContent>
    </Card>
  );
}

function PlanDraftItem({ prompt }: { prompt: PlanDraftPrompt }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-2">
      <h4 className="text-sm font-semibold">{prompt.title}</h4>
      <p className="text-sm leading-6 text-muted-foreground">{prompt.prompt}</p>
      <ul className="ml-4 list-disc text-sm text-muted-foreground">
        {prompt.evidence.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      </CardContent>
    </Card>
  );
}

function BenefitBadgeList({ benefits }: { benefits: BenefitBadge[] }) {
  if (benefits.length === 0) return <strong>혜택 확인 필요</strong>;

  return (
    <div className="flex flex-wrap gap-1.5">
      {benefits.map((benefit) => (
        <StatusBadge key={benefit.family} tone="brand">{benefit.label}</StatusBadge>
      ))}
    </div>
  );
}

function ChecklistSection({
  title,
  description,
  items,
  emptyText,
}: {
  title: string;
  description: string;
  items: RuleTraceChip[];
  emptyText: string;
}) {
  return (
    <Card>
      <CardHeader>
        <span className="text-xs font-medium uppercase text-muted-foreground">체크리스트</span>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {items.map((item) => (
          <TraceItem key={`${item.dimension}-${item.kind}-${item.label}`} item={item} />
        ))}
        {items.length === 0 ? (
          <Empty className="panel-empty">
            <EmptyDescription>{emptyText}</EmptyDescription>
          </Empty>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TraceItem({ item }: { item: RuleTraceChip }) {
  return (
    <Card size="sm">
      <CardContent className="grid gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <StatusBadge tone={traceTone(item.result)}>
          {traceResultLabel(item.result)}
        </StatusBadge>
        <h3 className="flex-1 text-sm font-semibold">{item.label}</h3>
      </div>
      {item.companyValue || item.sourceSpan ? (
        <p className="text-sm leading-6 text-muted-foreground">{item.companyValue ? `회사값 ${item.companyValue}` : item.sourceSpan}</p>
      ) : null}
      {item.unlock ? (
        <p className="text-sm leading-6 text-muted-foreground">
          {item.unlock.detail}{item.unlock.etaDate ? ` · ${formatEtaDate(item.unlock.etaDate)}` : ""}
        </p>
      ) : null}
      {item.action ? <StatusBadge tone="brand">{item.action.label}</StatusBadge> : null}
      </CardContent>
    </Card>
  );
}

function DocumentSection({
  documents,
  sourceAttachments,
}: {
  documents: RequiredDocument[];
  sourceAttachments: SourceAttachment[];
}) {
  return (
    <Card>
      <CardHeader>
        <span className="text-xs font-medium uppercase text-muted-foreground">서류와 원문</span>
        <CardTitle className="text-lg">준비 서류</CardTitle>
        <CardDescription>명확히 추출된 서류와 자동 판정이 어려운 원문 확인 항목입니다.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {documents.map((document) => (
          <Card key={`${document.name}-${document.sourceSpan ?? document.source}`} size="sm">
            <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div>
              <StatusBadge tone={document.required ? "warning" : "neutral"}>{document.required ? "필수" : "선택"}</StatusBadge>
              <h3 className="mt-2 text-sm font-semibold">{document.name}</h3>
              {document.sourceSpan || document.note ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{document.sourceSpan ?? document.note}</p> : null}
            </div>
            <strong className="text-sm">{document.fromTextOnly ? "원문 확인" : sourceLabel(document.source)}</strong>
            </CardContent>
          </Card>
        ))}
        {sourceAttachments.map((attachment) => (
          <Card key={`${attachment.filename}-${attachment.url ?? attachment.sourceUri ?? "file"}`} size="sm">
            <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div>
              <StatusBadge tone="brand">첨부</StatusBadge>
              <h3 className="mt-2 text-sm font-semibold">{attachment.filename}</h3>
              {attachment.sourceUri && attachment.sourceUri !== attachment.url ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{attachment.sourceUri}</p> : null}
            </div>
            <AttachmentActions attachment={attachment} />
            </CardContent>
          </Card>
        ))}
        {documents.length === 0 && sourceAttachments.length === 0 ? (
          <Empty className="panel-empty">
            <EmptyDescription>공식 공고문에서 필요 서류가 명확히 추출되지 않았습니다.</EmptyDescription>
          </Empty>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AttachmentActions({ attachment }: { attachment: SourceAttachment }) {
  const archiveUrl = attachment.archiveUrl ?? attachment.url;
  const sourceUrl = attachment.sourceUri ?? (attachment.archiveUrl ? attachment.url : null);
  const links = [
    archiveUrl ? { href: archiveUrl, label: "보관본" } : null,
    sourceUrl && sourceUrl !== archiveUrl ? { href: sourceUrl, label: "원문" } : null,
    attachment.markdownUrl ? { href: attachment.markdownUrl, label: "Markdown" } : null,
  ].filter((item): item is { href: string; label: string } => Boolean(item));

  if (links.length === 0) return <strong>원문 확인</strong>;

  return (
    <div className="flex flex-wrap gap-2 sm:justify-end">
      {links.map((link) => (
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href={link.href} key={`${link.label}:${link.href}`} target="_blank" rel="noreferrer">
          {link.label}
        </a>
      ))}
    </div>
  );
}

function fieldTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    text: "단문",
    long_text: "장문",
    number: "숫자",
    date: "날짜",
    currency: "금액",
    checkbox: "체크",
    table: "표",
    file: "파일",
    unknown: "확인",
  };
  return labels[value] ?? value;
}

function fillStrategyLabel(field: GrantDocumentFormField): string {
  if (field.fillStrategy === "copy") return field.mappedCompanyField ? "프로필 복사" : "복사";
  if (field.fillStrategy === "summarize") return "요약";
  if (field.fillStrategy === "generate") return "AI 작성";
  if (field.fillStrategy === "ask_user") return "입력 필요";
  return "수동 확인";
}

function fillStrategyTone(strategy: GrantDocumentFormField["fillStrategy"]) {
  if (strategy === "copy" || strategy === "summarize") return "success";
  if (strategy === "generate") return "brand";
  if (strategy === "ask_user") return "warning";
  return "neutral";
}

function preparationTypeTone(value: ApplicationPrep["documentGroups"][number]["preparationType"]) {
  if (value === "write") return "brand";
  if (value === "issue") return "success";
  if (value === "attach") return "warning";
  return "neutral";
}

function documentCategoryLabel(value: string): string {
  const labels: Record<string, string> = {
    application_form: "신청서",
    business_plan: "사업계획서",
    proposal_or_intro: "제안서/소개서",
    consent_or_pledge: "동의서/확약서",
    business_registration: "사업자등록증",
    corporate_register: "법인등기",
    company_confirmation: "기업확인서",
    financial_tax: "재무/세무",
    employment_insurance: "고용보험",
    shareholder: "주주/지분",
    bank_account: "통장 사본",
    estimate_budget: "견적/예산",
    portfolio_catalog: "포트폴리오",
    ip_certification: "지식재산/인증",
    recommendation: "추천서",
    performance_evidence: "실적 증빙",
    other: "기타",
  };
  return labels[value] ?? value;
}

function SummaryRow({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={emphasis ? "flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-primary/20 bg-primary/10 px-3 py-2" : "flex items-center justify-between gap-3 rounded-[var(--radius-lg)] border bg-card px-3 py-2"}>
      <span className="text-sm text-muted-foreground">{label}</span>
      <strong className="text-sm font-semibold">{label === "상태" ? <StatusBadge tone={value === "접수중" ? "success" : value === "예정" ? "warning" : "neutral"}>{value}</StatusBadge> : value}</strong>
    </div>
  );
}

function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감 확인";
  if (value === 0) return "오늘 마감";
  return `D-${value}`;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "일정 확인";
  if (!start) return `${end} 마감`;
  if (!end) return `${start} 시작`;
  return `${start} - ${end}`;
}

function formatEtaDate(value: string): string {
  return value.replaceAll("-", ".");
}

function grantStatusLabel(status: ApplySheet["grant"]["status"]): string {
  if (status === "open") return "접수중";
  if (status === "upcoming") return "예정";
  if (status === "closed") return "마감";
  return "확인 필요";
}

function traceResultLabel(result: RuleTraceChip["result"]): string {
  if (result === "pass") return "충족";
  if (result === "unknown") return "확인";
  if (result === "text_only") return "원문";
  return "미충족";
}

function traceTone(result: RuleTraceChip["result"]) {
  if (result === "pass") return "success";
  if (result === "fail") return "danger";
  if (result === "text_only") return "brand";
  return "warning";
}

function sourceLabel(source: RequiredDocument["source"]): string {
  if (source === "cert") return "발급";
  if (source === "self") return "직접 준비";
  return "포털 확인";
}
