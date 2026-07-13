/**
 * ops registry 업로드와 동일한 디코딩·파서·품질 gate를 로컬 파일에 적용한다(DB/R2 미접촉).
 *
 * pnpm exec tsx --tsconfig apps/admin/tsconfig.json scripts/registry/preview-upload.ts \
 *   --source procurement-debarment --file /path/to/file.csv
 */
import { readFile } from "node:fs/promises";
import {
  analyzeRegistryBytes,
  isRegistryUploadSource,
} from "../../apps/admin/src/lib/server/admin/registryImports";

const args = parseArgs(process.argv.slice(2));
if (!isRegistryUploadSource(args.source) || !args.file) {
  console.error("--source procurement-debarment|venture-confirmation|serious-accident --file <csv> 필요");
  process.exit(1);
}

const bytes = await readFile(args.file);
const { records: _records, ...report } = analyzeRegistryBytes({
  sourceKey: args.source,
  filename: args.file.split("/").pop() ?? "upload.csv",
  bytes,
});
console.log(JSON.stringify({
  valid: report.valid,
  source: report.source,
  encoding: report.encoding,
  fileSize: report.fileSize,
  sha256: report.sha256,
  rawRowCount: report.rawRowCount,
  parsedRowCount: report.parsedRowCount,
  rejectedRowCount: report.rejectedRowCount,
  exactKeyCount: report.exactKeyCount,
  activeRowCount: report.activeRowCount,
  duplicateCount: report.duplicateCount,
  errors: report.errors,
  warnings: report.warnings,
}, null, 2));
if (!report.valid) process.exitCode = 2;

function parseArgs(argv: string[]): { source: string | null; file: string | null } {
  let source: string | null = null;
  let file: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source") source = argv[++index] ?? null;
    else if (argv[index] === "--file") file = argv[++index] ?? null;
  }
  return { source, file };
}

