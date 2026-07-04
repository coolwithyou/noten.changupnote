/**
 * Gate 2 layout 엔진 어댑터 실행 러너 (CLI).
 *
 * 단일 원천: docs/plans/2026-07-04-gate2-layout-adapters.md §3·§5, 마스터 §17 Gate 2.
 *
 * 동작:
 *   - 후보 엔진(--engine <name|all>)을 골든 문서(--docs <doc01,..|all>)에 돌려 후보 필드를 산출한다.
 *   - layout 엔진 입력 = 페이지 이미지 spike-labels/pages/docNN-PP.png.
 *     kordoc 만 원본 파일 spike-samplesN/files (docRef 파일명으로 매칭).
 *   - per-unit 캐시(eval-cache/{engine}/{engineVersion}/{docId}-{page|doc}.json): 있으면 API 스킵(멱등).
 *   - 골든(--golden-source db|labels, 기본 db)과 비교해 coverage/manual recall/비용 산출.
 *     · db  = golden_set(kind=field_map) 승격분(검수 확정분).
 *     · labels = spike-labels/*.json 직접 사용 (미검수 — "참고용" 경고, 순환성 가드).
 *   - 골든 0건이면 후보 산출·캐시까지 하고 "골든 없음 — 메트릭 생략"으로 정상 종료.
 *   - eval_runs 기록은 --write + 골든>0 일 때만 (레포 CLI 관례: 기본 dry-run).
 *
 * 비용 안전장치(유료 API 오호출 방지):
 *   - costPerPageUsd>0 인 유료 엔진(Upstage/Google/Azure)은 --allow-paid 없이는 실호출하지 않고
 *     "paid-guard — 스킵"으로 건너뛴다. (미설정 엔진은 그와 별개로 "미설정 — 스킵".)
 *   - 무료/로컬 엔진(kordoc cost 0, PaddleOCR self-host cost 0)은 가드 없이 실행.
 *
 * 사용:
 *   pnpm eval:layout -- --engine kordoc --docs doc01
 *   pnpm eval:layout -- --engine all --docs all
 *   pnpm eval:layout -- --engine all --docs all --allow-paid          # 유료 실호출 허용
 *   pnpm eval:layout -- --engine kordoc --docs all --golden-source labels
 *   pnpm eval:layout -- --engine kordoc --docs all --write            # eval_runs 기록
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { ADAPTERS, ADAPTER_NAMES, getAdapter } from "./adapters";
import {
  EMPTY_TALLY,
  addTally,
  buildMetrics,
  extractGoldenFields,
  tallyDoc,
} from "./metrics";
import type { LayoutEngineAdapter, NormalizedFieldCandidate } from "./types";

loadMonorepoEnv();

const DEFAULT_GOLDEN_VER = "field_map_v0";
const LABELS_GOLDEN_VER = "labels_unreviewed";
const CACHE_BASE = fileURLToPath(new URL("./eval-cache", import.meta.url));

if (hasFlag("help")) {
  console.log(
    [
      "Usage: pnpm eval:layout -- [--engine <name|all>] [--docs <doc01,..|all>] \\",
      "         [--golden-source db|labels] [--goldenVer field_map_v0] [--write] [--allow-paid]",
      "",
      `엔진: ${ADAPTER_NAMES.join(", ")}, all`,
      "기본은 dry-run(eval_runs 미기록). 후보 산출·캐시는 항상 수행(멱등).",
      "유료 엔진(Upstage/Google/Azure)은 --allow-paid 없이는 실호출하지 않는다(paid-guard).",
    ].join("\n"),
  );
  process.exit(0);
}

const engineArg = (readArg("engine")?.trim() || "all").toLowerCase();
const docsArg = readArg("docs")?.trim() || "all";
const goldenSource = (readArg("golden-source")?.trim() || "db").toLowerCase();
const write = hasFlag("write");
const allowPaid = hasFlag("allow-paid");
const goldenVerArg = readArg("goldenVer")?.trim() || DEFAULT_GOLDEN_VER;

// ---------------------------------------------------------------------------
// 문서 목록
// ---------------------------------------------------------------------------

interface DocEntry {
  docId: string;
  docRef: string;
  sourceFilename: string;
  pageCount: number | null;
  pages: Array<{ page: number; pngPath: string }>;
  gold: unknown | null;
}

function loadDocs(root: string, filter: string): DocEntry[] {
  const labelDir = resolve(root, "spike-labels");
  const pagesDir = resolve(labelDir, "pages");
  const files = safeReaddir(labelDir)
    .filter((n) => /^doc\d+\.json$/i.test(n))
    .sort((a, b) => a.localeCompare(b));
  const wanted =
    filter === "all"
      ? null
      : new Set(filter.split(",").map((s) => s.trim()).filter(Boolean));

  const docs: DocEntry[] = [];
  for (const file of files) {
    const docId = file.replace(/\.json$/i, "");
    if (wanted && !wanted.has(docId)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(resolve(labelDir, file), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const docRef = typeof parsed["docRef"] === "string" ? (parsed["docRef"] as string) : "";
    if (!docRef) continue;
    docs.push({
      docId,
      docRef,
      sourceFilename: filenameOf(docRef),
      pageCount: typeof parsed["pageCount"] === "number" ? (parsed["pageCount"] as number) : null,
      pages: listPages(pagesDir, docId),
      gold: parsed, // labels 소스에서 재사용
    });
  }
  return docs;
}

function listPages(pagesDir: string, docId: string): Array<{ page: number; pngPath: string }> {
  const re = new RegExp(`^${docId}-(\\d+)\\.png$`, "i");
  const out: Array<{ page: number; pngPath: string }> = [];
  for (const name of safeReaddir(pagesDir)) {
    const m = name.match(re);
    if (!m || !m[1]) continue;
    out.push({ page: Number.parseInt(m[1], 10), pngPath: resolve(pagesDir, name) });
  }
  return out.sort((a, b) => a.page - b.page);
}

// ---------------------------------------------------------------------------
// kordoc 원본 파일 매칭 (docRef 파일명 ↔ spike-samples*/files)
// ---------------------------------------------------------------------------

