import { LegalPage, type LegalSection } from "@/features/legal/LegalPage";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import {
  getLegalConfig,
  type LegalConfig,
  type LegalOverseasTransferDisclosure,
  type LegalProcessorDisclosure,
} from "@/lib/server/legal/legalConfig";

function buildSections(input: LegalConfig): LegalSection[] {
  return [
  {
    title: "처리하는 개인정보",
    body: [
      `${input.serviceName}는 계정 운영을 위해 이메일, 이름, 로그인 제공자 정보를 처리할 수 있습니다. 회사 매칭을 위해 사용자가 입력한 사업자번호, 회사명, 소재지, 업종, 매출, 고용, 인증, 기수혜 정보가 처리될 수 있습니다.`,
      "사업자 검증과 회사정보 보강을 사용하면 대표자명, 개업일, 사업자 상태 확인 결과, 조회 증적과 캐시 상태가 함께 저장될 수 있습니다.",
    ],
  },
  {
    title: "처리 목적",
    body: [
      "개인정보와 회사 관련 정보는 계정 식별, 회사 접근 권한 관리, 지원사업 매칭, 로드맵 생성, 신청 준비 자료 작성, 알림 발송, 고객지원, 보안 감사 목적으로 사용됩니다.",
      "AI 초안 기능은 사용자가 선택한 공고와 회사 프로필을 기반으로 초안 문장을 생성하고, 누락 정보와 검토 필요 항목을 표시하는 데 사용됩니다.",
    ],
  },
  {
    title: "보유와 삭제",
    body: [
      input.retentionSummary,
      "법령상 보존 의무, 분쟁 대응, 보안 사고 조사에 필요한 정보는 해당 목적에 필요한 기간 동안 분리 보관될 수 있습니다.",
    ],
  },
  {
    title: "제3자 제공과 위탁",
    body: [
      `${input.operatorName}는 사용자의 동의 또는 법령상 근거 없이 개인정보를 외부에 판매하지 않습니다.`,
      "로그인, 데이터베이스, 파일 저장, 사업자 검증, 알림, AI 처리 등 서비스 운영에 필요한 외부 인프라와 API를 사용할 수 있습니다.",
      formatProcessors(input.privacyProcessors),
    ],
  },
  {
    title: "국외이전",
    body: [
      formatOverseasTransfers(input.overseasTransfers),
      "국외이전이 추가되거나 이전 국가, 항목, 보유 기간이 바뀌면 본 처리방침 또는 서비스 화면에 반영합니다.",
    ],
  },
  {
    title: "사용자 권리",
    body: [
      "사용자는 본인 정보 열람, 정정, 삭제, 처리 정지, 동의 철회를 요청할 수 있습니다. 로그인한 사용자는 내 계정의 데이터 내보내기에서 계정, 회사 접근 권한, 동의, 알림, 고객지원 기록을 JSON 파일로 받을 수 있습니다.",
      "회사 소속과 권한이 연결된 정보는 보안 확인과 회사 권한 검토 후 처리될 수 있습니다.",
    ],
  },
  {
    title: "안전성 조치",
    body: [
      "서비스는 회사 단위 접근 제어, 세션 관리, RLS 정책, 감사 이벤트, 최소 권한 원칙을 통해 데이터 분리를 유지합니다.",
      "외부 첨부 파일과 AI 초안 데이터는 서비스 제공 목적에 필요한 범위에서만 처리하며, 접근 권한과 저장 위치를 분리해 관리합니다.",
    ],
  },
  {
    title: "문의와 권리 행사",
    body: [
      `개인정보보호책임자: ${input.privacyOfficerName}`,
      `개인정보 문의처: ${input.privacyEmail}`,
      "사용자는 설정 페이지, 계정 데이터 내보내기, 계정 이메일, 고객지원 티켓을 통해 개인정보 열람, 정정, 삭제, 처리 정지, 동의 철회를 요청할 수 있습니다.",
    ],
  },
  ];
}

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  const user = await getOptionalHeaderUser();
  const config = getLegalConfig();
  return (
    <LegalPage
      user={user}
      eyebrow="개인정보 처리방침"
      title="창업노트 개인정보 처리방침"
      description="계정, 회사 정보, 매칭과 신청 준비 과정에서 처리되는 정보를 설명합니다."
      effectiveDate={config.effectiveDate}
      version={config.privacyVersion}
      summary={[
        { label: "처리자", value: config.operatorName },
        { label: "개인정보보호책임자", value: config.privacyOfficerName },
        { label: "개인정보 문의", value: config.privacyEmail },
        { label: "주소", value: config.businessAddress ?? "서비스 설정에서 고지" },
      ]}
      sections={buildSections(config)}
    />
  );
}

function formatProcessors(processors: LegalProcessorDisclosure[]): string {
  if (processors.length === 0) {
    return "현재 환경에 등록된 수탁사 목록이 없습니다. 운영 환경에서 외부 위탁이 확정되면 수탁사, 목적, 국가, 보유 기간을 설정해 고지합니다.";
  }

  return `수탁사: ${processors.map((processor) => [
    processor.name,
    processor.purpose,
    processor.country ? `국가 ${processor.country}` : null,
    processor.retention ? `보유 ${processor.retention}` : null,
  ].filter(Boolean).join(" · ")).join(" / ")}`;
}

function formatOverseasTransfers(transfers: LegalOverseasTransferDisclosure[]): string {
  if (transfers.length === 0) {
    return "현재 환경에 등록된 국외이전 항목이 없습니다. 운영 환경에서 국외 이전이 확정되면 이전받는 자, 국가, 목적, 항목, 보유 기간을 설정해 고지합니다.";
  }

  return `국외이전 항목: ${transfers.map((transfer) => [
    transfer.recipient,
    `국가 ${transfer.country}`,
    `목적 ${transfer.purpose}`,
    `항목 ${transfer.transferredItems}`,
    transfer.retention ? `보유 ${transfer.retention}` : null,
    transfer.contact ? `문의 ${transfer.contact}` : null,
  ].filter(Boolean).join(" · ")).join(" / ")}`;
}
