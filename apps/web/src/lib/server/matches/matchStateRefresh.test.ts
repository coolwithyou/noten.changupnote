import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import type { MatchStateInputBinding, ServiceRepositories } from "@cunote/core";
import { refreshMatchStates } from "./matchStateRefresh";

const companyId = "company-fixture";
const grant = fixtureGrant();
const binding: MatchStateInputBinding = {
  version: "match-state-input-v1",
  companyId,
  companyRevision: "3",
  grantId: grant.grant.id!,
  grantComponentRevisions: [{ grantId: grant.grant.id!, revision: "7" }],
};
let saveCalls = 0;
const staleRepositories = {
  matches: {
    async saveMatchState() {
      saveCalls += 1;
      return { status: "stale_input" as const };
    },
  },
} as unknown as ServiceRepositories<Record<string, never>>;

const stale = await refreshMatchStates({
  repositories: staleRepositories,
  companyId,
  company: {},
  grants: [grant],
  asOf: new Date("2026-09-07T00:00:00.000Z"),
  write: true,
  inputBindings: [binding],
});
assert.equal(saveCalls, 1);
assert.equal(stale.savedCount, 0);
assert.equal(stale.staleCount, 1);
assert.deepEqual(stale.staleGrantIds, [grant.grant.id]);

await assert.rejects(() => refreshMatchStates({
  repositories: staleRepositories,
  companyId,
  company: {},
  grants: [grant],
  asOf: new Date("2026-09-07T00:00:00.000Z"),
  write: true,
}), /requires current input binding/);
assert.equal(saveCalls, 1, "missing binding must fail before any unguarded save");

const userOverlay = await refreshMatchStates({
  repositories: staleRepositories,
  companyId,
  userId: "user-fixture",
  company: {},
  grants: [grant],
  asOf: new Date("2026-09-07T00:00:00.000Z"),
  write: false,
});
assert.equal(userOverlay.savedCount, 0);
assert.equal(userOverlay.staleCount, 0);
assert.equal(saveCalls, 1, "write=false user overlay must never reach shared save port");

console.log("match-state-refresh input binding: ok");

function fixtureGrant(): NormalizedGrant<Record<string, never>> {
  return {
    raw: { source: "bizinfo", source_id: "binding-fixture", payload: {}, status: "normalized" },
    grant: {
      id: "grant-fixture",
      source: "bizinfo",
      source_id: "binding-fixture",
      title: "binding fixture",
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [],
  };
}
