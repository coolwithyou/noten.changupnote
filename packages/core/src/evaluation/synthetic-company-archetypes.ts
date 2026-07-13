import type { CompanyProfile } from "@cunote/contracts";
import type { V3CompanyAnnotation } from "./v3-annotations.js";

const TAX_FLAGS = ["national_tax_delinquent", "local_tax_delinquent", "customs_delinquent", "social_insurance_delinquent"];
const CREDIT_FLAGS = ["credit_delinquency", "loan_default", "bond_default", "rehabilitation_in_progress", "bankruptcy_filed", "court_receivership", "financial_misconduct", "asset_seizure", "guarantee_restricted"];
const SANCTION_FLAGS = ["participation_restricted", "subsidy_fraud", "subsidy_law_violation", "obligation_breach", "wage_arrears_listed", "serious_accident_listed", "agreement_breach"];

const INDUSTRY_SPECS = [
  { labels: ["소프트웨어", "인공지능"], codes: ["62010", "62", "J"], certs: ["벤처기업확인"] },
  { labels: ["식품제조", "제조업"], codes: ["10799", "10", "C"], certs: ["HACCP"] },
  { labels: ["패션", "의류제조"], codes: ["14199", "14", "C"], certs: [] },
  { labels: ["바이오", "의약품제조"], codes: ["21102", "21", "C"], certs: ["기업부설연구소"] },
  { labels: ["전자상거래", "소매업"], codes: ["47912", "47", "G"], certs: [] },
  { labels: ["농업", "스마트팜"], codes: ["01159", "01", "A"], certs: ["농업경영체"] },
  { labels: ["물류", "창고업"], codes: ["52109", "52", "H"], certs: [] },
  { labels: ["콘텐츠", "영상제작"], codes: ["59114", "59", "J"], certs: [] },
  { labels: ["관광", "여행서비스"], codes: ["75290", "75", "N"], certs: ["관광사업등록"] },
  { labels: ["신재생에너지", "전기업"], codes: ["35114", "35", "D"], certs: ["기업부설연구소"] },
  { labels: ["건설업", "전문공사"], codes: ["41229", "41", "F"], certs: ["건설업등록"] },
  { labels: ["연구개발", "전문서비스"], codes: ["70119", "70", "M"], certs: ["기업부설연구소"] },
  { labels: ["수산업", "양식업"], codes: ["03211", "03", "A"], certs: ["수산업경영체"] },
  { labels: ["로봇", "기계제조"], codes: ["29280", "29", "C"], certs: ["벤처기업확인"] },
  { labels: ["화장품", "화학제품제조"], codes: ["20423", "20", "C"], certs: ["화장품제조업등록"] },
] as const;

const REGIONS = [
  ["11", "서울"], ["26", "부산"], ["27", "대구"], ["28", "인천"], ["29", "광주"],
  ["30", "대전"], ["31", "울산"], ["41", "경기"], ["42", "강원"], ["43", "충북"],
  ["44", "충남"], ["45", "전북"], ["46", "전남"], ["47", "경북"], ["48", "경남"],
] as const;

export function buildSyntheticCompanyArchetypes(): V3CompanyAnnotation[] {
  return Array.from({ length: 30 }, (_, index) => buildCompany(index));
}

