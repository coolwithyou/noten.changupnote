import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER_MARKER = ".cunote-product-uat-owner.json";
const CONNECTION_SCHEMA = "cunote-local-product-uat-connection-v1";
const FIXTURE_RECEIPT_SCHEMA = "cunote-local-product-uat-confirmation-fixture-receipt-v1";
const OWNER_MARKER_SCHEMA = "cunote-product-uat-runtime-owner-v1";
const SOURCE_MANIFEST_SCHEMA = "cunote-local-product-uat-source-manifest-v1";
const OUTPUT_RECEIPT = "natural-confirmations-browser-receipt.json";
const REQUIRED_HOLD_REMAINING_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,80}$/;
const BASIC_PROFILE_DIMENSIONS = ["region", "industry", "biz_age", "target_type"];
const NEXT_GENERATED_DECLARATIONS = new Set([
  "apps/admin/next-env.d.ts",
  "apps/web/next-env.d.ts",
]);
const NEXT_PRODUCTION_DECLARATION = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

const UAT = Object.freeze({
  companyA: "20000000-0000-4000-8000-000000000001",
  companyB: "20000000-0000-4000-8000-000000000002",
  ownerEmail: "sw@noten.im",
  editorEmail: "dev@noten.im",
  viewerEmail: "guest@noten.im",
  companyAName: "격리 합성 회사 A",
  companyBName: "격리 합성 회사 B",
  requiredPrompt: "최초 필수 질문",
  servingPrompt: "정상 노출 우대 질문",
});

export function parseNaturalConfirmationArgs(args) {
  assert.equal(args.length, 1, "--connection=<private connection.json> 하나가 필요합니다.");
  const connectionPath = args[0]?.match(/^--connection=(.+)$/)?.[1];
  assert.ok(connectionPath, "--connection=<private connection.json> 형식이 필요합니다.");
  return { connectionPath };
}

export function validateNaturalConfirmationConnection(connectionPath, options = {}) {
  const now = options.now ?? Date.now();
  const absoluteConnectionPath = resolve(connectionPath);
  assertPrivateRegularFile(absoluteConnectionPath, "UAT connection");
  assert.equal(basename(absoluteConnectionPath), "connection.json", "runner가 만든 connection.json만 허용합니다.");
  const canonicalConnectionPath = realpathSync(absoluteConnectionPath);
  const runtimeRoot = realpathSync(dirname(canonicalConnectionPath));
  const canonicalTmp = realpathSync(tmpdir());
  assert.ok(runtimeRoot.startsWith(`${canonicalTmp}${sep}`), "UAT runtime은 실제 임시 디렉터리 안에 있어야 합니다.");
  assert.match(basename(runtimeRoot), /^cunote-product-uat-pg-[A-Za-z0-9]+$/);
  const rootStat = lstatSync(runtimeRoot);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "UAT runtime root는 실제 디렉터리여야 합니다.");
  assert.equal(rootStat.mode & 0o777, 0o700, "UAT runtime root 권한은 0700이어야 합니다.");
  assertOwnedByCurrentUser(rootStat, "UAT runtime root");

  const markerPath = join(runtimeRoot, OWNER_MARKER);
  assertPrivateRegularFile(markerPath, "UAT owner marker");
  const marker = readJson(markerPath, "UAT owner marker");
  assert.equal(marker?.schema, OWNER_MARKER_SCHEMA, "UAT owner marker schema가 올바르지 않습니다.");
  assert.match(marker?.id ?? "", UUID, "UAT owner marker id가 올바르지 않습니다.");

  const connection = readJson(canonicalConnectionPath, "UAT connection");
  assert.equal(connection?.schema, CONNECTION_SCHEMA, "UAT connection schema가 올바르지 않습니다.");
  assert.equal(realpathSync(connection.postgresSocketPath), runtimeRoot, "connection과 격리 DB runtime이 다릅니다.");
  assertLoopbackUrl(connection.webUrl);
  const holdUntilMs = Date.parse(connection.holdUntil);
  assert.ok(Number.isFinite(holdUntilMs), "holdUntil이 올바른 시각이 아닙니다.");
  assert.ok(
    holdUntilMs > now + REQUIRED_HOLD_REMAINING_MS,
    "자연 브라우저 인수를 마칠 수 있도록 hold 시간이 120초 넘게 남아 있어야 합니다.",
  );
  assert.equal(typeof connection.userPassword, "string");
  assert.ok(connection.userPassword.length >= 16, "UAT 사용자 비밀번호가 누락됐습니다.");
  assert.deepEqual(
    new Set(connection.users),
    new Set([UAT.ownerEmail, UAT.editorEmail, UAT.viewerEmail]),
    "owner/editor/viewer 격리 계정 구성이 다릅니다.",
  );
  assert.match(connection.syntheticGrantId ?? "", UUID, "required other fixture grant가 누락됐습니다.");
  assert.match(connection.syntheticServingGrantId ?? "", UUID, "serving confirmation fixture grant가 누락됐습니다.");
  const source = validateSourceManifest(connection, canonicalTmp);

  const requestedFixtureReceiptPath = resolve(connection.confirmationFixtureReceiptPath);
  assertPrivateRegularFile(requestedFixtureReceiptPath, "confirmation fixture receipt");
  const fixtureReceiptPath = realpathSync(requestedFixtureReceiptPath);
  assert.equal(dirname(fixtureReceiptPath), runtimeRoot, "fixture receipt는 같은 bounded runtime 안에 있어야 합니다.");
  const fixtureReceipt = readJson(fixtureReceiptPath, "confirmation fixture receipt");
  assert.equal(fixtureReceipt?.schema, FIXTURE_RECEIPT_SCHEMA);
  assert.equal(fixtureReceipt?.grantId, connection.syntheticGrantId);
  assert.equal(fixtureReceipt?.servingGrantId, connection.syntheticServingGrantId);
  assert.equal(fixtureReceipt?.publicationAuthority, "isolated_publisher_fixture_not_release_approval");
  assert.ok(fixtureReceipt?.finalState?.activePrompts?.includes(UAT.requiredPrompt));
  assert.equal(
    fixtureReceipt?.naturalUiReadiness?.requiredOtherCompanyA?.naturalCtaContractReady,
    true,
    "R1 required other/text_only 자연 CTA HTTP gate를 통과한 fixture receipt가 필요합니다.",
  );

  return {
    connectionPath: canonicalConnectionPath,
    runtimeRoot,
    webUrl: normalizeLoopbackUrl(connection.webUrl),
    holdUntilMs,
    userPassword: connection.userPassword,
    grantId: connection.syntheticGrantId,
    servingGrantId: connection.syntheticServingGrantId,
    fixtureReceiptPath,
    source,
    provenance: {
      connectionRawSha256: sha256File(canonicalConnectionPath),
      fixtureReceiptRawSha256: sha256File(fixtureReceiptPath),
      sourceManifestRawSha256: sha256File(source.manifestPath),
      browserToolRawSha256: sha256File(fileURLToPath(import.meta.url)),
    },
  };
}

