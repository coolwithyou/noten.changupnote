/**
 * 운영 지식 추출 공용 모듈 — 텍스트 추출·LLM 추출 패스·서버측 검증.
 *
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §6.2(추출 패스).
 * 배경: v1 에서는 이 로직이 인제스천 CLI(ingest-knowledge-source.ts)에 갇혀 있었다.
 *   GUI 업로드→추출 API(/internal/knowledge/api/sources/[id]/extract)와 CLI 가 같은 파이프라인을
 *   공유하도록, 추출·검증·프롬프트를 이 모듈로 이동했다. CLI 는 이 모듈을 쓰는 얇은 셸이 된다.
 *
 * 원칙(변경 없음): 원문 인용(quote) 없는 후보 생성 금지. 추출 결과는 항상 "후보"(proposed).
 *   추출 결과를 신뢰하지 않고 서버측에서 화이트리스트·필수필드·scope 축·quote 실재를 재검증한다.
 *
 * 환경변수 해석은 지연 평가(resolve* 함수)한다: CLI 는 정적 import 후에 loadMonorepoEnv() 로
 *   .env 를 로드하므로, 모듈 최상위 const 로 굳히면 .env 정의값(ANTHROPIC_KNOWLEDGE_MODEL 등)을
 *   놓친다. 호출 시점에 process.env 를 읽어 CLI/Next 양쪽에서 동일하게 동작하게 한다.
 */
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { anthropicUsageToTokenUsage, withOpsBatchMetering } from "../credits/metering";
import { fieldKeyDictionaryPromptBlock, isKnownFieldKey } from "./fieldKeyDictionary";
import {
  EVIDENCE_TIERS,
  LESSON_TARGETS,
  scopeHasAxis,
  type EvidenceTier,
  type KnowledgeSourceKind,
  type LessonScope,
  type LessonTarget,
  type NonLessonItem,
} from "./knowledgeRepo";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/** 추출 프롬프트 버전(재현성·버전 관리). 변경 시 함께 올린다. v2: scope.fieldKey 축 + 표준 key 사전 주입. */
export const PROMPT_VER = "ops_extract_v2";

/** 추출 모델. ANTHROPIC_KNOWLEDGE_MODEL override, 기본 claude-opus-4-8. 호출 시점 해석. */
export function resolveExtractionModel(): string {
  return process.env.ANTHROPIC_KNOWLEDGE_MODEL?.trim() || "claude-opus-4-8";
}
/** 응답 최대 토큰. ANTHROPIC_KNOWLEDGE_MAX_TOKENS override, 기본 16000. */
export function resolveMaxTokens(): number {
  return Number(process.env.ANTHROPIC_KNOWLEDGE_MAX_TOKENS ?? "16000");
}
/** LLM 에 보내는 추출 텍스트 상한. KNOWLEDGE_MAX_TEXT_CHARS override, 기본 200000. */
export function resolveMaxTextChars(): number {
  return Number(process.env.KNOWLEDGE_MAX_TEXT_CHARS ?? "200000");
}

export const CANDIDATE_KINDS = ["lesson", "faq_candidate", "exemplar", "product_feedback", "noise"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];

// ── 텍스트 추출 ────────────────────────────────────────────
/**
 * 파일 바이트에서 페이지별 텍스트를 추출하고 [page N] 마커로 합성한다(quote page 근거용).
 * - txt/md: bytes 를 utf8 디코드(파일시스템 재접근 없이 바이트 기반으로 통일).
 * - pdf: pdfjs-dist legacy 로 페이지별 추출.
 * - 그 외: 에러(.pdf/.txt/.md 만 지원).
 */
export async function extractTextFromBytes(
  ext: string,
  bytes: Buffer,
): Promise<{ pages: Array<{ page: number; text: string }>; marked: string }> {
  const normalizedExt = ext.toLowerCase();
  if (normalizedExt === ".txt" || normalizedExt === ".md") {
    const text = bytes.toString("utf8");
    const pages = [{ page: 1, text }];
    return { pages, marked: `[page 1]\n${text}` };
  }
  if (normalizedExt === ".pdf") {
    const data = new Uint8Array(bytes);
    const doc = await getDocument({ data, verbosity: VerbosityLevel.ERRORS, isEvalSupported: false }).promise;
    const pages: Array<{ page: number; text: string }> = [];
    const markedParts: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join(" ")
        .replace(/[ \t]+/g, " ")
        .trim();
      pages.push({ page: p, text });
      markedParts.push(`[page ${p}]\n${text}`);
      page.cleanup();
    }
    await doc.destroy();
    return { pages, marked: markedParts.join("\n\n") };
  }
  throw new Error(`unsupported extension: ${ext} (.pdf/.txt/.md 만 지원)`);
}

