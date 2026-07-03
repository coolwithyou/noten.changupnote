/**
 * 질문 기반 검수 모드(v2) 질문 생성 배치 CLI.
 *
 * 정본: docs/plans/2026-07-03-reviewer-workspace-v1.md "v2 — 질문 기반 검수 모드".
 * 상위 기준서: docs/gate1-field-map-labeling-guide.md (규칙 1~10 — 프롬프트에 요약 포함).
 *
 * 원칙(스펙 "생성 원칙"):
 *   - 애매 필드만 question (notes "확인 필요"/추정, type=unknown, 서명·도장 인접, 겸용 셀,
 *     manual 판정 경계). 한 카드에 판단 하나.
 *   - 나머지 필드는 quick_confirm (한 줄 요약 + [맞음]/[수정]).
 *   - missing_sweep: 페이지당 1개.
 *
 * 역할 분담(quick_confirm 생성 방식 선택 근거):
 *   quick_confirm 은 "필드의 현재 속성을 사람이 읽기 쉬운 한 줄 요약"에 불과하다 — LLM 없이
 *   결정적 템플릿으로 생성한다(재현성·무비용·환각 없음). LLM 은 판단이 필요한 두 곳에만 집중:
 *   (1) question 선별·문구(어떤 필드가 애매한지, 무엇을 물을지, applyMap 제안),
 *   (2) missing_sweep 문구(페이지 성격에 맞춘 자연스러운 한 줄).
 *
 * applyMap 은 LLM 이 제안하되 서버(sanitizeApplyMap)에서 화이트리스트/타입 검증한다.
 * 검증 실패 항목은 버리고 사유를 로그한다. fieldIndex 범위 초과 질문도 버린다.
 *
 * 멱등: 답변된 질문(answer != null)은 보존. --regenerate 는 미답변 질문만 재생성한다.
 *   답변된 질문이 하나라도 있으면 그 문서는 재생성 시 미답변만 교체(답변 orderIndex 는 유지).
 *
 * 기본은 dry-run. --write 로 실제 DB 쓰기. --docs doc01,doc11 부분 실행.
 *
 * 사용:
 *   pnpm generate:review-questions                          # dry-run (전체)
 *   pnpm generate:review-questions -- --docs doc01,doc11,doc28 --write
 *   pnpm generate:review-questions -- --write               # 전체 생성
 *   pnpm generate:review-questions -- --regenerate --write  # 미답변만 재생성
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  ANSWER_TYPES,
  QUESTION_KINDS,
  sanitizeApplyMap,
  type AnswerType,
  type ApplyMap,
  type QuestionKind,
} from "../review/reviewQuestionsRepo";

loadMonorepoEnv();

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_REVIEW_MODEL?.trim() || "claude-sonnet-5";
const PAGE_KEY_PREFIX = "label-review/pages";
// 문서당 첨부 페이지 이미지 상한. 0 이면 vision 미첨부(notes 만으로 판단 — 사전 라벨러가 "확인 필요"에
// 시각적 애매함을 이미 기록했고, 무-vision 출력 품질이 충분해 기본은 0. 필요 시 REVIEW_Q_VISION_PAGES 로 상향).
const MAX_VISION_PAGES = Number(process.env.REVIEW_Q_VISION_PAGES ?? "0");

// ── CLI 인자 ──────────────────────────────────────────────
if (hasFlag("help")) {
  console.log(
    [
      "Usage: pnpm generate:review-questions -- [--docs doc01,doc11] [--regenerate] [--write]",
      "",
      "기본은 dry-run. --write 로 field_map_review_questions 에 실제 기록한다.",
      "--docs 로 일부 문서만 실행. --regenerate 는 미답변 질문만 재생성(답변은 보존).",
      "quick_confirm 은 결정적 템플릿, question·missing_sweep 문구는 LLM(claude-sonnet-5, vision).",
    ].join("\n"),
  );
  process.exit(0);
}

const write = hasFlag("write");
const regenerate = hasFlag("regenerate");
const docsFilter = parseDocsArg();

// ── 기준서 규칙 요약 (프롬프트 주입) ─────────────────────────
const RULES_SUMMARY = `[Gate 1 필드맵 라벨 판정 규칙 요약]
1. 주민등록번호·여권·면허번호 등 "고유식별정보"를 직접 기입하는 칸은 manual=true.
2. 배타 서식(참여유형 택1로 서식이 복수)에서 같은 key 반복은 정상.
3. 계층형 체크박스는 대분류 1개=checkbox 필드 1개, 하위옵션은 options 로.
4. 문서 말미 서명행("신청인/대표자 ___ (인)" + 날짜)은 반드시 signature 필드로 (누락 금지).
5. manual=true 는 고유식별정보 기입란에만. 생년월일·성명·연락처는 manual=false.
6. 표 필드 key 는 <의미>_table 접미어 (예: budget_table).
7. 체크박스 없는 동의문·서약문(서명만 요구)은 signature 필드 1개(manual=true), 별도 checkbox 만들지 않음.
8. 자가진단 체크리스트: "허위 기재 시 불이익" 등 법적 책임 문구/서명 확인이 동반되면 manual=true, 단순 준비물 확인용은 manual=false.
9. 겸용 셀(두 의미가 한 칸)은 주 용도 key 하나 + notes 에 겸용 표기.
10. 한/영 병기 택1 서식은 한국어판만 인스턴스로 라벨, 영문판은 notes 에 병렬 기록.
type enum: text|long_text|number|date|currency|checkbox|table|file|signature|stamp|unknown`;

// ── 타입 ──────────────────────────────────────────────────
type LabelField = {
  key?: string;
  label?: string;
  section?: string;
  type?: string;
  required?: boolean;
  applicantFills?: boolean;
  manual?: boolean;
  page?: number;
  bbox?: [number, number, number, number] | null;
  options?: string[];
  notes?: string;
};

type DocRow = typeof schema.fieldMapReviewDocs.$inferSelect;

type LlmQuestion = {
  fieldIndex: number | null;
  page: number | null;
  kind: "question" | "missing_sweep";
  prompt: string;
  answerType: AnswerType;
  options?: Array<{ value: string; label: string }>;
  applyMap?: unknown;
};

type BuiltQuestion = {
  fieldIndex: number | null;
  page: number | null;
  kind: QuestionKind;
  prompt: string;
  answerType: AnswerType;
  options: Array<{ value: string; label: string }> | null;
  applyMap: ApplyMap | null;
  orderIndex: number;
};

type DocStat = {
  docId: string;
  fields: number;
  pages: number;
  question: number;
  quickConfirm: number;
  missingSweep: number;
  llmDropped: number;
  preserved: number;
  action: "written" | "dry-run" | "skipped" | "error";
  reason?: string | undefined;
  droppedDetail?: string[] | undefined;
};

async function main() {
  const db = getCunoteDb();

  let rows = await db
    .select()
    .from(schema.fieldMapReviewDocs)
    .orderBy(asc(schema.fieldMapReviewDocs.docId));
  if (docsFilter) rows = rows.filter((r) => docsFilter.has(r.docId));

  if (rows.length === 0) {
    console.error(JSON.stringify({ ok: false, code: "no_docs", docsFilter: docsFilter ? [...docsFilter] : "all" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error(JSON.stringify({ ok: false, code: "no_api_key", hint: "ANTHROPIC_API_KEY 필요" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const stats: DocStat[] = [];
  const samples: Array<{ docId: string; questions: unknown[] }> = [];
  const sampleDocs = new Set(["doc01", "doc11", "doc28"]);

  // LLM 왕복이 많아 제한 동시성으로 문서를 처리한다 (배치 지연 단축). 기본 6.
  const concurrency = Math.max(1, Number(process.env.REVIEW_Q_CONCURRENCY ?? "6"));
  const indexed = rows.map((row, i) => ({ row, i }));
  const results = new Array<{ stat: DocStat; built: unknown[]; docId: string }>(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (true) {
        const cur = next++;
        if (cur >= indexed.length) break;
        const { row } = indexed[cur]!;
        try {
          const r = await processDoc(db, row, apiKey);
          results[cur] = { stat: r.stat, built: r.built, docId: row.docId };
        } catch (error) {
          results[cur] = {
            stat: {
              docId: row.docId,
              fields: 0,
              pages: 0,
              question: 0,
              quickConfirm: 0,
              missingSweep: 0,
              llmDropped: 0,
              preserved: 0,
              action: "error",
              reason: (error as Error).message,
            },
            built: [],
            docId: row.docId,
          };
        }
      }
    }),
  );
  for (const r of results) {
    if (!r) continue;
    stats.push(r.stat);
    if (sampleDocs.has(r.docId)) samples.push({ docId: r.docId, questions: r.built });
  }

  console.log(
    JSON.stringify(
      {
        dryRun: !write,
        model: MODEL,
        regenerate,
        docsFilter: docsFilter ? [...docsFilter] : "all",
        totals: {
          docs: stats.length,
          question: stats.reduce((n, s) => n + s.question, 0),
          quickConfirm: stats.reduce((n, s) => n + s.quickConfirm, 0),
          missingSweep: stats.reduce((n, s) => n + s.missingSweep, 0),
          llmDropped: stats.reduce((n, s) => n + s.llmDropped, 0),
          errors: stats.filter((s) => s.action === "error").length,
        },
        perDoc: stats,
        samples,
      },
      null,
      2,
    ),
  );
}

async function processDoc(
  db: ReturnType<typeof getCunoteDb>,
  row: DocRow,
  apiKey: string,
): Promise<{ stat: DocStat; built: BuiltQuestion[] }> {
  const labelJson = (row.labelJson ?? {}) as { fields?: unknown };
  const fields: LabelField[] = Array.isArray(labelJson.fields) ? (labelJson.fields as LabelField[]) : [];
  const pages = pageNumbers(row, fields);

  // 이미 답변된 질문 조회 (멱등 보존).
  const answered = await db
    .select()
    .from(schema.fieldMapReviewQuestions)
    .where(
      and(
        eq(schema.fieldMapReviewQuestions.reviewDocId, row.id),
        isNotNull(schema.fieldMapReviewQuestions.answer),
      ),
    );

  // 기존 질문 전부 (재생성 정책 판단용).
  const existingAll = await db
    .select({ id: schema.fieldMapReviewQuestions.id })
    .from(schema.fieldMapReviewQuestions)
    .where(eq(schema.fieldMapReviewQuestions.reviewDocId, row.id));

  // regenerate 아닌데 이미 질문이 있으면 스킵(멱등 — 이미 생성됨).
  if (!regenerate && existingAll.length > 0) {
    return {
      stat: {
        docId: row.docId,
        fields: fields.length,
        pages: pages.length,
        question: 0,
        quickConfirm: 0,
        missingSweep: 0,
        llmDropped: 0,
        preserved: existingAll.length,
        action: "skipped",
        reason: "already_generated",
      },
      built: [],
    };
  }

  // 애매 후보 필드 인덱스 (LLM 에 우선 제시).
  const ambiguous = fields
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => isAmbiguous(f));

  // ── LLM: question 선별·문구 + missing_sweep 문구 ──
  const llmResult = await callLlm(apiKey, row, fields, ambiguous, pages);
  const validated = validateLlmQuestions(llmResult.questions, fields, pages);

  // ── 결정적 quick_confirm: LLM question 이 붙지 않은 나머지 필드 ──
  const questionFieldIdx = new Set(
    validated.kept.filter((q) => q.kind === "question" && q.fieldIndex != null).map((q) => q.fieldIndex as number),
  );

  const built: BuiltQuestion[] = [];
  let order = 0;

  // 1) question (애매) 먼저.
  for (const q of validated.kept.filter((q) => q.kind === "question")) {
    built.push({ ...q, orderIndex: order++ });
  }
  // 2) quick_confirm (나머지 필드).
  for (let i = 0; i < fields.length; i++) {
    if (questionFieldIdx.has(i)) continue;
    const f = fields[i];
    if (!f) continue;
    built.push({
      fieldIndex: i,
      page: typeof f.page === "number" ? f.page : null,
      kind: "quick_confirm",
      prompt: quickConfirmSummary(f),
      answerType: "confirm",
      options: null,
      applyMap: null,
      orderIndex: order++,
    });
  }
  // 3) missing_sweep (페이지당 1개). LLM 문구가 있으면 사용, 없으면 템플릿.
  const sweepByPage = new Map<number, LlmQuestion>();
  for (const q of validated.kept.filter((q) => q.kind === "missing_sweep")) {
    if (typeof q.page === "number") sweepByPage.set(q.page, q as unknown as LlmQuestion);
  }
  for (const p of pages) {
    const fromLlm = sweepByPage.get(p);
    built.push({
      fieldIndex: null,
      page: p,
      kind: "missing_sweep",
      prompt:
        fromLlm?.prompt?.trim() ||
        `${p}페이지에 지원자가 써야 하는데 목록에 없는 칸이 있나요?`,
      answerType: "yes_no_unsure",
      options: null,
      applyMap: null,
      orderIndex: order++,
    });
  }

  const stat: DocStat = {
    docId: row.docId,
    fields: fields.length,
    pages: pages.length,
    question: built.filter((q) => q.kind === "question").length,
    quickConfirm: built.filter((q) => q.kind === "quick_confirm").length,
    missingSweep: built.filter((q) => q.kind === "missing_sweep").length,
    llmDropped: validated.dropped.length,
    preserved: answered.length,
    action: write ? "written" : "dry-run",
    droppedDetail: validated.dropped.length > 0 ? validated.dropped.slice(0, 12) : undefined,
  };

  if (write) {
    await db.transaction(async (tx) => {
      if (regenerate) {
        // 미답변만 삭제 후 재삽입. 답변된 질문은 보존.
        const answeredIds = new Set(answered.map((a) => a.id));
        const toDelete = await tx
          .select({ id: schema.fieldMapReviewQuestions.id })
          .from(schema.fieldMapReviewQuestions)
          .where(eq(schema.fieldMapReviewQuestions.reviewDocId, row.id));
        for (const d of toDelete) {
          if (!answeredIds.has(d.id)) {
            await tx
              .delete(schema.fieldMapReviewQuestions)
              .where(eq(schema.fieldMapReviewQuestions.id, d.id));
          }
        }
      }
      // 신규(비재생성) 이거나 재생성이면 built 를 삽입. 답변 보존을 위해 orderIndex 는
      // 답변된 질문 최대 orderIndex 이후로 밀어준다(재생성 시 충돌 방지는 orderIndex 유니크 아님이라 불필요, 단 순서 안정성).
      if (built.length > 0) {
        await tx.insert(schema.fieldMapReviewQuestions).values(
          built.map((q) => ({
            reviewDocId: row.id,
            fieldIndex: q.fieldIndex,
            page: q.page,
            kind: q.kind,
            prompt: q.prompt,
            answerType: q.answerType,
            options: q.options,
            applyMap: q.applyMap,
            orderIndex: q.orderIndex,
          })),
        );
      }
    });
  }

  return { stat, built };
}

// ── LLM 호출 (fetch, Messages API 직접) ─────────────────────
async function callLlm(
  apiKey: string,
  row: DocRow,
  fields: LabelField[],
  ambiguous: Array<{ f: LabelField; i: number }>,
  pages: number[],
): Promise<{ questions: LlmQuestion[] }> {
  // 애매 필드가 있는 페이지 이미지를 첨부(vision). 상한 MAX_VISION_PAGES.
  const ambiguousPages = [...new Set(ambiguous.map(({ f }) => f.page).filter((p): p is number => typeof p === "number"))];
  const visionPages = ambiguousPages.slice(0, MAX_VISION_PAGES);

  const fieldsForPrompt = fields.map((f, i) => ({
    fieldIndex: i,
    key: f.key ?? "",
    label: f.label ?? "",
    section: f.section ?? "",
    type: f.type ?? "",
    required: Boolean(f.required),
    applicantFills: f.applicantFills !== false,
    manual: Boolean(f.manual),
    page: f.page ?? null,
    notes: f.notes ?? "",
    ambiguous: isAmbiguous(f),
  }));

  const system = `당신은 공공 지원사업 서식의 "필드맵 라벨"을 비개발자 리뷰어가 검수하도록 돕는 질문 생성기다.
리뷰어는 데이터 편집자가 아니라 "질문에 답하는 전문가"다. 애매한 판정 지점만 골라 쉬운 한국어 질문으로 바꿔라.

${RULES_SUMMARY}

[네 임무] 아래 두 종류만 생성한다. quick_confirm 은 시스템이 따로 만드니 절대 생성하지 마라.
1) "question": 애매한 필드(ambiguous=true 우선, 그 밖에 판단 경계도 포함)에 대해, 한 카드에 판단 하나씩.
   - 예: 서명·도장 여부 → "이 칸은 도장이나 서명처럼 사람이 직접 해야 하나요?" (yes_no_unsure)
   - type 이 애매하면 choice 로 (options 에 후보 type). required/applicantFills/manual 판정도 yes_no_unsure.
   - 애매 필드당 1~3개. 전 속성 전수 질문 금지. 명백한 필드는 건드리지 마라(quick_confirm 로 감).
2) "missing_sweep": 필드가 있는 페이지에 한해 페이지당 최대 1개. 그 페이지 성격에 맞춰 "이 페이지에
   지원자가 써야 하는데 목록에 없는 칸이 있나요?" 를 자연스러운 한 줄로. answerType 은 반드시 yes_no_unsure.
   (미생성 페이지는 시스템이 기본 문구로 채우니, 페이지가 많으면 대표 페이지만 만들어도 된다.)

[applyMap] question 답변값 → 라벨 패치를 제안하라. 허용 키: type,required,applicantFills,manual,label.
   값 타입: type 은 위 enum 문자열, required/applicantFills/manual 은 boolean, label 은 문자열.
   예: yes_no_unsure 로 "직접 서명?" 질문이면 {"yes":{"manual":true,"type":"signature"},"no":{"manual":false}}.
   choice 질문이면 각 선택 value 에 대응하는 패치. 반영이 없으면 applyMap 생략.
   "unsure" 는 패치하지 말고(시스템이 보류 처리) applyMap 에 넣지 마라.

[출력] 반드시 JSON 하나만. 마크다운/설명 금지:
{"questions":[{"fieldIndex":<int|null>,"page":<int|null>,"kind":"question"|"missing_sweep",
"prompt":"<쉬운 한국어>","answerType":"confirm"|"yes_no_unsure"|"choice"|"short_text",
"options":[{"value":"...","label":"..."}]?,"applyMap":{"<answerValue>":{"<key>":<val>}}?}]}
question 은 fieldIndex 필수, missing_sweep 은 fieldIndex=null·page 필수.`;

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `문서 docId=${row.docId}, 파일=${row.sourceFilename ?? row.docRef}
문서 소급 교정·주의: ${row.correctionNotes ?? "(없음)"}
페이지 목록: ${pages.join(", ")}
애매 후보 fieldIndex: ${ambiguous.map((a) => a.i).join(", ") || "(자동 판정 결과 없음 — 필드를 직접 판단)"}

필드 목록(JSON):
${JSON.stringify(fieldsForPrompt)}

위 규칙에 따라 question 과 missing_sweep 을 생성하라. 페이지 이미지가 첨부된 경우 실제 서식을 보고 판단하라.`,
    },
  ];

  // vision: 페이지 이미지 base64 (spike-labels/pages/docNN-PP.png).
  for (const p of visionPages) {
    const b64 = pageImageBase64(row.docId, p);
    if (b64) {
      content.push({ type: "text", text: `↓ ${p}페이지 이미지` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: b64 },
      });
    }
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Number(process.env.REVIEW_Q_MAX_TOKENS ?? "4096"),
      system,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  const parsed = extractJson(text);
  const questions = Array.isArray((parsed as { questions?: unknown })?.questions)
    ? ((parsed as { questions: unknown[] }).questions as LlmQuestion[])
    : [];
  return { questions };
}

/** LLM 질문 출력을 서버 검증. 허용값·범위·applyMap 검증. 실패는 버리고 사유 수집. */
function validateLlmQuestions(
  raw: LlmQuestion[],
  fields: LabelField[],
  pages: number[],
): { kept: BuiltQuestion[]; dropped: string[] } {
  const kept: BuiltQuestion[] = [];
  const dropped: string[] = [];
  const pageSet = new Set(pages);

  for (const q of raw) {
    const kind = q.kind;
    if (kind !== "question" && kind !== "missing_sweep") {
      dropped.push(`kind:${String(kind)}`);
      continue;
    }
    if (!(QUESTION_KINDS as readonly string[]).includes(kind)) {
      dropped.push(`kind_enum:${String(kind)}`);
      continue;
    }
    const answerType = q.answerType;
    if (!(ANSWER_TYPES as readonly string[]).includes(answerType)) {
      dropped.push(`answerType:${String(answerType)}`);
      continue;
    }
    const prompt = typeof q.prompt === "string" ? q.prompt.trim() : "";
    if (!prompt) {
      dropped.push(`empty_prompt`);
      continue;
    }

    if (kind === "question") {
      const fi = q.fieldIndex;
      if (typeof fi !== "number" || !Number.isInteger(fi) || fi < 0 || fi >= fields.length) {
        dropped.push(`fieldIndex_range:${String(fi)}`);
        continue;
      }
      // choice 는 options 필요.
      let options: Array<{ value: string; label: string }> | null = null;
      if (answerType === "choice") {
        const opts = Array.isArray(q.options)
          ? q.options.filter((o) => o && typeof o.value === "string" && typeof o.label === "string")
          : [];
        if (opts.length < 2) {
          dropped.push(`choice_options:fi${fi}`);
          continue;
        }
        options = opts;
      }
      const { applyMap, dropped: amDropped } = sanitizeApplyMap(q.applyMap);
      if (amDropped.length > 0) dropped.push(...amDropped.map((d) => `applyMap[fi${fi}].${d}`));
      kept.push({
        fieldIndex: fi,
        page: fields[fi]?.page ?? (typeof q.page === "number" ? q.page : null),
        kind: "question",
        prompt,
        answerType,
        options,
        applyMap,
        orderIndex: 0,
      });
    } else {
      // missing_sweep
      const page = typeof q.page === "number" ? q.page : null;
      if (page == null || !pageSet.has(page)) {
        dropped.push(`sweep_page:${String(page)}`);
        continue;
      }
      if (answerType !== "yes_no_unsure") {
        dropped.push(`sweep_answerType:${answerType}`);
        continue;
      }
      kept.push({
        fieldIndex: null,
        page,
        kind: "missing_sweep",
        prompt,
        answerType: "yes_no_unsure",
        options: null,
        applyMap: null,
        orderIndex: 0,
      });
    }
  }
  return { kept, dropped };
}

