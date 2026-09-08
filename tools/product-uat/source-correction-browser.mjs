import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentBrowserSession,
  validateNaturalConfirmationConnection,
} from "./natural-confirmations-browser.mjs";

const RECEIPT_SCHEMA = "cunote-local-product-uat-source-correction-fixture-receipt-v1";
const UPDATE_RECEIPT_SCHEMA = "cunote-local-product-uat-source-correction-observation-update-receipt-v1";
const OUTPUT_RECEIPT = "source-correction-browser-receipt.json";
const AUTHORITY = "isolated_registry_observation_simulation_not_external_institution_refresh";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

const UAT = Object.freeze({
  companyId: "20000000-0000-4000-8000-000000000001",
  ownerEmail: "sw@noten.im",
  adminEmail: "manager@noten.im",
  dimension: "employees",
  provider: "registry",
  sourceKind: "public_registry",
  beforeValue: 20,
  afterValue: 8,
  statement: "공식 등록부의 상시근로자 수가 현재 실제 인원과 달라 정정을 요청합니다.",
  reviewNote: "공식 원천 갱신 여부를 확인하기 위해 관리자 검토를 시작합니다.",
  verifyNote: "격리된 registry 관측 갱신과 요청자의 재확인을 대조해 검수를 완료합니다.",
  negativeNote: "동일한 원천 관측으로는 갱신 검수를 완료할 수 없는지 확인합니다.",
});

export function parseSourceCorrectionBrowserArgs(args) {
  assert.equal(args.length, 1, "--connection=<private connection.json> 하나가 필요합니다.");
  const connectionPath = args[0]?.match(/^--connection=(.+)$/)?.[1];
  assert.ok(connectionPath);
  return { connectionPath };
}

export function validateSourceCorrectionConnection(connectionPath, options = {}) {
  const base = validateNaturalConfirmationConnection(connectionPath, options);
  const raw = JSON.parse(readFileSync(base.connectionPath, "utf8"));
  assertLoopbackUrl(raw.adminUrl);
  assert.equal(raw.admin, UAT.adminEmail);
  assert.equal(typeof raw.adminPassword, "string");
  assert.ok(raw.adminPassword.length >= 16, "UAT 관리자 비밀번호가 누락됐습니다.");
  assert.match(raw.correctionGrantId ?? "", UUID);

  const fixtureReceiptPath = realpathSync(resolve(raw.sourceCorrectionFixtureReceiptPath));
  assertPrivateRegularFile(fixtureReceiptPath, "source correction fixture receipt");
  assert.equal(dirname(fixtureReceiptPath), base.runtimeRoot);
  const fixtureReceipt = JSON.parse(readFileSync(fixtureReceiptPath, "utf8"));
  assert.equal(fixtureReceipt?.schema, RECEIPT_SCHEMA);
  assert.equal(fixtureReceipt?.authority, AUTHORITY);
  assert.equal(fixtureReceipt?.companyId, UAT.companyId);
  assert.equal(fixtureReceipt?.correctionGrantId, raw.correctionGrantId);
  assert.equal(fixtureReceipt?.provider, UAT.provider);
  assert.equal(fixtureReceipt?.sourceKind, UAT.sourceKind);
  assert.equal(fixtureReceipt?.dimension, UAT.dimension);
  assert.equal(fixtureReceipt?.before?.employeesCount, UAT.beforeValue);
  assert.equal(fixtureReceipt?.after?.employeesCount, UAT.afterValue);
  assert.equal(fixtureReceipt?.sameRowUpdateRequired, true);
  assert.match(fixtureReceipt?.servingBinding?.manifestSha256 ?? "", SHA256);
  assert.match(fixtureReceipt?.servingBinding?.planSha256 ?? "", SHA256);
  assert.match(fixtureReceipt?.servingBinding?.afterSha256 ?? "", SHA256);
  assert.deepEqual(
    pickCriterion(fixtureReceipt?.servingBinding?.criterion),
    { dimension: "employees", kind: "required", operator: "lte", value: { max: 10 } },
  );

  return {
    ...base,
    adminUrl: new URL(raw.adminUrl).origin,
    adminPassword: raw.adminPassword,
    postgresSocketPath: realpathSync(raw.postgresSocketPath),
    correctionGrantId: raw.correctionGrantId,
    sourceCorrectionFixtureReceiptPath: fixtureReceiptPath,
    sourceCorrectionFixtureReceipt: fixtureReceipt,
    provenance: {
      ...base.provenance,
      sourceCorrectionFixtureReceiptRawSha256: sha256File(fixtureReceiptPath),
      sourceCorrectionBrowserToolRawSha256: sha256File(fileURLToPath(import.meta.url)),
    },
  };
}

