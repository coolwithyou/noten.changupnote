import { createHash, randomUUID } from "node:crypto";
import {
  procurementDebarmentAdapter,
  seriousAccidentAdapter,
  ventureConfirmationAdapter,
  type RegistryAdapter,
  type RegistryRecord,
} from "@cunote/core";
import { getAdminSql } from "@/lib/server/db/client";
import { createRegistryStorageFromEnv } from "@/lib/server/storage/r2RegistryStorage";

export type RegistryUploadSource =
  | "procurement-debarment"
  | "venture-confirmation"
  | "serious-accident";

type ImportStatus = "staged" | "validated" | "published" | "failed" | "superseded";

interface SourceConfig {
  key: RegistryUploadSource;
  source: string;
  label: string;
  adapter: RegistryAdapter;
  requiredHeaders: string[];
  parserVersion: string;
  freshnessDays: number;
  knownOnAbsence: boolean;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const STORAGE_PREFIX = "registry-raw/";

const SOURCE_CONFIGS: Record<RegistryUploadSource, SourceConfig> = {
  "procurement-debarment": {
    key: "procurement-debarment",
    source: "data.go.kr:15137996",
    label: "조달청 부정당제재",
    adapter: procurementDebarmentAdapter,
    requiredHeaders: ["업체", "사업자등록번호", "제재시작일자", "제재종료일자"],
    parserVersion: "procurement-debarment-v2",
    freshnessDays: 14,
    knownOnAbsence: true,
  },
  "venture-confirmation": {
    key: "venture-confirmation",
    source: "data.go.kr:15084581",
    label: "벤처확인기업",
    adapter: ventureConfirmationAdapter,
    requiredHeaders: ["업체명", "벤처확인유형", "벤처유효시작일", "벤처유효종료일"],
    parserVersion: "venture-confirmation-v2",
    freshnessDays: 120,
    knownOnAbsence: false,
  },
  "serious-accident": {
    key: "serious-accident",
    source: "data.go.kr:15090150",
    label: "중대재해 발생 사업장",
    adapter: seriousAccidentAdapter,
    requiredHeaders: ["재해발생연도", "사업장명(현장명)", "사업장소재지"],
    parserVersion: "serious-accident-v2",
    freshnessDays: 400,
    knownOnAbsence: false,
  },
};

export interface RegistryPreview {
  sourceKey: RegistryUploadSource;
  source: string;
  label: string;
  objectKey: string;
  filename: string;
  fileSize: number;
  contentType: string | null;
  encoding: string;
  sha256: string;
  schemaSignature: string;
  rawRowCount: number;
  parsedRowCount: number;
  rejectedRowCount: number;
  exactKeyCount: number;
  activeRowCount: number;
  duplicateCount: number;
  previousRowCount: number | null;
  deltaCount: number | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface RegistryImportRunSummary {
  id: string;
  source: string;
  sourceLabel: string;
  status: ImportStatus;
  filename: string;
  parsedRowCount: number;
  exactKeyCount: number;
  sourcePublishedAt: string | null;
  freshUntil: string | null;
  createdAt: string;
  completedAt: string | null;
  uploadedBy: string;
  active: boolean;
}

interface ImportRunRow {
  id: string;
  source: string;
  status: ImportStatus;
  filename: string;
  parsed_row_count: number;
  exact_key_count: number;
  source_published_at: Date | string | null;
  fresh_until: Date | string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
  uploaded_by: string;
  active: boolean;
}

export class RegistryImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "RegistryImportError";
  }
}

export function isRegistryUploadSource(value: unknown): value is RegistryUploadSource {
  return typeof value === "string" && value in SOURCE_CONFIGS;
}

export function registrySourceOptions() {
  return Object.values(SOURCE_CONFIGS).map(({ key, source, label }) => ({ key, source, label }));
}

