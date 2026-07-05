/**
 * 운영 지식 인제스천 CLI — 운영 보고 문서 1건을 등록·추출해 lesson 후보를 만든다.
 *
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §6(추출 패스)·§8(리스크).
 * 선례: generate-review-questions.ts(Anthropic 직접 fetch·dry-run 기본·서버측 sanitize),
 *       load-golden-field-maps.ts(dry-run 가드), r2ObjectStorage(업로드 헬퍼).
 *
 * 흐름:
 *   1) 파일(.pdf/.txt/.md) 읽기 → sha256 → 같은 sha256 원천이 있으면 "이미 등록됨" 안내 후 종료(멱등).
 *   2) 텍스트 추출: PDF 는 pdfjs-dist legacy 로 페이지별 추출, [page N] 마커로 합성(quote page 특정용).
 *   3) LLM 추출 패스(Anthropic Messages API): 항목을 5분류로 분해, 원문 인용(quote) 필수.
 *   4) 서버측 검증(추출 결과 신뢰 금지): 화이트리스트·필수필드·scope 축, quote 실재(부분 문자열) 검사.
 *   5) dry-run(기본): 분류별 카운트·lesson 후보 목록·quote 통과율 출력. DB/R2/네트워크 쓰기 없음(LLM 호출은 함).
 *   6) --write: R2 업로드 + knowledge_sources insert(status='extracted') + lesson 후보 review_lessons(proposed) batch insert.
 *
 * 원칙: 원문 인용 없는 후보 생성 금지(§6). 추출 결과는 항상 "후보"(proposed) — 승격은 별도 검수 게이트.
 *
 * 사용:
 *   pnpm ingest:knowledge -- --file <경로> [--kind ops_interview] [--title "..."] [--program "LIPS/TIPS"]
 *       [--institution "..."] [--source-date 2026-07-01] [--uploaded-by email] [--write]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { closeCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import {
  EVIDENCE_TIERS,
  KNOWLEDGE_SOURCE_KINDS,
  LESSON_TARGETS,
  findSourceBySha256,
  insertKnowledgeSource,
  insertProposedLessons,
  scopeHasAxis,
  type EvidenceTier,
  type KnowledgeSourceKind,
  type LessonScope,
  type LessonTarget,
  type NonLessonItem,
  type ProposedLessonInput,
} from "./knowledgeRepo";

loadMonorepoEnv();

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_KNOWLEDGE_MODEL?.trim() || "claude-opus-4-8";
const PROMPT_VER = "ops_extract_v1";
const MAX_TOKENS = Number(process.env.ANTHROPIC_KNOWLEDGE_MAX_TOKENS ?? "16000");
// LLM 에 보내는 추출 텍스트 상한(초과 시 잘라내고 truncated 표기).
const MAX_TEXT_CHARS = Number(process.env.KNOWLEDGE_MAX_TEXT_CHARS ?? "200000");

const CANDIDATE_KINDS = ["lesson", "faq_candidate", "exemplar", "product_feedback", "noise"] as const;
type CandidateKind = (typeof CANDIDATE_KINDS)[number];

// ── CLI 인자 ──────────────────────────────────────────────
if (hasFlag("help")) {
  console.log(
    [
      "Usage: pnpm ingest:knowledge -- --file <경로> [--kind ops_interview] [--title \"...\"]",
      "         [--program \"LIPS/TIPS\"] [--institution \"...\"] [--source-date 2026-07-01]",
      "         [--uploaded-by email] [--write]",
      "",
      "기본은 dry-run(DB/R2 쓰기 없음, LLM 추출 호출은 함). --write 로 실제 등록·적재.",
      "kind: ops_interview | user_feedback_report | official_announcement | program_faq (기본 ops_interview).",
    ].join("\n"),
  );
  process.exit(0);
}

const write = hasFlag("write");
const filePathArg = readArg("file");
const kindArg = (readArg("kind")?.trim() || "ops_interview") as KnowledgeSourceKind;
const programHint = readArg("program")?.trim() || null;
const institutionHint = readArg("institution")?.trim() || null;
const sourceDateArg = readArg("source-date")?.trim() || todayIso();
const uploadedBy = readArg("uploaded-by")?.trim() || process.env.INGEST_UPLOADED_BY?.trim() || "ops@cunote.local";

async function main() {
  if (!filePathArg) {
    fail("no_file", "--file <경로> 가 필요합니다.");
    return;
  }
  if (!(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(kindArg)) {
    fail("invalid_kind", `--kind 는 ${KNOWLEDGE_SOURCE_KINDS.join(" | ")} 중 하나여야 합니다. (받음: ${kindArg})`);
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDateArg)) {
    fail("invalid_source_date", `--source-date 는 YYYY-MM-DD 여야 합니다. (받음: ${sourceDateArg})`);
    return;
  }

  const filePath = resolve(process.cwd(), filePathArg);
  if (!existsSync(filePath)) {
    fail("file_not_found", `파일을 찾을 수 없습니다: ${filePath}`);
    return;
  }
  const bytes = readFileSync(filePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha12 = sha256.slice(0, 12);
  const title = readArg("title")?.trim() || basename(filePath);
  const ext = extname(filePath).toLowerCase();

  // 1) 멱등: 같은 sha256 원천이 이미 등록됐으면 종료.
  const existing = await findSourceBySha256(sha256);
  if (existing) {
    console.log(
      JSON.stringify(
        { ok: true, alreadyRegistered: true, sourceId: existing.id, sha256Prefix: sha12, status: existing.status },
        null,
        2,
      ),
    );
    return;
  }

  // 2) 텍스트 추출(페이지별) → [page N] 마커 합성.
  let extraction: { pages: Array<{ page: number; text: string }>; marked: string };
  try {
    extraction = await extractText(filePath, ext, bytes);
  } catch (error) {
    fail("extract_error", (error as Error).message);
    return;
  }
  if (extraction.pages.length === 0 || extraction.marked.trim().length === 0) {
    fail("empty_extraction", "추출된 텍스트가 없습니다.");
    return;
  }
  const normalizedFull = normalizeWs(extraction.pages.map((p) => p.text).join("\n"));
  const truncated = extraction.marked.length > MAX_TEXT_CHARS;
  const markedForLlm = truncated ? extraction.marked.slice(0, MAX_TEXT_CHARS) : extraction.marked;

  // 3) LLM 추출 패스.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    fail("no_api_key", "ANTHROPIC_API_KEY 가 필요합니다(.env).");
    return;
  }
  let rawCandidates: RawCandidate[];
  try {
    rawCandidates = await runExtraction(apiKey, markedForLlm);
  } catch (error) {
    fail("llm_error", (error as Error).message);
    return;
  }

  // 4) 서버측 검증 + quote 실재 검사.
  const v = validateCandidates(rawCandidates, normalizedFull, sourceDateArg);

  // 5) dry-run 리포트.
  const report = {
    dryRun: !write,
    file: filePath,
    sha256Prefix: sha12,
    kind: kindArg,
    title,
    program: programHint,
    institution: institutionHint,
    sourceDate: sourceDateArg,
    uploadedBy,
    model: MODEL,
    promptVer: PROMPT_VER,
    extraction: { pages: extraction.pages.length, textChars: extraction.marked.length, truncated },
    counts: v.counts,
    quoteVerification: {
      totalCandidates: v.quoteTotal,
      passed: v.quotePassed,
      failed: v.quoteTotal - v.quotePassed,
      passRatePct: pct(v.quotePassed, v.quoteTotal),
      lessonTotal: v.lessonQuoteTotal,
      lessonPassed: v.lessonQuotePassed,
      lessonPassRatePct: pct(v.lessonQuotePassed, v.lessonQuoteTotal),
    },
    lessonCandidates: v.lessons.map((l) => ({
      target: l.target,
      scope: l.scope,
      instruction: summarize(l.instruction, 120),
      quotePreview: summarize(l.sourceRefs[0]?.quote ?? "", 80),
      evidenceTier: l.evidenceTier,
      reviewBy: l.reviewBy ? l.reviewBy.toISOString().slice(0, 10) : null,
      page: l.sourceRefs[0]?.page ?? null,
    })),
    nonLessonItems: v.nonLessonItems.length,
    dropped: v.dropped.slice(0, 40),
  };

  if (!write) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // 6) --write: R2 업로드 → knowledge_sources → review_lessons(proposed).
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    fail("no_r2", "R2 환경변수(R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL)가 필요합니다.");
    return;
  }
  const prefix = `knowledge-sources/${sha12}/`;
  const r2Key = `${prefix}${safeName(basename(filePath))}`;
  const extractedTextKey = `${prefix}extracted-text.txt`;
  const extractionJsonKey = `${prefix}extraction.json`;

  await storage.putObject({ key: r2Key, body: bytes, contentType: contentTypeForExt(ext) });
  await storage.putObject({ key: extractedTextKey, body: extraction.marked, contentType: "text/plain; charset=utf-8" });
  await storage.putObject({
    key: extractionJsonKey,
    body: JSON.stringify({ model: MODEL, promptVer: PROMPT_VER, candidates: rawCandidates }, null, 2),
    contentType: "application/json; charset=utf-8",
  });

  const source = await insertKnowledgeSource({
    kind: kindArg,
    title,
    sha256,
    r2Key,
    extractedTextKey,
    extractionJsonKey,
    programHint,
    institutionHint,
    sourceDate: sourceDateArg,
    uploadedBy,
    status: "extracted",
    extractionModel: MODEL,
    extractionPromptVer: PROMPT_VER,
    nonLessonItems: v.nonLessonItems,
  });

  const lessonsToInsert: ProposedLessonInput[] = v.lessons.map((l) => ({
    target: l.target,
    scope: l.scope,
    instruction: l.instruction,
    rationale: l.rationale,
    sourceKind: "ops_report",
    evidenceTier: l.evidenceTier,
    sourceRefs: l.sourceRefs.map((r) => ({ sourceId: source.id, page: r.page, quote: r.quote })),
    sourceId: source.id,
    programRound: l.programRound,
    reviewBy: l.reviewBy,
  }));
  const inserted = await insertProposedLessons(lessonsToInsert);

  console.log(
    JSON.stringify(
      {
        ...report,
        dryRun: false,
        written: {
          sourceId: source.id,
          r2Key,
          extractedTextKey,
          extractionJsonKey,
          lessonsInserted: inserted.length,
          nonLessonItemsStored: v.nonLessonItems.length,
        },
      },
      null,
      2,
    ),
  );
}

// ── 텍스트 추출 ────────────────────────────────────────────
async function extractText(
  filePath: string,
  ext: string,
  bytes: Buffer,
): Promise<{ pages: Array<{ page: number; text: string }>; marked: string }> {
  if (ext === ".txt" || ext === ".md") {
    const text = readFileSync(filePath, "utf8");
    const pages = [{ page: 1, text }];
    return { pages, marked: `[page 1]\n${text}` };
  }
  if (ext === ".pdf") {
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
const SYSTEM_PROMPT = `당신은 공공 지원사업(정부 창업·투자·융자 등) 운영 보고 문서에서 재사용 가능한 지식을 항목 단위로 분해·분류하는 추출기다.
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
- scope: 적용 범위. 최소 1개 축 필수. 축: program, institution, formTemplateId, documentCategory, fieldPattern, condition.
  · 보수적으로: 문서에서 확인되는 범위만 기입한다. 한 프로그램(예: LIPS) 문서의 지식을 전체 지원사업으로 일반화 금지.
- instruction: 에이전트에게 주입할 한 문장 지침(명령형).
- rationale: 근거·이유(왜 이 지침인가).
- evidenceTier: 'official_document'(공고문·규정 원문 인용) | 'staff_confirmed'(담당자 전언) | 'ops_inference'(운영팀 해석·추정).
- programRound: 문서에서 확인되는 회차(예: "2026 LIPS 2차"). 없으면 null.
- reviewBy: 수치·조건형 지식은 다음 회차 예상 시점(YYYY-MM-DD)을 제안. 모르면 null.

[모든 항목 공통 — 원문 인용 필수]
- quote: 원문에 실제로 존재하는 "연속 문자열"을 그대로 인용한다. 요약·의역·문장 병합 금지. 인용할 수 없으면 그 항목을 만들지 마라.
- page: 인용이 나온 [page N] 마커의 N(정수). 특정 불가하면 null.
- 비-lesson(faq_candidate/exemplar/product_feedback)은 content(내용 요약)와 quote/page 를 채운다.

[출력] JSON 하나만. 마크다운/설명/코드펜스 금지:
{"candidates":[{"kind":"lesson","target":"...","scope":{...},"instruction":"...","rationale":"...","evidenceTier":"...","programRound":null,"reviewBy":null,"quote":"...","page":3},{"kind":"faq_candidate","content":"...","quote":"...","page":2}]}`;

interface RawCandidate {
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

async function runExtraction(apiKey: string, markedText: string): Promise<RawCandidate[]> {
  const hints: string[] = [];
  if (programHint) hints.push(`program 힌트: ${programHint} (해당하면 scope.program 에 반영)`);
  if (institutionHint) hints.push(`institution 힌트: ${institutionHint} (해당하면 scope.institution 에 반영)`);
  if (kindArg === "ops_interview") hints.push("이 문서는 담당자 인터뷰 정리다. lesson 의 evidenceTier 기본값은 staff_confirmed(공고문 원문 인용이 있으면 official_document).");
  hints.push(`문서 작성일(sourceDate): ${sourceDateArg}. reviewBy 를 특정하기 어려우면 null 로 두라(코드가 sourceDate+1년으로 보정).`);

  const userText = `${hints.join("\n")}

아래는 문서 전문이다([page N] 은 페이지 마커, quote 의 page 근거로만 사용):
---
${markedText}
---
위 규칙에 따라 항목을 5분류로 분해해 JSON 으로 출력하라.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${body.slice(0, 400)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  const parsed = extractJson(text);
  const candidates = (parsed as { candidates?: unknown })?.candidates;
  return Array.isArray(candidates) ? (candidates as RawCandidate[]) : [];
}

// ── 서버측 검증(추출 결과 신뢰 금지) ────────────────────────
interface ValidatedLesson {
  target: LessonTarget;
  scope: LessonScope;
  instruction: string;
  rationale: string;
  evidenceTier: EvidenceTier;
  programRound: string | null;
  reviewBy: Date | null;
  sourceRefs: Array<{ page: number | null; quote: string }>;
}
interface ValidationResult {
  counts: Record<CandidateKind | "invalid", number>;
  lessons: ValidatedLesson[];
  nonLessonItems: NonLessonItem[];
  dropped: string[];
  quoteTotal: number;
  quotePassed: number;
  lessonQuoteTotal: number;
  lessonQuotePassed: number;
}

function validateCandidates(
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
function normalizeScope(raw: unknown): LessonScope {
  const out: LessonScope = {};
  if (!raw || typeof raw !== "object") return out;
  const axes: (keyof LessonScope)[] = [
    "program",
    "institution",
    "formTemplateId",
    "documentCategory",
    "fieldPattern",
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
function parseReviewBy(raw: unknown, sourceDate: string): Date | null {
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
function quoteExists(quote: string, normalizedFull: string): boolean {
  const q = normalizeWs(quote);
  if (q.length === 0) return false;
  return normalizedFull.includes(q);
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── 헬퍼 ──────────────────────────────────────────────────
function extractJson(text: string): unknown {
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

function summarize(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function pct(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((passed / total) * 1000) / 10;
}

function contentTypeForExt(ext: string): string {
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".md") return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function safeName(name: string): string {
  const cleaned = name.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return cleaned || "source";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function readArg(name: string): string | undefined {
  const eqPrefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(eqPrefix));
  if (eq) return eq.slice(eqPrefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1) {
    const next = process.argv[idx + 1];
    if (next && !next.startsWith("--")) return next;
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function fail(code: string, hint: string): void {
  console.error(JSON.stringify({ ok: false, code, hint }, null, 2));
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCunoteDb();
  });
