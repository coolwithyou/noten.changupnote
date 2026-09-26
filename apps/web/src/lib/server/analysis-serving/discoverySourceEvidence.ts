import type { CompanyProfile, DiscoverySourceEvidence } from "@cunote/contracts";
import { getCunoteDb } from "@/lib/server/db/client";
import { prepareDeepAnalysisInput } from "@/lib/server/deep-analysis/prepareInput";
import type { DeepAnalysisInputSeal } from "@/lib/server/deep-analysis/inputManifest";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

/** Discovery 자료는 현재 DB/R2 원문만 읽는다. 미승격 분석과 legacy criterion은 사용하지 않는다. */
export async function loadDiscoverySourceEvidence(input: {
  grantId: string;
  sourceRevisionSha256: string;
  sourceUrl: string | null;
  company: CompanyProfile;
}): Promise<DiscoverySourceEvidence | null> {
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) return null;
  const seal = await prepareDeepAnalysisInput({
    db: getCunoteDb(),
    storage,
    grantId: input.grantId,
  });
  // 한 요청 안에서도 source가 바뀔 수 있다. 매칭 projection과 다른 revision의
  // 인용문을 같은 화면에 합치지 않는다.
  if (seal.sourceRevisionSha256 !== input.sourceRevisionSha256) return null;
  return buildDiscoverySourceEvidence(seal, input.company, input.sourceUrl);
}

export function buildDiscoverySourceEvidence(
  seal: DeepAnalysisInputSeal,
  company: CompanyProfile,
  sourceUrl: string | null,
): DiscoverySourceEvidence | null {
  const structured = seal.chunks
    .filter((chunk) => chunk.sourceKind === "structured")
    .sort((left, right) => left.index - right.index)
    .map((chunk) => chunk.text).join("");
  let parsed: unknown;
  try { parsed = JSON.parse(structured); } catch { return null; }
  if (!isRecord(parsed) || parsed.schema !== "deep-analysis-structured-source-v1") return null;
  const payload = isRecord(parsed.rawPayload) ? parsed.rawPayload : null;
  const grant = isRecord(parsed.grant) ? parsed.grant : null;
  const officialUrl = safeHttpUrl(sourceUrl) ?? safeHttpUrl(grant?.url);
  if (!officialUrl) return null;

  const excerpts: DiscoverySourceEvidence["excerpts"] = [];
  const push = (kind: DiscoverySourceEvidence["excerpts"][number]["kind"], label: string,
    text: string | null, sourceLabel: string, url: string, cap: number) => {
    if (!text) return;
    const clean = text.trim();
    if (!clean) return;
    const displayed = clipAtBoundary(clean, cap);
    excerpts.push({
      kind, label, text: displayed, sourceLabel, sourceUrl: url,
      truncated: clean.length > displayed.length,
    });
  };
  const target = sourceText(payload?.aply_trgt_ctnt)
    ?? sourceText(payload?.trgetNm);
  const exclusion = sourceText(payload?.aply_excl_trgt_ctnt);
  // 수집원의 대상 필드에도 사업 소개 문장만 들어오는 사례가 있다.
  if (target && /(?:기업|사업자|예비창업|법인|기관|단체|개인|소상공인|중소기업|창업자)/u.test(target)) {
    push("target", "원본의 신청대상 항목", target, "공고 원본 · 신청대상 상세", officialUrl, 850);
  }
  if (exclusion && !isReferenceOnly(exclusion)) {
    push("exclusion", "신청 제외대상", exclusion, "공고 원본 · 신청 제외대상", officialUrl, 950);
  }

  // 신청서 양식의 '신청자격' 칸을 공고 자격 조항으로 인용하지 않는다.
  // 공식 공고문을 먼저 보고, 포스터·요약문은 공고문이 없을 때만 살핀다.
  const sourceAttachments = [...seal.attachments]
    .filter((attachment) => attachment.disposition === "included"
      && (!/(?:신청서|동의서|서식|양식)/u.test(attachment.filename)
        || /공고문/u.test(attachment.filename)))
    .sort((left, right) => Number(/공고문/u.test(right.filename)) - Number(/공고문/u.test(left.filename)));
  for (const attachment of sourceAttachments) {
    const text = seal.chunks.filter((chunk) => chunk.sourceKind === "attachment"
      && chunk.sourceId === attachment.id)
      .sort((left, right) => left.index - right.index)
      .map((chunk) => chunk.text).join("");
    if (!text) continue;
    const url = safeHttpUrl(attachment.sourceUri) ?? officialUrl;
    const sourceLabel = `첨부 공고문 · ${attachment.filename}`;
    if (!excerpts.some((item) => item.kind === "attachment_target")) {
      push("attachment_target", "첨부 공고문의 대상·신청자격",
        sourceSection(text, /(?:모집\s*대상\s*및\s*신청\s*자격|신청\s*자격|입주\s*자격)/u)
          ?? sourceSection(text, /(?:모집\s*대상|지원\s*대상)/u),
        sourceLabel, url, 1250);
    }
    if (!excerpts.some((item) => item.kind === "attachment_exclusion")) {
      push("attachment_exclusion", "첨부의 신청 제외대상", sourceSection(text,
        /(?:(?:신청|지원|입주)(?:\s*\(\s*지원\s*\))?\s*제외\s*대상)/u), sourceLabel, url, 1750);
    }
    if (excerpts.some((item) => item.kind === "attachment_target")
      && excerpts.some((item) => item.kind === "attachment_exclusion")) break;
  }

  const reviewItems: DiscoverySourceEvidence["reviewItems"] = [];
  const addReview = (label: string, pattern: RegExp) => {
    const index = excerpts.findIndex((excerpt) => pattern.test(excerpt.text));
    if (index !== -1) reviewItems.push({ label, excerptIndex: index });
  };
  addReview("창업 시점과 공고의 업력 기준", /(?:창업|업력)[^\n]{0,45}\d+\s*년/u);
  addReview("사업자등록 완료 여부", /사업자\s*등록/u);
  addReview("입주 후 주소지 이전 가능 여부", /(?:주소지\s*이전|이전\s*등록)/u);
  addReview("과거·현재 입주 지원 수혜 이력과 예외", /(?:입주|사무공간)[^\n]{0,65}(?:수혜|이력)|(?:수혜|이력)[^\n]{0,65}입주/u);
  addReview("초기창업패키지 선정·졸업 이력과 증빙", /초기창업패키지[^\n]{0,35}(?:선정|졸업)/u);
  const exclusionIndex = excerpts.findIndex((item) => item.kind === "exclusion" || item.kind === "attachment_exclusion");
  if (exclusionIndex !== -1) {
    reviewItems.push({ label: "신청 제외조건과 허용 예외", excerptIndex: exclusionIndex });
  }
  if (reviewItems.length === 0 && excerpts.length > 0) {
    reviewItems.push({ label: "원문 조건과 회사의 실제 충족 여부", excerptIndex: 0 });
  }
  if (excerpts.length === 0) return null;
  return {
    sourceRevisionSha256: seal.sourceRevisionSha256,
    companyFacts: {
      bizAgeMonths: Number.isInteger(company.biz_age_months) && company.biz_age_months! >= 0
        ? company.biz_age_months! : null,
      targetTypes: (company.target_types ?? []).slice(0, 2),
      industries: (company.industries ?? []).slice(0, 3),
    },
    excerpts,
    reviewItems,
    incompleteAttachments: seal.blockers.some((blocker) => blocker.attachmentId !== null),
    exclusionDetailsUnavailable: !excerpts.some((item) => item.kind === "exclusion" || item.kind === "attachment_exclusion"),
  };
}

