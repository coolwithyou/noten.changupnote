import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveTeamSeatLimit } from "./teamManagement";
import { EARLY_ACCESS_LIMITS } from "@/lib/server/workspace/limits";

assert.equal(resolveTeamSeatLimit(12), 12);
assert.equal(resolveTeamSeatLimit("9"), 9);
assert.equal(resolveTeamSeatLimit(1), 1);
assert.equal(resolveTeamSeatLimit(1000), 1000);
assert.equal(resolveTeamSeatLimit(0), EARLY_ACCESS_LIMITS.seats);
assert.equal(resolveTeamSeatLimit(1001), EARLY_ACCESS_LIMITS.seats);
assert.equal(resolveTeamSeatLimit("invalid"), EARLY_ACCESS_LIMITS.seats);

const root = process.cwd();
const teamManagementSource = readFileSync(resolve(root, "apps/web/src/lib/server/team/teamManagement.ts"), "utf8");
const workspaceOverviewSource = readFileSync(resolve(root, "apps/web/src/lib/server/workspace/overview.ts"), "utf8");

assert(
  teamManagementSource.includes(".from(schema.billingSubscriptions)")
    && teamManagementSource.includes("schema.billingSubscriptions.seatLimit")
    && teamManagementSource.includes("resolveTeamSeatLimit(subscriptionRow?.seatLimit)"),
  "team invite seat guard must use billing subscription seat limit",
);
assert(
  workspaceOverviewSource.includes("limit: seatUsage.seatLimit"),
  "workspace usage metric must display the billing subscription seat limit",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "team_seat_limit_resolver",
    "team_invitation_guard_uses_billing_subscription",
    "workspace_usage_uses_subscription_seat_limit",
  ],
}, null, 2));