export async function createRegistryUploadTarget(input: {
  sourceKey: RegistryUploadSource;
  filename: string;
  contentType: string;
  fileSize: number;
}): Promise<{ objectKey: string; uploadUrl: string }> {
  if (!Number.isFinite(input.fileSize) || input.fileSize <= 0 || input.fileSize > MAX_FILE_SIZE) {
    throw new RegistryImportError("invalid_file_size", "CSV 파일은 25MB 이하여야 합니다.");
  }
  if (!input.filename.toLowerCase().endsWith(".csv")) {
    throw new RegistryImportError("invalid_file_type", "CSV 파일만 업로드할 수 있습니다.");
  }
  const storage = createRegistryStorageFromEnv();
  if (!storage) throw new RegistryImportError("r2_not_configured", "ops 환경에 R2 설정이 필요합니다.", 503);
  const safeName = input.filename.normalize("NFC").replace(/[^0-9A-Za-z가-힣._-]+/g, "-").slice(-140);
  const date = new Date().toISOString().slice(0, 10);
  const objectKey = `${STORAGE_PREFIX}${SOURCE_CONFIGS[input.sourceKey].source}/${date}/${randomUUID()}-${safeName}`;
  const uploadUrl = await storage.presignPut({
    key: objectKey,
    contentType: input.contentType || "text/csv",
  });
  return { objectKey, uploadUrl };
}

export async function previewRegistryUpload(input: {
  sourceKey: RegistryUploadSource;
  objectKey: string;
  filename: string;
}): Promise<RegistryPreview & { records: RegistryRecord[] }> {
  assertObjectKey(input.objectKey, SOURCE_CONFIGS[input.sourceKey].source);
  const storage = createRegistryStorageFromEnv();
  if (!storage) throw new RegistryImportError("r2_not_configured", "ops 환경에 R2 설정이 필요합니다.", 503);
  const object = await storage.getBytes(input.objectKey);
  if (object.body.byteLength === 0 || object.body.byteLength > MAX_FILE_SIZE) {
    throw new RegistryImportError("invalid_file_size", "업로드 파일이 비어 있거나 25MB를 초과합니다.");
  }

  const previousRowCount = await getActiveRowCount(SOURCE_CONFIGS[input.sourceKey].source);
  return analyzeRegistryBytes({
    sourceKey: input.sourceKey,
    objectKey: input.objectKey,
    filename: input.filename,
    bytes: object.body,
    contentType: object.contentType,
    previousRowCount,
  });
}

