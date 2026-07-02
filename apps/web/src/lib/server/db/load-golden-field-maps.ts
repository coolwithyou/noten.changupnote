/**
 * Gate 1 필드맵 정답(golden_set kind=field_map) 적재 CLI.
 *
 * 상위 기준서: docs/gate1-field-map-labeling-guide.md
 * 마스터 설계: docs/public-support-application-guide-master-architecture.md (17장 Gate 1, 18장 지식 루프)
 *
 * 동작:
 *   - spike-labels/doc*.json 라벨 파일을 읽어 golden_set 에 kind='field_map' 로 적재한다.
 *   - ref = 라벨의 docRef, gold = 라벨 JSON 전체(docRef/labeledBy/labeledAt/pageCount/fields).
 *   - golden_ver 는 --goldenVer 인자, 없으면 기준서가 정한 기본값 'field_map_v0'.
 *
 * 순환성 가드(핵심 — 기준서 "AI 라벨을 검수 없이 golden 으로 승격 금지"):
 *   - labeledBy 가 AI 라벨러(opus/prelabel/ai/claude/gpt/sonnet/haiku/-model 등) 패턴이면 적재 거부.
 *   - 추가로 사람 검수자 표기(이메일 형태의 labeledBy 또는 reviewedBy)를 명시적으로 요구한다.
 *   - REVIEW-QUEUE.md 규약: 검수 완료 시 labeledBy 를 검수자(이메일)로 갱신한다.
 *   - 45문서 전부 미검수(labeledBy=opus-prelabel)인 현재는 0건 적재 + 문서별 스킵 사유 출력이 정상이다.
 *
 * 멱등성: 같은 (kind, ref, goldenVer) 가 이미 있으면 gold/curatedBy 를 갱신(upsert)하고 신규 삽입은 하지 않는다.
 *
 * 기본은 dry-run. --write 를 붙여야 실제로 DB 에 쓴다 (레포 CLI 관례와 동일).
 *
 * 사용:
 *   pnpm load:golden:field-maps                       # dry-run, 기본 golden_ver=field_map_v0
 *   pnpm load:golden:field-maps -- --write            # 실제 적재
 *   pnpm load:golden:field-maps -- --goldenVer=field_map_v1 --write
 *   pnpm load:golden:field-maps -- --dir=spike-labels --glob=doc
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const DEFAULT_GOLDEN_VER = "field_map_v0";
const DEFAULT_DIR = "spike-labels";
const DEFAULT_GLOB = "doc";

/**
 * AI 라벨러로 간주하여 거부하는 labeledBy 패턴.
 * 검수 없이 golden 으로 승격되는 순환성을 차단한다.
 */
const AI_LABELER_PATTERNS = [
  /prelabel/i,
  /\bopus\b/i,
  /\bsonnet\b/i,
  /\bhaiku\b/i,
  /\bclaude\b/i,
  /\bgpt\b/i,
  /\bgemini\b/i,
  /\bllm\b/i,
  /(^|[^a-z])ai([^a-z]|$)/i,
  /-?model$/i,
  /auto-?label/i,
];

if (hasFlag("help")) {
  console.log(
    [
      "Usage: pnpm load:golden:field-maps -- [--goldenVer=field_map_v0] [--dir=spike-labels] [--glob=doc] [--write]",
      "",
      "기본은 dry-run. --write 를 붙여야 golden_set 에 실제 적재한다.",
      "순환성 가드: labeledBy 가 AI 라벨러(opus-prelabel 등)이면 스킵한다. 검수자(이메일) 표기가 있어야 적재된다.",
    ].join("\n"),
  );
  process.exit(0);
}

const goldenVer = readArg("goldenVer")?.trim() || DEFAULT_GOLDEN_VER;
const dir = readArg("dir")?.trim() || DEFAULT_DIR;
const glob = readArg("glob")?.trim() || DEFAULT_GLOB;
const write = hasFlag("write");

type LabelField = Record<string, unknown>;
type LabelDoc = {
  docRef?: unknown;
  labeledBy?: unknown;
  reviewedBy?: unknown;
  labeledAt?: unknown;
  pageCount?: unknown;
  fields?: unknown;
};

type Decision = {
  file: string;
  docRef: string | null;
  labeledBy: string | null;
  reviewedBy: string | null;
  fieldCount: number | null;
  accepted: boolean;
  action: "insert" | "update" | "skip";
  reason: string;
  curatedBy: string | null;
};