// ── LLM 추출 패스 ──────────────────────────────────────────
export const SYSTEM_PROMPT = `당신은 공공 지원사업(정부 창업·투자·융자 등) 운영 보고 문서에서 재사용 가능한 지식을 항목 단위로 분해·분류하는 추출기다.
문서는 운영팀 인터뷰 정리, 사용자 피드백, 공고 해설 등이다. 아래 규칙을 반드시 지켜라.

[분류 — 각 항목은 정확히 하나의 kind]
- lesson: 지원서 작성·심사·필드 해석에 재사용 가능한 지침/규칙/사실 (예: 매출액 정의, 가점 조합, 자금 한도, 작성 하네스).
- faq_candidate: 사용자가 자주 물을 개념 구분·안내 (검증 Q&A 후보).
- exemplar: 좋은/나쁜 작성 예시(예문) — few-shot 소재 후보.
- product_feedback: 제품 기능 요청·개선 아이디어 (예: 재무제표 PDF 자동 기입). lesson 아님.
- noise: 잡담·중복·비지식. 저장하지 않는다.

[lesson 필드 스키마]
- target: 'classification'|'criteria'|'field_interpretation'|'fill_value'|'guide'|'evaluation' 중 하나.
  · classification: 문서/필드 분류 규칙  · criteria: 자격·전제조건  · field_interpretation: 필드값 해석 규칙
  · fill_value: 채워야 할 수치·한도  · guide: 작성 지침(하네스)  · evaluation: 심사·채점 관점
- scope: 적용 범위. 최소 1개 축 필수. 축: program, institution, formTemplateId, documentCategory, fieldPattern, fieldKey, condition.
  · 보수적으로: 문서에서 확인되는 범위만 기입한다. 한 프로그램(예: LIPS) 문서의 지식을 전체 지원사업으로 일반화 금지.
  · fieldKey: 아래 "[표준 필드 key 사전]"의 key 중, fieldPattern 이 가리키는 항목과 의미가 일치하는 것을 scope.fieldKey 로 제안하라. 사전에 없으면 fieldKey 를 생략한다(자유 발명 금지). fieldPattern 과 함께 채우는 것이 이상적이다.
- instruction: 에이전트에게 주입할 한 문장 지침(명령형).
- rationale: 근거·이유(왜 이 지침인가).
- evidenceTier: 'official_document'(공고문·규정 원문 인용) | 'staff_confirmed'(담당자 전언) | 'ops_inference'(운영팀 해석·추정).
- programRound: 문서에서 확인되는 회차(예: "2026 LIPS 2차"). 없으면 null.
- reviewBy: 수치·조건형 지식은 다음 회차 예상 시점(YYYY-MM-DD)을 제안. 모르면 null.

[모든 항목 공통 — 원문 인용 필수]
- quote: 원문에 실제로 존재하는 "연속 문자열"을 그대로 인용한다. 요약·의역·문장 병합 금지. 인용할 수 없으면 그 항목을 만들지 마라.
- page: 인용이 나온 [page N] 마커의 N(정수). 특정 불가하면 null.
- 비-lesson(faq_candidate/exemplar/product_feedback)은 content(내용 요약)와 quote/page 를 채운다.

[표준 필드 key 사전 — scope.fieldKey 는 반드시 아래 key 중 하나여야 하며, 없으면 생략한다]
${fieldKeyDictionaryPromptBlock()}

[출력] JSON 하나만. 마크다운/설명/코드펜스 금지:
{"candidates":[{"kind":"lesson","target":"...","scope":{"fieldPattern":"...","fieldKey":"..."},"instruction":"...","rationale":"...","evidenceTier":"...","programRound":null,"reviewBy":null,"quote":"...","page":3},{"kind":"faq_candidate","content":"...","quote":"...","page":2}]}`;

export interface RawCandidate {
  kind?: unknown;
  target?: unknown;
  scope?: unknown;
  instruction?: unknown;
  rationale?: unknown;
  evidenceTier?: unknown;
  programRound?: unknown;
  reviewBy?: unknown;
  content?: unknown;
  quote?: unknown;
  page?: unknown;
}

export interface LlmExtractionParams {
  apiKey: string;
  markedText: string;
  programHint: string | null;
  institutionHint: string | null;
  kind: KnowledgeSourceKind;
  sourceDate: string;
}

/**
 * LLM 추출 패스(Anthropic Messages API). 문서 전문을 항목 단위로 분해·분류한 후보 배열을 반환한다.
 * 힌트(program/institution/kind/sourceDate)는 파라미터로 명시화(v1 CLI 는 모듈 전역을 클로저로 참조했음).
 */
