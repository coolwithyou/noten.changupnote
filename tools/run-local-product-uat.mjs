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
      webAccounts.push(authenticated.proof);
    }
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
  const csrfResponse = await authenticated.jar.fetch(`${baseUrl}/api/auth/csrf`);
  assert.equal(csrfResponse.status, 200);
  const { csrfToken } = await csrfResponse.json();
  assert.equal(typeof csrfToken, "string");
  const signoutResponse = await authenticated.jar.fetch(`${baseUrl}/api/auth/signout`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-auth-return-redirect": "1",
    },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${baseUrl}/login`, json: "true" }),
    redirect: "manual",
  });
  assert.equal(signoutResponse.status, 200);
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
