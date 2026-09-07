import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  createProductUatEnv,
  createProductUatSourceSnapshot,
  stopTrackedChild,
  trackChildProcess,
  withIsolatedProductUatPostgres,
} from "./product-uat/runtime.mjs";

const runnerAbort = new AbortController();
const onSignal = (signal) => runnerAbort.abort(new Error(`local product UAT interrupted: ${signal}`));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
const { holdSeconds } = parseRunnerArgs(process.argv.slice(2));

const LOCAL_UAT_IDS = {
  owner: "10000000-0000-4000-8000-000000000001",
  editor: "10000000-0000-4000-8000-000000000002",
  viewer: "10000000-0000-4000-8000-000000000003",
  companyA: "20000000-0000-4000-8000-000000000001",
  companyB: "20000000-0000-4000-8000-000000000002",
  admin: "30000000-0000-4000-8000-000000000001",
};

class CookieJar {
  #cookies = new Map();

  async fetch(url, options = {}) {
    const headers = new Headers(options.headers);
    if (this.#cookies.size > 0) {
      headers.set("cookie", [...this.#cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    }
    const response = await fetch(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.any([
        runnerAbort.signal,
        AbortSignal.timeout(15_000),
      ]),
    });
    const setCookies = response.headers.getSetCookie();
    for (const value of setCookies) {
      const pair = value.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const key = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue) this.#cookies.set(key, cookieValue);
      else this.#cookies.delete(key);
    }
    return response;
  }
}

const source = createProductUatSourceSnapshot({ sourceRoot: process.cwd() });
const sourceManifestPath = join(source.runRoot, "source-manifest.json");
writeFileSync(sourceManifestPath, `${JSON.stringify({
  schema: "cunote-local-product-uat-source-manifest-v1",
  sourceRoot: source.sourceRoot,
  snapshotRoot: source.snapshotRoot,
  sha256: source.sourceManifestSha256,
  files: source.sourceFiles,
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
const result = await withIsolatedProductUatPostgres(async (postgresRuntime) => {
  const logsPath = join(postgresRuntime.runRoot, "logs");
  mkdirSync(logsPath, { mode: 0o700 });
  const webPort = await availableLoopbackPort();
  const adminPort = await availableLoopbackPort();
  const userPassword = randomSecret();
  const adminPassword = randomSecret();
  const webSecret = randomSecret();
  const adminSecret = randomSecret();
  const sharedEnv = createProductUatEnv({
    ...postgresRuntime.env,
    NODE_ENV: "production",
    VERCEL_ENV: "preview",
    CUNOTE_AUTH_DB_ADAPTER: "drizzle",
    CUNOTE_AUTH_REQUIRED: "true",
    CUNOTE_REPOSITORY_ADAPTER: "drizzle",
    CUNOTE_SOURCE_CORRECTIONS_ENABLED: "true",
    CUNOTE_DOCUMENT_AGENT_ENABLED: "false",
    CUNOTE_FIELD_EDITOR_AGENT_ENABLED: "false",
    BILLING_AUTO_BILLING_ENABLED: "false",
    BILLING_INVOICES_ENABLED: "false",
    APPLICATION_PRECOMPUTE_WORKER_MODE: "observe_only",
    DEEP_ANALYSIS_WORKER_MODE: "observe_only",
    NEXT_TELEMETRY_DISABLED: "1",
  });
  const webUrl = `http://127.0.0.1:${webPort}`;
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  const buildEnv = createProductUatEnv({
    ...sharedEnv,
    NEXTAUTH_URL: webUrl,
    NEXTAUTH_SECRET: webSecret,
    AUTH_SECRET: webSecret,
    ADMIN_AUTH_URL: adminUrl,
    ADMIN_AUTH_SECRET: adminSecret,
    ADMIN_ALLOWED_EMAILS: "manager@noten.im",
  });

  runLogged({
    command: "pnpm",
    args: ["exec", "tsx", "--tsconfig", "apps/web/tsconfig.json", "tools/product-uat/seed-local-credentials.ts"],
    cwd: source.snapshotRoot,
    env: createProductUatEnv({
      ...buildEnv,
      CUNOTE_LOCAL_UAT_USER_PASSWORD: userPassword,
      CUNOTE_LOCAL_UAT_ADMIN_PASSWORD: adminPassword,
    }),
    logPath: join(logsPath, "seed.log"),
    timeout: 180_000,
  });
  runLogged({
    command: "pnpm",
    args: ["build:packages"],
    cwd: source.snapshotRoot,
    env: buildEnv,
    logPath: join(logsPath, "build-packages.log"),
    timeout: 300_000,
  });
  const initialConfirmationFixture = runConfirmationFixture({
    action: "r1",
    sourceRoot: source.snapshotRoot,
    env: createProductUatEnv({
      ...buildEnv,
      CUNOTE_PRODUCT_UAT_RUNTIME_ROOT: postgresRuntime.runRoot,
    }),
    logPath: join(logsPath, "confirmation-r1.log"),
  });
  runLogged({
    command: "pnpm",
    args: ["--filter", "@cunote/web", "build"],
    cwd: source.snapshotRoot,
    env: buildEnv,
    logPath: join(logsPath, "build-web.log"),
    timeout: 600_000,
  });
  runLogged({
    command: "pnpm",
    args: ["--filter", "@cunote/admin", "build"],
    cwd: source.snapshotRoot,
    env: buildEnv,
    logPath: join(logsPath, "build-admin.log"),
    timeout: 600_000,
  });

  let web;
  let admin;
  try {
    web = startNextServer({
      app: "web",
      sourceRoot: source.snapshotRoot,
      port: webPort,
      env: createProductUatEnv({
        ...buildEnv,
        NEXTAUTH_URL: webUrl,
        NEXTAUTH_SECRET: webSecret,
        AUTH_SECRET: webSecret,
      }),
      logPath: join(logsPath, "web-server.log"),
    });
    admin = startNextServer({
      app: "admin",
      sourceRoot: source.snapshotRoot,
      port: adminPort,
      env: createProductUatEnv({
        ...buildEnv,
        NEXTAUTH_URL: adminUrl,
        NEXTAUTH_SECRET: adminSecret,
        AUTH_SECRET: adminSecret,
        ADMIN_AUTH_URL: adminUrl,
        ADMIN_AUTH_SECRET: adminSecret,
      }),
      logPath: join(logsPath, "admin-server.log"),
    });
    await Promise.all([
      waitForHttp(`${webUrl}/login`, web),
      waitForHttp(`${adminUrl}/login`, admin),
    ]);
    const webAccounts = [];
    const webAuthenticationByUserId = new Map();
    for (const account of [
      {
        email: "sw@noten.im",
        userId: LOCAL_UAT_IDS.owner,
        companies: [
          { id: LOCAL_UAT_IDS.companyA, role: "owner" },
          { id: LOCAL_UAT_IDS.companyB, role: "owner" },
        ],
      },
      {
        email: "dev@noten.im",
        userId: LOCAL_UAT_IDS.editor,
        companies: [{ id: LOCAL_UAT_IDS.companyA, role: "member" }],
      },
      {
        email: "guest@noten.im",
        userId: LOCAL_UAT_IDS.viewer,
        companies: [{ id: LOCAL_UAT_IDS.companyA, role: "viewer" }],
      },
    ]) {
      const authenticated = await verifyPasswordLogin({
        baseUrl: webUrl,
        email: account.email,
        password: userPassword,
        expectedUserId: account.userId,
      });
      await verifyVisibleCompanies(authenticated.jar, webUrl, account.companies);
      webAuthenticationByUserId.set(account.userId, authenticated);
      webAccounts.push(authenticated.proof);
    }
    const ownerAuthentication = webAuthenticationByUserId.get(LOCAL_UAT_IDS.owner);
    assert.ok(ownerAuthentication);
    const initialConfirmationRoundTrip = await verifyInitialConfirmationRoundTrip({
      jar: ownerAuthentication.jar,
      baseUrl: webUrl,
      grantId: initialConfirmationFixture.fixture.grantId,
      companyId: LOCAL_UAT_IDS.companyA,
    });
    const confirmationScenarios = await verifyConfirmationScenarios({
      baseUrl: webUrl,
      grantId: initialConfirmationFixture.fixture.grantId,
      owner: ownerAuthentication,
      editor: webAuthenticationByUserId.get(LOCAL_UAT_IDS.editor),
      viewer: webAuthenticationByUserId.get(LOCAL_UAT_IDS.viewer),
      userPassword,
      initial: initialConfirmationRoundTrip.internal,
      runFixture: (action, label) => runConfirmationFixture({
        action,
        sourceRoot: source.snapshotRoot,
        env: createProductUatEnv({
          ...buildEnv,
          CUNOTE_PRODUCT_UAT_RUNTIME_ROOT: postgresRuntime.runRoot,
        }),
        logPath: join(logsPath, `confirmation-${label}.log`),
      }),
    });
    await verifyRejectedWebAccess({ baseUrl: webUrl, password: userPassword });
    const relogin = await verifyLogoutAndRelogin({
      baseUrl: webUrl,
      email: "sw@noten.im",
      password: userPassword,
      expectedUserId: LOCAL_UAT_IDS.owner,
    });
    const adminLogin = await verifyPasswordLogin({
      baseUrl: adminUrl,
      email: "manager@noten.im",
      password: adminPassword,
      expectedUserId: LOCAL_UAT_IDS.admin,
      expectedRole: "admin",
    });
    const confirmationFixtureReceiptPath = join(postgresRuntime.runRoot, "confirmation-fixture-receipt.json");
    writeFileSync(confirmationFixtureReceiptPath, `${JSON.stringify({
      schema: "cunote-local-product-uat-confirmation-fixture-receipt-v1",
      grantId: initialConfirmationFixture.fixture.grantId,
      publicationAuthority: "isolated_publisher_fixture_not_release_approval",
      scenarios: confirmationScenarios.proof,
      finalState: confirmationScenarios.finalState,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const connectionPath = join(postgresRuntime.runRoot, "connection.json");
    const holdUntil = new Date(Date.now() + holdSeconds * 1_000).toISOString();
    writeFileSync(connectionPath, `${JSON.stringify({
      schema: "cunote-local-product-uat-connection-v1",
      holdUntil,
      webUrl,
      adminUrl,
      userPassword,
      adminPassword,
      users: ["sw@noten.im", "dev@noten.im", "guest@noten.im"],
      admin: "manager@noten.im",
      postgresSocketPath: postgresRuntime.socketPath,
      snapshotRoot: source.snapshotRoot,
      confirmationFixtureReceiptPath,
      syntheticGrantId: initialConfirmationFixture.fixture.grantId,
      activeConfirmationQuestions: confirmationScenarios.finalState.activePrompts,
    }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (holdSeconds > 0) {
      console.log(JSON.stringify({
        ok: true,
        status: "holding_for_browser_acceptance",
        connectionPath,
        webUrl,
        adminUrl,
        holdUntil,
      }));
      await holdForBrowserAcceptance(holdSeconds);
    }
    const receipt = {
      schema: "cunote-local-product-uat-receipt-v1",
      completedAt: new Date().toISOString(),
      source: {
        manifestSha256: source.sourceManifestSha256,
        manifestPath: sourceManifestPath,
        fileCount: source.sourceFileCount,
        snapshotRoot: source.snapshotRoot,
        coreRuntimeSha256: hashFile(join(source.snapshotRoot, "packages/core/dist/index.js")),
        contractsRuntimeSha256: hashFile(join(source.snapshotRoot, "packages/contracts/dist/index.js")),
      },
      postgres: {
        socketPath: postgresRuntime.socketPath,
        logPath: postgresRuntime.logPath,
        network: "unix_socket_only",
        serverRole: "postgres_privileged",
      },
      builds: { packages: "passed", web: "passed", admin: "passed" },
      httpCredentialsAcceptance: {
        webAccounts,
        companyVisibility: "passed",
        invalidPassword: "rejected",
        anonymousCompanyAccess: "rejected",
        logoutRelogin: relogin,
        admin: adminLogin.proof,
      },
      confirmationAcceptance: {
        fixturePublication: "isolated_publisher_fixture_not_release_approval",
        initialOwnerRoundTrip: initialConfirmationRoundTrip.proof,
        scenarios: confirmationScenarios.proof,
        fixtureReceiptPath: confirmationFixtureReceiptPath,
      },
      connectionPath,
      exclusions: {
        mockAuth: true,
        googleOauth: true,
        r2: true,
        paidModels: true,
        emailDelivery: true,
      },
    };
    const receiptPath = join(postgresRuntime.runRoot, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { receiptPath, receipt };
  } finally {
    await Promise.all([stopChild(web), stopChild(admin)]);
  }
});

console.log(JSON.stringify({
  ok: true,
  suite: "local-product-uat-first-login",
  receiptPath: result.receiptPath,
  sourceManifestSha256: result.receipt.source.manifestSha256,
  sourceManifestPath: result.receipt.source.manifestPath,
  sourceFileCount: result.receipt.source.fileCount,
  builds: result.receipt.builds,
  httpCredentialsAcceptance: result.receipt.httpCredentialsAcceptance,
  confirmationAcceptance: result.receipt.confirmationAcceptance,
  connectionPath: result.receipt.connectionPath,
  postgresNetwork: result.receipt.postgres.network,
}));
process.removeListener("SIGINT", onSignal);
process.removeListener("SIGTERM", onSignal);

function runLogged({ command, args, cwd, env, logPath, timeout }) {
  throwIfRunnerAborted();
  const execution = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
  writeFileSync(logPath, output, { flag: "wx", mode: 0o600 });
  if (execution.error || execution.status !== 0) {
    const tail = output.split("\n").slice(-40).join("\n");
    throw new Error(`${command} ${args.join(" ")} 실패(exit=${execution.status ?? "error"})\n${tail}`, {
      cause: execution.error,
    });
  }
  throwIfRunnerAborted();
  return output;
}

function runConfirmationFixture({ action, sourceRoot, env, logPath }) {
  const output = runLogged({
    command: "pnpm",
    args: [
      "exec",
      "tsx",
      "--tsconfig",
      "apps/web/tsconfig.json",
      "tools/product-uat/confirmation-fixture.ts",
      `--action=${action}`,
    ],
    cwd: sourceRoot,
    env,
    logPath,
    timeout: 120_000,
  });
  const lastLine = output.trim().split("\n").at(-1);
  const parsed = lastLine ? JSON.parse(lastLine) : null;
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.action, action);
  return parsed;
}

function startNextServer({ app, sourceRoot, port, env, logPath }) {
  const descriptor = openSync(logPath, "wx", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [
      join(sourceRoot, `apps/${app}/node_modules/next/dist/bin/next`),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ], {
      cwd: join(sourceRoot, `apps/${app}`),
      env,
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  return trackChildProcess(child);
}

async function waitForHttp(url, runtime) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    throwIfRunnerAborted();
    if (runtime.spawnError) throw new Error("Next server 프로세스를 시작하지 못했습니다.", { cause: runtime.spawnError });
    if (runtime.closed || runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`Next server가 준비 전에 종료했습니다(exit=${runtime.child.exitCode}, signal=${runtime.child.signalCode}).`);
    }
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.any([runnerAbort.signal, AbortSignal.timeout(2_000)]),
      });
      if (response.status >= 200 && response.status < 500) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Next server 준비 timeout: ${url}`);
}

async function verifyPasswordLogin({
  baseUrl,
  email,
  password,
  expectedUserId,
  expectedRole,
  jar = new CookieJar(),
}) {
  const csrfResponse = await jar.fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(csrfResponse.status, 200);
  const csrf = await csrfResponse.json();
  assert.equal(typeof csrf.csrfToken, "string");

  const body = new URLSearchParams({
    csrfToken: csrf.csrfToken,
    email,
    password,
    callbackUrl: `${baseUrl}/dashboard`,
    json: "true",
  });
  const loginResponse = await jar.fetch(`${baseUrl}/api/auth/callback/password`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body,
    redirect: "manual",
  });
  assert.equal(loginResponse.status, 200, `Credentials callback status=${loginResponse.status}`);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.error, undefined);

  const sessionResponse = await jar.fetch(`${baseUrl}/api/auth/session`);
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session?.user?.email, email);
  assert.equal(session?.user?.id, expectedUserId);
  if (expectedRole) assert.equal(session?.user?.role, expectedRole);
  return {
    jar,
    proof: {
      status: "passed",
      provider: "password",
      sessionStrategy: "jwt",
      email,
      userId: session.user.id,
      ...(expectedRole ? { role: session.user.role } : {}),
    },
  };
}

async function verifyVisibleCompanies(jar, baseUrl, expected) {
  const response = await jar.fetch(`${baseUrl}/api/web/companies`);
  assert.equal(response.status, 200);
  const body = await response.json();
  const actual = body?.data?.companies
    ?.map((company) => ({ id: company.id, role: company.role }))
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(actual, [...expected].sort((left, right) => left.id.localeCompare(right.id)));
}

async function verifyInitialConfirmationRoundTrip({ jar, baseUrl, grantId, companyId }) {
  const endpoint = confirmationEndpoint(baseUrl, grantId, companyId);
  const initial = await readConfirmations(jar, endpoint);
  assert.equal(initial.answers.length, 0);
  const required = initial.questions.find((question) => question.prompt === "최초 필수 질문");
  const legacy = initial.questions.find((question) => question.prompt === "기존 제외 질문");
  assert.ok(required?.binding);
  assert.ok(legacy && !legacy.binding);
  const response = await jar.fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      answers: [
        {
          questionId: required.id,
          values: ["yes"],
          binding: required.binding,
          expectedAnswerRevision: 0,
        },
        { questionId: legacy.id, values: ["clear"] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload?.ok, true);
  assert.equal(payload?.data?.saved?.length, 2);
  assert.equal(payload.data.saved.find((answer) => answer.questionId === required.id)?.evaluation, "satisfied");
  assert.equal(payload.data.saved.find((answer) => answer.questionId === required.id)?.answerRevision, 1);
  assert.equal(payload.data.saved.find((answer) => answer.questionId === legacy.id)?.disqualified, false);
  assert.equal(payload.data.refresh?.status, "not_persisted_user_scope");
  assert.equal(payload.data.refresh?.plannedCount, 1);
  assert.equal(payload.data.refresh?.savedCount, 0);
  assert.equal(payload.data.match?.eligibility, "eligible");
  const requiredTrace = payload.data.match?.ruleTrace?.find(
    (trace) => trace.criterionId === required.binding.criterionId,
  );
  assert.equal(requiredTrace?.result, "pass");
  assert.equal(requiredTrace?.resolution, "confirmed_by_user");
  const reloaded = await readConfirmations(jar, endpoint);
  assert.equal(reloaded.answers.find((answer) => answer.questionId === required.id)?.evaluation, "satisfied");
  assert.equal(reloaded.answers.find((answer) => answer.questionId === required.id)?.answerRevision, 1);
  assert.deepEqual(reloaded.answers.find((answer) => answer.questionId === legacy.id)?.values, ["clear"]);
  return {
    proof: {
      status: "passed",
      questionCount: initial.questions.length,
      savedCount: payload.data.saved.length,
      refreshStatus: payload.data.refresh.status,
      refreshPlannedCount: payload.data.refresh.plannedCount,
      refreshSavedCount: payload.data.refresh.savedCount,
      matchPresent: Boolean(payload.data.match),
      matchEligibility: payload.data.match.eligibility,
      requiredTrace: { result: requiredTrace.result, resolution: requiredTrace.resolution },
      requiredEvaluation: "satisfied",
      requiredAnswerRevision: 1,
      legacyDisqualified: false,
    },
    internal: { required, legacy },
  };
}

async function verifyConfirmationScenarios({
  baseUrl,
  grantId,
  owner,
  editor,
  viewer,
  userPassword,
  initial,
  runFixture,
}) {
  assert.ok(owner && editor && viewer);
  const endpointA = confirmationEndpoint(baseUrl, grantId, LOCAL_UAT_IDS.companyA);
  const endpointB = confirmationEndpoint(baseUrl, grantId, LOCAL_UAT_IDS.companyB);

  const ownerBInitial = await readConfirmations(owner.jar, endpointB);
  assert.equal(ownerBInitial.answers.length, 0, "회사 A 답변은 회사 B에 재사용하지 않는다");
  const requiredB = ownerBInitial.questions.find((question) => question.prompt === "최초 필수 질문");
  const legacyB = ownerBInitial.questions.find((question) => question.prompt === "기존 제외 질문");
  assert.ok(requiredB?.binding && legacyB);
  const companyBSave = await submitConfirmations(owner.jar, endpointB, [
    {
      questionId: requiredB.id,
      values: ["no"],
      binding: requiredB.binding,
      expectedAnswerRevision: 0,
    },
    { questionId: legacyB.id, values: ["restricted"] },
  ]);
  assert.equal(companyBSave.status, 200);
  assert.equal(companyBSave.body?.data?.match?.eligibility, "ineligible");
  assert.equal((await readConfirmations(owner.jar, endpointA)).answers.find(
    (answer) => answer.questionId === initial.required.id,
  )?.evaluation, "satisfied");

  const editorA = await readConfirmations(editor.jar, endpointA);
  const editorRequired = editorA.questions.find((question) => question.id === initial.required.id);
  assert.ok(editorRequired?.binding);
  assert.equal(editorA.answers.find((answer) => answer.questionId === editorRequired.id)?.answerRevision, 1);
  const editorSave = await submitConfirmations(editor.jar, endpointA, [{
    questionId: editorRequired.id,
    values: ["unknown"],
    binding: editorRequired.binding,
    expectedAnswerRevision: 1,
  }]);
  assert.equal(editorSave.status, 200);
  assert.equal(editorSave.body?.data?.saved?.[0]?.evaluation, "unknown");
  assert.equal(editorSave.body?.data?.saved?.[0]?.answerRevision, 2);

  const beforeStale = runFixture("inspect", "before-stale");
  const stale = await submitConfirmations(owner.jar, endpointA, [{
    questionId: initial.required.id,
    values: ["no"],
    binding: initial.required.binding,
    expectedAnswerRevision: 1,
  }]);
  assert.equal(stale.status, 409);
  assert.equal(stale.body?.error?.code, "confirmation_answer_conflict");
  const afterStale = runFixture("inspect", "after-stale");
  assert.equal(ledgerSha(afterStale), ledgerSha(beforeStale));

  const beforeViewer = runFixture("inspect", "before-viewer-forbidden");
  const viewerSave = await submitConfirmations(viewer.jar, endpointA, [{
    questionId: initial.required.id,
    values: ["yes"],
    binding: initial.required.binding,
    expectedAnswerRevision: 2,
  }]);
  assert.equal(viewerSave.status, 403);
  assert.equal(viewerSave.body?.error?.code, "company_write_forbidden");
  const editorBRead = await editor.jar.fetch(endpointB);
  assert.equal(editorBRead.status, 403);
  const editorBSave = await submitConfirmations(editor.jar, endpointB, [{
    questionId: requiredB.id,
    values: ["yes"],
    binding: requiredB.binding,
    expectedAnswerRevision: 1,
  }]);
  assert.equal(editorBSave.status, 403);
  const afterForbidden = runFixture("inspect", "after-forbidden");
  assert.equal(ledgerSha(afterForbidden), ledgerSha(beforeViewer));

  await signOut(owner.jar, baseUrl);
  await assertNoSession(owner.jar, baseUrl);
  const reloggedOwner = await verifyPasswordLogin({
    baseUrl,
    email: "sw@noten.im",
    password: userPassword,
    expectedUserId: LOCAL_UAT_IDS.owner,
  });
  const reloggedA = await readConfirmations(reloggedOwner.jar, endpointA);
  assert.equal(reloggedA.answers.find((answer) => answer.questionId === initial.required.id)?.evaluation, "unknown");
  assert.equal(reloggedA.answers.find((answer) => answer.questionId === initial.required.id)?.answerRevision, 2);

  const revision2 = runFixture("r2", "r2");
  const revisedA = await readConfirmations(reloggedOwner.jar, endpointA);
  assert.deepEqual(revisedA.questions.map((question) => question.prompt).sort(), [
    "기존 제외 질문",
    "수정한 필수 질문",
    "추가한 우대 질문",
  ]);
  const revisedRequired = revisedA.questions.find((question) => question.prompt === "수정한 필수 질문");
  const preferred = revisedA.questions.find((question) => question.prompt === "추가한 우대 질문");
  const unchangedLegacy = revisedA.questions.find((question) => question.prompt === "기존 제외 질문");
  assert.ok(revisedRequired?.binding && preferred?.binding && unchangedLegacy);
  assert.equal(revisedA.answers.some((answer) => answer.questionId === revisedRequired.id), false);
  assert.deepEqual(revisedA.answers.find((answer) => answer.questionId === unchangedLegacy.id)?.values, ["clear"]);
  const beforeOldDefinition = runFixture("inspect", "before-old-definition");
  const oldDefinitionSave = await submitConfirmations(reloggedOwner.jar, endpointA, [{
    questionId: initial.required.id,
    values: ["yes"],
    binding: initial.required.binding,
    expectedAnswerRevision: 2,
  }]);
  assert.equal(oldDefinitionSave.status, 404);
  const afterOldDefinition = runFixture("inspect", "after-old-definition");
  assert.equal(ledgerSha(afterOldDefinition), ledgerSha(beforeOldDefinition));
  const revisedSave = await submitConfirmations(reloggedOwner.jar, endpointA, [
    {
      questionId: revisedRequired.id,
      values: ["satisfied"],
      binding: revisedRequired.binding,
      expectedAnswerRevision: 0,
    },
    {
      questionId: preferred.id,
      values: ["unknown"],
      binding: preferred.binding,
      expectedAnswerRevision: 0,
    },
  ]);
  assert.equal(revisedSave.status, 200);
  assert.equal(revisedSave.body?.data?.match?.eligibility, "eligible");

  const withdrawal = runFixture("withdraw", "withdraw");
  assert.equal(withdrawal.state.answers.length, 6, "manual 철회는 A/B·legacy·r2 답변 이력을 삭제하지 않는다");
  assert.equal(withdrawal.state.answers.filter((answer) => answer.companyId === LOCAL_UAT_IDS.companyA).length, 4);
  assert.equal(withdrawal.state.answers.filter((answer) => answer.companyId === LOCAL_UAT_IDS.companyB).length, 2);
  assert.ok(withdrawal.state.answers.some((answer) =>
    answer.companyId === LOCAL_UAT_IDS.companyA
    && answer.questionId === initial.required.id
    && answer.evaluation === "unknown"
    && answer.answerRevision === 2));
  assert.ok(withdrawal.state.answers.some((answer) =>
    answer.companyId === LOCAL_UAT_IDS.companyB
    && answer.questionId === requiredB.id
    && answer.evaluation === "unsatisfied"
    && answer.answerRevision === 1));
  assert.ok(withdrawal.state.answers.some((answer) =>
    answer.companyId === LOCAL_UAT_IDS.companyA
    && answer.questionId === initial.legacy.id
    && answer.evaluation === null));
  const withdrawnA = await readConfirmations(reloggedOwner.jar, endpointA);
  assert.deepEqual(withdrawnA.questions.map((question) => question.prompt), ["기존 제외 질문"]);
  assert.deepEqual(withdrawnA.answers.map((answer) => answer.questionId), [unchangedLegacy.id]);
  const beforeWithdrawnSave = runFixture("inspect", "before-withdrawn-save");
  const withdrawnSave = await submitConfirmations(reloggedOwner.jar, endpointA, [{
    questionId: revisedRequired.id,
    values: ["satisfied"],
    binding: revisedRequired.binding,
    expectedAnswerRevision: 1,
  }]);
  assert.equal(withdrawnSave.status, 404);
  const afterWithdrawnSave = runFixture("inspect", "after-withdrawn-save");
  assert.equal(ledgerSha(afterWithdrawnSave), ledgerSha(beforeWithdrawnSave));

  const rollback = runFixture("rollback", "rollback");
  const restoredA = await readConfirmations(reloggedOwner.jar, endpointA);
  assert.deepEqual(restoredA.questions.map((question) => question.prompt).sort(), ["기존 제외 질문", "최초 필수 질문"]);
  assert.equal(restoredA.answers.find((answer) => answer.questionId === initial.required.id)?.evaluation, "unknown");
  assert.equal(restoredA.answers.find((answer) => answer.questionId === initial.required.id)?.answerRevision, 2);
  assert.deepEqual(restoredA.answers.find((answer) => answer.questionId === initial.legacy.id)?.values, ["clear"]);
  assert.equal(rollback.state.answers.length, 6);

  const listingResponse = await reloggedOwner.jar.fetch(`${baseUrl}/api/web/matches?limit=40`);
  assert.equal(listingResponse.status, 200);
  const listingBody = await listingResponse.json();
  assert.equal(listingBody?.ok, true);
  assert.equal(listingBody?.data?.matches?.some((match) => match.grantId === grantId), false);

  return {
    proof: {
      status: "passed",
      companyIsolation: "A_and_B_answers_independent",
      editorAWrite: "passed",
      viewerAWrite: "forbidden_403",
      editorBReadWrite: "forbidden_403",
      staleAnswerRevision: "conflict_409_without_ledger_change",
      reloginAnswerRevision: 2,
      revision2: {
        changedQuestionRequiresNewAnswer: true,
        preferredQuestionAdded: true,
        unchangedLegacyAnswerPreserved: true,
        oldDefinitionStatus: oldDefinitionSave.status,
      },
      withdrawAll: {
        manualQuestionsActive: 0,
        legacyQuestionsActive: 1,
        withdrawnSaveStatus: withdrawnSave.status,
      },
      rollback: {
        restoredInitialManualQuestion: true,
        restoredAnswerRevision: 2,
        preservedLegacyAnswer: true,
      },
      naturalListing: {
        syntheticGrantVisible: false,
        reason: "serving_release_registry_not_seeded",
        directConfirmationHttpIsNotNaturalUiAcceptance: true,
      },
      matcherObservations: {
        companyBEligibility: companyBSave.body.data.match.eligibility,
        revision2Eligibility: revisedSave.body.data.match.eligibility,
        revision2RefreshStatus: revisedSave.body.data.refresh?.status ?? "unreported",
      },
      fixtureTransitions: {
        r2LedgerSha256: ledgerSha(revision2),
        withdrawnLedgerSha256: ledgerSha(withdrawal),
        rollbackLedgerSha256: ledgerSha(rollback),
      },
    },
    finalState: rollback.state,
  };
}

async function submitConfirmations(jar, endpoint, answers) {
  const response = await jar.fetch(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  return { status: response.status, body };
}

function ledgerSha(result) {
  const value = result?.ledgerSha256 ?? result?.state?.ledgerSha256;
  assert.match(value ?? "", /^[0-9a-f]{64}$/);
  return value;
}

async function readConfirmations(jar, endpoint) {
  const response = await jar.fetch(endpoint);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload?.ok, true);
  assert.ok(payload?.data);
  return payload.data;
}

function confirmationEndpoint(baseUrl, grantId, companyId) {
  return `${baseUrl}/api/web/matches/${encodeURIComponent(grantId)}/confirmations?${new URLSearchParams({ companyId })}`;
}

async function verifyRejectedWebAccess({ baseUrl, password }) {
  const anonymous = new CookieJar();
  await assertNoSession(anonymous, baseUrl);
  const anonymousCompanies = await anonymous.fetch(`${baseUrl}/api/web/companies`);
  assert.equal(anonymousCompanies.status, 401);

  const invalid = await submitPassword({
    jar: new CookieJar(),
    baseUrl,
    email: "sw@noten.im",
    password: `${password}-wrong`,
  });
  assert.equal(invalid.response.status, 401);
  await assertNoSession(invalid.jar, baseUrl);
}

async function verifyLogoutAndRelogin({ baseUrl, email, password, expectedUserId }) {
  const authenticated = await verifyPasswordLogin({
    baseUrl,
    email,
    password,
    expectedUserId,
  });
  await signOut(authenticated.jar, baseUrl);
  await assertNoSession(authenticated.jar, baseUrl);
  const relogin = await verifyPasswordLogin({
    jar: authenticated.jar,
    baseUrl,
    email,
    password,
    expectedUserId,
  });
  return {
    status: "passed",
    userIdBefore: authenticated.proof.userId,
    userIdAfter: relogin.proof.userId,
  };
}

async function signOut(jar, baseUrl) {
  const csrfResponse = await jar.fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(csrfResponse.status, 200);
  const { csrfToken } = await csrfResponse.json();
  assert.equal(typeof csrfToken, "string");
  const signoutResponse = await jar.fetch(`${baseUrl}/api/auth/signout`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${baseUrl}/login`, json: "true" }),
    redirect: "manual",
  });
  assert.equal(signoutResponse.status, 200);
}

