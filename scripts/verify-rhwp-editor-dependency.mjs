import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_NAME = "@rhwp/editor";
const EXPECTED_VERSION = "0.8.5";
const EXPECTED_CORE_NAME = "@rhwp/core";
const EXPECTED_CORE_VERSION = "0.8.4";
const VENDOR_SPEC = "file:vendor/rhwp-editor-0.8.5.tgz";
const VENDOR_SHA256 = "6d9b6b2ea8637380c80b88f46949a4ecb043fd9a227cf758302619c998864158";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webPackage = JSON.parse(readFileSync(join(repositoryRoot, "apps/web/package.json"), "utf8"));
const vercelConfig = JSON.parse(readFileSync(join(repositoryRoot, "apps/web/vercel.json"), "utf8"));
const nextConfig = readFileSync(join(repositoryRoot, "apps/web/next.config.mjs"), "utf8");
const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
const dependency = webPackage.dependencies?.[EXPECTED_NAME];
const coreDependency = webPackage.dependencies?.[EXPECTED_CORE_NAME];

assert(
  coreDependency === EXPECTED_CORE_VERSION,
  `${EXPECTED_CORE_NAME}는 Studio WASM과 같은 ${EXPECTED_CORE_VERSION}로 exact 고정해야 합니다.`,
);
assert(
  lockfile.includes(`specifier: ${EXPECTED_CORE_VERSION}`)
    && lockfile.includes(`'${EXPECTED_CORE_NAME}@${EXPECTED_CORE_VERSION}'`),
  `${EXPECTED_CORE_NAME} ${EXPECTED_CORE_VERSION} lock이 없습니다.`,
);

assert(
  typeof vercelConfig.buildCommand === "string"
    && vercelConfig.buildCommand.includes("scripts/copy-rhwp-wasm.mjs"),
  "Vercel production build가 @rhwp/core WASM public 복사 단계를 실행해야 합니다.",
);
assert(
  nextConfig.includes('"./node_modules/@rhwp/core/**/*"'),
  "Vercel server function이 @rhwp/core package boundary와 WASM sidecar를 함께 추적해야 합니다.",
);

if (dependency === EXPECTED_VERSION) {
  assert(!lockfile.includes("rhwp-editor-0.8.5.tgz"), "registry 전환 뒤 vendor tarball lock이 남아 있습니다.");
  assert(lockfile.includes(`specifier: ${EXPECTED_VERSION}`), "registry exact specifier가 lockfile에 없습니다.");
  assert(lockfile.includes(`'${EXPECTED_NAME}@${EXPECTED_VERSION}'`), "registry package lock이 없습니다.");
  console.log(`RHWP editor dependency verification passed (registry ${EXPECTED_VERSION}).`);
  process.exit(0);
}

assert(dependency === VENDOR_SPEC, `${EXPECTED_NAME}는 ${EXPECTED_VERSION} 또는 ${VENDOR_SPEC}로 exact 고정해야 합니다.`);

const tarballPath = join(repositoryRoot, "apps/web/vendor/rhwp-editor-0.8.5.tgz");
const tarball = readFileSync(tarballPath);
const sha256 = createHash("sha256").update(tarball).digest("hex");
const sha512 = createHash("sha512").update(tarball).digest("base64");
assert(sha256 === VENDOR_SHA256, `vendor tarball SHA-256 불일치: ${sha256}`);

const packedPackage = JSON.parse(execFileSync(
  "tar",
  ["-xOzf", tarballPath, "package/package.json"],
  { encoding: "utf8" },
));
assert(packedPackage.name === EXPECTED_NAME, `vendor package name 불일치: ${packedPackage.name}`);
assert(packedPackage.version === EXPECTED_VERSION, `vendor package version 불일치: ${packedPackage.version}`);
assert(lockfile.includes(`specifier: ${VENDOR_SPEC}`), "vendor exact specifier가 lockfile에 없습니다.");
assert(lockfile.includes(`integrity: sha512-${sha512}`), "vendor tarball integrity가 lockfile과 다릅니다.");

console.log(`RHWP editor dependency verification passed (vendored ${EXPECTED_VERSION}, sha256=${sha256}).`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
