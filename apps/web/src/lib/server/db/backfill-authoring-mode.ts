/**
 * grants.f_authoring_mode 백필: 각 grant 를 "지원서를 어떻게 작성하는가"(file_form/web_form/unknown)
 * 기준으로 분류해 정규화 컬럼(f_authoring_mode)에 반영한다.
 *
 * 사용:
 *   dry-run(기본, DB 미변경): pnpm backfill:authoring-mode -- --dry-run
 *   실제 반영:                pnpm backfill:authoring-mode
 *
 * 원칙:
 *   - id 커서 배치(500건)로 전체 grants 를 순회한다.
 *   - grant_raw 를 (source, source_id) 로 배치마다 벌크 조회(inArray)해 attachments·payload.detail 을
 *     함께 읽는다(N+1 회피).
 *   - 분류 결과가 기존 f_authoring_mode 와 같으면 스킵(불필요한 write 회피).
 *   - --dry-run 은 모드별 분포와 예정 업데이트 건수만 출력하고 DB 를 건드리지 않는다.
 *
 * input 구성:
 *   - attachmentFilenames = grant_raw.attachments[].filename
 *   - attachmentsKnown    = (source='bizinfo' AND attachments is not null)
 *                           OR (source='kstartup' AND payload.detail 존재)
 *   - applyMethods        = grants.f_apply_methods (선행 백필 완료 전제)
 *   - applyMethodTexts    = grants.apply_method(jsonb) 의 텍스트 값들
 *   - submitDocumentsText = payload.detail.submit_documents_text
 */
import { asc, eq, gt, inArray } from "drizzle-orm";
import type { ApplyMethodChannel, AuthoringMode } from "@cunote/contracts";
import { classifyAuthoringMode } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "./client";
import * as schema from "./schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

const BATCH_SIZE = 500;
const dryRun = process.argv.includes("--dry-run");

loadMonorepoEnv();

interface RawDetail {
  attachments?: Array<{ filename?: unknown }>;
  submit_documents_text?: unknown;
}

function rawKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

function attachmentFilenames(attachments: Array<Record<string, unknown>> | null): string[] {
  if (!attachments) return [];
  return attachments
    .map((attachment) => attachment.filename)
    .filter((filename): filename is string => typeof filename === "string" && filename.trim().length > 0);
}

function applyMethodTexts(applyMethod: Record<string, string | null> | null): string[] {
  if (!applyMethod) return [];
  return Object.values(applyMethod).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
}

function payloadDetail(payload: Record<string, unknown> | null): RawDetail | null {
  if (!payload) return null;
  const detail = (payload as { detail?: unknown }).detail;
  return detail && typeof detail === "object" ? (detail as RawDetail) : null;
}

async function main(): Promise<void> {
  const mode = dryRun ? "DRY-RUN" : "WRITE";
  console.log(`grants.f_authoring_mode 백필 (${mode})\n`);

  const db = getCunoteDb();
  const distribution = new Map<AuthoringMode, number>();
  let cursor: string | null = null;
  let scanned = 0;
  let toUpdate = 0;
  let updated = 0;

  for (;;) {
    const rows = await db
      .select({
        id: schema.grants.id,
        source: schema.grants.source,
        sourceId: schema.grants.sourceId,
        applyMethod: schema.grants.applyMethod,
        fApplyMethods: schema.grants.fApplyMethods,
        fAuthoringMode: schema.grants.fAuthoringMode,
      })
      .from(schema.grants)
      .where(cursor ? gt(schema.grants.id, cursor) : undefined)
      .orderBy(asc(schema.grants.id))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    // 배치의 source_id 로 grant_raw 를 벌크 조회해 (source, source_id) 키로 매핑(N+1 회피).
    const sourceIds = [...new Set(rows.map((row) => row.sourceId))];
    const rawRows = await db
      .select({
        source: schema.grantRaw.source,
        sourceId: schema.grantRaw.sourceId,
        payload: schema.grantRaw.payload,
        attachments: schema.grantRaw.attachments,
      })
      .from(schema.grantRaw)
      .where(inArray(schema.grantRaw.sourceId, sourceIds));
    const rawByKey = new Map(rawRows.map((raw) => [rawKey(raw.source, raw.sourceId), raw]));

    for (const row of rows) {
      scanned += 1;
      const raw = rawByKey.get(rawKey(row.source, row.sourceId));
      const attachments = raw?.attachments ?? null;
      const detail = payloadDetail(raw?.payload ?? null);
      const attachmentsKnown =
        (row.source === "bizinfo" && attachments !== null) ||
        (row.source === "kstartup" && detail !== null);
      const submitDocumentsText =
        detail && typeof detail.submit_documents_text === "string" ? detail.submit_documents_text : null;

      const authoringMode = classifyAuthoringMode({
        attachmentFilenames: attachmentFilenames(attachments),
        attachmentsKnown,
        applyMethods: row.fApplyMethods as ApplyMethodChannel[],
        applyMethodTexts: applyMethodTexts(row.applyMethod),
        submitDocumentsText,
      });

      distribution.set(authoringMode, (distribution.get(authoringMode) ?? 0) + 1);
      if (authoringMode === row.fAuthoringMode) continue;
      toUpdate += 1;
      if (!dryRun) {
        await db
          .update(schema.grants)
          .set({ fAuthoringMode: authoringMode })
          .where(eq(schema.grants.id, row.id));
        updated += 1;
      }
    }

    cursor = rows[rows.length - 1]!.id;
    console.log(`  진행: ${scanned}건 스캔, ${toUpdate}건 변경 예정 (커서=${cursor})`);
  }

  console.log("\n작성 방식 분포:");
  for (const authoringMode of ["file_form", "web_form", "unknown"] as const) {
    console.log(`  ${authoringMode.padEnd(9)} ${distribution.get(authoringMode) ?? 0}건`);
  }
  console.log(`\n요약: 스캔 ${scanned}건, 변경 예정 ${toUpdate}건, 반영 ${updated}건.`);

  if (dryRun) {
    console.log("\n(dry-run — DB 미변경. 반영하려면 --dry-run 없이 실행)");
  }
}

main()
  .then(async () => {
    await closeCunoteDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeCunoteDb();
    process.exit(1);
  });
