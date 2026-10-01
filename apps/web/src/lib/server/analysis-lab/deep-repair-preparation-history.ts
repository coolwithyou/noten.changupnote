import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isImmutableArtifactTempFileName } from "./immutable-artifact-fs";
import { analysisLabDir } from "./run-store";
import { CURRENT_INVENTORY_SCHEMA, MATCHING_MATERIAL_SOURCE_BINDING_SCHEMA, validateCurrentLaunchInventory } from "./current-inventory-launch";

const LEGACY_COHORT_SNAPSHOT_FILE = /^cohort\..+\.json$/;
const PRIMARY_RUN_FILE = /^run-[0-9TZ.\-]{10,40}(?:-[a-f0-9]{4,8})?\.json$/;
const SERIES_MARKER_FILE = /^([a-z0-9][a-z0-9-]*)\.json$/;
const PROPOSAL_LOGICAL_PREFIX = "spike-out/analysis-lab/experiments/proposals/";
const FORMAL_BASELINE_COHORT_PREFIX = "cohort.deep-v17-cp2b-";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `all`은 감사용 전체 이력, `formal-baseline`은 deep-v17 정식 비교 코호트와 실제 착수된
 * experiment target만 읽는다. 계획만 되고 실행되지 않은 target은 후속 proposal에서 재사용한다.
 */
export async function readDeepRepairHistoricalGrantIds(options: {
  readonly rootDir?: string;
  readonly scope?: "all" | "formal-baseline";
} = {}): Promise<string[]> {
  const root = options.rootDir ?? analysisLabDir();
  const scope = options.scope ?? "all";
  const ids = new Set<string>();
  const rootEntries = await readRequiredHistoryRoot(root);

  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const isCohort = entry.name === "cohort.json" || LEGACY_COHORT_SNAPSHOT_FILE.test(entry.name);
    const isFormalBaseline = entry.name.startsWith(FORMAL_BASELINE_COHORT_PREFIX);
    if (isCohort && (scope === "all" || isFormalBaseline)) {
      const label = `historical cohort ${entry.name}`;
      for (const grantId of await readLegacyCohortGrantIds(join(root, entry.name), label)) {
        ids.add(grantId);
      }
    }
  }

  for (const entry of scope === "all" ? rootEntries : []) {
    if (!entry.isDirectory() || !entry.name.includes("__")) continue;
    const runDir = join(root, entry.name);
    for (const file of await readDirectoryOrEmpty(runDir)) {
      if (!file.isFile() || !PRIMARY_RUN_FILE.test(file.name)) continue;
      const label = `historical run ${entry.name}/${file.name}`;
      const run = await readJsonRecord(join(runDir, file.name), label);
      ids.add(requiredGrantId(run.grantId, `${label}.grantId`));
    }
  }

  const seriesRoot = join(root, "experiments", "series");
  // 새 current inventory도 준비된 exact 대상으로 all 이력에서 제외한다.
  for (const entry of scope === "all" ? await readDirectoryOrEmpty(join(root, "launch", "inventories")) : []) {
    if (isImmutableArtifactTempFileName(entry.name)) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) throw new Error("unexpected current inventory entry");
    const bytes = await readFile(join(root, "launch", "inventories", entry.name));
    if (`${createHash("sha256").update(bytes).digest("hex")}.json` !== entry.name) throw new Error("current inventory SHA mismatch");
    const inventory = validateHistoricalCurrentLaunchInventory(JSON.parse(bytes.toString("utf8")));
    if (inventory.schema !== CURRENT_INVENTORY_SCHEMA) throw new Error("current inventory schema mismatch");
    for (const target of inventory.targets) ids.add(target.grantId);
  }
  for (const entry of await readDirectoryOrEmpty(seriesRoot)) {
    if (!entry.isFile()) throw new Error(`unexpected experiment series entry: ${entry.name}`);
    if (isImmutableArtifactTempFileName(entry.name)) continue;
    const match = SERIES_MARKER_FILE.exec(entry.name);
    if (!match) throw new Error(`unexpected experiment series marker: ${entry.name}`);
    const marker = await readJsonRecord(
      join(seriesRoot, entry.name),
      `experiment series marker ${entry.name}`,
    );
    const proposalSha256 = requiredSha(
      marker.proposalSha256,
      `experiment series marker ${entry.name}.proposalSha256`,
    );
    const planSha256 = requiredSha(
      marker.planSha256,
      `experiment series marker ${entry.name}.planSha256`,
    );
    requiredSha(
      marker.planArtifactSha256,
      `experiment series marker ${entry.name}.planArtifactSha256`,
    );
    requiredSha(
      marker.manifestSha256,
      `experiment series marker ${entry.name}.manifestSha256`,
    );
    if (
      marker.schema !== "deep-repair-series-proposal-v1"
      || marker.seriesId !== match[1]
      || marker.proposalPath !== `${PROPOSAL_LOGICAL_PREFIX}${proposalSha256}.json`
    ) {
      throw new Error(`malformed experiment series marker: ${entry.name}`);
    }
    const proposalPath = join(root, "experiments", "proposals", `${proposalSha256}.json`);
    const proposalBytes = await readFile(proposalPath).catch((error: unknown) => {
      throw new Error(`cannot read committed experiment proposal ${proposalSha256}`, { cause: error });
    });
    if (createHash("sha256").update(proposalBytes).digest("hex") !== proposalSha256) {
      throw new Error(`experiment proposal content address mismatch: ${proposalPath}`);
    }
    const proposal = parseJsonRecord(proposalBytes, `experiment proposal ${proposalSha256}`);
    if (
      proposal.schema !== "deep-repair-proposal-v1"
      || !Array.isArray(proposal.sequence)
      || proposal.sequence.length === 0
    ) {
      throw new Error(`malformed experiment proposal: ${proposalSha256}`);
    }
    for (let index = 0; index < proposal.sequence.length; index += 1) {
      const target = asRecord(
        proposal.sequence[index],
        `experiment proposal ${proposalSha256}.sequence[${index}]`,
      );
      const grantId = requiredGrantId(
        target.grantId,
        `experiment proposal ${proposalSha256}.sequence[${index}].grantId`,
      );
      if (
        scope === "all"
        || await wasExperimentTargetStarted(root, planSha256, index, grantId)
      ) {
        ids.add(grantId);
      }
    }
  }

  return [...ids].sort();
}

