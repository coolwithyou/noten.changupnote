/**
 * LLM 사전라벨 러너 — surface 검수 문서의 초기 fieldMap 을 채운다 (슬라이스 B2).
 *
 * 정본: docs/plans/2026-07-08-ideal-flow-vertical-slice.md "슬라이스 B — B2. LLM 사전라벨 러너".
 * 상위 기준서: docs/gate1-field-map-labeling-guide.md (라벨 판정 규칙 1~10 · 표준 key 사전 — 프롬프트 주입).
 *
 * 대상: docRef 가 'surface:' 로 시작하고 labelJson.fields 가 비었으며 review_status='pending' 인 문서.
 * 호출: generate-review-questions.ts 의 Anthropic vision 호출 패턴 재사용(fetch 직접, base64 이미지).
 *   page image 는 R2(pageImageKeys)에서 로드한다(spike 러너처럼 로컬 파일이 아님). 비용 가드로 문서당
 *   최대 --maxPages(기본 8) 페이지만 전송.
 *
 * 순환성 가드(가장 중요): 저장 시 review_status 를 절대 바꾸지 않는다(pending 유지). labeledBy 는
 *   `ai:<model>` 로 표식해, field-map-review-guard 가 검수 없는 golden 승격을 계속 차단하도록 한다.
 *   AI 라벨은 사람 검수 확정 전에는 어떤 사용자 노출/golden 에도 닿지 않는다.
 *
 * 응답 파싱은 순수 함수(reviewFieldMapping.parsePrelabelResponse)로 분리 — 단위 검증 가능.
 * 기본은 dry-run. --write 로 실제 DB 쓰기.
 *
 * 사용:
 *   pnpm prelabel:review-docs                                # dry-run (limit 5)
 *   pnpm prelabel:review-docs -- --write                     # 실제 사전라벨
 *   pnpm prelabel:review-docs -- --docId=s-1a2b3c4d --write
 *   pnpm prelabel:review-docs -- --limit=10 --maxPages=6 --write
 */
import { asc, eq, like } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { SURFACE_DOC_REF_PREFIX } from "./import-review-docs-from-surfaces";
import {
  parsePrelabelResponse,
  prelabelFieldToReviewField,
  type ReviewLabelField,
} from "../documents/reviewFieldMapping";

loadMonorepoEnv();

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_PRELABEL_MODEL?.trim() || "claude-sonnet-5";
const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_PAGES = 8;

// ── 기준서 규칙 요약 (프롬프트 주입) — generate-review-questions.RULES_SUMMARY 와 동일 정본 ──
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

[표준 fieldKey 사전 — 같은 의미면 문서가 달라도 같은 key]
company_name(기업명/상호), biz_reg_no(사업자등록번호), ceo_name(대표자 성명), founded_date(설립일/개업일),
address(소재지), industry(업종/업태), employee_count(상시 근로자 수), revenue(매출액), item_summary(사업/아이템 개요),
exec_plan(추진 계획), expected_effect(기대 효과), budget_table(사업비/예산 표), budget_basis(예산 산출근거),
rep_signature(대표자 서명/날인), consent_privacy(개인정보 동의).

