import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalCwd = process.cwd();
const outsideMonorepo = await mkdtemp(join(tmpdir(), "cunote-release-admission-import-"));

try {
  process.chdir(outsideMonorepo);
  const productionAdmission = await import("./release-admission-production");

  assert.equal(typeof productionAdmission.admitApplicationRoundtripRelease, "function");
  assert.throws(
    () => productionAdmission.admitApplicationRoundtripRelease({
      grantId: "00000000-0000-4000-8000-000000000001",
      deepReceiptSha256: "a".repeat(64),
    }),
    /pnpm-workspace\.yaml 을 찾지 못했습니다/,
    "로컬 release 실행은 모노레포 밖에서 계속 fail-closed해야 한다",
  );
} finally {
  process.chdir(originalCwd);
  await rm(outsideMonorepo, { recursive: true, force: true });
}

console.log("application roundtrip production admission import tests: ok");
