import assert from "node:assert/strict";
import { symlink, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertDurableAnalysisArtifactPath, findMonorepoRoot } from "./run-store";

test("모델 산출물이 임시 경로로 해석되면 실행 전에 거부한다", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cunote-artifact-guard-"));
  try {
    assert.throws(
      () => assertDurableAnalysisArtifactPath(join(temporary, "spike-out", "analysis-lab")),
      /산출물 경로가 임시 디렉터리/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("임시 checkout에서 영속 spike-out으로 연결한 실제 경로는 허용한다", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cunote-artifact-guard-"));
  const durable = await mkdtemp(join(findMonorepoRoot(), "spike-out", "artifact-guard-test-"));
  try {
    await mkdir(join(durable, "analysis-lab"));
    await symlink(durable, join(temporary, "spike-out"));
    assert.doesNotThrow(() => assertDurableAnalysisArtifactPath(
      join(temporary, "spike-out", "analysis-lab", "new-receipts"),
    ));
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(durable, { recursive: true, force: true });
  }
});