/** R2/DB 없이도 실파일과 fixture를 검증할 수 있는 순수 분석 경계. */
export function analyzeRegistryBytes(input: {
  sourceKey: RegistryUploadSource;
  objectKey?: string;
  filename: string;
  bytes: Buffer;
  contentType?: string | null;
  previousRowCount?: number | null;
}): RegistryPreview & { records: RegistryRecord[] } {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_FILE_SIZE) {
    throw new RegistryImportError("invalid_file_size", "업로드 파일이 비어 있거나 25MB를 초과합니다.");
  }

  const config = SOURCE_CONFIGS[input.sourceKey];
  const { text, encoding } = decodeRegistryFile(input.bytes);
  const normalizedText = text.replace(/^\uFEFF/, "");
  const compactText = normalizedText.replace(/\s+/g, "");
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingHeaders = config.requiredHeaders.filter((header) => !compactText.includes(header.replace(/\s+/g, "")));
  if (missingHeaders.length > 0) errors.push(`필수 컬럼 누락: ${missingHeaders.join(", ")}`);

  const records = missingHeaders.length === 0
    ? config.adapter.parse(normalizedText, { fetchedAt: new Date() })
    : [];
  if (records.length === 0) errors.push("파싱 결과가 0행입니다. 현재 데이터는 교체할 수 없습니다.");

  const rawRowCount = estimateRawRows(normalizedText, config.requiredHeaders);
  const rejectedRowCount = Math.max(rawRowCount - records.length, 0);
  const exactKeyCount = records.reduce((count, record) => count + (record.bizNo || record.corpNo ? 1 : 0), 0);
  const activeRowCount = records.reduce(
    (count, record) => count + (!record.validUntil || record.validUntil.getTime() >= Date.now() ? 1 : 0),
    0,
  );
  const keys = records.map(sourceRecordKey);
  const duplicateCount = keys.length - new Set(keys).size;
  if (duplicateCount > 0) errors.push(`중복 레코드 키 ${duplicateCount.toLocaleString("ko-KR")}건`);
  if (config.knownOnAbsence && records.length > 0 && exactKeyCount / records.length < 0.9) {
    errors.push("부재 확정 소스인데 사업자번호·법인번호 보유율이 90% 미만입니다.");
  }

  const previousRowCount = input.previousRowCount ?? null;
  const deltaCount = previousRowCount === null ? null : records.length - previousRowCount;
  if (previousRowCount && records.length < previousRowCount * 0.7) {
    errors.push("직전 활성 버전보다 행 수가 30% 이상 감소했습니다.");
  }
  if (previousRowCount && records.length > previousRowCount * 2) {
    errors.push("직전 활성 버전보다 행 수가 100% 이상 증가했습니다.");
  }
  if (rejectedRowCount > 0) warnings.push(`원본 대비 ${rejectedRowCount.toLocaleString("ko-KR")}행이 제외됐습니다.`);
  if (!config.knownOnAbsence) warnings.push("present-only 소스입니다. 명단 부재를 '해당 없음'으로 확정하지 않습니다.");

  const header = findHeaderLine(normalizedText, config.requiredHeaders) ?? "";
  return {
    sourceKey: input.sourceKey,
    source: config.source,
    label: config.label,
    objectKey: input.objectKey ?? "local-preview",
    filename: input.filename,
    fileSize: input.bytes.byteLength,
    contentType: input.contentType ?? null,
    encoding,
    sha256: sha256(input.bytes),
    schemaSignature: sha256(Buffer.from(normalizeHeader(header), "utf8")),
    rawRowCount,
    parsedRowCount: records.length,
    rejectedRowCount,
    exactKeyCount,
    activeRowCount,
    duplicateCount,
    previousRowCount,
    deltaCount,
    valid: errors.length === 0,
    errors,
    warnings,
    records,
  };
}

