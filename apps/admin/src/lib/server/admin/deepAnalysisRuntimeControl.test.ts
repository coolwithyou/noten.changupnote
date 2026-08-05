import assert from "node:assert/strict"

import { getDeepAnalysisRuntimeControlStatus } from "./deepAnalysisRuntimeControl"

const queries: string[] = []
const fakeSql = ((strings: TemplateStringsArray) => {
  const query = strings.join("?")
  queries.push(query)
  if (query.includes("FROM deep_analysis_runtime_control")) {
    return Promise.resolve([{
      control_key: "global",
      mode: "paused",
      generation: 3,
      changed_by: "test",
      change_reason: null,
      local_owner_id: null,
      local_lease_expires_at: null,
      created_at: new Date("2026-08-05T00:00:00.000Z"),
      updated_at: new Date("2026-08-05T00:00:00.000Z"),
    }])
  }
  if (query.includes("FROM grant_deep_analysis_jobs")) {
    return Promise.resolve([{
      active_deep_leases: 0,
      active_application_leases: 0,
    }])
  }
  throw new Error(`Unexpected query: ${query}`)
})

const status = await getDeepAnalysisRuntimeControlStatus(fakeSql as never)
const leaseQuery = queries.find((query) => query.includes("FROM grant_application_precompute_jobs"))

assert.equal(status.mode, "paused")
assert.equal(status.activeApplicationLeases, 0)
assert.ok(leaseQuery)
assert.match(leaseQuery, /FROM grant_application_precompute_jobs\s+WHERE status = 'leased'/u)
assert.doesNotMatch(leaseQuery, /queue_status/u)

console.log("deep-analysis runtime control: lease query passed")