function buildCompany(index: number): V3CompanyAnnotation {
  const businessKind = index < 15 ? "individual" : "corporation";
  const slot = index % 15;
  const industry = INDUSTRY_SPECS[slot]!;
  const region = REGIONS[(slot * 7 + (businessKind === "corporation" ? 3 : 0)) % REGIONS.length]!;
  const ages = [6, 12, 18, 24, 36, 48, 60, 72, 84, 96, 120, 144, 180, 216, 240];
  const size = slot % 5 === 0 ? "소상공인" : slot % 5 <= 2 ? "소기업" : slot % 5 === 3 ? "중소기업" : "중견기업";
  const employees = size === "소상공인" ? 2 + (slot % 3) : size === "소기업" ? 6 + slot : size === "중소기업" ? 35 + slot * 2 : 180 + slot * 5;
  const revenue = size === "소상공인" ? 120_000_000 + slot * 20_000_000
    : size === "소기업" ? 700_000_000 + slot * 100_000_000
      : size === "중소기업" ? 5_000_000_000 + slot * 500_000_000
        : 80_000_000_000 + slot * 2_000_000_000;
  const companyId = `seed-${businessKind}-${String(slot + 1).padStart(2, "0")}`;
  const profile: CompanyProfile = {
    id: companyId,
    region: { code: region[0], label: region[1] },
    biz_age_months: ages[slot]!,
    founder_age: 24 + ((slot * 3 + (businessKind === "corporation" ? 5 : 0)) % 32),
    is_preliminary: false,
    industries: [...industry.labels],
    industry_codes: [...industry.codes],
    size,
    revenue_krw: revenue,
    employees_count: employees,
    traits: slot % 6 === 0 ? ["청년"] : slot % 7 === 0 ? ["여성기업"] : [],
    certs: [...industry.certs],
    prior_awards: slot % 8 === 0 ? ["지역창업지원사업"] : [],
    ip: slot % 4 === 0 ? ["특허"] : [],
    target_types: [businessKind === "individual" ? "개인사업자" : "법인사업자", ages[slot]! <= 84 ? "창업기업" : "중소기업"],
    list_completeness: {
      industry: "complete", certification: "complete", founder_trait: "complete",
      prior_award: "complete", ip: "complete", target_type: "complete",
    },
    business_status: { active: true, label: "계속사업자" },
    tax_compliance: {
      flags: slot === 5 ? ["national_tax_delinquent"] : [],
      known_flags: [...TAX_FLAGS],
      exceptions: slot === 5 && businessKind === "corporation" ? ["payment_deferral_approved"] : [],
    },
    credit_status: {
      flags: slot === 8 ? ["loan_default"] : [],
      known_flags: [...CREDIT_FLAGS],
      exceptions: [],
    },
    sanction: {
      flags: slot === 12 ? ["participation_restricted"] : [],
      known_flags: [...SANCTION_FLAGS],
      exceptions: [],
    },
    financial_health: {
      debt_ratio_pct: 60 + slot * 35,
      impairment: slot === 14 ? "partial" : "none",
      interest_coverage_ratio: slot === 13 ? 0.7 : 1.5 + slot * 0.2,
      total_assets_krw: Math.round(revenue * 1.2),
      equity_krw: Math.round(revenue * 0.45),
      capital_krw: Math.round(revenue * 0.2),
      fiscal_year: "2025",
    },
    insured_workforce: {
      employment_insurance_active: true,
      insured_count: employees,
      no_layoff: slot !== 11,
      ...(slot === 11 ? { months_since_last_layoff: 3 } : {}),
    },
    investment: {
      total_raised_krw: slot % 5 === 0 ? 1_000_000_000 + slot * 100_000_000 : 0,
      last_round: slot % 5 === 0 ? "Seed" : null,
      tips_backed: slot === 0 || slot === 10,
    },
    confidence: Object.fromEntries([
      "region", "biz_age", "founder_age", "industry", "size", "revenue", "employees", "founder_trait",
      "certification", "prior_award", "ip", "target_type", "business_status", "tax_compliance",
      "credit_status", "sanction", "financial_health", "insured_workforce", "investment",
    ].map((dimension) => [dimension, 1])) as NonNullable<CompanyProfile["confidence"]>,
  };
  return {
    recordType: "company",
    schemaVersion: "matching-v3",
    companyId,
    businessKind,
    profile,
    sourceFixture: "synthetic:matching-v3-company-archetype-expanded-v1",
    labelStatus: "draft",
    annotatorId: null,
    reviewerId: null,
    annotatedAt: null,
    reviewedAt: null,
  };
}