export function assertCorrectionStateEvidence(matchResponse, sheetResponse, expected) {
  assert.equal(matchResponse?.status, 200);
  assert.equal(matchResponse?.body?.ok, true);
  const card = matchResponse.body.data.matches.find((candidate) => candidate.grantId === expected.grantId);
  assert.ok(card, "정정 인수 공고가 actual matches 응답에 있어야 합니다");
  const matchTrace = card.ruleTrace.find((trace) => trace.dimension === UAT.dimension && trace.kind === "required");
  assert.ok(matchTrace, "actual matches 응답에 employees required trace가 필요합니다");
  assert.equal(card.eligibility, expected.eligibility);
  assert.equal(matchTrace.result, expected.result);
  assert.equal(matchTrace.unresolvedReason ?? null, expected.unresolvedReason ?? null);
  assert.equal(matchTrace.confirmationNextAction ?? null, expected.confirmationNextAction ?? null);

  assert.equal(sheetResponse?.status, 200);
  assert.equal(sheetResponse?.body?.ok, true);
  const sheet = sheetResponse.body.data;
  const sheetTraces = [...sheet.satisfied, ...sheet.needsCheck];
  const sheetTrace = sheetTraces.find((trace) => trace.dimension === UAT.dimension && trace.kind === "required");
  assert.ok(sheetTrace, "actual grant apply-sheet 응답에 employees required trace가 필요합니다");
  assert.equal(sheetTrace.result, expected.result);
  assert.equal(sheetTrace.unresolvedReason ?? null, expected.unresolvedReason ?? null);
  assert.equal(sheetTrace.confirmationNextAction ?? null, expected.confirmationNextAction ?? null);
  assert.equal(sheet.satisfied.includes(sheetTrace), expected.result === "pass");
  assert.equal(sheet.needsCheck.includes(sheetTrace), expected.result !== "pass");
  assert.equal(Object.hasOwn(sheet, "eligibility"), false, "ApplySheet에는 eligibility 계약이 없음을 숨기지 않습니다");
  return {
    eligibility: card.eligibility,
    matchTrace: traceEvidence(matchTrace),
    applySheetTrace: traceEvidence(sheetTrace),
    applySheetEligibilityFieldAbsent: true,
  };
}

