// 공모 딥분석 실험실 — 단독 스모크 CLI (tsx 실행, 실제 Anthropic 호출 발생 주의).
// 실행: pnpm lab:smoke                          (코호트 1건 자동 선택 — markdown 보유 공고 우선)
//       pnpm lab:smoke -- --grantId=<uuid>      (특정 공고 지정)
//       pnpm lab:smoke -- --refresh             (코호트 재선정 후 실행)
// env 는 loadMonorepoEnv 관행으로 루트 .env(.env.local)에서 로드한다. DB에는 어떤 쓰기도 하지 않는다.
import { closeCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { runLabAnalysis } from "./analyze";
import { loadLabCohort } from "./cohort";
import { labRunFilePath } from "./run-store";

loadMonorepoEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  let grantId = readArg("grantId");
  if (!grantId) {
    const cohort = await loadLabCohort({ refresh: hasFlag("refresh") });
    const preferred =
      cohort.notices.find((notice) => notice.attachments.some((a) => a.markdownAvailable)) ??
      cohort.notices[0];
    if (!preferred) throw new Error("코호트가 비어 있습니다 — open 공고가 없는지 확인해주세요.");
    grantId = preferred.grantId;
    console.log(`[smoke] 코호트 선택: ${preferred.title} (${preferred.source}/${preferred.sourceId})`);
    console.log(`[smoke] 첨부 ${preferred.attachments.length}건(markdown ${preferred.attachments.filter((a) => a.markdownAvailable).length}건) · 현재 criteria ${preferred.currentCriteriaCount}건`);
  }

  console.log(`[smoke] 딥분석 시작: grantId=${grantId}`);
  const run = await runLabAnalysis(grantId);

  console.log("\n===== 딥분석 스모크 요약 =====");
  console.log(`제목: ${run.title}`);
  console.log(`모델: ${run.model} · promptVersion: ${run.promptVersion}`);
  console.log(`소요: ${(run.durationMs / 1000).toFixed(1)}s · error: ${run.error ?? "없음"}`);
  console.log(`입력: 총 ${run.inputTotalChars.toLocaleString()}자 · sha256 ${run.inputSha256.slice(0, 12)}…`);
  for (const block of run.inputBlocks) {
    console.log(`  - [${block.label}] ${block.chars.toLocaleString()}자${block.truncated ? " (절단됨)" : ""}`);
  }

  const verified = run.criteria.filter((criterion) => criterion.spanVerified).length;
  const ratio = run.criteria.length > 0 ? ((verified / run.criteria.length) * 100).toFixed(0) : "-";
  console.log(`criteria: ${run.criteria.length}건 · spanVerified ${verified}건(${ratio}%)`);

  const statusCounts = new Map<string, number>();
  for (const assessment of run.axisAssessments) {
    statusCounts.set(assessment.status, (statusCounts.get(assessment.status) ?? 0) + 1);
  }
  const distribution = [...statusCounts.entries()].map(([status, n]) => `${status}=${n}`).join(" · ");
  console.log(`축 검사(${run.axisAssessments.length}/22): ${distribution || "-"}`);
  console.log(`신규 축 제안: ${run.taxonomyProposals.length}건`);

  if (run.usage) {
    console.log(
      `토큰: input ${run.usage.inputTokens.toLocaleString()} · output ${run.usage.outputTokens.toLocaleString()}` +
        (run.usage.cacheReadTokens != null ? ` · cache_read ${run.usage.cacheReadTokens.toLocaleString()}` : ""),
    );
  }
  console.log(`비용: ${run.costUsd != null ? `$${run.costUsd.toFixed(4)}` : "-"}`);
  console.log(`저장: ${labRunFilePath(run.source, run.sourceId, run.runId)}`);
  console.log(`analysis_markdown: ${run.analysisMarkdown.length.toLocaleString()}자`);
}

// verify 계열 스크립트가 커넥션 잔존으로 안 죽는 기존 현상이 있어, 명시적으로 정리·종료한다.
main()
  .then(async () => {
    await closeCunoteDb().catch(() => undefined);
    process.exit(0);
  })
  .catch(async (error) => {
    console.error("[smoke] 실패:", error instanceof Error ? error.message : error);
    await closeCunoteDb().catch(() => undefined);
    process.exit(1);
  });