/**
 * e74de4102ebb5626ab8d50f3fe6c70bf3cc934de가 발행한 artifact-loss 정책은
 * 역사 exclusion 소비만 지원한다. 현재 launch admission을 열거나 역사 대상을 재사용하지 않는다.
 * 정책 이름만 허용하지 않고 producer의 전체 target/attestation material 결속을 검증한다.
 */
export function validateHistoricalCurrentLaunchInventory(value: unknown): {
  readonly schema: typeof CURRENT_INVENTORY_SCHEMA;
  readonly targets: readonly { readonly grantId: string }[];
} {
  const inventory = asRecord(value, "historical current inventory");
  if (inventory.policy !== "open-visible-current-period-artifact-loss-reanalysis-v1") {
    return validateCurrentLaunchInventory(value);
  }
  if (inventory.schema !== CURRENT_INVENTORY_SCHEMA
    || typeof inventory.seriesId !== "string"
    || !/^current-[a-z0-9][a-z0-9-]{0,70}$/u.test(inventory.seriesId)
    || !inventory.seriesId.startsWith("current-artifact-loss-")
    || typeof inventory.model !== "string" || !inventory.model.trim()
    || typeof inventory.observedAt !== "string" || !Number.isFinite(Date.parse(inventory.observedAt))
    || !isHistorySha(inventory.historicalGrantIdsSha256)
    || !Array.isArray(inventory.targets) || inventory.targets.length < 1 || inventory.targets.length > 100) {
    throw new Error("historical artifact loss inventory 계약이 잘못됐습니다.");
  }
  const targets = inventory.targets.map((target, index) => {
    const row = asRecord(target, "historical artifact loss target");
    const binding = asRecord(row.matchingMaterialSourceBinding, "historical artifact loss matching material");
    if (row.sequence !== index || typeof row.grantId !== "string" || !UUID.test(row.grantId)
      || typeof row.stratum !== "string" || !/^(bizinfo|kstartup)\/(thin|medium|thick)$/u.test(row.stratum)
      || !isHistorySha(row.inputSha256) || !isHistorySha(row.attachmentManifestSha256)
      || !isHistorySha(row.sourceRevisionSha256)
      || binding.schema !== MATCHING_MATERIAL_SOURCE_BINDING_SCHEMA
      || !isHistorySha(binding.materialSourceRevisionSha256) || !isHistorySha(binding.sourceRawSha256)) {
      throw new Error("historical artifact loss target material 결속이 잘못됐습니다.");
    }
    return {
      grantId: row.grantId,
      sourceRevisionSha256: row.sourceRevisionSha256,
      inputSha256: row.inputSha256,
      attachmentManifestSha256: row.attachmentManifestSha256,
    };
  });
  if (new Set(targets.map(target => target.grantId)).size !== targets.length) {
    throw new Error("historical artifact loss target 중복입니다.");
  }
  const recovery = asRecord(inventory.artifactLossRecovery, "historical artifact loss attestation");
  if (recovery.schema !== "analysis-artifact-loss-reanalysis-attestation-v1"
    || recovery.evidenceStatus !== "session-transcript-only"
    || !isHistorySha(recovery.sessionTranscriptSha256) || !isHistorySha(recovery.priorManifestSha256)
    || !isHistorySha(recovery.priorGrantSha256) || !isHistorySha(recovery.priorTerminalReceiptSha256)
    || !Array.isArray(recovery.targets) || recovery.targets.length !== targets.length) {
    throw new Error("historical artifact loss attestation 결속이 잘못됐습니다.");
  }
  const priorSequences = new Set<number>();
  for (const [index, item] of recovery.targets.entries()) {
    const prior = asRecord(item, "historical artifact loss prior target");
    const current = targets[index]!;
    if (prior.grantId !== current.grantId || typeof prior.priorSequence !== "number"
      || !Number.isSafeInteger(prior.priorSequence) || prior.priorSequence < 0
      || priorSequences.has(prior.priorSequence)
      || typeof prior.priorRunId !== "string" || !/^run-[0-9TZ.\-]{10,40}-[a-f0-9]{6}$/u.test(prior.priorRunId)
      || !isHistorySha(prior.priorSourceRevisionSha256) || !isHistorySha(prior.priorInputSha256)
      || !isHistorySha(prior.priorAttachmentManifestSha256)
      || prior.priorSourceRevisionSha256 !== current.sourceRevisionSha256
      || prior.priorInputSha256 !== current.inputSha256
      || prior.priorAttachmentManifestSha256 !== current.attachmentManifestSha256) {
      throw new Error("historical artifact loss 과거 관측과 현재 material 결속이 다릅니다.");
    }
    priorSequences.add(prior.priorSequence);
  }
  return { schema: CURRENT_INVENTORY_SCHEMA, targets };
}

