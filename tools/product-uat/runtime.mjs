import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const INHERITED_ENV_ALLOWLIST = Object.freeze([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "PNPM_HOME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

const FORBIDDEN_SNAPSHOT_BASENAME = /^(?:\.env.*|\.npmrc|\.vercel|node_modules|\.git|\.next(?:-.*)?|spike-out.*)$/;
const SOURCE_TOP_LEVEL_DIRECTORIES = new Set(["apps", "db", "packages", "scripts", "tools"]);
const SOURCE_ROOT_FILES = new Set([
  "design-tokens.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
]);
const DENIED_SOURCE_SEGMENT = /^(?:\.git|\.next(?:-.*)?|\.renorm-analysis|\.turbo|\.vercel|backups?|coverage|node_modules|outputs?|spike-labels|spike-out.*|spike-samples.*|temp|tmp)$/;
const DENIED_SOURCE_BASENAME = /^(?:\.env.*|\.npmrc)$/;
const OWNER_MARKER = ".cunote-product-uat-owner.json";

/**
 * UAT child process에 전달할 환경을 명시 allowlist로 다시 만든다.
 * 호출자가 넘긴 overrides만 추가되며 현재 shell의 DB/provider/model 비밀은 상속하지 않는다.
 */
export function createProductUatEnv(
  overrides = {},
  inherited = process.env,
) {
  const env = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    if (typeof inherited[key] === "string" && inherited[key]) env[key] = inherited[key];
  }
  env.CI = "1";
  env.NEXT_TELEMETRY_DISABLED = "1";
  env.npm_config_update_notifier = "false";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    env[key] = String(value);
  }
  return env;
}

export function trackChildProcess(child) {
  const runtime = {
    child,
    closed: false,
    spawnError: undefined,
    termination: undefined,
  };
  runtime.termination = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      runtime.spawnError = error;
      resolvePromise({ error });
    });
    child.once("close", (code, signal) => {
      runtime.closed = true;
      resolvePromise({ code, signal });
    });
  });
  return runtime;
}

export async function stopTrackedChild(runtime, timeoutMs = 5_000) {
  if (!runtime || runtime.closed || runtime.spawnError) return;
  runtime.child.kill("SIGTERM");
  if (await waitBounded(runtime.termination, timeoutMs) === "timeout" && !runtime.closed) {
    runtime.child.kill("SIGKILL");
    if (await waitBounded(runtime.termination, timeoutMs) === "timeout" && !runtime.closed) {
      throw new Error("UAT child process가 SIGKILL 뒤에도 종료되지 않았습니다.");
    }
  }
}

/**
 * 현재 checkout의 소스만 새 /tmp snapshot에 복사하고 그 snapshot 안에서 의존성을 재결속한다.
 * .env*, .vercel, node_modules, build 출력과 역사 spike artifact는 어느 깊이에서도 복사하지 않는다.
 */
export function createProductUatSourceSnapshot(options = {}) {
  const sourceRoot = realpathSync(resolve(options.sourceRoot ?? process.cwd()));
  if (options.runRoot !== undefined) {
    throw new Error("UAT source runtime 경로는 호출자가 지정하거나 재사용할 수 없습니다.");
  }
  const runRoot = createOwnedRunRoot({
    prefix: "cunote-product-uat-source-",
  });
  assertDisjointRoots(sourceRoot, runRoot);
  const snapshotRoot = join(runRoot, "source");
  mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });

  const inventory = resolveSourceInventory(sourceRoot, options.sourceInventory, options.inheritedEnv);
  copySourceInventory({ sourceRoot, snapshotRoot, inventory });

  const manifest = buildSourceManifest(snapshotRoot);
  const forbiddenPaths = findForbiddenSnapshotPaths(snapshotRoot);
  if (forbiddenPaths.length > 0) {
    throw new Error(`UAT source snapshot에 금지 경로가 포함됐습니다: ${forbiddenPaths.join(", ")}`);
  }

  if (options.installDependencies !== false) {
    run("pnpm", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], {
      cwd: snapshotRoot,
      env: createProductUatEnv({}, options.inheritedEnv),
    });
    assertWorkspacePackagesStayInsideSnapshot(snapshotRoot, options.workspacePackages ?? [
      "apps/web/node_modules/@cunote/core",
      "apps/web/node_modules/@cunote/contracts",
      "apps/admin/node_modules/@cunote/core",
      "apps/admin/node_modules/@cunote/contracts",
    ]);
  }

  return {
    runRoot,
    snapshotRoot,
    sourceRoot,
    sourceManifestSha256: manifest.sha256,
    sourceFileCount: manifest.files.length,
    sourceFiles: manifest.files,
  };
}