export async function runSourceCorrectionAcceptance(connection, options = {}) {
  const prefix = options.sessionPrefix ?? `cunote-source-correction-${process.pid}`;
  const makeSession = options.makeSession ?? ((role, url, password) => createAgentBrowserSession({
    session: `${prefix}-${role}`,
    webUrl: url,
    sensitiveValues: [password],
  }));
  const owner = makeSession("owner", connection.webUrl, connection.userPassword);
  const admin = makeSession("admin", connection.adminUrl, connection.adminPassword);
  try {
    owner.close();
    admin.close();
    assertHoldActive(connection);
    await step("owner_login", () => login(owner, UAT.ownerEmail, connection.userPassword, 2), owner);
    const company = readApi(owner, "/api/web/companies");
    assert.equal(company.status, 200);
    assert.equal(company.body?.data?.currentCompanyId, UAT.companyId);

    const before = options.resumeAfterExistingSubmit === true
      ? { status: "not_repeated_existing_diagnostic_runtime" }
      : await step("baseline_match", () => readCorrectionState(owner, connection, {
          eligibility: "ineligible",
          result: "fail",
        }), owner);
    const submitted = options.resumeAfterExistingSubmit === true
      ? await step("read_existing_owner_submission", () => readExistingSubmission(owner), owner)
      : await step(
          "owner_submit",
          () => submitCorrection(owner, connection, options.allowRawDimensionLabel === true),
          owner,
        );
    const disputedAfterSubmit = await step("submitted_match", () => readCorrectionState(owner, connection, {
      eligibility: "conditional",
      result: "unknown",
      unresolvedReason: "source_dispute",
      confirmationNextAction: "admin_source_review",
    }), owner);

    assertHoldActive(connection);
    await step("admin_login", () => login(admin, UAT.adminEmail, connection.adminPassword, 1), admin);
    const review = await step("admin_review", () => startAdminReview(admin, submitted.recordId), admin);
    const sameObservation = await step(
      "owner_same_observation_recheck",
      () => ownerRecheck(owner, connection, submitted.recordId, UAT.beforeValue),
      owner,
    );
    const blockedVerify = await step(
      "same_observation_verify_blocked",
      () => verifySameObservationBlocked(admin, submitted.recordId, sameObservation.revision),
      admin,
    );

    assertHoldActive(connection);
    const simulatedUpdate = await step(
      "isolated_registry_observation_simulation",
      () => advanceIsolatedObservation(connection, options.spawnSyncImpl ?? spawnSync),
      owner,
    );
    const changedObservation = await step(
      "owner_changed_observation_recheck",
      () => ownerRecheck(owner, connection, submitted.recordId, UAT.afterValue),
      owner,
    );
    const stillDisputed = await step("pre_resolution_match", () => readCorrectionState(owner, connection, {
      eligibility: "conditional",
      result: "unknown",
      unresolvedReason: "source_dispute",
      confirmationNextAction: "admin_source_review",
    }), owner);
    const resolved = await step(
      "admin_verify_changed_observation",
      () => completeAdminVerification(admin, submitted.recordId),
      admin,
    );
    const rematched = await step("resolved_rematch", () => readCorrectionState(owner, connection, {
      eligibility: "eligible",
      result: "pass",
    }), owner);
    const finalInspection = inspectIsolatedFixture(connection, options.spawnSyncImpl ?? spawnSync);
    assertFinalInspection(
      finalInspection,
      submitted.recordId,
      connection.sourceCorrectionFixtureReceipt.profileRowId,
    );

    return {
      schema: "cunote-source-correction-browser-receipt-v1",
      status: "passed",
      completedAt: new Date().toISOString(),
      authority: AUTHORITY,
      app: {
        webOrigin: new URL(connection.webUrl).origin,
        adminOrigin: new URL(connection.adminUrl).origin,
        transport: "loopback_http",
      },
      sourceProvenance: {
        sourceManifestSha256: connection.source.manifestSha256,
        sourceManifestPath: connection.source.manifestPath,
        snapshotRoot: connection.source.snapshotRoot,
        sourceInventoryFilesVerified: connection.source.fileCount,
        generatedDeclarations: connection.source.generatedDeclarations,
        connectionRawSha256: connection.provenance.connectionRawSha256,
        confirmationFixtureReceiptRawSha256: connection.provenance.fixtureReceiptRawSha256,
        sourceCorrectionFixtureReceiptRawSha256: connection.provenance.sourceCorrectionFixtureReceiptRawSha256,
        sourceManifestRawSha256: connection.provenance.sourceManifestRawSha256,
        naturalBrowserGuardToolRawSha256: connection.provenance.browserToolRawSha256,
        sourceCorrectionBrowserToolRawSha256: connection.provenance.sourceCorrectionBrowserToolRawSha256,
        updateReceiptRawSha256: simulatedUpdate.updateReceiptRawSha256,
        sameSnapshotManifestVerified: true,
        runtimeBound: true,
      },
      workflow: {
        before,
        submitted,
        disputedAfterSubmit,
        review,
        sameObservation,
        blockedVerify,
        simulatedUpdate,
        changedObservation,
        stillDisputed,
        resolved,
        rematched,
      },
      finalInspection: {
        sha256: sha256Canonical(finalInspection),
        profileRowId: finalInspection.profileRow.id,
        employeesCount: finalInspection.profileRow.value.employees_count,
        sourceKind: finalInspection.profileRow.evidence.sourceKind,
        provider: finalInspection.profileRow.evidence.provider,
        correctionStatus: finalInspection.corrections[0].status,
        correctionRevision: finalInspection.corrections[0].revision,
        ticketStatus: finalInspection.tickets[0].status,
        publicAdminMessageCount: finalInspection.messages.filter((message) =>
          message.authorType === "admin" && message.visibility === "public").length,
      },
      evidenceBoundaries: {
        officialRefresh: "isolated_same_row_registry_observation_simulation_not_external_institution_refresh",
        eligibility: "actual_matches_http_eligibility_plus_actual_apply_sheet_http_trace",
        applySheetEligibilityField: "absent_by_current_contract",
        releaseApproval: false,
        productionDatabase: false,
      },
      modelCalls: 0,
      externalWrites: 0,
      isolatedFixtureWrites: true,
    };
  } finally {
    owner.close();
    admin.close();
  }
}

