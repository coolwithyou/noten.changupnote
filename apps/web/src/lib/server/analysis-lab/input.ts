// 공모 딥분석 실험실 — LLM 입력 조립 (dev 전용, read-only).
// ① 공고 구조화 필드 블록(grants 행 + grant_raw.payload 소스별 주요 필드)
// ② 첨부 markdown 전문 블록들(R2 markdownStorageKey → stripYamlFrontmatter, 본문성 우선 정렬)
// 총량 캡(기본 120,000자, env ANALYSIS_LAB_INPUT_CHAR_CAP) 안에서 블록별 chars/truncated 를 기록하고
// 최종 입력 텍스트 전체의 sha256 을 산출한다. source_span 검증은 이 최종 텍스트 기준으로 이루어진다.
// 렌더 방식은 grantAnalysisPilotExtractor 의 renderBalancedPilotInput 을 참고했다.
import { createHash } from "node:crypto";
import { htmlToText } from "@cunote/core";
import { stripYamlFrontmatter } from "@/lib/server/chat/grounding";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import type { LabInputBlock } from "@/features/dev/analysis-lab/contract";

const DEFAULT_INPUT_CHAR_CAP = 120_000;

export function labInputCharCap(): number {
  const raw = process.env.ANALYSIS_LAB_INPUT_CHAR_CAP?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INPUT_CHAR_CAP;
}

export interface LabInputGrant {
  source: string;
  sourceId: string;
  title: string;
  agencyOperator: string | null;
  agencyJurisdiction: string | null;
  applyStart: Date | null;
  applyEnd: Date | null;
  applyMethod: Record<string, string | null> | null;
  supportAmount: Record<string, unknown> | null;
  benefits: Array<Record<string, unknown>> | null;
}

export interface LabInputArchive {
  filename: string;
  markdownStorageKey: string | null;
  markdownBytes: number | null;
}

export interface LabAssembledInput {
  /** LLM 에 그대로 전달하는 최종 입력 텍스트 — source_span 검증 기준. */
  text: string;
  blocks: LabInputBlock[];
  totalChars: number;
  inputSha256: string;
}

interface DraftBlock {
  label: string;
  body: string;
}

export async function assembleLabInput(
  input: {
    grant: LabInputGrant;
    payload: Record<string, unknown> | null;
    archives: LabInputArchive[];
  },
  deps: { storage?: LabAttachmentTextStorage | null } = {},
): Promise<LabAssembledInput> {
  const cap = labInputCharCap();
  const structured: DraftBlock = {
    label: "공고 구조화 필드",
    body: renderStructuredFields(input.grant, input.payload),
  };
  // 첨부는 남은 캡 예산만큼만 R2 에서 읽는다 — 어차피 버릴 대용량 첨부를 전부 메모리에
  // 올리지 않기 위함(Codex 리뷰 M2). 못 읽은 첨부는 unavailable 로 돌려받아 아래에서 고지한다.
  const attachment = await loadAttachmentBlocks(
    input.archives,
    Math.max(0, cap - structured.body.length),
    deps.storage,
  );
  const drafts: DraftBlock[] = [structured, ...attachment.blocks];

  // 총량 캡: 블록 본문 기준으로 앞에서부터 예산을 소진한다(pilot capBlocks 와 동형).
  let remaining = cap;
  const blocks: LabInputBlock[] = [];
  const renderedBlocks: string[] = [];
  const cappedLabels: string[] = [];
  for (const draft of drafts) {
    if (remaining <= 0) {
      blocks.push({ label: draft.label, chars: 0, truncated: true });
      cappedLabels.push(`${draft.label}(전체 제외)`);
      continue;
    }
    const body = draft.body.slice(0, remaining);
    const truncated = body.length < draft.body.length;
    remaining -= body.length;
    blocks.push({ label: draft.label, chars: body.length, truncated });
    if (truncated) cappedLabels.push(`${draft.label}(뒷부분 잘림)`);
    if (body.trim()) renderedBlocks.push(`[블록: ${draft.label}]\n${body}`);
  }

  // 로드 실패·캡 초과로 입력에 못 들어간 첨부도 블록 메타에 남긴다(실행 메타 탭에서 보이도록).
  for (const item of attachment.unavailable) {
    blocks.push({
      label: `첨부 미투입(${UNAVAILABLE_REASON_LABELS[item.reason]}): ${item.filename}`,
      chars: 0,
      truncated: true,
    });
  }

  // 잘림·제외·로드 실패를 모델에게 고지한다 — 고지가 없으면 모델이 "검사했으나 조건 없음"과
  // "입력에 없어 검사 불가(input_missing)"를 구분할 수 없어 축 검사 판정이 왜곡된다(Codex 리뷰 M1).
  const noticeParts: string[] = [];
  if (cappedLabels.length > 0) {
    noticeParts.push(
      `길이 제한(${cap.toLocaleString()}자)으로 다음 블록이 잘리거나 제외되었다: ${cappedLabels.join(", ")}`,
    );
  }
  if (attachment.unavailable.length > 0) {
    noticeParts.push(
      `다음 첨부는 입력에 포함되지 못했다: ${attachment.unavailable
        .map((item) => `${item.filename}(${UNAVAILABLE_REASON_LABELS[item.reason]})`)
        .join(", ")}`,
    );
  }
  const capNotice =
    noticeParts.length > 0
      ? `\n\n[입력 한계 고지] ${noticeParts.join(" / ")}. 이로 인해 검사할 수 없는 축은 input_missing 으로 보고하라.`
      : "";

  const text = [
    "[공모 딥분석 실험실 입력]",
    `source: ${input.grant.source}`,
    `source_id: ${input.grant.sourceId}`,
    `title: ${input.grant.title}`,
    "",
    renderedBlocks.join("\n\n") + capNotice,
  ].join("\n");

  return {
    text,
    blocks,
    totalChars: text.length,
    inputSha256: createHash("sha256").update(text).digest("hex"),
  };
}

