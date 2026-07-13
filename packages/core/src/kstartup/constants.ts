export const KSTARTUP_SOURCE = "kstartup" as const;
export const KSTARTUP_API_ENDPOINT =
  "https://nidapi.k-startup.go.kr/api/kisedKstartupService/v1/getAnnouncementInformation";
// v3: 결격 축(v2)에 긍정 industry criterion → f_industries projection을 추가.
export const KSTARTUP_NORMALIZER_VERSION = "kstartup-field-parser-v3";

export const REGION_CODES: Record<string, string> = {
  "서울": "11",
  "부산": "26",
  "대구": "27",
  "인천": "28",
  "광주": "29",
  "대전": "30",
  "울산": "31",
  "세종": "36",
  "경기": "41",
  "강원": "42",
  "충북": "43",
  "충남": "44",
  "전북": "45",
  "전남": "46",
  "경북": "47",
  "경남": "48",
  "제주": "50",
};

export const REGION_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(REGION_CODES).map(([label, code]) => [code, label]),
);

export const METRO_REGION_CODES = ["11", "28", "41"] as const;

export const TEXT_HINTS = {
  size: /중소기업|중견|소상공인|상시근로자|매출|대기업/,
  industry: /제조|업종|분야|소재|부품|장비|바이오|콘텐츠|ICT|소프트웨어|SW|딥테크|로봇|패션|AI|디지털|SaaS|해양/,
  certification: /벤처기업|이노비즈|메인비즈|연구소|전담부서|특허|인증/,
  priorAwardOrBadStanding: /중복|기존.*선정|참여제한|체납|채무불이행|휴.?폐업|부도|제재/,
} as const;