export function createAgentBrowserSession({
  session,
  webUrl,
  sensitiveValues = [],
  spawnSyncImpl = spawnSync,
}) {
  assert.match(session, SESSION_NAME, "agent-browser session 이름이 올바르지 않습니다.");
  assertLoopbackUrl(webUrl);
  const secrets = sensitiveValues.filter((value) => typeof value === "string" && value.length > 0);
  const env = Object.fromEntries([
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TERM",
    "TMPDIR",
    "USER",
  ].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []));
  Object.assign(env, {
    AGENT_BROWSER_ALLOWED_DOMAINS: "127.0.0.1",
    AGENT_BROWSER_DEFAULT_TIMEOUT: "15000",
    AGENT_BROWSER_MAX_OUTPUT: "200000",
  });

  function run(args, input, options = {}) {
    const argv = ["--session", session, "--json", ...args];
    for (const secret of secrets) {
      assert.ok(argv.every((arg) => !String(arg).includes(secret)), "민감정보를 agent-browser argv에 넣을 수 없습니다.");
    }
    const result = spawnSyncImpl("agent-browser", argv, {
      input,
      encoding: "utf8",
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
    if (options.tolerateFailure && (result.error || result.status !== 0)) return null;
    const output = `${result.stderr ?? ""}${result.stdout ?? ""}`;
    if (result.error || result.status !== 0) {
      throw new Error(redact(`agent-browser ${args[0] ?? "command"} 실패: ${output.slice(-2_000)}`, secrets), {
        cause: result.error,
      });
    }
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error(redact(`agent-browser JSON 응답이 올바르지 않습니다: ${String(result.stdout).slice(-1_000)}`, secrets));
    }
    assert.equal(payload?.success, true, redact(payload?.error ?? "agent-browser command failed", secrets));
    return payload.data;
  }

  return {
    name: session,
    run,
    evaluate(code) {
      const data = run(["eval", "--stdin"], code);
      const result = data && typeof data === "object" && Object.hasOwn(data, "result")
        ? data.result
        : data;
      return normalizeEvaluation(result);
    },
    open(path) {
      const url = new URL(path, webUrl);
      assert.equal(url.origin, new URL(webUrl).origin, "loopback 앱 밖으로 이동할 수 없습니다.");
      run(["open", url.href]);
      run(["wait", "--load", "networkidle"]);
    },
    snapshot() {
      return run(["snapshot", "-i"]);
    },
    close() {
      run(["close"], undefined, { tolerateFailure: true });
    },
  };
}

export function nextCompanyIsolationOptionValue(previousAnswer) {
  return previousAnswer?.values.includes("yes") ? "unknown" : "yes";
}