// ── ① 공고 구조화 필드 블록 ─────────────────────────────────────────

function renderStructuredFields(
  grant: LabInputGrant,
  payload: Record<string, unknown> | null,
): string {
  const lines: string[] = [
    field("제목", grant.title),
    field("주관/운영", grant.agencyOperator ?? grant.agencyJurisdiction),
    field("접수 시작", isoDate(grant.applyStart)),
    field("접수 마감", isoDate(grant.applyEnd)),
    field("신청 방법", compactObject(grant.applyMethod)),
    field("지원 금액", compactObject(grant.supportAmount)),
    field("지원 내용", compactArray(grant.benefits)),
  ].filter(Boolean) as string[];

  if (payload) {
    if (grant.source === "kstartup") lines.push(...renderKStartupPayload(payload));
    else lines.push(...renderBizInfoPayload(payload));
  }
  return lines.join("\n");
}

// K-Startup 원본 payload 주요 필드(packages/core/src/kstartup/extraction-input.ts 필드 선택 참고).
const KSTARTUP_FIELDS: Array<[key: string, label: string]> = [
  ["biz_pbanc_nm", "공고명"],
  ["pbanc_ctnt", "공고 내용"],
  ["aply_trgt", "신청대상 요약"],
  ["aply_trgt_ctnt", "신청대상 상세"],
  ["aply_excl_trgt_ctnt", "신청 제외대상"],
  ["prfn_matr", "우대사항"],
  ["biz_enyy", "업력 조건"],
  ["biz_trgt_age", "대상 연령"],
  ["supt_regin", "지원지역"],
  ["supt_biz_clsfc", "지원분류"],
  ["pbanc_rcpt_bgng_dt", "접수 시작(원본)"],
  ["pbanc_rcpt_end_dt", "접수 마감(원본)"],
];

/**
 * payload 필드 렌더 — 짧은 단일행 값은 "라벨: 값" 으로 그대로 노출한다.
 * 모델이 구조화 필드를 인용할 때 자연스럽게 쓰는 형식("지원지역: 전국")과 입력 표기를
 * 일치시켜 source_span 부분문자열 검증이 성립하게 하기 위함(v2 보정).
 */
function payloadLine(label: string, key: string, text: string): string {
  if (!text.includes("\n") && text.length <= 80) {
    return `${label}: ${text} (source_field: ${key})`;
  }
  return `## ${label}\nsource_field: ${key}\n${text}`;
}

function renderKStartupPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, label] of KSTARTUP_FIELDS) {
    const text = clean(payload[key]);
    if (text) lines.push(payloadLine(label, key, text));
  }
  const detail = isRecord(payload.detail) ? payload.detail : null;
  const applyMethodText = clean(detail?.apply_method_text);
  if (applyMethodText) {
    lines.push(`## 상세 신청방법\nsource_field: detail.apply_method_text\n${applyMethodText}`);
  }
  const submitDocumentsText = clean(detail?.submit_documents_text);
  if (submitDocumentsText) {
    lines.push(`## 상세 제출서류\nsource_field: detail.submit_documents_text\n${submitDocumentsText}`);
  }
  return lines;
}

// 기업마당 원본 payload 주요 필드(packages/core/src/bizinfo/extraction-input.ts 필드 선택 참고).
// bsnsSumryCn/reqstMthPapersCn 은 HTML 이라 태그를 제거한다(htmlToText).
const BIZINFO_FIELDS: Array<[key: string, label: string, html: boolean]> = [
  ["pblancNm", "공고명", false],
  ["trgetNm", "지원대상", false],
  ["reqstBeginEndDe", "신청기간", false],
  ["pldirSportRealmLclasCodeNm", "지원분야(대)", false],
  ["pldirSportRealmMlsfcCodeNm", "지원분야(중)", false],
  ["reqstMthPapersCn", "신청방법", true],
  ["bsnsSumryCn", "사업요약", true],
  ["hashtags", "해시태그", false],
];

function renderBizInfoPayload(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, label, html] of BIZINFO_FIELDS) {
    const raw = payload[key];
    const text = html && typeof raw === "string" ? clean(htmlToText(raw)) : clean(raw);
    if (text) lines.push(payloadLine(label, key, text));
  }
  return lines;
}

// ── ② 첨부 markdown 블록(본문성 우선 정렬) ──────────────────────────