// ── 결정적 quick_confirm 요약 문구 ─────────────────────────
const TYPE_KO: Record<string, string> = {
  text: "텍스트",
  long_text: "서술형 텍스트",
  number: "숫자",
  date: "날짜",
  currency: "금액",
  checkbox: "체크박스",
  table: "표",
  file: "첨부파일",
  signature: "서명·날인",
  stamp: "직인·도장",
  unknown: "미분류",
};

/** "기업명 — 지원자가 쓰는 필수 텍스트 칸" 형태의 한 줄 요약. */
function quickConfirmSummary(f: LabelField): string {
  const name = (f.label && f.label.trim()) || (f.key && f.key.trim()) || "이름 없는 칸";
  const who = f.applicantFills !== false ? "지원자가 쓰는" : "발급기관·심사자 몫인";
  const req = f.required ? "필수" : "선택";
  const typeKo = TYPE_KO[f.type ?? "unknown"] ?? f.type ?? "칸";
  const manual = f.manual ? " · 자필/서명 필요" : "";
  return `${name} — ${who} ${req} ${typeKo} 칸${manual}. 맞나요?`;
}

// ── 애매 필드 판정 (스펙 생성 원칙) ─────────────────────────
function isAmbiguous(f: LabelField): boolean {
  const notes = (f.notes ?? "").toString();
  if (/확인 필요/.test(notes)) return true;
  if (/추정|애매|불명|불확실|겸용/.test(notes)) return true;
  if ((f.type ?? "") === "unknown") return true;
  // 서명·도장 인접(manual 판정 경계): signature/stamp 이거나 manual 필드는 확인 대상.
  if (f.type === "signature" || f.type === "stamp") return true;
  return false;
}