async function readCorrectionState(session, connection, expected) {
  const matches = readApi(session, "/api/web/matches?status=all&limit=40");
  const sheet = readApi(session, `/api/web/grants/${encodeURIComponent(connection.correctionGrantId)}`);
  return assertCorrectionStateEvidence(matches, sheet, { ...expected, grantId: connection.correctionGrantId });
}

async function submitCorrection(session, connection, allowRawDimensionLabel) {
  session.open(`/support/source-corrections?companyId=${encodeURIComponent(UAT.companyId)}`);
  waitFor(session, "Boolean(document.querySelector('#correction-field'))");
  const field = session.evaluate(`(() => {
    const button = document.querySelector('#correction-field');
    return { text: button?.textContent.trim() ?? null, disabled: button?.disabled ?? null };
  })()`);
  if (allowRawDimensionLabel) assert.ok(field.text?.includes("employees"));
  else assert.ok(field.text?.includes("상시근로자"), "정정 필드는 raw enum이 아닌 한국어 라벨이어야 합니다");
  assert.equal(field.disabled, false);
  setTextArea(session, "#correction-statement", UAT.statement);
  installResponseObserver(session, "/api/web/profile/source-corrections");
  clickButton(session, "정정 요청 접수");
  waitFor(session, "(window.__cunoteCorrectionResponses ?? []).some(item => item.method === 'POST')");
  waitFor(session, "document.body.textContent.includes('정정 요청을 접수했습니다')");
  const response = observedResponses(session).filter((item) => item.method === "POST").at(-1);
  assert.equal(response?.status, 201);
  assert.equal(response?.body?.ok, true);
  const record = response.body.data;
  assert.match(record.id, UUID);
  assert.equal(record.companyId, UAT.companyId);
  assert.equal(record.dimension, UAT.dimension);
  assert.equal(record.status, "open");
  assert.equal(record.baseline.value, UAT.beforeValue);
  assert.equal(record.baseline.evidence.provider, UAT.provider);
  assert.equal(record.baseline.evidence.sourceKind, UAT.sourceKind);
  return {
    status: "passed",
    recordId: record.id,
    ticketId: record.ticketId,
    revision: record.revision,
    baseline: snapshotEvidence(record.baseline),
    uiNoticeObserved: true,
    dimensionLabel: field.text,
    rawDimensionLabelDiagnosticAllowed: allowRawDimensionLabel,
    postStatus: response.status,
    snapshotSha256: snapshotDigest(session),
  };
}

