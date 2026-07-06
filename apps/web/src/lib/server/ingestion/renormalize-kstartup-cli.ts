/**
 * K-Startup 공고 criteria 재정규화(백필) CLI.
 *
 * 배경: packages/core/src/kstartup/normalize.ts 에 업종 룰이 추가된 뒤,
 * 기존 DB(grant_criteria)에는 룰 적용 전 산출물(industry `text_only` placeholder)이 남아 있다.
 * 이 CLI는 grant_raw 원본 payload 로 결정적 룰 파서(buildKStartupCriteria)를 다시 돌려
 * 각 공고의 criteria 를 현행 룰 기준으로 재정규화한다.
 *
 * 실행:
 *   # dry-run (기본, DB 무변경) — text_only placeholder 를 가진 kstartup 공고 대상
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *     apps/web/src/lib/server/ingestion/renormalize-kstartup-cli.ts --dry-run
 *
 *   # dry-run 전체(kstartup 전 공고) — 검증/드리프트 점검용
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *     apps/web/src/lib/server/ingestion/renormalize-kstartup-cli.ts --dry-run --all
 *
 *   # 실제 반영(검수자 전용 — 이 세션에서 실행 금지). --limit 로 샘플 실행 가능
 *   pnpm exec tsx --tsconfig apps/web/tsconfig.json \
 *     apps/web/src/lib/server/ingestion/renormalize-kstartup-cli.ts --execute --limit=50
 *
 * 옵션:
 *   --dry-run       기본값. DB 를 절대 건드리지 않고 통계만 산출한다.
 *   --execute       공고 단위로 재발행(criteria delete+reinsert). --dry-run 과 동시 지정 시 dry-run 우선(안전).
 *   --all           kstartup 전 공고를 대상으로. 미지정 시 industry text_only placeholder 보유 공고만.
 *   --limit=N       대상 공고 수 상한(샘플 실행/점검용).
 *   --batch=N       DB fetch 배치 크기(기본 500).
 *
 * 안전 보증: DB 쓰기 경로(publishKStartupGrants)는 오직 `mode === "execute"` 분기 안에만 존재한다.
 * dry-run 경로는 select 만 수행하며 어떤 쓰기도 하지 않는다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  buildKStartupCriteria,
  classifyKStartupIndustry,
  normalizeKStartupAnnouncement,
  INDUSTRY_ANY_PATTERN,
  INDUSTRY_RULES,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { publishKStartupGrants } from "./kstartupPublisher";

loadMonorepoEnv();

if (hasFlag("help")) {
  console.log(
    [
      "Usage: renormalize-kstartup-cli [--dry-run] [--execute] [--all] [--limit=N] [--batch=N]",
      "",
      "기본 모드는 dry-run (DB 무변경). --execute 는 검수자 전용.",
      "--all 미지정 시 industry text_only placeholder 보유 kstartup 공고만 대상.",
    ].join("\n"),
  );
  process.exit(0);
}

// --execute 와 --dry-run 동시 지정 시 안전을 위해 dry-run 을 우선한다.
const mode: "dry-run" | "execute" = hasFlag("execute") && !hasFlag("dry-run") ? "execute" : "dry-run";
const all = hasFlag("all");
// --dump: 구조화/전업종/가드발화 후보의 전체 레코드(캡 없음, 신청대상 원문 포함)를
// .renorm-analysis/ 에 JSONL 로 덤프한다. 로컬 정밀도 분석 전용(커밋 대상 아님).
const dump = hasFlag("dump");
const limit = readNumberArg("limit");
const batchSize = boundedInteger(readArg("batch"), 500, 1, 2_000);

// ---------------------------------------------------------------------------
// 진단 로직은 normalize.ts 의 export(classifyKStartupIndustry / INDUSTRY_ANY_PATTERN /
// INDUSTRY_RULES)를 그대로 import 해서 사용한다. 상수 복제(드리프트) 없음 — 단일 원천은
// packages/core/src/kstartup/normalize.ts. 아래 통계는 그 분류기의 outcome 을 집계한 것이다.
// ---------------------------------------------------------------------------
function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstSentenceWith(text: string, pattern: RegExp): string {
  const normalized = clean(text);
  const parts = normalized.split(/[\r\n.。]+/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => pattern.test(part)) ?? normalized.slice(0, 120);
}

function combinedText(ann: KStartupAnnouncement): string {
  return [ann.aply_trgt_ctnt, ann.aply_excl_trgt_ctnt].map(clean).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// 통계 누산기
// ---------------------------------------------------------------------------
interface StructuredSample {
  sourceId: string;
  title: string;
  sourceSpan: string;
  codes: string[];
  labels: string[];
}
interface NationwideSample {
  sourceId: string;
  title: string;
  sentence: string;
}
interface FailureRecord {
  sourceId: string;
  error: string;
}

const RULE_LABELS = INDUSTRY_RULES.map((rule) => rule.labels[0] ?? "unknown");
const ruleBreakdown: Record<string, number> = Object.fromEntries(RULE_LABELS.map((label) => [label, 0]));

const dimBefore: Record<string, number> = {};
const dimAfter: Record<string, number> = {};

const structuredSamples: StructuredSample[] = [];
const nationwideSamples: NationwideSample[] = [];
const failures: FailureRecord[] = [];

// --dump 전용 전체 레코드(캡 없음). 정밀도 실측 코퍼스.
interface DumpStructured {
  sourceId: string;
  title: string;
  ruleLabel: string;
  codes: string[];
  sourceSpan: string;
  applyText: string;
  exclText: string;
  rawApply: string;
  rawExcl: string;
}
interface DumpNationwide {
  sourceId: string;
  title: string;
  sentence: string;
  applyText: string;
  exclText: string;
}
const dumpStructured: DumpStructured[] = [];
const dumpNationwide: DumpNationwide[] = [];
const dumpGuardFired: DumpStructured[] = [];

let targetGrantCount = 0;
let processed = 0;
let unprocessable = 0; // grant_raw payload 미보유
let placeholderSubjects = 0; // 기존에 industry text_only placeholder 를 가졌던 공고
let nonPlaceholderProcessed = 0; // --all 에서 placeholder 가 없던 공고
let nationwideRemoved = 0; // ① 전업종 감지 → placeholder 제거
let ruleStructured = 0; // ② 명시 룰 구조화(operator "in")
let placeholderRetained = 0; // ③ placeholder 잔존(text_only)
let guardFired = 0; // ③ 중 문맥 가드로 구조화가 차단된 건
let plainPlaceholder = 0; // ③ 중 애초에 매칭 룰이 없던 건
let criteriaBefore = 0;
let criteriaAfter = 0;
let published = 0;
let failed = 0;

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function toAnnouncement(payload: Record<string, unknown> | null): KStartupAnnouncement | null {
  if (!payload) return null;
  return payload as unknown as KStartupAnnouncement;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const db = getCunoteDb();

try {
  if (mode === "execute") {
    console.error("[renormalize-kstartup] EXECUTE 모드 — DB 쓰기가 발생합니다.");
  }

  // 재발행 시 ingestion 커서(lastPage)를 손상시키지 않도록 현재 값을 보존한다.
  const [cursor] = await db
    .select({ lastPage: schema.sourceCursor.lastPage })
    .from(schema.sourceCursor)
    .where(eq(schema.sourceCursor.source, "kstartup"));
  const preservedLastPage = cursor?.lastPage ?? 1;

  const targetIds = await loadTargetGrantIds(db, all);
  targetGrantCount = targetIds.length;
  const scopedIds = typeof limit === "number" ? targetIds.slice(0, limit) : targetIds;

  for (const ids of chunk(scopedIds, batchSize)) {
    const grantRows = await db
      .select({
        id: schema.grants.id,
        sourceId: schema.grants.sourceId,
        title: schema.grants.title,
        payload: schema.grantRaw.payload,
        collectedAt: schema.grantRaw.collectedAt,
      })
      .from(schema.grants)
      .leftJoin(
        schema.grantRaw,
        and(
          eq(schema.grantRaw.source, schema.grants.source),
          eq(schema.grantRaw.sourceId, schema.grants.sourceId),
        ),
      )
      .where(inArray(schema.grants.id, ids));

    const critRows = await db
      .select({
        grantId: schema.grantCriteria.grantId,
        dimension: schema.grantCriteria.dimension,
        operator: schema.grantCriteria.operator,
      })
      .from(schema.grantCriteria)
      .where(inArray(schema.grantCriteria.grantId, ids));

    const critByGrant = new Map<string, Array<{ dimension: string; operator: string }>>();
    for (const row of critRows) {
      const list = critByGrant.get(row.grantId) ?? [];
      list.push({ dimension: row.dimension, operator: row.operator });
      critByGrant.set(row.grantId, list);
    }

    for (const row of grantRows) {
      const ann = toAnnouncement(row.payload);
      if (!ann) {
        unprocessable++;
        continue;
      }

      const oldCriteria = critByGrant.get(row.id) ?? [];
      const newCriteria = buildKStartupCriteria(ann);
      const oldHadTextOnly = oldCriteria.some(
        (c) => c.dimension === "industry" && c.operator === "text_only",
      );

      processed++;
      criteriaBefore += oldCriteria.length;
      criteriaAfter += newCriteria.length;
      for (const c of oldCriteria) bump(dimBefore, c.dimension);
      for (const c of newCriteria) bump(dimAfter, c.dimension);

      const newIndustry = newCriteria.find((c) => c.dimension === "industry");

      if (oldHadTextOnly) {
        placeholderSubjects++;
        if (!newIndustry) {
          // ① 전업종/업종무관 감지 → placeholder 미생성
          nationwideRemoved++;
          if (nationwideSamples.length < 5) {
            nationwideSamples.push({
              sourceId: row.sourceId,
              title: row.title,
              sentence: firstSentenceWith(combinedText(ann), INDUSTRY_ANY_PATTERN),
            });
          }
          if (dump) {
            dumpNationwide.push({
              sourceId: row.sourceId,
              title: row.title,
              sentence: firstSentenceWith(combinedText(ann), INDUSTRY_ANY_PATTERN),
              applyText: clean(ann.aply_trgt_ctnt),
              exclText: clean(ann.aply_excl_trgt_ctnt),
            });
          }
        } else if (newIndustry.operator === "in") {
          // ② 명시 룰 구조화
          ruleStructured++;
          const value = newIndustry.value as { codes?: string[]; labels?: string[] };
          const labels = value.labels ?? [];
          const codes = value.codes ?? [];
          bump(ruleBreakdown, labels[0] ?? "unknown");
          if (structuredSamples.length < 10) {
            structuredSamples.push({
              sourceId: row.sourceId,
              title: row.title,
              sourceSpan: newIndustry.source_span ?? "",
              codes,
              labels,
            });
          }
          if (dump) {
            dumpStructured.push({
              sourceId: row.sourceId,
              title: row.title,
              ruleLabel: labels[0] ?? "unknown",
              codes,
              sourceSpan: newIndustry.source_span ?? "",
              applyText: clean(ann.aply_trgt_ctnt),
              exclText: clean(ann.aply_excl_trgt_ctnt),
              rawApply: ann.aply_trgt_ctnt ?? "",
              rawExcl: ann.aply_excl_trgt_ctnt ?? "",
            });
          }
        } else {
          // ③ placeholder 잔존(text_only) — 분류기의 matchedRuleLabel 로 가드발화/순수 구분.
          placeholderRetained++;
          const classification = classifyKStartupIndustry(ann);
          if (classification.matchedRuleLabel) {
            // 룰 키워드가 매치됐으나 가드/나열/긍정템플릿 미충족으로 구조화가 차단됨
            guardFired++;
            if (dump) {
              dumpGuardFired.push({
                sourceId: row.sourceId,
                title: row.title,
                ruleLabel: classification.matchedRuleLabel,
                codes: [],
                sourceSpan: classification.span ?? "",
                applyText: clean(ann.aply_trgt_ctnt),
                exclText: clean(ann.aply_excl_trgt_ctnt),
                rawApply: ann.aply_trgt_ctnt ?? "",
                rawExcl: ann.aply_excl_trgt_ctnt ?? "",
              });
            }
          } else {
            plainPlaceholder++;
          }
        }
      } else {
        nonPlaceholderProcessed++;
      }

      if (mode === "execute") {
        // ── DB 쓰기: 오직 이 분기 안에서만 발생 ─────────────────────────────
        const collectedAt = row.collectedAt ?? new Date();
        try {
          const entry = normalizeKStartupAnnouncement(ann, { collectedAt });
          await publishKStartupGrants(db, [entry], {
            page: preservedLastPage,
            collectedAt,
          });
          published++;
        } catch (error) {
          failed++;
          failures.push({
            sourceId: row.sourceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (mode === "execute") {
      console.error(
        `[renormalize-kstartup] progress ${published + failed}/${scopedIds.length} (published=${published}, failed=${failed})`,
      );
    }
  }

  const summary = {
    mode,
    all,
    ...(typeof limit === "number" ? { limit } : {}),
    batchSize,
    targetGrantCount,
    processed,
    unprocessable,
    placeholderSubjects,
    ...(all ? { nonPlaceholderProcessed } : {}),
    industry: {
      nationwideRemoved,
      ruleStructured,
      placeholderRetained,
      ruleBreakdown,
      guardFired,
      plainPlaceholder,
    },
    criteriaTotals: {
      before: criteriaBefore,
      after: criteriaAfter,
      delta: criteriaAfter - criteriaBefore,
    },
    dimensionTotals: dimensionTotalsReport(),
    samples: {
      structured: structuredSamples,
      nationwide: nationwideSamples,
    },
    ...(mode === "execute"
      ? {
          execute: {
            published,
            failed,
            preservedLastPage,
            failures: failures.slice(0, 50),
          },
        }
      : {}),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (dump) {
    const dir = resolvePath(process.cwd(), "apps/web/src/lib/server/ingestion/.renorm-analysis");
    mkdirSync(dir, { recursive: true });
    const toJsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(resolvePath(dir, "structured.jsonl"), toJsonl(dumpStructured), "utf8");
    writeFileSync(resolvePath(dir, "nationwide.jsonl"), toJsonl(dumpNationwide), "utf8");
    writeFileSync(resolvePath(dir, "guard-fired.jsonl"), toJsonl(dumpGuardFired), "utf8");
    console.error(
      `[renormalize-kstartup] dump 저장: structured=${dumpStructured.length} nationwide=${dumpNationwide.length} guardFired=${dumpGuardFired.length} → ${dir}`,
    );
  }
} finally {
  await closeCunoteDb();
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function loadTargetGrantIds(
  database: ReturnType<typeof getCunoteDb>,
  allGrants: boolean,
): Promise<string[]> {
  if (allGrants) {
    const rows = await database
      .select({ id: schema.grants.id })
      .from(schema.grants)
      .where(eq(schema.grants.source, "kstartup"))
      .orderBy(schema.grants.id);
    return rows.map((r) => r.id);
  }
  const rows = await database
    .selectDistinct({ id: schema.grants.id })
    .from(schema.grants)
    .innerJoin(schema.grantCriteria, eq(schema.grantCriteria.grantId, schema.grants.id))
    .where(
      and(
        eq(schema.grants.source, "kstartup"),
        eq(schema.grantCriteria.dimension, "industry"),
        eq(schema.grantCriteria.operator, "text_only"),
      ),
    )
    .orderBy(schema.grants.id);
  return rows.map((r) => r.id);
}

function dimensionTotalsReport(): Record<string, { before: number; after: number; delta: number }> {
  const dims = new Set([...Object.keys(dimBefore), ...Object.keys(dimAfter)]);
  const out: Record<string, { before: number; after: number; delta: number }> = {};
  for (const dim of [...dims].sort()) {
    const before = dimBefore[dim] ?? 0;
    const after = dimAfter[dim] ?? 0;
    out[dim] = { before, after, delta: after - before };
  }
  return out;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readNumberArg(name: string): number | undefined {
  const value = readArg(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid positive integer: --${name}=${value}`);
  return parsed;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid bounded integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}
