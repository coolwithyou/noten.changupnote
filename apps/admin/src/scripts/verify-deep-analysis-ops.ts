import { getAnalysisMonitoringSnapshot } from "@/lib/server/admin/analysisMonitoring"
import { closeAdminSql } from "@/lib/server/db/client"

async function main() {
  const snapshot = await getAnalysisMonitoringSnapshot()
  const failures: string[] = []
  const warnings: string[] = []

  if (!snapshot.worker.healthy) {
    failures.push(
      `analysis worker is unhealthy: status=${snapshot.worker.status}, mode=${snapshot.worker.executionMode}, activeWorkers=${snapshot.worker.activeWorkerCount}, activeLeases=${snapshot.worker.activeLeaseCount}`,
    )
  }
  if (!snapshot.inputPreparation.healthy) {
    failures.push(
      `input preparation is unhealthy: status=${snapshot.inputPreparation.status}, failed=${snapshot.inputPreparation.failedCount}, unresolved=${snapshot.inputPreparation.unresolvedCount}`,
    )
  }
  if (!snapshot.serving.healthy) {
    failures.push(
      `serving monitor is unhealthy: checked=${snapshot.serving.checkedItems}/${snapshot.serving.expectedItems}, fresh=${snapshot.serving.freshItems}, failed=${snapshot.serving.failedReceipts}, stale=${snapshot.serving.staleReceipts}`,
    )
  }
  if (snapshot.launch.systemicFailure) {
    failures.push(`latest launch has systemic failure: ${snapshot.launch.systemicFailure}`)
  }
  if (!snapshot.launch.available) {
    warnings.push("local launch artifacts are unavailable in this runtime")
  }
  if (snapshot.launch.summary.held > 0 || snapshot.launch.summary.failed > 0) {
    warnings.push(
      `latest launch isolated targets: held=${snapshot.launch.summary.held}, failed=${snapshot.launch.summary.failed}`,
    )
  }

  console.log(JSON.stringify({
    schema: "analysis-system-monitoring-verification-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    generatedAt: snapshot.generatedAt,
    runtime: snapshot.runtime,
    launch: {
      available: snapshot.launch.available,
      state: snapshot.launch.state,
      seriesId: snapshot.launch.seriesId,
      stopReason: snapshot.launch.stopReason,
      summary: snapshot.launch.summary,
    },
    worker: snapshot.worker,
    inputPreparation: snapshot.inputPreparation,
    serving: snapshot.serving,
    latestRelease: snapshot.releases[0] ?? null,
    warnings,
    failures,
  }, null, 2))
  if (failures.length > 0) process.exitCode = 2
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeAdminSql()
  })