async function readExistingSubmission(session) {
  const response = readApi(
    session,
    `/api/web/profile/source-corrections?companyId=${encodeURIComponent(UAT.companyId)}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body?.ok, true);
  assert.equal(response.body?.data?.records?.length, 1);
  const record = response.body.data.records[0];
  assert.equal(record.status, "open");
  assert.equal(record.dimension, UAT.dimension);
  assert.equal(record.baseline.value, UAT.beforeValue);
  assert.equal(record.events?.length, 1);
  assert.equal(record.events?.[0]?.action, "submitted");
  return {
    status: "passed_existing_diagnostic_submission",
    recordId: record.id,
    ticketId: record.ticketId,
    revision: record.revision,
    baseline: snapshotEvidence(record.baseline),
    existingRuntimeResume: true,
  };
}

async function startAdminReview(session, recordId) {
  session.open("/source-corrections");
  waitFor(session, `document.body.textContent.includes(${JSON.stringify(recordId)})`);
  setTextArea(session, `#note-${recordId}`, UAT.reviewNote);
  installResponseObserver(session, "/api/admin/source-corrections");
  clickButton(session, "검토 시작");
  waitFor(session, "(window.__cunoteCorrectionResponses ?? []).some(item => item.method === 'POST')");
  const response = observedResponses(session).filter((item) => item.method === "POST").at(-1);
  assert.equal(response?.status, 200);
  assert.equal(response?.body?.data?.status, "reviewing");
  return {
    status: "passed",
    postStatus: response.status,
    correctionStatus: response.body.data.status,
    revision: response.body.data.revision,
    snapshotSha256: snapshotDigest(session),
  };
}

async function ownerRecheck(session, connection, recordId, expectedValue) {
  session.open(`/support/source-corrections?companyId=${encodeURIComponent(UAT.companyId)}`);
  waitFor(session, `document.body.textContent.includes(${JSON.stringify(recordId)})`);
  installResponseObserver(session, "/api/web/profile/source-corrections");
  clickButton(session, "서비스 보유 원천 재확인");
  waitFor(session, "(window.__cunoteCorrectionResponses ?? []).some(item => item.method === 'POST')");
  const response = observedResponses(session).filter((item) => item.method === "POST").at(-1);
  assert.equal(response?.status, 200);
  assert.equal(response?.body?.data?.id, recordId);
  assert.equal(response?.body?.data?.status, "reviewing");
  assert.equal(response?.body?.data?.observation?.value, expectedValue);
  assert.equal(response?.body?.data?.observation?.evidence?.provider, UAT.provider);
  assert.equal(response?.body?.data?.observation?.evidence?.sourceKind, UAT.sourceKind);
  return {
    status: "passed",
    recordId,
    revision: response.body.data.revision,
    observation: snapshotEvidence(response.body.data.observation),
    postStatus: response.status,
    uiRecheckClicked: true,
    snapshotSha256: snapshotDigest(session),
  };
}

async function verifySameObservationBlocked(session, recordId, revision) {
  session.open("/source-corrections");
  waitFor(session, `document.body.textContent.includes(${JSON.stringify(recordId)})`);
  const disabled = buttonState(session, "갱신값 검수 완료");
  assert.equal(disabled.present, true);
  assert.equal(disabled.disabled, true, "동일 공식 관측이면 관리자 완료 버튼이 disabled여야 합니다");
  const response = readApi(session, "/api/admin/source-corrections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: recordId, revision, action: "verify", note: UAT.negativeNote }),
  });
  assert.equal(response.status, 409);
  assert.equal(response.body?.error?.code, "source_observation_required");
  return {
    status: "passed",
    uiVerifyDisabled: true,
    directApiStatus: response.status,
    directApiErrorCode: response.body.error.code,
    syntheticResponseUsed: false,
    snapshotSha256: snapshotDigest(session),
  };
}

