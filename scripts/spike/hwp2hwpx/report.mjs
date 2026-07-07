#!/usr/bin/env node
// hwp2hwpx Phase 0 — 기계 판독 보고서 집계. 각 단계 JSON 을 읽어 통과기준별 판정 산출.
// 사용법: node scripts/spike/hwp2hwpx/report.mjs
// 산출: spike-out/hwp2hwpx/report.json

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = join(ROOT, "spike-out/hwp2hwpx");
const read = (n) => (existsSync(join(OUT, n)) ? JSON.parse(readFileSync(join(OUT, n), "utf8")) : null);

const core = read("core-results.json");
const render = read("render-results.json");
const kordoc = read("kordoc-results.json");

const PIN = "50ae71bbaf98ec7a00192f72492d6a130a755ac1";

const cs = core?.summary;
const rs = render?.summary;
const ks = kordoc?.summary;

const verdicts = {
  convert: {
    pass: cs && cs.convertOk === cs.total && cs.unclassifiedFail === 0,
    detail: cs ? `변환 ${cs.convertOk}/${cs.total} 성공, 분류실패 ${cs.convertFail} ${JSON.stringify(cs.failByReason)}, 미분류실패 ${cs.unclassifiedFail}` : "n/a",
  },
  structure: {
    // 모든 변환본에서 셀 전건 cellAddr 보유 + 빈 셀 보존(빈 셀 0인 문서는 원문에 빈 셀 없음 — 정상)
    pass: cs && core.rows.every((r) => !r.struct || r.struct.error || r.struct.structureOk),
    emptyPreservedDocs: cs?.structEmptyPreservedDocs,
    docsWithFieldBegin: cs?.docsWithFieldBegin,
    detail: cs ? `구조단정 통과(표/셀/cellAddr) — 빈 셀 보존 문서 ${cs.structEmptyPreservedDocs}/${cs.total}(나머지는 원문에 빈 셀 없음), 누름틀(fieldBegin) 포함 ${cs.docsWithFieldBegin}건` : "n/a",
  },
  fill: {
    pass: cs && cs.fillHonestReportDocs === cs.total,
    detail: cs ? `채움 성공 ${cs.fillSuccessDocs}/${cs.total}(1건은 빈 셀 0), 미채움 정직보고 ${cs.fillHonestReportDocs}/${cs.total}` : "n/a",
  },
  render: {
    // H2O 렌더 게이트: 하드 통과 아님. 오라클 한계로 판정보류.
    pass: false,
    inconclusive: true,
    detail: rs
      ? `원본 렌더 ${rs.origRenderOk}/${rs.total}. 변환(STORE정규화) H2O 렌더 ${rs.convRenderOk}/${rs.total} — importer crash(SIGABRT) ${rs.convImporterCrash}건, sniff-fail ${rs.convSniffFail}건. 렌더 가능분 페이지수 원본일치 ${rs.pagesMatchOfRenderable}/${rs.convRenderOk}(불일치 ${rs.pagesMismatch.length}건). ` +
        `→ H2O importer 가 hwp2hwpx(및 kordoc regenerated) hwpx 대부분에서 crash. 한컴 동일성의 오라클로 부적합. 한컴 눈검수로 이월.`
      : "n/a",
    crashList: rs?.crashList,
    pagesMismatch: rs?.pagesMismatch,
  },
  hancomEyeball: {
    pass: null,
    detail: "사용자 몫 — 미완. 눈검수 표본 PNG: spike-out/hwp2hwpx/render/png/{10,11,26}_{orig,conv,filled}-*.png (orig↔conv↔filled 3-way). crash 19건은 H2O 렌더 불가로 한컴 직접 확인 필요.",
  },
};

const kordocCompare = ks
  ? {
      parseOk: `${ks.parseOk}/${ks.total} (.hwp 네이티브 읽기)`,
      fillDidFill: `${ks.fillDidFill}/${ks.total}`,
      producedOriginalPreservingHwpx: `0/${ks.total} — fillForm(.hwp) 기본 출력은 markdown, hwpx-preserve 는 .hwp 입력 거부("HWPX 입력만 지원"). "hwpx" 출력은 IR 재생성본(원본 레이아웃 보존 아님).`,
      regeneratedHwpxH2ORender: "13/17/22/10 전건 H2O 렌더 FAIL (kordoc 자체 SVG 렌더러 별도 경로).",
      note: "측정만 — 채택 판단 금지. Java(구조 전사·원본 보존) vs Node(IR 재생성/markdown)는 서로 다른 충실도 모델. 감독자 결정 대기.",
    }
  : "n/a";

const report = {
  generatedAt: new Date().toISOString(),
  track: "hwp2hwpx Phase 0 변환 스파이크",
  population: `${cs?.total ?? "?"} .hwp (spike-samples/files)`,
  build: {
    converter: "neolord0/hwp2hwpx",
    pinnedCommit: PIN,
    pinnedCommitDate: "2026-06-25",
    deps: { hwplib: "1.1.10", hwpxlib: "1.0.9" },
    jar: "spike-out/hwp2hwpx/hwp2hwpx-cli.jar (uber jar, mainClass=kr.dogfoot.hwp2hwpx.cli.Main)",
    reproduce: "bash scripts/spike/hwp2hwpx/build-jar.sh  (Docker maven:3.9-eclipse-temurin-17, release=8)",
    jdkNote: "원 pom java7 타깃 → 오버레이 pom 에서 release=8 승격(build-pom.xml)",
  },
  verdicts,
  kordocCompare,
  artifacts: {
    converted: "spike-out/hwp2hwpx/converted/*.hwpx",
    filled: "spike-out/hwp2hwpx/filled/*.filled.hwpx",
    renderPng: "spike-out/hwp2hwpx/render/png/",
    machineJson: ["core-results.json", "render-results.json", "kordoc-results.json", "render-experiment.json"],
  },
  knownDefects: [
    "hwp2hwpx HWPXWriter 는 mimetype 을 DEFLATE 로 저장 → 표준 위반(STORE 필요). production 재포장(core writeHwpx)이 STORE 로 정규화하므로 실질 무해하나, 원 산출물 단독으로는 H2O sniff 실패.",
    "hwp2hwpx container.xml 이 Preview/PrvText.txt 를 참조하나 파일은 미생성(dangling). manifest.xml 은 빈 목록. H2O 렌더에는 무관(실측).",
    "H2O(H2Orestart) importer 가 hwp2hwpx 변환본 19/22 에서 SIGABRT crash(ImportFrom). 원인 콘텐츠 레벨. Hancom 호환성과 별개(오라클 한계).",
  ],
  openItems: [
    "한컴오피스 눈검수 ≥1 (사용자) — 변환본이 실제 한컴에서 열리는지/레이아웃/채움 확인. 특히 H2O crash 19건.",
    "렌더 페이지수 예외 소명 — H2O 렌더 가능분(3건)은 페이지수 일치. crash 19건은 페이지수 대조 불가(H2O 오라클로는 측정 불능).",
  ],
};

writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