/**
 * 외부 TCP를 듣지 않는 새 PostgreSQL cluster의 전체 수명주기를 소유한다.
 * callback이 끝나거나 실패하면 cluster를 항상 중지하며 감사용 data/log는 /tmp에 남긴다.
 */
export async function withIsolatedProductUatPostgres(callback, options = {}) {
  if (options.runRoot !== undefined) {
    throw new Error("UAT PostgreSQL runtime 경로는 호출자가 지정하거나 재사용할 수 없습니다.");
  }
  const runRoot = createOwnedRunRoot({
    prefix: "cunote-product-uat-pg-",
  });
  const dataPath = join(runRoot, "postgres-data");
  const logPath = join(runRoot, "postgres.log");
  const baseEnv = createProductUatEnv({ LANG: "C", LC_ALL: "C" }, options.inheritedEnv);
  let started = false;
  try {
    run("initdb", [
      "-D",
      dataPath,
      "-U",
      "postgres",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ], { env: baseEnv });
    run("pg_ctl", [
      "-D",
      dataPath,
      "-l",
      logPath,
      "-o",
      `-h '' -k ${runRoot} -c max_connections=20`,
      "-w",
      "start",
    ], { env: baseEnv });
    started = true;

    // postgres-js URL에 localhost를 넣지 않는다. hostname 없는 URL과 명시 PGHOST를 함께 사용해
    // 기존 TCP PostgreSQL 대신 이 cluster의 Unix socket만 선택한다.
    const postgresEnv = createProductUatEnv({
      DATABASE_URL: "postgres:///postgres",
      PGDATABASE: "postgres",
      PGHOST: runRoot,
      PGPORT: "5432",
      PGUSER: "postgres",
    }, options.inheritedEnv);
    return await callback({
      runRoot,
      dataPath,
      logPath,
      socketPath: runRoot,
      env: postgresEnv,
    });
  } finally {
    // pg_ctl start가 timeout/예외를 던진 뒤에도 postmaster가 기동됐을 수 있다.
    // 이 함수가 만든 marker/data만 대상으로 status를 확인해 잔존 cluster를 닫는다.
    if (started || postgresIsRunning(dataPath, baseEnv)) {
      assertOwnedRunRoot(runRoot);
      run("pg_ctl", ["-D", dataPath, "-m", "fast", "-w", "stop"], { env: baseEnv });
    }
  }
}

export function findForbiddenSnapshotPaths(snapshotRoot) {
  const root = realpathSync(snapshotRoot);
  const found = [];
  walk(root, (absolutePath, entry) => {
    if (FORBIDDEN_SNAPSHOT_BASENAME.test(entry.name)) {
      found.push(relative(root, absolutePath));
    }
  });
  return found.sort();
}

function buildSourceManifest(snapshotRoot) {
  const root = realpathSync(snapshotRoot);
  const files = [];
  walk(root, (absolutePath, entry) => {
    if (!entry.isFile()) return;
    const path = relative(root, absolutePath).split(sep).join("/");
    files.push({ path, sha256: sha256(readFileSync(absolutePath)) });
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    sha256: sha256(Buffer.from(JSON.stringify(files))),
  };
}

function resolveSourceInventory(sourceRoot, explicitInventory, inheritedEnv) {
  const rawInventory = explicitInventory ?? gitSourceInventory(sourceRoot, inheritedEnv);
  const inventory = [...new Set(rawInventory)].sort();
  if (inventory.length === 0) throw new Error("UAT source inventory가 비어 있습니다.");
  for (const path of inventory) assertAllowedSourcePath(path);
  return inventory;
}

function gitSourceInventory(sourceRoot, inheritedEnv) {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: sourceRoot, env: createProductUatEnv({}, inheritedEnv), encoding: "utf8", timeout: 30_000 },
  );
  return output.split("\0").filter(Boolean).filter(isAllowedSourcePath);
}

function isAllowedSourcePath(path) {
  try {
    assertAllowedSourcePath(path);
    return true;
  } catch {
    return false;
  }
}

function assertAllowedSourcePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new Error("UAT source inventory 경로가 올바르지 않습니다.");
  }
  const normalized = path.split("\\").join("/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`UAT source inventory가 source root 밖을 가리킵니다: ${path}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => DENIED_SOURCE_SEGMENT.test(part)) || DENIED_SOURCE_BASENAME.test(parts.at(-1) ?? "")) {
    throw new Error(`UAT source inventory에 금지 경로가 있습니다: ${path}`);
  }
  if (parts.length === 1) {
    if (!SOURCE_ROOT_FILES.has(parts[0])) throw new Error(`UAT source root 파일 allowlist 밖입니다: ${path}`);
    return;
  }
  if (!SOURCE_TOP_LEVEL_DIRECTORIES.has(parts[0])) {
    throw new Error(`UAT source 상위 경로 allowlist 밖입니다: ${path}`);
  }
}