function buildSourceIndex(root: string): Array<{ base: string; ext: string; path: string }> {
  const index: Array<{ base: string; ext: string; path: string }> = [];
  for (const dir of safeReaddir(root).filter((n) => /^spike-samples\d*$/.test(n))) {
    const filesDir = resolve(root, dir, "files");
    for (const name of safeReaddir(filesDir)) {
      // NN_hash- 접두어 제거
      const stripped = name.replace(/^\d+_[0-9a-f]+-/i, "");
      const ext = extOf(stripped);
      index.push({ base: normalizeName(stripped), ext, path: resolve(filesDir, name) });
    }
  }
  return index;
}

/** docRef 파일명으로 원본 파일 경로를 찾는다(확장자 일치 + 정규화 base 동등/포함). */
function matchSourceFile(
  index: ReadonlyArray<{ base: string; ext: string; path: string }>,
  sourceFilename: string,
): string | null {
  const ext = extOf(sourceFilename);
  const base = normalizeName(sourceFilename);
  if (!base) return null;
  // 1) 확장자 일치 + base 완전 동등
  const exact = index.find((c) => c.ext === ext && c.base === base);
  if (exact) return exact.path;
  // 2) 확장자 일치 + 포함(둘 중 짧은 쪽 길이 ≥ 8 로 오탐 축소)
  const contained = index.find(
    (c) =>
      c.ext === ext &&
      Math.min(c.base.length, base.length) >= 8 &&
      (c.base.includes(base) || base.includes(c.base)),
  );
  return contained?.path ?? null;
}

// ---------------------------------------------------------------------------
// 골든
// ---------------------------------------------------------------------------

async function loadGolden(
  source: string,
  docs: readonly DocEntry[],
  goldenVer: string,
): Promise<{ map: Map<string, unknown>; warnings: string[] }> {
  const map = new Map<string, unknown>();
  const warnings: string[] = [];

  if (source === "labels") {
    warnings.push("⚠ golden-source=labels: 미검수 라벨을 참고용으로 사용합니다(순환성 가드 — golden 승격 아님).");
    for (const d of docs) map.set(d.docRef, d.gold);
    return { map, warnings };
  }

  // source=db
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({ ref: schema.goldenSet.ref, gold: schema.goldenSet.gold })
      .from(schema.goldenSet)
      .where(and(eq(schema.goldenSet.kind, "field_map"), eq(schema.goldenSet.goldenVer, goldenVer)));
    for (const r of rows) map.set(r.ref, r.gold);
  } catch (error) {
    warnings.push(`⚠ golden_set 조회 실패 — 메트릭 생략 경로로 진행: ${(error as Error).message}`);
  }
  return { map, warnings };
}

// ---------------------------------------------------------------------------
// 캐시
// ---------------------------------------------------------------------------

function cachePathFor(engine: string, engineVersion: string, docId: string, unit: string): string {
  return resolve(CACHE_BASE, engine, safeSeg(engineVersion), `${docId}-${unit}.json`);
}

function readCache(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function writeCache(path: string, raw: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(raw), "utf8");
}

// ---------------------------------------------------------------------------
// 엔진 × 문서 실행
// ---------------------------------------------------------------------------