function isHistorySha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function wasExperimentTargetStarted(
  root: string,
  planSha256: string,
  sequence: number,
  grantId: string,
): Promise<boolean> {
  const claimPath = join(
    root,
    "experiments",
    "attempts",
    planSha256,
    String(sequence).padStart(2, "0"),
    "claim.json",
  );
  const claimBytes = await readOptionalFile(claimPath);
  if (claimBytes === null) return false;

  const label = `experiment attempt ${planSha256}/${String(sequence).padStart(2, "0")}`;
  const claim = parseJsonRecord(claimBytes, label);
  const target = asRecord(claim.target, `${label}.target`);
  if (
    claim.schema !== "deep-repair-live-start-v1"
    || claim.planSha256 !== planSha256
    || target.sequence !== sequence
    || requiredGrantId(target.grantId, `${label}.target.grantId`) !== grantId
  ) {
    throw new Error(`malformed ${label}`);
  }
  return true;
}

async function readLegacyCohortGrantIds(path: string, label: string): Promise<string[]> {
  const cohort = await readJsonRecord(path, label);
  if (cohort.version === 2 && Array.isArray(cohort.entries)) {
    return cohort.entries.map((entry, index) => requiredGrantId(
      asRecord(entry, `${label}.entries[${index}]`).grantId,
      `${label}.entries[${index}].grantId`,
    ));
  }
  if (Array.isArray(cohort.grantIds)) {
    return cohort.grantIds.map((grantId, index) => requiredGrantId(
      grantId,
      `${label}.grantIds[${index}]`,
    ));
  }
  throw new Error(`malformed ${label}`);
}

async function readJsonRecord(path: string, label: string): Promise<Record<string, unknown>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new Error(`cannot read ${label}`, { cause: error });
  }
  return parseJsonRecord(bytes, label);
}

function parseJsonRecord(bytes: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}`, { cause: error });
  }
  return asRecord(parsed, label);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredGrantId(value: unknown, label: string): string {
  const grantId = requiredText(value, label);
  if (!UUID.test(grantId)) throw new Error(`${label} must be a UUID: ${grantId}`);
  return grantId.toLowerCase();
}

function requiredSha(value: unknown, label: string): string {
  const sha = requiredText(value, label);
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`${label} must be a SHA-256`);
  return sha;
}

async function readDirectoryOrEmpty(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readRequiredHistoryRoot(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`analysis lab history root not found: ${path}`, { cause: error });
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
