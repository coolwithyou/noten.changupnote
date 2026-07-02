/**
 * 리뷰어 워크스페이스 시드 임포트 CLI (마스터 9.8, docs/plans/2026-07-03-reviewer-workspace-v1.md).
 *
 * 동작:
 *   - spike-labels/doc*.json 을 field_map_review_docs 로 upsert 한다 (docRef 기준, 멱등).
 *     · 이미 approved 인 행은 건드리지 않는다 (검수 결과 보호).
 *   - spike-labels/pages/docNN-PP.png 를 R2 로 업로드한다 (키 label-review/pages/docNN-PP.png, 존재하면 스킵).
 *   - REVIEW-QUEUE.md 의 문서별 소급 교정·주의 항목을 correctionNotes 로 주입한다 (하드코딩 시드 맵).
 *
 * 순환성 주의: 이 임포트는 golden 승격이 아니라 "검수 대기 큐" 적재다. labeledBy=opus-prelabel 그대로 저장하고
 *   reviewStatus='pending' 으로 둔다. golden 승격은 /internal/review 확정 경로에서만 일어난다.
 *
 * 기본은 dry-run. --write 를 붙여야 실제로 DB 쓰기 + R2 업로드가 일어난다 (레포 CLI 관례).
 *
 * 사용:
 *   pnpm import:review-docs                # dry-run
 *   pnpm import:review-docs -- --write     # 실제 임포트
 *   pnpm import:review-docs -- --dir=spike-labels --write
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const DEFAULT_DIR = "spike-labels";
const PAGE_KEY_PREFIX = "label-review/pages";
const PAGE_UPLOAD_CONCURRENCY = 8;

/** 제한 동시성으로 매핑한다 (순서 보존). */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * REVIEW-QUEUE.md 유래 문서별 소급 교정·주의 항목 (1회성 시드, 하드코딩 허용).
 * 키는 docId (doc05 등). 검수자가 상세 화면 상단에서 먼저 확인한다.
 */
const CORRECTION_NOTES: Record<string, string> = {
  doc05: "규칙 5 소급: 생년월일 단독란을 manual=false로 재분류. (고유식별정보만 manual)",
  doc10: "규칙 4 소급: 말미 서명행 signature 필드 추가 (doc11과 통일).",
  doc13:
    "규칙 8: 적정성확인서를 법적 책임 문구 기준으로 manual 재판정. 사업비/매출/이력 표 canonical key 통일(budget_table 계열).",
  doc22:
    "규칙 8: 자격확인 체크표를 법적 책임 문구 기준으로 manual 재판정.",
  doc23:
    "규칙 5 재확인: 주민번호 기입란은 manual 유지, 생년월일류가 섞였는지 재확인.",
  doc28:
    "배치3 추가 교정: 창업구분·주요기술구분 체크 옵션이 렌더 이미지에서 안 보임(원본 드롭다운 추정) — 원본 HWP로 옵션 확정(규칙 9 적용 여부 포함).",
  doc29:
    "규칙 5 재확인: 주민번호 기입란은 manual 유지, 생년월일류가 섞였는지 재확인.",
  doc51:
    "규칙 10: 한/영 병기 — 한국어판만 인스턴스로 라벨. 제출용/참고용 라벨 충돌 확인.",
  doc53:
    "배치4 주의: 공고문+양식 합본 — 양식 시작 페이지 경계 확인(파일명만으로 판별 불가 사례).",
  doc54:
    "배치4 주의: batch3 doc16과 동일 공고의 .doc 인스턴스 — key 일치 여부 대조(form template 재사용 검증).",
};

type LabelDoc = {
  docRef?: unknown;
  labeledBy?: unknown;
  labeledAt?: unknown;
  pageCount?: unknown;
  fields?: unknown;
};

type DocAction = "insert" | "update" | "skip_approved" | "skip_error";

type Decision = {
  file: string;
  docId: string;
  docRef: string | null;
  fieldCount: number | null;
  docAction: DocAction;
  reason: string;
  pagesFound: number;
  pagesUploaded: number;
  pagesSkipped: number;
};

if (hasFlag("help")) {
  console.log(
    [
      "Usage: pnpm import:review-docs -- [--dir=spike-labels] [--write]",
      "",
      "기본은 dry-run. --write 를 붙여야 field_map_review_docs 적재 + R2 페이지 업로드가 일어난다.",
      "이미 approved 인 문서는 건드리지 않는다. R2 키가 이미 있으면 업로드를 스킵한다(멱등).",
    ].join("\n"),
  );
  process.exit(0);
}

const dir = readArg("dir")?.trim() || DEFAULT_DIR;
const write = hasFlag("write");

