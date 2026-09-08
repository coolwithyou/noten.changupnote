import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCorrectionStateEvidence,
  parseSourceCorrectionBrowserArgs,
  validateSourceCorrectionConnection,
} from "./source-correction-browser.mjs";

const runtimeRoot = mkdtempSync(join(tmpdir(), "cunote-product-uat-pg-"));
const sourceRunRoot = mkdtempSync(join(tmpdir(), "cunote-product-uat-source-"));
const snapshotRoot = join(sourceRunRoot, "source");
const marker = {
  schema: "cunote-product-uat-runtime-owner-v1",
  id: "70000000-0000-4000-8000-000000000001",
};
const connectionPath = join(runtimeRoot, "connection.json");
const confirmationReceiptPath = join(runtimeRoot, "confirmation-fixture-receipt.json");
const correctionReceiptPath = join(runtimeRoot, "source-correction-fixture-receipt.json");
const manifestPath = join(sourceRunRoot, "source-manifest.json");
const grantId = "40000000-0000-4000-8000-000000000003";
const password = "private-browser-password-123456789";
const adminPassword = "private-admin-password-123456789";
const nextDeclaration = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

try {
  mkdirSync(snapshotRoot, { mode: 0o700 });
  writePrivate(join(runtimeRoot, ".cunote-product-uat-owner.json"), marker);
  writePrivate(join(sourceRunRoot, ".cunote-product-uat-owner.json"), marker);
  mkdirSync(join(snapshotRoot, "apps/admin"), { recursive: true });
  mkdirSync(join(snapshotRoot, "apps/web"), { recursive: true });
  writeFileSync(join(snapshotRoot, "apps/admin/next-env.d.ts"), nextDeclaration);
  writeFileSync(join(snapshotRoot, "apps/web/next-env.d.ts"), nextDeclaration);
  writeFileSync(join(snapshotRoot, "fixture.txt"), "source-correction\n");
  const files = [
    { path: "apps/admin/next-env.d.ts", sha256: sha256(nextDeclaration) },
    { path: "apps/web/next-env.d.ts", sha256: sha256(nextDeclaration) },
    { path: "fixture.txt", sha256: sha256("source-correction\n") },
  ];
  const manifestSha256 = sha256(JSON.stringify(files));
  writePrivate(manifestPath, {
    schema: "cunote-local-product-uat-source-manifest-v1",
    snapshotRoot,
    sha256: manifestSha256,
    files,
  });
  writePrivate(confirmationReceiptPath, {
    schema: "cunote-local-product-uat-confirmation-fixture-receipt-v1",
    grantId: "40000000-0000-4000-8000-000000000001",
    servingGrantId: "40000000-0000-4000-8000-000000000002",
    publicationAuthority: "isolated_publisher_fixture_not_release_approval",
    finalState: { activePrompts: ["기존 제외 질문", "최초 필수 질문"] },
    naturalUiReadiness: { requiredOtherCompanyA: { naturalCtaContractReady: true } },
  });
  const correctionReceipt = {
    schema: "cunote-local-product-uat-source-correction-fixture-receipt-v1",
    authority: "isolated_registry_observation_simulation_not_external_institution_refresh",
    companyId: "20000000-0000-4000-8000-000000000001",
    ownerUserId: "10000000-0000-4000-8000-000000000001",
    profileRowId: "50000000-0000-4000-8000-000000000001",
    correctionGrantId: grantId,
    provider: "registry",
    sourceKind: "public_registry",
    dimension: "employees",
    before: { employeesCount: 20 },
    after: { employeesCount: 8 },
    sameRowUpdateRequired: true,
    servingBinding: {
      manifestSha256: "a".repeat(64),
      planSha256: "b".repeat(64),
      afterSha256: "c".repeat(64),
      criterion: { dimension: "employees", kind: "required", operator: "lte", value: { max: 10 } },
    },
  };
  writePrivate(correctionReceiptPath, correctionReceipt);
  const connection = {
    schema: "cunote-local-product-uat-connection-v1",
    holdUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
    webUrl: "http://127.0.0.1:43210",
    adminUrl: "http://127.0.0.1:43211",
    userPassword: password,
    adminPassword,
    users: ["sw@noten.im", "dev@noten.im", "guest@noten.im"],
    admin: "manager@noten.im",
    postgresSocketPath: runtimeRoot,
    snapshotRoot,
    sourceManifestSha256: manifestSha256,
    sourceManifestPath: manifestPath,
    confirmationFixtureReceiptPath: confirmationReceiptPath,
    sourceCorrectionFixtureReceiptPath: correctionReceiptPath,
    syntheticGrantId: "40000000-0000-4000-8000-000000000001",
    syntheticServingGrantId: "40000000-0000-4000-8000-000000000002",
    correctionGrantId: grantId,
  };
  writePrivate(connectionPath, connection);

  assert.deepEqual(parseSourceCorrectionBrowserArgs([`--connection=${connectionPath}`]), { connectionPath });
  assert.throws(() => parseSourceCorrectionBrowserArgs([]), /하나가 필요/);
  const validated = validateSourceCorrectionConnection(connectionPath);
  assert.equal(validated.correctionGrantId, grantId);
  assert.equal(validated.adminUrl, "http://127.0.0.1:43211");
  assert.equal(validated.sourceCorrectionFixtureReceipt.authority, correctionReceipt.authority);
  assert.match(validated.provenance.sourceCorrectionBrowserToolRawSha256, /^[a-f0-9]{64}$/);

  writePrivate(connectionPath, { ...connection, adminUrl: "https://example.com" }, false);
  assert.throws(() => validateSourceCorrectionConnection(connectionPath), /http:|127\.0\.0\.1/);
  writePrivate(connectionPath, connection, false);
  chmodSync(correctionReceiptPath, 0o644);
  assert.throws(() => validateSourceCorrectionConnection(connectionPath), /0600/);
  chmodSync(correctionReceiptPath, 0o600);
  writePrivate(correctionReceiptPath, { ...correctionReceipt, authority: "external_refresh" }, false);
  assert.throws(() => validateSourceCorrectionConnection(connectionPath), /strictly equal/);
  writePrivate(correctionReceiptPath, correctionReceipt, false);

  const states = [
    { eligibility: "ineligible", result: "fail" },
    { eligibility: "conditional", result: "unknown", unresolvedReason: "source_dispute", confirmationNextAction: "admin_source_review" },
    { eligibility: "eligible", result: "pass" },
  ];
  for (const expected of states) {
    const trace = {
      criterionId: "criterion-employees",
      dimension: "employees",
      kind: "required",
      result: expected.result,
      ...(expected.unresolvedReason ? { unresolvedReason: expected.unresolvedReason } : {}),
      ...(expected.confirmationNextAction ? { confirmationNextAction: expected.confirmationNextAction } : {}),
    };
    const evidence = assertCorrectionStateEvidence(
      { status: 200, body: { ok: true, data: { matches: [{ grantId, eligibility: expected.eligibility, ruleTrace: [trace] }] } } },
      { status: 200, body: { ok: true, data: {
        satisfied: expected.result === "pass" ? [trace] : [],
        needsCheck: expected.result === "pass" ? [] : [trace],
      } } },
      { ...expected, grantId },
    );
    assert.equal(evidence.eligibility, expected.eligibility);
    assert.equal(evidence.applySheetEligibilityFieldAbsent, true);
  }
  assert.throws(() => assertCorrectionStateEvidence(
    { status: 200, body: { ok: true, data: { matches: [{ grantId, eligibility: "eligible", ruleTrace: [] }] } } },
    { status: 200, body: { ok: true, data: { satisfied: [], needsCheck: [] } } },
    { grantId, eligibility: "eligible", result: "pass" },
  ), /employees required trace/);

  console.log(JSON.stringify({
    ok: true,
    suite: "source-correction-browser-guards",
    checks: 14,
    sourceKinds: ["public_registry"],
    provider: "registry",
    eligibilityEvidence: "matches_plus_apply_sheet_trace",
  }));
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(sourceRunRoot, { recursive: true, force: true });
}

function writePrivate(path, value, exclusive = true) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    ...(exclusive ? { flag: "wx" } : {}),
    mode: 0o600,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