function sourceText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clipAtBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const candidate = text.slice(0, cap);
  const lastLine = candidate.lastIndexOf("\n");
  if (lastLine >= Math.floor(cap / 2)) return candidate.slice(0, lastLine).trimEnd();
  const lastSentence = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("다. "));
  if (lastSentence >= Math.floor(cap / 2)) return candidate.slice(0, lastSentence + 1).trimEnd();
  return candidate;
}

function isReferenceOnly(value: string): boolean {
  return /^(?:(?:모집|첨부)\s*)?(?:공고문|첨부\s*파일|붙임)\s*(?:참고|참조|확인)[.!。\s]*$/u.test(value.trim());
}

/** 절의 표제행만 선택한다. 본문에서 우연히 나온 '신청자격'은 표제로 취급하지 않는다. */
function sourceSection(text: string, heading: RegExp): string | null {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => {
    const normalized = line.trim().replace(/^(?:[□■]|#{1,3}|[①-⑳]|\d+[.)])\s*/u, "");
    return normalized.length < 100 && heading.test(normalized)
      && (normalized.match(heading)?.index ?? -1) === 0;
  });
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && end - start < 65) {
    if (/^\s*(?:[□■]|#{1,3}\s+|[ⅠⅡⅢⅣⅤ]\.)/u.test(lines[end]!) && end > start + 1) break;
    end += 1;
  }
  return lines.slice(start, end).join("\n").trim() || null;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