function advanceIsolatedObservation(connection, spawnSyncImpl) {
  const execution = runFixtureCommand(connection, "advance", spawnSyncImpl);
  assert.equal(execution?.ok, true);
  assert.equal(execution?.action, "advance");
  assert.equal(execution?.receipt?.authority, AUTHORITY);
  assert.equal(execution?.receipt?.sameRowUpdated, true);
  assert.equal(execution?.receipt?.externalInstitutionContacted, false);
  assert.equal(execution?.state?.profileRow?.value?.employees_count, UAT.afterValue);
  const updateReceiptPath = realpathSync(execution.receiptPath);
  assertPrivateRegularFile(updateReceiptPath, "source correction update receipt");
  assert.equal(dirname(updateReceiptPath), connection.runtimeRoot);
  const rawReceipt = JSON.parse(readFileSync(updateReceiptPath, "utf8"));
  assert.equal(rawReceipt.schema, UPDATE_RECEIPT_SCHEMA);
  assert.equal(rawReceipt.profileRowId, connection.sourceCorrectionFixtureReceipt.profileRowId);
  return {
    status: "passed",
    authority: rawReceipt.authority,
    sameRowUpdated: rawReceipt.sameRowUpdated,
    externalInstitutionContacted: rawReceipt.externalInstitutionContacted,
    beforeRowSha256: rawReceipt.beforeRowSha256,
    afterRowSha256: rawReceipt.afterRowSha256,
    updateReceiptPath,
    updateReceiptRawSha256: sha256File(updateReceiptPath),
  };
}

async function completeAdminVerification(session, recordId) {
  session.open("/source-corrections");
  waitFor(session, `document.body.textContent.includes(${JSON.stringify(recordId)})`);
  const enabled = buttonState(session, "갱신값 검수 완료");
  assert.equal(enabled.present, true);
  assert.equal(enabled.disabled, false, "변경 공식 관측을 재확인하면 관리자 완료 버튼이 활성화돼야 합니다");
  setTextArea(session, `#note-${recordId}`, UAT.verifyNote);
  installResponseObserver(session, "/api/admin/source-corrections");
  clickButton(session, "갱신값 검수 완료");
  waitFor(session, "(window.__cunoteCorrectionResponses ?? []).some(item => item.method === 'POST')");
  const response = observedResponses(session).filter((item) => item.method === "POST").at(-1);
  assert.equal(response?.status, 200);
  assert.equal(response?.body?.data?.status, "resolved");
  waitFor(session, "document.body.textContent.includes('처리 완료 이력은 수정하지 않습니다')");
  return {
    status: "passed",
    postStatus: response.status,
    correctionStatus: response.body.data.status,
    revision: response.body.data.revision,
    uiVerifyEnabled: true,
    snapshotSha256: snapshotDigest(session),
  };
}

function inspectIsolatedFixture(connection, spawnSyncImpl) {
  const execution = runFixtureCommand(connection, "inspect", spawnSyncImpl);
  assert.equal(execution?.ok, true);
  assert.equal(execution?.action, "inspect");
  return execution;
}

