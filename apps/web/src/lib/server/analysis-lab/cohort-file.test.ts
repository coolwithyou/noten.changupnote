// 코호트 파일 경계 테스트 — 외부 API/DB 무접촉.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cohortSnapshotFilePath,
  readCohortFileV2,
  writeCohortFileV2,
  type CohortFileV2,
} from "./cohort-file";

const file: CohortFileV2 = {
  version: 2,
  selectedAt: "2026-08-13T00:00:00.000Z",
  seed: 20260813,
  experimentLabel: "deep-v15-cp2b-pilot5",
  entries: [{ grantId: "g1", stratum: "bizinfo/thick" }],
};

assert.match(
  cohortSnapshotFilePath("deep-v15-cp2b-pilot5"),
  /spike-out\/analysis-lab\/cohort\.deep-v15-cp2b-pilot5\.json$/,
);
for (const invalid of ["", "../escape", "UPPER", "dot.name", "trailing-"]) {
  assert.throws(() => cohortSnapshotFilePath(invalid), /코호트 스냅샷 라벨 형식/);
}

const root = await mkdtemp(join(tmpdir(), "cunote-cohort-file-"));
try {
  const path = join(root, "cohort.snapshot.json");
  await writeCohortFileV2(file, { path, exclusive: true });
  assert.deepEqual(await readCohortFileV2(path), file, "불변 스냅샷 왕복");
  await assert.rejects(
    writeCohortFileV2({ ...file, seed: 2 }, { path, exclusive: true }),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST",
    "같은 이름의 스냅샷은 덮어쓰지 않는다",
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).seed, 20260813, "최초 스냅샷 보존");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("cohort-file tests passed");