export async function runNaturalConfirmationAcceptance(connection, options = {}) {
  const sessionPrefix = options.sessionPrefix ?? `cunote-natural-confirmations-${process.pid}`;
  assert.match(sessionPrefix, SESSION_NAME);
  const makeSession = options.makeSession ?? ((role) => createAgentBrowserSession({
    session: `${sessionPrefix}-${role}`,
    webUrl: connection.webUrl,
    sensitiveValues: [connection.userPassword],
  }));
  const sessions = {
    owner: makeSession("owner"),
    editor: makeSession("editor"),
    viewer: makeSession("viewer"),
  };
  try {
    for (const session of Object.values(sessions)) session.close();
    assertHoldActive(connection);
    await acceptanceStep("owner_login", () => login(sessions.owner, connection, UAT.ownerEmail), sessions.owner);
    const ownerRoundTrip = await acceptanceStep(
      "owner_required_roundtrip",
      () => verifyOwnerRoundTrip(sessions.owner, connection),
      sessions.owner,
    );

    assertHoldActive(connection);
    await acceptanceStep("editor_login", () => login(sessions.editor, connection, UAT.editorEmail), sessions.editor);
    const editorDrawer = await acceptanceStep(
      "editor_profile_drawer_reload",
      () => verifyEditorDrawerDoesNotReopen(sessions.editor, connection),
      sessions.editor,
    );

    assertHoldActive(connection);
    const companyIsolation = await acceptanceStep(
      "owner_company_full_reload_isolation",
      () => verifyRouteUnmountCompanyIsolation(sessions.owner, connection),
      sessions.owner,
    );

    assertHoldActive(connection);
    const lateGet = await acceptanceStep(
      "actual_late_get_reopen",
      () => verifyLateActualGet(sessions.owner, sessions.editor, connection),
      [sessions.owner, sessions.editor],
    );

    assertHoldActive(connection);
    const logoutRelogin = await acceptanceStep(
      "owner_logout_relogin",
      () => verifyLogoutRelogin(sessions.owner, connection, lateGet.expectedLabel),
      sessions.owner,
    );

    assertHoldActive(connection);
    await acceptanceStep("viewer_login", () => login(sessions.viewer, connection, UAT.viewerEmail), sessions.viewer);
    const viewerReadOnly = await acceptanceStep(
      "viewer_read_only",
      () => verifyViewerReadOnly(sessions.viewer, connection),
      sessions.viewer,
    );

    return {
      schema: "cunote-natural-confirmations-browser-receipt-v1",
      status: "passed",
      completedAt: new Date().toISOString(),
      publicationAuthority: "isolated_publisher_fixture_not_release_approval",
      app: { origin: new URL(connection.webUrl).origin, transport: "loopback_http" },
      sourceProvenance: {
        sourceManifestSha256: connection.source.manifestSha256,
        sourceManifestPath: connection.source.manifestPath,
        snapshotRoot: connection.source.snapshotRoot,
        sourceInventoryFilesVerified: connection.source.fileCount,
        generatedDeclarations: connection.source.generatedDeclarations,
        connectionRawSha256: connection.provenance.connectionRawSha256,
        fixtureReceiptRawSha256: connection.provenance.fixtureReceiptRawSha256,
        sourceManifestRawSha256: connection.provenance.sourceManifestRawSha256,
        browserToolRawSha256: connection.provenance.browserToolRawSha256,
        sameSnapshotManifestVerified: true,
        runtimeBound: true,
      },
      accounts: {
        owner: "actual_password_login",
        editor: "actual_password_login",
        viewer: "actual_password_login",
      },
      requiredOtherTextOnly: ownerRoundTrip.requiredOtherTextOnly,
      ownerRoundTrip,
      editorDrawer,
      companyIsolation,
      lateGet,
      logoutRelogin,
      viewerReadOnly,
      evidenceBoundaries: {
        companySwitch: "actual_SettingsPageView_dialog_switch_then_route_unmount_A_to_B_to_A",
        lateGet: "actual_response_delayed_without_payload_substitution",
        syntheticComponentAbaSevenCases: "separate_suite_not_executed_here",
        productionReleaseApproval: false,
      },
      modelCalls: 0,
      externalWrites: 0,
    };
  } finally {
    for (const session of Object.values(sessions)) session.close();
  }
}

