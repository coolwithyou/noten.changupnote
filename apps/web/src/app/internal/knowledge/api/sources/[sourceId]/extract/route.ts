import { extname } from "node:path";

import { NextResponse } from "next/server";

import {
  PROMPT_VER,
  extractTextFromBytes,
  normalizeWs,
  resolveExtractionModel,
  resolveMaxTextChars,
  runLlmExtraction,
  validateCandidates,
} from "@/lib/server/knowledge/extraction";
import {
  countLessonsBySource,
  getKnowledgeSourceById,
  insertProposedLessons,
  updateKnowledgeSourceExtraction,
  type ProposedLessonInput,
} from "@/lib/server/knowledge/knowledgeRepo";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 추출은 PDF 파싱 + LLM 호출로 수 분이 걸릴 수 있다.
export const maxDuration = 300;

interface RouteContext {
  params: Promise<{ sourceId: string }>;
}

/**
 * 등록된 원천 문서에서 lesson 후보를 추출·적재한다(GUI "추출 실행").
 *
 * 인증: getReviewerIdentity(미인가 404).
 * 상태 가드(중복 적재 방지):
 *   - source 없음 → 404
 *   - status='curated' → 409(이미 큐레이션 완료)
 *   - status='extracted' 이고 lesson 이 1건 이상 → 409 already_extracted
 *   - 진행 대상: status='registered', 또는 status='extracted'+lesson 0건(이전 실패 재시도)
 * 파이프라인(CLI --write 경로와 동일 조립):
 *   R2 getObjectBytes → extractTextFromBytes → runLlmExtraction → validateCandidates
 *   → extracted-text.txt/extraction.json R2 업로드 → insertProposedLessons(성공 후)
 *   → updateKnowledgeSourceExtraction(status='extracted'). lesson insert 실패 시 source 를 extracted 로 만들지 않는다.
 */
export async function POST(_request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) return new NextResponse("Not Found", { status: 404 });

  const { sourceId } = await context.params;

  const source = await getKnowledgeSourceById(sourceId);
  if (!source) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  if (source.status === "curated") {
    return NextResponse.json(
      { ok: false, error: "already_curated", message: "이미 큐레이션이 완료된 원천입니다." },
      { status: 409 },
    );
  }
  if (source.status === "extracted") {
    const counts = await countLessonsBySource(sourceId);
    if (counts.total > 0) {
      return NextResponse.json(
        { ok: false, error: "already_extracted", message: "이미 추출된 원천입니다(lesson 존재)." },
        { status: 409 },
      );
    }
    // lesson 0건이면 이전 실패로 간주하고 재시도를 허용한다.
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    return NextResponse.json(
      { ok: false, error: "no_r2", message: "R2 스토리지 환경변수가 설정되지 않았습니다." },
      { status: 500 },
    );
  }

  // 1) R2 에서 원본 바이트 → 텍스트 추출.
  let extraction: { pages: Array<{ page: number; text: string }>; marked: string };
  try {
    const { body } = await storage.getObjectBytes(source.r2Key);
    const ext = extname(source.r2Key).toLowerCase();
    extraction = await extractTextFromBytes(ext, body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: "extract_error", message }, { status: 500 });
  }
  if (extraction.pages.length === 0 || extraction.marked.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "empty_extraction", message: "추출된 텍스트가 없습니다." },
      { status: 422 },
    );
  }

  const normalizedFull = normalizeWs(extraction.pages.map((p) => p.text).join("\n"));
  const maxTextChars = resolveMaxTextChars();
  const markedForLlm =
    extraction.marked.length > maxTextChars ? extraction.marked.slice(0, maxTextChars) : extraction.marked;

  // 2) LLM 추출 패스.
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "no_api_key", message: "ANTHROPIC_API_KEY 가 설정되지 않았습니다." },
      { status: 500 },
    );
  }
  const model = resolveExtractionModel();
  let rawCandidates;
  try {
    rawCandidates = await runLlmExtraction({
      apiKey,
      markedText: markedForLlm,
      programHint: source.programHint,
      institutionHint: source.institutionHint,
      kind: source.kind,
      sourceDate: source.sourceDate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: "llm_error", message }, { status: 502 });
  }

  // 3) 서버측 검증(추출 결과 신뢰 금지).
  const v = validateCandidates(rawCandidates, normalizedFull, source.sourceDate);

  // 4) 추출 산출물 R2 업로드(멱등 키 — 재시도 시 덮어쓰기).
  const prefix = `knowledge-sources/${source.sha256.slice(0, 12)}/`;
  const extractedTextKey = `${prefix}extracted-text.txt`;
  const extractionJsonKey = `${prefix}extraction.json`;
  try {
    await storage.putObject({
      key: extractedTextKey,
      body: extraction.marked,
      contentType: "text/plain; charset=utf-8",
    });
    await storage.putObject({
      key: extractionJsonKey,
      body: JSON.stringify({ model, promptVer: PROMPT_VER, candidates: rawCandidates }, null, 2),
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: "upload_failed", message }, { status: 502 });
  }

  // 5) lesson 적재(성공 후에만 source 를 extracted 로 전이). sourceRefs 에 sourceId 주입.
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

  let inserted;
  try {
    inserted = await insertProposedLessons(lessonsToInsert);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // lesson 적재 실패: source 상태를 바꾸지 않는다(재시도 가능).
    return NextResponse.json({ ok: false, error: "lesson_insert_failed", message }, { status: 500 });
  }

  // 6) 원천 문서에 추출 결과 반영.
  await updateKnowledgeSourceExtraction(source.id, {
    status: "extracted",
    extractedTextKey,
    extractionJsonKey,
    extractionModel: model,
    extractionPromptVer: PROMPT_VER,
    nonLessonItems: v.nonLessonItems,
  });

  return NextResponse.json({
    ok: true,
    summary: {
      lessonsInserted: inserted.length,
      nonLessonItems: v.nonLessonItems.length,
      counts: v.counts,
      quotePassRatePct: pct(v.quotePassed, v.quoteTotal),
      dropped: v.dropped.slice(0, 10),
    },
  });
}

function pct(passed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((passed / total) * 1000) / 10;
}