function assertFinalInspection(inspection, recordId, profileRowId) {
  assert.equal(inspection.profileRow.id, profileRowId);
  assert.equal(inspection.profileRow.value.employees_count, UAT.afterValue);
  assert.equal(inspection.profileRow.evidence.provider, UAT.provider);
  assert.equal(inspection.profileRow.evidence.sourceKind, UAT.sourceKind);
  assert.equal(inspection.profileRow.userId, null);
  assert.equal(inspection.corrections.length, 1);
  assert.equal(inspection.corrections[0].id, recordId);
  assert.equal(inspection.corrections[0].status, "resolved");
  assert.equal(inspection.corrections[0].observation.value, UAT.afterValue);
  assert.deepEqual(inspection.corrections[0].events.map((event) => event.action), [
    "submitted", "review", "recheck", "recheck", "verify",
  ]);
  assert.equal(inspection.tickets.length, 1);
  assert.equal(inspection.tickets[0].status, "resolved");
  assert.equal(inspection.messages.filter((message) => message.visibility === "public").length, 2);
}

function runFixtureCommand(connection, action, spawnSyncImpl) {
  const env = Object.fromEntries([
    "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER",
  ].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []));
  Object.assign(env, {
    PGHOST: connection.postgresSocketPath,
    PGUSER: "postgres",
    DATABASE_URL: "postgres:///postgres",
    CUNOTE_PRODUCT_UAT_RUNTIME_ROOT: connection.runtimeRoot,
  });
  const args = [
    "exec", "tsx", "--tsconfig", "apps/web/tsconfig.json",
    "tools/product-uat/source-correction-fixture.ts", `--action=${action}`,
  ];
  assert.ok(args.every((argument) => !String(argument).includes(connection.userPassword)));
  assert.ok(args.every((argument) => !String(argument).includes(connection.adminPassword)));
  const result = spawnSyncImpl("pnpm", args, {
    cwd: connection.source.snapshotRoot,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`source correction fixture ${action} 실패: ${String(result.stderr ?? "").slice(-2000)}`, {
      cause: result.error,
    });
  }
  const lastLine = String(result.stdout ?? "").trim().split("\n").at(-1);
  assert.ok(lastLine);
  return JSON.parse(lastLine);
}

async function login(session, email, password, submitCount) {
  assert.ok(submitCount === 1 || submitCount === 2);
  session.open("/login");
  if (readSessionEmail(session) === email) return;
  session.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(item => item.textContent.includes('이메일로 계속하기'));
    button?.click();
    return true;
  })()`);
  waitFor(session, "Boolean(document.querySelector('input[type=\"password\"]'))");
  session.evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (const [selector, value] of ${JSON.stringify([["input[type=email]", email], ["input[type=password]", password]])}) {
      const input = document.querySelector(selector);
      if (!input) throw new Error('로그인 입력을 찾지 못했습니다.');
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
  session.run(["click", 'button[type="submit"]']);
  if (submitCount === 2) session.run(["click", 'button[type="submit"]']);
  waitFor(session, "location.pathname !== '/login'");
  assert.equal(readSessionEmail(session), email);
}

function readSessionEmail(session) {
  return session.evaluate("fetch('/api/auth/session').then(response => response.json()).then(value => value.user?.email ?? null)");
}

function readApi(session, path, options = undefined) {
  return session.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(options)}).then(async response => ({
    status: response.status,
    body: await response.json(),
  }))`);
}

function setTextArea(session, selector, value) {
  const result = session.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input || input.disabled) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert.equal(result, true, `${selector} 입력이 가능해야 합니다`);
}

function clickButton(session, label) {
  const clicked = session.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(candidate =>
      candidate.textContent.trim() === ${JSON.stringify(label)} && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `${label} 버튼을 누를 수 있어야 합니다`);
}