async function acceptanceStep(name, operation, diagnosticSessions) {
  try {
    return await operation();
  } catch (error) {
    const sessions = Array.isArray(diagnosticSessions) ? diagnosticSessions : [diagnosticSessions];
    const diagnostics = sessions.filter(Boolean).map(pageDiagnostic);
    throw new Error(
      `${name}: ${error instanceof Error ? error.message : String(error)}; page=${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  }
}

function pageDiagnostic(session) {
  try {
    return session.evaluate(`({
      pathname: location.pathname,
      search: location.search,
      readyState: document.readyState,
      cardCount: document.querySelectorAll('[data-product-grant]').length,
      profileDrawerOpen: Boolean(document.querySelector('button[aria-label="내 사업자 정보 닫기"]')),
      confirmationSheetOpen: Boolean(document.querySelector('button[aria-label="공고 확인 질문 닫기"]')),
      dialogButtons: Array.from(document.querySelectorAll('[role="dialog"] button')).map(button => ({
        label: button.textContent.trim(), disabled: button.disabled,
      })),
    })`);
  } catch {
    return { unavailable: true };
  }
}

async function verifyOwnerRoundTrip(session, connection) {
  session.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  closeProfileDrawerIfOpen(session);
  const matching = readMatching(session, connection.grantId, UAT.companyA);
  const match = matching.teaser.matches.find((entry) => entry.grantId === connection.grantId);
  assert.ok(match, "required other fixture가 실제 매칭 응답에 있어야 합니다.");
  const confirmation = readConfirmations(session, connection.grantId, UAT.companyA);
  assert.equal(confirmation.canSubmit, true);
  const question = requiredQuestion(confirmation);
  const requiredTrace = match.ruleTrace.find((trace) =>
    trace.criterionId === question.binding.criterionId
    && trace.dimension === "other"
    && trace.kind === "required"
    && trace.result === "text_only"
    && trace.unresolvedReason === "criterion_text_only"
    && trace.confirmationNextAction === "user_confirmation");
  assert.ok(requiredTrace, "실제 응답에 required other/text_only criterion이 있어야 합니다.");
  assert.ok((match.confirmationQuestionCount ?? 0) > 0, "required other 질문이 자연 CTA에 연결돼야 합니다.");
  const selectedOption = optionByValue(question, "yes");

  const firstOpen = openQuestionFromCard(session, connection.grantId, question.prompt);
  selectQuestionOption(session, question.prompt, selectedOption.label);
  const saved = saveConfirmation(session, connection.grantId, UAT.companyA);
  assert.equal(saved.put.status, 200);
  assert.equal(saved.put.body?.ok, true);
  assert.ok(saved.matchingGet, "저장 뒤 실제 company-matching GET이 있어야 합니다.");

  openQuestionFromCard(session, connection.grantId, question.prompt);
  assert.deepEqual(selectedLabels(session, question.prompt), [selectedOption.label]);
  closeConfirmationSheet(session);
  session.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  closeProfileDrawerIfOpen(session);
  openQuestionFromCard(session, connection.grantId, question.prompt);
  assert.deepEqual(selectedLabels(session, question.prompt), [selectedOption.label]);
  const revisitSnapshot = snapshotDigest(session);
  closeConfirmationSheet(session);

  const persisted = answerFor(readConfirmations(session, connection.grantId, UAT.companyA), question.id);
  assert.deepEqual(persisted.values, [selectedOption.value]);
  return {
    status: "passed",
    requiredOtherTextOnly: true,
    naturalCardCta: firstOpen.cta,
    questionId: question.id,
    savedValue: selectedOption.value,
    savedRevision: persisted.answerRevision,
    putStatus: saved.put.status,
    actualMatchingReload: true,
    restoredAfterSheetReopen: true,
    restoredAfterPageReload: true,
    revisitSnapshotSha256: revisitSnapshot,
  };
}

async function verifyEditorDrawerDoesNotReopen(session, connection) {
  session.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  const matching = readMatching(session, connection.grantId, UAT.companyA);
  const missingBasic = BASIC_PROFILE_DIMENSIONS.filter((dimension) =>
    matching.teaser.profileView.rows.find((row) => row.dimension === dimension)?.status !== "known");
  assert.ok(missingBasic.length > 0, "editor 개인 프로필에는 미완성 기본정보가 있어야 합니다.");
  waitFor(session, `Boolean(document.querySelector('button[aria-label="내 사업자 정보 닫기"]'))`);
  session.run(["click", 'button[aria-label="내 사업자 정보 닫기"]']);
  waitFor(session, `!document.querySelector('button[aria-label="내 사업자 정보 닫기"]')`);

  const confirmation = readConfirmations(session, connection.grantId, UAT.companyA);
  assert.equal(confirmation.canSubmit, true);
  const question = requiredQuestion(confirmation);
  const selectedOption = optionByValue(question, "unknown");
  openQuestionFromCard(session, connection.grantId, question.prompt);
  selectQuestionOption(session, question.prompt, selectedOption.label);
  const saved = saveConfirmation(session, connection.grantId, UAT.companyA);
  assert.equal(saved.put.status, 200);
  assert.ok(saved.matchingGet);
  waitForAnimationFrames(session);
  assert.equal(profileDrawerIsOpen(session), false, "확인답변 저장 재조회가 닫은 프로필을 다시 열면 안 됩니다.");
  const persisted = answerFor(readConfirmations(session, connection.grantId, UAT.companyA), question.id);
  assert.deepEqual(persisted.values, [selectedOption.value]);
  return {
    status: "passed",
    missingBasicDimensions: missingBasic,
    initialAutomaticOpen: true,
    explicitClose: true,
    confirmationPutStatus: saved.put.status,
    actualMatchingReload: true,
    profileRemainedClosedAfterSaveReload: true,
    savedRevision: persisted.answerRevision,
  };
}

async function verifyRouteUnmountCompanyIsolation(session, connection) {
  const grantId = connection.servingGrantId;
  const questionA = questionByPrompt(
    readConfirmations(session, grantId, UAT.companyA),
    UAT.servingPrompt,
  );
  const beforeA = optionalAnswerFor(readConfirmations(session, grantId, UAT.companyA), questionA.id);
  assert.equal(beforeA, null, "A의 preferred 질문은 회사 분리 검증 전에 미응답이어야 합니다.");
  const toB = switchCompanyThroughSettingsPage(session, UAT.companyB, UAT.companyBName);
  closeProfileDrawerIfOpen(session);
  const confirmationB = readConfirmations(session, grantId, UAT.companyB);
  const questionB = questionByPrompt(confirmationB, UAT.servingPrompt);
  const beforeB = optionalAnswerFor(confirmationB, questionB.id);
  const optionB = optionByValue(questionB, nextCompanyIsolationOptionValue(beforeB));
  openQuestionFromCard(session, grantId, questionB.prompt);
  selectQuestionOption(session, questionB.prompt, optionB.label);
  const savedB = saveConfirmation(session, grantId, UAT.companyB);
  assert.equal(savedB.put.status, 200);
  const afterB = answerFor(readConfirmations(session, grantId, UAT.companyB), questionB.id);
  assert.deepEqual(afterB.values, [optionB.value]);
  const afterAWhileB = optionalAnswerFor(readConfirmations(session, grantId, UAT.companyA), questionA.id);
  assert.deepEqual(afterAWhileB, beforeA, "B 저장이 A 답변을 바꾸면 안 됩니다.");

  const toA = switchCompanyThroughSettingsPage(session, UAT.companyA, UAT.companyAName);
  closeProfileDrawerIfOpen(session);
  openQuestionFromCard(session, grantId, questionA.prompt);
  assert.deepEqual(selectedLabels(session, questionA.prompt), []);
  closeConfirmationSheet(session);
  return {
    status: "passed",
    grantId,
    questionKind: questionA.kind,
    mechanism: "SettingsPageView.switchCompany_then_matches_route_navigation",
    settingsServerRefreshes: [toB.settingsServerRefreshed, toA.settingsServerRefreshed],
    routeUnmountNavigations: [toB.routeUnmountNavigation, toA.routeUnmountNavigation],
    transitions: ["A_to_B", "B_to_A"],
    companyAStayedUnansweredAfterBSave: true,
    companyBRevision: afterB.answerRevision,
    companyASelectionRestoredAfterRouteUnmount: true,
    inPlaceCompanySwitchClaimed: false,
  };
}

async function verifyLateActualGet(owner, editor, connection) {
  owner.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  closeProfileDrawerIfOpen(owner);
  editor.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  closeProfileDrawerIfOpen(editor);
  const beforePayload = readConfirmations(owner, connection.grantId, UAT.companyA);
  const question = requiredQuestion(beforePayload);
  const before = answerFor(beforePayload, question.id);
  installHeldActualGet(owner, connection.grantId);
  openQuestionFromCard(owner, connection.grantId, question.prompt, { waitForQuestion: false });
  waitFor(owner, "window.__cunoteHeldConfirmationGet?.actual != null");
  const heldRevision = owner.evaluate(`window.__cunoteHeldConfirmationGet.actual.body.data.answers.find(
    answer => answer.questionId === ${JSON.stringify(question.id)})?.answerRevision ?? 0`);
  assert.equal(heldRevision, before.answerRevision);
  closeConfirmationSheet(owner);

  const nextOption = optionByValue(question, "yes");
  openQuestionFromCard(editor, connection.grantId, question.prompt);
  selectQuestionOption(editor, question.prompt, nextOption.label);
  const editorSave = saveConfirmation(editor, connection.grantId, UAT.companyA);
  assert.equal(editorSave.put.status, 200);
  const after = answerFor(readConfirmations(editor, connection.grantId, UAT.companyA), question.id);
  assert.ok(after.answerRevision > before.answerRevision);
  assert.deepEqual(after.values, [nextOption.value]);

  openQuestionFromCard(owner, connection.grantId, question.prompt);
  assert.deepEqual(selectedLabels(owner, question.prompt), [nextOption.label]);
  owner.evaluate("window.__cunoteHeldConfirmationGet.release(); true");
  waitFor(owner, "window.__cunoteHeldConfirmationGet.released === true");
  waitForAnimationFrames(owner);
  assert.deepEqual(selectedLabels(owner, question.prompt), [nextOption.label]);
  closeConfirmationSheet(owner);
  return {
    status: "passed",
    scope: "same_company_close_reopen_with_actual_editor_save",
    oldGetRevision: heldRevision,
    currentRevision: after.answerRevision,
    actualResponseDelayed: true,
    responsePayloadSubstituted: false,
    latestSelectionPreserved: true,
    expectedLabel: nextOption.label,
  };
}

async function verifyLogoutRelogin(session, connection, expectedLabel) {
  session.open("/settings");
  waitFor(session, `Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '로그아웃')`);
  session.run(["find", "role", "button", "click", "--name", "로그아웃", "--exact"]);
  waitFor(session, "location.pathname === '/'");
  assert.equal(readSessionEmail(session), null);
  await login(session, connection, UAT.ownerEmail);
  session.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  closeProfileDrawerIfOpen(session);
  const question = requiredQuestion(readConfirmations(session, connection.grantId, UAT.companyA));
  openQuestionFromCard(session, connection.grantId, question.prompt);
  assert.deepEqual(selectedLabels(session, question.prompt), [expectedLabel]);
  const snapshotSha256 = snapshotDigest(session);
  closeConfirmationSheet(session);
  return {
    status: "passed",
    actualLogoutControl: true,
    sessionAbsentAfterLogout: true,
    actualPasswordRelogin: true,
    persistedSelectionRestored: true,
    snapshotSha256,
  };
}

async function verifyViewerReadOnly(session, connection) {
  session.open(`/matches?companyId=${encodeURIComponent(UAT.companyA)}`);
  closeProfileDrawerIfOpen(session);
  installResponseObserver(session);
  const confirmation = readConfirmations(session, connection.grantId, UAT.companyA);
  assert.equal(confirmation.canSubmit, false);
  const question = requiredQuestion(confirmation);
  const openEvidence = openQuestionFromCard(session, connection.grantId, question.prompt);
  const state = session.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const group = dialog?.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(question.prompt)}]`)});
    const options = group ? Array.from(group.querySelectorAll('button')) : [];
    return {
      notice: dialog?.textContent.includes('조회 전용 권한이에요') === true,
      optionCount: options.length,
      allDisabled: options.length > 0 && options.every(button => button.disabled),
      savePresent: Array.from(dialog?.querySelectorAll('button') ?? []).some(button => button.textContent.trim() === '저장'),
    };
  })()`);
  assert.equal(state.notice, true);
  assert.equal(state.allDisabled, true);
  assert.equal(state.savePresent, false);
  session.evaluate(`(() => {
    const group = document.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(question.prompt)}]`)});
    group?.querySelector('button')?.click();
    return true;
  })()`);
  session.run(["wait", "150"]);
  assert.equal(observedResponses(session).filter((response) => response.method === "PUT").length, 0);
  const snapshotSha256 = snapshotDigest(session);
  closeConfirmationSheet(session);
  return {
    status: "passed",
    naturalCardCta: openEvidence.cta,
    apiCanSubmit: false,
    optionCount: state.optionCount,
    optionsDisabled: true,
    saveButtonAbsent: true,
    putCount: 0,
    snapshotSha256,
  };
}

