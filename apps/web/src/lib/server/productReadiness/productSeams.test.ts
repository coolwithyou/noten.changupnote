import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { APPLICATION_ROUNDTRIP_VERSION, ROUNDTRIP_FIELD_CANDIDATE_LIMIT, buildApplicationPrecomputeAnalysisVersion } from "../documents/applicationAnalysisContract";
import { APPLICATION_ROUNDTRIP_VERSION as legacyVersion } from "../analysis-lab/application-roundtrip/contract";
import { buildApplicationPrecomputeAnalysisVersion as legacyIdentity } from "../documents/applicationPrecomputeMaterialization";

assert.equal(APPLICATION_ROUNDTRIP_VERSION, "kordoc-application-roundtrip-v9");
assert.equal(legacyVersion, APPLICATION_ROUNDTRIP_VERSION);
assert.equal(ROUNDTRIP_FIELD_CANDIDATE_LIMIT, 180);
assert.equal(legacyIdentity, buildApplicationPrecomputeAnalysisVersion, "역사 manifest identity 함수는 동일 정본을 사용한다");

const serverRoot = path.resolve(import.meta.dirname, "..");
// 이번에 분리한 제품 조회 seam은 lab 경로/실행 함수로 다시 의존하지 못한다.
for (const filename of ["documents/documentAgentGrounding.ts", "documents/applicationPrecomputePolicy.ts", "documents/applicationPrecomputeState.ts", "documents/applicationAnalysisContract.ts", "documents/applicationFieldAnalysis.ts", "documents/applicationPrecomputeMaterialization.ts", "productReadiness/report.ts", "repositories/drizzle.ts"]) {
  const source = fs.readFileSync(path.join(serverRoot, filename), "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
      if (!typeOnly) imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(!imports.some((specifier) => /analysis-lab|PrecomputeMaterialization|run-store|promote-cli/.test(specifier)), `${filename}: 제품 조회에 실험 실행 모듈을 다시 연결하지 않는다`);
}

// 이름만 adapter로 감싼 뒤 내부에서 실험실 실행/파일 I/O를 다시 불러오지 못한다.
const visited = new Set<string>();
function verifySharedGraph(filename: string, chain: string[] = []) {
  if (visited.has(filename)) return;
  visited.add(filename);
  assert.ok(!filename.includes("/analysis-lab/"), `공용 실행 graph의 실험실 의존: ${[...chain, filename].join(" -> ")}`);
  const source = fs.readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    let specifier: string | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
      specifier = node.moduleSpecifier.text;
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specifier = node.arguments[0].text;
    if (specifier) {
      const target = specifier.startsWith(".") ? path.resolve(path.dirname(filename), specifier)
        : specifier.startsWith("@/") ? path.resolve(serverRoot, "../..", specifier.slice(2)) : null;
      if (target) {
        const resolved = [target, `${target}.ts`, `${target}.tsx`, path.join(target, "index.ts")].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        assert.ok(resolved, `${filename}: unresolved ${specifier}`);
        verifySharedGraph(resolved, [...chain, path.relative(serverRoot, filename)]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
for (const filename of ["application-analysis/analyze-document.ts", "analysis-serving/promotionServing.ts", "analysis-serving/verifiedDeepSources.ts", "documents/applicationPrecomputeProcessor.ts"]) verifySharedGraph(path.join(serverRoot, filename));
console.log("product seams: shared immutable contract and separated runtime imports passed");
