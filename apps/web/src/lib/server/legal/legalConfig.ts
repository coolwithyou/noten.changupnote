export interface LegalConfig {
  serviceName: string;
  operatorName: string;
  supportEmail: string;
  privacyEmail: string;
  privacyOfficerName: string;
  businessRegistrationNumber: string | null;
  businessAddress: string | null;
  mailOrderRegistrationNumber: string | null;
  effectiveDate: string;
  termsVersion: string;
  privacyVersion: string;
  retentionSummary: string;
  privacyProcessors: LegalProcessorDisclosure[];
  overseasTransfers: LegalOverseasTransferDisclosure[];
}

export interface LegalProcessorDisclosure {
  name: string;
  purpose: string;
  country: string | null;
  retention: string | null;
}

export interface LegalOverseasTransferDisclosure {
  recipient: string;
  country: string;
  purpose: string;
  transferredItems: string;
  retention: string | null;
  contact: string | null;
}

export function getLegalConfig(sourceEnv: NodeJS.ProcessEnv = process.env): LegalConfig {
  const supportEmail = env("CUNOTE_SUPPORT_EMAIL", sourceEnv)
    ?? env("NEXT_PUBLIC_SUPPORT_EMAIL", sourceEnv)
    ?? "support@changupnote.com";
  const privacyEmail = env("CUNOTE_PRIVACY_EMAIL", sourceEnv) ?? supportEmail;

  return {
    serviceName: env("NEXT_PUBLIC_SERVICE_NAME", sourceEnv) ?? "창업노트",
    operatorName: env("CUNOTE_LEGAL_OPERATOR_NAME", sourceEnv) ?? "창업노트 운영팀",
    supportEmail,
    privacyEmail,
    privacyOfficerName: env("CUNOTE_PRIVACY_OFFICER_NAME", sourceEnv) ?? "개인정보 보호책임자",
    businessRegistrationNumber: env("CUNOTE_BUSINESS_REGISTRATION_NUMBER", sourceEnv),
    businessAddress: env("CUNOTE_BUSINESS_ADDRESS", sourceEnv),
    mailOrderRegistrationNumber: env("CUNOTE_MAIL_ORDER_REGISTRATION_NUMBER", sourceEnv),
    effectiveDate: env("CUNOTE_LEGAL_EFFECTIVE_DATE", sourceEnv) ?? "2026년 6월 28일",
    termsVersion: env("CUNOTE_TERMS_VERSION", sourceEnv) ?? "v1.0",
    privacyVersion: env("CUNOTE_PRIVACY_VERSION", sourceEnv) ?? "v1.0",
    retentionSummary: env("CUNOTE_PRIVACY_RETENTION_SUMMARY", sourceEnv)
      ?? "계정과 회사 정보는 서비스 이용 기간 동안 보관하며, 삭제 요청 또는 계약 종료 후 운영상 필요한 보존 기간이 지나면 파기합니다.",
    privacyProcessors: parseProcessors(env("CUNOTE_PRIVACY_PROCESSORS", sourceEnv)),
    overseasTransfers: parseOverseasTransfers(env("CUNOTE_PRIVACY_OVERSEAS_TRANSFERS", sourceEnv)),
  };
}

function env(key: string, sourceEnv: NodeJS.ProcessEnv): string | null {
  const value = sourceEnv[key]?.trim();
  return value ? value : null;
}

function parseProcessors(value: string | null): LegalProcessorDisclosure[] {
  return parseRows(value)
    .map((columns) => ({
      name: columns[0] ?? "",
      purpose: columns[1] ?? "",
      country: optional(columns[2]),
      retention: optional(columns[3]),
    }))
    .filter((entry) => entry.name && entry.purpose);
}

function parseOverseasTransfers(value: string | null): LegalOverseasTransferDisclosure[] {
  return parseRows(value)
    .map((columns) => ({
      recipient: columns[0] ?? "",
      country: columns[1] ?? "",
      purpose: columns[2] ?? "",
      transferredItems: columns[3] ?? "",
      retention: optional(columns[4]),
      contact: optional(columns[5]),
    }))
    .filter((entry) => entry.recipient && entry.country && entry.purpose && entry.transferredItems);
}

function parseRows(value: string | null): string[][] {
  if (!value) return [];
  return value
    .split(";")
    .map((row) => row.split("|").map((column) => column.trim()))
    .filter((columns) => columns.some(Boolean));
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}
