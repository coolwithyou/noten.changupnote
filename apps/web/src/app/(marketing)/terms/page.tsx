import { LegalPage, type LegalSection } from "@/features/legal/LegalPage";
import { getOptionalHeaderUser } from "@/lib/server/auth/session";
import { getLegalConfig, type LegalConfig } from "@/lib/server/legal/legalConfig";

function buildSections(input: LegalConfig): LegalSection[] {
  return [
  {
    title: "서비스의 목적",
    body: [
      `${input.serviceName}는 회사 정보와 공개 지원사업 공고를 대조해 사용자가 검토할 수 있는 지원사업, 준비 서류, 일정, 신청 준비 자료를 정리해 주는 업무형 SaaS입니다.`,
      "서비스가 제공하는 매칭, 적합도, 초안, 체크리스트는 의사결정을 돕는 정보이며, 선정 가능성이나 지원금 수령을 보장하지 않습니다.",
    ],
  },
  {
    title: "계정과 회사 데이터",
    body: [
      "사용자는 본인 또는 권한을 가진 회사 정보만 등록해야 합니다. 회사 소유권 검증, 구성원 권한, 동의 상태는 서비스 내 데이터 접근 범위를 정하는 기준이 됩니다.",
      "사용자가 입력하거나 연결한 회사 정보가 부정확하면 매칭 결과와 신청 준비 자료도 부정확할 수 있습니다.",
    ],
  },
  {
    title: "지원사업 정보",
    body: [
      "지원사업 공고는 외부 기관의 공개 자료와 첨부 문서를 기반으로 수집, 변환, 표준화됩니다. 원문 변경, 기관 정정, 접수 조기 마감 등으로 서비스 화면과 실제 공고가 달라질 수 있습니다.",
      "신청 전에는 반드시 해당 기관의 공고 원문, 첨부 양식, 접수 포털 조건을 최종 확인해야 합니다.",
    ],
  },
  {
    title: "AI 초안과 자동채움",
    body: [
      "AI 초안과 자동채움 기능은 회사 프로필, 공고 정보, 제출서류 taxonomy를 기반으로 작성 재료를 생성합니다. 제출 전 사용자 검토와 수정이 필요합니다.",
      "사용자는 허위 정보, 타인의 영업비밀, 민감정보, 제출 권한이 없는 자료를 입력하거나 제출해서는 안 됩니다.",
    ],
  },
  {
    title: "요금과 유료 전환",
    body: [
      "현재 유료 플랜 전환은 서비스 내 플랜 전환 요청 또는 고객지원 상담을 통해 접수됩니다. 카드 정보와 결제 수단은 결제 provider가 연결되기 전까지 서비스가 직접 수집하지 않습니다.",
      "유료 계약, 청구 주기, 좌석 수, 세금계산서 발행 조건은 별도 합의 또는 서비스 화면에서 확정된 조건을 따릅니다.",
    ],
  },
  {
    title: "고객지원과 통지",
    body: [
      `서비스 이용, 권한, 개인정보, 오류 신고는 ${input.supportEmail} 또는 고객지원 티켓으로 접수할 수 있습니다.`,
      `${input.operatorName}는 중요한 약관 변경, 보안 알림, 서비스 운영 변경 사항을 계정 이메일, 서비스 화면, 고객지원 채널 중 적절한 수단으로 안내할 수 있습니다.`,
    ],
  },
  {
    title: "운영자 정보",
    body: [
      `운영자: ${input.operatorName}`,
      `문의처: ${input.supportEmail}`,
      `사업자등록번호: ${input.businessRegistrationNumber ?? "운영 환경 설정 전"}`,
      `통신판매업 신고번호: ${input.mailOrderRegistrationNumber ?? "운영 환경 설정 전"}`,
      `주소: ${input.businessAddress ?? "운영 환경 설정 전"}`,
    ],
  },
  {
    title: "이용 제한",
    body: [
      "서비스 안정성, 보안, 제3자의 권리를 해치는 이용은 제한될 수 있습니다. 자동화된 과도한 요청, 무단 크롤링, 계정 공유, 허위 회사 등록은 금지됩니다.",
      "운영자는 보안 사고 예방과 법령 준수를 위해 필요한 범위에서 이용을 일시 제한하거나 추가 확인을 요청할 수 있습니다.",
    ],
  },
  {
    title: "책임의 범위",
    body: [
      "서비스는 지원사업 탐색과 신청 준비의 효율을 높이기 위한 도구입니다. 지원사업 선정 여부, 기관 심사 결과, 제출 지연, 외부 포털 장애에 대해서는 사용자가 최종 책임을 집니다.",
      "관련 법령상 책임을 배제할 수 없는 경우를 제외하고, 서비스 운영자는 사용자가 원문 공고와 제출 조건을 확인하지 않아 발생한 손해에 대해 책임지지 않습니다.",
    ],
  },
  ];
}

export const dynamic = "force-dynamic";

export default async function TermsPage() {
  const user = await getOptionalHeaderUser();
  const config = getLegalConfig();
  return (
    <LegalPage
      user={user}
      eyebrow="이용약관"
      title="창업노트 서비스 이용약관"
      description="지원사업 매칭, 신청 준비, AI 초안 기능을 사용할 때 적용되는 기본 조건입니다."
      effectiveDate={config.effectiveDate}
      version={config.termsVersion}
      summary={[
        { label: "운영자", value: config.operatorName },
        { label: "문의처", value: config.supportEmail },
        { label: "사업자등록번호", value: config.businessRegistrationNumber ?? "서비스 설정에서 고지" },
        { label: "주소", value: config.businessAddress ?? "서비스 설정에서 고지" },
      ]}
      sections={buildSections(config)}
    />
  );
}
