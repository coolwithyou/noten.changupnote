import {
  buildDeepV34MatchingReprojectionReport,
  writeMatchingReprojectionReport,
} from "./matching-reprojection";

const root = process.cwd();
const outputArg = process.argv.find((argument) => argument.startsWith("--output="));
const outputPath = outputArg?.slice("--output=".length) || undefined;
const report = await buildDeepV34MatchingReprojectionReport(root);
const written = await writeMatchingReprojectionReport(report, {
  root,
  ...(outputPath ? { outputPath } : {}),
});

console.log(JSON.stringify({
  schema: report.schema,
  outputPath: written.path,
  reportSha256: written.sha256,
  authority: report.authority,
  terminalPopulation: report.terminalPopulation,
  summary: report.summary,
}, null, 2));