async function submitPassword({ jar, baseUrl, email, password }) {
  const csrfResponse = await jar.fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(csrfResponse.status, 200);
  const csrf = await csrfResponse.json();
  assert.equal(typeof csrf.csrfToken, "string");
  const response = await jar.fetch(`${baseUrl}/api/auth/callback/password`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      password,
      callbackUrl: `${baseUrl}/dashboard`,
      json: "true",
    }),
    redirect: "manual",
  });
  return { jar, response };
}

async function assertNoSession(jar, baseUrl) {
  const response = await jar.fetch(`${baseUrl}/api/auth/session`);
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(session?.user, undefined);
}

async function availableLoopbackPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function stopChild(runtime) {
  await stopTrackedChild(runtime);
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function throwIfRunnerAborted() {
  if (runnerAbort.signal.aborted) throw runnerAbort.signal.reason;
}

function parseRunnerArgs(args) {
  let holdSeconds = 0;
  for (const argument of args) {
    if (!argument.startsWith("--hold-seconds=")) {
      throw new Error(`지원하지 않는 local UAT 인자입니다: ${argument}`);
    }
    const value = Number(argument.slice("--hold-seconds=".length));
    if (!Number.isSafeInteger(value) || value < 1 || value > 180) {
      throw new Error("--hold-seconds는 1~180 사이의 정수여야 합니다.");
    }
    holdSeconds = value;
  }
  return { holdSeconds };
}

async function holdForBrowserAcceptance(seconds) {
  throwIfRunnerAborted();
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(resolvePromise, seconds * 1_000);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(runnerAbort.signal.reason);
    };
    runnerAbort.signal.addEventListener("abort", onAbort, { once: true });
    timeout.unref?.();
  });
}