export async function runLlmExtraction(params: LlmExtractionParams): Promise<RawCandidate[]> {
  const { apiKey, markedText, programHint, institutionHint, kind, sourceDate } = params;
  const hints: string[] = [];
  if (programHint) hints.push(`program 힌트: ${programHint} (해당하면 scope.program 에 반영)`);
  if (institutionHint) hints.push(`institution 힌트: ${institutionHint} (해당하면 scope.institution 에 반영)`);
  if (kind === "ops_interview") hints.push("이 문서는 담당자 인터뷰 정리다. lesson 의 evidenceTier 기본값은 staff_confirmed(공고문 원문 인용이 있으면 official_document).");
  hints.push(`문서 작성일(sourceDate): ${sourceDate}. reviewBy 를 특정하기 어려우면 null 로 두라(코드가 sourceDate+1년으로 보정).`);

  const userText = `${hints.join("\n")}

아래는 문서 전문이다([page N] 은 페이지 마커, quote 의 page 근거로만 사용):
---
${markedText}
---
위 규칙에 따라 항목을 5분류로 분해해 JSON 으로 출력하라.`;

  const model = resolveExtractionModel();
  const maxOutputTokens = resolveMaxTokens();
  // 운영 배치 무과금 미터링(6.2 ops_batch, 원가수집). ★ fail-open — 반환값·오류 경로 불변.
  return withOpsBatchMetering(
    {
      featureCode: "ops_batch_knowledge_extraction",
      model,
      estimate: { inputTokens: 0, maxOutputTokens },
      requestId: `knowledge:${kind}`,
      contextRef: { kind },
    },
    async ({ report, maxTokens }) => {
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`anthropic_${res.status}: ${body.slice(0, 400)}`);
      }
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: unknown;
      };
      report(anthropicUsageToTokenUsage(data.usage));
      const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      const parsed = extractJson(text);
      const candidates = (parsed as { candidates?: unknown })?.candidates;
      return Array.isArray(candidates) ? (candidates as RawCandidate[]) : [];
    },
  );
}

// ── 서버측 검증(추출 결과 신뢰 금지) ────────────────────────
export interface ValidatedLesson {
  target: LessonTarget;
  scope: LessonScope;
  instruction: string;
  rationale: string;
  evidenceTier: EvidenceTier;
  programRound: string | null;
  reviewBy: Date | null;
  sourceRefs: Array<{ page: number | null; quote: string }>;
}
export interface ValidationResult {
  counts: Record<CandidateKind | "invalid", number>;
  lessons: ValidatedLesson[];
  nonLessonItems: NonLessonItem[];
  dropped: string[];
  quoteTotal: number;
  quotePassed: number;
  lessonQuoteTotal: number;
  lessonQuotePassed: number;
}

