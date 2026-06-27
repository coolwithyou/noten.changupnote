import type {
  ApplicationPrep,
  ApplySheet,
  BenefitBadge,
  PlanDraftPrompt,
  ProfileCopyField,
  RequiredDocument,
  RuleTraceChip,
  SourceAttachment,
  SupportAmount,
} from "@cunote/contracts";
import { ApplyLink } from "./ApplyLink";

export function ApplySheetView({ sheet }: { sheet: ApplySheet }) {
  const dDayLabel = formatDday(sheet.schedule.dDay);

  return (
    <main className="apply-shell">
      <header className="dashboard-nav">
        <a className="brand-mark" href="/" aria-label="창업노트 홈">
          <span className="brand-symbol" aria-hidden="true">C</span>
          <span>창업노트</span>
        </a>
        <nav>
          <a href="/dashboard">기회 맵</a>
          <a href="/roadmap">로드맵</a>
          <a href="/internal/live-match">내부 검증</a>
        </nav>
      </header>

      <section className="apply-hero">
        <div>
          <p className="eyebrow">신청 준비 시트</p>
          <h1>{sheet.grant.title}</h1>
          <p>{sheet.grant.agency ?? "운영기관 확인 필요"}</p>
        </div>
        <aside className="apply-summary">
          <SummaryRow label="상태" value={grantStatusLabel(sheet.grant.status)} />
          <SummaryRow label="마감" value={dDayLabel} emphasis={sheet.schedule.dDay !== null && sheet.schedule.dDay <= 14} />
          <SummaryRow label="지원금" value={formatSupportAmount(sheet.grant.supportAmount)} />
        </aside>
      </section>

      <section className="apply-overview">
        <div className="apply-overview-card">
          <span>접수 기간</span>
          <strong>{formatDateRange(sheet.schedule.applyStart, sheet.schedule.applyEnd)}</strong>
        </div>
        <div className="apply-overview-card">
          <span>접수 방법</span>
          <strong>{sheet.applyMethod ?? "원문 확인"}</strong>
        </div>
        <div className="apply-overview-card action">
          <span>신청 링크</span>
          {sheet.deepLink ? (
            <ApplyLink href={sheet.deepLink} grantId={sheet.grant.id} />
          ) : (
            <strong>원문 확인 필요</strong>
          )}
        </div>
        <div className="apply-overview-card">
          <span>받을 수 있는 것</span>
          <BenefitBadgeList benefits={sheet.grant.benefits} />
        </div>
      </section>

      <ApplicationPrepSection prep={sheet.applicationPrep} />

      <section className="apply-grid">
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
    </main>
  );
}

function ApplicationPrepSection({ prep }: { prep: ApplicationPrep }) {
  return (
    <section className="apply-panel application-prep-panel">
      <div className="panel-heading">
        <span className="eyebrow">지원서 준비</span>
        <h2>복붙 프로필과 사업계획서 초안</h2>
        <p>접수는 각 포털에서 진행하고, 아래 정보는 신청서 작성 재료로만 사용합니다.</p>
      </div>
      <div className="application-prep-grid">
        <section className="profile-copy-panel" aria-label="복붙 프로필">
          <h3>복붙 프로필</h3>
          <div className="profile-copy-list">
            {prep.profileCopyFields.map((field) => (
              <ProfileCopyItem key={`${field.source}:${field.label}`} field={field} />
            ))}
            {prep.profileCopyFields.length === 0 ? (
              <p className="panel-empty">복사할 회사 프로필 정보가 아직 없습니다.</p>
            ) : null}
          </div>
        </section>
        <section className="plan-draft-panel" aria-label="사업계획서 초안">
          <h3>초안 프롬프트</h3>
          <div className="plan-draft-list">
            {prep.planDraftPrompts.map((prompt) => (
              <PlanDraftItem key={prompt.title} prompt={prompt} />
            ))}
          </div>
        </section>
      </div>
    </section>
  );
}

