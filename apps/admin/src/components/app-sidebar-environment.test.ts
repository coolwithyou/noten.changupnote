import assert from "node:assert/strict"

import {
  hostnameFromHostHeader,
  isLocalAdminHostname,
  isLocalAdminRuntime,
  LOCAL_ANALYSIS_LAB_URL,
} from "./app-sidebar-environment"

assert.equal(isLocalAdminHostname("localhost"), true)
assert.equal(isLocalAdminHostname("127.0.0.1"), true)
assert.equal(isLocalAdminHostname("::1"), true)
assert.equal(isLocalAdminHostname("dev-ops.changupnote.com"), true)
assert.equal(isLocalAdminHostname("dev.ops.changupnote.com"), true)
assert.equal(isLocalAdminHostname("DEV-OPS.CHANGUPNOTE.COM"), true)

assert.equal(isLocalAdminHostname("ops.changupnote.com"), false)
assert.equal(isLocalAdminHostname("changupnote.com"), false)
assert.equal(isLocalAdminHostname("127.0.0.1.example.com"), false)

assert.equal(LOCAL_ANALYSIS_LAB_URL, "http://127.0.0.1:4010/dev/analysis-lab#batch-ops")
assert.equal(isLocalAdminRuntime("dev-ops.changupnote.com", "development"), true)
assert.equal(isLocalAdminRuntime("dev-ops.changupnote.com", "production"), false)
assert.equal(hostnameFromHostHeader("127.0.0.1:4011"), "127.0.0.1")
assert.equal(hostnameFromHostHeader("dev-ops.changupnote.com, proxy.local"), "dev-ops.changupnote.com")
assert.equal(hostnameFromHostHeader("[::1]:4011"), "::1")

console.log("admin sidebar environment tests: ok")