interface DocResult {
  docId: string;
  status: "ok" | "no_source" | "no_pages" | "error";
  reason?: string;
  candidates: number;
  apiUnits: number;
  cacheHits: number;
  pages: number;
  fieldCoverage: number | null;
  manualRecall: number | null;
}

interface EngineResult {
  engine: string;
  layer: string;
  engineVersion: string | null;
  status: "ran" | "skipped_unconfigured" | "skipped_paid_guard";
  reason?: string;
  docs: DocResult[];
  metrics: Record<string, number> | null;
  metricsNote?: string;
  wrote: boolean;
}

async function runEngine(
  adapter: LayoutEngineAdapter,
  docs: readonly DocEntry[],
  sourceIndex: ReadonlyArray<{ base: string; ext: string; path: string }>,
  golden: Map<string, unknown>,
  goldenVerLabel: string,
): Promise<EngineResult> {
  // 스킵 판정
  if (!adapter.isConfigured()) {
    return skeleton(adapter, "skipped_unconfigured", `미설정 — ${adapter.requires || "n/a"}`);
  }
  if (adapter.costPerPageUsd > 0 && !allowPaid) {
    return skeleton(adapter, "skipped_paid_guard", "유료 엔진 — --allow-paid 필요(비용 안전장치)");
  }

  const engineVersion = adapter.engineVersion();
  const docResults: DocResult[] = [];
  let tally = EMPTY_TALLY;
  let candidatesTotal = 0;
  let pagesProcessed = 0;
  let apiCallUnits = 0;
  let cacheHitUnits = 0;
  let docsWithGolden = 0;

  for (const doc of docs) {
    const collected: NormalizedFieldCandidate[] = [];
    let apiUnits = 0;
    let cacheHits = 0;
    let units = 0;
    let docError: string | undefined;

    try {
      if (adapter.mode === "document") {
        const sourcePath = matchSourceFile(sourceIndex, doc.sourceFilename);
        if (!sourcePath) {
          docResults.push(noResult(doc.docId, "no_source", `원본 파일 매칭 실패: ${doc.sourceFilename}`));
          continue;
        }
        const cachePath = cachePathFor(adapter.name, engineVersion, doc.docId, "doc");
        let raw = readCache(cachePath);
        if (raw === undefined) {
          raw = await adapter.fetchDocument({ docId: doc.docId, docRef: doc.docRef, sourceFilePath: sourcePath });
          writeCache(cachePath, raw);
          apiUnits += 1;
        } else {
          cacheHits += 1;
        }
        units = 1;
        collected.push(...adapter.normalizeDocument(raw, { docId: doc.docId, docRef: doc.docRef, sourceFilePath: sourcePath }));
      } else {
        if (doc.pages.length === 0) {
          docResults.push(noResult(doc.docId, "no_pages", "페이지 이미지 없음"));
          continue;
        }
        for (const pg of doc.pages) {
          const ctx = { docId: doc.docId, page: pg.page, pngPath: pg.pngPath };
          const cachePath = cachePathFor(adapter.name, engineVersion, doc.docId, String(pg.page));
          let raw = readCache(cachePath);
          if (raw === undefined) {
            raw = await adapter.fetchPage(ctx);
            writeCache(cachePath, raw);
            apiUnits += 1;
          } else {
            cacheHits += 1;
          }
          units += 1;
          collected.push(...adapter.normalizePage(raw, ctx));
        }
      }
    } catch (error) {
      docError = (error as Error).message;
    }

    candidatesTotal += collected.length;
    pagesProcessed += units;
    apiCallUnits += apiUnits;
    cacheHitUnits += cacheHits;

    if (docError) {
      docResults.push({
        docId: doc.docId,
        status: "error",
        reason: docError,
        candidates: collected.length,
        apiUnits,
        cacheHits,
        pages: units,
        fieldCoverage: null,
        manualRecall: null,
      });
      continue;
    }

    // 메트릭 (골든 있을 때만)
    const gold = golden.get(doc.docRef);
    let fieldCoverage: number | null = null;
    let manualRecall: number | null = null;
    if (gold !== undefined) {
      const goldenFields = extractGoldenFields(gold);
      const t = tallyDoc(goldenFields, collected);
      tally = addTally(tally, t);
      docsWithGolden += 1;
      fieldCoverage = t.goldenFields > 0 ? round(t.matchedFields / t.goldenFields) : null;
      manualRecall = t.manualGoldenFields > 0 ? round(t.manualMatched / t.manualGoldenFields) : null;
    }

    docResults.push({
      docId: doc.docId,
      status: "ok",
      candidates: collected.length,
      apiUnits,
      cacheHits,
      pages: units,
      fieldCoverage,
      manualRecall,
    });
  }

  const hasGolden = tally.goldenFields > 0;
  const estimatedCostUsd = adapter.costPerPageUsd * apiCallUnits;
  let metrics: Record<string, number> | null = null;
  let metricsNote: string | undefined;
  let wrote = false;

  if (hasGolden) {
    metrics = buildMetrics(tally, {
      candidatesTotal,
      pagesProcessed,
      apiCallUnits,
      cacheHitUnits,
      docsProcessed: docsWithGolden,
      costPerPageUsd: adapter.costPerPageUsd,
      estimatedCostUsd,
    });
    if (write) {
      await writeEvalRun(adapter, engineVersion, goldenVerLabel, docsWithGolden, metrics);
      wrote = true;
    }
  } else {
    metricsNote = "골든 없음 — 메트릭 생략 (후보 산출·캐시는 완료)";
  }

  const result: EngineResult = {
    engine: adapter.name,
    layer: adapter.layer,
    engineVersion,
    status: "ran",
    docs: docResults,
    metrics,
    wrote,
  };
  if (metricsNote !== undefined) result.metricsNote = metricsNote;
  return result;
}

