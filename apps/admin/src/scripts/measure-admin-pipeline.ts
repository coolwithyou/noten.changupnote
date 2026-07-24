import { getPipelineMeasurement } from "@/lib/server/admin/pipelineGraph"
import { closeAdminSql } from "@/lib/server/db/client"

async function main() {
  try {
    const measurement = await getPipelineMeasurement()
    process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`)
  } finally {
    await closeAdminSql()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