function ProfileCopyItem({ field }: { field: ProfileCopyField }) {
  return (
    <article className="profile-copy-item">
      <span>{field.label}</span>
      <strong>{field.value}</strong>
    </article>
  );
}

function PlanDraftItem({ prompt }: { prompt: PlanDraftPrompt }) {
  return (
    <article className="plan-draft-item">
      <h4>{prompt.title}</h4>
      <p>{prompt.prompt}</p>
      <ul>
        {prompt.evidence.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

function BenefitBadgeList({ benefits }: { benefits: BenefitBadge[] }) {
  if (benefits.length === 0) return <strong>혜택 확인 필요</strong>;

  return (
    <div className="benefit-badge-list">
      {benefits.map((benefit) => (
        <strong key={benefit.family}>{benefit.label}</strong>
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
    <section className="apply-panel">
      <div className="panel-heading">
        <span className="eyebrow">체크리스트</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="checklist-list">
        {items.map((item) => (
          <TraceItem key={`${item.dimension}-${item.kind}-${item.label}`} item={item} />
        ))}
        {items.length === 0 ? <p className="panel-empty">{emptyText}</p> : null}
      </div>
    </section>
  );
}

function TraceItem({ item }: { item: RuleTraceChip }) {
  return (
    <article className={`trace-item ${item.result}`}>
      <div>
        <span className="trace-kind">{traceResultLabel(item.result)}</span>
        <h3>{item.label}</h3>
      </div>
      {item.companyValue || item.sourceSpan ? (
        <p>{item.companyValue ? `회사값 ${item.companyValue}` : item.sourceSpan}</p>
      ) : null}
      {item.unlock ? (
        <p className="trace-unlock">
          {item.unlock.detail}{item.unlock.etaDate ? ` · ${formatEtaDate(item.unlock.etaDate)}` : ""}
        </p>
      ) : null}
      {item.action ? <strong>{item.action.label}</strong> : null}
    </article>
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
    <section className="apply-panel documents-panel">
      <div className="panel-heading">
        <span className="eyebrow">서류와 원문</span>
        <h2>준비 서류</h2>
        <p>명확히 추출된 서류와 자동 판정이 어려운 원문 확인 항목입니다.</p>
      </div>
      <div className="document-list">
        {documents.map((document) => (
          <article className="document-item" key={`${document.name}-${document.sourceSpan ?? document.source}`}>
            <div>
              <span>{document.required ? "필수" : "선택"}</span>
              <h3>{document.name}</h3>
              {document.sourceSpan || document.note ? <p>{document.sourceSpan ?? document.note}</p> : null}
            </div>
            <strong>{document.fromTextOnly ? "원문 확인" : sourceLabel(document.source)}</strong>
          </article>
        ))}
        {sourceAttachments.map((attachment) => (
          <article className="document-item" key={`${attachment.filename}-${attachment.url ?? attachment.sourceUri ?? "file"}`}>
            <div>
              <span>첨부</span>
              <h3>{attachment.filename}</h3>
              {attachment.sourceUri && attachment.sourceUri !== attachment.url ? <p>{attachment.sourceUri}</p> : null}
            </div>
            {attachment.url ? (
              <a href={attachment.url} target="_blank" rel="noreferrer">열기</a>
            ) : (
              <strong>원문 확인</strong>
            )}
          </article>
        ))}
        {documents.length === 0 && sourceAttachments.length === 0 ? (
          <p className="panel-empty">공식 공고문에서 필요 서류가 명확히 추출되지 않았습니다.</p>
        ) : null}
      </div>
    </section>
  );
}

function SummaryRow({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className={emphasis ? "summary-row emphasis" : "summary-row"}>
      <span>{label}</span>
      <strong>{value}</strong>
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

function sourceLabel(source: RequiredDocument["source"]): string {
  if (source === "cert") return "발급";
  if (source === "self") return "직접 준비";
  return "포털 확인";
}
