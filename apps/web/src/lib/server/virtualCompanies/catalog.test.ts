import assert from "node:assert/strict";
import { isValidBizNoChecksum } from "@cunote/contracts";
import {
  VIRTUAL_COMPANY_IDENTITIES,
  isAcceptedLandingBizNo,
  isVirtualCompanyBizNo,
} from "@/lib/virtualCompanies";
import {
  isVirtualCompanyServerEnabled,
  listVirtualCompanyScenarios,
  resolveVirtualCompanyScenario,
  validateVirtualCompanyIdentityEntries,
} from "./catalog";

const asOf = new Date("2026-08-02T00:00:00.000Z");
const scenarios = listVirtualCompanyScenarios({ asOf });

assert.equal(scenarios.length, 3);
assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
assert.equal(new Set(scenarios.map((scenario) => scenario.bizNo)).size, scenarios.length);

for (const identity of VIRTUAL_COMPANY_IDENTITIES) {
  assert.equal(identity.bizNo.length, 10);
  assert.equal(isValidBizNoChecksum(identity.bizNo), false, `${identity.id} 번호는 정상 체크섬이면 안 된다`);
  assert.equal(isVirtualCompanyBizNo(identity.bizNo), true);
  assert.equal(isAcceptedLandingBizNo(identity.bizNo, { allowVirtual: false }), false);
  assert.equal(isAcceptedLandingBizNo(identity.bizNo, { allowVirtual: true }), true);
  const scenario = resolveVirtualCompanyScenario(identity.bizNo, { asOf });
  assert.equal(scenario?.id, identity.id);
  assert.equal(scenario?.profile.name, scenario?.name);
  assert.equal(scenario?.targets.length, 1);
  assert.match(scenario?.targets[0]?.expectedRevision ?? "", /^[a-f0-9]{64}$/);
  assert.match(scenario?.targets[0]?.expectedDocument.sourceSha256 ?? "", /^[a-f0-9]{64}$/);
}

assert.equal(isVirtualCompanyBizNo("0000000004"), false);
assert.equal(isAcceptedLandingBizNo("0000000004", { allowVirtual: true }), false);
assert.equal(isAcceptedLandingBizNo("746-54-00870", { allowVirtual: false }), true);
assert.equal(resolveVirtualCompanyScenario("7465400870", { asOf }), null);

assert.equal(isVirtualCompanyServerEnabled({ CUNOTE_VIRTUAL_COMPANY_ENABLED: "true" }), true);
assert.equal(isVirtualCompanyServerEnabled({ CUNOTE_VIRTUAL_COMPANY_ENABLED: "1" }), true);
assert.equal(isVirtualCompanyServerEnabled({ CUNOTE_VIRTUAL_COMPANY_ENABLED: "false" }), false);
assert.equal(isVirtualCompanyServerEnabled({}), false);

assert.throws(
  () => validateVirtualCompanyIdentityEntries([
    { id: "valid-checksum", bizNo: "1234567891" },
  ]),
  /실제 체크섬/,
);
assert.throws(
  () => validateVirtualCompanyIdentityEntries([
    { id: "duplicate", bizNo: "0000000001" },
    { id: "duplicate", bizNo: "0000000002" },
  ]),
  /ID가 중복/,
);
assert.throws(
  () => validateVirtualCompanyIdentityEntries([
    { id: "first", bizNo: "0000000001" },
    { id: "second", bizNo: "0000000001" },
  ]),
  /사업자번호가 중복/,
);

const perfect = resolveVirtualCompanyScenario("000-00-00001", { asOf });
assert.equal(perfect?.profile.region?.code, "44");
assert.deepEqual(perfect?.profile.traits, ["장애인기업"]);
assert.deepEqual(perfect?.profile.certs, ["장애인기업 확인서"]);
assert.equal(perfect?.profile.profile_evidence?.certification?.provider, "cunote_virtual_company");
assert.equal(perfect?.targets[0]?.expectedWritingEntry, "available");
assert.equal(perfect?.targets[0]?.expectedAuthoring?.documentCount, 2);
assert.equal(perfect?.targets[0]?.expectedAuthoring?.manualQuestionCount, 6);

const regionFail = resolveVirtualCompanyScenario("0000000002", { asOf });
assert.equal(regionFail?.profile.region?.code, "11");
assert.equal(regionFail?.targets[0]?.expected, "not_recommended");
assert.equal(regionFail?.targets[0]?.expectedWritingEntry, "hidden");

const certMissing = resolveVirtualCompanyScenario("0000000003", { asOf });
assert.equal(certMissing?.profile.certs, undefined);
assert.equal(certMissing?.profile.profile_evidence?.certification, undefined);
assert.equal(certMissing?.targets[0]?.expected, "needs_profile_input");
assert.equal(certMissing?.targets[0]?.expectedNextQuestionDimension, "certification");
assert.equal(certMissing?.targets[0]?.expectedWritingEntry, "needs_profile_input");

console.log("virtualCompanies/catalog.test.ts: all assertions passed");