async function writeEvalRun(
  adapter: LayoutEngineAdapter,
  engineVersion: string,
  goldenVerLabel: string,
  docCount: number,
  metrics: Record<string, number>,
): Promise<void> {
  const db = getCunoteDb();
  await db.insert(schema.evalRuns).values({
    target: "field_map",
    versionRefs: {
      engine: adapter.name,
      engineVersion,
      goldenVer: goldenVerLabel,
      docCount: String(docCount),
    },
    metrics,
    goldenVer: goldenVerLabel,
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const root = repoRoot();
  const docs = loadDocs(root, docsArg);
  if (docs.length === 0) {
    console.error(JSON.stringify({ ok: false, code: "no_docs", docsArg }, null, 2));
    process.exitCode = 1;
    return;
  }

  const engines: LayoutEngineAdapter[] =
    engineArg === "all"
      ? [...ADAPTERS]
      : (() => {
          const a = getAdapter(engineArg);
          if (!a) {
            console.error(
              JSON.stringify({ ok: false, code: "unknown_engine", engineArg, known: ADAPTER_NAMES }, null, 2),
            );
            process.exitCode = 1;
            return [];
          }
          return [a];
        })();
  if (engines.length === 0) return;

  const goldenVerLabel = goldenSource === "labels" ? LABELS_GOLDEN_VER : goldenVerArg;
  const { map: golden, warnings } = await loadGolden(goldenSource, docs, goldenVerArg);
  const sourceIndex = buildSourceIndex(root);

  const engineResults: EngineResult[] = [];
  for (const adapter of engines) {
    engineResults.push(await runEngine(adapter, docs, sourceIndex, golden, goldenVerLabel));
  }

  for (const w of warnings) console.error(w);

  console.log(
    JSON.stringify(
      {
        dryRun: !write,
        allowPaid,
        goldenSource,
        goldenVer: goldenVerLabel,
        goldenDocs: golden.size,
        docs: docs.map((d) => d.docId),
        cacheBase: CACHE_BASE,
        engines: engineResults,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------

function skeleton(adapter: LayoutEngineAdapter, status: EngineResult["status"], reason: string): EngineResult {
  return {
    engine: adapter.name,
    layer: adapter.layer,
    engineVersion: null,
    status,
    reason,
    docs: [],
    metrics: null,
    wrote: false,
  };
}

function noResult(docId: string, status: DocResult["status"], reason: string): DocResult {
  return {
    docId,
    status,
    reason,
    candidates: 0,
    apiUnits: 0,
    cacheHits: 0,
    pages: 0,
    fieldCoverage: null,
    manualRecall: null,
  };
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** docRef 마지막 세그먼트(파일명). */
function filenameOf(docRef: string): string {
  const idx = docRef.lastIndexOf(":");
  return idx === -1 ? docRef : docRef.slice(idx + 1);
}

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i + 1).toLowerCase();
}

/** 파일명 정규화: 확장자 제거 + NFC + 소문자 + 한글/영숫자만 남김(공백·구두점·언더바 제거). */
function normalizeName(filename: string): string {
  const i = filename.lastIndexOf(".");
  const base = i === -1 ? filename : filename.slice(0, i);
  return base.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 파일 경로 세그먼트로 안전한 문자열. */
function safeSeg(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function repoRoot(): string {
  const cwd = process.cwd();
  const candidates = [cwd, resolve(cwd, "../.."), resolve(cwd, "..", "..")];
  for (const c of candidates) {
    if (existsSync(resolve(c, "spike-labels"))) return c;
  }
  return cwd;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  // 공백 구분 형태(--engine kordoc)도 지원
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    const next = process.argv[idx + 1];
    if (next && !next.startsWith("--")) return next;
  }
  return undefined;
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
