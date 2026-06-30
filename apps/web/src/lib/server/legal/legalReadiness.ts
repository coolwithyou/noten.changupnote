import { getLegalConfig } from "./legalConfig";

export type LegalReadinessStatus = "ready" | "attention";

export interface LegalReadinessItem {
  key: string;
  label: string;
  status: LegalReadinessStatus;
  detail: string;
  envKeys: string[];
}

export interface LegalReadiness {
  status: LegalReadinessStatus;
  statusLabel: string;
  score: number;
  configuredCount: number;
  requiredCount: number;
  missingKeys: string[];
  fallbackKeys: string[];
  summary: string;
  items: LegalReadinessItem[];
}

export function buildLegalReadiness(sourceEnv: NodeJS.ProcessEnv = process.env): LegalReadiness {
  const config = getLegalConfig(sourceEnv);
  const items: LegalReadinessItem[] = [
    item({
      key: "operator",
      label: "운영자",
      envKeys: ["CUNOTE_LEGAL_OPERATOR_NAME"],
      configured: hasEnv(sourceEnv, "CUNOTE_LEGAL_OPERATOR_NAME"),
      readyDetail: `${config.operatorName}로 운영자명이 설정되어 있습니다.`,
      attentionDetail: "운영자명이 기본값입니다. 배포 전 실제 법인/개인사업자명을 확정하세요.",
    }),
    item({
      key: "support-email",
      label: "고객지원 이메일",
      envKeys: ["CUNOTE_SUPPORT_EMAIL", "NEXT_PUBLIC_SUPPORT_EMAIL"],
      configured: hasAnyEnv(sourceEnv, ["CUNOTE_SUPPORT_EMAIL", "NEXT_PUBLIC_SUPPORT_EMAIL"]),
      readyDetail: `${config.supportEmail}로 고객지원 문의처가 설정되어 있습니다.`,
      attentionDetail: "고객지원 이메일이 기본값입니다. 운영 메일 수신함을 확정하세요.",
    }),
    item({
      key: "privacy-contact",
      label: "개인정보 문의처",
      envKeys: ["CUNOTE_PRIVACY_EMAIL", "CUNOTE_PRIVACY_OFFICER_NAME"],
      configured: hasEnv(sourceEnv, "CUNOTE_PRIVACY_EMAIL") && hasEnv(sourceEnv, "CUNOTE_PRIVACY_OFFICER_NAME"),
      readyDetail: `${config.privacyOfficerName} · ${config.privacyEmail}로 개인정보 문의처가 설정되어 있습니다.`,
      attentionDetail: "개인정보 보호책임자와 문의 이메일이 기본값 또는 일부 누락 상태입니다.",
    }),
    item({
      key: "business-disclosure",
      label: "사업자 고지",
      envKeys: ["CUNOTE_BUSINESS_REGISTRATION_NUMBER", "CUNOTE_BUSINESS_ADDRESS"],
      configured: Boolean(config.businessRegistrationNumber && config.businessAddress),
      readyDetail: "사업자등록번호와 주소가 약관/개인정보 처리방침에 반영됩니다.",
      attentionDetail: "사업자등록번호 또는 주소가 비어 있어 공개 법무 문서에 설정 전 문구가 표시됩니다.",
    }),
    item({
      key: "commerce-disclosure",
      label: "통신판매업 고지",
      envKeys: ["CUNOTE_MAIL_ORDER_REGISTRATION_NUMBER"],
      configured: hasEnv(sourceEnv, "CUNOTE_MAIL_ORDER_REGISTRATION_NUMBER"),
      readyDetail: "통신판매업 신고번호가 계정 export와 법무 config에 포함됩니다.",
      attentionDetail: "통신판매업 신고번호가 비어 있습니다. 해당 없음 여부까지 운영 정책으로 확인하세요.",
    }),
    item({
      key: "policy-versions",
      label: "정책 버전",
      envKeys: ["CUNOTE_LEGAL_EFFECTIVE_DATE", "CUNOTE_TERMS_VERSION", "CUNOTE_PRIVACY_VERSION"],
      configured: hasEnv(sourceEnv, "CUNOTE_LEGAL_EFFECTIVE_DATE")
        && hasEnv(sourceEnv, "CUNOTE_TERMS_VERSION")
        && hasEnv(sourceEnv, "CUNOTE_PRIVACY_VERSION"),
      readyDetail: `${config.effectiveDate} 기준 약관 ${config.termsVersion}, 개인정보 ${config.privacyVersion} 버전입니다.`,
      attentionDetail: "시행일 또는 정책 버전이 기본값입니다. 배포 버전과 DB 수락 이력을 맞추세요.",
    }),
    item({
      key: "retention",
      label: "보유 기간",
      envKeys: ["CUNOTE_PRIVACY_RETENTION_SUMMARY"],
      configured: hasEnv(sourceEnv, "CUNOTE_PRIVACY_RETENTION_SUMMARY"),
      readyDetail: "개인정보 보유/파기 요약이 환경값으로 설정되어 있습니다.",
      attentionDetail: "개인정보 보유/파기 요약이 기본 문구입니다. 실제 보존 정책을 확정하세요.",
    }),
    item({
      key: "processors",
      label: "수탁사/국외이전",
      envKeys: ["CUNOTE_PRIVACY_PROCESSORS", "CUNOTE_PRIVACY_OVERSEAS_TRANSFERS"],
      configured: hasEnv(sourceEnv, "CUNOTE_PRIVACY_PROCESSORS") && hasEnv(sourceEnv, "CUNOTE_PRIVACY_OVERSEAS_TRANSFERS"),
      readyDetail: `수탁사 ${config.privacyProcessors.length.toLocaleString("ko-KR")}건, 국외이전 ${config.overseasTransfers.length.toLocaleString("ko-KR")}건이 환경값으로 확정되어 있습니다.`,
      attentionDetail: "수탁사 또는 국외이전 환경값이 비어 있습니다. 해당 없음이면 운영 정책상 해당 없음 값을 별도로 확정하세요.",
    }),
  ];
  const configuredCount = items.filter((entry) => entry.status === "ready").length;
  const requiredCount = items.length;
  const score = Math.round((configuredCount / requiredCount) * 100);
  const missingKeys = items
    .filter((entry) => entry.status === "attention")
    .flatMap((entry) => entry.envKeys.filter((key) => !hasEnv(sourceEnv, key)));
  const fallbackKeys = items
    .filter((entry) => entry.status === "attention")
    .map((entry) => entry.key);
  const status: LegalReadinessStatus = configuredCount === requiredCount ? "ready" : "attention";

  return {
    status,
    statusLabel: status === "ready" ? "운영 확정" : "확인 필요",
    score,
    configuredCount,
    requiredCount,
    missingKeys,
    fallbackKeys,
    summary: status === "ready"
      ? "공개 법무 고지에 필요한 운영 환경값이 모두 설정되어 있습니다."
      : `공개 법무 고지 ${requiredCount - configuredCount}개 항목이 기본값 또는 미설정 상태입니다.`,
    items,
  };
}

function item(input: {
  key: string;
  label: string;
  envKeys: string[];
  configured: boolean;
  readyDetail: string;
  attentionDetail: string;
}): LegalReadinessItem {
  return {
    key: input.key,
    label: input.label,
    status: input.configured ? "ready" : "attention",
    detail: input.configured ? input.readyDetail : input.attentionDetail,
    envKeys: input.envKeys,
  };
}

function hasAnyEnv(sourceEnv: NodeJS.ProcessEnv, keys: string[]): boolean {
  return keys.some((key) => hasEnv(sourceEnv, key));
}

function hasEnv(sourceEnv: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(sourceEnv[key]?.trim());
}