export async function publishRegistryUpload(input: {
  sourceKey: RegistryUploadSource;
  objectKey: string;
  filename: string;
  expectedSha256: string;
  sourcePublishedAt: string | null;
  adminUserId: string;
}): Promise<{ runId: string; inserted: number }> {
  const preview = await previewRegistryUpload(input);
  if (!preview.valid) throw new RegistryImportError("registry_validation_failed", preview.errors.join(" "));
  if (preview.sha256 !== input.expectedSha256) {
    throw new RegistryImportError("registry_file_changed", "미리보기 이후 파일이 변경됐습니다.", 409);
  }
  const config = SOURCE_CONFIGS[input.sourceKey];
  const publishedAt = parseOptionalDate(input.sourcePublishedAt);
  const sql = getAdminSql();

  const duplicate = await sql<{ id: string }[]>`
    select id from registry_import_runs where source = ${config.source} and sha256 = ${preview.sha256} limit 1
  `;
  if (duplicate[0]) throw new RegistryImportError("registry_duplicate_file", "이미 반영했거나 검토한 파일입니다.", 409);

  const runRows = await sql<{ id: string }[]>`
    insert into registry_import_runs (
      source, status, filename, file_size, content_type, encoding, sha256, raw_object_key,
      source_published_at, parser_version, schema_signature, raw_row_count, parsed_row_count,
      rejected_row_count, exact_key_count, active_row_count, uploaded_by_admin_user_id
    ) values (
      ${config.source}, 'validated', ${preview.filename}, ${preview.fileSize}, ${preview.contentType},
      ${preview.encoding}, ${preview.sha256}, ${preview.objectKey}, ${publishedAt}, ${config.parserVersion},
      ${preview.schemaSignature}, ${preview.rawRowCount}, ${preview.parsedRowCount}, ${preview.rejectedRowCount},
      ${preview.exactKeyCount}, ${preview.activeRowCount}, ${input.adminUserId}
    ) returning id
  `;
  const runId = runRows[0]?.id;
  if (!runId) throw new RegistryImportError("registry_run_create_failed", "반입 이력을 만들지 못했습니다.", 500);

  try {
    const values = preview.records.map((record) => registryInsertValue(record, runId));
    for (let i = 0; i < values.length; i += 500) {
      const batch = values.slice(i, i + 500);
      await sql`
        insert into registry_index ${sql(batch, [
          "registry_type", "flag_or_cert", "polarity", "biz_no", "corp_no", "name_normalized",
          "representative", "region_sido", "valid_from", "valid_until", "detail", "source",
          "import_run_id", "source_record_key", "source_year", "source_fetched_at", "confidence",
        ])}
      `;
    }

    const freshUntil = new Date((publishedAt ?? new Date()).getTime() + config.freshnessDays * 86_400_000);
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${config.source}))`;
      const previous = await tx<{ active_run_id: string }[]>`
        select active_run_id from registry_source_state where source = ${config.source} for update
      `;
      const previousId = previous[0]?.active_run_id ?? null;
      await tx`
        insert into registry_source_state (source, active_run_id, last_success_at, fresh_until, updated_at)
        values (${config.source}, ${runId}, now(), ${freshUntil}, now())
        on conflict (source) do update set
          active_run_id = excluded.active_run_id,
          last_success_at = excluded.last_success_at,
          fresh_until = excluded.fresh_until,
          last_error_at = null,
          last_error_code = null,
          updated_at = now()
      `;
      if (previousId && previousId !== runId) {
        await tx`update registry_import_runs set status = 'superseded' where id = ${previousId}`;
      }
      await tx`update registry_import_runs set status = 'published', completed_at = now() where id = ${runId}`;
    });
    return { runId, inserted: preview.records.length };
  } catch (error) {
    await sql`
      update registry_import_runs
      set status = 'failed', completed_at = now(), error_summary = ${sql.json({ message: safeError(error) })}
      where id = ${runId}
    `;
    throw error;
  }
}

export async function rollbackRegistrySource(input: {
  runId: string;
  adminUserId: string;
}): Promise<{ source: string; activeRunId: string }> {
  const sql = getAdminSql();
  const runs = await sql<{ id: string; source: string; status: ImportStatus; source_published_at: Date | null }[]>`
    select id, source, status, source_published_at from registry_import_runs where id = ${input.runId} limit 1
  `;
  const target = runs[0];
  if (!target || !["published", "superseded"].includes(target.status)) {
    throw new RegistryImportError("invalid_rollback_run", "되돌릴 수 있는 성공 버전이 아닙니다.", 404);
  }
  const config = Object.values(SOURCE_CONFIGS).find((item) => item.source === target.source);
  if (!config) throw new RegistryImportError("unknown_registry_source", "알 수 없는 소스입니다.");
  const freshUntil = new Date((target.source_published_at ?? new Date()).getTime() + config.freshnessDays * 86_400_000);

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${target.source}))`;
    const current = await tx<{ active_run_id: string }[]>`
      select active_run_id from registry_source_state where source = ${target.source} for update
    `;
    const currentId = current[0]?.active_run_id;
    if (!currentId) throw new RegistryImportError("registry_source_not_active", "현재 활성 버전이 없습니다.", 409);
    await tx`
      update registry_source_state
      set active_run_id = ${target.id}, last_success_at = now(), fresh_until = ${freshUntil}, updated_at = now()
      where source = ${target.source}
    `;
    await tx`update registry_import_runs set status = 'superseded' where id = ${currentId}`;
    await tx`update registry_import_runs set status = 'published', completed_at = now() where id = ${target.id}`;
  });
  void input.adminUserId;
  return { source: target.source, activeRunId: target.id };
}

