#!/usr/bin/env node
/**
 * globals.css의 top-level 클래스 셀렉터를 추출해 src 전체(ts/tsx)에서의
 * 참조 여부를 집계한다. 디자인 시스템 재정비 트랙의 dead CSS 게이트.
 *
 * 사용법:
 *   node scripts/audit-css-classes.mjs            # 콘솔 요약
 *   node scripts/audit-css-classes.mjs --json     # JSON 전체 출력
 *   node scripts/audit-css-classes.mjs --skip-pending  # "MIGRATION PENDING" 섹션 제외
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cssPath = join(root, "src/app/globals.css");
const srcDir = join(root, "src");
const asJson = process.argv.includes("--json");
const skipPending = process.argv.includes("--skip-pending");

let css = readFileSync(cssPath, "utf8");

if (skipPending) {
  const idx = css.indexOf("MIGRATION PENDING");
  if (idx !== -1) {
    // 배너 이후 전체를 감사 대상에서 제외 (격리 섹션은 후속 이관 예정)
    css = css.slice(0, idx);
  }
}

// 최상위 클래스 셀렉터 추출: 셀렉터 줄에서 .class-name 토큰 수집.
// 중괄호 깊이를 추적해 rule 내부(선언부)는 건너뛴다.
const classNames = new Set();
let depth = 0;
for (const rawLine of css.split("\n")) {
  const line = rawLine.trim();
  const opens = (line.match(/\{/g) ?? []).length;
  const closes = (line.match(/\}/g) ?? []).length;
  const selectorContext = depth === 0 || (depth === 1 && css.includes("@layer"));
  if (selectorContext && !line.startsWith("--") && !line.startsWith("/*")) {
    for (const m of line.matchAll(/\.([A-Za-z][\w-]*)/g)) {
      classNames.add(m[1]);
    }
  }
  depth += opens - closes;
}

// src 전체 ts/tsx 파일 수집
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full);
    } else if ([".ts", ".tsx"].includes(extname(entry))) {
      files.push(full);
    }
  }
})(srcDir);

const contents = files.map((f) => ({ file: f.replace(root + "/", ""), text: readFileSync(f, "utf8") }));

const live = [];
const dead = [];
for (const cls of [...classNames].sort()) {
  const hits = contents.filter(({ text }) => text.includes(cls));
  if (hits.length === 0) {
    dead.push(cls);
  } else {
    live.push({ class: cls, count: hits.length, files: hits.map((h) => h.file) });
  }
}

if (asJson) {
  console.log(JSON.stringify({ total: classNames.size, dead, live }, null, 2));
} else {
  console.log(`globals.css top-level 클래스: ${classNames.size}개`);
  console.log(`  참조 있음(live): ${live.length}개`);
  console.log(`  참조 없음(dead): ${dead.length}개`);
  if (dead.length > 0) {
    console.log("\n[dead 클래스 목록]");
    for (const cls of dead) console.log(`  .${cls}`);
  }
  console.log(
    "\n주의: 부분 문자열 매치라 일반 단어(active, error 등)는 과대집계될 수 있다. dead 판정만 신뢰할 것.",
  );
}