async function main() {
  const root = repoRoot();
  const labelDir = resolve(root, dir);
  const pagesDir = resolve(labelDir, "pages");
  const files = listLabelFiles(labelDir);

  if (files.length === 0) {
    console.error(JSON.stringify({ ok: false, code: "no_label_files", dir: labelDir }, null, 2));
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

  const db = getCunoteDb();
  const decisions: Decision[] = [];

  for (const file of files) {
    const docId = file.replace(/\.json$/i, "");
    const full = resolve(labelDir, file);

    let doc: LabelDoc;
    try {
      doc = JSON.parse(readFileSync(full, "utf8")) as LabelDoc;
    } catch (error) {
      decisions.push(errDecision(file, docId, `parse_error: ${(error as Error).message}`));
      continue;
    }

    const docRef = typeof doc.docRef === "string" ? doc.docRef : null;
    const fields = Array.isArray(doc.fields) ? doc.fields : null;
    if (!docRef) {
      decisions.push(errDecision(file, docId, "missing_docRef"));
      continue;
    }
    if (!fields) {
      decisions.push(errDecision(file, docId, "missing_fields_array"));
      continue;
    }

    const labeledBy = typeof doc.labeledBy === "string" ? doc.labeledBy : null;
    const labeledAt = typeof doc.labeledAt === "string" ? doc.labeledAt : null;
    const pageCount = typeof doc.pageCount === "number" ? doc.pageCount : null;
    const sourceFilename = deriveSourceFilename(docRef);
    const correctionNotes = CORRECTION_NOTES[docId] ?? null;

    // 페이지 이미지 업로드 (존재하면 스킵). R2 왕복이 많아 문서 내에서 제한 동시성으로 처리한다.
    const pageFiles = listPageFiles(pagesDir, docId);
    const pageImageKeys = pageFiles.map((pageFile) => `${PAGE_KEY_PREFIX}/${pageFile}`);
    let uploaded = 0;
    let skippedPages = 0;
    if (write) {
      const results = await mapWithConcurrency(pageFiles, PAGE_UPLOAD_CONCURRENCY, async (pageFile) => {
        const key = `${PAGE_KEY_PREFIX}/${pageFile}`;
        if (await storage.objectExists(key)) return "skipped" as const;
        const body = readFileSync(resolve(pagesDir, pageFile));
        await storage.putObject({ key, body, contentType: "image/png" });
        return "uploaded" as const;
      });
      uploaded = results.filter((r) => r === "uploaded").length;
      skippedPages = results.filter((r) => r === "skipped").length;
    }

    // 기존 행 조회 (approved 보호).
    const existing = await db
      .select({ id: schema.fieldMapReviewDocs.id, reviewStatus: schema.fieldMapReviewDocs.reviewStatus })
      .from(schema.fieldMapReviewDocs)
      .where(eq(schema.fieldMapReviewDocs.docRef, docRef))
      .limit(1);
    const existingRow = existing[0];
    const exists = existingRow !== undefined;

    if (existingRow && existingRow.reviewStatus === "approved") {
      decisions.push({
        file,
        docId,
        docRef,
        fieldCount: fields.length,
        docAction: "skip_approved",
        reason: "already_approved",
        pagesFound: pageFiles.length,
        pagesUploaded: uploaded,
        pagesSkipped: skippedPages,
      });
      continue;
    }

    const labelJson = doc as unknown as Record<string, unknown>;

    if (write) {
      if (existingRow) {
        await db
          .update(schema.fieldMapReviewDocs)
          .set({
            docId,
            sourceFilename,
            pageCount,
            labelJson,
            labeledBy,
            labeledAt,
            correctionNotes,
            pageImageKeys,
            updatedAt: new Date(),
          })
          .where(eq(schema.fieldMapReviewDocs.id, existingRow.id));
      } else {
        await db.insert(schema.fieldMapReviewDocs).values({
          docRef,
          docId,
          sourceFilename,
          pageCount,
          labelJson,
          labeledBy,
          labeledAt,
          reviewStatus: "pending",
          correctionNotes,
          pageImageKeys,
        });
      }
    }

    decisions.push({
      file,
      docId,
      docRef,
      fieldCount: fields.length,
      docAction: exists ? "update" : "insert",
      reason: exists ? "exists_upsert" : "new",
      pagesFound: pageFiles.length,
      pagesUploaded: uploaded,
      pagesSkipped: skippedPages,
    });
  }

  const inserted = decisions.filter((d) => d.docAction === "insert").length;
  const updated = decisions.filter((d) => d.docAction === "update").length;
  const skippedApproved = decisions.filter((d) => d.docAction === "skip_approved").length;
  const errors = decisions.filter((d) => d.docAction === "skip_error").length;
  const totalPagesFound = decisions.reduce((n, d) => n + d.pagesFound, 0);
  const totalPagesUploaded = decisions.reduce((n, d) => n + d.pagesUploaded, 0);
  const totalPagesSkipped = decisions.reduce((n, d) => n + d.pagesSkipped, 0);
  const totalKeys = decisions.reduce((n, d) => n + d.pagesFound, 0);
  const correctionNotesCount = decisions.filter((d) => CORRECTION_NOTES[d.docId]).length;

  console.log(
    JSON.stringify(
      {
        dryRun: !write,
        dir: labelDir,
        pageKeyPrefix: PAGE_KEY_PREFIX,
        totals: {
          files: decisions.length,
          inserted,
          updated,
          skippedApproved,
          errors,
          pageImageKeys: totalKeys,
          pagesFound: totalPagesFound,
          pagesUploaded: write ? totalPagesUploaded : undefined,
          pagesSkippedExisting: write ? totalPagesSkipped : undefined,
          correctionNotesInjected: correctionNotesCount,
        },
        decisions,
      },
      null,
      2,
    ),
  );
}

function deriveSourceFilename(docRef: string): string {
  const idx = docRef.lastIndexOf(":");
  return idx === -1 ? docRef : docRef.slice(idx + 1);
}

function errDecision(file: string, docId: string, reason: string): Decision {
  return {
    file,
    docId,
    docRef: null,
    fieldCount: null,
    docAction: "skip_error",
    reason,
    pagesFound: 0,
    pagesUploaded: 0,
    pagesSkipped: 0,
  };
}

function listLabelFiles(labelDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(labelDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^doc\d+\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
}

function listPageFiles(pagesDir: string, docId: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(pagesDir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${docId}-\\d+\\.png$`, "i");
  return entries.filter((name) => re.test(name)).sort((a, b) => a.localeCompare(b));
}

function repoRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, resolve(cwd, "../.."), resolve(cwd, "..", "..")];
  for (const c of candidates) {
    try {
      readdirSync(resolve(c, DEFAULT_DIR));
      return c;
    } catch {
      // continue
    }
  }
  return cwd;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeCunoteDb();
  });