async function main() {
  const root = repoRoot();
  const labelDir = resolve(root, dir);
  const files = listLabelFiles(labelDir, glob);

  if (files.length === 0) {
    console.error(JSON.stringify({ ok: false, code: "no_label_files", dir: labelDir, glob }, null, 2));
    process.exitCode = 1;
    return;
  }

  const db = getCunoteDb();
  const decisions: Decision[] = [];

  // 이메일 -> users.id 매핑 캐시 (curatedBy 채우기용).
  const userIdByEmail = new Map<string, string | null>();
  async function resolveUserId(email: string | null): Promise<string | null> {
    if (!email) return null;
    const key = email.toLowerCase();
    if (userIdByEmail.has(key)) return userIdByEmail.get(key) ?? null;
    const rows = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    const id = rows[0]?.id ?? null;
    userIdByEmail.set(key, id);
    return id;
  }

  for (const file of files) {
    const full = resolve(labelDir, file);
    let doc: LabelDoc;
    try {
      doc = JSON.parse(readFileSync(full, "utf8")) as LabelDoc;
    } catch (error) {
      decisions.push({
        file,
        docRef: null,
        labeledBy: null,
        reviewedBy: null,
        fieldCount: null,
        accepted: false,
        action: "skip",
        reason: `parse_error: ${(error as Error).message}`,
        curatedBy: null,
      });
      continue;
    }

    const docRef = typeof doc.docRef === "string" ? doc.docRef : null;
    const labeledBy = typeof doc.labeledBy === "string" ? doc.labeledBy : null;
    const reviewedBy = typeof doc.reviewedBy === "string" ? doc.reviewedBy : null;
    const fields = Array.isArray(doc.fields) ? (doc.fields as LabelField[]) : null;
    const fieldCount = fields?.length ?? null;

    if (!docRef) {
      decisions.push(skip(file, docRef, labeledBy, reviewedBy, fieldCount, "missing_docRef"));
      continue;
    }
    if (!fields) {
      decisions.push(skip(file, docRef, labeledBy, reviewedBy, fieldCount, "missing_fields_array"));
      continue;
    }

    const gate = evaluateReviewer(labeledBy, reviewedBy);
    if (!gate.ok) {
      decisions.push(skip(file, docRef, labeledBy, reviewedBy, fieldCount, gate.reason));
      continue;
    }

    // 사람 검수자 확정: curatedBy 는 검수자 이메일을 users 로 조회해 채운다(없으면 null).
    const curatedBy = await resolveUserId(gate.reviewer);

    // gold 는 라벨 JSON 전체를 저장한다 (기준서 "golden_set.gold 에 문서 단위로 저장").
    const gold = doc as unknown as Record<string, unknown>;

    const existing = await db
      .select({ id: schema.goldenSet.id })
      .from(schema.goldenSet)
      .where(
        and(
          eq(schema.goldenSet.kind, "field_map"),
          eq(schema.goldenSet.ref, docRef),
          eq(schema.goldenSet.goldenVer, goldenVer),
        ),
      )
      .limit(1);
    const exists = existing.length > 0;

    if (write) {
      if (exists) {
        await db
          .update(schema.goldenSet)
          .set({ gold, curatedBy })
          .where(eq(schema.goldenSet.id, existing[0].id));
      } else {
        await db.insert(schema.goldenSet).values({
          kind: "field_map",
          ref: docRef,
          gold,
          goldenVer,
          curatedBy,
        });
      }
    }

    decisions.push({
      file,
      docRef,
      labeledBy,
      reviewedBy,
      fieldCount,
      accepted: true,
      action: exists ? "update" : "insert",
      reason: exists ? "exists_upsert" : "new",
      curatedBy,
    });
  }

  const accepted = decisions.filter((d) => d.accepted);
  const inserted = accepted.filter((d) => d.action === "insert").length;
  const updated = accepted.filter((d) => d.action === "update").length;
  const skipped = decisions.filter((d) => !d.accepted);

  console.log(
    JSON.stringify(
      {
        dryRun: !write,
        goldenVer,
        dir: labelDir,
        glob,
        totals: {
          files: decisions.length,
          accepted: accepted.length,
          skipped: skipped.length,
          wouldInsert: !write ? inserted : undefined,
          wouldUpdate: !write ? updated : undefined,
          inserted: write ? inserted : undefined,
          updated: write ? updated : undefined,
        },
        skipReasons: summarize(skipped.map((d) => d.reason)),
        decisions: decisions.map((d) => ({
          file: d.file,
          docRef: d.docRef,
          labeledBy: d.labeledBy,
          accepted: d.accepted,
          action: d.action,
          reason: d.reason,
          fieldCount: d.fieldCount,
          curatedBy: d.curatedBy,
        })),
      },
      null,
      2,
    ),
  );
}

/**
 * 순환성 가드 판정.
 * - 검수자 표기(이메일 형태) 요구: reviewedBy(있으면 우선) 또는 labeledBy 가 이메일이어야 한다.
 * - AI 라벨러 패턴이면 거부.
 */
function evaluateReviewer(
  labeledBy: string | null,
  reviewedBy: string | null,
): { ok: true; reviewer: string } | { ok: false; reason: string } {
  const reviewer = (reviewedBy ?? labeledBy ?? "").trim();
  if (!reviewer) {
    return { ok: false, reason: "no_labeledBy" };
  }
  if (isAiLabeler(reviewer)) {
    return { ok: false, reason: `ai_labeler_unreviewed:${reviewer}` };
  }
  if (!isReviewerEmail(reviewer)) {
    // 사람 검수자는 이메일로 표기한다(기준서 예시 reviewer@ba-ton.kr, REVIEW-QUEUE 규약).
    return { ok: false, reason: `not_human_reviewer:${reviewer}` };
  }
  return { ok: true, reviewer };
}

function isAiLabeler(value: string): boolean {
  return AI_LABELER_PATTERNS.some((re) => re.test(value));
}

function isReviewerEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function skip(
  file: string,
  docRef: string | null,
  labeledBy: string | null,
  reviewedBy: string | null,
  fieldCount: number | null,
  reason: string,
): Decision {
  return {
    file,
    docRef,
    labeledBy,
    reviewedBy,
    fieldCount,
    accepted: false,
    action: "skip",
    reason,
    curatedBy: null,
  };
}

function summarize(reasons: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of reasons) {
    // 값 부분(:xxx)은 접두어로 집계.
    const key = raw.includes(":") ? `${raw.slice(0, raw.indexOf(":"))}` : raw;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function listLabelFiles(labelDir: string, prefix: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(labelDir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
}

function repoRoot(): string {
  // apps/web 에서 tsx 로 실행되든 레포 루트에서 실행되든 spike-labels 를 찾는다.
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