export function validateCandidates(
  raw: RawCandidate[],
  normalizedFull: string,
  sourceDate: string,
): ValidationResult {
  const counts: Record<CandidateKind | "invalid", number> = {
    lesson: 0,
    faq_candidate: 0,
    exemplar: 0,
    product_feedback: 0,
    noise: 0,
    invalid: 0,
  };
  const lessons: ValidatedLesson[] = [];
  const nonLessonItems: NonLessonItem[] = [];
  const dropped: string[] = [];
  let quoteTotal = 0;
  let quotePassed = 0;
  let lessonQuoteTotal = 0;
  let lessonQuotePassed = 0;

  raw.forEach((c, i) => {
    const kind = c.kind;
    if (typeof kind !== "string" || !(CANDIDATE_KINDS as readonly string[]).includes(kind)) {
      counts.invalid++;
      dropped.push(`[${i}] kind:${String(kind)}`);
      return;
    }
    const ck = kind as CandidateKind;
    if (ck === "noise") {
      counts.noise++;
      return; // 저장하지 않음.
    }

    const quote = typeof c.quote === "string" ? c.quote.trim() : "";
    const page = typeof c.page === "number" && Number.isInteger(c.page) ? c.page : null;

    if (ck === "lesson") {
      const target = c.target;
      const evidenceTier = c.evidenceTier;
      const instruction = typeof c.instruction === "string" ? c.instruction.trim() : "";
      const rationale = typeof c.rationale === "string" ? c.rationale.trim() : "";
      const scope = normalizeScope(c.scope);

      // fieldKey 화이트리스트 검증: 사전에 없는 fieldKey 는 그 축만 제거한다(候補 전체 드랍 아님 —
      // fieldPattern·다른 축은 유효하므로 후보는 살리고 자유 발명된 fieldKey 만 버린다).
      if (scope.fieldKey && !isKnownFieldKey(scope.fieldKey)) {
        dropped.push(`[${i}] lesson_fieldKey_not_in_dictionary(축 제거): ${summarize(scope.fieldKey, 40)}`);
        delete scope.fieldKey;
      }

      if (typeof target !== "string" || !(LESSON_TARGETS as readonly string[]).includes(target)) {
        counts.invalid++;
        dropped.push(`[${i}] lesson_target:${String(target)}`);
        return;
      }
      if (typeof evidenceTier !== "string" || !(EVIDENCE_TIERS as readonly string[]).includes(evidenceTier)) {
        counts.invalid++;
        dropped.push(`[${i}] lesson_evidenceTier:${String(evidenceTier)}`);
        return;
      }
      if (!instruction) {
        counts.invalid++;
        dropped.push(`[${i}] lesson_empty_instruction`);
        return;
      }
      if (!rationale) {
        counts.invalid++;
        dropped.push(`[${i}] lesson_empty_rationale`);
        return;
      }
      if (!scopeHasAxis(scope)) {
        counts.invalid++;
        dropped.push(`[${i}] lesson_empty_scope`);
        return;
      }
      if (!quote) {
        counts.invalid++;
        dropped.push(`[${i}] lesson_empty_quote`);
        return;
      }
      // quote 실재 검증.
      lessonQuoteTotal++;
      quoteTotal++;
      if (!quoteExists(quote, normalizedFull)) {
        dropped.push(`[${i}] lesson_quote_not_found: ${summarize(quote, 60)}`);
        return;
      }
      lessonQuotePassed++;
      quotePassed++;

      lessons.push({
        target: target as LessonTarget,
        scope,
        instruction,
        rationale,
        evidenceTier: evidenceTier as EvidenceTier,
        programRound: typeof c.programRound === "string" && c.programRound.trim() ? c.programRound.trim() : null,
        reviewBy: parseReviewBy(c.reviewBy, sourceDate),
        sourceRefs: [{ page, quote }],
      });
      counts.lesson++;
      return;
    }

    // 비-lesson (faq_candidate | exemplar | product_feedback)
    const content = typeof c.content === "string" ? c.content.trim() : "";
    if (!content) {
      counts.invalid++;
      dropped.push(`[${i}] ${ck}_empty_content`);
      return;
    }
    if (!quote) {
      counts.invalid++;
      dropped.push(`[${i}] ${ck}_empty_quote`);
      return;
    }
    quoteTotal++;
    if (!quoteExists(quote, normalizedFull)) {
      dropped.push(`[${i}] ${ck}_quote_not_found: ${summarize(quote, 60)}`);
      return;
    }
    quotePassed++;
    nonLessonItems.push({ kind: ck, content, quote, page });
    counts[ck]++;
  });

  return {
    counts,
    lessons,
    nonLessonItems,
    dropped,
    quoteTotal,
    quotePassed,
    lessonQuoteTotal,
    lessonQuotePassed,
  };
}

/** scope 를 화이트리스트 축만 남긴 문자열 맵으로 정규화. */
export function normalizeScope(raw: unknown): LessonScope {
  const out: LessonScope = {};
  if (!raw || typeof raw !== "object") return out;
  const axes: (keyof LessonScope)[] = [
    "program",
    "institution",
    "formTemplateId",
    "documentCategory",
    "fieldPattern",
    "fieldKey",
    "condition",
  ];
  const obj = raw as Record<string, unknown>;
  for (const k of axes) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) out[k] = v.trim();
  }
  return out;
}

/** reviewBy 를 Date 로. 유효한 ISO date 면 사용, 아니면 sourceDate + 1년. */
export function parseReviewBy(raw: unknown, sourceDate: string): Date | null {
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    const d = new Date(`${raw.trim()}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const base = new Date(`${sourceDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCFullYear(base.getUTCFullYear() + 1);
  return base;
}

/** 공백 정규화 후 quote 가 원문 정규화 텍스트의 부분 문자열인지. */
export function quoteExists(quote: string, normalizedFull: string): boolean {
  const q = normalizeWs(quote);
  if (q.length === 0) return false;
  return normalizedFull.includes(q);
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── 헬퍼 ──────────────────────────────────────────────────
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fence ? fence[1] : trimmed) ?? "";
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  try {
    return JSON.parse(slice);
  } catch {
    return {};
  }
}

/** 문자열을 공백 정규화 후 n자로 자르고 말줄임표 표기(리포트·dropped 메시지용). */
export function summarize(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function contentTypeForExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === ".pdf") return "application/pdf";
  if (e === ".md") return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export function safeName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return cleaned || "source";
}
