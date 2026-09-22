import assert from "node:assert/strict";
import test from "node:test";
import { parseLegacyQuestionMigrationDraftCliArgs } from "./legacyQuestionMigrationDraft-cli";

test("migration draft CLI는 exact 입력 경로와 bounded limit만 허용한다", () => {
  assert.deepEqual(parseLegacyQuestionMigrationDraftCliArgs([
    "--manifest=/tmp/review/manifest.json",
    "--decisions=/tmp/review/decisions.json",
    "--limit=25",
  ]), {
    manifestPath: "/tmp/review/manifest.json",
    packetDirectory: "/tmp/review",
    decisionSetPath: "/tmp/review/decisions.json",
    outputDirectory: null,
    limit: 25,
  });
  assert.throws(() => parseLegacyQuestionMigrationDraftCliArgs([
    "--manifest=/tmp/manifest.json",
    "--decisions=/tmp/decisions.json",
    "--limit=0",
  ]), /1~20000/);
  assert.throws(() => parseLegacyQuestionMigrationDraftCliArgs([
    "--manifest=/tmp/manifest.json",
    "--decisions=/tmp/decisions.json",
    "--write=true",
  ]), /지원하지 않는 옵션/);
  assert.throws(() => parseLegacyQuestionMigrationDraftCliArgs([
    "--manifest=/tmp/manifest.json",
    "--manifest=/tmp/other.json",
    "--decisions=/tmp/decisions.json",
  ]), /한 번만/);
});