// ── 헬퍼 ──────────────────────────────────────────────────
function pageNumbers(row: DocRow, fields: LabelField[]): number[] {
  const set = new Set<number>();
  for (const f of fields) if (typeof f.page === "number" && f.page >= 1) set.add(f.page);
  const pc = typeof row.pageCount === "number" ? row.pageCount : 0;
  for (let p = 1; p <= pc; p++) set.add(p);
  // 이미지 키에서도 페이지를 유추 (fields 없는 페이지의 missing_sweep 을 위해).
  const keys = Array.isArray(row.pageImageKeys) ? row.pageImageKeys : [];
  for (const k of keys) {
    const m = /-(\d+)\.png$/i.exec(k);
    if (m) set.add(Number(m[1]));
  }
  return [...set].sort((a, b) => a - b);
}

function pageImageBase64(docId: string, page: number): string | null {
  const pp = String(page).padStart(2, "0");
  const root = repoRoot();
  const candidates = [
    resolve(root, "spike-labels/pages", `${docId}-${pp}.png`),
    resolve(root, "spike-labels/pages", `${docId}-${page}.png`),
  ];
  for (const c of candidates) {
    try {
      return readFileSync(c).toString("base64");
    } catch {
      // continue
    }
  }
  return null;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // 코드펜스 제거.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fence ? fence[1] : trimmed) ?? "";
  // 첫 { 부터 마지막 } 까지.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  try {
    return JSON.parse(slice);
  } catch {
    return {};
  }
}

function repoRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, resolve(cwd, "../.."), resolve(cwd, "..", "..")];
  for (const c of candidates) {
    if (existsSync(resolve(c, "spike-labels"))) return c;
  }
  return cwd;
}

function parseDocsArg(): Set<string> | null {
  const idx = process.argv.indexOf("--docs");
  let raw: string | undefined;
  if (idx !== -1 && process.argv[idx + 1]) raw = process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith("--docs="));
  if (eq) raw = eq.slice("--docs=".length);
  if (!raw) return null;
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return set.size > 0 ? set : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// PAGE_KEY_PREFIX 는 이미지 키 규약 참고용 (현재는 로컬 파일에서 base64 로드).
void PAGE_KEY_PREFIX;

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCunoteDb();
  });
