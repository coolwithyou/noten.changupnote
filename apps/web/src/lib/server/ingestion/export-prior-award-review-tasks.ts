/**
 * P5 prior_award deterministic 후보를 기존 matching-v3 독립 검수 형식으로 내보낸다.
 * DB는 읽기 전용이며 draft annotation은 reviewer 확정 전 발행할 수 없다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  buildKStartupCriteria,
  buildMatchingV3GrantReviewTask,
  renderMatchingV3ReviewWorkbench,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const outputPath = resolve(readArg("output") ?? "tmp/prior-award-p5-review-tasks.jsonl");
const annotationsPath = resolve(readArg("annotations-output") ?? "tmp/prior-award-p5-draft-annotations.jsonl");
const workbenchPath = resolve(readArg("workbench-output") ?? "tmp/prior-award-p5-review-workbench.html");
const force = process.argv.includes("--force");
if (!force && (existsSync(outputPath) || existsSync(annotationsPath) || existsSync(workbenchPath))) {
  throw new Error("output exists; use --force to replace prior_award review artifacts");
}

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<KStartupAnnouncement>({ dialect: "drizzle", client: db });
  const rows = await db.select({
    sourceId: schema.grantRaw.sourceId,
    payload: schema.grantRaw.payload,
  }).from(schema.grantRaw)
    .innerJoin(schema.grants, and(
      eq(schema.grantRaw.source, schema.grants.source),
      eq(schema.grantRaw.sourceId, schema.grants.sourceId),
    ))
    .where(and(
      eq(schema.grantRaw.source, "kstartup"),
      inArray(schema.grants.status, ["open", "upcoming"]),
    ));

  const tasks = [];
  let criterionCount = 0;
  for (const row of rows) {
    const announcement = { ...row.payload, pbanc_sn: row.payload.pbanc_sn ?? row.sourceId } as unknown as KStartupAnnouncement;
    const predictedCriteria = buildKStartupCriteria(announcement, row.sourceId, { priorAwardSplit: true })
      .filter((criterion) => criterion.dimension === "prior_award");
    if (predictedCriteria.length === 0) continue;
    const entry = await repositories.grants.findGrantById(`kstartup:${row.sourceId}`);
    if (!entry) throw new Error(`current grant not found: kstartup:${row.sourceId}`);
    const inputSha256 = createHash("sha256")
      .update(JSON.stringify({ sourceId: row.sourceId, exclusion: announcement.aply_excl_trgt_ctnt ?? null }))
      .digest("hex");
    tasks.push(buildMatchingV3GrantReviewTask(entry, {
      sourceFixture: `prior-award-p5:kstartup:${row.sourceId}:${inputSha256}`,
      predictedCriteria,
      predictionProvenance: {
        extractorVersion: "prior-award-deterministic-p5-draft-v1",
        model: "deterministic",
        inputSha256,
      },
    }));
    criterionCount += predictedCriteria.length;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(dirname(annotationsPath), { recursive: true });
  writeFileSync(outputPath, `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`, "utf8");
  writeFileSync(annotationsPath, `${tasks.map((task) => JSON.stringify(task.annotationTemplate)).join("\n")}\n`, "utf8");
  const workbench = renderMatchingV3ReviewWorkbench({
    companyTasks: [],
    grantTasks: tasks,
    pairTasks: [],
    includeHoldout: false,
  });
  for (const forbidden of ["archive_url", "storage_key", "source_uri", "markdown_storage_key"]) {
    if (workbench.includes(`\"${forbidden}\"`)) {
      throw new Error(`refusing workbench with forbidden storage field ${forbidden}`);
    }
  }
  mkdirSync(dirname(workbenchPath), { recursive: true });
  writeFileSync(workbenchPath, workbench, "utf8");
  console.log(JSON.stringify({
    ok: true,
    databaseWrite: false,
    externalApiCall: false,
    taskCount: tasks.length,
    criterionCount,
    outputPath,
    annotationsPath,
    workbenchPath,
    operationalReady: false,
    reminder: "draft annotations require independent human annotator/reviewer metadata before publication",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
