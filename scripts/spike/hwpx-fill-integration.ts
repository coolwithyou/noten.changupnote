// Phase 1 검수: hwpx-fill 모듈을 실제 정부 양식 샘플에 실행하는 통합 검증.
// docs/plans/2026-07-07-hwpx-fill-export.md Phase 1 검수 절차.
//
// 실행: pnpm exec tsx scripts/spike/hwpx-fill-integration.ts
// 산출: spike-out/hwpx-fill-p1/*.p1.hwpx + report (이후 Docker 렌더 게이트 입력)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  detectHwpFormat,
  fillHwpxTemplate,
} from "../../packages/core/src/documents/hwpx-fill.js";

// 정부 양식에서 흔한 라벨 변형을 폭넓게 시도 — 매칭률 실측이 목적
const VALUES: Record<string, string> = {
  기업명: "주식회사 채움검증",
  업체명: "주식회사 채움검증",
  기업체명: "주식회사 채움검증",
  회사명: "주식회사 채움검증",
  사업자등록번호: "123-45-67890",
  법인등록번호: "110111-1234567",
  대표자: "홍길동",
  대표자명: "홍길동",
  성명: "홍길동",
  주소: "서울특별시 강남구 테헤란로 1",
  소재지: "서울특별시 강남구 테헤란로 1",
  연락처: "02-1234-5678",
  전화번호: "02-1234-5678",
  휴대폰: "010-1234-5678",
  이메일: "test@example.com",
  "E-mail": "test@example.com",
  설립일: "2020-01-01",
  설립연월일: "2020-01-01",
  업종: "정보통신업 & 소프트웨어 <개발>",
};

const dirs = ["spike-samples/files", "spike-samples2/files"];
const outDir = "spike-out/hwpx-fill-p1";
mkdirSync(outDir, { recursive: true });

let ok = 0;
let total = 0;
const rows: string[] = [];

for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".hwpx")).sort()) {
    const buf = readFileSync(join(dir, file));
    if (detectHwpFormat(buf) !== "hwpx") {
      rows.push(`SKIP  ${file} — 위장 파일(${detectHwpFormat(buf)})`);
      continue;
    }
    total++;
    try {
      const res = fillHwpxTemplate({ source: buf, values: VALUES });
      const outPath = join(outDir, file.replace(/\.hwpx$/i, ".p1.hwpx"));
      writeFileSync(outPath, res.output);
      const reasons = new Map<string, number>();
      for (const u of res.unfilled) reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1);
      const reasonSummary = [...reasons.entries()].map(([r, n]) => `${r}:${n}`).join(" ");
      rows.push(
        `OK    ${file}\n      채움 ${res.filled.length}건 [${res.filled.map((f) => f.label).join(", ")}]` +
          `\n      미채움 ${res.unfilled.length}건 (${reasonSummary})`,
      );
      ok++;
    } catch (err) {
      rows.push(`FAIL  ${file} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(rows.join("\n"));
console.log(`\n합계: ${ok}/${total} 실행 성공, 산출: ${outDir}/`);
process.exit(ok === total ? 0 : 1);