// 본문성 휴리스틱 — grounding.ts 의 announcementScore 복제(비export 라 dev 전용으로 복제, 출처 주석).
const ANNOUNCEMENT_PATTERNS = /(공\s*고|모집공고|모집요강|사업\s*안내|통합공고|공고문)/;
const FORM_PATTERNS =
  /(신청서|지원서|사업\s*계획서|수행계획서|계획서|양식|서식|서약서|동의서|확약서|제안서|붙임|별지|증빙|명부|통장)/;

export function announcementScore(filename: string): number {
  let score = 0;
  if (ANNOUNCEMENT_PATTERNS.test(filename)) score += 2;
  if (FORM_PATTERNS.test(filename)) score -= 2;
  return score;
}

/** 코호트 선정 기준: 이 크기 이상인 본문성 markdown 이 있어야 "딥분석하기 좋은 공고"로 본다. */
export const BODY_MARKDOWN_MIN_BYTES = 2_000;

type UnavailableReason = "markdown_missing" | "r2_unconfigured" | "load_failed" | "cap_exceeded";

const UNAVAILABLE_REASON_LABELS: Record<UnavailableReason, string> = {
  markdown_missing: "변환 안 됨",
  r2_unconfigured: "R2 미설정",
  load_failed: "로드 실패",
  cap_exceeded: "캡 초과 미로드",
};

/** 첨부 markdown 텍스트 로더 — 테스트에서 R2 없이 주입하기 위한 최소 인터페이스. */
export interface LabAttachmentTextStorage {
  getObjectText(key: string): Promise<string>;
}

interface AttachmentLoadResult {
  blocks: DraftBlock[];
  /** 입력에 포함되지 못한 markdown 첨부 — 조용히 버리지 않고 호출자에게 돌려 고지한다(M1). */
  unavailable: Array<{ filename: string; reason: UnavailableReason }>;
}

async function loadAttachmentBlocks(
  archives: LabInputArchive[],
  budget: number,
  injectedStorage?: LabAttachmentTextStorage | null,
): Promise<AttachmentLoadResult> {
  // markdown 미생성 첨부(변환 실패·미시도)도 조용히 버리지 않고 고지한다 — 고지가 없으면
  // 모델이 그 첨부의 존재를 모른 채 inspected_no_condition 으로 오판한다(178352 실사례).
  const markdownMissing: AttachmentLoadResult["unavailable"] = archives
    .filter((archive) => !archive.markdownStorageKey)
    .map((archive) => ({ filename: archive.filename, reason: "markdown_missing" as const }));
  const withMarkdown = archives
    .filter((archive): archive is LabInputArchive & { markdownStorageKey: string } =>
      Boolean(archive.markdownStorageKey))
    .sort((a, b) => {
      const scoreDelta = announcementScore(b.filename) - announcementScore(a.filename);
      if (scoreDelta !== 0) return scoreDelta;
      return (b.markdownBytes ?? 0) - (a.markdownBytes ?? 0);
    });
  if (withMarkdown.length === 0) return { blocks: [], unavailable: markdownMissing };

  const storage = injectedStorage === undefined ? createR2ObjectStorageFromEnv() : injectedStorage;
  if (!storage) {
    // R2 env 미설정 — 구조화 필드만으로 진행하되, 어떤 첨부가 빠졌는지는 고지한다.
    return {
      blocks: [],
      unavailable: [
        ...markdownMissing,
        ...withMarkdown.map((archive) => ({
          filename: archive.filename,
          reason: "r2_unconfigured" as const,
        })),
      ],
    };
  }

  const blocks: DraftBlock[] = [];
  const unavailable: AttachmentLoadResult["unavailable"] = [...markdownMissing];
  let loadedChars = 0;
  for (const archive of withMarkdown) {
    // 캡 예산을 이미 소진했으면 더 읽지 않는다(M2) — 본문성 우선 정렬이라 뒤쪽은 서식류.
    if (loadedChars >= budget) {
      unavailable.push({ filename: archive.filename, reason: "cap_exceeded" });
      continue;
    }
    try {
      const raw = await storage.getObjectText(archive.markdownStorageKey);
      const body = stripYamlFrontmatter(raw).trim();
      if (body) {
        blocks.push({ label: `첨부 공고문: ${archive.filename}`, body });
        loadedChars += body.length;
      }
    } catch {
      unavailable.push({ filename: archive.filename, reason: "load_failed" });
    }
  }
  return { blocks, unavailable };
}

// ── 렌더 유틸 ─────────────────────────────────────────────────────

function field(label: string, value: string | null): string | null {
  return value ? `${label}: ${value}` : null;
}

function isoDate(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function compactObject(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  const entries = Object.entries(value)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .slice(0, 12);
  return entries.length > 0 ? entries.join(" · ") : null;
}

function compactArray(value: Array<Record<string, unknown>> | null): string | null {
  if (!value || value.length === 0) return null;
  const items = value.map((item) => {
    const name = item.name ?? item.label ?? item.text;
    return typeof name === "string" ? name : JSON.stringify(item);
  }).slice(0, 20);
  return items.join(", ");
}

function clean(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