async function login(session, connection, email) {
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
    const entries = ${JSON.stringify([
      ["input[type=email]", email],
      ["input[type=password]", connection.userPassword],
    ])};
    for (const [selector, value] of entries) {
      const input = document.querySelector(selector);
      if (!input) throw new Error('로그인 입력을 찾지 못했습니다.');
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  })()`);
  session.run(["click", 'button[type="submit"]']);
  waitFor(session, "location.pathname !== '/login'");
  session.run(["wait", "--load", "networkidle"]);
  assert.equal(readSessionEmail(session), email, `${email} 실제 password 로그인이 필요합니다.`);
}

function readSessionEmail(session) {
  return session.evaluate("fetch('/api/auth/session').then(response => response.json()).then(value => value.user?.email ?? null)");
}

function readMatching(session, grantId, companyId) {
  const response = readApi(session, `/api/web/company-matching?${new URLSearchParams({ companyId })}`);
  assert.equal(response.status, 200);
  assert.equal(response.body?.ok, true);
  assert.equal(response.body?.data?.companyId, companyId);
  assert.ok(response.body.data.teaser.matches.some((match) => match.grantId === grantId));
  return response.body.data;
}

function readConfirmations(session, grantId, companyId) {
  const response = readApi(
    session,
    `/api/web/matches/${encodeURIComponent(grantId)}/confirmations?${new URLSearchParams({ companyId })}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body?.ok, true);
  return response.body.data;
}

function readApi(session, path) {
  return session.evaluate(`fetch(${JSON.stringify(path)}).then(async response => ({
    status: response.status,
    body: await response.json(),
  }))`);
}

function requiredQuestion(payload) {
  const question = questionByPrompt(payload, UAT.requiredPrompt);
  assert.ok(question, "required other/text_only 질문이 실제 API에 있어야 합니다.");
  return question;
}

function questionByPrompt(payload, prompt) {
  const question = payload.questions.find((candidate) =>
    candidate.prompt === prompt
    && candidate.binding);
  assert.ok(question, `${prompt} 질문이 실제 API에 있어야 합니다.`);
  return question;
}