function copySourceInventory({ sourceRoot, snapshotRoot, inventory }) {
  const sourcePrefix = `${sourceRoot}${sep}`;
  for (const path of inventory) {
    const sourcePath = resolve(sourceRoot, path);
    if (!sourcePath.startsWith(sourcePrefix)) throw new Error(`source root 밖의 파일입니다: ${path}`);
    assertNoSymlinkAncestors(sourceRoot, path);
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isSymbolicLink()) throw new Error(`UAT source symlink는 허용하지 않습니다: ${path}`);
    if (!sourceStat.isFile()) throw new Error(`UAT source inventory는 일반 파일이어야 합니다: ${path}`);

    const descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      if (!fstatSync(descriptor).isFile()) throw new Error(`UAT source inventory는 일반 파일이어야 합니다: ${path}`);
      bytes = readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const destinationPath = join(snapshotRoot, path);
    mkdirSync(dirname(destinationPath), { recursive: true });
    writeFileSync(destinationPath, bytes, { flag: "wx", mode: sourceStat.mode & 0o777 });
  }
}

function assertNoSymlinkAncestors(sourceRoot, path) {
  let cursor = sourceRoot;
  for (const part of path.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`UAT source symlink는 허용하지 않습니다: ${path}`);
    }
  }
}

function assertWorkspacePackagesStayInsideSnapshot(snapshotRoot, packagePaths) {
  const root = `${realpathSync(snapshotRoot)}${sep}`;
  for (const packagePath of packagePaths) {
    const absolutePath = join(snapshotRoot, packagePath);
    const resolved = realpathSync(absolutePath);
    if (!`${resolved}${sep}`.startsWith(root)) {
      throw new Error(`workspace package가 source snapshot 밖을 참조합니다: ${packagePath} -> ${resolved}`);
    }
  }
}

function walk(root, visit) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolutePath = join(root, entry.name);
    visit(absolutePath, entry);
    if (entry.isDirectory()) walk(absolutePath, visit);
  }
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout ?? 300_000,
  });
}

function createOwnedRunRoot({ prefix }) {
  const root = mkdtempSync(join(realTmpDir(), prefix));
  if (!basename(root).startsWith(prefix)) {
    throw new Error(`UAT runtime 경로는 전용 prefix가 필요합니다: ${root}`);
  }
  const parent = realpathSync(dirname(root));
  if (!isInside(realTmpDir(), parent) && parent !== realTmpDir()) {
    throw new Error(`UAT runtime 경로는 실제 임시 디렉터리 아래여야 합니다: ${root}`);
  }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`UAT runtime 경로는 실제 디렉터리여야 합니다: ${root}`);
  const canonicalRoot = realpathSync(root);
  if (!isInside(realTmpDir(), canonicalRoot)) {
    throw new Error(`UAT runtime 실제 경로가 임시 디렉터리 밖입니다: ${canonicalRoot}`);
  }
  chmodSync(canonicalRoot, 0o700);
  writeFileSync(join(canonicalRoot, OWNER_MARKER), JSON.stringify({
    schema: "cunote-product-uat-runtime-owner-v1",
    id: randomUUID(),
  }), { flag: "wx", mode: 0o600 });
  return canonicalRoot;
}

function assertOwnedRunRoot(runRoot) {
  const marker = JSON.parse(readFileSync(join(runRoot, OWNER_MARKER), "utf8"));
  if (marker?.schema !== "cunote-product-uat-runtime-owner-v1" || typeof marker.id !== "string") {
    throw new Error(`UAT runtime 소유 marker가 올바르지 않습니다: ${runRoot}`);
  }
}

function assertDisjointRoots(sourceRoot, runRoot) {
  if (sourceRoot === runRoot || isInside(sourceRoot, runRoot) || isInside(runRoot, sourceRoot)) {
    throw new Error("UAT source root와 runtime 경로는 서로 포함할 수 없습니다.");
  }
}

function isInside(parent, child) {
  return child.startsWith(`${parent}${sep}`);
}

function postgresIsRunning(dataPath, env) {
  if (!existsSync(dataPath)) return false;
  const result = spawnSync("pg_ctl", ["-D", dataPath, "status"], {
    env,
    stdio: "pipe",
    timeout: 10_000,
  });
  return result.status === 0;
}

function realTmpDir() {
  return realpathSync(tmpdir());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitBounded(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolvePromise) => {
        timeout = setTimeout(resolvePromise, timeoutMs, "timeout");
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
