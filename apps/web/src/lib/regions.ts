export const KOREA_REGION_OPTIONS = [
  { code: "41", label: "경기" },
  { code: "11", label: "서울" },
  { code: "28", label: "인천" },
  { code: "26", label: "부산" },
  { code: "27", label: "대구" },
  { code: "30", label: "대전" },
  { code: "29", label: "광주" },
  { code: "31", label: "울산" },
  { code: "36", label: "세종" },
  { code: "42", label: "강원" },
  { code: "43", label: "충북" },
  { code: "44", label: "충남" },
  { code: "45", label: "전북" },
  { code: "46", label: "전남" },
  { code: "47", label: "경북" },
  { code: "48", label: "경남" },
  { code: "50", label: "제주" },
] as const;

export type KoreaRegionLabel = typeof KOREA_REGION_OPTIONS[number]["label"];

export const KOREA_REGION_CODE_BY_LABEL = Object.fromEntries(
  KOREA_REGION_OPTIONS.map((region) => [region.label, region.code]),
) as Record<KoreaRegionLabel, string>;

export function regionCodeForLabel(label: string): string | undefined {
  return KOREA_REGION_CODE_BY_LABEL[label as KoreaRegionLabel];
}