function optionByValue(question, value) {
  const option = question.options.find((candidate) => candidate.value === value);
  assert.ok(option, `${value} 선택지가 필요합니다.`);
  return option;
}

function optionLabelForValue(question, value) {
  return optionByValue(question, value).label;
}

function answerFor(payload, questionId) {
  const answer = optionalAnswerFor(payload, questionId);
  assert.ok(answer, `${questionId} 저장 답변이 필요합니다.`);
  return answer;
}

function optionalAnswerFor(payload, questionId) {
  const answer = payload.answers.find((candidate) => candidate.questionId === questionId);
  return answer
    ? { values: answer.values, answerRevision: answer.answerRevision ?? 0 }
    : null;
}

function openQuestionFromCard(session, grantId, prompt, options = {}) {
  const cardSelector = `[data-product-grant=${JSON.stringify(grantId)}]`;
  for (let attempt = 0; attempt < 6 && !session.evaluate(`Boolean(document.querySelector(${JSON.stringify(cardSelector)}))`); attempt += 1) {
    const expanded = session.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(candidate =>
        candidate.getAttribute('aria-expanded') === 'false'
        && /답하면 확정|원문 확인 필요|준비하면 열려요/.test(candidate.textContent));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.equal(expanded, true, `공고 ${grantId}가 있는 결과 버킷을 열 수 없습니다.`);
    session.run(["wait", "100"]);
  }
  waitFor(session, `Boolean(document.querySelector(${JSON.stringify(cardSelector)}))`);
  const collapsed = `${cardSelector} > button[aria-expanded="false"]`;
  if (session.evaluate(`Boolean(document.querySelector(${JSON.stringify(collapsed)}))`)) {
    session.run(["click", collapsed]);
  }
  const cta = session.evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(cardSelector)});
    const button = Array.from(card?.querySelectorAll('button') ?? []).find(candidate =>
      ['확인하기', '확인 내용 수정'].includes(candidate.textContent.trim()));
    return button?.textContent.trim() ?? null;
  })()`);
  assert.ok(cta, "실제 공고 카드에 확인 CTA가 있어야 합니다.");
  session.evaluate(`(() => {
    const card = document.querySelector(${JSON.stringify(cardSelector)});
    const button = Array.from(card?.querySelectorAll('button') ?? []).find(candidate =>
      candidate.textContent.trim() === ${JSON.stringify(cta)});
    if (!button) throw new Error('확인 CTA가 사라졌습니다.');
    button.click();
    return true;
  })()`);
  waitFor(session, `Boolean(document.querySelector('button[aria-label="공고 확인 질문 닫기"]'))`);
  if (options.waitForQuestion !== false) {
    waitFor(session, `Boolean(document.querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(prompt)}]`)}))`);
  }
  return { cta, snapshotSha256: snapshotDigest(session) };
}