[fieldType enum] text|long_text|number|date|currency|checkbox|table|file|signature|stamp|unknown
[좌표계 §8.4] bbox 는 페이지 크기 대비 0~1 정규화, 원점은 좌상단(top-left), [x, y, w, h] 순. 위치 특정이 곤란하면 bbox=null.`;

// ── CLI 인자 ──
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface DocStat {
  docId: string;
  docRef: string;
  pageImages: number;
  pagesSent: number;
  fieldsGenerated: number;
  dropped: number;
  action: "written" | "dry-run" | "skipped" | "error";
  reason?: string;
}

async function main() {
  if (hasFlag("help")) {
    console.log(
      [
        "Usage: pnpm prelabel:review-docs -- [--docId=s-xxxx] [--limit=5] [--maxPages=8] [--write]",
        "",
        "surface 검수 문서(fields 비어있고 pending)의 초기 fieldMap 을 LLM vision 으로 채운다.",
        "review_status 는 절대 바꾸지 않는다(pending 유지 — 순환성 가드). labeledBy=ai:<model>.",
        "기본은 dry-run. --write 로 실제 DB 쓰기.",
      ].join("\n"),
    );
    return;
  }

  const write = hasFlag("write");
  const limit = Math.max(1, Number(readArg("limit") ?? DEFAULT_LIMIT));
  const maxPages = Math.max(1, Number(readArg("maxPages") ?? DEFAULT_MAX_PAGES));
  const docIdFilter = readArg("docId")?.trim() || null;

  const db = getCunoteDb();

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error(JSON.stringify({ ok: false, code: "no_api_key", hint: "ANTHROPIC_API_KEY 필요" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    console.error(
      JSON.stringify(
        { ok: false, code: "r2_not_configured", hint: "R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL 필요" },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  // 대상: surface 네임스페이스 + pending. fields 비어있음 필터는 앱측에서(jsonb 배열 길이).
  let rows = await db
    .select()
    .from(schema.fieldMapReviewDocs)
    .where(
      docIdFilter
        ? eq(schema.fieldMapReviewDocs.docId, docIdFilter)
        : like(schema.fieldMapReviewDocs.docRef, `${SURFACE_DOC_REF_PREFIX}%`),
    )
    .orderBy(asc(schema.fieldMapReviewDocs.docId));

  rows = rows.filter((row) => {
    if (!row.docRef.startsWith(SURFACE_DOC_REF_PREFIX)) return false;
    if (row.reviewStatus !== "pending") return false;
    const labelJson = (row.labelJson ?? {}) as { fields?: unknown };
    const fields = Array.isArray(labelJson.fields) ? labelJson.fields : [];
    return fields.length === 0;
  });

  const targets = rows.slice(0, limit);
  const stats: DocStat[] = [];

  for (const row of targets) {
    try {
      const pageImageKeys = Array.isArray(row.pageImageKeys) ? row.pageImageKeys : [];
      const sendKeys = pageImageKeys.slice(0, maxPages);

      // R2 → base64 (없으면 스킵).
      const images: string[] = [];
      for (const key of sendKeys) {
        try {
          const { body } = await storage.getObjectBytes(key);
          if (body.length > 0) images.push(body.toString("base64"));
        } catch {
          // 이미지 로드 실패는 무시(부분 전송).
        }
      }

      if (images.length === 0) {
        stats.push({
          docId: row.docId,
          docRef: row.docRef,
          pageImages: pageImageKeys.length,
          pagesSent: 0,
          fieldsGenerated: 0,
          dropped: 0,
          action: "skipped",
          reason: "no_page_images_loaded",
        });
        continue;
      }

      const text = await callPrelabelLlm(apiKey, row.sourceFilename ?? row.docRef, images);
      const { fields: prelabel, dropped } = parsePrelabelResponse(text);
      const reviewFields: ReviewLabelField[] = prelabel.map(prelabelFieldToReviewField);

      if (write) {
        const baseLabel = (row.labelJson ?? {}) as Record<string, unknown>;
        const nextLabel = {
          ...baseLabel,
          fields: reviewFields,
          labeledBy: `ai:${MODEL}`,
          labeledAt: new Date().toISOString().slice(0, 10),
        };
        await db
          .update(schema.fieldMapReviewDocs)
          .set({
            labelJson: nextLabel,
            labeledBy: `ai:${MODEL}`,
            labeledAt: new Date().toISOString().slice(0, 10),
            // reviewStatus 는 갱신하지 않는다 (pending 유지 — 순환성 가드).
            updatedAt: new Date(),
          })
          .where(eq(schema.fieldMapReviewDocs.id, row.id));
      }

      stats.push({
        docId: row.docId,
        docRef: row.docRef,
        pageImages: pageImageKeys.length,
        pagesSent: images.length,
        fieldsGenerated: reviewFields.length,
        dropped: dropped.length,
        action: write ? "written" : "dry-run",
      });
    } catch (error) {
      stats.push({
        docId: row.docId,
        docRef: row.docRef,
        pageImages: Array.isArray(row.pageImageKeys) ? row.pageImageKeys.length : 0,
        pagesSent: 0,
        fieldsGenerated: 0,
        dropped: 0,
        action: "error",
        reason: (error as Error).message,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun: !write,
        model: MODEL,
        maxPages,
        totals: {
          targets: targets.length,
          eligible: rows.length,
          fieldsGenerated: stats.reduce((n, s) => n + s.fieldsGenerated, 0),
          errors: stats.filter((s) => s.action === "error").length,
        },
        perDoc: stats,
      },
      null,
      2,
    ),
  );
}

/** Anthropic Messages API vision 호출. 페이지 이미지 base64 를 첨부하고 structured JSON 을 요구한다. */
async function callPrelabelLlm(apiKey: string, sourceName: string, imagesBase64: string[]): Promise<string> {
  const system = `당신은 공공 지원사업 서식(HWP/PDF)의 "필드맵"을 만드는 라벨러다.
페이지 이미지를 보고, 지원자가 값을 하나 기입하거나 행동 하나를 해야 하는 최소 단위를 필드 1개로 라벨한다.

${RULES_SUMMARY}

[출력] 반드시 JSON 하나만. 마크다운/설명 금지:
{"fields":[{"label":"<사람이 읽는 항목명>","fieldKey":"<영문 snake_case, 표준 사전 우선>","fieldType":"<enum>",
"required":<bool>,"manual":<bool>,"section":"<소속 구획, 없으면 \\"\\">","page":<1기준 정수>,
"bbox":[x,y,w,h]|null,"sourceSpan":"<원문 근거 문구, 없으면 \\"\\">"}]}
- 순수 안내문/유의사항은 필드가 아니다. "~를 첨부하시오" 지시는 file 필드로.
- 위치를 특정하기 어려우면 bbox=null 로 두되 page 는 최대한 채운다.
- 자신 없는 항목은 fieldType=unknown 으로 두고 label 에 그대로 옮겨 사람이 검수하게 한다.`;

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `문서: ${sourceName}
첨부된 페이지 이미지(${imagesBase64.length}장)를 보고 위 규칙에 따라 필드맵 JSON 을 생성하라. 페이지 순서는 이미지 순서와 같다.`,
    },
  ];
  imagesBase64.forEach((b64, i) => {
    content.push({ type: "text", text: `↓ ${i + 1}페이지` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });
  });

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Number(process.env.PRELABEL_MAX_TOKENS ?? "8192"),
      system,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`anthropic_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCunoteDb();
  });