export async function listRegistryImportRuns(limit = 30): Promise<RegistryImportRunSummary[]> {
  const sql = getAdminSql();
  const rows = await sql<ImportRunRow[]>`
    select r.id, r.source, r.status, r.filename, r.parsed_row_count, r.exact_key_count,
           r.source_published_at, s.fresh_until, r.created_at, r.completed_at,
           u.email as uploaded_by, (s.active_run_id = r.id) as active
    from registry_import_runs r
    join admin_users u on u.id = r.uploaded_by_admin_user_id
    left join registry_source_state s on s.source = r.source
    order by r.created_at desc
    limit ${Math.min(Math.max(limit, 1), 100)}
  `;
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    sourceLabel: Object.values(SOURCE_CONFIGS).find((item) => item.source === row.source)?.label ?? row.source,
    status: row.status,
    filename: row.filename,
    parsedRowCount: row.parsed_row_count,
    exactKeyCount: row.exact_key_count,
    sourcePublishedAt: iso(row.source_published_at),
    freshUntil: iso(row.fresh_until),
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
    uploadedBy: row.uploaded_by,
    active: row.active,
  }));
}

function decodeRegistryFile(bytes: Buffer): { text: string; encoding: string } {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    throw new RegistryImportError("unsupported_encoding", "UTF-16BE 파일은 UTF-8로 변환 후 업로드해 주세요.");
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("euc-kr", { fatal: true }).decode(bytes), encoding: "cp949" };
  }
}

function estimateRawRows(text: string, requiredHeaders: string[]): number {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => {
    const compact = line.replace(/\s+/g, "");
    return requiredHeaders.slice(0, 2).every((header) => compact.includes(header.replace(/\s+/g, "")));
  });
  if (index < 0) return 0;
  return lines.slice(index + 1).filter((line) => line.trim() !== "").length;
}

function findHeaderLine(text: string, requiredHeaders: string[]): string | null {
  return text.split(/\r?\n/).find((line) => {
    const compact = line.replace(/\s+/g, "");
    return requiredHeaders.slice(0, 2).every((header) => compact.includes(header.replace(/\s+/g, "")));
  }) ?? null;
}

function normalizeHeader(header: string): string {
  return header.replace(/^\uFEFF/, "").replace(/\s+/g, "").toLowerCase();
}

function sourceRecordKey(record: RegistryRecord): string {
  const stable = [
    record.source,
    record.registryType,
    record.flagOrCert,
    record.bizNo ?? "",
    record.corpNo ?? "",
    record.nameNormalized,
    record.validFrom?.toISOString() ?? "",
    record.validUntil?.toISOString() ?? "",
    JSON.stringify(record.detail ?? {}),
  ].join("|");
  return sha256(Buffer.from(stable, "utf8"));
}

function registryInsertValue(record: RegistryRecord, runId: string) {
  return {
    registry_type: record.registryType,
    flag_or_cert: record.flagOrCert,
    polarity: record.polarity,
    biz_no: record.bizNo,
    corp_no: record.corpNo,
    name_normalized: record.nameNormalized,
    representative: record.representative,
    region_sido: record.regionSido,
    valid_from: record.validFrom,
    valid_until: record.validUntil,
    detail: record.detail,
    source: record.source,
    import_run_id: runId,
    source_record_key: sourceRecordKey(record),
    source_year: registrySourceYear(record),
    source_fetched_at: record.sourceFetchedAt,
    confidence: record.confidence,
  };
}

function registrySourceYear(record: RegistryRecord): number | null {
  const raw = record.detail?.["재해발생연도"];
  const year = typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(year) && year >= 1900 && year <= 2200 ? year : null;
}

async function getActiveRowCount(source: string): Promise<number | null> {
  const sql = getAdminSql();
  const rows = await sql<{ count: number | string }[]>`
    select count(i.id)::int as count
    from registry_source_state s
    join registry_index i on i.import_run_id = s.active_run_id
    where s.source = ${source}
  `;
  const value = rows[0]?.count;
  return value === undefined ? null : Number(value);
}

function parseOptionalDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00.000+09:00`);
  if (!Number.isFinite(date.getTime())) throw new RegistryImportError("invalid_source_date", "파일 수정일이 올바르지 않습니다.");
  return date;
}

function assertObjectKey(key: string, source: string): void {
  if (!key.startsWith(`${STORAGE_PREFIX}${source}/`) || key.includes("..")) {
    throw new RegistryImportError("invalid_object_key", "허용되지 않은 업로드 경로입니다.");
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}
