/**
 * 운영 지식 인제스천 CLI — 운영 보고 문서 1건을 등록·추출해 lesson 후보를 만든다.
 *
 * 설계: docs/plans/2026-07-05-ops-knowledge-ingestion.md §6(추출 패스)·§8(리스크).
 * 선례: generate-review-questions.ts(Anthropic 직접 fetch·dry-run 기본·서버측 sanitize),
 *       load-golden-field-maps.ts(dry-run 가드), r2ObjectStorage(업로드 헬퍼).
 *
 * 이 파일은 추출 파이프라인(extraction.ts)을 소비하는 얇은 셸이다.
 *   텍스트 추출·LLM 추출·서버측 검증·프롬프트는 extraction.ts 가 단일 원천이며(GUI 추출 API 와 공유),
 *   여기서는 CLI 인자 파싱·멱등 가드·dry-run 리포트 출력·--write 적재만 담당한다.
 *
 * 흐름:
 *   1) 파일(.pdf/.txt/.md) 읽기 → sha256 → 같은 sha256 원천이 있으면 "이미 등록됨" 안내 후 종료(멱등).
 *   2) 텍스트 추출: extractTextFromBytes([page N] 마커 합성).
 *   3) LLM 추출 패스: runLlmExtraction(항목 5분류, 원문 인용 필수).
 *   4) 서버측 검증(추출 결과 신뢰 금지): validateCandidates(화이트리스트·필수필드·scope 축·quote 실재).
 *   5) dry-run(기본): 분류별 카운트·lesson 후보 목록·quote 통과율 출력. DB/R2/네트워크 쓰기 없음(LLM 호출은 함).
 *   6) --write: R2 업로드 + knowledge_sources insert(status='extracted') + lesson 후보 review_lessons(proposed) batch insert.
 *
 * 사용:
 *   pnpm ingest:knowledge -- --file <경로> [--kind ops_interview] [--title "..."] [--program "LIPS/TIPS"]
 *       [--institution "..."] [--source-date 2026-07-01] [--uploaded-by email] [--write]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { closeCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import {
  KNOWLEDGE_SOURCE_KINDS,
  findSourceBySha256,
  insertKnowledgeSource,
  insertProposedLessons,
  type KnowledgeSourceKind,
  type ProposedLessonInput,
} from "./knowledgeRepo";
import {
  PROMPT_VER,
  contentTypeForExt,
  extractTextFromBytes,
  normalizeWs,
  resolveExtractionModel,
  resolveMaxTextChars,
  runLlmExtraction,
  safeName,
  summarize,
  validateCandidates,
  type RawCandidate,
} from "./extraction";

loadMonorepoEnv();

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
  const model = resolveExtractionModel();

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
    extraction = await extractTextFromBytes(ext, bytes);
  } catch (error) {
    fail("extract_error", (error as Error).message);
    return;
  }
  if (extraction.pages.length === 0 || extraction.marked.trim().length === 0) {
    fail("empty_extraction", "추출된 텍스트가 없습니다.");
    return;
  }
  const normalizedFull = normalizeWs(extraction.pages.map((p) => p.text).join("\n"));
  const maxTextChars = resolveMaxTextChars();
  const truncated = extraction.marked.length > maxTextChars;
  const markedForLlm = truncated ? extraction.marked.slice(0, maxTextChars) : extraction.marked;

  // 3) LLM 추출 패스.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    fail("no_api_key", "ANTHROPIC_API_KEY 가 필요합니다(.env).");
    return;
  }
  let rawCandidates: RawCandidate[];
  try {
    rawCandidates = await runLlmExtraction({
      apiKey,
      markedText: markedForLlm,
      programHint,
      institutionHint,
      kind: kindArg,
      sourceDate: sourceDateArg,
    });
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
    model,
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
    body: JSON.stringify({ model, promptVer: PROMPT_VER, candidates: rawCandidates }, null, 2),
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
    extractionModel: model,
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

// ── 헬퍼(CLI 전용) ─────────────────────────────────────────
function pct(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((passed / total) * 1000) / 10;
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