function selectQuestionOption(session, prompt, label) {
  const groupSelector = `[aria-label=${JSON.stringify(prompt)}]`;
  const selected = session.evaluate(`(() => {
    const group = document.querySelector(${JSON.stringify(groupSelector)});
    const button = Array.from(group?.querySelectorAll('button') ?? []).find(candidate =>
      candidate.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(selected, true, `${prompt}의 ${label} 선택지를 누를 수 있어야 합니다.`);
  waitFor(session, `(() => {
    const group = document.querySelector(${JSON.stringify(groupSelector)});
    const button = Array.from(group?.querySelectorAll('button') ?? []).find(candidate =>
      candidate.textContent.trim() === ${JSON.stringify(label)});
    return button?.getAttribute('aria-pressed') === 'true' || button?.hasAttribute('data-pressed');
  })()`);
}

function selectedLabels(session, prompt) {
  const groupSelector = `[aria-label=${JSON.stringify(prompt)}]`;
  return session.evaluate(`(() => {
    const group = document.querySelector(${JSON.stringify(groupSelector)});
    return Array.from(group?.querySelectorAll('button') ?? [])
      .filter(button => button.getAttribute('aria-pressed') === 'true' || button.hasAttribute('data-pressed'))
      .map(button => button.textContent.trim());
  })()`);
}

function saveConfirmation(session, grantId, companyId) {
  installResponseObserver(session);
  const clicked = session.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const button = Array.from(dialog?.querySelectorAll('button') ?? []).find(candidate => candidate.textContent.trim() === '저장');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, "현재 writable 확인 시트의 저장 버튼을 눌러야 합니다.");
  waitFor(session, "(window.__cunoteNaturalResponses ?? []).some(response => response.method === 'PUT')");
  waitFor(session, `!document.querySelector('button[aria-label="공고 확인 질문 닫기"]')`);
  waitFor(session, "(window.__cunoteNaturalResponses ?? []).some(response => response.method === 'GET' && response.url.includes('/api/web/company-matching'))");
  session.run(["wait", "--load", "networkidle"]);
  const responses = observedResponses(session);
  const put = responses.filter((response) =>
    response.method === "PUT"
    && response.url.includes(`/api/web/matches/${grantId}/confirmations`)
    && response.url.includes(`companyId=${companyId}`)).at(-1);
  assert.ok(put, "실제 확인답변 PUT 응답을 관찰해야 합니다.");
  return {
    put,
    matchingGet: responses.some((response) =>
      response.method === "GET" && response.url.includes("/api/web/company-matching")),
  };
}

function closeConfirmationSheet(session) {
  if (!session.evaluate(`Boolean(document.querySelector('button[aria-label="공고 확인 질문 닫기"]'))`)) return;
  session.run(["click", 'button[aria-label="공고 확인 질문 닫기"]']);
  waitFor(session, `!document.querySelector('button[aria-label="공고 확인 질문 닫기"]')`);
}

function closeProfileDrawerIfOpen(session) {
  if (!profileDrawerIsOpen(session)) return false;
  session.run(["click", 'button[aria-label="내 사업자 정보 닫기"]']);
  waitFor(session, `!document.querySelector('button[aria-label="내 사업자 정보 닫기"]')`);
  return true;
}

function profileDrawerIsOpen(session) {
  return session.evaluate(`Boolean(document.querySelector('button[aria-label="내 사업자 정보 닫기"]'))`);
}

function installResponseObserver(session) {
  session.evaluate(`(() => {
    if (!window.__cunoteNaturalOriginalFetch) {
      window.__cunoteNaturalOriginalFetch = window.fetch;
      window.fetch = function(...args) {
        const url = String(args[0]?.url ?? args[0]);
        const method = String(args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
        const pending = window.__cunoteNaturalOriginalFetch.apply(this, args);
        pending.then(response => {
          if (!url.includes('/api/web/company-matching') && !url.includes('/confirmations')) return;
          response.clone().json().then(body => {
            window.__cunoteNaturalResponses.push({ url, method, status: response.status, body });
          }).catch(() => {});
        });
        return pending;
      };
    }
    window.__cunoteNaturalResponses = [];
    return true;
  })()`);
}

function observedResponses(session) {
  return session.evaluate("window.__cunoteNaturalResponses ?? []");
}

function installHeldActualGet(session, grantId) {
  session.evaluate(`(() => {
    const originalFetch = window.fetch;
    let holdNext = true;
    window.__cunoteHeldConfirmationGet = null;
    window.fetch = function(...args) {
      const url = String(args[0]?.url ?? args[0]);
      const method = String(args[1]?.method ?? args[0]?.method ?? 'GET').toUpperCase();
      const actualRequest = originalFetch.apply(this, args);
      if (!holdNext || method !== 'GET' || !url.includes(${JSON.stringify(`/matches/${grantId}/confirmations`)})) {
        return actualRequest;
      }
      holdNext = false;
      return actualRequest.then(async response => {
        const body = await response.clone().json();
        return new Promise(resolve => {
          window.__cunoteHeldConfirmationGet = {
            actual: { status: response.status, body },
            released: false,
            release() {
              this.released = true;
              resolve(response);
            },
          };
        });
      });
    };
    return true;
  })()`);
}

function switchCompanyThroughSettingsPage(session, companyId, companyName) {
  session.open("/settings#company-settings");
  waitFor(session, "Array.from(document.querySelectorAll('button')).some(button => button.textContent.trim() === '다른 사업자로 변경')");
  const before = readApi(session, "/api/web/companies");
  assert.equal(before.status, 200);
  assert.notEqual(before.body?.data?.currentCompanyId, companyId, "이미 선택된 회사로는 회사 전환을 검증할 수 없습니다.");
  const settingsTimeOrigin = session.evaluate("performance.timeOrigin");
  session.run(["find", "role", "button", "click", "--name", "다른 사업자로 변경", "--exact"]);
  waitFor(session, "Boolean(document.querySelector('[role=dialog]'))");
  const clicked = session.evaluate(`(() => {
    const dialog = document.querySelector('[role=dialog]');
    const button = Array.from(dialog?.querySelectorAll('button') ?? []).find(candidate =>
      candidate.textContent.includes(${JSON.stringify(companyName)}) && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `${companyName} 전환 버튼을 눌러야 합니다.`);
  session.run(["wait", "--load", "networkidle"]);
  waitFor(session, `fetch('/api/web/companies').then(response => response.json()).then(body => body.data?.currentCompanyId === ${JSON.stringify(companyId)})`);
  assert.equal(session.evaluate("performance.timeOrigin"), settingsTimeOrigin, "SettingsPageView 전환은 router.refresh 계약이어야 합니다.");
  const after = readApi(session, "/api/web/companies");
  assert.equal(after.status, 200);
  assert.equal(after.body?.data?.currentCompanyId, companyId);
  session.open(`/matches?companyId=${encodeURIComponent(companyId)}`);
  waitFor(session, `new URL(location.href).searchParams.get('companyId') === ${JSON.stringify(companyId)}`);
  assert.ok(session.evaluate("performance.timeOrigin") > settingsTimeOrigin, "matches route navigation은 새 document여야 합니다.");
  return {
    previousCompanyId: before.body?.data?.currentCompanyId,
    currentCompanyId: companyId,
    settingsServerRefreshed: true,
    routeUnmountNavigation: true,
  };
}

function waitFor(session, expression) {
  session.run(["wait", "--fn", expression]);
}

function waitForAnimationFrames(session) {
  session.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
}

function snapshotDigest(session) {
  return createHash("sha256").update(JSON.stringify(session.snapshot())).digest("hex");
}

function assertHoldActive(connection) {
  assert.ok(connection.holdUntilMs > Date.now() + 15_000, "bounded UAT hold가 종료되기 전에 인수를 마쳐야 합니다.");
}

function validateSourceManifest(connection, canonicalTmp) {
  assert.match(connection?.sourceManifestSha256 ?? "", SHA256, "source manifest SHA가 필요합니다.");
  const requestedManifestPath = resolve(connection.sourceManifestPath);
  assertPrivateRegularFile(requestedManifestPath, "UAT source manifest");
  const manifestPath = realpathSync(requestedManifestPath);

  const requestedSnapshotRoot = resolve(connection.snapshotRoot);
  const snapshotStat = lstatSync(requestedSnapshotRoot);
  assert.ok(snapshotStat.isDirectory() && !snapshotStat.isSymbolicLink(), "UAT source snapshot은 실제 디렉터리여야 합니다.");
  assert.equal(snapshotStat.mode & 0o777, 0o700, "UAT source snapshot 권한은 0700이어야 합니다.");
  assertOwnedByCurrentUser(snapshotStat, "UAT source snapshot");
  const snapshotRoot = realpathSync(requestedSnapshotRoot);
  const sourceRunRoot = realpathSync(dirname(snapshotRoot));
  assert.ok(sourceRunRoot.startsWith(`${canonicalTmp}${sep}`), "UAT source snapshot은 실제 임시 디렉터리 안에 있어야 합니다.");
  assert.match(basename(sourceRunRoot), /^cunote-product-uat-source-[A-Za-z0-9]+$/);
  assert.equal(dirname(manifestPath), sourceRunRoot, "source manifest와 snapshot root의 runtime이 다릅니다.");
  const sourceMarkerPath = join(sourceRunRoot, OWNER_MARKER);
  assertPrivateRegularFile(sourceMarkerPath, "UAT source owner marker");
  const sourceMarker = readJson(sourceMarkerPath, "UAT source owner marker");
  assert.equal(sourceMarker?.schema, OWNER_MARKER_SCHEMA);
  assert.match(sourceMarker?.id ?? "", UUID);

  const manifest = readJson(manifestPath, "UAT source manifest");
  assert.equal(manifest?.schema, SOURCE_MANIFEST_SCHEMA);
  assert.equal(realpathSync(manifest.snapshotRoot), snapshotRoot, "source manifest가 다른 snapshot을 가리킵니다.");
  assert.equal(manifest.sha256, connection.sourceManifestSha256, "connection source manifest SHA가 다릅니다.");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, "source manifest file inventory가 필요합니다.");
  assert.equal(
    sha256Value(Buffer.from(JSON.stringify(manifest.files))),
    connection.sourceManifestSha256,
    "source manifest inventory SHA가 다릅니다.",
  );
  const generatedDeclarations = [];
  for (const entry of manifest.files) {
    assert.equal(typeof entry?.path, "string");
    assert.match(entry?.sha256 ?? "", SHA256);
    const sourcePath = resolve(snapshotRoot, entry.path);
    assert.ok(sourcePath.startsWith(`${snapshotRoot}${sep}`), "source manifest 상대경로가 snapshot을 벗어납니다.");
    const sourceStat = lstatSync(sourcePath);
    assert.ok(sourceStat.isFile() && !sourceStat.isSymbolicLink(), `${entry.path}: manifest source가 실제 파일이어야 합니다.`);
    const currentSha256 = sha256File(sourcePath);
    if (NEXT_GENERATED_DECLARATIONS.has(entry.path)) {
      assert.equal(
        readFileSync(sourcePath, "utf8"),
        NEXT_PRODUCTION_DECLARATION,
        `${entry.path}: Next production build가 만든 declaration template과 다릅니다.`,
      );
      generatedDeclarations.push({
        path: entry.path,
        manifestSha256: entry.sha256,
        currentSha256,
        classification: "next_production_generated_declaration",
        exactTemplateVerified: true,
      });
      continue;
    }
    assert.equal(currentSha256, entry.sha256, `${entry.path}: snapshot source SHA가 manifest와 다릅니다.`);
  }
  assert.deepEqual(
    generatedDeclarations.map((entry) => entry.path).sort(),
    [...NEXT_GENERATED_DECLARATIONS].sort(),
    "두 Next generated declaration만 build 변환 예외로 분류해야 합니다.",
  );
  return {
    manifestPath,
    manifestSha256: connection.sourceManifestSha256,
    snapshotRoot,
    fileCount: manifest.files.length,
    generatedDeclarations,
  };
}

function assertPrivateRegularFile(path, label) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `${label}는 실제 일반 파일이어야 합니다.`);
  assert.equal(stat.mode & 0o777, 0o600, `${label} 권한은 0600이어야 합니다.`);
  assertOwnedByCurrentUser(stat, label);
}

function assertOwnedByCurrentUser(stat, label) {
  if (typeof process.getuid === "function") {
    assert.equal(stat.uid, process.getuid(), `${label}는 현재 사용자가 소유해야 합니다.`);
  }
}

function assertLoopbackUrl(value) {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", "UAT 앱은 loopback HTTP만 허용합니다.");
  assert.equal(url.hostname, "127.0.0.1", "UAT 앱 host는 127.0.0.1이어야 합니다.");
  assert.match(url.port, /^\d+$/, "UAT 앱 port가 필요합니다.");
  assert.ok(Number(url.port) > 0 && Number(url.port) <= 65_535);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.ok(url.pathname === "/" || url.pathname === "", "UAT base URL에는 경로를 넣을 수 없습니다.");
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
}

function normalizeLoopbackUrl(value) {
  return new URL(value).origin;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} JSON을 읽지 못했습니다.`, { cause: error });
  }
}

function normalizeEvaluation(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !/^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(trimmed)) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function redact(value, secrets) {
  let output = String(value);
  for (const secret of secrets) output = output.split(secret).join("[redacted]");
  return output;
}

function sha256File(path) {
  return sha256Value(readFileSync(path));
}

function sha256Value(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  let secrets = [];
  try {
    const { connectionPath } = parseNaturalConfirmationArgs(process.argv.slice(2));
    const connection = validateNaturalConfirmationConnection(connectionPath);
    secrets = [connection.userPassword];
    const receipt = await runNaturalConfirmationAcceptance(connection);
    const receiptPath = join(connection.runtimeRoot, OUTPUT_RECEIPT);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({
      ok: true,
      suite: "natural-confirmations-browser",
      status: receipt.status,
      receiptPath,
      checks: {
        ownerRoundTrip: receipt.ownerRoundTrip.status,
        editorDrawer: receipt.editorDrawer.status,
        companyIsolation: receipt.companyIsolation.status,
        lateGet: receipt.lateGet.status,
        logoutRelogin: receipt.logoutRelogin.status,
        viewerReadOnly: receipt.viewerReadOnly.status,
      },
      modelCalls: 0,
      externalWrites: 0,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      suite: "natural-confirmations-browser",
      error: redact(error instanceof Error ? error.message : error, secrets),
    }));
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) await main();
