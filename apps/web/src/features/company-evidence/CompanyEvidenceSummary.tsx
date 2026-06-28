import type { CompanyEvidence } from "@cunote/contracts";
import { StatusBadge } from "@/components/app/status-badge";
import { Card, CardContent } from "@/components/ui/card";

export function CompanyEvidenceSummary({
  evidence,
  privacyNote,
  compact = false,
  prominent = false,
}: {
  evidence: CompanyEvidence;
  privacyNote?: string;
  compact?: boolean;
  prominent?: boolean;
}) {
  const companyName = evidenceFieldValue(evidence, "corp_name");
  const region = evidenceFieldValue(evidence, "region");
  const businessStatus = evidenceFieldValue(evidence, "business_status");
  const visibleFields = evidence.fields
    .filter((field) => field.available && field.value)
    .filter((field) => companyName ? field.key !== "corp_name" : true)
    .slice(0, compact ? 4 : 6);
  const checkedAt = formatEvidenceDate(evidence.checkedAt);
  const cachedUntil = formatEvidenceDate(evidence.cachedUntil);
  const className = [
    "company-evidence-card",
    compact ? "compact" : null,
    prominent ? "prominent" : null,
  ].filter(Boolean).join(" ");

  return (
    <Card className={className} size="sm">
      <CardContent>
        <div className="company-evidence-header">
          <div>
            <span className="eyebrow">사업자 정보 확인</span>
            <h3>{headline(evidence, companyName)}</h3>
          </div>
          <StatusBadge tone={evidence.provider === "popbill" ? "success" : "neutral"}>
            {cacheLabel(evidence)}
          </StatusBadge>
        </div>

        {companyName ? (
          <div className="company-evidence-identity" aria-label="확인된 회사">
            <strong>{companyName}</strong>
            <span>{[region, businessStatus].filter(Boolean).join(" · ") || "사업자 정보 확인됨"}</span>
          </div>
        ) : null}

        <p className="company-evidence-summary">{evidence.summary}</p>

        <div className="company-evidence-meta" aria-label="사업자 정보 조회 상태">
          {evidence.maskedBizNo ? <span>사업자번호 {evidence.maskedBizNo}</span> : null}
          {evidence.resultMessage ? <span>결과 {evidence.resultMessage}</span> : null}
          {checkedAt ? <time dateTime={evidence.checkedAt ?? undefined}>조회 {checkedAt}</time> : null}
          {cachedUntil ? <time dateTime={evidence.cachedUntil ?? undefined}>캐시 만료 {cachedUntil}</time> : null}
        </div>

        {visibleFields.length > 0 ? (
          <dl className="company-evidence-fields">
            {visibleFields.map((field) => (
              <div key={field.key}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {privacyNote ? <p className="company-evidence-privacy">{privacyNote}</p> : null}
      </CardContent>
    </Card>
  );
}

function headline(evidence: CompanyEvidence, companyName: string | null): string {
  if (companyName && evidence.source === "popbill_cache") return `${companyName} 정보를 바로 확인했어요`;
  if (companyName && evidence.source === "popbill_live") return `팝빌에서 ${companyName}을 확인했어요`;
  if (companyName) return `${companyName} 기준으로 계산했어요`;
  if (evidence.source === "popbill_cache") return "저장된 팝빌 조회 결과로 회사 정보를 확인했어요";
  if (evidence.source === "popbill_live") return "팝빌에서 사업자 정보를 확인했어요";
  if (evidence.source === "manual_profile") return "직접 입력한 정보로 계산했어요";
  if (evidence.source === "sample_profile") return "샘플 정보로 계산했어요";
  return "저장된 회사 정보로 계산했어요";
}

function cacheLabel(evidence: CompanyEvidence): string {
  if (evidence.cacheStatus === "hit") return "저장 결과 재사용";
  if (evidence.cacheStatus === "stored") return "다음 조회 저장됨";
  if (evidence.provider === "popbill") return "팝빌 조회";
  if (evidence.provider === "manual") return "수기 입력";
  if (evidence.provider === "sample") return "샘플";
  return "저장 정보";
}

function evidenceFieldValue(evidence: CompanyEvidence, key: string): string | null {
  return evidence.fields.find((field) => field.key === key && field.available && field.value)?.value ?? null;
}

function formatEvidenceDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