function buttonState(session, label) {
  return session.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('button')).find(candidate =>
      candidate.textContent.trim() === ${JSON.stringify(label)});
    return { present: Boolean(button), disabled: button?.disabled ?? null };
  })()`);
}

function installResponseObserver(session, fragment) {
  session.evaluate(`(() => {
    const original = window.fetch;
    window.__cunoteCorrectionResponses = [];
    window.fetch = function(...args) {
      const url = String(args[0]?.url ?? args[0]);
      const method = String(args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
      const pending = original.apply(this, args);
      if (url.includes(${JSON.stringify(fragment)})) pending.then(response => response.clone().json().then(body => {
        window.__cunoteCorrectionResponses.push({ url, method, status: response.status, body });
      }).catch(() => {}));
      return pending;
    };
    return true;
  })()`);
}

function observedResponses(session) {
  return session.evaluate("window.__cunoteCorrectionResponses ?? []");
}

function waitFor(session, expression) {
  session.run(["wait", "--fn", expression]);
}

async function step(name, operation, session) {
  try {
    return await operation();
  } catch (error) {
    let diagnostic = { unavailable: true };
    try {
      diagnostic = session.evaluate(`({
        pathname: location.pathname,
        search: location.search,
        readyState: document.readyState,
        bodyText: document.body.textContent.slice(0, 1200),
        buttons: Array.from(document.querySelectorAll('button')).slice(0, 20).map(button => ({
          label: button.textContent.trim(), disabled: button.disabled,
        })),
      })`);
    } catch {}
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}; page=${JSON.stringify(diagnostic)}`, {
      cause: error,
    });
  }
}

function traceEvidence(trace) {
  return {
    criterionId: trace.criterionId ?? null,
    dimension: trace.dimension,
    kind: trace.kind,
    result: trace.result,
    companyValue: trace.companyValue ?? null,
    unresolvedReason: trace.unresolvedReason ?? null,
    confirmationNextAction: trace.confirmationNextAction ?? null,
  };
}

function snapshotEvidence(snapshot) {
  return {
    dimension: snapshot.dimension,
    value: snapshot.value,
    displayValue: snapshot.displayValue,
    sourceKind: snapshot.evidence.sourceKind,
    provider: snapshot.evidence.provider,
    asOf: snapshot.evidence.asOf,
    scope: snapshot.evidence.scope,
    observationId: snapshot.evidence.observationId,
    observationVersion: snapshot.evidence.observationVersion,
  };
}

function pickCriterion(criterion) {
  return criterion ? {
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
  } : null;
}

function assertHoldActive(connection) {
  assert.ok(connection.holdUntilMs > Date.now() + 15_000, "bounded UAT hold 안에서만 인수를 실행합니다");
}

function assertPrivateRegularFile(path, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label}는 실제 일반 파일이어야 합니다`);
  assert.equal(stat.mode & 0o777, 0o600, `${label} 권한은 0600이어야 합니다`);
  if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid());
}

function assertLoopbackUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.port, /^\d+$/);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.ok(url.pathname === "/" || url.pathname === "");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
}

function snapshotDigest(session) {
  return createHash("sha256").update(JSON.stringify(session.snapshot())).digest("hex");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Canonical(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
}

async function main() {
  let secrets = [];
  try {
    const { connectionPath } = parseSourceCorrectionBrowserArgs(process.argv.slice(2));
    const connection = validateSourceCorrectionConnection(connectionPath);
    secrets = [connection.userPassword, connection.adminPassword];
    const receipt = await runSourceCorrectionAcceptance(connection);
    const receiptPath = join(connection.runtimeRoot, OUTPUT_RECEIPT);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({
      ok: true,
      suite: "source-correction-browser",
      status: receipt.status,
      receiptPath,
      checks: {
        submitted: receipt.workflow.submitted.status,
        sameObservationBlocked: receipt.workflow.blockedVerify.status,
        sameRowUpdated: receipt.workflow.simulatedUpdate.sameRowUpdated,
        resolved: receipt.workflow.resolved.status,
        rematchedEligibility: receipt.workflow.rematched.eligibility,
      },
      modelCalls: 0,
      externalWrites: 0,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      suite: "source-correction-browser",
      error: redact(error instanceof Error ? error.message : error, secrets),
    }));
    process.exitCode = 1;
  }
}

function redact(value, secrets) {
  let output = String(value);
  for (const secret of secrets) output = output.split(secret).join("[redacted]");
  return output;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
